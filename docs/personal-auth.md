# 本人資格情報の方式(Token Vault / ESC / IdP トークン方式)

Leisen はソースの API を常に利用者本人の資格情報で呼ぶ(不変条件 1)。本人の資格情報をどう得て、どこに置くかを、ソースごとに 3 つの方式から選ぶ(ADR-022、2026-11-14 オーナー決定)。この文書は運用者向けの手引きで、決定の理由は ADR-022 と検討メモ(docs/notes/)にある。

## 1. 方式の選び方

| 方式(`connectors[].auth.provider`) | 仕組み | 長命の秘密の置き場所 | 接続の操作 | 使えるソース |
|---|---|---|---|---|
| `token_exchange`(IdP トークン方式) | 要求に添えられた本人の IdP トークンを、呼び出しのたびにソースのトークンへ交換する | なし | なし(IdP のログインに連動) | IdP と信頼関係のあるソースだけ。現時点で確実なのは Microsoft 365(Entra ID の On-Behalf-Of) |
| `token_vault`(既定に推奨) | Gateway の接続ページで OAuth を行い、更新トークンを封筒暗号化して Gateway が保管する | Gateway(状態 DB。鍵は KMS) | 接続ページで 1 回 | 本人ごとの OAuth があるすべてのソース(GitHub / Google / Slack など) |
| `esc` | 同じく OAuth で得たトークンを、Gateway の鍵で封じた暗号文(JWE)にしてクライアントが保持する。Gateway は鍵と拒否リストだけを持つ | クライアント(暗号文) | クライアントのログイン時の同意画面 | 同上。Gateway の認可サーバーが要る |

選び方の目安:

- IdP トークン方式が成り立つソースは `token_exchange` にする。保管も接続の操作もなく、失効は IdP に追随する
- それ以外は `token_vault` を既定にする。すべてのクライアント(素の LibreChat を含む)で同じ接続ページが使え、IdP での利用停止に合わせて Gateway がソースへ失効を依頼できる
- 導入先が「本人の資格情報をサーバーに永続化しない」ことを要件にする場合だけ、そのソースを `esc` にする。代償は §6 にまとめた(ソースを後から足すと再ログインが要る、鍵が漏れると配布済みの暗号文がすべて開ける、IdP 起点でソースへ能動的に失効を依頼できない)

開発用の `mock_env`(環境変数の固定トークン)は従来どおりで、本番(`NODE_ENV=production`)では起動しない。

## 2. 共通の設定

`token_vault` / `esc` / 認可サーバーを使う構成では、次の 2 つが要る。設定例は `examples/deployment.credentials.yaml`。

```yaml
gateway:
  publicBaseUrl: https://leisen.example.com   # ブラウザ・MCP クライアントから見た URL。本番は https
  credentials:
    store: { kind: sqlite, path: /var/lib/leisen/credentials.db }
    keys: { kind: local }                     # local / aws_kms / gcp_kms
```

- **状態 DB**(`credentials.store`): SQLite の 1 ファイル。Token Vault の暗号文と、ESC・認可サーバーの拒否リスト・使用済みの印(資格情報を含まない)を置く。ボリュームに置いてバックアップの対象にする。ファイルは 0600 で作られる。Node 22.13 以上が要る(`node:sqlite`。起動時に実験的機能の警告が 1 行出る)
- **鍵**(`credentials.keys`): Token Vault のデータ鍵(資格情報 1 件ごとに生成)を包む鍵
  - `local`: 環境変数 `LEISEN_VAULT_KEY`(32 バイト。`openssl rand -base64 32`)。入れ替え中の旧鍵は `LEISEN_VAULT_KEY_PREVIOUS`(カンマ区切り)
  - `aws_kms`: `keyId`(ARN またはエイリアス)と `region`。KMS を呼ぶ IAM は環境変数(`AWS_ACCESS_KEY_ID` 等)かコンテナの資格情報(ECS / EKS Pod Identity)から得る。キーポリシーで Gateway のロールに `kms:Encrypt` / `kms:Decrypt` だけを許す
  - `gcp_kms`: `keyName`(`projects/…/cryptoKeys/…`)。アクセストークンは `GOOGLE_APPLICATION_CREDENTIALS` のサービスアカウント鍵、なければメタデータサーバーから得る。役割は `roles/cloudkms.cryptoKeyEncrypterDecrypter` だけにする
  - KMS を呼ぶための基盤の資格情報はソースへのアクセスには使わない(不変条件 1 の対象外)
