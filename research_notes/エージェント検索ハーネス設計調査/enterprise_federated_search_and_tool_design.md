# 異種SaaSネイティブ検索に対するエージェント検索(中央インデックスなしのフェデレーテッド検索)とツール設計の実践 — 2026-11-25 時点

凡例:
- 「実物スキーマ」= 2026-11-25 にこの調査セッションへ接続されていた公式 MCP サーバーの `tools/list` で実際に観測したツール定義の文字列。公開ドキュメントではなく実物なので、公開 URL は最も近い公式ページを付けた。文言はサーバー側で随時変わりうる。
- WebFetch は小型モデルによる要約経由のため、「逐語」とした引用も最終利用前に原典で再確認するのが安全(特に数値)。ソースコード由来の引用(Redmine)は原典 URL を直接確認できる。

## 1. 各バックエンドの検索セマンティクス(esa / GitHub / Redmine / Google Drive / Slack)

### Takeaway
5 つのバックエンドは「スペース区切りの解釈(AND か、トークン単位か、部分文字列か)」「自然文の扱い」「上限(語数・文字数・件数)」「並び順」がすべて違い、自然文をそのまま通して意味検索が効くのは Slack(RTS のセマンティック検索、プラン・設定依存)だけである。他の 4 つは「著者が書きそうな名詞 2〜3 語」を AND で渡す前提の作りで、長い自然文や 6 語以上のクエリは 0 件(esa/GitHub/Drive)か黙って切り捨て(Redmine は 5 トークンまで)になる。

### Cited Findings

