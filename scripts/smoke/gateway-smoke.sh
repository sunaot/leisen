#!/usr/bin/env bash
# shellcheck disable=SC2016
# (SC2016: node -e に渡す JavaScript を単一引用符で書いている。シェルで展開しないのが意図どおり)
#
# kp-gateway のスモークテスト(T-012)。CI の reference-deploy ジョブとローカルで共用する。
#
#   KP_SESSION_TOKEN=<Bearer セッショントークン> scripts/smoke/gateway-smoke.sh [GATEWAY_URL]
#
# 例(Docker Compose のリファレンスデプロイ。トークンは Keycloak から取得する):
#   KP_SESSION_TOKEN="$(scripts/smoke/keycloak-token.sh)" scripts/smoke/gateway-smoke.sh
# 例(モック IdP で手元起動した Gateway。README「手元で動かす」):
#   KP_SESSION_TOKEN=dev-token scripts/smoke/gateway-smoke.sh
#
# 確認すること(1つでも失敗したら非0で終了する):
#   1. GET /healthz が 200 {"status":"ok"}(起動直後に備えて KP_SMOKE_WAIT_SEC 秒まで待つ)
#   2. initialize(protocolVersion 2025-11-25)が成功する
#   3. tools/list が4ツール(search / fetch / list / describe)を返す。search の source enum を表示し、
#      対象ソースが含まれることを確かめる
#   4. tools/call search(既定: source dev-docs、query VPN)が1件以上ヒットする
#   5. Authorization なし・不正なトークンの要求が 401 になる
#
# - 依存は bash / curl / node だけ(jq 不要)
# - トークンの値は出力しない。curl へは権限 600 のヘッダファイル経由で渡し、コマンドライン
#   引数(ps で見える)にも載せない(不変条件6)
# - 検索結果は件数だけを表示する。実ソースに向けて実行したときに、文書のタイトル・ID・
#   本文をログ(CI ログを含む)に残さないため(不変条件7)
#
# 環境変数:
#   KP_SESSION_TOKEN   Bearer セッショントークン(必須)
#   GATEWAY_URL        Gateway のベース URL(既定 http://127.0.0.1:8787。第1引数が優先)
#   KP_SMOKE_MCP_PATH  MCP エンドポイントのパス(既定 /mcp。deployment.yaml の gateway.http.path)
#   KP_SMOKE_SOURCE    検索するソース(既定 dev-docs)
#   KP_SMOKE_QUERY     検索クエリ(既定 VPN)
#   KP_SMOKE_WAIT_SEC  /healthz を待つ秒数(既定 30)
set -euo pipefail

GATEWAY_URL="${1:-${GATEWAY_URL:-http://127.0.0.1:8787}}"
GATEWAY_URL="${GATEWAY_URL%/}"
MCP_PATH="${KP_SMOKE_MCP_PATH:-/mcp}"
SOURCE="${KP_SMOKE_SOURCE:-dev-docs}"
QUERY="${KP_SMOKE_QUERY:-VPN}"
WAIT_SEC="${KP_SMOKE_WAIT_SEC:-30}"
PROTOCOL_VERSION="2025-11-25"

fail() {
  echo "gateway-smoke: FAIL: $*" >&2
  exit 1
}

if [ -z "${KP_SESSION_TOKEN:-}" ]; then
  echo "gateway-smoke: KP_SESSION_TOKEN is not set" >&2
  exit 2
fi
command -v curl >/dev/null || fail "curl is required"
command -v node >/dev/null || fail "node is required"

umask 077
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# トークンはファイル経由で curl に渡す(引数に載せない)。bash -x で実行されても
# トークンを展開した行をトレースに出さない
case "$-" in *x*) restore_xtrace=1 ;; *) restore_xtrace=0 ;; esac
{ set +x; } 2>/dev/null
printf 'Authorization: Bearer %s\n' "$KP_SESSION_TOKEN" >"$WORK/auth.header"
if [ "$restore_xtrace" = 1 ]; then set -x; fi

CURL=(curl -sS --max-time 30)
# ループバック宛てはプロキシを使わない(CI・社内プロキシ環境向け。それ以外は環境の設定に従う)
case "$GATEWAY_URL" in
  http://127.* | http://localhost | http://localhost:* | http://localhost/* | "http://[::1]"*)
    CURL+=(--noproxy '*')
    ;;
esac

# JSON-RPC 応答ファイル($1)を読み、エラー応答なら内容(Gateway の固定文言)を出して失敗する。
# 続く JavaScript($2)を res(応答)・fail(失敗)・arg(追加の引数 $3)を使って評価する
check_json() {
  node -e '
const [file, code, arg] = process.argv.slice(1);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
let res;
try {
  res = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
} catch {
  fail("response is not JSON");
}
if (res.error) {
  fail(`JSON-RPC error ${res.error.code}: ${res.error.message}`);
}
new Function("res", "fail", "arg", code)(res, fail, arg);
' "$1" "$2" "${3:-}"
}