- **ESC の鍵**(`credentials.escKeyEnv`、既定 `LEISEN_ESC_KEY`): Gateway が封じるトークン(ESC・認可コード・state・ブラウザのセッション)の鍵。32 バイト。Token Vault の鍵とは別の値にする(同じ値は起動時に拒否)。`esc` を使わない構成でも、接続ページのセッションに使う

| 環境変数 | 用途 | 必須の条件 |
|---|---|---|
| `LEISEN_ESC_KEY` | Gateway が封じるトークンの鍵(32 バイト) | `token_vault` / `esc` / 認可サーバーのいずれか |
| `LEISEN_ESC_KEY_PREVIOUS` | 入れ替え中の旧鍵(カンマ区切り) | 鍵の入れ替え中だけ |
| `LEISEN_VAULT_KEY` / `LEISEN_VAULT_KEY_PREVIOUS` | Token Vault の鍵(`keys.kind: local`) | `token_vault` かつ `local` |
| `LEISEN_ADMIN_CREDENTIAL` | 利用停止の管理 API(32 文字以上) | 任意(未設定なら管理 API は無効、起動時に WARNING) |
| ソースごとの `clientSecretEnv` | ソースの OAuth クライアントの secret | そのソースを有効にするとき |

## 3. IdP 側の設定(ブラウザのログイン)

接続ページと認可サーバーの `/authorize` は、利用者のブラウザを IdP にログインさせて本人を確定する。Gateway は IdP の OIDC クライアント(認可コード + PKCE の機密クライアント)になり、`idp.adapter` の `clientId` / `clientSecretEnv` を使う。

Keycloak の場合:

- Gateway のクライアントで **Standard Flow を有効**にし、リダイレクト URI に `<publicBaseUrl>/login/callback` を登録する
- `idp.adapter.allowedClients` に **Gateway 自身の `clientId` を含める**(Gateway がログインで得たトークンも検証するため。なければ `idp_login_client_not_allowed` で起動を拒否)
- イントロスペクションの応答に `email` / `email_verified` を含める(既定のスコープ `email`)。接続時の本人照合(§4)に使う
- ブラウザから見える IdP の URL が `baseUrl` と異なる構成では、`allowedIssuers` の先頭にブラウザから見える発行者を書く(認可画面の URL に使う)

モック IdP(開発用)では、IdP の画面の代わりにセッショントークンを入力するフォームが出る。メールアドレスは `LEISEN_MOCK_SESSIONS=dev-token=alice;email=alice@example.com` の形で与える。

## 4. ソースの OAuth クライアント(token_vault / esc)

```yaml
auth:
  provider: token_vault        # または esc
  oauth:
    preset: github             # github / google / slack / esa / custom
    clientId: Iv23li...
    clientSecretEnv: LEISEN_GITHUB_APP_SECRET
    scopes: []                 # プリセットが本人照合に要るスコープを足す
    identityCheck: email       # 既定。none は confirmIdentityCheckDisabled: true が要る
```

- ソース側にアプリ(OAuth クライアント)を登録し、コールバック URL に **`<publicBaseUrl>/connections/callback`** を登録する(`token_vault` / `esc` 共通)
- client secret は Gateway だけが持つ。リダイレクト先を固定した機密クライアントなので、利用者がアプリを流用してソースを直接呼ぶことはできない(docs/direct-connection.md §2 の許可リストの前提)
- **本人照合**(ADR-022 決定 8): 接続時に、ソース側アカウントの検証済みメールアドレスと IdP のメールアドレスの一致を確かめる。一致しなければ保管せず、得たトークンをソースへ失効依頼して捨てる(私用アカウントの誤接続の防止)
  - GitHub: `GET /user/emails` の verified なもの(GitHub App は「Email addresses」の読み取り権限が要る)
  - Google: userinfo の `email`(`email_verified: true`)。スコープ `openid email` を自動で足す
  - Slack: `users.info` の `profile.email`。`authed_user.id` は照会にだけ使い、保管しない(不変条件 7)。スコープ `users:read` `users:read.email` を自動で足す
  - esa: MCP の `esa_get_team_members` の `myself: true` の行の `email`(ADR-023。`mcp` スコープのトークンでは REST の `GET /v1/user` が 403 になるため、コネクタと同じ MCP サーバー・チームで引く。`kind: esa` と `settings.team` が要る)
  - custom: `endpoints.userinfoEndpoint` の `email` / `email_verified`
