# キーワード型検索ツールを使うエージェントのハーネス/プロンプト設計:主要ベンダー・製品の実践(2026-11 時点)

調査日: 2026-11-25。引用の信頼度の区別:

- **[原文]** = リポジトリの raw ファイルを直接取得して確認した文言(一字一句)。
- **[要約経由]** = Web ページを取得ツール(小型モデルによる抽出)経由で読んだ引用。文言は概ね正確だが、最終レポートに逐語引用する前に原文確認を推奨。
- **[二次]** = 一次情報が取れず二次情報に依拠。

---

## 1. Anthropic: クエリ生成・ツール呼び出し回数・並列化・結果評価について何を言っているか

### Takeaway
Anthropic の公開資料は一貫して「短く広いクエリから始めて絞る」「ツール呼び出し予算を質問の複雑さに合わせて事前に決める(単純 <5、中 5、難 10、最大 15〜20)」「各結果の後に思考して次のクエリを決める」「同一クエリを繰り返さない」「並列呼び出し」「逓減したら止める」を明文で指示している。検索付き claude.ai のシステムプロンプトは公式には非公開で、最も具体的な一次資料は cookbook に公開された Research 用プロンプト原文である。

### Cited Findings

**(a) Research サブエージェントのプロンプト原文(anthropics/claude-cookbooks、Research 機能のプロンプトとして公開)[原文]**

- 予算を先に決める: "As part of the plan, determine a 'research budget' - roughly how many tool calls to conduct to accomplish this task. Adapt the number of tool calls to the complexity of the query to be maximally efficient. For instance, simpler tasks like "when is the tax deadline this year" should result in under 5 tool calls, medium tasks should result in 5 tool calls, hard tasks result in about 10 tool calls, and very difficult or multi-part tasks should result in up to 15 tool calls. Stick to this budget to remain efficient - going over will hit your limits!" — [research_subagent.md](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/prompts/research_subagent.md)
- 下限と上限: "Execute a MINIMUM of five distinct tool calls, up to ten for complex queries. Avoid using more than ten tool calls." — [同上](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/prompts/research_subagent.md)
- 結果ごとの推論と同一クエリ禁止: "Reason carefully after receiving tool results. Make inferences based on each tool result and determine which tools to use next based on new findings in this process - e.g. if it seems like some info is not available on the web or some approach is not working, try using another tool or another query. Evaluate the quality of the sources in search results carefully. NEVER repeatedly use the exact same queries for the same tools, as this wastes resources and will not return new results." — [同上](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/prompts/research_subagent.md)
- クエリの書き方(全文): "Avoid overly specific searches that might have poor hit rates: * Use moderately broad queries rather than hyper-specific ones. * Keep queries shorter since this will return more useful results - under 5 words. * If specific searches yield few results, broaden slightly. * Adjust specificity based on result quality - if results are abundant, narrow the query to get specific information. * Find the right balance between specific and general." — [同上](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/prompts/research_subagent.md)
- search → fetch の核ループ: "The core loop is to use web search to run queries, then use web_fetch to get complete information using the URLs of the most promising sources." / "Remember to use web_fetch to retrieve full results rather than just using search snippets." — [同上](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/prompts/research_subagent.md)
- OODA ループ: "Execute an excellent OODA (observe, orient, decide, act) loop by (a) observing what information has been gathered so far, what still needs to be gathered to accomplish the task, and what tools are available currently; (b) orienting toward what tools and queries would be best ... (c) making an informed, well-reasoned decision to use a specific tool in a certain way; (d) acting to use this tool." — [同上](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/prompts/research_subagent.md)
- 並列: "whenever you need to perform multiple independent operations, invoke 2 relevant tools simultaneously rather than sequentially. Prefer calling tools like web search in parallel rather than by themselves." — [同上](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/prompts/research_subagent.md)
- ハード上限と停止条件: "stay under a limit of 20 tool calls and under about 100 sources. This is the absolute maximum upper limit. ... whenever you get to around 15 tool calls or 100 sources, make sure to stop gathering sources ... Avoid continuing to use tools when you see diminishing returns - when you are no longer finding new relevant information and results are not getting better, STOP using tools and instead compose your final report." — [同上](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/prompts/research_subagent.md)
- 内部ツール優先: "**ALWAYS use internal tools** (google drive, gmail, calendar, or similar other tools) for tasks that might require the user's personal data, work, or internal context ... Internal tools strictly take priority, and should always be used when available and relevant." — [同上](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/prompts/research_subagent.md)
- 矛盾情報の扱い: "When encountering conflicting information, prioritize based on recency, consistency with other facts, the quality of the sources used ... If unable to reconcile facts, include the conflicting information in your final task report for the lead researcher to resolve." — [同上](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/prompts/research_subagent.md)

**(b) Research リードエージェントのプロンプト原文 [原文]**

- 質問タイプの分類(depth-first / breadth-first / straightforward)を明示させる: "**Query type determination**: Explicitly state your reasoning on what type of query this question is from the categories below." — [research_lead_agent.md](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/prompts/research_lead_agent.md)
- サブエージェント数の目安: "Simple/Straightforward queries: create 1 subagent", "Standard complexity queries: 2-3 subagents", "Medium complexity queries: 3-5 subagents", "High complexity queries: 5-10 subagents (maximum 20)"、"Prefer fewer, more capable subagents over many overly narrow ones. More subagents = more overhead." — [同上](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/prompts/research_lead_agent.md)
- 委任ブリーフの要素: "Specific research objectives, ideally just 1 core objective per subagent." / "If needed, precise scope boundaries to prevent research drift." / "Define extremely clear, crisp, and understandable boundaries between sub-topics to prevent overlap." — [同上](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/prompts/research_lead_agent.md)
- 内部ソースごとのサブエージェント: "it is likely best to create an Asana subagent, a Slack subagent, a Google Drive subagent, and a Web Search subagent. Each of these subagents should be explicitly instructed to focus on using exclusively those tools" — [同上](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/prompts/research_lead_agent.md)
- 未知のツールは試し打ちして学ぶ: "always use the relevant read-only tools once or twice to learn how they work and get some basic information from them." — [同上](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/prompts/research_lead_agent.md)
- 停止: "when you have reached the point where further research has diminishing returns and you can give a good enough answer to the user, STOP FURTHER RESEARCH and do not create any new subagents." — [同上](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/prompts/research_lead_agent.md)

**(c) "How we built our multi-agent research system"(2025-06-13)[要約経由]**