#### esa
- 検索オプションの公式ヘルプ(docs.esa.io/posts/104、revision 27、2025-08-12 更新。esa MCP の `esa_get_search_options_help` がこの記事をそのまま返す)。主要記法の逐語: 「`keyword` | 記事名 or カテゴリ or 本文にkeywordを含むもの(表記の揺れを考慮した検索)」「`"keyword"` | 記事名 or カテゴリ or 本文にkeywordを含むもの(語句の完全一致による検索)」「`name:keyword` または `title:keyword` | 記事名にkeywordを含むもの」「`full_name:keyword` | "[カテゴリ名]/[記事名]" にkeywordを含むもの」「`category:keyword` | カテゴリ名にkeywordを含むもの(部分一致)」「`in:keyword` | カテゴリ名がkeywordから始まるもの(前方一致)」「`on:keyword` | カテゴリ名がkeywordであるもの(完全一致)」「`body:keyword` | 記事本文にkeywordを含むもの」「`#tag1` または `tag:tag1`」「`@screen_name` または `user:screen_name`」「`updated_by:screen_name`」「`comment:keyword` | コメント本文に keyword が含まれる記事」「`wip:true または wip:false`」「`kind:stock または kind:flow`」「`created:>2015-07-05`」「`updated:>2015-07`」「`keyword1 keyword2` | AND検索(スペース区切り)」「`keyword1 OR keyword2` | OR検索」「`keyword1 | keyword2` | OR検索」「`-keyword` | 否定検索」 — [docs.esa.io/posts/104](https://docs.esa.io/posts/104)
- 結合の優先順位: 「通常検索内容は左から順番に処理されますが、`()` を使って優先順位を調整することができます」。例「`in:日報 えさ OR 餌` => (`in:日報` AND `えさ`) OR (`餌`) として処理」「`in:日報 (えさ OR 餌)` => (`in:日報`) AND ( `えさ` OR `餌`) として処理」。つまり OR をフィルタと混ぜるときは括弧が必須 — [docs.esa.io/posts/104](https://docs.esa.io/posts/104)
- 数値・日付は `:>` `:<` `:>=` `:<=` が使える(`stars` `watches` `comments` `number` `done` `undone` `created` `updated`) — [docs.esa.io/posts/104](https://docs.esa.io/posts/104)
- ソート: `sort:` キーとして `best_match-desc` / `updated-desc|asc` / `created-desc|asc` / `stars-desc` / `watches-desc` / `comments-desc` / `full_name-asc` / `name-asc` / `number-desc|asc`。ベストマッチの優先度に影響する要素は「WIP or Ship It 状態(Ship It済み > WIP)」「記事タイトルへのキーワード含有」「ストック/フロー分類」「Star・Watch・コメント数」「アーカイブ状態」 — [docs.esa.io/posts/104](https://docs.esa.io/posts/104)
- ベストマッチの補足(ProTip): 「本文よりもタイトル内にキーワードが入っている記事の方が、ベストマッチでソート時に検索スコアが高くなります。」、スコアは「ストック記事 > フロー記事」、アーカイブ記事は低くなる。数値の重みは非公開(定性的記述のみ) — [docs.esa.io/posts/389](https://docs.esa.io/posts/389)
- 公式 MCP の `esa_search_posts` の `sort` 引数は enum `updated / created / number / stars / watches / comments / best_match`、`order` は `desc / asc`、`perPage` 最大 100(実物スキーマ)。記述上 `sort` の既定値は示されていない — [esaio/esa-mcp-server](https://github.com/esaio/esa-mcp-server)
- 日付記法の落とし穴を MCP 側が明示的に警告している(実物スキーマ、`query` の説明): "**WARNING: Do NOT use 'after:', 'before:', 'since:', or 'until:' syntax (these are from GitHub/Gmail/pplog). Use esa-specific date syntax: created:>YYYY-MM-DD, created:<YYYY-MM-DD, updated:>YYYY-MM-DD, updated:<YYYY-MM-DD" — LLM が他 SaaS の記法を持ち込む失敗が実際に起きることの一次的な証拠 — [esaio/esa-mcp-server](https://github.com/esaio/esa-mcp-server)

#### GitHub
- REST 検索の制約: クエリは「Are longer than 256 characters (not including operators or qualifiers)」は不可、「Have more than five `AND`, `OR`, or `NOT` operators」も不可で、違反は "Validation failed"。1 検索あたり最大 1,000 件。「The REST API will find up to 4,000 repositories that match your filters.」 — [GitHub REST: Search](https://docs.github.com/en/rest/search/search)
- レート制限: 認証済みで検索全般 30 req/分、コード検索は認証必須で 10 req/分 — [GitHub REST: Search](https://docs.github.com/en/rest/search/search)
- コード検索(REST)の制約: 既定ブランチのみ、384 KB 未満のファイルのみ、検索語が最低 1 つ必要(`language:go` だけは不可) — [GitHub REST: Search](https://docs.github.com/en/rest/search/search)
- 並び順は既定で best match 降順。時間切れのときは見つかった分を返して `incomplete_results: true`(「Reaching a timeout does not necessarily mean that search results are incomplete.」)。`Accept: application/vnd.github.text-match+json` で `text_matches`(`fragment` と `matches` のオフセット)が得られる — [GitHub REST: Search](https://docs.github.com/en/rest/search/search)
- REST のコード検索は Web UI の新しいコード検索とは別の(レガシー)構文で、公式ヘルプは旧構文について REST のコード検索エンドポイント向けとしている。Web の新コード検索の構文(正規表現、`symbol:` など)は別ページ。非コード(issue 等)の検索構文もコード検索とは別 — [Searching code (legacy)](https://docs.github.com/en/search-github/searching-on-github/searching-code); [Understanding GitHub Code Search syntax](https://docs.github.com/en/search-github/github-code-search/understanding-github-code-search-syntax)
- 公式 MCP サーバーは `search_code` の説明でレガシー REST 前提を明示: 「Search query (GitHub code search REST). Implicit AND between terms; supports `OR`, `NOT`, and `"quoted phrase"` for exact match. Qualifiers: `repo:owner/repo`, `org:`, `user:`, `language:`, `path:dir` (prefix match), `filename:exact.ext`, `extension:`, `in:file`, `in:path`, `size:`, `is:archived`, `is:fork`. Max 256 chars.」。`sort` は「Sort field ('indexed' only)」 — [github/github-mcp-server README](https://github.com/github/github-mcp-server/blob/main/README.md)

#### Redmine
- REST のパラメータ(`/search.:format`): `q`「query strings. enable to specify multiple values separated by a space」、`scope`(`all` / `my_project` / `subprojects`)、`all_words`「matched all query strings or not」、`titles_only`「matched only title or not」、`open_issues`、`attachments`(`0` 説明のみ / `1` 説明と添付 / `only` 添付のみ)、種別フィルタ `issues` `news` `documents` `changesets` `wiki_pages` `messages` `projects`、`offset` `limit`。結果は `id` `title` `type` `url` `description` `datetime` — [Redmine wiki: Rest_Search](https://www.redmine.org/projects/redmine/wiki/Rest_Search)
- トークン化(ソース): `@question.scan(/"[^"]+"|[^\p{Zs}]+/)` — 二重引用符の句はそのまま 1 トークン、他は Unicode の空白区切り(`\p{Zs}` なので全角スペースも区切り)。長さフィルタ `tokens.uniq.select{|w| w.length > 1 || w =~ /\p{Han}/}`(1 文字は漢字のみ可)。`MAX_TOKENS = 5` で先頭 5 個だけを使い、超過分は切り捨て(`truncated?`) — [redmine/lib/redmine/search.rb](https://github.com/redmine/redmine/blob/master/lib/redmine/search.rb)
- 照合(ソース): 各トークンを `"%#{ActiveRecord::Base.sanitize_sql_like w}%"` にして `Redmine::Database.like(column, value)` で検索、すなわち SQL LIKE の部分文字列一致。トークン間は `all_words ? ' AND ' : ' OR '`。`titles_only` は `columns = columns[0..0]`(先頭の検索対象カラムのみ)。検索可能なカスタムフィールド、ジャーナル(非公開注記は `view_private_notes` 権限が必要)、添付(ファイル名と説明)も対象 — [acts_as_searchable.rb](https://github.com/redmine/redmine/blob/master/lib/plugins/acts_as_searchable/lib/acts_as_searchable.rb)
- 並び順は関連度ではなく日付: `reorder(searchable_options[:date_column] => :desc, :id => :desc)`、全体では `ret.sort! {|a, b| b.last <=> a.last}`。スコアリングは存在しない — [acts_as_searchable.rb](https://github.com/redmine/redmine/blob/master/lib/plugins/acts_as_searchable/lib/acts_as_searchable.rb); [search.rb](https://github.com/redmine/redmine/blob/master/lib/redmine/search.rb)
- 可視性は検索スコープに組み込み(モデルの `visible` スコープ、なければ `Project.allowed_to_condition(user, permission)`)。検索キャッシュのキーに user ID が入る — [acts_as_searchable.rb](https://github.com/redmine/redmine/blob/master/lib/plugins/acts_as_searchable/lib/acts_as_searchable.rb); [search.rb](https://github.com/redmine/redmine/blob/master/lib/redmine/search.rb)
- 5 トークン上限の黙殺は本家でも問題視され、上限は維持して結果の上に警告を出すパッチが提案されている(Feature #44464。チケットの状態は検索結果上で表示が食い違い、未確認) — [Redmine #44464](https://www.redmine.org/issues/44464)

#### Google Drive (`files.list` の `q`)
- `fullText contains` はトークン単位: 「The `contains` operator only performs matching on entire string tokens for the `fullText` term.」。"HelloWorld" は `fullText contains 'HelloWorld'` でのみ返る — [Drive API: Search query terms and operators](https://developers.google.com/workspace/drive/api/guides/ref-search-terms)
- `name contains` は前方一致のみ: ファイル名 `HelloWorld` に対し `name contains 'Hello'` は一致、`name contains 'World'` は不一致 — [同上](https://developers.google.com/workspace/drive/api/guides/ref-search-terms)
- フレーズは単一引用符の中に二重引用符: `fullText contains '"Hello there"'`。アンダースコアはフレーズ照合で空白扱い。`fullText` の対象は名前・説明・indexableText・本文/メタデータ内のテキスト。値は単一引用符、アポストロフィは `\'` — [同上](https://developers.google.com/workspace/drive/api/guides/ref-search-terms)
- Google 製 Drive MCP コネクタ(実物スキーマ `search_files`)は、`orderBy` を省略すると関連度降順(「If omitted or empty, results are ordered by relevance descending.」)、指定できるのは `modifiedTime` / `viewedByMeTime` のみ。スニペット量は `snippetVerbosity`(BRIEF 約 1000 字 / MEDIUM 約 2500 字 / DETAILED 約 5000 字 / MAX_ALLOWED)で調整 — [Drive API: Search for files](https://developers.google.com/workspace/drive/api/guides/search-files)(実物スキーマの公開 URL は未特定)

#### Slack
- Real-time Search (RTS) API は Data Access API の後継。メソッドは `assistant.search.context`(メッセージ・ファイル・チャンネル・ユーザーの検索)と `assistant.search.info`(チームの検索機能の照会)。`sort` は `score`(既定)か `timestamp` — [Slack: Real-time Search API](https://docs.slack.dev/apis/web-api/real-time-search-api/)
- キーワード検索が既定: 結果はクエリのキーワードを含む必要があり、ステミングはあるが同義語は効かない。`OR` は両モードで使える(例 `"budget OR finance OR expenses"`)。クエリから書式を取り除くことを推奨 — [同上](https://docs.slack.dev/apis/web-api/real-time-search-api/)
- セマンティック検索は Pro / Business+ / Enterprise+ でワークスペースの AI 検索が有効なときに利用でき、クエリが自然文の質問(疑問詞で始まる、または「?」で終わる)のときに発動、既定の `score` ソートのときだけ適用、遅延が増えうる。セマンティック検索は自然文からフィルタ(ユーザー、チャンネル、日付、ファイル種別)を抽出できるが、フィルタは明示指定が推奨 — [同上](https://docs.slack.dev/apis/web-api/real-time-search-api/)
- 保存禁止: 「You must not store or copy any of the data retrieved from this API.」。学習利用も不可。利用できるのは「directory-published apps and internal apps only」。レガシーの `search:read` スコープは使わない。スコープは `search:read.public`(最小)に `search:read.private` / `.mpim` / `.im` / `.files` / `.users` を追加 — [同上](https://docs.slack.dev/apis/web-api/real-time-search-api/)
- 公式 Slack MCP サーバー: エンドポイント `https://mcp.slack.com/mcp`、Streamable HTTP のみ(SSE と Dynamic Client Registration は非対応)、利用できるのは directory 公開アプリか内部アプリのみ(「unlisted apps are prohibited from using MCP」)、アプリ ID 固定の登録済み Slack アプリが必要。検索ユーザー/チャンネル/絵文字は Tier 2(20+/分)、メッセージ・ファイル検索は「Special rate limits apply」 — [Slack MCP server](https://docs.slack.dev/ai/slack-mcp-server/)
- モディファイア(公式 MCP の実物スキーマに列挙): `in:<#C123456> | in:@username | from:<@U123456> | from:username | with:<@U123456> | creator:@user` / `has:pin | has:link | has:file | has:reaction | has::emoji: | hasmy::emoji: | is:thread | is:saved | is:dm` / `before:YYYY-MM-DD | after:YYYY-MM-DD | on:YYYY-MM-DD | during:month`、「Same modifier repeated = OR (except with/has = AND).」 — [Slack MCP server](https://docs.slack.dev/ai/slack-mcp-server/)

### Inferences
- 「自然文を 1 本投げる」現行のやり方が悪い結果になるのは仕様どおり。esa・GitHub・Drive は AND 既定で、文を語に割った全語が含まれる文書しか返らない。Redmine は LIKE 部分一致なので助詞付きの文節(例「設定方法について」)がそのまま 1 トークンになり、ほぼ当たらない。
- Redmine は関連度がなく新しい順なので、上位 N 件を取るだけでは「最近更新された無関係な Issue」が並ぶ。`titles_only=1` で絞る、種別フィルタ(`wiki_pages=1` 等)で分ける、`all_words=1` を既定にする、という「クエリではなくパラメータ」での制御が効く対象。
- Drive の `name contains` は前方一致なので、タイトル中の語を探すなら `fullText contains`(名前も対象)と併用するのが安全。日本語は分かち書きがないため「トークン単位」がどう切られるかは文書に記載がなく(下の Gaps)、短い語(2〜4 文字の名詞)に寄せるのが無難という推測に留まる。
- Slack だけは「キーワード配列 + フィルタ + 自然文」を別々に渡す設計が成立する(セマンティック検索がある)。他ソースに同じ自然文フィールドを足しても効果はない。
- GitHub の「演算子 5 個まで」「256 文字」は、LLM が OR で同義語を並べる戦略と直接衝突する。同義語展開は 1 クエリに詰めずに複数クエリへ分ける必要がある。

### Gaps
- esa の「表記の揺れを考慮した検索」の実体(形態素解析か N-gram か、部分一致の範囲)は公式ドキュメントに記述がなく未確認。docs.esa.io/posts/389 にも記載なし。
- esa MCP の `keyword:API` という記法(実物スキーマに登場)は docs.esa.io/posts/104 の表にはない。挙動未確認。
- Drive の `fullText` の日本語トークン化、クエリ長の上限、`fullText` と `orderBy` の併用制約は公式ページから確認できなかった。
- Slack 公式ヘルプ(検索モディファイア、引用符、`-`、`*`、日本語の扱い)は 429 で取得できず。日本語のトークン化仕様は一次情報なし。
- GitHub のレガシーコード検索が API からいつまで提供されるか、新コード検索が API で使えるようになったかの公式な時系列は見つからなかった。issue 検索の日本語トークン化も一次情報なし。
- Redmine `/search.json` の `limit` の上限値は未確認。

## 2. 公式 MCP サーバーは検索ツールの説明でクエリ構文をどう教えているか

### Takeaway
観測できたパターンは 5 つ: (a) 説明文に構文チートシートと例を埋め込む(GitHub `search_code`、Google Drive、Slack)、(b) 構文ヘルプを別ツールにして「迷ったら先に呼べ」と書く(esa)、(c) クエリを構造化して LLM に分解させる(Slack の `keywords[]` / `filters` / `natural_language_query`)、(d) 意味検索ツールと構文検索ツールを別々に出す(Atlassian の Rovo `search` と JQL/CQL、Notion の AI 検索とワークスペース検索)、(e) 「他 SaaS の記法を使うな」「著者が書く語だけ入れろ」のような失敗予防の一文を入れる。

### Cited Findings
- **Slack(構造化分解 + 例 + 戦略、実物スキーマ `slack_search_public`)**: 「Split your search query into 3 fields: 1. `keywords` — Lexical terms that must appear in content. Each element should be a single word or "quoted phrase". All AND'd. Use nouns identifying subject matter. People/channels/dates go in filters. 2. `filters` — Slack search modifiers to constrain results … 3. `natural_language_query` — User's question in conversational tone. Preserve original phrasing; on follow-ups incorporate prior context. Don't include filter-like content.」 — [Slack MCP server](https://docs.slack.dev/ai/slack-mcp-server/)
- 同ツールの `keywords` 引数の説明: 「Each element MUST be a single word (no spaces) OR an exact phrase in quotes. All elements are AND'd (every element must match). Use the author test: only include words the author would naturally write.」 `natural_language_query`: 「Used for semantic reranking.」 — [同上](https://docs.slack.dev/ai/slack-mcp-server/)
- 同ツールは利用者ごとの機能を説明文に動的に出す(「✅ Semantic search is available for this user.」)、few-shot 例を `<examples>` で 3 つ載せる(例: 「User: What's the latest on Project Unicorn? > keywords: ["Project", "Unicorn"], natural_language_query: What's the latest on Project Unicorn?」)、失敗時の方針も書く: 「Strategy: Decompose complex requests into parallel searches. Use keywords for subject terms, filters for people/channels/dates. If 0 results, broaden by removing filters or simplifying keywords.」 — [同上](https://docs.slack.dev/ai/slack-mcp-server/)
- 同ツールの結果制御: `limit`「up to a max of 20. Defaults to 20」、`response_format` enum `detailed`(既定)/ `concise`、`include_context`(前後のメッセージ、既定 true、concise では無視)、`max_context_length`、`sort` `score|timestamp`、`cursor` — [同上](https://docs.slack.dev/ai/slack-mcp-server/)
- **esa(別ツールのヘルプ + クエリ書き換え戦略)**: `esa_get_search_options_help` の説明「Get esa search syntax documentation when you need to construct complex search queries. Use this BEFORE esa_search_posts if you're unsure how to translate user's search requirements into proper esa query syntax (e.g., date ranges, tag filters, category searches, advanced operators).」(実物スキーマ) — [esaio/esa-mcp-server](https://github.com/esaio/esa-mcp-server)
- `esa_search_posts` 自体の説明は「Search for posts in esa.io」だけで、指示は `query` 引数の説明に集中している。逐語: 「When searching, apply these strategies: 1. Convert concepts to technical terms (e.g., general descriptions → specific property names, method names, or technical keywords) 2. Translate between Japanese and English technical terms (e.g., Japanese concepts → English API/property names) 3. Expand to related technical elements … IMPORTANT: Space-separated terms are treated as AND conditions. Use "OR" operator for alternative terms: "word-break OR word-wrap OR overflow-wrap". … For broader results, use OR between related terms rather than listing them with spaces.」「Use specific terms, not wildcards like "*". Empty string returns all posts.」 — [esaio/esa-mcp-server](https://github.com/esaio/esa-mcp-server)
- esa MCP は検索以外の探索手段もツールで出している: `esa_get_categories`「指定パス配下のカテゴリー一覧」、`esa_get_top_categories`、`esa_get_all_category_paths`「チーム内の全カテゴリーパス一覧(記事数付き、フィルタリング対応)」、`esa_get_team_tags`「チーム内で使われているタグと使用回数」、`esa_get_post_backlinks`「指定記事を参照している記事の一覧」、リソース `esa://teams/{teamName}/posts/recent`。README は STDIO 版を「esa.io の公式 MCP(Model Context Protocol)サーバー(STDIO Transport版)」と記載、ツール 27 個 — [esaio/esa-mcp-server](https://github.com/esaio/esa-mcp-server)
- **GitHub(ツールごとに教え方が違う)**: `search_code` は構文チートシート + 例(「Examples: `WithContext language:go org:github`; `"package main" repo:o/r`; `func extension:go path:cmd repo:o/r`; `NOT TODO language:go repo:o/r`.」)。一方 `search_issues` の `query` は「The search query, as natural language. When the user gives alternative wordings, include them as plain words rather than joining them with OR.」と、自然語を受ける前提で OR を使わせない指示。`search_pull_requests` は「Search query using GitHub pull request search syntax」のみ — [github/github-mcp-server README](https://github.com/github/github-mcp-server/blob/main/README.md)
- GitHub MCP はサーバー `instructions` で使い分けを教える(この調査セッションに届いた実物): 「Use 'list_*' tools for broad, simple retrieval and pagination of all items of a type … Use 'search_*' tools for targeted queries with specific criteria, keywords, or complex filters」「Use pagination whenever possible with batches of 5-10 items.」「Use separate 'sort' and 'order' parameters if available for sorting results - do not include 'sort:' syntax in query strings. Query strings should contain only search criteria」 — [github/github-mcp-server](https://github.com/github/github-mcp-server)
- GitHub MCP は応答サイズの引数を持つ: `search_repositories` の `minimal_output`「Return minimal repository information (default: true).」、`search_issues` / `list_issues` の `fields`「Subset of fields to return … omitting 'body' and 'field_values' in particular drops the largest per-result data.」 — [github/github-mcp-server README](https://github.com/github/github-mcp-server/blob/main/README.md)
- **Google Drive(文法の全量 + 例 + やってはいけない指示、実物スキーマ `search_files`)**: 「Search for Drive files using a structured query (syntax: `query_term operator values`). Only terms in this list are supported.」「Use `title contains` instead of `title =` when searching by file or folder name, unless the user explicitly asks for an exact full-title match. Do NOT include document type terms (e.g., 'presentation', 'slides', 'deck', 'document', 'doc', 'spreadsheet', 'sheet', 'pdf', 'folder', 'project') inside `title` or `fullText` clauses. Separate title keywords from file type terms and map them to `mimeType` clauses in the query.」 例 13 個を列挙。API の `name` を `title` と呼び替え、`ancestors`(配下すべて)のような API にない語も足している(コネクタ側で API 構文へ翻訳している) — [Drive API: Search for files](https://developers.google.com/workspace/drive/api/guides/search-files)(実物スキーマの公開 URL は未特定)
- **Atlassian Rovo MCP(意味検索と構文検索を併置)**: `search`「Enriched. Semantic search across Jira, Confluence, and connected apps using natural language, through Rovo.」(Beta, Primary)、`searchJiraIssuesUsingJql`「Search Jira work items using JQL.」、`searchConfluence`「Search Confluence content with CQL.」、`searchCode`(Beta)、`discover`「Natural-language search over the deferred tool catalog.」。Enriched ツールは Rovo クレジットを消費 — [Atlassian Rovo MCP: Supported tools](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/)
- **Notion MCP**: `notion-search` の `query` は「Use short, specific keywords or a page title.」。AI 検索が使える利用者では AI 検索になり結果に `type: "ai_search"` が付く。完全一致フィルタ・空クエリ・関連度以外のソートのときはワークスペース検索のまま。使えないオプションは落として `notices` 配列で知らせる。最大 50 件。接続先ソースについては「It doesn't search connected sources such as Slack or Google Drive.」で、`notion-connector-search` を別ツールとして並列に呼ぶ — [Notion MCP: search reference](https://developers.notion.com/guides/mcp/tools-search-reference.md)
- **Glean MCP**: 組み込みツールは「Search, Chat, Read Document, Code Search, People, Artifacts, and Image generation」。プロンプトの助言は「State the data or tool you want explicitly.」程度で、クエリの書き方の指示は公開ページにない。「All queries enforce user permissions through the Knowledge Graph of Glean.」 — [Glean: About Glean MCP server](https://docs.glean.com/administration/platform/mcp/about)

### Inferences
- バックエンドがキーワード検索のベンダーほど説明文が長く具体的(esa・Slack・Drive・GitHub code)、意味検索を持つベンダーほど短い(Rovo・Glean)。説明文の量は「バックエンドの弱さを LLM 側で補う必要量」に比例している。
- 一様な `search(query)` IF を保ったまま教える手段は 3 つある: ツール説明(コネクタごとに別文面)、`describe` の返り値に構文プロファイルを入れる(esa の help ツール相当)、サーバー `instructions`。esa の「Use this BEFORE …」方式は、IF を変えずに済む反面、LLM が呼ばないと効かない。Slack 方式(引数の構造化)は IF 変更(= ADR)になる。
- Notion の `notices`(使えなかった指定を結果で知らせる)と Redmine #44464(切り捨てた語を警告)は同じ発想で、「黙って劣化しない」ことが LLM 呼び出し側の再試行を可能にする。
- GitHub の `search_issues` が「OR で繋ぐな、言い換えは平文で並べろ」と書くのは、演算子 5 個制限と AND 既定を踏まえた逆方向の指示であり、「OR を使え」という esa と正反対。ソースごとに戦略文を変える必要があることの実例。

### Gaps
- Linear / Box / Sentry の MCP 検索ツール説明は今回取得していない。
- esa のリモート MCP(`https://mcp.esa.io`、β)のツール文面が STDIO 版と同一かは未確認(本セッションの実物スキーマがどちらに由来するかも未特定)。
- Glean MCP の `search` ツールの説明文そのものは公開ページから取れなかった。
- Atlassian のページには Rovo `search` と JQL/CQL の使い分け指針の明文はなかった。

## 3. 検索ツールの設計指針(Anthropic / MCP 仕様 / OpenAI の search・fetch 規約)

### Takeaway
指針はほぼ一致している: 検索ツールは「絞り込んだ少量の高信号な結果 + 次の一手が分かる文面」を返し、応答量は `response_format` や件数・ページングで呼び出し側に選ばせ、失敗は不透明なコードではなく直し方を返す。OpenAI の `search`/`fetch` 規約は「`query` 1 本 → `{id,title,url}` の配列」「`id` → `{id,title,text,url,metadata}`」という最小形で、leisen の `search`/`fetch` と同形である。

### Cited Findings
- Anthropic「Writing effective tools for agents — with agents」(2025-09-11): 「you might choose to implement a `search_contacts` or `message_contact` tool instead of a `list_contacts` tool」「consider implementing a `search_logs` tool which only returns relevant log lines and some surrounding context.」「Too many tools or overlapping tools can also distract agents from pursuing efficient strategies.」 — [Anthropic Engineering](https://www.anthropic.com/engineering/writing-tools-for-agents)
- 名前空間: 「namespacing tools by service (e.g., `asana_search`, `jira_search`)」 — [同上](https://www.anthropic.com/engineering/writing-tools-for-agents)
- 返す内容: 「They should prioritize contextual relevance over flexibility, and eschew low-level technical identifiers」。`response_format` enum(`"detailed"` / `"concise"`)の例では詳細 206 トークンに対し簡潔 72 トークン(「we use ~⅓ of the tokens with "concise" tool responses」) — [同上](https://www.anthropic.com/engineering/writing-tools-for-agents)
- 量の制御: 「For Claude Code, we restrict tool responses to 25,000 tokens by default.」、切り詰め時は「making many small and targeted searches instead of a single, broad search」へ誘導する文面を返す — [同上](https://www.anthropic.com/engineering/writing-tools-for-agents)
- エラー: 「clearly communicate specific and actionable improvements, rather than opaque error codes or tracebacks.」 — [同上](https://www.anthropic.com/engineering/writing-tools-for-agents)
- 説明文: 「think of how you would describe your tool to a new hire on your team.」。評価から見つかった検索固有の失敗例: 「Claude was needlessly appending `2025` to the tool's `query` parameter, biasing search results」(説明文の修正で対処) — [同上](https://www.anthropic.com/engineering/writing-tools-for-agents)
- 評価: 「Strong evaluation tasks might require multiple tool calls—potentially dozens.」「We relied on held-out test sets to ensure we did not overfit to our "training" evaluations.」 — [同上](https://www.anthropic.com/engineering/writing-tools-for-agents)
- MCP 仕様(2025-06-18 版の tools): ツール定義は `name` / `title` / `description` / `inputSchema` / `outputSchema` / `annotations`。「clients **MUST** consider tool annotations to be untrusted unless they come from trusted servers.」 — [MCP spec: Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- 構造化出力: 「**Structured** content is returned as a JSON object in the `structuredContent` field of a result. For backwards compatibility, a tool that returns structured content SHOULD also return the serialized JSON in a TextContent block.」。`outputSchema` を出したら「Servers **MUST** provide structured results that conform to this schema.」 — [同上](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- エラーの 2 系統: プロトコルエラー(未知のツール、引数不正)と、`isError: true` の結果として返すツール実行エラー(API 失敗、入力データ不正、業務ロジック)。ツール結果は `resource_link`(`uri` / `name` / `description` / `mimeType`、`annotations.audience` / `priority`)も返せる — [同上](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- OpenAI の規約(deep research / company knowledge 向け MCP サーバー): `search` は引数 `query`(文字列 1 本)、戻りは `results` 配列で各要素 `id` / `title` / `url`。`fetch` は引数 `id`、戻りは `id` / `title` / `text`(全文)/ `url` / 任意の `metadata`。`structuredContent` と、同内容の JSON 文字列を `content` の text 1 件として両方返す。`url` が空でないときだけ引用可能。件数の規定はない。例のサーバー instructions は「まず search、次に fetch」。例のコメントに「Natural language queries work best for semantic search.」(ベクトルストア前提の例) — [OpenAI: MCP docs](https://developers.openai.com/api/docs/mcp)
- 件数・スニペット量の実例(規約ではなく実装値): Slack MCP は既定 20・最大 20 件、Notion は最大 50 件、GitHub MCP の instructions は 5〜10 件ずつ、Drive はスニペット約 1000 / 2500 / 5000 字の 3 段、Onyx のフェデレーテッド Slack は既定 25 件(1〜100) — [Slack MCP server](https://docs.slack.dev/ai/slack-mcp-server/); [Notion](https://developers.notion.com/guides/mcp/tools-search-reference.md); [github-mcp-server](https://github.com/github/github-mcp-server); [Onyx](https://docs.onyx.app/admins/connectors/official/slack/slack_federated.md)

### Inferences
- OpenAI 規約の `search(query)` は意味検索バックエンドを暗黙の前提にしている(例が「自然文が最適」)。キーワード検索バックエンドに同じ IF を被せると、その前提が崩れた分をどこかで補う必要がある(説明文、コネクタ側の書き換え、または結果に添えるヒント)。
- 「0 件」「切り捨て」「無視した語」は `isError` ではなく正常結果の中の文面(または構造化フィールド)で返すのが各指針と実例(Notion `notices`、Slack の 0 件時戦略)に沿う。ただし leisen では未認可候補の件数を外に出せない(不変条件 3)ので、ヒントは「認可後に見えている結果」と「クエリの形」だけから作る必要がある。
- `response_format: concise` を search の既定にして、本文は fetch で読ませる(fetch-then-read)構成が、Slack・GitHub(`fields` / `minimal_output`)・Drive(`snippetVerbosity`)の共通の方向。

### Gaps
- MCP 仕様 2026-07-28 版(ステートレス)でのツール関連の差分は今回確認していない(読んだのは 2025-06-18 版)。サーバー `instructions` の仕様上の記述も原典では未確認(GitHub MCP が実際に使っていることは観測)。
- OpenAI の「Company knowledge compatibility」節の本文は取得できず、規約が 2026-11 時点で必須か任意かは未確認。
- 件数・スニペット長についての規範的な指針(「何件が最適」)は見つからなかった。あるのは各実装の既定値のみ。

## 4. エンタープライズ製品のアーキテクチャ(中央インデックス vs ライブのフェデレーテッド検索)とクエリ処理

### Takeaway
2026 年時点で「本人資格情報でソースをライブに叩く」方式は主流の選択肢の一つになっている(Microsoft 365 Copilot のフェデレーテッドコネクタ、Claude の enterprise search、Slack の enterprise search / RTS、Onyx のフェデレーテッド Slack、ChatGPT のライブ接続)。ただし検索品質は中央インデックスに劣ると当事者自身が認めており(Onyx)、インデックス派(Glean)はそこを攻撃材料にしている。ライブ方式の補い方として文書化されているのは、LLM 側のツール選択とクエリ分解、ソース名・期間の明示、1 ソースずつの検索、インデックス結果とのマージである。

### Cited Findings
- **Microsoft 365 Copilot**(ページ更新 2026-11-16): フェデレーテッドコネクタは「Use Model Context Protocol (MCP) to fetch data in real time.」「Access data using the user's identity and permissions.」「Don't index external data into Microsoft 365.」。FAQ: 「Synced Copilot connectors index data into Microsoft Graph. Federated Copilot connectors fetch content live; no indexing takes place.」「Synced connectors are supported at an organization level; federated connectors are federated at the user level. User credentials, rather than admin credentials, are required to connect to any data source.」両方式は同一テナントで併存できる — [Microsoft Learn: Federated connectors overview](https://learn.microsoft.com/en-us/microsoft-365/copilot/connectors/federated-connectors-overview)
- 同ページ: ツール選択は実行時に Copilot が行う(「Copilot selects relevant connector tools at runtime and uses the live results returned by the source」)。利用者への助言は、ソース名と具体的な対象(プロジェクト名やレコード名)をプロンプトに含めること。対応先に Atlassian Rovo / Slack / GitHub / Notion / Linear / Box / Google Calendar などの MCP が並ぶ。読み取りツールは承認不要、書き込み系は承認が必要 — [同上](https://learn.microsoft.com/en-us/microsoft-365/copilot/connectors/federated-connectors-overview)
- **Claude(Anthropic)enterprise search**: 「Search results are generated by making MCP calls.」「No data from connected services are indexed in our systems for serving queries.」「You only see search results from data you have permission to access in the original systems.」。プロジェクトは「Specialized system prompts maintained by Anthropic for effective searches」を使う(プロンプト本文は非公開)。利用者向けの助言: ソース名を挙げる、期間を入れる、徹底的に調べるときは手順に分けて 1 ソースずつ検索する。コネクタが失敗したら残りのツールで検索し通知を出す — [Claude Help: Use enterprise search](https://support.claude.com/en/articles/12489464-use-enterprise-search)
- 一方で Anthropic は Enterprise 向けに Google Docs のカタログ化(管理者が有効化、検索品質と精度の向上が目的)も提供しており、ライブ検索のみではない — [Claude Help: Google Workspace connectors](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors)(検索結果の要約経由。本文は未取得)
- **Onyx**: フェデレーテッド Slack コネクタは「Onyx searches Slack live at query time with the Slack Search API.」、インデックスに保存せず、インデックス済みソースの結果とマージする。設定は「Maximum number of messages to retrieve per search (default 25, range 1 to 100).」「Maximum number of days to search back (default 30, range 1 to 365).」「Federated connectors do not have index attempts, pruning, or permission sync.」「Each user authorizes their own Slack account.」 — [Onyx docs: Slack Federated](https://docs.onyx.app/admins/connectors/official/slack/slack_federated.md)
- Onyx 自身の評価: Slack Indexed コネクタは「finds relevant results much better than the Slack Search API」で、Slack のプランと管理ポリシーが許すならインデックス方式を推奨、許さない場合にフェデレーテッド — [同上](https://docs.onyx.app/admins/connectors/official/slack/slack_federated.md)
- **Glean**(中央インデックス + ナレッジグラフ。ブログは 2024-11-19 更新でやや古い、かつ自社の立場からの主張): フェデレーテッド検索について「This method is often incomplete and fails to account for relationships across people, content, and activity.」。クエリ処理は「rewriting the query to bring in enterprise-specific knowledge about the data sources available」、計画 → サブエージェントが各ステップを実行(「They reason about the tools to use」)→ 自己評価(「The agent self-reflects on the initial search results and assesses its own confidence in its answer.」)。自社計測で関連度 24% 向上と主張 — [Glean blog: Agentic reasoning](https://www.glean.com/blog/agentic-reasoning-future-ai)
- Glean は検索計画を専用モデルに分ける構成を説明している(どのソースを照会し、どのツールを呼び、いつ証拠が十分かを決める工程を、最終回答の LLM と分離)。遅延約 50% 減・トークン約 25% 減は自社公表値 — [Glean: search planning vs deep reasoning](https://www.glean.com/perspectives/exploring-gleans-approach-search-planning-vs-deep-reasoning-in-ai)(検索結果の要約経由。本文は未取得)
- **Slack enterprise search**: 外部ソースを「real-time search for users across multiple external sources」で検索する。カスタムコネクタのアプリは org-ready への opt-in が必要で、公開配布や Marketplace 提出は不可。Slack はフェデレーテッド検索を、ソースを事前にインデックスせず問い合わせ時に取得する方式と説明し、結果はその時点の本人のアクセス権に従う。対象に Asana / Box / GitHub / Google Drive / Jira / Salesforce — [Slack: Enterprise Search (developers)](https://docs.slack.dev/enterprise-search/); [Slack: Enterprise search](https://slack.com/features/enterprise-search)
- **Atlassian Rovo**: MCP では Rovo の意味検索(`search`、Jira・Confluence・接続アプリを横断)と、製品ネイティブの構文検索(JQL / CQL)を別ツールで併置している — [Atlassian Rovo MCP: Supported tools](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/)
- **Notion**: AI 検索(Notion と接続ソース)とワークスペース検索を切り替え、接続ソース(Slack、Google Drive 等)は `notion-connector-search` を別ツールにしている(「For questions covering both, call both tools in parallel」に相当する記述) — [Notion MCP: search reference](https://developers.notion.com/guides/mcp/tools-search-reference.md)
- **ChatGPT**: 同期(管理者管理の事前インデックス、「apps with sync」、一部有料プランのみ)とライブ接続(本人の認可で都度ソースを照会)を別の体験として区別している。コネクタは「apps」に改称、Company Knowledge はプラグインとして提供、カスタムは MCP の `search` / `fetch` — [OpenAI Help: ChatGPT synced connectors / apps with sync](https://help.openai.com/en/articles/10847137-chatgpt-synced-connectors)(検索結果の要約経由。区別の文言は二次資料 [eesel](https://www.eesel.ai/blog/chatgpt-connector) に依拠し、公式本文は未取得)

### Inferences
- ライブ方式を採る製品は、弱いネイティブ検索の補償をほぼ「LLM 側」に置いている: (1) 専用のシステムプロンプト(Claude)、(2) 実行時のツール選択(Copilot)、(3) ツール説明での構文教育(各ベンダー MCP)、(4) 利用者へのプロンプト助言(ソース名・期間・1 ソースずつ)。コネクタ側の自動クエリ書き換えを明記した一次資料は Google Drive コネクタ(`title`→`name` 等の語彙の翻訳)以外に見つからなかった。
- 「1 ソースずつ検索してから統合」という Claude の助言と、Glean の「検索計画を別工程にする」は同じ構造を指す: ソースごとにクエリを作り直す工程が要る。全ソースに同一クエリを撒く fan-out は推奨されていない。
- Onyx の「既定 25 件・過去 30 日」は、ライブ検索の弱いランキングを件数と期間の上限で抑える運用上の工夫と読める。
- 両方式の併存(Copilot、ChatGPT、Claude、Onyx)が実態で、「ライブのみ」で品質を出し切った事例の公開計測は見当たらない。leisen の「認可委譲のためライブが基本」という制約下では、品質の根拠は自前の評価で作るしかない。

### Gaps
- Dust、Amazon Q Business、Elastic、Coveo、Box は今回調査していない。
- Microsoft の Copilot Search / クエリの KQL への書き換えの詳細は未調査。
- Glean の中央インデックスとライブ照会の混在の有無、Glean MCP 経由の検索での再ランキングの詳細は一次資料で確認できなかった。
- マージ結果の再ランキング(ソース横断の rerank)を具体的に記述した一次資料は、Onyx の「インデックス結果とマージ」の一文以外に得られなかった。Onyx のフェデレーテッド Slack でのクエリ展開の有無はドキュメントに記載なし(ソースコードの確認が必要、PR #5275 が入口)。
- Slack enterprise search のカスタムコネクタが受け取るクエリの形(元の文か、書き換え後か)と件数上限は、概要ページに記載がなく未確認(`developing-apps-with-search-features` ページが次の参照先)。

## 5. ソース別のクエリ適応パターン

### Takeaway
一次資料で確認できた適応パターンは、(1) ツール説明での構文と書き換え戦略の提示、(2) 構文ヘルプ/能力照会の別エンドポイント、(3) クエリの構造化分解、(4) 0 件時の緩和手順の明文化、(5) 検索以外の探索ツール(カテゴリ、タグ、被リンク、最近の更新、list)の併置、(6) 劣化を結果で知らせる、の 6 つ。コネクタ内での自動書き換えや横断 rerank は、製品として行っていることは示唆されるが手順を公開した資料は少ない。

### Cited Findings
- **能力記述子(search profile)の実例**: Slack は `assistant.search.info` でチームごとの検索機能を返し、公式 MCP は「✅ Semantic search is available for this user.」を説明文に反映する。Notion は使えない指定を落として `notices` で知らせる — [Slack RTS API](https://docs.slack.dev/apis/web-api/real-time-search-api/); [Notion](https://developers.notion.com/guides/mcp/tools-search-reference.md)
- **構文ヘルプの別ツール**: esa `esa_get_search_options_help`(「Use this BEFORE esa_search_posts if you're unsure …」)、`esa_search_help`(esa のドキュメント検索) — [esaio/esa-mcp-server](https://github.com/esaio/esa-mcp-server)
- **クエリ書き換え戦略の明文化(LLM 側で実行)**: esa「Convert concepts to technical terms」「Translate between Japanese and English technical terms」「Expand to related technical elements」「For broader results, use OR between related terms rather than listing them with spaces.」/ Slack「Use the author test: only include words the author would naturally write.」「Use nouns identifying subject matter.」/ GitHub issues「include them as plain words rather than joining them with OR」 — [esaio/esa-mcp-server](https://github.com/esaio/esa-mcp-server); [Slack MCP server](https://docs.slack.dev/ai/slack-mcp-server/); [github-mcp-server README](https://github.com/github/github-mcp-server/blob/main/README.md)
- **緩和手順(fallback)**: Slack「If 0 results, broaden by removing filters or simplifying keywords.」「Decompose complex requests into parallel searches.」。Anthropic は切り詰め時に「many small and targeted searches」へ誘導する文面を勧める — [Slack MCP server](https://docs.slack.dev/ai/slack-mcp-server/); [Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)
- **フィルタとキーワードの分離**: Slack(人・チャンネル・日付は `filters`、主題語は `keywords`)、Drive(ファイル種別の語は `title`/`fullText` に入れず `mimeType` へ)、GitHub(ソート指定をクエリに入れず `sort`/`order` 引数へ) — [Slack MCP server](https://docs.slack.dev/ai/slack-mcp-server/); [github/github-mcp-server](https://github.com/github/github-mcp-server); [Drive API: Search for files](https://developers.google.com/workspace/drive/api/guides/search-files)
- **検索以外のナビゲーション**: esa はカテゴリ一覧(記事数付き)、タグと使用回数、被リンク、最近の更新をツール/リソースで提供。esa 自身も人間向けに「カテゴリの README に、よく見られる記事へのリンクを追加する」を勧める。GitHub MCP は instructions で list 系と search 系の使い分けを指示 — [esaio/esa-mcp-server](https://github.com/esaio/esa-mcp-server); [docs.esa.io/posts/389](https://docs.esa.io/posts/389); [github/github-mcp-server](https://github.com/github/github-mcp-server)
- **バックエンド側のパラメータで緩める手段**: Redmine は `all_words`(AND/OR)と `titles_only`、種別フィルタで緩急を付けられる。esa は `title:` / `body:` / `in:` と `sort`、Slack は `sort`(`score`/`timestamp`)と `context_channel_id`(「boosting the search results for a channel」) — [Redmine Rest_Search](https://www.redmine.org/projects/redmine/wiki/Rest_Search); [docs.esa.io/posts/104](https://docs.esa.io/posts/104); [Slack MCP server](https://docs.slack.dev/ai/slack-mcp-server/)
- **コネクタ側での語彙翻訳の実例**: Google の Drive コネクタは API の `name` を `title` として出し、`ancestors` / `parentId` / `sharedFrom` / `followUp` など API の `q` にない語を受けて内部で翻訳している(実物スキーマの語彙と Drive API の語彙の差から) — [Drive API: Search query terms](https://developers.google.com/workspace/drive/api/guides/ref-search-terms)
- **ソース横断のマージ**: Onyx はライブの Slack 結果をインデックス済みソースの結果とマージする。Glean は検索計画と証拠収集を回答生成から分離する — [Onyx](https://docs.onyx.app/admins/connectors/official/slack/slack_federated.md); [Glean](https://www.glean.com/blog/agentic-reasoning-future-ai)

### Inferences
- leisen の `describe` は、ベンダー各社が説明文に書いている内容(AND/OR の既定、照合単位、語数・文字数の上限、使えるフィルタ、並び順、例 3〜5 個、0 件時の次の手)を載せる「検索プロファイル」の置き場として自然で、IF 変更を伴わない(esa の help ツールと同じ役割)。
- 5 ソースの仕様から導ける緩和の順序の案(一次資料に同じ梯子がそのまま載っているわけではない): フレーズ/タイトル限定 → 名詞 2〜3 語の AND → 語を 1 つ減らす → 同義語・日英の言い換えを別クエリで(esa は OR、GitHub issues は平文、GitHub code は別クエリ)→ カテゴリ/タグ/list/最近の更新で辿る。Redmine は「AND(`all_words=1`)→ `titles_only=1` で精度確認 → OR」の順がパラメータで表現できる。
- Redmine の 5 トークン上限と GitHub の演算子 5 個・256 文字は、コネクタ側で事前に検査して「何を捨てたか」を結果に書く価値がある(本家 #44464 と同じ問題)。クエリ文字列の形だけで判定できるので、未認可候補の件数を漏らさずに済む。
- コネクタ側の自動書き換え(汎用クエリ → バックエンド構文)は、助詞の除去や全角スペース正規化のような機械的な正規化なら安全だが、語の取捨は LLM 側に残す方が、ベンダー各社の実装(書き換え戦略を説明文で LLM に委ねる)と整合する。

### Gaps
- 「コネクタ側クエリ翻訳器」「ソース横断 rerank」「重複排除」を定量評価した公開資料は得られなかった。
- 日本語圏の実務者による esa / Redmine / Slack の MCP 検索の工夫記事(Zenn / Qiita)は、今回の検索では該当が見つからなかった(検索が US 限定で日本語記事に弱い可能性がある)。

## 6. 日本語に関する考慮点

### Takeaway
日本語の扱いを一次資料で確認できたのは Redmine(ソースコード)と esa(ヘルプの文言)だけで、Slack・Drive・GitHub は日本語のトークン化を文書化していない。Redmine は LIKE 部分一致なので分かち書きに依存しないが、空白で区切らない限り文全体が 1 トークンになる。日本語クエリは「空白区切りの短い名詞」に正規化するのが 5 ソース共通で安全側。

### Cited Findings
- Redmine: トークン区切りは `\p{Zs}`(全角スペース U+3000 を含む)。全角スペース対応は Feature #37878 として 2022-11 にコミット、対象は Redmine 5.1.0 — [Redmine #37878](https://www.redmine.org/issues/37878); [search.rb](https://github.com/redmine/redmine/blob/master/lib/redmine/search.rb)
- Redmine: 1 文字トークンは原則捨てられるが漢字(`\p{Han}`)は可(`w.length > 1 || w =~ /\p{Han}/`)。元はパッチ #30037「It accepts single multibyte-character keywords while keeping the current limitation for keywords with ASCII characters.」。現行コードの条件は `\p{Han}` なので、ひらがな・カタカナ 1 文字は捨てられる — [Redmine #30037](https://www.redmine.org/issues/30037); [search.rb](https://github.com/redmine/redmine/blob/master/lib/redmine/search.rb)
- Redmine: 照合は `%token%` の LIKE なので、日本語でも部分文字列一致(形態素解析なし、関連度なし) — [acts_as_searchable.rb](https://github.com/redmine/redmine/blob/master/lib/plugins/acts_as_searchable/lib/acts_as_searchable.rb)
- Redmine の標準検索を置き換える全文検索プラグイン(clear-code/redmine_full_text_search)は Groonga(Mroonga / PGroonga)を使い、クエリ展開による同義語検索に対応する。導入先がこれを入れていると検索の挙動が標準と変わる — [clear-code/redmine_full_text_search](https://github.com/clear-code/redmine_full_text_search)
- esa: 通常のキーワードは「表記の揺れを考慮した検索」、二重引用符は「語句の完全一致による検索」(2017-07-12 リリース)。カテゴリは `category:`(部分一致)/ `in:`(前方一致)/ `on:`(完全一致)で照合方式が明示されている — [docs.esa.io/posts/104](https://docs.esa.io/posts/104)
- esa MCP は日英の言い換えを LLM に指示している: 「Translate between Japanese and English technical terms (e.g., Japanese concepts → English API/property names)」 — [esaio/esa-mcp-server](https://github.com/esaio/esa-mcp-server)
- Slack RTS: キーワード検索は「ステミングあり・同義語なし」と記述されるが、言語別の記述はない — [Slack RTS API](https://docs.slack.dev/apis/web-api/real-time-search-api/)
- Drive: `fullText contains` は「entire string tokens」での照合としか書かれておらず、日本語の分割規則は記載なし — [Drive API: Search query terms](https://developers.google.com/workspace/drive/api/guides/ref-search-terms)

### Inferences
- Redmine に日本語の自然文を渡すと、空白がないため文全体が 1 トークンの `%…%` になり、ほぼ必ず 0 件になる。コネクタか LLM のどちらかで名詞に分割して空白区切りにする必要がある。逆に分割さえすれば部分一致なので、複合語の一部(「認可」で「再認可」)にも当たる。
- esa は表記揺れを吸収するとされるが範囲は不明なので、カタカナ/英字(「デプロイ」/「deploy」)は OR で両方書くのが MCP の指示とも整合する。
- Slack と Drive は日本語のトークン境界が不明なため、長い複合語(「権限委譲方式」)より構成語(「権限」「委譲」)の AND の方が安全という推測になる。これは実測で確かめるべき項目。
- 全角スペース・全角英数・全角コロン(`title:`)の正規化は、どのバックエンドでも害がなくコネクタ側でやれる前処理。

### Gaps
- Slack の日本語検索の仕様(分かち書き、部分一致の可否)は一次情報が得られなかった(ヘルプは 429)。実務者報告も検索では見つからなかった。
- Drive の `fullText` の日本語での挙動、GitHub の issue 検索・レガシーコード検索の日本語(CJK)トークン化は、公式資料にも実務者報告にも当たれなかった。
- esa の「表記の揺れ」の具体的範囲(かな/カナ、全角/半角、送り仮名、英字の大文字小文字)は未確認。
- いずれも合成コーパスでの実測(同一文書に対し、文・文節・名詞 AND・複合語・構成語で当たり方を比べる)で埋めるのが確実。