- プリセットの端点は `endpoints` で上書きできる(GitHub Enterprise Server は `authorizationEndpoint` / `tokenEndpoint` / `apiBaseUrl`)
- `resource`(RFC 8707)はトークンの受け手。リモート MCP サーバーを上流にするソースで使い、認可要求・コード交換・更新の 3 つに同じ値を載せる。`esa` プリセットの既定は `https://mcp.esa.io`

### esa(ADR-023)

```yaml
- id: esa
  kind: esa                    # 公式コネクタ(@leisen/connector-esa)
  settings:
    team: example-team         # <team>.esa.io の <team>。このチームだけを検索する
    privateCategories: [Users] # 個人の場所として使うカテゴリを private に分類する
  auth:
    provider: token_vault      # または esc
    oauth:
      preset: esa
      clientId: <esa の OAuth クライアント ID>
      clientSecretEnv: LEISEN_ESA_CLIENT_SECRET
      scopes: [mcp]
```

- esa チームの owner が「SETTINGS > API・アプリ・MCP > アクセス設定 > リモートMCPサーバー」でアクセスを許可する(既定は拒否)。「ポリシー+アプリごとに承認」にして leisen のクライアントだけを承認し、ポリシーで読み取り系に絞ることを推奨する
- クライアントは `https://api.esa.io/oauth/dcr`(動的登録)で一度だけ登録する。リダイレクト URI は `<publicBaseUrl>/connections/callback`、認証方式は `client_secret_post`。得た client secret は環境変数で渡す
- コネクタは esa の読み取り系のツールだけを呼ぶ。書き込み系のツールは MCP クライアントに見えない。`mcp` スコープ自体は書き込みも許すので、owner のポリシーで読み取りに絞ることは**必須**とする
- 本番ではトークンの送り先を `https://mcp.esa.io` に固定する(`settings.mcpUrl` の上書きは開発・テスト用)
- 本人照合はメールアドレスの一致による。esa がメールアドレスの変更時に確認を求めるかは未確認(ADR-023 確認事項 8)

## 5. IdP トークン方式(token_exchange)

```yaml
auth:
  provider: token_exchange
  exchange:
    kind: entra_obo            # または rfc8693
    tokenEndpoint: https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token
    clientId: <中間層 API のアプリ ID>
    clientSecretEnv: LEISEN_ENTRA_CLIENT_SECRET
    scope: https://graph.microsoft.com/.default   # entra_obo では必須
```

- `entra_obo`: On-Behalf-Of(`grant_type=jwt-bearer`、`requested_token_use=on_behalf_of`)。利用者の IdP トークンの `aud` は、Gateway のアプリ(中間層 API)であること(Entra ID の要件)。delegated のスコープに管理者の同意を済ませておく
- `rfc8693`: 汎用の token exchange(Keycloak の token exchange 等)。`audience` / `resource` / `scope` と、クライアント認証(`client_secret_basic` 既定 / `client_secret_post`)を指定する
- 同意・条件付きアクセスの不足(`interaction_required` 等)は `source_not_connected` として利用者に返る(本人が IdP 側で対応する)

## 6. Gateway の MCP 認可サーバー(esc を使うとき)

`gateway.authorizationServer.enabled: true` にすると、Gateway が MCP の認可サーバーになる(ADR-022 決定 4)。MCP クライアント・LibreChat は IdP のトークンの代わりに Gateway が発行したトークンを持つ。

