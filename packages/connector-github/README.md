# @kp/connector-github — GitHub コネクタ(T-019)

connector-sdk v0.3(ADR-016)の `Connector`(`search` / `fetch` / `list` / `describe`)を GitHub REST API で実装したコネクタ。**全呼び出しを利用者本人の user access token で行い**、認可は GitHub に委譲する(CLAUDE.md 不変条件1、ADR-010、`docs/auth-matrix.md` §4)。

- `capabilities`: `{ nativeSearch: "degraded", ingest: false }`。コード専用索引(シンボル・AST)はコア外(ADR-008 §5)
- 外部依存なし(`@kp/connector-sdk` のみ)。HTTP は注入可能な `fetch`(既定はグローバル `fetch`。注入する実装の前提は「リダイレクトの扱い」を参照)
- 公開 API は `createGitHubConnector` と型(`GitHubConnector` / `GitHubConnectorOptions` / `FetchLike` / `RateLimitOptions`)のみ。API クライアント・残quota追跡・documentId の符号化は内部実装で公開しない(Gateway を経由せずに GitHub を呼ぶ部品を配らない、不変条件2)
- **実アカウントでの手動疎通は未実施**(GitHub App の組織承認待ち。T-019 の人手の前提)。現状の検証はフェイク GitHub API(注入 fetch)によるユニットテストのみ

## 前提(導入・認可)

auth-matrix §4 の結論に従う。

| 項目 | 前提 |
|---|---|
| 資格情報 | **本番は GitHub App の user access token(user-to-server。web application flow / device flow で本人が認可)に限る**(ADR-010 方式A、auth-matrix §4)。Token Vault によるリフレッシュ・失効管理(TM-C4: 退職・権限剥奪時の revoke)の対象にするため。PAT(本人の fine-grained PAT を含む)は開発時の `MockCredentialProvider` 経由(`KP_MOCK_TOKEN_GITHUB`、下記「ローカル開発」)に限定し、本番の資格情報には使わない(発行・失効が利用者任せになり Token Vault の管理外になる) |
| 使わないもの | GitHub App の installation access token、サービスアカウント、共有 PAT。app 自身として動作し本人の権限判定にならないため**採用不可**(auth-matrix §4)。コネクタにこれらへのフォールバックはない。多層防御として、installation token(`ghs_`)・refresh token(`ghr_`)の接頭辞を持つトークンは API を呼ぶ前に `invalid_request` で拒否する(資格情報プロバイダの取り違えの検知。メッセージにトークンを含めない) |
| 資格情報の形式 | `AuthContext.credential.kind === "oauth_bearer"`。`delegated_identity` は `invalid_request` で拒否する |
| 実効範囲 | GitHub App の user token は「app の権限・インストール範囲」∩「本人の権限」。app を組織にインストールし(対象リポジトリは全て推奨)、本人が認可する |
| GitHub App の権限(read) | Metadata、Issues、Pull requests、Contents。検索 API と `/user/orgs` は追加権限不要(結果は本人と app がアクセスできる範囲に絞られる) |
| 組織側の設定 | OAuth App アクセス制限(新規 org は既定 ON・オーナー承認制)の承認。**SAML SSO 有効の org では本人がトークンを SSO 認可すること**(未認可の org のリソースは `permission_denied`、検索結果からは黙って除外される) |
| 失効(TM-C4) | **SCIM(理想は Enterprise Managed Users)連携を導入前提とする**。SAML 単独ではオフボーディング後も認可済みトークンが org へのアクセスを保ち続ける(GitHub 公式明記)。導入チェックリスト(T-012)の項目 |

`expiresAt` が経過した資格情報、および `expiresAt` が有限数でない(`NaN` / `±Infinity`。「無期限」とはみなさない)資格情報は API を呼ばずに `auth_expired` を返す。`expiresAt <= 0` は「失効時刻不明」(失効しないトークン等)として扱い、失効判定を GitHub の 401 に委ねる。ただしこの `<= 0` の意味は connector-sdk で未定義の暫定扱いで、Token Vault(T-004)の実装時に ADR-016 追補で確定する。

