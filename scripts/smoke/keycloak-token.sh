#!/usr/bin/env bash
# shellcheck disable=SC2016
# (SC2016: node -e に渡す JavaScript を単一引用符で書いている。シェルで展開しないのが意図どおり)
#
# 【開発・CI 専用】Keycloak(realm leisen。e2e/keycloak/realm/leisen-realm.json)から、
# パスワードグラント(public client e2e-cli)で利用者のアクセストークンを取得し、
# 標準出力に1行で出す。スモークテスト(gateway-smoke.sh)に渡すためのもの。
#
#   LEISEN_SESSION_TOKEN="$(scripts/smoke/keycloak-token.sh)" scripts/smoke/gateway-smoke.sh
#
# - パスワードグラント(Resource Owner Password Credentials)は開発・CI 専用。realm でも
#   テスト用の e2e-cli だけが許可している(direct access grants)。本番の利用者認証に
#   使わないこと
# - 既定値は e2e と同じローカル専用のダミー(ユーザー alice、パスワード dev-only-…)
# - トークンは標準出力にだけ出す(変数に取り込んで使う。ログに出さないこと)。
#   パスワードはコマンドライン引数に載せない(標準入力で curl に渡す)
# - トークンの有効期間は realm の accessTokenLifespan(300 秒)。切れたら取り直す
#
# 環境変数:
#   KEYCLOAK_BASE_URL   既定 http://localhost:8080(deploy/compose / e2e/keycloak の公開ポート)
#   KEYCLOAK_REALM      既定 leisen
#   KEYCLOAK_CLIENT_ID  既定 e2e-cli
#   LEISEN_SMOKE_USERNAME   既定 alice
#   LEISEN_SMOKE_PASSWORD   既定 dev-only-alice-password(realm のダミー値)
set -euo pipefail

BASE_URL="${KEYCLOAK_BASE_URL:-http://localhost:8080}"
BASE_URL="${BASE_URL%/}"
REALM="${KEYCLOAK_REALM:-leisen}"
CLIENT_ID="${KEYCLOAK_CLIENT_ID:-e2e-cli}"
USERNAME="${LEISEN_SMOKE_USERNAME:-alice}"

fail() {
  echo "keycloak-token: $*" >&2
  exit 1
}
command -v curl >/dev/null || fail "curl is required"
command -v node >/dev/null || fail "node is required"

umask 077
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

CURL=(curl -sS --max-time 30)
# ループバック宛てはプロキシを使わない(それ以外は環境の設定に従う)
case "$BASE_URL" in
  http://127.* | http://localhost | http://localhost:* | http://localhost/* | "http://[::1]"*)
    CURL+=(--noproxy '*')
    ;;
esac

# bash -x で実行されてもパスワードを展開した行をトレースに出さない
case "$-" in *x*) restore_xtrace=1 ;; *) restore_xtrace=0 ;; esac
{ set +x; } 2>/dev/null
status="$(printf '%s' "${LEISEN_SMOKE_PASSWORD:-dev-only-alice-password}" |
  "${CURL[@]}" -o "$WORK/token.json" -w '%{http_code}' -X POST \
    --data-urlencode grant_type=password \
    --data-urlencode "client_id=$CLIENT_ID" \
    --data-urlencode "username=$USERNAME" \
    --data-urlencode "password@-" \
    "$BASE_URL/realms/$REALM/protocol/openid-connect/token" || true)"
if [ "$restore_xtrace" = 1 ]; then set -x; fi

# 成功ならアクセストークンだけを標準出力へ。失敗時は OAuth のエラー種別と説明だけを出す
node -e '
const [file, status] = process.argv.slice(1);
let body = {};
try {
  body = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
} catch {}
if (status === "200" && typeof body.access_token === "string" && body.access_token !== "") {
  process.stdout.write(`${body.access_token}\n`);
  process.exit(0);
}
const detail = body.error
  ? `${body.error}${body.error_description ? `: ${body.error_description}` : ""}`
  : "no token in response";
console.error(`keycloak-token: token request failed (HTTP ${status || "none"}; ${detail})`);
process.exit(1);
' "$WORK/token.json" "$status"
