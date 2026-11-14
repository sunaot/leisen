# ADR-023: esa を公式リモート MCP サーバー経由で検索するコネクタと、その本人資格情報

Status: Accepted(2026-11-14 オーナー指示で採用)/ Date: 2026-11-14

## 文脈

esa(esa.io)は社内ナレッジの置き場として使われる。esa は公式に 2 つの MCP サーバーを提供している。

- ローカルの MCP サーバー(docs.esa.io/posts/561、2025-09)。stdio で動き、個人アクセストークン(`ESA_ACCESS_TOKEN`)を環境変数で受ける
- リモートの MCP サーバー(docs.esa.io/posts/584、2026-06 β)。`https://mcp.esa.io`。本人ごとの OAuth で認可する

leisen のコネクタは connector-sdk の IF(`search` / `fetch` / `list` / `describe`)を実装する Gateway 内のプラグインで、ソースの API を利用者本人の資格情報で呼ぶ(不変条件 1・2・5)。esa の MCP のツール(`esa_search_posts` 等)はこの IF と別物で、書き込み系のツール(`esa_create_post` 等)も含むため、MCP クライアントへそのまま見せることはできない。

本人資格情報の方式は ADR-022 で 3 つ(IdP トークン方式・Token Vault・ESC)をソースごとに選べる形になった(T-004 実装済み)。

### 確認した外部事実(2026-11-14)

公開のメタデータと未認証の要求で確認した。

