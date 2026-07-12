#!/usr/bin/env bash
# リファレンスデプロイの起動確認(T-012)。CIと手元の両方で使う。
# 前提: docker compose -f deploy/reference/docker-compose.yml up -d --build 済み。
#
# 確認内容:
#   1. keycloakのrealm importが完了している
#   2. gatewayの/healthzが200を返す
#   3. 認証なしのMCP初期化が401で拒否される(認可分岐)
#   4. Keycloak発行トークンでMCPセッションが確立できる(初期化200+セッションID)
#   5. tools/listが4ツール(search/fetch/list/describe)を返す
set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://localhost:3000}"
KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8080}"
TIMEOUT_SEC="${SMOKE_TIMEOUT_SEC:-180}"
CURL=(curl -sS --noproxy '*')

wait_for() {
  local name="$1" url="$2"
  local deadline=$((SECONDS + TIMEOUT_SEC))
  until "${CURL[@]}" -o /dev/null -f "$url" 2>/dev/null; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "smoke: $name did not become ready within ${TIMEOUT_SEC}s ($url)" >&2
      return 1
    fi
    sleep 2
  done
  echo "smoke: $name ready"
}

wait_for keycloak "$KEYCLOAK_URL/realms/kp/.well-known/openid-configuration"
wait_for gateway "$GATEWAY_URL/healthz"

INIT_BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'

# 3. 認証なしは401(fail-closed)
status=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST "$GATEWAY_URL/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d "$INIT_BODY")
if [ "$status" != "401" ]; then
  echo "smoke: expected 401 for unauthenticated initialize, got $status" >&2
  exit 1
fi
echo "smoke: unauthenticated initialize rejected (401)"

# 4. Keycloakからaliceのトークンを取得してセッション確立
#    (開発realmのpassword grant。値はrealm定義のダミー、e2e/keycloak/README.md)
token=$("${CURL[@]}" -X POST "$KEYCLOAK_URL/realms/kp/protocol/openid-connect/token" \
  -d 'grant_type=password' -d 'client_id=e2e-cli' \
  -d 'username=alice' -d 'password=dev-only-alice-password' |
  sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
if [ -z "$token" ]; then
  echo "smoke: failed to obtain a token from keycloak" >&2
  exit 1
fi

headers_file=$(mktemp)
trap 'rm -f "$headers_file"' EXIT
status=$("${CURL[@]}" -o /dev/null -D "$headers_file" -w '%{http_code}' \
  -X POST "$GATEWAY_URL/mcp" \
  -H "authorization: Bearer $token" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d "$INIT_BODY")
session_id=$(tr -d '\r' <"$headers_file" | awk 'tolower($1)=="mcp-session-id:" {print $2}')
if [ "$status" != "200" ] || [ -z "$session_id" ]; then
  echo "smoke: initialize with token failed (status=$status, session_id=${session_id:-none})" >&2
  exit 1
fi
echo "smoke: mcp session established"

# 5. tools/list(initialized通知→一覧取得)
"${CURL[@]}" -o /dev/null -X POST "$GATEWAY_URL/mcp" \
  -H "authorization: Bearer $token" \
  -H "mcp-session-id: $session_id" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
tools=$("${CURL[@]}" -X POST "$GATEWAY_URL/mcp" \
  -H "authorization: Bearer $token" \
  -H "mcp-session-id: $session_id" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')
for tool in search fetch list describe; do
  if ! printf '%s' "$tools" | grep -q "\"name\":\"$tool\""; then
    echo "smoke: tools/list is missing tool '$tool'" >&2
    printf '%s\n' "$tools" >&2
    exit 1
  fi
done
echo "smoke: tools/list returned all four connector tools"

echo "smoke: OK"
