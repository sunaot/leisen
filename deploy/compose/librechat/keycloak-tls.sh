#!/bin/sh
# keycloak-tls コンテナのエントリポイント(docker-compose.librechat.yml、T-021、評価用)。
#
# Caddy(Caddyfile: Keycloak の前段の TLS 終端)を起動し、Caddy の内部 CA のルート証明書を
# 共有ボリューム(/ca/root.crt)に読み取り可能な権限(0644)で書き出す。Caddy は証明書を
# 0600 で保存するため、別ユーザーで動く LibreChat はそのままでは読めない。LibreChat は
# このルート証明書だけを追加で信頼する(NODE_EXTRA_CA_CERTS)。秘密鍵は書き出さない。
#
# healthcheck は /ca/root.crt の有無で判定する(書き出しは Caddy が内部 CA を用意した後)。
set -eu

ROOT_CERT=/data/caddy/pki/authorities/local/root.crt
EXPORT_DIR=/ca

# 前回の起動で書き出したものは消す(CA を作り直した場合に古いルートを信頼させない)
rm -f "$EXPORT_DIR/root.crt" "$EXPORT_DIR/.root.crt.tmp"

caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
caddy_pid=$!
# docker stop の SIGTERM を Caddy に渡す(このスクリプトが PID 1)
trap 'kill -TERM "$caddy_pid" 2>/dev/null || true' TERM INT

# 内部 CA は起動直後(keycloak.localhost の証明書の発行時)に作られる
while [ ! -s "$ROOT_CERT" ]; do
  if ! kill -0 "$caddy_pid" 2>/dev/null; then
    echo "keycloak-tls: caddy exited before creating its local CA" >&2
    exit 1
  fi
  sleep 1
done
cp "$ROOT_CERT" "$EXPORT_DIR/.root.crt.tmp"
chmod 0644 "$EXPORT_DIR/.root.crt.tmp"
mv "$EXPORT_DIR/.root.crt.tmp" "$EXPORT_DIR/root.crt"
echo "keycloak-tls: exported the local CA root certificate to $EXPORT_DIR/root.crt"

status=0
wait "$caddy_pid" || status=$?
# シグナルで wait が中断された場合は、Caddy の終了をもう一度待つ
if kill -0 "$caddy_pid" 2>/dev/null; then
  wait "$caddy_pid" || status=$?
fi
exit "$status"
