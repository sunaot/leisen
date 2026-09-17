# 認可実現性マトリクス(T-000a)

Status: Approved(2026-07-12 人間レビュー完了、T-000aゲート解除。ADR-010は同時にAccepted化)/ Date: 2026-07-09

本書は実装前ゲート T-000a の成果物である。主要ソースについて「本人権限アクセス」が実際に
成立する方式を一次情報で確定し、ADR-010(ソース別Auth Adapter + Token Vault)を
Accepted 化する根拠を与える。各セルの記述には一次情報(公式ドキュメント)への参照を付す。

- 調査日: 2026-07-09。一次情報は各項目のURLを正とし、仕様変更があれば本書を改訂する
- 「本人性」= 認可判定が利用者本人に対して行われるか(不変条件1)。「資格情報の形態」とは
  分けて評価する(ADR-010 決定4)
- 未確認・推測の箇所は明示的に「推測」「要確認」と記す

---

## 1. サマリ(結論の一覧)

| ソース | 本人検索API | token exchange (外部IdP→ソース) | 推奨方式 | 本人性 | 検索層(index)要否 | 管理者同意 |
|---|---|---|---|---|---|---|
| Google Drive | ◎ `files.list`(q)/ Cloud Search | ×(WIFはGoogle Cloud限定) | 個別OAuth(3-legged) | ◎ | 不要 | ドメインインストール/事前承認可 |
| Slack | ◎ RTS `assistant.search.context` | ×(本人OAuthのみ) | 個別OAuth(xoxp user token) | ◎ | 不可(ADR-014、ToSで禁止) | アプリ承認要 |
| GitHub | ◎ Search API | ×(GitHub App OAuthのみ) | GitHub App user-to-server token | ◎(app∩user権限) | 不要 | Org承認・SAML SSO要件あり |
| SharePoint/OneDrive | ◎ Graph `/search/query` | **◎ Entra ID OBO(唯一の成立例)** | OBO(delegated) | ◎ | 不要 | admin consent 必須 |
| Confluence | ◎ CQL `/wiki/rest/api/search` | ×(3LOのみ) | 個別OAuth(3LO) | ◎ | 不要 | 組織のアプリ承認ポリシー次第 |
| Notion | △ `/v1/search`(共有範囲のみ) | ×(public integration OAuthのみ) | 個別OAuth(bot user) | **△ 部分的** | 不要(ただし検索範囲に構造的限界) | Enterprise承認リスト |
| Box(参考) | ◎ `GET /search` | △(RFC 8693はdownscope用途) | 個別OAuth + downscope | ◎ | 不要 | 組織設定次第 |
| ファイル共有(SMB/NAS) | ×(中央検索API不在) | ×(OIDC→Kerberos直接経路なし) | KCD/RBCD + S4U(**T-017で検証**) | ○(ACL評価は本人SID、資格はサービスアサート) | **必須(index-required)** | AD管理者設定 |
| オブジェクトストレージ(S3) | ×(全文検索API不在) | ○(trusted identity propagation) | Identity Center + S3 Access Grants | ◎ | **必須(index-required)** | AWS管理者設定 |
| 社内DB・業務システム | ×(標準検索APIなしが多数) | △(自社実装ならRFC 8693受け入れ可) | RLS + SET ROLE / OIDC本人ベアラ | ○(実装依存) | **必須(index-required)** | 個別 |

凡例: ◎=公式に成立 ○=条件付きで成立 △=部分的/実装依存 ×=不成立・不在

**ADR-010 の提案を裏付ける中心的事実:**

1. 外部IdPトークンを各SaaSの本人トークンへ交換する汎用経路は存在しない。成立するのは
   **Microsoft圏(Entra ID On-Behalf-Of)のみ**であり、「token exchange は例外」という
   ADR-010 の反転は正しい
2. Google / Slack / GitHub / Confluence / Notion / Box はいずれも**本人の個別OAuth承認**が
   唯一の本人資格情報取得経路 → Token Vault(リフレッシュトークンの暗号化保管・失効)が
   中核コンポーネントであることが確定
3. ファイル共有・S3・社内DBは「中央検索API不在(index-required)」かつ「委譲身元が必要」の
   交差クラスであり、T-015(検索層)+ T-017(delegated identity スパイク)の両方を要する

---

## 2. Google Drive / Google Workspace

