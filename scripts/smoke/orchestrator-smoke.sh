#!/usr/bin/env bash
# shellcheck disable=SC2016
# (SC2016: node -e に渡す JavaScript を単一引用符で書いている。シェルで展開しないのが意図どおり)
#
# Orchestrator サービス(kp-ask serve、T-021 / ADR-018)のスモークテスト。CI の
# reference-deploy ジョブ(LibreChat overlay)とローカルで共用する。
#
#   KP_SESSION_TOKEN=<Bearer トークン> scripts/smoke/orchestrator-smoke.sh [ORCHESTRATOR_URL]
#
# 例(Docker Compose の LibreChat overlay。トークンは Keycloak から取得する):
#   KP_SESSION_TOKEN="$(scripts/smoke/keycloak-token.sh)" scripts/smoke/orchestrator-smoke.sh
#
# 確認すること(1つでも失敗したら非0で終了する):
#   1. GET /healthz が 200 {"status":"ok"}(起動直後に備えて KP_SMOKE_WAIT_SEC 秒まで待つ)
#   2. Authorization なしの initialize が 401(JSON-RPC の処理より前に拒否される)
#   3. Keycloak のトークンで initialize(protocolVersion 2025-11-25)が成功し、tools/list が
#      ask と feedback の2つを返す(Orchestrator はトークンの有効性を Gateway の tools/list で
#      確かめる。ADR-018 決定2)
#   4. 不正なトークンの initialize / tools/list が 401(Gateway が拒否したものをそのまま返す)
#
# - ask は呼ばない(LLM が要るため。CI には LLM がない)。LLM までの疎通は手元で確認する
#   (docs/ui-librechat.md)
# - 依存は bash / curl / node だけ(jq 不要)
# - トークンの値は出力しない。curl へは権限 600 のヘッダファイル経由で渡し、コマンドライン
#   引数(ps で見える)にも載せない(不変条件6)。応答の本文も出力しない(ツール名・サーバー名・
#   プロトコル版だけを表示する)
#
# 環境変数:
#   KP_SESSION_TOKEN   Bearer トークン(必須。Keycloak が利用者に発行したアクセストークン)
#   ORCHESTRATOR_URL   Orchestrator のベース URL(既定 http://127.0.0.1:8790。第1引数が優先)
#   KP_SMOKE_MCP_PATH  MCP エンドポイントのパス(既定 /mcp。kp-ask serve の --path)
#   KP_SMOKE_WAIT_SEC  /healthz を待つ秒数(既定 30)
set -euo pipefail

ORCHESTRATOR_URL="${1:-${ORCHESTRATOR_URL:-http://127.0.0.1:8790}}"
ORCHESTRATOR_URL="${ORCHESTRATOR_URL%/}"
MCP_PATH="${KP_SMOKE_MCP_PATH:-/mcp}"
WAIT_SEC="${KP_SMOKE_WAIT_SEC:-30}"
PROTOCOL_VERSION="2025-11-25"

fail() {
  echo "orchestrator-smoke: FAIL: $*" >&2
  exit 1
}

if [ -z "${KP_SESSION_TOKEN:-}" ]; then
  echo "orchestrator-smoke: KP_SESSION_TOKEN is not set" >&2
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

CURL=(curl -sS --max-time 60)
# ループバック宛てはプロキシを使わない(CI・社内プロキシ環境向け。それ以外は環境の設定に従う)
case "$ORCHESTRATOR_URL" in
  http://127.* | http://localhost | http://localhost:* | http://localhost/* | "http://[::1]"*)
    CURL+=(--noproxy '*')
    ;;
esac

# MCP の応答ファイル($1)を読み、JSON-RPC の応答を取り出す。応答は単発 JSON か
# Server-Sent Events(data: 行)のどちらでもよい。エラー応答なら内容(固定文言)を出して
# 失敗する。続く JavaScript($2)を res(応答)・fail(失敗)・arg(追加の引数 $3)で評価する
check_json() {
  node -e '
const [file, code, arg] = process.argv.slice(1);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const text = require("node:fs").readFileSync(file, "utf8");
let res;
try {
  res = JSON.parse(text);
} catch {
  // SSE: data: 行の JSON-RPC 応答(result か error を持つもの)を採る
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      const message = JSON.parse(line.slice(5).trim());
      if (message && (message.result !== undefined || message.error !== undefined)) res = message;
    } catch {}
  }
}
if (res === undefined) fail("response is neither JSON nor an SSE stream with a JSON-RPC response");
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
  "${CURL[@]}" "${args[@]}" --data-binary "$body" "$ORCHESTRATOR_URL$MCP_PATH" || true
}