- 広く始めて絞る: "start with short, broad queries, evaluate what's available, then progressively narrow focus." — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- 努力量のスケール: "Simple fact-finding requires just 1 agent with 3-10 tool calls, direct comparisons might need 2-4 subagents with 10-15 calls each" / "complex research might use more than 10 subagents with clearly divided responsibilities" — [同上](https://www.anthropic.com/engineering/multi-agent-research-system)
- 委任ブリーフ: "Each subagent needs an objective, an output format, guidance on the tools and sources to use, and clear task boundaries." — [同上](https://www.anthropic.com/engineering/multi-agent-research-system)
- 結果後の思考: サブエージェントは interleaved thinking を使い "to evaluate quality, identify gaps, and refine their next query." — [同上](https://www.anthropic.com/engineering/multi-agent-research-system)
- 並列化: "the lead agent spins up 3-5 subagents in parallel rather than serially"、"These changes cut research time by up to 90% for complex queries" — [同上](https://www.anthropic.com/engineering/multi-agent-research-system)
- ツール選択: "each tool needs a distinct purpose and a clear description." / "prefer specialized tools over generic ones." — [同上](https://www.anthropic.com/engineering/multi-agent-research-system)
- 観察された失敗: 早期のエージェントは "continuing when they already had sufficient results"、また "consistently chose SEO-optimized content farms over authoritative but less highly-ranked sources." — [同上](https://www.anthropic.com/engineering/multi-agent-research-system)
- トークン量と性能: "token usage by itself explains 80% of the variance"、"three factors explained 95% of the performance variance"(BrowseComp)、"multi-agent systems use about 15× more tokens than chats" — [同上](https://www.anthropic.com/engineering/multi-agent-research-system)

**(d) "Writing effective tools for agents"(2025-09-11)[要約経由]**

- エラー/切り詰めメッセージで行動を誘導: "Tool truncation and error responses can steer agents towards more token-efficient tool-use behaviors." 推奨行動の例として "making many small and targeted searches instead of a single, broad search." — [Anthropic Engineering](https://www.anthropic.com/engineering/writing-tools-for-agents)
- エラーは "opaque error codes or tracebacks" ではなく対処可能な文で書く — [同上](https://www.anthropic.com/engineering/writing-tools-for-agents)
- 結果量の制御: "pagination, range selection, filtering, and/or truncation with sensible default parameter values"、Claude Code では "we restrict tool responses to 25,000 tokens by default." — [同上](https://www.anthropic.com/engineering/writing-tools-for-agents)
- `response_format`: "allowing your agent to control whether tools return "concise" or "detailed" responses." — [同上](https://www.anthropic.com/engineering/writing-tools-for-agents)
- list より search: "implement a `search_contacts` or `message_contact` tool instead of a `list_contacts` tool." — [同上](https://www.anthropic.com/engineering/writing-tools-for-agents)
- 識別子: エージェントは "grapple with natural language names, terms, or identifiers significantly more successfully than they do with cryptic identifiers." — [同上](https://www.anthropic.com/engineering/writing-tools-for-agents)
- 名前空間: `asana_search`, `jira_search` のように "grouping related tools under common prefixes." — [同上](https://www.anthropic.com/engineering/writing-tools-for-agents)
- 評価: 現実的な評価タスクは "multiple tool calls—potentially dozens." を要しうる — [同上](https://www.anthropic.com/engineering/writing-tools-for-agents)

**(e) "Building effective agents"(2024-12-19。ページ自身が、記載のツール類の多くはその後変わったと注記)[要約経由]**

- "Tool definitions and specifications should be given just as much prompt engineering attention as your overall prompts." / "Think of this as writing a great docstring for a junior developer on your team." / 良い定義は "example usage, edge cases, input format requirements, and clear boundaries from other tools." を含む — [Anthropic Engineering](https://www.anthropic.com/engineering/building-effective-agents)
- SWE-bench エージェントでは "actually spent more time optimizing our tools than the overall prompt." — [同上](https://www.anthropic.com/engineering/building-effective-agents)
- 停止条件: "It's also common to include stopping conditions (such as a maximum number of iterations) to maintain control." — [同上](https://www.anthropic.com/engineering/building-effective-agents)
- evaluator-optimizer の適用例: "Complex search tasks that require multiple rounds of searching and analysis." — [同上](https://www.anthropic.com/engineering/building-effective-agents)

**(f) "Effective context engineering for AI agents"(2025-09-29)[要約経由]**

- just-in-time 検索: 事前埋め込み検索に対し、"maintain lightweight identifiers (file paths, stored queries, web links, etc.)" を保持して実行時に取りに行く。"we increasingly see teams augmenting these retrieval systems with "just in time" context strategies." — [Anthropic Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- メタデータはシグナル: "Folder hierarchies, naming conventions, and timestamps all provide important signals" — [同上](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- サブエージェントの返却量: "returns only a condensed, distilled summary of its work (often 1,000-2,000 tokens)." — [同上](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- 軽い圧縮: "One of the safest lightest touch forms of compaction is tool result clearing" — [同上](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- ハイブリッドの適所: "The hybrid strategy might be better suited for contexts with less dynamic content, such as legal or finance work." — [同上](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

**(g) Web search ツール docs(platform.claude.com、2026-11 時点の現行ページ)**

- 回数の目安(公式): "The `max_uses` parameter limits the number of searches in a single turn. Single-fact queries typically use 1–3 searches; comparative or multientity research can use 10 or more." — [Web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)
- ゼロ件はエラーではない: "A search that succeeds but matches no results returns an empty `content` list, not an error." エラーコードは `too_many_requests` / `invalid_tool_input` / `max_uses_exceeded` / `query_too_long` / `request_too_large` / `unavailable` — [同上](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)
- Dynamic filtering(`web_search_20260209` 以降): "Claude instead writes and runs code that filters the results first, so only relevant content reaches the context window. This reduces token use on search-heavy requests." — [同上](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)
- `response_inclusion: "excluded"`(`web_search_20260318`)で、コード実行が消費した生の検索結果ブロックを応答から落とせる — [同上](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)
- 結果の形: `url` / `title` / `page_age` / `encrypted_content`、引用の `cited_text` は "Up to 150 characters" — [同上](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)

**(h) 公開システムプロンプト**

- 公式ページは検索ありの版を公開していない: "For current models, these pages publish one version of the core system prompt, used in some chats with web search turned off. Other chats, including those with web search turned on, use other versions, which these pages don't publish." — [System prompts](https://platform.claude.com/docs/en/release-notes/system-prompts/overview)
- [二次・リーク由来] Claude 4(2025-05)のツール部は Simon Willison がリーク版を基に解説。"Queries in the Research category need 2-20 tool calls"、"Scale tool calls by difficulty: 2-4 for simple comparisons, 5-9 for multi-source analysis"、"Complex queries using terms like 'deep dive,' ... require AT LEAST 5 tool calls for thoroughness."、"Tool priority: (1) internal tools for company/personal data, (2) web_search/web_fetch for external info"、安定した知識は検索しない("Claude answers from its own extensive knowledge first for stable information.") — [Simon Willison, 2025-05-25](https://simonwillison.net/2025/May/25/claude-4-system-prompt/)

### Inferences
- 「約 3 ターン固定」は Anthropic の公開実践のどの水準にも合わない。最も単純なサブタスクでも「5 未満」、通常は 5〜10 回、上限 15〜20 回で、かつ**回数は質問の複雑さでモデル自身に事前見積もりさせる**設計。
- クエリ長の指示は「5 語未満」と明確に短い。キーワード型バックエンド(AND マッチで長いクエリほど 0 件になる)ではこの指示がそのまま効く。
- 検索スニペットで答えさせず、search(候補発見)→ fetch(全文)の二段を「核ループ」として固定している点は、内部ナレッジ検索の `search`/`fetch` IF とそのまま対応する。
- Dynamic filtering は「検索結果をモデルの文脈に入れる前に絞る」方向への 2026 年の進化で、精度(precision)問題への公式な回答の一つ。ただしコード実行前提。

### Gaps
- 検索有効時の claude.ai システムプロンプトの公式全文は非公開。「1-6 words」「never repeat similar queries」等の文言はリーク版に依拠する情報で、今回は一次確認できなかった(cookbook プロンプトの "under 5 words" と "NEVER repeatedly use the exact same queries" は原文確認済み)。
- multi-agent 記事の "Agents often default to overly long, specific queries that return few results" に相当する一節は記憶にはあるが、今回の取得では逐語確認できていない。引用するなら原文確認が必要。
- Web fetch ツール docs は今回未取得。

---

## 2. Claude Code / コーディングエージェント: 「RAG ではなく agentic search」と検索サブエージェント

### Takeaway
Claude Code は初期のベクトル DB 方式を捨て、モデル駆動の glob/grep に移行した(理由: 性能、インデックスの陳腐化、権限の複雑さ)。一方 2025 年後半以降の流れは「grep だけ」ではなく、(1) 検索を専用の高速サブエージェントに切り出して並列・少ターンで回す(Cognition SWE-grep、Amp、Cursor Explore)、(2) grep とセマンティック検索を併用する(Cursor)方向に収束している。

### Cited Findings
- [要約経由・編集者の要約であり本人の逐語ではない] Claude Code チームはローカルベクトル DB や再帰的なモデルベースのインデックスを試したが、stale index と permission complexity が欠点で、"Plain glob and grep, driven by the model, beat everything." — [Pragmatic Engineer, 2026-03-04](https://newsletter.pragmaticengineer.com/p/building-claude-code-with-boris-cherny)
- [二次] Boris Cherny の X での発言として "Early versions of Claude Code used RAG + a local vector database, but we found pretty quickly that agentic search generally works better." と "It outperformed everything, by a lot." が流通している(中国語記事の転載経由でしか確認できず、原ポスト未確認) — [huxiu 転載](https://www.huxiu.com/article/4871341.html)
- Anthropic 公式の説明: Claude Code は "primitives like glob and grep allow it to navigate its environment and retrieve files just-in-time"、かつ "Claude Code is an agent that employs this hybrid model"(CLAUDE.md を先読み + 実行時探索) — [Effective context engineering, 2025-09-29](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- **Cognition SWE-grep / Fast Context(2025-10-16)[要約経由]**: "fast agentic models specialized in highly parallel context retrieval."。最大 4 ターン(探索 3 + 回答 1)、1 ターン最大 8 並列ツール呼び出し、ツールは "a restricted set of tool calls (grep, read, glob, ...)"。動機は、エージェントの軌跡が "spending >60% of their first turn just retrieving context"、通常の agentic search は "dozens of sequential roundtrips" で遅く、"tens of thousands of tokens worth of irrelevant information" による文脈汚染を起こすこと。埋め込み検索は多段の質問で不正確になりうる。サブエージェントの出力は自由文の要約ではなく "designed to retrieve a list of files with line ranges."。報酬は F-β(β=0.5)で **再現率より適合率を重視**。"flow window" は 5 秒 — [Cognition](https://cognition.com/blog/swe-grep)
- **Cognition "Don't Build Multi-Agents"(2025-06-12)[要約経由]**: 原則 "Share context, and share full agent traces, not just individual messages." / "Actions carry implicit decisions, and conflicting decisions carry bad results."。ただし調査型サブエージェントは許容例として挙げ、Claude Code は "never does work in parallel with the subtask agent"、サブエージェントは "usually only tasked with answering a question, not writing any code."、利点は "the subagent's investigative work does not need to remain in the history of the main agent." — [Cognition](https://cognition.com/blog/dont-build-multi-agents)
- **Cursor(2025-11-06)[要約経由]**: セマンティック検索の追加で "Achieving on average 12.5% higher accuracy in answering questions (6.5%–23.5% depending on the model)."、"the combination of these two leads to the best outcomes."(grep + semantic)、"Semantic search is currently necessary to achieve the best results, especially in large codebases."。A/B では code retention +0.3%(1,000 ファイル以上で +2.6%)、セマンティック検索なしで不満のフォローアップが +2.2%。埋め込みモデルは "Our approach uses agent sessions as training data." — [Cursor blog](https://cursor.com/blog/semsearch)
- [検索結果の要約] Cursor の現行 docs は、複雑なタスクで「セマンティック検索で入口を見つけ、grep で参照を辿り、ファイル読みで文脈を作る」連鎖と、Explore サブエージェントを記述 — [Cursor docs: search](https://cursor.com/docs/agent/tools/search.md)
- **Amp(Thorsten Ball, 2025-06-10)[要約経由]**: 検索エージェントは "has access to read-only tools and that's prompted to search your codebase."、サブエージェントは "each have their own context window."。特化型サブエージェントを増やす試みは "never turned out to be useful."(検索エージェントで足り、モデルが "simply didn't invoke them.") — [Amp: Agents for the Agent](https://ampcode.com/agents-for-the-agent)
- **Sourcegraph Deep Search(ブログ 2026-05-01)[要約経由]**: "A single-shot RAG query over code often struggles on large, multi-repo systems."、多段エージェントは "that can take twenty small actions usually fares better."。各ステップ後に "evaluates what it found, decides whether it has enough information"、出力は "a research trail the reader can verify file by file." — [Sourcegraph blog](https://sourcegraph.com/blog/deep-search)

### Inferences
- 文書検索に移る教訓: (1) インデックス陳腐化と権限複製を避けるという Claude Code の理由は、ソース委譲型の内部ナレッジ検索と同じ制約であり、「ソースのネイティブ検索を多数回叩く」設計を正当化する。(2) ただし grep が効くのは**完全一致で網羅的に返る**からで、ランキング付き・件数上限付きのキーワード検索 API では 1 回の呼び出しの情報量が小さい。したがって回数と並列度で補う必要がある(SWE-grep は 3 探索ターン × 8 並列 = 最大 24 検索)。
- 「3 ターン」という数字自体は SWE-grep と同じだが、SWE-grep は 1 ターン 8 並列・専用学習モデル・適合率重視の報酬という前提がある。逐次 1 クエリ × 3 ターンとは別物。
- 検索サブエージェントの返り値を「ファイル + 行範囲」のような検証可能な形にする設計は、文書検索では「documentId + 該当箇所」のリストに対応し、要約の伝言ゲームによる劣化を避ける。
- Cursor の結果は「キーワード一致だけでは語彙不一致の質問に弱い」ことの定量的な裏付け。キーワード専用バックエンドでは、同義語・表記ゆれの展開をクエリ側(エージェント)が担う必要がある。

### Gaps
- Boris Cherny 本人の逐語発言は一次ソース(X の原ポスト、ポッドキャストの書き起こし)で確認できていない。
- Amp の検索サブエージェントのツール一覧・モデル・ターン上限の公式ドキュメントは見つからなかった。
- Claude Code の Explore サブエージェントの内部プロンプトは公式には非公開。

---

## 3. OpenAI: web search / deep research / file_search とクエリ書き換えの所在

### Takeaway
OpenAI はクエリ書き換えを**ツール側のオプション**(`rewrite_query`)として提供しつつ、多段の検索は推論モデルに任せる(`search` / `open_page` / `find_in_page` の 3 アクション、推論努力を上げる)構成。ハイブリッド検索の重みやスコア閾値は開発者が調整できる。

### Cited Findings
- Web search のアクション型: `search`("represents a web search."、通常 `queries` を含む)、`open_page`("represents a page being opened. Supported in reasoning models.")、`find_in_page`("represents searching within a page. Supported in reasoning models.") — [OpenAI: Web search guide](https://developers.openai.com/api/docs/guides/tools-web-search) [要約経由]
- 多ソースの質問には推論モデルを推奨、理由は "can refine its searches as it reads results."。多段調査では reasoning effort `high` / `xhigh` と background mode を推奨。`search_context_size` は low / medium(既定)/ high で、"This setting does not set an exact token count or guarantee a specific number of sources or citations."。Web search の文脈は 128k トークンで上限 — [同上](https://developers.openai.com/api/docs/guides/tools-web-search) [要約経由]
- 同ページは検索回数の目安を示していない(回数はモデル任せ) — [同上](https://developers.openai.com/api/docs/guides/tools-web-search) [要約経由]
- 内部データと Web の分離: "run public web search and private MCP lookups in separate requests" — [同上](https://developers.openai.com/api/docs/guides/tools-web-search) [要約経由]
- Vector store search のクエリ書き換え: "Enable this feature by setting `rewrite_query=true` when performing a `search`."、書き換え後は "The rewritten query will be available in the result's `search_query` field."。例: "I'd like to know the height of the main office building." → "primary office building height." — [OpenAI: Retrieval guide](https://developers.openai.com/api/docs/guides/retrieval) [要約経由]
- ランキング調整: `ranking_options` で `ranker`(`auto` / `default-2024-08-21`)と `score_threshold`(0.0〜1.0)。`ranking_options.hybrid_search` で埋め込みとテキストの重みを調整(reciprocal rank fusion)。属性フィルタはセマンティック検索の前に適用 — [同上](https://developers.openai.com/api/docs/guides/retrieval) [要約経由]
- 結果の整形例: 各結果を `<result>` / `<content>` タグで file ID とファイル名付きで包む — [同上](https://developers.openai.com/api/docs/guides/retrieval) [要約経由]
- file_search ツール: "semantic and keyword search."、`max_num_results` は "can help reduce both token usage and latency, but may come at the cost of reduced answer quality."、検索結果本体は既定で返らず `include: ["file_search_call.results"]` が必要 — [OpenAI: File search guide](https://developers.openai.com/api/docs/guides/tools-file-search) [要約経由]

### Inferences
- `rewrite_query` の例(自然文 → 3〜4 語のキーワード句)は、OpenAI も「検索バックエンドに渡す文字列は短いキーワード句が良い」と見なしていることを示す。書き換えをツール内に置くと、モデルが自然文で呼んでも救済される(ハーネス側の防御策になる)。
- `open_page` と `find_in_page` を別アクションにしているのは、「検索 → 開く → ページ内検索」の 3 段を第一級の操作として扱う設計で、Anthropic の search → fetch と同型。

### Gaps
- Deep Research API 専用ガイド(プロンプト書き換え・確認質問の段、`max_tool_calls`、MCP の search/fetch 契約)は、試した URL が web search ガイドの内容を返し、取得できなかった。記憶では旧版ガイドに「軽量モデルでプロンプトを詳細化してから deep research モデルに渡す」「MCP サーバーは search と fetch の 2 ツールを実装する」という記述があったが、今回は未確認。
- file_search が内部で「複雑な質問を複数検索に分解して並列実行し、キーワード + セマンティックで検索して再ランクする」という記述は旧 Assistants API docs(2024)にあった認識だが、現行ページでは確認できなかった。
- ChatGPT search のシステムプロンプトは公式非公開で、今回は調べていない。Agents SDK 固有の検索ガイダンスも未取得。

---

## 4. Google: Gemini の Google Search grounding、Vertex AI Search

### Takeaway
Gemini はモデルが自動で 1 個以上の検索クエリを生成・実行する方式で、Gemini 3 以降は**モデルが実行した検索クエリ 1 本ごとに課金**される(クエリ fan-out が前提)。Vertex AI Search の answer メソッドは、クエリ言い換え(サブクエリ分割、最大 5 ステップ)と ReAct 型の多段推論をサーバー側機能として持つ。

### Cited Findings
- 動作: "The model analyzes the prompt and determines if a Google Search can improve the answer." → "If needed, the model automatically generates one or multiple search queries and executes them." — [Gemini API: Grounding with Google Search](https://aistudio.google.com/docs/google-search) [要約経由。ai.google.dev から aistudio.google.com/docs へリダイレクト]
- 課金: Gemini 3 以降は "your project is billed for **each** search query that the model decides to execute."(月 5,000 件まで無料、以降 $14 / 1,000 検索)。Gemini 2.5 以前はプロンプト単位 — [同上](https://aistudio.google.com/docs/google-search) [要約経由]
- 現行ページの応答は `google_search_call`(モデルが実行した `queries`)、`google_search_result`(`search_suggestions`)、`annotations` の `url_citation` で記述されている — [同上](https://aistudio.google.com/docs/google-search) [要約経由]
- Vertex AI Search answer メソッド: クエリ言い換えは既定で有効で、複雑な質問をサブクエリに分割し、フォローアップを前の文脈と統合する。`queryRephraserSpec.maxRephraseSteps` は最大 5(未設定または 1 未満は 1)。多段推論は ReAct パラダイムに基づく。検索結果は最大 25 件(既定 10) — [Vertex AI Search: answer](https://docs.cloud.google.com/generative-ai-app-builder/docs/answer) [要約経由。ページ先頭 10 万文字のみ読了]
- クエリ分類(`ADVERSARIAL_QUERY` / `NON_ANSWER_SEEKING_QUERY`)は既定でオフ、ラベル付けのみで、`ignore...` を設定した場合だけ回答を抑止する — [同上](https://docs.cloud.google.com/generative-ai-app-builder/docs/answer) [要約経由]

### Inferences
- Google の 2 製品はどちらも「1 ユーザー質問 = 複数検索クエリ」を既定動作としている。クエリ単位課金への変更は、fan-out が常態化したことの反映と読める。
- Vertex AI Search の「言い換えステップ最大 5」は、企業内検索向け製品におけるサーバー側の反復上限の実例(固定上限だが 3 より大きく、既定は 1)。

### Gaps
- 指定された `groundingMetadata.webSearchQueries` という旧フィールド名は現行ページ(取得した範囲)に出てこない。API 形の移行によるものか、取得ツールの抽出漏れかは未確認。
- Gemini Deep Research(Interactions API / エージェント)の計画・反復に関する公式記述は未取得。

---

## 5. 検索 API ベンダー(Perplexity / Exa / Tavily / Brave): クエリ様式と LLM 向けの適応

### Takeaway
ベンダー間でクエリ様式の推奨は割れる。キーワード系インデックス(Perplexity Search API、Tavily)は「短いキーワード、1 クエリ 1 論点、複数クエリに分割、年はクエリに入れずフィルタで」。ニューラル系(Exa)は「キーワードではなく欲しいページを記述」。つまり**クエリ様式はバックエンド依存で、ツール説明に書くべき情報**である。共通の適応は、複数クエリ同時実行、結果数・抜粋量の制御、スコアの返却、エージェントの目的(objective)を別パラメータで渡すこと。

### Cited Findings
- **Perplexity Search API best practices [要約経由]**: "Name the entities, terms, and constraints you care about, in a few keywords."、短いキーワードクエリは完全な質問文より通常うまく働く。年をクエリに足さない(年は "is only another keyword and does not restrict publication dates.")、日付フィルタを使う。1 リクエストに最大 5 本の短いクエリ、比較はエンティティごとに 1 クエリ。`max_results`(既定 10)は "Set it to the number of results your code or model will read."。ドメインや言語はクエリ語ではなくフィルタで絞る。結合結果は `url` で重複排除 — [Perplexity docs](https://docs.perplexity.ai/guides/search-best-practices)
- **Tavily best practices [要約経由]**: クエリは 1500 文字未満、長文プロンプトではなく検索エージェントへの入力として扱う。簡潔に保ち、複雑・複数論点の質問は焦点を絞ったサブクエリに分割(例: 企業の質問を競合・業績・最近の動向に分ける)。`search_depth` は `ultra-fast` / `fast` / `basic`(一般用途の推奨既定)/ `advanced`(最高の関連度、ニッチな話題・多部構成の質問向け、2 クレジット)。`max_results` 既定 5 で、高くしすぎると品質が下がりうる。`score` による閾値フィルタ、search で URL を見つけてから Extract API で全文を取る 2 段構成、async での並列実行を推奨 — [Tavily docs](https://docs.tavily.com/documentation/best-practices/best-practices-search)
- **Exa search best practices [要約経由]**: キーワードの集合ではなく欲しいページを記述する(主題・ソース種別・期間を含める)。結果が悪ければまずクエリを直し、検索モードの変更は最後。`type` は `auto` から始め、難しい検索や多数結果の統合は `deep`。`useAutoprompt` は削除すべきフィールド(Exa がクエリを直接解釈)。コンテンツは `highlights` を基本とし(関連度に応じて抜粋量を決める)、少数ページだけ全文が要るなら highlights で検索してから Contents を呼ぶ。`numResults` は文脈を小さくしたいなら少なく、再現率が欲しいなら多く — [Exa docs](https://exa.ai/docs/reference/search-best-practices)
- **Exa のエージェント向け推奨 [要約経由]**: より大きなタスクの 1 ステップである検索には `objective` を付ける(どの文書を上位にし、何を除外し、どの事実を抜くかを検索側に伝える)。検索をツールとして公開するときは `objective` を必須の文字列パラメータにする。`notices` は結果と一緒にモデルに渡し、`warnings` は開発者向けにログしてモデルに渡さない — [同上](https://exa.ai/docs/reference/search-best-practices)
- OSS 側の実例(検索演算子の禁止)[原文]: GPT Researcher のクエリ生成プロンプトは "Each query must be a plain natural language phrase. Do not use search operator syntax such as site:, filetype:, inurl:, intitle:, OR, AND, or NOT — these operators are not universally supported and will return empty results on many search backends." — [gpt_researcher/prompts.py](https://raw.githubusercontent.com/assafelovic/gpt-researcher/master/gpt_researcher/prompts.py)

### Inferences
- 「キーワードか自然文か」に普遍解はなく、バックエンドの照合方式で決まる。キーワード(BM25/AND 系)バックエンドに対しては Perplexity/Tavily/Anthropic/Jina の指示(2〜5 語、1 クエリ 1 論点、分割)が該当し、Exa の「長く記述的に」は逆効果になる。
- Exa の `objective` パラメータは注目に値する: **クエリ文字列(照合用)と検索意図(ランキング/抽出用)を別フィールドに分ける**。キーワードバックエンドでも、objective をハーネス側の再ランクやスニペット選択に使えば、短いクエリのまま精度を上げられる。
- 「年・サイト・種別はクエリ語ではなく構造化フィルタで」は 3 社共通。ソースが検索オプション(期間、カテゴリ、タグ等)を持つ場合、それをツールの引数として露出するのが定石。
- Tavily の旧資料で知られた 400 文字制限は、現行ページでは 1500 文字と記載されている(更新された点)。

### Gaps
- Brave の LLM Context API のドキュメントは試した URL が 404 で取得できず、今回は一次情報なし。
- Exa の Deep Search が内部で行うクエリ拡張の詳細は当該ページに記載がなく、未確認。
- Perplexity の Sonar / Deep Research 側(回答生成 API)の内部ハーネスは未調査。

---

## 6. OSS の deep research ハーネス: クエリ生成・内省・ギャップ分析・停止条件のプロンプト

### Takeaway
主要 OSS は例外なく「検索のたびに内省(何が分かった/何が足りない/続けるか)」を強制し、明示的な停止条件(十分に答えられる、関連ソース 3 件以上、直近 2 回が同内容)とハード上限を併記する。失敗したクエリを次のプロンプトに明示的に戻して再利用を防ぐ仕組み(Jina)や、ゼロ件時に緩和を促すエラー文(smolagents)が実装されている。

### Cited Findings

**LangChain open_deep_research(`prompts.py`、main ブランチ)[原文]** — [prompts.py](https://raw.githubusercontent.com/langchain-ai/open_deep_research/main/src/open_deep_research/prompts.py)
- 研究者プロンプトの手順: "Think like a human researcher with limited time. Follow these steps: 1. **Read the question carefully** - What specific information does the user need? 2. **Start with broader searches** - Use broad, comprehensive queries first 3. **After each search, pause and assess** - Do I have enough to answer? What's still missing? 4. **Execute narrower searches as you gather information** - Fill in the gaps 5. **Stop when you can answer confidently** - Don't keep searching for perfection"
- 予算: "**Simple queries**: Use 2-3 search tool calls maximum / **Complex queries**: Use up to 5 search tool calls maximum / **Always stop**: After 5 search tool calls if you cannot find the right sources"
- 停止条件: "**Stop Immediately When**: - You can answer the user's question comprehensively - You have 3+ relevant examples/sources for the question - Your last 2 searches returned similar information"
- 内省の強制: "**CRITICAL: Use think_tool after each search to reflect on results and plan next steps. Do not call think_tool with the tavily_search or any other tools.**" 内省の問い: "What key information did I find? / What's missing? / Do I have enough to answer the question comprehensively? / Should I search more or provide my answer?"
- スーパーバイザー: "**Bias towards single agent** - Use single agent for simplicity unless the user request has clear opportunity for parallelization"、"**Maximum {max_concurrent_research_units} parallel agents per iteration**"、"Always stop after {max_researcher_iterations} tool calls to ConductResearch and think_tool"
- 委任ブリーフ: "When calling ConductResearch, provide complete standalone instructions - sub-agents can't see other agents' work" / "Do NOT use acronyms or abbreviations in your research questions, be very clear and specific"
- 圧縮時の抜粋上限: key_excerpts は "up to a maximum of 5"

**GPT Researcher(`prompts.py`、master)[原文]** — [prompts.py](https://raw.githubusercontent.com/assafelovic/gpt-researcher/master/gpt_researcher/prompts.py)
- 固定数のクエリを一括生成(`max_iterations: int = 3` が既定): "Write {max_iterations} search queries to research the following task: "{task}""
- 初回検索結果を文脈にしてクエリを具体化: "Use this context to inform and refine your search queries. The context provides real-time web information that can help you generate more specific and relevant queries."
- 検索演算子の禁止(上記 5 節の引用)

**Jina node-DeepResearch(`agent.ts` / `schemas.ts` / `query-rewriter.ts`、main)[原文]** — [agent.ts](https://raw.githubusercontent.com/jina-ai/node-DeepResearch/main/src/agent.ts)、[schemas.ts](https://raw.githubusercontent.com/jina-ai/node-DeepResearch/main/src/utils/schemas.ts)、[query-rewriter.ts](https://raw.githubusercontent.com/jina-ai/node-DeepResearch/main/src/tools/query-rewriter.ts)
- クエリのスキーマ記述: `q` は "keyword-based search query, 2-3 words preferred, total length < 30 characters."(max 50)。配列は "Array of search keywords queries, orthogonal to each other. Maximum ${MAX_QUERIES_PER_STEP} queries allowed."。定数は `MAX_QUERIES_PER_STEP = 5`、`MAX_URLS_PER_STEP = 5`、`MAX_REFLECT_PER_STEP = 2`
- クエリ書き換え器の規則: "Split queries for distinct aspects / Add operators only when necessary / Ensure each query targets a specific intent / Remove fluff words but preserve crucial qualifiers / Keep 'q' field short and keyword-based (2-5 words ideal)"、時間条件は "Use 'tbs' for time-sensitive queries (remove time constraints from 'q' field)"、演算子の文法(`+term`、`-term`、`filetype:`)をプロンプト内に明記
- 多視点展開: 7 つの "cognitive personas"(Expert Skeptic、Detail Analyst、Historical Researcher、Comparative Thinker、Temporal Context、Globalizer、Reality-Hater-Skepticalist)から各 1 クエリ。Globalizer は主題にとって最も権威ある言語で検索する
- 失敗クエリの再提示: search アクションの説明に "Avoid those unsuccessful search requests and queries: <bad-requests> ... </bad-requests>" を動的に挿入
- 重複検索時のフィードバック: "But then you realized you have already searched for these keywords before, no new information is returned. You decided to think out of the box or cut from a completely different angle." / 結果欄 "You have tried all possible queries and found no new information. You must think out of the box or different angle!!!"
- reflect アクション: "Think slowly and planning lookahead. Examine <question>, <context>, previous conversation with users to identify knowledge gaps. - Reflect the gaps and plan a list key clarifying questions that deeply related to the original question and lead to the answer"
- 予算は回数でなくトークン: `tokenBudget: number = 1_000_000`、`maxBadAttempts: number = 2`、`regularBudget = tokenBudget * 0.85` を超えると強制回答モード("beast mode")。URL が 50 件たまると検索を無効化(`allowSearch = allowSearch && (weightedURLs.length < 50)`)。クエリは埋め込みで既出クエリと重複排除(`dedupQueries`)
- search の基本方針: "Always prefer a single search request, only add another request if the original question covers multiple aspects or elements and one query is not enough, each request focus on one specific aspect of the original question"

**smolagents open_deep_research(`run.py` / `text_web_browser.py`、main)[原文]** — [run.py](https://raw.githubusercontent.com/huggingface/smolagents/main/examples/open_deep_research/run.py)、[text_web_browser.py](https://raw.githubusercontent.com/huggingface/smolagents/main/examples/open_deep_research/scripts/text_web_browser.py)
- 検索サブエージェントは `max_steps=20`、`planning_interval=4`(4 ステップごとに再計画)、マネージャーは `max_steps=12`。`text_limit = 100000`
- 委任は自然文で: "Your request must be a real sentence, not a google search! Like "Find me this information (...)" rather than a few keywords." / "Provide him as much context as possible, in particular if you need to search on a specific timeframe!"
- ゼロ件時のエラー文: "No results found for query: '{query}'. Use a less specific query." / "No results found for '{query}'{year_filter_message}. Try with a more general query, or remove the year filter."
- ページ内検索(`find_on_page`、ワイルドカード対応)と年フィルタ(`filter_year`)をツールとして提供

**Onyx(ブログ 2026-02-17)[要約経由]** — [Onyx blog](https://onyx.app/blog/building-the-best-deep-research)
- 計画は実行から完全に分離: "Once the plan is ready, it is the only context we bring into the research phase."
- オーケストレーター: "The Orchestrator basically asks questions and then analyzes subagent reports."。入れ子は "only 2 levels deep."、深い入れ子は文脈が "can easily become unrecognizable through just a few layers."
- 研究エージェントのツール: `web_search`、`open_url`、`internal_search`、`generate_intermediate_report`
- 検索と取捨選択をモデルに残す: エンドツーエンドの Web 検索は "takes away the LLM's freedom to decide which results are actually most relevant."、結果を事前要約して渡す方式は "handicaps better models since the research agents lose access to ground truth." として却下
- `think_tool` は "a chain-of-thought approach that predates reasoning models," で、非推論モデル向けの補助
- プロンプトの知見: 関連する指示は近接させる、条件付きルールを増やしすぎるとモデルが "lose track very quickly."、リマインダは "text prompts that the system injects at the very end of the context passed to the LLM."。(古いモデルでの例として)引用の信頼性はリマインダなし約 70% → あり約 99%

### Inferences
- OSS の予算は幅が大きい: ODR は研究者 1 体あたり検索 5 回が上限(ただし複数研究者を並列に立てる)、smolagents は 20 ステップ、Jina は 100 万トークン。**「固定 3 回」に近いのは GPT Researcher の一括 3 クエリ生成だけで、これは反復なしの旧来型(2023 年設計)**。
- ODR の停止条件 3 つ(十分に答えられる / 関連ソース 3 件以上 / 直近 2 回が同内容)は、そのまま流用できる具体的で検査可能な基準。
- Jina の「失敗クエリ一覧をプロンプトに戻す」「重複検索を検出して別角度を促す文を返す」は、ハーネス側で安価に実装できる再定式化の誘導で、モデル任せの「同じクエリを繰り返すな」指示より確実。
- Onyx の「事前要約するな、モデルに原文を見せろ」と Anthropic の「スニペットではなく fetch で全文」は同じ方向。精度不足の原因がスニペットだけでの判断にある場合に効く。
- smolagents と ODR は逆方向の指示を持つ: 検索エンジンへは短いキーワード、**サブエージェントへは略語なしの完全な自然文**。2 つの層で文体を使い分けるのが共通理解。

### Gaps
- Onyx の研究エージェントの実プロンプト(クエリ生成指示、サイクル数上限)はリポジトリのファイルを特定して読んでおらず、ブログの記述のみ。
- ODR の `max_researcher_iterations` / `max_concurrent_research_units` の既定値は configuration ファイルを読んでおらず未確認。
- Jina の Globalizer(権威ある言語で検索)は Web 向けの工夫で、日本語中心の社内文書にそのまま当てはまるかは不明(日英の表記ゆれ展開としては示唆あり)。

---

## 7. 横断パターン(1)〜(8)の整理

### Takeaway
8 つのパターンはすべて複数の一次資料で確認できる。特に (3) 結果ごとの内省、(4) 複雑さに応じた動的予算 + ハード上限、(2) 広く始めて絞る、(1) 分解・fan-out は、Anthropic・LangChain・Jina・Google・Perplexity/Tavily で独立に一致している。

### Cited Findings

| # | パターン | 確認できた実例(出典) |
|---|---|---|
| 1 | クエリ分解 / fan-out | Gemini は "automatically generates one or multiple search queries" — [Google](https://aistudio.google.com/docs/google-search)。Perplexity は 1 リクエスト最大 5 クエリ、比較はエンティティごと — [Perplexity](https://docs.perplexity.ai/guides/search-best-practices)。Tavily はサブクエリ分割を推奨 — [Tavily](https://docs.tavily.com/documentation/best-practices/best-practices-search)。Jina は 1 ステップ最大 5 本の "orthogonal" なクエリ — [Jina schemas.ts](https://raw.githubusercontent.com/jina-ai/node-DeepResearch/main/src/utils/schemas.ts)。SWE-grep は 1 ターン 8 並列 — [Cognition](https://cognition.com/blog/swe-grep)。Vertex AI Search はサブクエリ分割を既定で有効 — [Google Cloud](https://docs.cloud.google.com/generative-ai-app-builder/docs/answer) |
| 2 | 広く → 狭く | "Use moderately broad queries rather than hyper-specific ones ... if results are abundant, narrow the query" — [Anthropic subagent prompt](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/prompts/research_subagent.md)。"Start with broader searches" → "Execute narrower searches as you gather information" — [ODR](https://raw.githubusercontent.com/langchain-ai/open_deep_research/main/src/open_deep_research/prompts.py) |
| 3 | 結果ごとの内省 | "Reason carefully after receiving tool results." — [Anthropic](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/prompts/research_subagent.md)。"Use think_tool after each search to reflect on results and plan next steps." — [ODR](https://raw.githubusercontent.com/langchain-ai/open_deep_research/main/src/open_deep_research/prompts.py)。Jina の reflect アクション(ギャップ質問の生成)— [Jina agent.ts](https://raw.githubusercontent.com/jina-ai/node-DeepResearch/main/src/agent.ts)。smolagents の `planning_interval=4` — [smolagents](https://raw.githubusercontent.com/huggingface/smolagents/main/examples/open_deep_research/run.py)。Onyx は think_tool を非推論モデル向け補助と位置づけ — [Onyx](https://onyx.app/blog/building-the-best-deep-research) |
| 4 | 動的予算 + ハード上限 | Anthropic: <5 / 5 / 約 10 / 最大 15、絶対上限 20 — [Anthropic](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/prompts/research_subagent.md)。公式 docs: 単一事実 1〜3 回、比較・多エンティティは 10 回以上 — [Web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)。ODR: 単純 2〜3、複雑 5 まで — [ODR](https://raw.githubusercontent.com/langchain-ai/open_deep_research/main/src/open_deep_research/prompts.py)。Jina: トークン予算の 85% で強制回答 — [Jina agent.ts](https://raw.githubusercontent.com/jina-ai/node-DeepResearch/main/src/agent.ts)。SWE-grep: 固定 4 ターンだが 8 並列 — [Cognition](https://cognition.com/blog/swe-grep) |
| 5 | バックエンドの検索文法をツール説明に書く | "example usage, edge cases, input format requirements, and clear boundaries from other tools" — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)。Jina はクエリ演算子の文法とスキーマ記述(語数・文字数)を明記 — [Jina query-rewriter.ts](https://raw.githubusercontent.com/jina-ai/node-DeepResearch/main/src/tools/query-rewriter.ts)。GPT Researcher は逆に、バックエンド非対応の演算子を禁止 — [GPT Researcher](https://raw.githubusercontent.com/assafelovic/gpt-researcher/master/gpt_researcher/prompts.py)。Anthropic リードは未知ツールを 1〜2 回試し打ちして学ばせる — [Anthropic lead prompt](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/prompts/research_lead_agent.md) |
| 6 | ゼロ件・エラー文で再定式化を誘導 | "Tool truncation and error responses can steer agents towards more token-efficient tool-use behaviors." — [Writing tools](https://www.anthropic.com/engineering/writing-tools-for-agents)。"No results found for query: '{query}'. Use a less specific query." / "Try with a more general query, or remove the year filter." — [smolagents](https://raw.githubusercontent.com/huggingface/smolagents/main/examples/open_deep_research/scripts/text_web_browser.py)。Jina の重複検索フィードバックと `<bad-requests>` — [Jina agent.ts](https://raw.githubusercontent.com/jina-ai/node-DeepResearch/main/src/agent.ts) |
| 7 | 結果の整形(スニペット vs 全文、量の上限) | search はスニペット、全文は fetch — [Anthropic](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/prompts/research_subagent.md)。ツール応答 25,000 トークン既定上限、`response_format` concise / detailed — [Writing tools](https://www.anthropic.com/engineering/writing-tools-for-agents)。Exa は highlights を基本、必要な少数だけ全文 — [Exa](https://exa.ai/docs/reference/search-best-practices)。Tavily は search → extract の 2 段と `score` 閾値 — [Tavily](https://docs.tavily.com/documentation/best-practices/best-practices-search)。Claude の dynamic filtering(文脈に入る前にコードで絞る)— [Web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)。Onyx は事前要約を却下 — [Onyx](https://onyx.app/blog/building-the-best-deep-research) |
| 8 | 精密なブリーフ付きの検索サブエージェント | "an objective, an output format, guidance on the tools and sources to use, and clear task boundaries" — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)。"provide complete standalone instructions" / 略語禁止 — [ODR](https://raw.githubusercontent.com/langchain-ai/open_deep_research/main/src/open_deep_research/prompts.py)。"Your request must be a real sentence, not a google search!" — [smolagents](https://raw.githubusercontent.com/huggingface/smolagents/main/examples/open_deep_research/run.py)。返り値は 1,000〜2,000 トークンの要約 — [Context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)、またはファイル + 行範囲 — [Cognition](https://cognition.com/blog/swe-grep)。入れ子は 2 段まで — [Onyx](https://onyx.app/blog/building-the-best-deep-research) |

### Inferences
- 約 3 検索ターン・キーワードバックエンド・低精度という現状に対し、資料から直接導ける改善候補(優先度は当方の判断):
  1. **ターン数ではなく検索呼び出し数で予算を表現し、質問の複雑さで事前見積もりさせる**(単純 2〜5、複雑 10 前後、ハード上限 15〜20)。1 ターンに複数クエリを並列で出せるようにすれば、ターン数を増やさずに検索数を増やせる(SWE-grep、Jina、Perplexity の multi-query)。
  2. **クエリ様式をツール説明とプロンプトの両方に明記**: 2〜5 語、1 クエリ 1 論点、期間・カテゴリ等は引数で、バックエンドが対応する演算子だけを例付きで記載。
  3. **結果ごとの内省を必須化**し、停止条件を検査可能な形で書く(ODR の 3 条件)。
  4. **ゼロ件・重複・過多のときにツール応答で次の一手を示す**(「より一般的な語で」「フィルタを外す」「既に同じクエリを実行済み」)。既出クエリ一覧をプロンプトに戻す。
  5. **スニペットで判断せず、有望な上位を fetch して本文で確認**してから採否を決める(精度に直結)。
  6. 精度重視なら、検索サブエージェントの出力を「文書 ID + 該当箇所」の検証可能なリストにし、適合率寄りに評価する(SWE-grep の F0.5)。
- 「精度が低い」原因がクエリの長さ・過度な具体性にあるのか、スニペットだけでの採否判断にあるのかで効く対策が違う。資料は両方を別々の失敗モードとして扱っている(前者: Anthropic "overly specific searches that might have poor hit rates"、後者: Onyx / Anthropic の fetch 指示)。
- 2023〜2024 年の助言で置き換わったもの: (a) 固定本数のクエリを一括生成して終わる単発 fan-out(GPT Researcher 型)→ 反復 + 内省、(b) 事前埋め込み RAG 一択 → just-in-time の agentic search、あるいは併用(Anthropic 2025-09、Cursor 2025-11)、(c) Exa の autoprompt → 廃止方向(`useAutoprompt` は削除対象)、(d) 明示的な think ツール → 推論モデルでは不要寄り(Onyx 2026-02)、(e) Gemini 1.5 の dynamic retrieval 閾値方式 → モデルが検索の要否と本数を決める方式(旧 `google_search_retrieval` は旧モデル用)。

### Gaps
- パターン (5) について「ソース固有の検索文法をツール説明に書くと精度が何 % 上がるか」のような定量データは見つからなかった。
- キーワードバックエンドに限定した(ウェブ検索ではない企業内検索での)ターン数と精度の関係を測った公開ベンチマークは、今回の範囲では見つからなかった。Anthropic の「トークン量が分散の 80% を説明」は BrowseComp(ウェブ)での結果。
- 日本語のキーワード検索(分かち書き、表記ゆれ)に特化したクエリ生成の公開ガイダンスは、今回の対象ベンダーからは見つからなかった。

---

## 8. 出典の日付一覧と鮮度の注意

### Takeaway
中核となる一次資料は 2025-06〜2026-05 に集中しており、2026-11 時点でも現行の指針として扱える。2024-12 の "Building effective agents" は原則論としては有効だが、ページ自身がツール面の記述は古いと注記している。

### Cited Findings
- 2024-12-19: Building effective agents — [Anthropic](https://www.anthropic.com/engineering/building-effective-agents)
- 2025-05-25: Claude 4 システムプロンプト解説(リーク版に依拠する部分あり)— [Simon Willison](https://simonwillison.net/2025/May/25/claude-4-system-prompt/)
- 2025-06-10: Agents for the Agent — [Amp](https://ampcode.com/agents-for-the-agent)
- 2025-06-12: Don't Build Multi-Agents — [Cognition](https://cognition.com/blog/dont-build-multi-agents)
- 2025-06-13: How we built our multi-agent research system — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
- 2025-09-11: Writing effective tools for agents — [Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)
- 2025-09-29: Effective context engineering for AI agents — [Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- 2025-10-16: SWE-grep — [Cognition](https://cognition.com/blog/swe-grep)
- 2025-11-06: Improving agent with semantic search — [Cursor](https://cursor.com/blog/semsearch)
- 2026-02-17: Building the best deep research — [Onyx](https://onyx.app/blog/building-the-best-deep-research)
- 2026-03-04: Building Claude Code with Boris Cherny — [Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/building-claude-code-with-boris-cherny)
- 2026-05-01: Deep Search — [Sourcegraph](https://sourcegraph.com/blog/deep-search)
- 日付なし(2026-11-25 取得時点の現行版): Claude web search tool docs、OpenAI の web search / retrieval / file search ガイド、Gemini grounding docs、Vertex AI Search answer docs、Perplexity / Tavily / Exa の best practices、各 OSS リポジトリの main / master ブランチ

### Inferences
- OSS プロンプトは main ブランチの現在値であり、コミット日は確認していない。レポートで引用する際は「2026-11-25 取得」と明記するのが安全。

### Gaps
- Anthropic cookbook の research プロンプトの初回公開日は未確認(multi-agent 記事と同時期の 2025 年中頃の公開という認識だが、今回は確かめていない)。
