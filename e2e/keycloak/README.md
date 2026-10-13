# Keycloak E2E(T-002 参照実装)

Keycloak を IdP とした IdP Adapter の参照統合。フローは
「Keycloak がユーザーへ発行したトークン → `KeycloakIdpAdapter.authenticate`
(イントロスペクション、RFC 7662)→ `getCredential`(モックプロバイダ)→
モックコネクタ呼び出し」まで。

## この E2E が検証しない範囲(重要)

**このE2Eは「Keycloak発行トークンを受けるモックコネクタ」であり、
Google Drive / Slack 等の実SaaSの認可経路は一切検証しない**(ADR-010 帰結)。

- 実ソースへの本人資格情報の取得(個別OAuth同意、OBO交換)は T-004 の範囲
- 「本人に見えない文書が返らないこと」というソース側認可の検証は
  実コネクタのタスク(T-005/T-006 等)の範囲
- ここで確認できるのは: セッション検証、userId の伝播、資格情報キャッシュの
  ユーザー分離、未認証/未接続の認可分岐、コネクタIFへの `AuthContext` 受け渡し

## 実行方法

```sh
docker compose -f e2e/keycloak/docker-compose.yml up -d
e2e/keycloak/wait-ready.sh
KEYCLOAK_E2E=1 npm test -w @leisen/gateway
docker compose -f e2e/keycloak/docker-compose.yml down
```

`KEYCLOAK_E2E=1` が無い場合、E2Eテスト(`test/e2e/keycloak.e2e.test.ts`)は
skip され、通常の `npm test` は Docker なしで通る。CI では `keycloak-e2e`
ジョブがこの手順を実行する。

## 構成

- realm `leisen`(`realm/leisen-realm.json` から自動import)
- クライアント `gateway`: イントロスペクション用 confidential クライアント
- クライアント `e2e-cli`: テストがパスワードグラントでユーザートークンを
  得るための public クライアント(direct access grants 有効。開発専用)。
  アクセストークンに Gateway を audience として加えるマッパー付き(Gateway の
  `requireAudience: true` のため。issue #16)
- クライアント `librechat`: リファレンスデプロイの LibreChat overlay(T-021、ADR-018)が
  OpenID ログインに使う confidential クライアント(標準フローのみ、PKCE の S256 を必須)。
  リダイレクト先はコールバック `http://localhost:3080/oauth/openid/callback`、ログアウト後の
  戻り先は `http://localhost:3080/login` の完全一致だけ(ワイルドカードを使わない。LibreChat の
  `DOMAIN_SERVER` / `DOMAIN_CLIENT` / `OPENID_CALLBACK_URL` を変えたらここも合わせる)。
  アクセストークンに Gateway を audience として加えるマッパー付き
- ユーザー `alice` / `bob`

パスワード・シークレットはすべてローカル専用のダミー値(`dev-only-` 接頭辞)。
実環境の値をこのディレクトリに書かないこと(不変条件6)。