### ローカル開発

実 IdP・Token Vault なしで Gateway 経由の動作を確認する場合は、Gateway の `MockCredentialProvider`(開発専用、`NODE_ENV=production` では構築拒否)が環境変数 `KP_MOCK_TOKEN_GITHUB`(ユーザー別に上書きする場合は `KP_MOCK_TOKEN_GITHUB__<USERID>`。`<USERID>` は userId を大文字化し英数字以外を `_` にしたもの)から本人トークンを注入する(sourceId が `github` の場合)。PAT を使ってよいのはこの開発経路のみ。トークンは自分の開発用アカウントのものを使い、**ファイル・コード・テストフィクスチャに書かない**(不変条件6)。

**権限境界の検証ではユーザー別変数を必須とする。** `KP_MOCK_TOKEN_GITHUB` だけを設定すると、全モックユーザーが同じトークン(= 同じ GitHub アカウントの権限)を共有する。この状態では「他人の権限で見えてしまう」逸脱を検出できないため、カナリア検証(threat-model §5)や権限別アイデンティティでのテストでは、各ユーザーに別アカウントのトークンを `KP_MOCK_TOKEN_GITHUB__<USERID>` で設定すること。

## 使い方

```ts
import { createGitHubConnector } from "@kp/connector-github";

const github = createGitHubConnector({
  sourceId: "github", // deployment.yaml の connectors[].id と一致させる
  timeoutMs: 10_000, // Gateway の limits.timeoutMs より短くする(下記)
  searchCode: true,
});
// Gateway にコネクタとして登録する(Gateway を経由しない呼び出し経路を作らない、不変条件2)
```

| オプション | 既定 | 説明 |
|---|---|---|
| `sourceId` | `"github"` | `Connector.sourceId` |
| `displayName` | `"GitHub"` | describe の表示名 |
| `baseUrl` | `https://api.github.com` | GitHub Enterprise Server では `https://HOST/api/v3`。https 必須(http は loopback のみ) |
| `timeoutMs` | 30000 | 1リクエストのタイムアウト(`AbortSignal.timeout`)。超過は `source_unavailable` |
| `userAgent` | `leisen-connector-github/0.1.0` | GitHub API は User-Agent 必須 |
| `fetchImpl` | グローバル `fetch` | テスト・プロキシ用の注入 |
| `searchCode` | `true` | コード検索(`/search/code`)を行うか |
| `defaultSearchLimit` | 20 | `options.limit` 未指定時の返却件数(1〜100) |
| `snippetChars` | 500 | snippet の最大長(上限 `MAX_SNIPPET_CHARS`) |
| `pageChars` | 20000 | fetch の1ページの文字数 |
| `maxComments` | 30 | fetch で issue / PR に含めるコメント数(最初の1ページのみ、0〜100) |
| `listPageSize` | 100 | list の1ページの件数(1〜100) |
| `maxTopContainers` | 30 | describe の `topContainers`(本人の所属 org)の上限数(0〜100) |
| `rateLimit.maxEntries` | 10000 | 残quota追跡のエントリ(ユーザー×リソース種別)上限 |
| `rateLimit.secondaryBackoffBaseMs` / `secondaryBackoffMaxMs` | 60000 / 900000 | 待機指示のない二次制限の指数バックオフ(初回 / 上限) |

不正な設定値は構築時に `RangeError` で拒否する(黙って既定値に倒さない)。deployment.yaml にはまだコネクタ固有設定の欄がないため、これらはデプロイ組み立て(T-012)でコードから注入する。タイムアウトは deployment.yaml の `connectors[].limits.timeoutMs`(Gateway が1ツール呼び出し全体に適用)より短くすること。fetch(issue)は本文とコメントの2リクエストを直列に行うため、`timeoutMs` の2倍程度が Gateway の値に収まるのが目安。

## 挙動

### search

