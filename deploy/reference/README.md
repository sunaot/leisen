# リファレンスデプロイ(T-012)

gateway + keycloak を `docker compose up` で起動する参照構成。
導入手順・アップグレード手順・本番向けの差し替えポイントは
[docs/install.md](../../docs/install.md) を参照。

```sh
docker compose -f deploy/reference/docker-compose.yml up -d --build
deploy/reference/smoke.sh   # 起動確認(CIと同じ検査)
docker compose -f deploy/reference/docker-compose.yml down
```

- 同梱のKeycloak(realm `kp`、ユーザー `alice`/`bob`)は開発・評価用。
  資格情報はすべてローカル専用のダミー値(`dev-only-` 接頭辞)であり、
  実環境の秘密情報をこのディレクトリに書かないこと(不変条件6)
- コネクタ実体は未登録のため、有効ソースは空(コネクタ実装はT-005以降)。
  ツール面(search/fetch/list/describe)と認証・監査の経路確認までができる
- CIの `reference-deploy` ジョブがこの構成の起動確認を自動実行する