INITIALIZE='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"'"$PROTOCOL_VERSION"'","capabilities":{},"clientInfo":{"name":"kp-orchestrator-smoke","version":"0.0.0"}}}'
TOOLS_LIST='{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

echo "orchestrator-smoke: target $ORCHESTRATOR_URL (MCP path $MCP_PATH)"

# --- 1. /healthz ---------------------------------------------------------
deadline=$((SECONDS + WAIT_SEC))
status=""
while :; do
  status="$("${CURL[@]}" -o "$WORK/healthz.json" -w '%{http_code}' "$ORCHESTRATOR_URL/healthz" 2>/dev/null || true)"
  [ "$status" = 200 ] && break
  [ "$SECONDS" -ge "$deadline" ] && fail "GET /healthz did not return 200 within ${WAIT_SEC}s (last status: ${status:-none})"
  sleep 1
done
node -e '
const body = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
if (body.status !== "ok") process.exit(1);
' "$WORK/healthz.json" || fail "GET /healthz body is not {\"status\":\"ok\"}"
echo "[1/4] GET /healthz: ok"

# --- 2. トークンなし -------------------------------------------------------
status="$(mcp_post unauthenticated "$INITIALIZE" none)"
[ "$status" = 401 ] || fail "initialize without Authorization returned HTTP ${status} (expected 401)"
echo "[2/4] initialize without a token: ok (401)"

# --- 3. Keycloak のトークンで initialize → tools/list ----------------------
status="$(mcp_post initialize "$INITIALIZE" token)"
[ "$status" = 200 ] || fail "initialize with the token returned HTTP ${status} (401: the Gateway rejected the token; 503: the Gateway is unreachable)"
summary="$(check_json "$WORK/initialize.json" '
const r = res.result ?? {};
if (typeof r.protocolVersion !== "string" || r.protocolVersion === "") fail("initialize: no protocolVersion");
if (!r.capabilities?.tools) fail("initialize: the server does not declare the tools capability");
const instructions = typeof r.instructions === "string" && r.instructions.trim() !== "" ? "yes" : "no";
console.log(`${r.protocolVersion} ${r.serverInfo?.name ?? "?"} ${r.serverInfo?.version ?? "?"} ${instructions}`);
')" || fail "initialize returned an unexpected result"
read -r NEGOTIATED_VERSION server_name server_version has_instructions <<<"$summary"

status="$(mcp_post tools-list "$TOOLS_LIST" token)"
[ "$status" = 200 ] || fail "tools/list with the token returned HTTP ${status}"
tools="$(check_json "$WORK/tools-list.json" '
const tools = res.result?.tools;
if (!Array.isArray(tools)) fail("tools/list: no tools array");
const names = tools.map((t) => t.name).sort();
if (names.join(",") !== "ask,feedback") fail(`tools/list: unexpected tools: ${names.join(", ")} (expected: ask, feedback)`);
console.log(names.join(", "));
')" || fail "tools/list returned an unexpected result"
echo "[3/4] initialize + tools/list with a token: ok (server $server_name $server_version, protocolVersion $NEGOTIATED_VERSION, instructions: $has_instructions; tools: $tools)"

# --- 4. 不正なトークン -----------------------------------------------------
status="$(mcp_post invalid-initialize "$INITIALIZE" invalid)"
[ "$status" = 401 ] || fail "initialize with an invalid token returned HTTP ${status} (expected 401)"
status="$(mcp_post invalid-tools-list "$TOOLS_LIST" invalid)"
[ "$status" = 401 ] || fail "tools/list with an invalid token returned HTTP ${status} (expected 401)"
echo "[4/4] requests with an invalid token: ok (401)"

echo "orchestrator-smoke: all checks passed"