- 本人トークンで **issue(`is:issue`)・PR(`is:pull-request`)・コード の3本を並行に検索**し、round-robin で統合する。GitHub App の user access token では issue と PR を1クエリで混在検索できない(修飾子なしは 422)ため、issue と PR は別クエリにしている(Search API ドキュメント)
- `options.limit`(既定 20、上限 100)を各検索の `per_page` に配分する(例: 20 → issue 7 / PR 7 / code 6)。返却件数は limit を超えない
- `nextCursor` は各検索のページ番号を符号化した不透明文字列。継続時は初回の配分を引き継ぐ(`limit` は無視)。GitHub 検索の上限(1クエリ 1000 件)より先は要求しない。カーソルは LLM から改変されて戻りうるため構造・値域を検証し、各検索の `per_page` 合計が limit の上限(100)を超えるもの(正規の配分では生じない偽造)は `invalid_request`
- **総件数を返さない**。GitHub の `total_count` は読み捨てる(ADR-012 / ADR-016)。続きの有無は `Link` ヘッダで判定する
- snippet: issue / PR は本文先頭(HTML コメント除去・空白正規化)、コードは `text_matches` の断片(なければ空文字)。いずれも `MAX_SNIPPET_CHARS` 以内に切り詰める(サロゲートペアを分断しない)
- code hit は `anchor: { kind: "section", value: <path> }`。`meta` に `type`(issue / pull_request / code)・`repository`・`number`・`state`・`author`・`path`・`ref`
- 一部の検索だけが失敗した場合(例: コード検索がレート制限中・5xx)は残りの結果を返し(degraded)、失敗した検索は `nextCursor` に同じページを残して再試行できるようにする。`auth_expired` はほかが成功しても失敗として返す。全検索が失敗した場合はそのエラーを返す

| filters | 修飾子 | 備考 |
|---|---|---|
| `container` | `repo:owner/repo` または `org:ORG` | 構文検証(空白・コロン等の修飾子混入は `invalid_request`)。コード検索にも適用。**検索範囲を絞るヒントであり安全境界ではない**: `repo:` / `org:` 修飾子は検索語(`query`)にも書けるため、container の指定は範囲外の結果を防ぐ仕組みにならない。範囲外(権限外)の結果を防ぐのは GitHub 側の本人権限による認可(describe の要約でも開示) |
| `author` | `author:LOGIN` | 先頭の `@` は除去。bot は `name[bot]` |
| `updatedAfter` / `updatedBefore` | `updated:>=` / `updated:<=` | ISO 8601 を UTC に正規化して埋め込む |

コード検索は検索語が必須で `author:` / `updated:` に対応しないため、検索語が空、または `author` / `updatedAfter` / `updatedBefore` を指定した場合はコード検索を行わない(フィルタ外の結果を混ぜない)。

### fetch

- issue / PR: `GET /repos/{owner}/{repo}/issues/{n}` の本文+先頭コメント(`/comments` の最初のページ、`maxComments` 件まで。コメント0件なら呼ばない)。状態・作成者・日時・ラベルを見出しに含める。PR のレビューコメント(差分行へのコメント)は含めない
- file: `GET /repos/{owner}/{repo}/contents/{path}?ref=` の base64 本文を UTF-8 で復号する。バイナリ(先頭 8000 バイトに NUL)・不正な UTF-8・`encoding` が base64 でないもの(1MB 超)・ディレクトリ・submodule は `invalid_request`
- 本文は `pageChars` ごとにページングし `nextPageCursor` を返す。**本文をキャッシュしない**ため、各ページの取得でソースから取り直す(ページ間で文書が更新されると境界がずれうる)

### list / describe

- `list()`(containerId なし): 本人の所属 org(`kind: "other"`)を列挙し終えたページで、本人がアクセスできる repo(`/user/repos`、`kind: "repository"`)を続けて返す。`nextCursor` でページング
- `list("ORG")`: その org の repo のうち本人に見えるもの。カーソルは org に束縛する(別の containerId での再利用は `invalid_request`)
- `list("owner/repo")`: repo の配下は列挙しない(`invalid_request`。検索は `filters.container` で絞る)
- `describe()`: 表示名、要約(degraded であること・コード検索の制約を開示)、本人の所属 org(`topContainers`)、`supportedFilters: ["updatedAfter", "updatedBefore", "container", "author"]`。describe / list も本人トークンで呼ぶため、権限外の区画名は返らない(TM-B3)

