#!/usr/bin/env bash
#
# LibreChat(deploy/compose の LibreChat overlay、T-021)のスモークテスト。CI の reference-deploy
# ジョブとローカルで共用する。
#
#   scripts/smoke/librechat-smoke.sh [LIBRECHAT_URL]
#
# 確認すること(1つでも失敗したら非0で終了する):
#   1. GET /health が 200(起動直後に備えて KP_SMOKE_WAIT_SEC 秒まで待つ)
#   2. GET /oauth/openid が 302 で Keycloak の認可エンドポイント(https)へリダイレクトする。
#      LibreChat が起動時に OpenID のディスカバリ(TLS 終端 keycloak-tls 経由、ローカル CA の
#      信頼を含む)に成功し、ログインを構成できたことを示す(失敗していると 302 にならない)
#
# - ログインそのもの(ブラウザでの認証)と MCP サーバー leisen の呼び出しは確かめない
#   (手元での確認手順は docs/ui-librechat.md)
# - リダイレクト先は origin とパスだけを表示する(クエリの state 等は出さない)
# - 依存は bash / curl だけ
#
# 環境変数:
#   LIBRECHAT_URL           LibreChat のベース URL(既定 http://127.0.0.1:3080。第1引数が優先)
#   KP_SMOKE_OIDC_AUTH_URL  期待する認可エンドポイント(既定 https://keycloak.localhost:8443/
#                           realms/kp/protocol/openid-connect/auth。librechat.env の OPENID_ISSUER
#                           + /protocol/openid-connect/auth)
#   KP_SMOKE_WAIT_SEC       /health を待つ秒数(既定 60)
set -euo pipefail

LIBRECHAT_URL="${1:-${LIBRECHAT_URL:-http://127.0.0.1:3080}}"
LIBRECHAT_URL="${LIBRECHAT_URL%/}"
AUTH_URL="${KP_SMOKE_OIDC_AUTH_URL:-https://keycloak.localhost:8443/realms/kp/protocol/openid-connect/auth}"
WAIT_SEC="${KP_SMOKE_WAIT_SEC:-60}"

fail() {
  echo "librechat-smoke: FAIL: $*" >&2
  exit 1
}
command -v curl >/dev/null || fail "curl is required"

CURL=(curl -sS --max-time 30)
# ループバック宛てはプロキシを使わない(CI・社内プロキシ環境向け。それ以外は環境の設定に従う)
case "$LIBRECHAT_URL" in
  http://127.* | http://localhost | http://localhost:* | http://localhost/* | "http://[::1]"*)
    CURL+=(--noproxy '*')
    ;;
esac

echo "librechat-smoke: target $LIBRECHAT_URL"

# --- 1. /health ----------------------------------------------------------
deadline=$((SECONDS + WAIT_SEC))
status=""
while :; do
  status="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$LIBRECHAT_URL/health" 2>/dev/null || true)"
  [ "$status" = 200 ] && break
  [ "$SECONDS" -ge "$deadline" ] && fail "GET /health did not return 200 within ${WAIT_SEC}s (last status: ${status:-none})"
  sleep 2
done
echo "[1/2] GET /health: ok"

# --- 2. OpenID ログインの開始 -----------------------------------------------
result="$("${CURL[@]}" -o /dev/null -w '%{http_code} %{redirect_url}' "$LIBRECHAT_URL/oauth/openid" || true)"
status="${result%% *}"
location="${result#* }"
location_without_query="${location%%\?*}"
[ "$status" = 302 ] || fail "GET /oauth/openid returned HTTP ${status:-none} (expected 302; the OpenID strategy is not configured — check the librechat logs for [openidStrategy])"
[ "$location_without_query" = "$AUTH_URL" ] ||
  fail "GET /oauth/openid redirected to ${location_without_query:-nothing} (expected $AUTH_URL)"
echo "[2/2] OpenID login redirect: ok (302 to $AUTH_URL)"

echo "librechat-smoke: all checks passed"
