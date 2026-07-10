#!/usr/bin/env bash
# Keycloakのレルムimport完了を待つ(E2E用)。
set -eu
BASE_URL="${KEYCLOAK_BASE_URL:-http://localhost:8080}"
DEADLINE=$((SECONDS + ${KEYCLOAK_WAIT_TIMEOUT_SEC:-180}))
until curl -sf --noproxy '*' "$BASE_URL/realms/kp/.well-known/openid-configuration" >/dev/null; do
  if [ "$SECONDS" -ge "$DEADLINE" ]; then
    echo "keycloak did not become ready within timeout" >&2
    docker compose -f "$(dirname "$0")/docker-compose.yml" logs keycloak | tail -50 >&2 || true
    exit 1
  fi
  sleep 2
done
echo "keycloak ready: $BASE_URL/realms/kp"
