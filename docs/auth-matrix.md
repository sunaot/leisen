# 認可実現性マトリクス(T-000a)

Status: Draft(人手検証待ち) / Date: 2026-07-07

本書は実装前ゲート T-000a の成果物であり、ADR-010(ソース別Auth Adapter + Token Vault)を
Accepted化する根拠となる調査結果である。主要10ソースについて「本人権限アクセス」が実際に
成立する方式を整理する。

**作成方法と限界**: 本ドラフトはエージェントのモデル知識(2026年1月時点)に基づく。作成環境の
ネットワークポリシーにより各SaaS公式ドキュメントへの直接アクセスによる裏取りは実施できていない。
各セルの参照URLと ⚠️ 印の項目は、人手(公式ドキュメント+各SaaS管理コンソール)での検証が必要。
検証チェックリストは末尾の「9. 人手検証チェックリスト」にまとめた。

- 凡例(方式分類)は「1. 方式の分類」を参照
- 記号: ○=成立 / △=条件付き成立 / ×=不成立 / ⚠️=要人手検証(確信度が低い、またはテナント設定依存)

---

## 1. 方式の分類

| 方式 | 内容 | 資格情報の保持者 | 認可判定の主体 |
|---|---|---|---|
| **A. 個別OAuth** | ユーザーごとに3-legged OAuthで本人アクセストークンを取得。リフレッシュトークンをToken Vaultに暗号化保管 | 本人(委任) | 本人 |
| **B. token exchange / OBO** | IdPトークンをソースAPIトークンへ交換(RFC 8693 / Entra ID on-behalf-of) | 本人(交換) | 本人 |
| **C. サービスアカウント+本人偽装** | サービスアカウント系資格情報で特定ユーザーとしてAPIを実行(Google DWD、Box as-user等)。認可判定は偽装対象の本人に対して行われるが、資格情報自体は全ユーザーを偽装可能 | サービスアカウント | 本人(偽装対象) |
| **D. delegated_identity** | Kerberos制約付き委任(KCD/RBCD)等でOSレベルの本人偽装(ADR-015、T-017スパイク対象) | サービス(委任) | 本人(AD/ACL) |
| **E. 接続不可/個別判断** | 本人単位の認可判定が成立する経路がない。個別ADRなしでは接続しない | — | — |

不変条件1(CLAUDE.md)により、C/Dは「認可判定が本人に対して行われる」場合に限り、
ソースごとのADRで採用可否を判断する。

---

## 2. サマリマトリクス