- `https://mcp.esa.io/.well-known/oauth-protected-resource`: `authorization_servers: ["https://api.esa.io"]`、`resource: "https://mcp.esa.io"`、`scopes_supported: ["mcp"]`、ヘッダの Bearer だけ
- `https://api.esa.io/.well-known/oauth-authorization-server`: 認可・トークン・失効(`/oauth/revoke`)・動的登録(`/oauth/dcr`)の端点。`token_endpoint_auth_methods_supported` は `client_secret_basic` / `client_secret_post` / `none`。grant は `authorization_code` / `refresh_token` / `urn:ietf:params:oauth:grant-type:token-exchange`。PKCE は S256
- 未認証の MCP 要求は 401 で、`WWW-Authenticate` が上記の resource metadata を指す
- `urn:ietf:params:oauth:grant-type:jwt-bearer`(ID-JAG の引き換えに使う RFC 7523 の grant)は `unsupported_grant_type`。token-exchange は引数を変えても一律に `invalid_request` で、受け付ける `subject_token_type` は外からは分からない
- チームの owner が「SETTINGS > API・アプリ・MCP > アクセス設定 > リモートMCPサーバー」で許可するまで、リモート MCP サーバーへのアクセスは既定で拒否される。許可の形は「すべて許可 / ポリシー(スコープ・カテゴリ)で制限 / ポリシー+アプリごとの owner 承認 / すべて拒否」
- ツールの応答は JSON のテキスト。検索の結果は投稿の配列で、投稿は `url`・`category_and_title_and_tags`(「カテゴリ/名前 #tag」の 1 文字列)・`body_md`・`wip`(`"WIP"` / `"Shipped"`)・`updated_at` を持つ。カテゴリは `{ full_name, count, has_child }` で、`count` は投稿数

## 決定

1. **esa は公式のリモート MCP サーバー(`https://mcp.esa.io`)を上流とする公式コネクタ `@leisen/connector-esa`(`kind: esa`)で扱う。** ローカルの MCP サーバー(stdio、個人アクセストークン)は使わない。利用者ごとの PAT を Gateway に置くことになり、ADR-022 決定 4 の平文提示と同じ問題を持つため
2. **コネクタは Gateway の中で MCP クライアントとして上流を呼ぶ。** 呼び出しはすべて、Gateway が `AuthContext` で渡す本人の OAuth アクセストークン(`Authorization: Bearer`)で行う。MCP クライアントのトークンを上流へそのまま渡さない(MCP の token passthrough の禁止、ADR-022)。上流の MCP は公式 SDK(`@modelcontextprotocol/sdk`、Gateway と同じ版)のクライアントで、操作ごとに接続し、セッションを利用者間で共有しない(不変条件 4)
3. **呼べるツールは読み取り系の許可リスト(`esa_search_posts` / `esa_get_post` / `esa_get_top_categories` / `esa_get_categories`)に限る。** 書き込み系のツールはコネクタから呼べない(型と実行時の両方で拒否する)。owner のポリシーでもスコープを読み取りに絞ることを推奨する(二重の防御)
4. **IF への写像**: `search` → `esa_search_posts`(フィルタは esa の検索修飾子 `updated:>` / `updated:<` / `in:` / `user:` に変換し、修飾子に紛れ込む値は拒否する)、`fetch` → `esa_get_post`(`truncate: false`。長文はコネクタでページに分ける)、`list` → カテゴリ、`describe` → 子を持つ最上位カテゴリ。documentId は `post:<番号>`。IF は変えない(不変条件 5 の ADR は不要)
5. **件数を返さない。** 検索の `total_count` と、カテゴリの `count`(投稿数)は使わない(ADR-012。ゲストのカテゴリ制限がある場合、本人に見えない投稿を数えうる)
6. **対象のチームは deployment.yaml の `settings.team` で 1 つに固定する。** 本人が別のチームにも属していても、そのチームを検索しない(ADR-005、1 デプロイ = 1 社)
7. **領域(scope)は classified とする。** esa にはチーム内の非公開領域の仕組みがない(閲覧範囲はメンバー・ゲストのカテゴリ制限で esa が判定する)ため、既定はすべて `shared`。慣習で個人の場所として使うカテゴリ(例: `Users`)を `settings.privateCategories` で `private` に分類し、除外は Gateway に任せる(ADR-016 追補 2)
8. **本人資格情報は Token Vault と ESC の両方を選べるようにする(ADR-022 決定 1・5)。** どちらも esa の OAuth を Gateway が機密クライアントとして行う。esa 固有の差分は Gateway の OAuth プリセット `esa` だけに閉じる
   - 端点: `https://api.esa.io/oauth/authorize` / `/oauth/token` / `/oauth/revoke`
   - **RFC 8707 の `resource=https://mcp.esa.io` を、認可要求・コード交換・更新の 3 つに載せる。** 受け手を MCP サーバーに限ったトークンを得るため。`connectors[].auth.oauth.resource` で上書きでき、リモート MCP サーバーを上流にする `custom` のソースでも使える
   - スコープは `mcp`(esa が公開する唯一のスコープ。読み取り・書き込みの絞り込みは owner のポリシーで行う)
   - クライアント認証は本文の client secret(`client_secret_post`)
   - 失効は RFC 7009(更新トークンを送る)。本人の解除・IdP の利用停止で Gateway から失効を依頼できる(ADR-022 確認事項 4 の「能動的な失効依頼」を満たす)
9. **本人照合(ADR-022 決定 8)は、esa の MCP サーバーの `esa_get_team_members` で `myself: true` の行の `email` を使う**(2026-11-14 改訂。当初の REST API `GET /v1/user` は、`mcp` スコープのトークンでは 403 になることを実チームで確認した)。照会先はコネクタと同じ MCP エンドポイント・同じチームで、トークンの受け手(`resource`)と一致する。最終アクセスの新しい順に並べ(認可した直後の本人はほぼ先頭)、見つかるまでページを進め、上限(20 ページ)で打ち切る。他のメンバーの行は読み捨て、保管・記録しない。`preset: esa` で照合するには `kind: esa` と `settings.team` が要る(なければ起動時に `esa_identity_check_requires_esa_connector`)。esa はメールアドレスの確認を経てアカウントを有効にするため確認済みとして扱う(変更時の扱いは確認事項 8)。照合できなければ保管せず、得たトークンの失効を依頼する
10. **IdP トークン方式(方式 B)は、esa では現時点で採らない。** ID-JAG の引き換え(jwt-bearer)に対応しておらず、token-exchange が外部 IdP のトークンを受けるかは確認できない。esa が対応したら、`connectors[].auth.provider` を切り替えるだけで移れる(コネクタは方式を知らない)
11. **OAuth クライアントは導入企業が登録し、owner が承認する。** 登録は動的登録(`/oauth/dcr`)を導入時に一度だけ行うか、esa のアプリ登録を使う。リダイレクト URI は `<publicBaseUrl>/connections/callback`。owner のアクセス設定は「ポリシー+アプリごとに承認」にし、leisen のアプリだけを承認する構成を推奨する(docs/direct-connection.md §2。利用者が自分で登録したクライアントを止められる)
12. **トークンの送り先を `mcp.esa.io` に固定する。** `settings.mcpUrl` の上書きは開発・テスト用で、本番(`NODE_ENV=production`)ではオリジンが `https://mcp.esa.io` 以外なら起動を拒否する(設定の誤り・改ざんで本人のトークンが別のホストへ送られることを防ぐ。OAuth の `resource` と同じオリジン。既定の `https://mcp.esa.io/` の末尾の `/` は MCP のパスで、`resource` の値には付けない)。`oauth.resource` は `esa` と `custom` のプリセットにだけ書ける
13. 公式コネクタの許可表(ADR-021)に `esa` → `@leisen/connector-esa` の行を足す。上流がβであるため、応答の形の想定外は `source_unavailable` にし、黙って空の結果にしない

## 帰結

- esa を Token Vault・ESC のどちらでも使える。接続ページ(`/connections`)と、認可サーバーの同意画面での接続の両方が esa のプリセットで動く(結合テストで確認)
- コネクタに MCP SDK の依存が入る(Gateway・Orchestrator と同じ版)。SDK の更新はこの 3 つを揃えて行う
- esa の検索は利用者本人の権限で esa が判定する。leisen は権限を複製しない(不変条件 1、ADR-003)
- 上流の仕様がβで変わりうる。応答の読み取りは寛容に(REST の形も受ける)、想定外は失敗にする
- 1 回の操作ごとに MCP の接続(initialize)を行うため、REST を直接呼ぶより往復が多い。必要になったらセッションの再利用(userId ごと)を検討する

## 残る確認事項(実疎通で確かめる。導入先の esa チームの承認が要る)

1. `mcp.esa.io` に、`resource` を付けて得たトークンで実際に接続できるか(付けない場合に受け手がどうなるか)
2. ~~`GET /v1/user` が `mcp` スコープのトークンで呼べるか~~ → **確認済み(2026-11-14、実チーム): 403 で呼べない。** トークンの交換(`resource` 付きの認可コードの交換)は成功した。本人照合を MCP の `esa_get_team_members` に切り替えた(決定 9)。あわせて、受け手を限ったトークンが `api.esa.io` の REST では使えないことも分かった
3. 更新トークンの寿命とローテーションの有無(Token Vault の直列化と、ESC の更新の挙動に関わる)
4. owner がメンバーを削除・停止したときに、既存のトークンが即時に無効になるか(ESC では退職時の失効をこの経路に頼る。TM-C4)
5. 動的登録で作るクライアントと、esa のアプリ登録で作るクライアントのどちらが owner の承認・ポリシーの対象になるか
6. レート制限の上限値と 429 の `Retry-After` の有無
7. ゲストのカテゴリ制限が MCP の検索・カテゴリ一覧にも効くか(効かなければ classified の分類だけでは足りず、ADR を改める)
8. **(オーナーの判断を要する。2026-11-14 のセキュリティレビュー H-1)** esa がメールアドレスの変更時に新しいアドレスの確認を必須にしているか。必須でなければ、他人の esa アカウントに入れる者が、そのメールアドレスを自分の IdP のアドレスに変えて本人照合を通れる(別人の esa 権限で検索できる)。確認できるまで、決定 9 の照合は「メールアドレスの一致」以上の保証にならない。代案(screen_name と IdP の対応表)は ACL の複製に当たらないかの判断が要る

## 既知の限界(2026-11-14 のセキュリティレビューの Low)

- 期限切れで操作を打ち切ったときは、上流のセッションの終了(DELETE)を送らない(打ち切りの信号で送れないため)。esa 側にセッションが残りうるが、利用者間で共有はしない
- `includeWip: false` は検索語に `wip:false` を足す既定の動作で、利用者の検索語の修飾子で打ち消せる。認可・private の分類には影響しない(閲覧の判定は esa、分類は返った投稿のカテゴリで行う)
- `mcp` スコープは書き込みも許す。書き込みのツールはコネクタから呼べないが、owner のポリシーで読み取りに絞ることを導入手順の必須項目とする

## 参照

- docs.esa.io/posts/584(リモート MCP サーバー)、docs.esa.io/posts/561(ローカル MCP サーバー)
- ADR-003 / ADR-005 / ADR-010 / ADR-012 / ADR-016 追補 2 / ADR-021 / ADR-022、docs/personal-auth.md、docs/direct-connection.md §2
- RFC 8707(Resource Indicators)、RFC 7009(Token Revocation)、RFC 9728(Protected Resource Metadata)、MCP Authorization(token passthrough の禁止)