- 公開する端点: `/.well-known/oauth-protected-resource`(RFC 9728)、`/.well-known/oauth-authorization-server`(RFC 8414)、`/authorize`(PKCE S256 必須)、`/token`、`/revoke`(RFC 7009)、`/register`(RFC 7591。`allowDynamicRegistration: true` のときだけ)
- MCP の 401 応答の `WWW-Authenticate` に `resource_metadata` が付き、対応したクライアントは自動で認可サーバーを見つける
- クライアントは `clients` に事前登録する(`clientId`、`redirectUris` は完全一致で照合。https かループバックの http)。`clientSecretEnv` があれば機密クライアント。resource を送らないクライアントは `defaultResource` で受け手を決める
- 発行するアクセストークンは ESC の束(本人、受け手、本人の IdP トークン、`esc` のソースのトークン)を JWE で封じたもので、Gateway だけが開ける。有効期間は `accessTokenTtlSec`(既定 300 秒)と、IdP・ソースのトークンの期限の最小
- リフレッシュトークン(既定 30 日)は使うたびに入れ替わる。使用済みの再提示を検知すると、そのログインの系列全体を拒否する。リフレッシュのたびに IdP のトークンを更新し、本人がまだ有効かを IdP に確かめる(IdP での利用停止はここで反映される。遅延の上限はアクセストークンの有効期間)
- `esc` のソースのトークンの更新(ソース側のローテーションを含む)は、リフレッシュのときだけ行う。呼び出しの途中では更新しない
- `acceptIdpTokens: true` にすると IdP のトークンの直接提示も受ける(移行期間・開発用。本番では起動を拒否)

### 6.1 esc のソースの接続

`esc` のソースは、クライアントのログイン(`/authorize`)の同意画面で接続する。接続しなかったソース、後から追加したソースを使う要求には、Gateway が `403 insufficient_scope`(`scope="mcp source:<id>"`)を返す。MCP の step-up に対応したクライアントは、その scope で再認可する(同意画面で接続する)。対応しないクライアントでは再ログインが要る。

### 6.2 Orchestrator・LibreChat

Orchestrator(`leisen-ask serve`)は受けたトークンを Gateway にそのまま転送しない。Gateway の `/token` で RFC 8693 により Gateway 宛ての短命トークンに交換してから使う(ADR-022 決定 10。ADR-018 決定 8 の直接転送はこの構成では使わない)。

```bash
leisen-ask serve --gateway http://gateway:8787/mcp --config deployment.yaml \
  --authorization-server https://leisen.example.com \
  --public-url https://leisen.example.com/ask/mcp
```

- deployment.yaml の `authorizationServer.orchestratorResource` を `--public-url` と同じ URL にする
- 交換のクライアント認証は `LEISEN_ORCHESTRATOR_CREDENTIAL`(run API と同じ値)。Gateway 宛ての受け手は `--gateway-resource`(既定 `<--authorization-server>/mcp`)
- LibreChat は MCP サーバー(Orchestrator)の OAuth 設定で、`authorization_url` を `<publicBaseUrl>/authorize`、`token_url` を `<publicBaseUrl>/token`、`client_id` / `client_secret` を事前登録の値にする。LibreChat のコールバック URL を `redirectUris` に、`defaultResource` を `orchestratorResource` にする(設定キーは LibreChat のバージョンで異なる。docs/ui-librechat.md を参照し、導入時に実機で確かめる)

## 7. 失効と利用停止

責任分担(ADR-022 決定 6): **ソース側の経路(SCIM・アカウント無効化・CAE)を一次とし、Gateway の失効依頼・拒否は追加の防御とする。** 導入チェックリスト(docs/install.md §10)のソース側の前提(GitHub の SCIM 連携等)は、どの方式でも要る。

- **本人の解除**: 接続ページの「解除」。`token_vault` はソースへ失効を依頼して削除する。`esc` は「この時刻より前に取得したそのソースのトークンを拒否」を拒否リストに入れる(全クライアントで使えなくなる)
- **ログアウト**: クライアントの `/revoke` でそのログインの系列を拒否し、含まれていた `esc` のソースのトークンもソースへ失効を依頼する
- **利用停止**(IdP で無効化した利用者): 管理 API に通知する

  ```bash
  curl -sS -X POST https://leisen.example.com/admin/deprovision \
    -H "authorization: Bearer $LEISEN_ADMIN_CREDENTIAL" -H "content-type: application/json" \
    -d '{"userId":"<IdP の sub>"}'
  ```

  Token Vault の当該利用者の全トークンをソースへ失効依頼して削除し、Gateway が発行したトークンを「この時刻より前の発行」として拒否し、資格情報のキャッシュを捨てる。応答はソースへの失効依頼の成否の件数。IdP の利用停止のイベント(SCIM 等)からこの API を呼ぶ連携は導入先で組む