### documentId 形式

コネクタスコープの不透明な文字列(ADR-007)。検索結果の値をそのまま `fetch` に渡す。

| 種別 | 形式 | 例 |
|---|---|---|
| issue | `issue:<owner>/<repo>#<number>` | `issue:acme/app#123` |
| pull request | `pr:<owner>/<repo>#<number>` | `pr:acme/app#45` |
| ファイル | `file:<owner>/<repo>@<ref>:<path>` | `file:acme/app@0123abc…:src/index.ts` |

ファイルの `ref` はコード検索が返すコミット SHA(空ならデフォルトブランチ)。documentId は LLM からも渡されうるため、復号時に owner / repo / ref / path を構文検証し、ドットセグメント(`..`)や修飾子の混入を `invalid_request` で拒否する(受領値はメッセージにエコーしない)。

## レート制限の扱い

GitHub の指針(Rate limits for the REST API)に従い、制限応答を分類して**残quotaを尊重する**(T-019 受け入れ条件)。

- 403 / 429 で `retry-after` がある → `rate_limited`、`retryAfterMs` = その秒数
- 403 / 429 で `x-ratelimit-remaining: 0` → `rate_limited`、`retryAfterMs` = `x-ratelimit-reset` − 現在時刻
- 上記の指示がない 429、または本文が二次制限(secondary rate limit)を示す 403 → `rate_limited`、最低1分から連続するたびに倍(上限 15 分)
- 直近の応答の `x-ratelimit-remaining` / `x-ratelimit-reset` と上記の待機を**ユーザー(userId)×リソース種別(core / search / code_search)ごと**に保持し、制限中は **API を呼ばずに** `rate_limited`(`retryAfterMs` 付き)を返す。reset 経過後は再開する。あるユーザーの枯渇で他のユーザーは止まらない(GitHub の primary rate limit は認証ユーザー単位。不変条件4)
- 追跡状態は上限件数付き(LRU、既定 10000)。制限に影響しない状態(remaining > 0)は保持しない。状態はプロセス内のみ(複数プロセス間では共有しない)
- **コネクタ内ではリトライしない**。再試行の判断と回数の記録(監査レコードの `retryCount`)は Gateway / Orchestrator 側で、`retryAfterMs` に従って行う。ソース全体の流量上限は deployment.yaml の `limits.maxRequestsPerMinute`(Gateway)で設定する。search は1回で `search` 枠2リクエスト+ `code_search` 枠1リクエストを使う

GitHub の枠(2026-09 時点): 認証済み primary 5,000 req/hour(ユーザー単位。本人の PAT や他アプリの利用と合算)、検索 30 req/min、**コード検索 10 req/min**(auth-matrix §4 の調査時点では 9 req/min と記載)。

## エラー分類

| 状況 | ConnectorErrorClass |
|---|---|
| `delegated_identity` の資格情報、userId 空 | `invalid_request`(API を呼ばない) |
| `ghs_` / `ghr_` 接頭辞のトークン(installation token / refresh token) | `invalid_request`(API を呼ばない) |
| トークン空・不正文字・`expiresAt` 経過・`expiresAt` が有限数でない | `auth_expired`(API を呼ばない) |
| 401 | `auth_expired` |
| 403 / 429 のレート制限 | `rate_limited` |
| 上記以外の 403(SAML SSO 未認可を含む)、451 | `permission_denied` |
| 404 / 409 / 410 | `not_found`(権限外の private repo も GitHub は 404 を返し存在を明かさない) |
| 400 / 422(検索構文エラー、権限外の `repo:` / `org:` 指定を含む)、403 のファイルサイズ超過 | `invalid_request` |
| 5xx、通信失敗、タイムアウト、応答の形の異常 | `source_unavailable` |
| `baseUrl` の外へのリダイレクト、パスにエンコードされた区切り文字(`%2F` / `%5C`)を含むリダイレクト、4回以上のリダイレクト | `source_unavailable`(追従しない) |
| 注入 `fetch` が追従してしまったリダイレクトの応答(`response.redirected`) | `source_unavailable`(応答を使わない) |