| # | ソース | 本人検索 | 本人fetch | permission check API | token exchange | 主方式 | 管理者同意 | 退職時失効(IdP連動) |
|---|---|---|---|---|---|---|---|---|
| 1 | Google Drive | ○ files.list(q) | ○ files.get/export | △ 実質fetch判定 | × | A(Cは個別ADR) | △ scope検証/内部アプリ | ○ アカウント停止連動 |
| 2 | Slack | ○ search.messages(userトークン必須) | △ conversations.history(レート制約⚠️) | × | × | A+公式MCP/RTS(ADR-014) | ○ アプリ承認制 | ○ ユーザー無効化で失効 |
| 3 | GitHub | ○ /search/*(user access token) | ○ contents API | ○ repos.get / collaborators permission | × | A(GitHub App user token) | ○ Appインストール承認 | △ org除外/EMUはIdP連動 |
| 4 | Confluence Cloud | ○ CQL search | ○ content API | △ restrictions API+実質fetch判定 | × | A(3LO) | △ アプリアクセス制御⚠️ | ○ Atlassian Guard+SCIM |
| 5 | Jira Cloud | ○ JQL search | ○ issue API | ○ mypermissions | × | A(3LO、Confluenceと同一機構) | △ 同上⚠️ | ○ 同上 |
| 6 | Notion | △ 共有選択範囲のみ | △ 同左 | × | × | A(ただし権限透過に構造的限界)⚠️ | △ ワークスペース設定依存 | △ メンバー削除で失効⚠️ |
| 7 | SharePoint / OneDrive | ○ Microsoft Search API(delegated専用) | ○ Graph driveItem | ○ driveItem permissions | ○ Entra OBO | **B**(唯一の成立圏) | ○ delegated scopeの管理者同意 | ○ Entra無効化+CAE |
| 8 | Box | ○ /2.0/search | ○ files API | ○ collaborations API | × | A(Cのas-userは個別ADR) | ○ アプリ承認 | ○ SCIM+ユーザー無効化 |
| 9 | ファイル共有(SMB/NAS) | ×(検索APIなし→index-required) | △ D方式で成立見込み | △ ACL評価=fetch時 | × | D(T-017スパイクで確定) | —(AD設定) | ○ ADアカウント無効化で即時 |
| 10 | 社内DB・業務システム | システム依存 | システム依存 | システム依存 | × | E(個別ADR必須) | システム依存 | システム依存 |

**結論の要旨**: token exchange(方式B)が公式に前提化できるのはMicrosoft圏(Entra ID OBO)のみ。
それ以外の主要ソースはすべて個別OAuth(方式A)が主経路であり、Token Vault(暗号化保管・
ローテーション・SCIM連動失効)と初回同意UXが必須となる。ADR-010の決定1〜4を裏付ける。

---

## 3. ソース別詳細

### 3.1 Google Drive

| 項目 | 内容 | 参照(要URL検証) |
|---|---|---|
| 本人検索 | ○ Drive API v3 `files.list` + `q`(`fullText contains` 等)。返却は呼び出しユーザーがアクセス可能なファイルのみ | https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list |
| 本人fetch | ○ `files.get` / `files.export`(Google Docs系はexport) | https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get |
| permission check | △ `files.get(fields=capabilities)` で本人の操作可否を取得可。他者権限の列挙(`permissions.list`)は本人がアクセス可能なファイルに限る。実質「本人トークンでfetchできるか」が判定 | https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions |
| token exchange | × 外部IdPトークン→Google Workspace APIトークンの公式汎用経路なし。Workforce Identity FederationはGoogle Cloud API向けであり、**Google Workspace API(Drive等)は対象外** ⚠️(対象サービス一覧で要確認) | https://cloud.google.com/iam/docs/federated-identity-supported-services |
| 個別OAuth | ○ 3-legged OAuth。scope: `https://www.googleapis.com/auth/drive.readonly`(restricted scope) | https://developers.google.com/workspace/drive/api/guides/api-specific-auth |
| 管理者同意 | △ restricted scopeは外部公開アプリだとGoogleのアプリ検証+セキュリティ評価が必要。**同一Workspace内の内部アプリは検証免除** ⚠️。管理コンソールでアプリを信頼済み設定可 | https://support.google.com/cloud/answer/13463073 |
| サービスアカウント系(C) | △ ドメインワイド委任(DWD)で本人偽装可能。認可判定は偽装対象の本人に対して行われるが、資格情報は全ユーザー偽装可能で影響半径が大きい。**採用する場合は個別ADR必須**(ADR-010決定4) | https://developers.google.com/identity/protocols/oauth2/service-account#delegatingauthority |
| rate limit | ⚠️ プロジェクト単位+ユーザー単位のクォータ(既定値は要確認。目安: 12,000クエリ/60秒/プロジェクト) | https://developers.google.com/workspace/drive/api/guides/limits |
| private/shared | ○ マイドライブ/共有ドライブとも本人トークンで権限透過。privateスコープの既定除外はADR-013に従う | — |
| 退職時失効 | ○ Googleアカウント停止/削除でトークン失効。IdP→SCIM→Workspaceアカウント停止の連動で一元化可。管理者は接続済みアプリのトークンを個別取り消し可 | https://support.google.com/a/answer/6328616 |

### 3.2 Slack

| 項目 | 内容 | 参照(要URL検証) |
|---|---|---|
| 本人検索 | ○ `search.messages` / `search.files` は **userトークン(xoxp)必須、botトークン不可**。scope: `search:read`。結果は本人の閲覧範囲(参加チャンネル・DM)に自動で絞られる | https://api.slack.com/methods/search.messages |
| 本人fetch | △ `conversations.history` / `conversations.replies`(userトークンで本人参加範囲)。⚠️ **2025年5月以降に作成された非Marketplaceアプリには厳格なレート制限(conversations.history系: 1 req/分、返却15件程度)が適用される**。この制約が自前コネクタの実用性を大きく損なう | https://api.slack.com/changelog/2025-05-terms-rate-limit-update-and-faq |
| permission check | × 専用APIなし。検索・fetchが本人範囲に自動で絞られることで代替 | — |
| token exchange | × 外部IdPトークン→Slackトークンの経路なし。OpenID Connect対応はサインイン用でありAPIトークンは別 | https://api.slack.com/authentication/sign-in-with-slack |
| 個別OAuth | ○ OAuth v2でuser scopeを取得(`search:read` 等) | https://api.slack.com/authentication/oauth-v2 |
| 公式MCP / RTS | ○ ADR-014の第一候補。Slack公式のReal-Time Search(RTS)/公式MCPサーバーは本人権限で検索し、**取得データの永続化禁止条項**がある(ADR-014・不変条件7)。⚠️ 提供条件・料金・対象プランは法務確認と合わせて要確認(T-006前提の人間タスク) | https://api.slack.com/ (RTS/MCP該当ページ要特定) |
| 管理者同意 | ○ ワークスペース/Enterprise Gridのアプリ承認制(管理者承認) | https://slack.com/help/articles/222386767 |
| rate limit | ⚠️ `search.messages` はTier 2(目安20 req/分)。上記2025年制限と併せて要確認 | https://api.slack.com/apis/rate-limits |
| private/shared | ○ private channel / DMも本人トークンなら本人参加分のみヒット。privateスコープの既定除外はADR-013 | — |
| 退職時失効 | ○ ユーザーの無効化(SCIM連動可)でuserトークン失効。`auth.revoke` で明示失効も可 | https://api.slack.com/methods/auth.revoke |

### 3.3 GitHub

| 項目 | 内容 | 参照(要URL検証) |
|---|---|---|
| 本人検索 | ○ `GET /search/code` / `/search/issues` 等をGitHub Appの **user access token(user-to-server)** で実行。結果は本人がアクセス可能なリポジトリに限定される(ユーザー権限×Appインストール範囲の積) | https://docs.github.com/en/rest/search/search |
| 本人fetch | ○ contents API / issues API 等(同上の積) | https://docs.github.com/en/rest/repos/contents |
| permission check | ○ `GET /repos/{owner}/{repo}` の200/404で判定可。`GET /repos/{o}/{r}/collaborators/{u}/permission` もあり | https://docs.github.com/en/rest/collaborators/collaborators |
| token exchange | × 外部IdPトークン→GitHubトークンの経路なし(ActionsのOIDCはクラウド向けで逆方向) | — |
| 個別OAuth | ○ GitHub Appのユーザー認可フロー。user access tokenは既定で8時間有効、refresh tokenは6ヶ月 ⚠️(expiring token設定に依存) | https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app |
| 管理者同意 | ○ GitHub Appのorganizationへのインストールはorg owner承認 | https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party |
| rate limit | ⚠️ user-to-server: 5,000 req/時(Enterprise Cloudは上限拡大あり)。search: 30 req/分、code search: 10 req/分 | https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api |
| private/shared | ○ private repoも本人アクセス権があればヒット。Appのインストール範囲(リポジトリ選択)が上限になる点に注意 | — |
| 退職時失効 | △ org除外で本人権限が消えるため実質即時(認可判定はGitHub側で毎回本人評価)。**EMU(Enterprise Managed Users)ならIdP連動で無効化**。非EMUの個人アカウントはIdPと直接連動しない ⚠️ 導入先のGitHub形態を要確認 | https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/understanding-iam-for-enterprises/about-enterprise-managed-users |

### 3.4 Confluence Cloud

| 項目 | 内容 | 参照(要URL検証) |
|---|---|---|
| 本人検索 | ○ CQL search(`/wiki/rest/api/search`)。結果は本人のスペース/ページ権限でトリミング | https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-search/ |
| 本人fetch | ○ content API(v2: `/wiki/api/v2/pages/{id}`) | https://developer.atlassian.com/cloud/confluence/rest/v2/ |
| permission check | △ content restrictions APIあり。実質は本人トークンでのfetch可否 | https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-content-restrictions/ |
| token exchange | × 外部IdPトークン→Atlassianトークンの経路なし | — |
| 個別OAuth | ○ OAuth 2.0 (3LO)。granular scope(例: `read:page:confluence`, `read:content-details:confluence`)。rotating refresh token(⚠️ 失効条件: 非アクティブ期限・絶対期限の現行値を要確認) | https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/ |
| 管理者同意 | △ ユーザー自身が同意可能。⚠️ 組織管理者によるサードパーティアプリのアクセス制御(ブロック)設定の有無・既定値を要確認 | https://support.atlassian.com/security-and-access-policies/ |
| rate limit | ⚠️ ポイントベースの動的制限(公表は目安のみ)。429+`Retry-After` 遵守の実装が前提 | https://developer.atlassian.com/cloud/confluence/rate-limiting/ |
| private/shared | ○ 個人スペースもスペース権限に従い本人トークンで透過 | — |
| 退職時失効 | ○ Atlassian Guard(旧Access)+SCIMでアカウント停止→API失敗。トークン自体の即時revokeは⚠️要確認 | https://support.atlassian.com/provisioning-users/ |

### 3.5 Jira Cloud

Confluence Cloudと同一の認可機構(Atlassian 3LO・granular scope・Atlassian Guard)。差分のみ記す。

| 項目 | 内容 | 参照(要URL検証) |
|---|---|---|
| 本人検索 | ○ JQL search(`/rest/api/3/search`)。本人の閲覧権限でトリミング | https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/ |
| permission check | ○ `GET /rest/api/3/mypermissions`(プロジェクト/課題単位の本人権限照会) | https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-permissions/ |
| scope例 | `read:jira-work` または granular `read:issue:jira` 等 | 同上 |

### 3.6 Notion

| 項目 | 内容 | 参照(要URL検証) |
|---|---|---|
| 本人検索 | △ **構造的限界あり**: search APIの対象は「インテグレーションに共有されたページ」のみ。公開OAuthではユーザーが認可時にアクセス許可するページ群を選択する方式であり、**本人の全閲覧権限集合とは一致しない(選択制)**。認可判定の主体は本人だが、再現率が共有選択に依存する | https://developers.notion.com/reference/post-search |
| 本人fetch | △ 同上(共有されたページのみ) | https://developers.notion.com/reference/retrieve-a-page |
| permission check | × 専用APIなし | — |
| token exchange | × | — |
| 個別OAuth | ○ 公開インテグレーションのOAuthフロー自体は成立 | https://developers.notion.com/docs/authorization |
| 公式MCP | ⚠️ Notion公式MCPサーバー(mcp.notion.com、2025年提供開始)は本人OAuthで動作する。アクセス範囲が本人権限全体か選択制かを要確認 — 選択制の限界を緩和できる可能性があるため優先調査 | https://developers.notion.com/docs/mcp |
| 管理者同意 | △ ワークスペース設定でメンバーによるインテグレーション追加を制限可(Enterprise) | https://www.notion.com/help/enterprise-connections |
| rate limit | ⚠️ 平均3 req/秒/インテグレーション(バースト許容あり) | https://developers.notion.com/reference/request-limits |
| private/shared | △ privateページは本人が明示的にインテグレーションへ共有した場合のみ。ADR-013の既定除外方針とは整合的 | — |
| 退職時失効 | ⚠️ ワークスペースからのメンバー削除で当該ユーザーが認可したトークンが失効するかを要確認。SCIMはEnterpriseプランのみ | https://www.notion.com/help/provision-users-and-groups-with-scim |

**評価**: Notionは「本人がアクセスできるものが漏れなく検索対象になる」という権限透過の期待を
満たさない可能性が高い。コネクタ化する場合は `describe` でこの限界(選択制であること)を
明示する設計が必要。T-020の製品選定時の判断材料とする。

### 3.7 SharePoint Online / OneDrive(Microsoft 365)

| 項目 | 内容 | 参照(要URL検証) |
|---|---|---|
| 本人検索 | ○ Microsoft Search API(`POST /search/query`、entityType: driveItem/listItem/site)。**delegated permission専用(application permission不可)であり、結果は本人のACLで常にトリミングされる** — 権限透過が仕様として保証される唯一の検索API | https://learn.microsoft.com/en-us/graph/search-concept-files |
| 本人fetch | ○ Graph `GET /drives/{id}/items/{id}` 等 | https://learn.microsoft.com/en-us/graph/api/driveitem-get |
| permission check | ○ `GET /drives/{id}/items/{id}/permissions` | https://learn.microsoft.com/en-us/graph/api/driveitem-list-permissions |
| token exchange | ○ **Entra ID on-behalf-of(OBO)フローが公式に成立**。Gateway(confidential client)が利用者のIDトークン/アクセストークンをGraphトークンへ交換。**Phase 1主要対象で唯一のB方式成立圏** | https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-on-behalf-of-flow |
| 必要scope | delegated: `Files.Read.All`, `Sites.Read.All` ⚠️(Sites.Read.Allは管理者同意が必要となるテナント設定が多い) | https://learn.microsoft.com/en-us/graph/permissions-reference |
| 管理者同意 | ○ アプリ登録+delegated scopeへの管理者同意(テナントポリシー依存) | https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent |
| rate limit | ⚠️ Graphスロットリング(サービス別・テナント別の動的制限)。429+`Retry-After` 遵守 | https://learn.microsoft.com/en-us/graph/throttling |
| private/shared | ○ OneDrive個人領域/SharePointサイトとも本人権限で透過。privateスコープ既定除外はADR-013 | — |
| 退職時失効 | ○ Entraアカウント無効化でrefresh token失効。CAE(継続的アクセス評価)対応APIならアクセストークンも準リアルタイム失効 | https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-continuous-access-evaluation |
| IdPがEntra以外の場合 | △ 会社IdPがOkta等でもM365テナントがあればEntra経由のフェデレーションでOBO成立。M365未導入ならこの行自体が対象外 | — |

### 3.8 Box

| 項目 | 内容 | 参照(要URL検証) |
|---|---|---|
| 本人検索 | ○ `GET /2.0/search`。本人の閲覧権限でトリミング | https://developer.box.com/reference/get-search/ |
| 本人fetch | ○ files API(`GET /2.0/files/{id}/content`) | https://developer.box.com/reference/get-files-id-content/ |
| permission check | ○ collaborations API(`GET /2.0/files/{id}/collaborations`) | https://developer.box.com/reference/get-files-id-collaborations/ |
| token exchange | × 外部IdPからは不可。Box内部のtoken exchange(downscoping)は自トークンの縮退のみ | https://developer.box.com/guides/authentication/tokens/downscope/ |
| 個別OAuth | ○ OAuth 2.0(3-legged) | https://developer.box.com/guides/authentication/oauth2/ |
| サービスアカウント系(C) | △ Service Account(JWT/CCG)+ `as-user` ヘッダで本人偽装可。認可判定は対象ユーザー本人に対して行われる。管理者の有効化が必要。**採用する場合は個別ADR必須**(Google DWDと同じ扱い) | https://developer.box.com/guides/authentication/jwt/as-user/ |
| 管理者同意 | ○ カスタムアプリの管理者承認(App Approval) | https://developer.box.com/guides/authorization/custom-app-approval/ |
| rate limit | ⚠️ ユーザー単位のAPI呼び出し上限(目安: 10 req/秒/ユーザー、検索は別枠)を要確認 | https://developer.box.com/guides/api-calls/permissions-and-errors/rate-limits/ |
| 退職時失効 | ○ SCIM対応。ユーザー無効化でトークン失効 | https://developer.box.com/guides/box-integrations/scim/ |

### 3.9 ファイル共有(SMB/NAS)

| 項目 | 内容 | 参照 |
|---|---|---|
| 本人検索 | × ネイティブ検索APIなし。**index-requiredクラス**であり検索層(Phase 2、ADR-006)が前提。未認可候補境界はADR-012に従う | docs/product-design-v2.md |
| 本人fetch | △ **D方式(delegated_identity)**: Kerberos制約付き委任(KCD/RBCD)でGatewayサービスが本人を偽装してSMBアクセス。認可判定はAD/NTFS ACLが偽装対象の本人に対して実施。**成立可否はT-017スパイクで確定させる(Q2)** | ADR-015 / docs/backlog/T-017 |
| permission check | △ fetch時のACL評価が実質の判定。事前チェック(Security Descriptor読取)は別権限が必要 | — |
| token exchange | ×(Kerberos委任はOAuthの枠外。RFC 8693とは別系統) | — |
| 管理者同意 | — AD側の委任設定(msDS-AllowedToActOnBehalfOfOtherIdentity等)。セキュリティ部門相談がT-017の前提 | — |
| rate limit | —(APIレート制限の概念なし。ファイラー負荷への配慮を実装側で行う) | — |
| 退職時失効 | ○ ADアカウント無効化で即時(Kerberosチケットの残存TTLに注意 ⚠️ 最大10時間程度) | — |

### 3.10 社内DB・業務システム

| 項目 | 内容 | 参照 |
|---|---|---|
| 総論 | 方式はシステムごとに異なり、一般化できない。**E方式: 個別ADRなしでは接続しない** | — |
| 成立しうるパターン | (a) 業務システム自体が本人単位のAPIトークン/OAuthを持つ場合 → A方式に帰着。(b) DBレイヤの本人性担保: Oracle proxy authentication、PostgreSQL `SET ROLE`+行レベルセキュリティ(RLS)等 → アプリ側でIdP ID→DBロールの対応が管理されている場合のみ | — |
| 成立しないパターン | 共有サービスアカウント+アプリ独自ACLで、当基盤からACLを評価できない場合。**独自ACL複製は不変条件1違反であり実装しない** | CLAUDE.md 不変条件1 |
| 退職時失効 | システム依存。IdP連動が無い場合は導入時のリスク評価事項 | — |

---

## 4. 横断的な発見(ADR-010への反映事項)

1. **token exchange(B方式)が公式に前提化できるのはMicrosoft圏のみ。** Google・Slack・GitHub・
   Atlassian・Notion・Boxのいずれも外部IdPトークンから本人APIトークンへの交換経路を持たない。
   ADR-010の決定1(ソース別Auth Adapter、token exchangeは例外扱い)を裏付ける。
2. **主経路は個別OAuth(A方式)であり、Token Vaultが中核となる。** リフレッシュトークンの暗号化
   保管・ローテーション(Atlassianはrotating refresh token必須)・SCIM連動失効が共通要件。
   ADR-010の決定2を裏付ける。
3. **初回同意UXは製品要件。** A方式の全ソースで本人の同意フローが必要であり、未接続ソースの
   スキップと接続促し(ADR-010決定3)は不可避。
4. **C方式(サービスアカウント+本人偽装)は3ソースで利用可能**(Google DWD、Box as-user、
   SMB Kerberos委任)。いずれも認可判定は本人に対して行われるが、資格情報の影響半径が大きく、
   ソースごとの個別ADRを必須とする(ADR-010決定4)。
5. **Notionは権限透過が構造的に不完全**(インテグレーションへの共有選択制)。「本人が読める
   ものは漏れなく対象」という前提が成立しないため、採用時はdescribeでの限界明示が必要。
6. **Slackの自前コネクタは2025年レート制限で実用性が低下**しており、公式MCP/RTS第一候補
   (ADR-014)の妥当性を補強する。
7. **失効レイテンシはソースごとに異なる**(Entra CAE: 準リアルタイム、OAuthアクセストークン:
   TTL依存で最大1時間程度、Kerberosチケット: 最大10時間程度)。脅威モデル(threat-model.md)の
   「権限剥奪の反映遅延」と認可キャッシュTTL設計(T-003)の入力となる。

## 5. T-004(Auth Adapter実装)への反映

実現可能と確認された作業のみをT-004の対象とする:

- **Entra ID OBOアダプタ**(B方式)— M365導入企業向け
- **Google個別OAuthアダプタ**(A方式、`drive.readonly`)
- **Slack個別OAuthアダプタ**(A方式、`search:read`。ただしT-006は公式MCP/RTS第一候補)
- **GitHub Appユーザー認可アダプタ**(A方式、user access token+refresh)
- **Atlassian 3LOアダプタ**(A方式、rotating refresh token対応必須)
- Token Vault共通機能: KMS連携暗号化、ローテーション、SCIM deprovisioning連動revoke

除外(T-004スコープ外): DWD/as-user(個別ADR待ち)、Kerberos委任(T-017)、Notion(T-020の
製品選定判断待ち)、社内DB(個別ADR)。

## 6. 人手検証チェックリスト

以下は公式ドキュメント・管理コンソールでの人手検証が必要(⚠️ 印の根拠):

- [ ] 本書内の全参照URLの実在と記載内容の一致(エージェントのネットワーク制限により未検証)
- [ ] Google: Workforce Identity FederationのWorkspace API非対応の明文確認/restricted scope検証の内部アプリ免除条件/Drive APIクォータ既定値
- [ ] Slack: search.messagesのrate limit tier現行値/2025年5月レート制限の適用条件(アプリ作成日・Marketplace掲載有無)/RTS・公式MCPの提供条件(法務確認と合流)
- [ ] GitHub: user access tokenの有効期限既定値/導入先がEMUか非EMUか(退職時失効経路が変わる)
- [ ] Atlassian: rotating refresh tokenの失効条件現行値/組織管理者によるサードパーティアプリ制御の既定
- [ ] Notion: 公式MCPのアクセス範囲(本人権限全体か選択制か)/メンバー削除時のトークン失効挙動
- [ ] Microsoft: Sites.Read.All(delegated)の管理者同意要否(導入先テナントポリシー)/Microsoft Search APIのapplication permission不可の明文確認
- [ ] Box: rate limit現行値/as-userの管理者設定手順
- [ ] 各SaaS管理コンソールでのアプリ登録・承認フローの実地確認(T-004サンドボックス準備と合流)