- **esc の限界**: Gateway はクライアントが持つ暗号文の中身を持たないため、IdP 起点でソースへ能動的に失効を依頼できない。Gateway 経由の利用は拒否リストで止まるが、ソース側でトークンを失効させるのはソース側の経路(SCIM 等)だけになる

## 8. 鍵の入れ替え

- **ESC の鍵**: 新しい鍵を `LEISEN_ESC_KEY`、旧鍵を `LEISEN_ESC_KEY_PREVIOUS` に置いて再起動する。新しい発行は新鍵で行い、旧鍵で封じたものも開ける。旧鍵で封じたリフレッシュトークンの最長期間(`refreshTokenTtlSec`)が過ぎてから旧鍵を外す。旧鍵を外した時点で残っているログインは再ログインになる。鍵が漏れたときは直ちに入れ替えて旧鍵を外す(配布済みの全 ESC が開ける状態のため、全員が再ログインになる)
- **Token Vault の鍵(local)**: 新しい鍵を `LEISEN_VAULT_KEY`、旧鍵を `LEISEN_VAULT_KEY_PREVIOUS` に置く。包み直し(`TokenVault.rewrapAll`)を実行する CLI はまだないため、当面は旧鍵を並べ続ける(各行は更新のたびに新鍵で包み直される)
- **KMS**: KMS 側の鍵のローテーション(自動ローテーション)に任せる。Leisen 側の操作は要らない

## 9. 監査

接続・解除・失効・トークンの発行は監査レコード `credential_event` に残る(ADR-022 決定 9)。事象は `connect_started` / `connected` / `connect_failed`(理由: `identity_mismatch`、`consent_denied`、`state_binding_mismatch` 等)/ `disconnected` / `revoked` / `deprovisioned` / `refresh_failed` / `token_issued` / `token_refreshed` / `token_exchanged` / `token_revoked` / `token_reuse_detected`。トークンの値・メールアドレス・ソース側のアカウント識別子は含めない。接続導線の離脱率は `connect_started` と `connected` の差で測れる。

## 10. 既知の制約

- `/authorize` の途中(IdP のログイン後からコードの発行まで、最長 10 分)の状態は Gateway のプロセス内のメモリに置く(ログイン前の要求は封じた state で運び、メモリに置かない。進行中の取引は利用者 1 人あたり 20 件まで)。複数レプリカでは次がプロセスごとに閉じるため、当面は 1 レプリカで動かす: 取引の表(スティッキーセッションが要る)、Token Vault の更新の直列化(状態 DB の比較交換で衝突は検出する)、資格情報キャッシュ(あるレプリカでの解除・利用停止が他のレプリカのキャッシュに TTL まで残る)。状態 DB(SQLite)も 1 ファイルで、共有は想定していない
- 本人照合はメールアドレスの一致で、私用アカウントに会社のメールアドレスを検証済みで追加した場合は防げない(GitHub)。Google は Workspace のアカウント(`hd` がメールのドメインと一致)だけを受ける
- 期限切れの拒否リスト・使用済みの印は 1 時間ごとに消す
- 本番では外部の端点(OAuth・token exchange・KMS・Orchestrator)にループバック以外の平文 http を使えない(`plain_http_endpoint`)
- 動的登録(`allowDynamicRegistration`)は登録を保管しない(封じた client_id を返す)ため、登録の数・頻度の上限がない。リダイレクト先は https とループバックに限る
- MCP の Client ID Metadata Documents(クライアント ID を URL にする方式)には未対応
- `esc` のソースのトークンを更新したリフレッシュの応答がクライアントに届かなかった場合、ソース側で旧い更新トークンが失効していれば(GitHub 等のローテーションするソース)、そのソースだけ再接続になる
- 接続後に同じ質問を自動で再実行する導線(ADR-022 決定 7)は未実装。接続ページは「元の画面に戻って同じ質問を送り直す」よう案内する
- `leisen-ask`(1 問の CLI)は認可サーバーへのログインに対応していない。認可サーバーを有効にした構成では `acceptIdpTokens`(開発用)か、MCP クライアント・LibreChat から使う
- Token Vault の包み直しの CLI はない(§8)