エラーメッセージには固定のエンドポイントラベルと HTTP ステータスのみを含め、**トークン・レスポンス本文・URL(検索クエリ)を含めない**(不変条件6、TM-A2)。

Gateway は LLM・利用者向けの応答で `permission_denied` と `not_found` を同一の分類 `not_available`(固定文言)に正規化する(threat-model TM-B2 / TM-H1。GitHub は権限外の private repo を 404、SSO 未認可 org のリソースを 403 で返すため、区別を返すと存在が推定できる)。区別は監査レコードの `errorClass` にのみ残る。

### リダイレクトの扱い

リダイレクトは `fetch` の自動追従に任せず(`redirect: "manual"`)、`baseUrl` と同じオリジン・ベースパス内のもの(リネームされた repo・移管された issue の 301 等)に限り本人トークン付きで最大3回まで追う。パスにエンコードされた区切り文字(`%2F` / `%5C`)を含むリダイレクトは、URL 上はベースパス内に見えてもサーバー側の復号で外へ抜けうるため追わない。

**注入する `fetch`(`fetchImpl`)は `redirect: "manual"` を尊重する(3xx を追従せずそのまま返す)ことが前提**であり、この前提のもとでトークンを `baseUrl` 以外へ送らない。前提に反して fetch 実装が追従した応答(`response.redirected === true`)は使わずに `source_unavailable` にするが、これは検知であって、追従時に転送先へ送られたトークンは取り消せない。プロキシ・計測等で fetch を差し替える場合は前提を満たす実装を使うこと(既定のグローバル `fetch` は満たす)。

## 既知の限界

- **コード検索は degraded**: デフォルトブランチのみ、384KB 未満のファイルのみ、語彙一致のみ(シンボル解決なし)、レート制限が厳しい。導入の利用状況によっては `searchCode: false` にする
- **Enterprise の internal リポジトリ**: 可視性はエンタープライズのメンバーシップに依存する(auth-matrix §4 では推測扱い)。実疎通で確認が必要
- SAML SSO を本人が認可していない org のリソースは、検索では黙って除外され、fetch では `permission_denied` になる。LLM・利用者には Gateway の正規化により「利用できない」(`not_available`)としか見えないため、SSO 認可の案内は接続・同意の導線(T-009)で行う想定。SSO 強制 org で「存在しない repo」と「存在するが権限外の repo」が 403(SSO)と 404 のどちらで返るかは実疎通で記録する(T-019 残作業)
- `filters.container` は安全境界ではない(上記 filters 表)。範囲外の結果を防ぐのは GitHub 側の認可のみ
- 一部の検索が失敗した場合の degraded な結果には、その旨を示すフィールドがない(SDK の `SearchResult` に該当フィールドがないため。IF 変更は ADR が必要)
- fetch は 1MB を超えるファイルを扱わない。PR のレビューコメント・差分は取得しない
- GitHub 検索は1クエリにつき 1000 件まで

## テスト

```bash
npm test -w @kp/connector-github
```

フェイク GitHub API(注入 fetch)で検証する。認可分岐(資格情報の前提違反・401/403/404/5xx・本人トークンの付与とユーザー間の非混線・リダイレクト)を `test/auth.test.ts`、残quotaの尊重を `test/ratelimit.test.ts` に置く。フィクスチャのトークンは `dev-only-token-<user>` 形式のダミーのみ(接頭辞による拒否のテストは `ghs_dev-only` / `ghr_dev-only` のような実トークン形式でない短い値を使う)。内部モジュールは相対 import で参照する(公開 API は factory と型のみ)。
