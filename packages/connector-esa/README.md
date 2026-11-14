# @leisen/connector-esa — esa コネクタ(T-026、ADR-023)

connector-sdk v0.4 の `Connector`(`search` / `fetch` / `list` / `describe`)を、esa 公式のリモート MCP サーバー(`https://mcp.esa.io`、β。docs.esa.io/posts/584)の読み取り系ツールで実装したコネクタ。**全呼び出しを利用者本人の esa の OAuth アクセストークンで行い**、認可は esa に委譲する(CLAUDE.md 不変条件1)。

- `capabilities`: `{ nativeSearch: "full", ingest: false, privateScopeHandling: "classified" }`
- 依存: `@leisen/connector-sdk`、`@modelcontextprotocol/sdk`(Gateway と同じ版。上流の MCP クライアント)
- 公開 API は factory(`createEsaConnector`、プラグイン契約の `createConnector`)と型だけ。MCP の呼び出し部品は公開しない(コネクタを経由せずに esa を呼ぶ部品を配らない。不変条件2)
- **実チームでの疎通は未実施**(owner の許可と OAuth クライアントの承認待ち。ADR-023「残る確認事項」)。現状の検証は、公式 SDK で作ったフェイクの MCP サーバーとモックの OAuth による試験

## 資格情報

トークンの用意は Gateway が行い、コネクタは方式を知らない(ADR-022)。

| 方式 | 設定 | 内容 |
|---|---|---|
| Token Vault(既定) | `auth.provider: token_vault` | 接続ページ(`/connections`)で本人が esa に接続し、Gateway が更新トークンを暗号化して保管する |
| ESC | `auth.provider: esc` | Gateway の認可サーバーの同意画面で接続し、esa のトークンを Gateway の鍵で封じた暗号文を MCP クライアントが持つ |
| 開発用 | `auth.provider: mock_env` | `LEISEN_MOCK_TOKEN_ESA` の固定トークン(本番では拒否) |

どちらの本番方式も Gateway の OAuth プリセット `esa` を使う(`resource=https://mcp.esa.io`、scope `mcp`、本人照合は `GET /v1/user` の email、失効は RFC 7009)。設定の書き方は docs/personal-auth.md「esa」。

esa チームの owner は「SETTINGS > API・アプリ・MCP > アクセス設定 > リモートMCPサーバー」でアクセスを許可する(既定は拒否)。「ポリシー+アプリごとに承認」にして leisen のクライアントだけを承認し、ポリシーで読み取り系に絞ることを推奨する。

## IF の写像

| IF | esa の MCP ツール | 補足 |
|---|---|---|
| `search` | `esa_search_posts` | フィルタは検索修飾子へ: `updatedAfter` → `updated:>`、`updatedBefore` → `updated:<`、`container` → `in:`(カテゴリ)、`author` → `user:`(screen_name)。修飾子に紛れ込む値(引用符、空白入りの screen_name 等)は `invalid_request` |
| `fetch` | `esa_get_post`(`truncate: false`) | 見出し(タイトル・カテゴリ・タグ・WIP・更新日時)+ Markdown 本文。`pageChars` ごとにページに分ける |
| `list` | `esa_get_top_categories` / `esa_get_categories` | カテゴリを `folder` として返す。id はカテゴリのパス全体 |
| `describe` | `esa_get_top_categories` | 子を持つ最上位カテゴリを `topContainers` にする |

- documentId は `post:<番号>`。URL は `https://<team>.esa.io/posts/<番号>`
- 呼べるツールは上の 4 つだけ。書き込み系(`esa_create_post` 等)は型と実行時の両方で拒否する
- 件数を返さない: 検索の `total_count`、カテゴリの `count`(投稿数)は使わない(ADR-012)
- 対象のチームは `settings.team` の 1 つに固定する

## プライベート領域

esa にはチーム内の非公開領域の仕組みがない(閲覧範囲はメンバーとゲストのカテゴリ制限で esa が判定する)。既定はすべて `shared` で、`settings.privateCategories` に挙げたカテゴリ(前方一致、区切りは `/`)を `private` に分類する。`privateScopes: excluded`(既定)なら Gateway が除外する。個人の場所として `Users/<名前>` を使うチームでは `privateCategories: [Users]` を設定する。

## settings

| キー | 型 | 既定 | 内容 |
|---|---|---|---|
| `team` | string | (必須) | `<team>.esa.io` の `<team>` |
| `displayName` | string | `esa (<team>)` | describe の表示名 |
| `summary` | string | 汎用の説明 | describe の説明(エージェントの初手選択に使う) |
| `mcpUrl` | string | `https://mcp.esa.io/` | 開発・テスト用の上書き。**本番では `https://mcp.esa.io` のオリジン以外を拒否する**(本人のトークンの送り先の固定) |
| `timeoutMs` | integer | 15000 | 1 回の操作(接続からツールの結果まで)の期限。1000〜120000 |
| `defaultSearchLimit` | integer | 10 | 1〜100 |
| `snippetChars` | integer | 300 | 1〜500 |
| `pageChars` | integer | 20000 | fetch の 1 ページの文字数。1000〜200000 |
| `maxTopContainers` | integer | 30 | 1〜100 |
| `includeWip` | boolean | true | false なら検索に `wip:false` を足す(既定の動作で、検索語の修飾子で打ち消せる。方針ではない) |
| `privateCategories` | string[] | [] | private に分類するカテゴリ |

トークンは settings に書けない(未知のキーとして拒否する)。

## エラーの分類

| 上流 | 分類 |
|---|---|
| HTTP 401 / ツールのエラー `unauthorized` | `auth_expired`(Gateway は再接続を案内する) |
| HTTP 403 / `forbidden` | `permission_denied` |
| HTTP 429 / `too_many_requests` | `rate_limited` |
| ツールのエラー `not_found` | `not_found` |
| 期限切れ・5xx・想定外の応答の形 | `source_unavailable` |

メッセージには分類と HTTP の状態・esa のエラーコードだけを入れ、応答本文・トークン・引数を含めない(不変条件6)。

## 既知の限界

- 1 回の操作ごとに MCP の接続(initialize)を行う。往復が増えるが、セッションを利用者間で共有しない
- 上流はβで、応答の形が変わりうる。想定外は `source_unavailable` にする(黙って空にしない)
- ゲストのカテゴリ制限が MCP の検索にも効くかは未確認(ADR-023 確認事項 7)
- 本人照合(`GET /v1/user` の email)の強さは、esa がメールアドレスの変更時に確認を求めるかに依存する(ADR-023 確認事項 8。未確認)
- 期限切れで打ち切った操作は、上流のセッションの終了を送らない