| 項目 | 事実 | 一次情報 |
|---|---|---|
| 本人検索 | `files.list` + `q`(`fullText contains` 等)。本人トークンで実行され本人がアクセスできるファイルのみ返る。Cloud Search Query API(`query.search`)も本人コンテキスト | [検索ガイド](https://developers.google.com/workspace/drive/api/guides/search-files) / [検索語リファレンス](https://developers.google.com/workspace/drive/api/guides/ref-search-terms) / [Cloud Search](https://developers.google.com/workspace/cloud-search/docs/reference/rest/v1/query/search) |
| 本人fetch | `files.get`(`alt=media`)、ネイティブ形式は `files.export`。本人トークンで本人権限評価 | [files.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get) |
| permission check | `files.get` の `capabilities` フィールド(現在のユーザーの実効権限をbool群で返す)。`permissions.list` は共有設定一覧 | [capabilities](https://developers.google.com/drive/api/v3/reference/files) / [permissions.list](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/list) |
| token exchange | **不成立。** Workforce Identity Federation(RFC 8693準拠 STS)は Google Cloud リソース用で、**Workspace API(Drive等)は対象外**(対応プロダクト表に含まれない)。外部IdPは認証(SSO)のみを担い、API認可はGoogle発行OAuthトークンが別途必要 | [WIF](https://docs.cloud.google.com/iam/docs/workforce-identity-federation) / [対応プロダクト・制限](https://docs.cloud.google.com/iam/docs/federated-identity-supported-services) |
| 個別OAuth / scope | 本人ごとの3-legged OAuth同意が必須。`drive.readonly` / `drive.metadata.readonly` は **Restricted scope**(公開アプリはGoogleのセキュリティアセスメント対象。自社利用のinternalアプリは検証免除の区分あり — 導入形態ごとに要確認)。Cloud Search は `cloud_search.query` | [scope分類](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) / [Cloud Search scope](https://developers.google.com/workspace/cloud-search/docs/guides/query-guide) |
| 管理者同意 | 管理者が Admin Console / Marketplace でアプリをドメイン全体にインストール・事前承認、またはブロック可能 | [アプリアクセス制御](https://support.google.com/a/answer/7281227) |
| rate limit | プロジェクト単位 1,000,000 units/分、**ユーザー×プロジェクト 325,000 units/分**(`files.get`=5, `files.list`=100)。超過時 403/429 → 指数バックオフ | [limits](https://developers.google.com/workspace/drive/api/guides/limits) / [errors](https://developers.google.com/workspace/drive/api/guides/handle-errors) |
| private / shared | マイドライブ / 共有ドライブを区別(`corpora=drive`, `includeItemsFromAllDrives=true`)。いずれも本人ACLで可視範囲が決まる。権限外の共有ドライブ名・メタデータは本人トークンでは返らない(TM-B3) | [共有ドライブ](https://developers.google.com/workspace/drive/api/guides/enable-shareddrives) |
| 失効経路 | (a) パスワード変更で一部トークン自動失効、(b) 管理者の明示失効(Admin Console / Directory API `tokens.delete`)、(c) SCIM連携でユーザーをサスペンド/削除→実効アクセス剥奪。発行済みアクセストークンの反映には最大〜1時間程度のラグがあり得る(推測: リフレッシュサイクル依存) | [自動失効](https://support.google.com/a/answer/6328616) / [tokens.delete](https://developers.google.com/workspace/admin/directory/reference/rest/v1/tokens/delete) |
| サービスアカウント系 | **Domain-Wide Delegation は可能**で、`subject` 指定によりACL判定は被なりすましユーザー本人のものになる(本人がアクセスできないデータには到達不可)。Cloud Search Query API はDWD経由でのみサービスアカウント利用可。ただし資格情報はサービスアカウント形態のため、採用する場合はソース別ADRで明示承認(不変条件1) | [DWD](https://support.google.com/a/answer/162106) / [Cloud Search DWD](https://developers.google.com/workspace/cloud-search/docs/guides/delegation) / [ベストプラクティス](https://support.google.com/a/answer/14437356) |

**結論**: 個別OAuth(3-legged)+ 本人トークンで Drive API を呼ぶのが唯一の正規経路。
DWD は本人性を満たすが資格情報がサービスアカウント形態のため、既定では採用せず、
初回同意UXの摩擦が問題化した導入でのみソース別ADRを書いて判断する。

## 3. Slack

| 項目 | 事実 | 一次情報 |
|---|---|---|
| 本人検索 | **RTS API(`assistant.search.context`)** が現行方式(2026-02-17 GA、公式MCPサーバーと同時)。本人がアクセスできる全チャンネルを横断し permission-aware に返す。旧 `search.messages` + `search:read` はレガシーで「使用すべきでない」と明記 | [RTS](https://docs.slack.dev/apis/web-api/real-time-search-api/) / [assistant.search.context](https://docs.slack.dev/reference/methods/assistant.search.context/) / [search.messages(レガシー)](https://docs.slack.dev/reference/methods/search.messages/) / [MCP changelog](https://docs.slack.dev/changelog/2026/02/17/slack-mcp/) |
| 本人fetch / permission check | RTSが返す message/file 参照から本人トークンで取得。独立の permission check API はなし(結果自体が本人可視範囲に絞られる)(推測を含む) | [RTS](https://docs.slack.dev/apis/web-api/real-time-search-api/) |
| token exchange | **不成立。** トークン取得はOAuth認可フローのみ(認可成功時に xoxp user token を受領)。外部IdPトークンからの交換経路は一次情報に存在しない | [installing-with-oauth](https://docs.slack.dev/authentication/installing-with-oauth/) |
| 個別OAuth / scope | xoxp user token を本人OAuth承認で取得。RTS必須scope: `search:read.public` を最低限含む。private channel は `search:read.private`(**Slackクライアント内での本人の事前同意必須・撤回可能**)、DMは `search:read.im` / `search:read.mpim`、ファイルは `search:read.files` | [token types](https://api.slack.com/authentication/token-types) / [search:read.public](https://docs.slack.dev/reference/scopes/search.read.public/) / [search:read.private](https://docs.slack.dev/reference/scopes/search.read.private/) |
| 管理者同意 | ワークスペース/Enterprise のアプリ承認制(`admin.apps.restrict` 等で制限可能)。導入には管理者のアプリ許可が前提 | [admin.apps.restrict](https://docs.slack.dev/reference/methods/admin.apps.restrict/) |
| rate limit | RTS: 多くのチームで 10+ req/min(バースト可)、大規模チームは 400+ req/min。**ユーザー単位 10 req/min**(恒常超過は日次上限)。Web API は Tier制(2025-05に非Marketplaceアプリの制限変更あり) | [RTS](https://docs.slack.dev/apis/web-api/real-time-search-api/) / [rate limits](https://docs.slack.dev/apis/web-api/rate-limits/) / [2025-05変更](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/) |
| private / DM | user token の性質どおり本人が参加しているもののみ可視。private は scope + 本人同意の二重ゲート(ADR-013 の privateScopes 既定 excluded と整合) | [search:read.private](https://docs.slack.dev/reference/scopes/search.read.private/) |
| 失効経路 | **ユーザーアカウントが無効化されるとそのOAuthトークンは失効**(公式明記)。失効時は `tokens_revoked` イベント。SCIM deprovisioning → アカウント無効化 → xoxp 失効の経路が成立 | [installing-with-oauth](https://docs.slack.dev/authentication/installing-with-oauth/) / [auth.revoke](https://docs.slack.dev/reference/methods/auth.revoke/) / [tokens_revoked](https://api.slack.com/events/tokens_revoked) |
| サービスアカウント系 | bot token(xoxb)は特定個人の権限に紐づかず、private会話・クライアント外利用には user token 必須 → **本人性を満たさない。採用不可** | [installing-with-oauth](https://docs.slack.dev/authentication/installing-with-oauth/) |
| データ保存制約 | API ToS: 自組織外からのAPI Dataの使用・処理・**保持は必要最小限**。RTSは「顧客データを外部サーバーに保存せず、その場で取得」が設計思想 → ADR-014 / 不変条件7 と整合 | [API ToS](https://slack.com/terms-of-service/api) / [RTS発表](https://slack.com/blog/news/mcp-real-time-search-api-now-available) |

**結論**: RTS API を本人OAuth承認で得た xoxp user token で呼ぶ(公式MCPサーバー第一候補、
ADR-014)。取得データは永続化しない。bot token・token exchange は不可。

## 4. GitHub

| 項目 | 事実 | 一次情報 |
|---|---|---|
| 本人検索 | Search API(code / issues 等)を **user access token(user-to-server)** で呼ぶと、認証ユーザーがアクセス可能なリソースのみ返り、権限外は列挙されない(存在も漏らさない — TM-B3に好適) | [Search API](https://docs.github.com/en/rest/search/search) |
| 本人fetch / permission check | contents API 等も同一認可モデル(本人がアクセス不可のrepoは404/403)(推測含む)。独立のpermission check APIは不要(アクセス結果自体が判定) | [Search API](https://docs.github.com/en/rest/search/search) |
| token exchange | **不成立。** user access token は GitHub 自身の OAuth(web application flow / device flow)でのみ発行。外部IdPトークンからの交換経路なし | [user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app) |
| 個別OAuth / scope | GitHub App の user access token は **app権限とuser権限の積集合**(app が repo A,B・user が B,C なら B のみ)。fine-grained permissions(従来scope不使用)。token寿命は既定8時間+refresh token 6ヶ月 | [user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app) |
| 管理者同意 | Org の OAuth App アクセス制限(新規Orgは既定ON、オーナー承認制)。**SAML SSO有効Orgでは認可のたびにアクティブなSAMLセッションが必要** | [OAuth App制限](https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/about-oauth-app-access-restrictions) / [SAML SSO認可](https://docs.github.com/en/enterprise-cloud@latest/authentication/authenticating-with-single-sign-on/authorizing-an-app-for-single-sign-on) |
| rate limit | 認証済み primary 5,000 req/hour。**code search は認証時 9 req/min**、他のsearchは最大30 req/min。secondary: 900 points/min 等 | [rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) / [Search API](https://docs.github.com/en/rest/search/search) |
| private / internal | 本人トークンで本人アクセス可能な private も返る。権限外は結果に含まれず非開示。internal repo(Enterprise)はメンバーシップ依存(推測) | [Search API](https://docs.github.com/en/rest/search/search) |
| 失効経路 | **SAML単独では自動deprovisionされず、認可済みトークンはセッション失効後もOrgアクセスを付与し続ける**(公式明記 — 重要リスク)。SCIM有効ならIdP除去でOrgから自動除去。EMUならIdP無効化でセッション・アカウント無効化。手動RevokeはOrg管理画面から可能 | [SCIM for orgs](https://docs.github.com/en/organizations/managing-saml-single-sign-on-for-your-organization/about-scim-for-organizations) / [SAMLアクセス管理](https://docs.github.com/en/enterprise-cloud@latest/organizations/granting-access-to-your-organization-with-saml-single-sign-on/viewing-and-managing-a-members-saml-access-to-your-organization) |
| サービスアカウント系 | installation access token(server-to-server)は app 自身として動作し1時間で失効。特定個人の権限判定にはならない → **本人性を満たさない。採用不可** | [installation token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation) |

**結論**: GitHub App の user-to-server token(web/device flow)で Search / contents API を呼ぶ。
**導入前提として SCIM(理想はEMU)連携を要求する**(SAML単独ではオフボーディング後も
トークンが残存し、TM-C4 の失効要件を満たせない)。

## 5. SharePoint / OneDrive(Microsoft 365)

| 項目 | 事実 | 一次情報 |
|---|---|---|
| 本人検索 | Graph `POST /search/query`。**サインイン中ユーザーのコンテキストで実行され、アイテムのアクセス制御で絞られる**(「GETで取れる以上のものは検索でも取れない」と公式明記)。対象は `driveItem` / `listItem` / `site` / `drive` 等 | [Search API overview](https://learn.microsoft.com/en-us/graph/api/resources/search-api-overview?view=graph-rest-1.0) |
| 本人fetch / permission check | `GET /me/drive/...`、`GET /drives/{id}/items/{id}` 等を delegated トークンで。permissions は `GET /drives/{id}/items/{id}/permissions` | [list permissions](https://learn.microsoft.com/en-us/graph/api/driveitem-list-permissions?view=graph-rest-1.0) |
| token exchange | **成立(本マトリクスで唯一)。** OAuth 2.0 On-Behalf-Of: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` + `requested_token_use=on_behalf_of`。**delegated scope 専用で app roles は使えず、user principal のみ** → 本人性要件と完全整合。assertion の `aud` は中間層API自身であること必須 | [OBO flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-on-behalf-of-flow) |
| 個別OAuth / scope | `Files.Read.All`(delegated)/ `Sites.Read.All`(delegated)はいずれも **admin consent 必須** | [permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference) |
| rate limit | Graph はスロットリング制(per-app / per-user)。search 固有の公開固定値はなし(推測) | [throttling](https://learn.microsoft.com/en-us/graph/throttling) |
| private / shared | OneDrive 個人領域も SharePoint サイトも同一検索コンテキストで、アイテムACLで本人にスコープ | [Search API overview](https://learn.microsoft.com/en-us/graph/api/resources/search-api-overview?view=graph-rest-1.0) |
| 失効経路 | **Continuous Access Evaluation(CAE)**: アカウント削除/無効化・パスワード変更・管理者による全refresh token失効等の critical event で near-real-time 失効(イベント伝播最大15分)。SharePoint Online が subscribe 対象。SCIM→Entra disable→CAE の経路が最短 | [CAE](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-continuous-access-evaluation) |
| サービスアカウント系 | `/search/query` は application permission も受けるが、サインインユーザー不在でテナント横断となり**本人性を満たさない。採用不可** | [search-query](https://learn.microsoft.com/en-us/graph/api/search-query?view=graph-rest-1.0) |

**結論**: Entra ID OBO(delegated)で Graph `/search/query` + fetch。本プロジェクトで
token exchange が正当に成立する唯一のソース。Auth Adapter の「例外系」参照実装となる。

## 6. Confluence(Atlassian Cloud)

| 項目 | 事実 | 一次情報 |
|---|---|---|
| 本人検索 | `GET /wiki/rest/api/search`(CQL)。「**閲覧権限のあるエンティティのみ返る**」と公式明記 | [Search API](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-search/) |
| 本人fetch / permission check | content 取得系を 3LO 本人トークンで。Content Permissions API(操作可否チェック)、Content Restrictions API あり | [content permissions](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-content-permissions/) / [restrictions](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-content-restrictions/) |
| token exchange | **不成立。** 3LO(authorization code)のみ。ユーザーimpersonation(2LOi)は Connect アプリ限定 | [3LO apps](https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/) / [2LOi](https://developer.atlassian.com/cloud/confluence/user-impersonation-for-connect-apps/) |
| 個別OAuth / scope | `search:confluence`(classic)、`read:confluence-content.summary` / `.all`(granular)。Developer Console でアプリ登録・ユーザー同意 | [scopes](https://developer.atlassian.com/cloud/confluence/scopes-for-oauth-2-3LO-and-forge-apps/) |
| 管理者同意 | 組織のアプリ承認ポリシー次第(推測: 組織設定依存) | — |
| rate limit | コストバジェット制(ポイント消費)。429時 `Retry-After` / `X-RateLimit-*` ヘッダ | [rate limiting](https://developer.atlassian.com/cloud/confluence/rate-limiting/) |
| private / shared | Space permission + content-level restriction。本人トークンなら本人権限の範囲で取得 | [Search API](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-search/) |
| 失効経路 | SCIM(Atlassian Guard)でユーザー無効化→トークン失効。access token 短命 + refresh rotation。CAE相当の near-real-time プロトコルはなし(推測: トークン有効期限内は残存しうる) | [3LO apps](https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/) |
| サービスアカウント系 | API token / 2LOi は本人でない主体 → **本人性を満たさない。採用不可** | [2LOi](https://developer.atlassian.com/cloud/confluence/user-impersonation-for-connect-apps/) |

**結論**: 3LO 個別OAuthで本人トークンを取得し CQL search + fetch。標準的な個別OAuth型。

## 7. Notion

| 項目 | 事実 | 一次情報 |
|---|---|---|
| 本人検索 | `POST /v1/search`。ただし対象は**コネクション(bot)に明示共有されたページ/DBのみ**。共有直後はインデックス遅延で返らないことがある | [search limitations](https://developers.notion.com/reference/search-optimizations-and-limitations) |
| 本人fetch / permission check | `GET /v1/pages/{id}` 等。独立の permission check API なし。アクセス可否は「コネクションへの共有 × ユーザーcapability上限」 | [capabilities](https://developers.notion.com/reference/capabilities) |
| token exchange | **不成立。** public integration の OAuth(authorization code)のみ。トークンは **bot user として振る舞う**(`bot_id`) | [authorization](https://developers.notion.com/docs/authorization) |
| 個別OAuth / capabilities | public integration は公開前に Notion のセキュリティレビュー必須。capabilities は「ユーザーの権限を超えない」上限として作用 | [authorization](https://developers.notion.com/docs/authorization) / [capabilities](https://developers.notion.com/reference/capabilities) |
| 管理者同意 | Enterprise はコネクションの承認リスト管理(承認/全ユーザー切断/削除) | [connections管理](https://www.notion.com/help/add-and-manage-connections-with-the-api) |
| rate limit | 平均約 3 req/sec(バースト許容)+ ワークスペース単位の別枠。429 + `rate_limited` | [request limits](https://developers.notion.com/reference/request-limits) |
| private / shared | 明示共有されたページとその子孫のみ。非共有 private は不可視 | [capabilities](https://developers.notion.com/reference/capabilities) |
| 失効経路 | SCIM でユーザー削除可。「トークン生成者がワークスペースを離れる/降格すると全トークン失効」。Revoke token API あり | [SCIM](https://www.notion.com/help/provision-users-and-groups-with-scim) / [revoke token](https://developers.notion.com/reference/revoke-token) |
| サービスアカウント系 | internal integration token(単一bot)は明確に不可 | [authorization](https://developers.notion.com/docs/authorization) |

**⚠ 本人性の構造的限界**: Notion の認可モデルは「botへの明示共有範囲 × ユーザーcapability上限」
であり、リクエスト時に本人権限を都度評価する方式ではない。capability がユーザー権限を超えない
ため**権限逸脱(見えてはいけないものが見える)は起きない**が、**recall の欠落(本人が見える
はずのものが共有されておらず検索できない)が構造的に発生する**。T-020(wikiコネクタ)で
Notion を採用する場合、この限界を describe/README で利用者に開示すること。

**結論**: public integration OAuth(3-legged)。本人性は「逸脱なし・recall欠落あり」の
部分的成立であり、コネクタ実装時にこの特性を明示する。

## 8. Box(SaaSファイル共有、参考)

| 項目 | 事実 | 一次情報 |
|---|---|---|
| 本人検索 | `GET /search`。**要求ユーザーがプレビュー権限以上を持つ項目のみ返る** | [get-search](https://developer.box.com/reference/get-search) |
| OAuth / token exchange | OAuth 2.0 ユーザートークン。**RFC 8693 準拠の downscope**(`grant_type=...token-exchange`)があり、元トークンの権限を超えない最小権限トークンを発行可能 | [downscope](https://developer.box.com/guides/authentication/tokens/downscope/) / [OAuth2](https://developer.box.com/guides/authentication/oauth2) |
| rate limit | 概ね 1,000 calls/分、超過時 `Retry-After` | [rate limits](https://developer.box.com/guides/api-calls/permissions-and-errors/rate-limits) |
| 失効経路 | ユーザートークン失効・IdP連動(推測: Box固有の即時失効仕様は未確認) | — |

**結論**: SaaS型ファイル共有(Box)はネイティブ検索が本人権限で透過するため index 不要。
オンプレSMBとは実現性がまったく異なる — 「ファイル共有」を一括りにせず導入先の実態で分類する。

## 9. ファイル共有(SMB/NAS + Active Directory)

| 項目 | 事実 | 一次情報 |
|---|---|---|
| 本人検索 | **中央検索APIは存在しない**(Windows Search はローカル/対話用)。中央検索には外部インデックスが必須 → **index-required クラスで確定**(ADR-006/008 の第一顧客) | (不在の裏取り。S3の同型構図: [OpenSearch direct query](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/direct-query-s3-overview.html)) |
| 本人権限アクセス | **KCD/RBCD + S4U**: S4U2Self(protocol transition)でユーザーのWindowsトークンを取得し、S4U2Proxy でバックエンドSMB向けチケットを取得。**SMB/NTFS のACL評価は本人SIDに対して行われる** | [KCD overview](https://learn.microsoft.com/en-us/windows-server/security/kerberos/kerberos-constrained-delegation-overview) / [MS-SFU](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-sfu/bde93b0e-f3c9-4ddf-9f44-e1453be7af5a) |
| KCD vs RBCD | KCD(旧来型)は前後サービス同一ドメイン要件。**別ドメイン/フォレストは RBCD 必須**(バックエンド側の `msDS-AllowedToActOnBehalfOfOtherIdentity` で制御) | [KCD overview](https://learn.microsoft.com/en-us/windows-server/security/kerberos/kerberos-constrained-delegation-overview) / [属性](https://learn.microsoft.com/en-us/windows/win32/adschema/a-msds-allowedtoactonbehalfofotheridentity) |
| 本人性の精緻化 | ACL評価は本人SIDだが、資格は**サービスがアサートした身元**(本人の直接認証ではない)。バックエンドは well-known SID で判別可能: `AUTHENTICATION_AUTHORITY_ASSERTED_IDENTITY`(S-1-18-1)vs `SERVICE_ASSERTED_IDENTITY`(S-1-18-2)。**不変条件1の「サービスアカウント系はADR明示承認に限る」に該当する類型 → T-017 の成果でADR化** | [KCD overview](https://learn.microsoft.com/en-us/windows-server/security/kerberos/kerberos-constrained-delegation-overview) |
| OIDC→Kerberos | クラウドIdPのOIDCトークンからSMB用Kerberosチケットへの標準1ステップ経路はなし(推測)。Entra Domain Services で KCD 構成の橋渡し経路あり。実運用はドメイン参加サービスアカウントの S4U による合成 | [Entra DS KCD](https://learn.microsoft.com/en-us/entra/identity/domain-services/deploy-kcd) |
| 失効経路 | アカウント無効化後も**発行済みチケットは期限切れまで有効**(公式明記)。既定ユーザーチケット最大寿命10時間 → 失効ラグを設計に織り込む(TM-C4/C5と同系) | [ticket lifetime](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/security-policy-settings/maximum-lifetime-for-user-ticket) |

**結論**: index-required + delegated identity の交差クラス。方式候補は RBCD + S4U。
成立可否・失効ラグ・S-1-18-2 の扱いは **T-017(Q2スパイク)で実地検証し、ソース別ADRを書く**。
文書検索モジュール本体は Q3(ADR-006/008)。

## 10. オブジェクトストレージ(Amazon S3)

| 項目 | 事実 | 一次情報 |
|---|---|---|
| 本人検索 | 全文検索APIなし(ListObjects は列挙のみ)。全文検索には外部索引(OpenSearch等)が必要 → **index-required** | [OpenSearch direct query](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/direct-query-s3-overview.html) |
| 本人権限アクセス | 第一候補: **IAM Identity Center trusted identity propagation + S3 Access Grants**。外部認証済み本人の代理でAWSへ要求でき、`GetDataAccess` が付与検証してSTS一時トークンを発行。**CloudTrailに実本人への直接参照が残る**(監査要件・不変条件2に好適) | [trusted identity propagation](https://docs.aws.amazon.com/singlesignon/latest/userguide/trustedidentitypropagation-overview.html) / [Access Grants](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-grants-credentials.html) / [チュートリアル](https://docs.aws.amazon.com/singlesignon/latest/userguide/tip-tutorial-s3.html) |
| 代替 | `AssumeRoleWithSAML`(SAML→STS一時資格、既定1時間)。Identity Center 管理ロールには使用不可 | [AssumeRoleWithSAML](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithSAML.html) / [SAMLフェデレーション](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_saml.html) |
| 失効経路 | STS一時資格は短命(既定1h)で自然失効。IdP無効化で以後の発行を拒否。発行済み資格は寿命内有効(推測 — セッションポリシーで別途対処) | [一時資格](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp.html) |

**結論**: index-required + delegated identity。trusted identity propagation + S3 Access Grants
が本人性・監査の両面で最適。T-015/T-016/T-017 の対象。

## 11. 社内DB・業務システム

| 項目 | 事実 | 一次情報 |
|---|---|---|
| RDB(PostgreSQL RLS) | ポリシー式で `current_user` を評価(`CREATE POLICY ... USING (manager = current_user)`)。**本人ごとDBロール + `SET ROLE`** が堅い(切替後IDでRLS評価)。セッション変数方式(`current_setting`)は接続プール共有での取り違えリスクあり。テーブル所有者は既定でRLSバイパス(`FORCE ROW LEVEL SECURITY` で強制)、superuser/BYPASSRLS は常にバイパス | [RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) / [CREATE POLICY](https://www.postgresql.org/docs/current/sql-createpolicy.html) / [SET ROLE](https://www.postgresql.org/docs/current/sql-set-role.html) |
| 自社Webアプリ | OIDC/OAuth 本人ベアラトークンをアプリAPIに渡し、アプリ側が本人権限で応答。標準検索APIは無いことが多い。text-to-query は v1.0 スコープ外(ADR-008) | (一般論。個別導入で確認) |
| token exchange | RFC 8693 は impersonation / delegation 両セマンティクスを定義(`subject_token` / `actor_token` / `may_act`)。**自社アプリの認可サーバが実装すれば受け入れ可能**(標準としては成立) | [RFC 8693](https://datatracker.ietf.org/doc/html/rfc8693) |
| 失効経路 | IdP連動(OAuth失効・イントロスペクション、導入IdP依存)。DBロール方式はロール剥奪で即時失効可 | — |

**結論**: index-required(全文検索が要る場合)+ delegated identity。実現方式は導入先の
実装に強く依存するため、個別導入時に本マトリクスの枠組み(本人検索/fetch/失効/本人性)で
アセスメントする。text-to-query は v1.0 スコープ外を維持。

---

## 12. 横断的結論(ADR-010 への反映)

### 12.1 認可方式の分類(Auth Adapter の型)

| 方式 | 該当ソース | Token Vault 要否 |
|---|---|---|
| A. 個別OAuth(3-legged、本人トークン) | Google Drive, Slack, GitHub, Confluence, Notion, Box | **要**(リフレッシュトークン保管・失効) |
| B. token exchange(OBO) | SharePoint/OneDrive(Entra ID)のみ | 不要(都度交換。IdPセッションに追随) |
| C. delegated identity(委譲身元) | SMB/NAS(RBCD+S4U)、S3(identity propagation)、社内DB(SET ROLE) | 不要(ただし方式ごとにADR承認必須) |
| D. サービスアカウント+本人判定(DWD等) | Google Drive(DWD)— 既定不採用、ソース別ADRで例外承認 | — |

### 12.2 確定事項

1. **ADR-010 の決定1〜4 はすべて一次情報で裏付けられた。** token exchange の汎用経路は
   存在せず(成立は Microsoft 圏のみ)、個別OAuthが主経路、Token Vault が中核
2. **失効の一次経路はソースごとに異なる**: Slack はアカウント無効化で自動失効、M365 は CAE、
   GitHub は SCIM/EMU が前提条件(SAML単独は失効しない)、Kerberos/STS はチケット寿命ラグ。
   Token Vault の deprovisioning 連動(TM-C4)に加え、**GitHub の SCIM 前提は導入
   チェックリスト項目**(T-012)とする
3. **describe/list の権限境界(TM-B3)**: Google/Slack/GitHub/Confluence/M365 とも、本人
   トークンで呼ぶ限り権限外メタデータは返らない(検索・列挙とも本人可視範囲に絞られる)。
   Notion のみ「共有範囲」モデルで、逸脱はしないが recall が欠落する
4. **Notion の本人性は部分的**(逸脱なし・recall欠落あり)。採用時はコネクタの describe で
   限界を開示する(T-020)
5. **index-required クラス(SMB/S3/DB)は delegated identity と不可分**。T-017 スパイクの
   検証対象は RBCD+S4U(SMB)を第一とし、S-1-18-1/2 SID の扱いを含めてADR化する

### 12.3 未確認事項(実装・導入時に確認)

- Google: internal アプリの Restricted scope 検証免除の正確な条件(導入形態ごと)
- Google: 発行済みアクセストークンの失効反映ラグの実測(≦1時間と推定)
- Graph: `/search/query` の実効レート(公開固定値なし。T-005系の実装時に計測)
- Atlassian: 組織アプリ承認ポリシーの既定と near-real-time 失効の有無
- Box: 即時失効仕様
- Slack: docs.slack.dev の一部ページは anti-bot のため全文精読未了(スコープ名・数値は裏取り済み)

## 13. 後続タスクへの反映

- **ADR-010**: 本書の人間レビュー完了をもって Accepted 化(ADR-002 は同時に Superseded)
- **T-002(IdP Adapter IF)**: 方式A/B/C の差を吸収するIFであること。Keycloak E2E は
  実SaaSの認可経路を検証しない限界を README/CI に明記(ADR-010 帰結)
- **T-004(Auth Adapter 実接続)**: 前提を「Entra ID OBO(方式B)+ Google/Slack 個別
  OAuth(方式A)」に確定。GitHub は SCIM/EMU 前提を追加
- **T-017(delegated identity スパイク)**: RBCD+S4U の成立可否・失効ラグ・アサート身元
  SID の扱いを検証し、ソース別ADRを起こす
- **T-012(リファレンスデプロイ)**: 導入チェックリストに「GitHub SCIM 連携必須」
  「Kerberosチケット寿命の短縮検討」「Google 管理者事前承認」を追加
- **T-020(wikiコネクタ)**: Notion の recall 欠落の開示要件
