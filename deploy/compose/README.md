# deploy/compose — リファレンスデプロイ(Docker Compose)

Gateway と Keycloak を起動する**評価用構成**(T-012)。手順・前提・未実装事項・公開時の必須条件は
[docs/install.md](../../docs/install.md) を参照。

```bash
cp .env.example .env
docker compose up -d --build --wait
KP_SESSION_TOKEN="$(../../scripts/smoke/keycloak-token.sh)" ../../scripts/smoke/gateway-smoke.sh
```

| ファイル | 内容 |
|---|---|
| `docker-compose.yml` | gateway(`deploy/Dockerfile` でビルド)+ keycloak。検索バックエンドは profile `search-backend` の枠のみ |
| `deployment.yaml` | リファレンス設定(コンテナの `/etc/kp/deployment.yaml` に読み取り専用でマウント) |
| `.env.example` | 環境変数の雛形(ローカル評価専用のダミー値) |

- 開発用の部品(`dev-fixture` / `mock_env`)を使うため `NODE_ENV=development` で起動する。
  本番の本人資格情報の取得方式は T-004
- ホストへの公開は `127.0.0.1` だけ。外部への公開は TLS を終端するリバースプロキシ経由にする
  (docs/install.md §6)
- 起動確認は CI の `reference-deploy` ジョブが担う(PR #14 で成功を確認。docs/install.md §0)