# MCP エンドポイントへ POST する。応答本文は $WORK/<名前>.json、HTTP ステータスを標準出力へ。
#   mcp_post <名前> <JSON-RPC 本文> <認証: token | none | invalid>
mcp_post() {
  local name="$1" body="$2" auth="$3"
  local args=(-o "$WORK/$name.json" -w '%{http_code}' -X POST
    -H 'Content-Type: application/json'
    -H 'Accept: application/json, text/event-stream')
  if [ -n "${NEGOTIATED_VERSION:-}" ]; then
    args+=(-H "mcp-protocol-version: $NEGOTIATED_VERSION")
  fi
  case "$auth" in
    token) args+=(-H "@$WORK/auth.header") ;;
    invalid) args+=(-H 'Authorization: Bearer kp-smoke-invalid-token') ;;
    none) ;;
  esac
  "${CURL[@]}" "${args[@]}" --data-binary "$body" "$GATEWAY_URL$MCP_PATH" || true
}

echo "gateway-smoke: target $GATEWAY_URL (MCP path $MCP_PATH)"

# --- 1. /healthz ---------------------------------------------------------
deadline=$((SECONDS + WAIT_SEC))
status=""
while :; do
  status="$("${CURL[@]}" -o "$WORK/healthz.json" -w '%{http_code}' "$GATEWAY_URL/healthz" 2>/dev/null || true)"
  [ "$status" = 200 ] && break
  [ "$SECONDS" -ge "$deadline" ] && fail "GET /healthz did not return 200 within ${WAIT_SEC}s (last status: ${status:-none})"
  sleep 1
done
node -e '
const body = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
if (body.status !== "ok") process.exit(1);
' "$WORK/healthz.json" || fail "GET /healthz body is not {\"status\":\"ok\"}"
echo "[1/5] GET /healthz: ok"

# --- 2. initialize -------------------------------------------------------
status="$(mcp_post initialize '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"'"$PROTOCOL_VERSION"'","capabilities":{},"clientInfo":{"name":"kp-gateway-smoke","version":"0.0.0"}}}' token)"
[ "$status" = 200 ] || fail "initialize returned HTTP ${status}"
summary="$(check_json "$WORK/initialize.json" '
const r = res.result ?? {};
if (typeof r.protocolVersion !== "string" || r.protocolVersion === "") fail("initialize: no protocolVersion");
if (!r.capabilities?.tools) fail("initialize: the server does not declare the tools capability");
console.log(`${r.protocolVersion} ${r.serverInfo?.name ?? "?"} ${r.serverInfo?.version ?? "?"}`);
')" || fail "initialize returned an unexpected result"
read -r NEGOTIATED_VERSION server_name server_version <<<"$summary"
echo "[2/5] initialize: ok (server $server_name $server_version, protocolVersion $NEGOTIATED_VERSION)"

# --- 3. tools/list -------------------------------------------------------
status="$(mcp_post tools-list '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' token)"
[ "$status" = 200 ] || fail "tools/list returned HTTP ${status}"
check_json "$WORK/tools-list.json" '
const tools = res.result?.tools;
if (!Array.isArray(tools)) fail("tools/list: no tools array");
const names = tools.map((t) => t.name).sort();
if (names.join(",") !== "describe,fetch,list,search") fail(`tools/list: unexpected tools: ${names.join(", ")}`);
const sources = tools.find((t) => t.name === "search").inputSchema?.properties?.source?.enum;
if (!Array.isArray(sources)) fail("tools/list: search has no source enum");
if (!sources.includes(arg)) {
  fail(`tools/list: source "${arg}" is not enabled on this gateway (search sources: ${sources.join(", ")})`);
}
console.log(`[3/5] tools/list: ok (tools: ${names.join(", ")}; search sources: ${sources.join(", ")})`);
' "$SOURCE" || fail "tools/list returned an unexpected result"

# --- 4. tools/call search ------------------------------------------------
search_body="$(node -e '
const [source, query] = process.argv.slice(1);
console.log(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", arguments: { source, query } } }));
' "$SOURCE" "$QUERY")"
status="$(mcp_post search "$search_body" token)"
[ "$status" = 200 ] || fail "tools/call search returned HTTP ${status}"
check_json "$WORK/search.json" '
const r = res.result ?? {};
if (r.isError) {
  // Gateway の正規化エラー(固定文言)。分類だけを出す
  let errorClass = "unknown";
  try { errorClass = JSON.parse(r.content?.[0]?.text ?? "{}").errorClass ?? errorClass; } catch {}
  fail(`search returned a tool error (errorClass: ${errorClass})`);
}
const hits = r.structuredContent?.hits;
if (!Array.isArray(hits)) fail("search: no hits array in structuredContent");
if (hits.length < 1) fail("search: 0 hits");
// 件数だけを出す(文書のタイトル・ID・本文はログに残さない)
console.log(`[4/5] tools/call search: ok (${hits.length} hit(s) for the smoke query on ${arg})`);
' "$SOURCE" || fail "tools/call search returned an unexpected result"

# --- 5. 認証なし・不正なトークン ----------------------------------------
tools_list='{"jsonrpc":"2.0","id":4,"method":"tools/list"}'
status="$(mcp_post unauthenticated "$tools_list" none)"
[ "$status" = 401 ] || fail "a request without Authorization returned HTTP ${status} (expected 401)"
status="$(mcp_post invalid-token "$tools_list" invalid)"
[ "$status" = 401 ] || fail "a request with an invalid token returned HTTP ${status} (expected 401)"
echo "[5/5] requests without a valid token: ok (401)"

echo "gateway-smoke: all checks passed"
