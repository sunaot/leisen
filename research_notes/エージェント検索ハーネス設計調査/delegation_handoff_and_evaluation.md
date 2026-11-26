# 多層エージェント検索パイプラインの委譲(ハンドオフ)設計と評価・観測(2026-11-25 時点)

調査メモの読み方:
- 引用は原文のまま(英語)。取得は WebFetch(要約モデル経由)なので、短い引用は原文どおりだが、設計判断の根拠にする引用は公開前に原典で再確認すること。
- 「強モデル依存」= フロンティアモデルでの知見。「弱モデルにも適用」= 小型ローカルモデル(約 27B 級)でも成り立つ根拠があるもの。根拠がないものは明記した。
- 対象の連鎖: チャット UI の LLM(LibreChat)→ Orchestrator MCP サーバーの `ask`(約 3 ターンの検索エージェント)→ MCP Gateway → 各コネクタの `search` → SaaS のキーワード検索。

## 1. ハンドオフ / ブリーフの品質: サブエージェントに何を渡すべきか

### Takeaway
主要ベンダーの指針は一致している。サブエージェントは親の会話を見ていないので、渡すのは「短い言い換えクエリ」ではなく、目的・出力形式・使うツールと情報源・境界を含む自己完結したブリーフであり、可能なら元の文脈そのもの(会話履歴・ユーザーの原文)を共有する。2026-11 の実験(Lost in Delegation)は、検索の委譲が単一エージェントより精度を下げる場合が多いこと(32 条件中 21〜22 条件で悪化)を示しており、オーナーの観察と整合する。

### Cited Findings

**Anthropic**
- (2025-06-13)サブエージェントへの委譲に必要な 4 要素: "Each subagent needs an objective, an output format, guidance on the tools and sources to use, and clear task boundaries." 曖昧な指示では作業の重複が起きた(1 体が 2021 年の自動車向け半導体不足を調べ、他の 2 体が 2025 年のサプライチェーンを重複して調べた例)。 — [Anthropic, How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- (同)「伝言ゲーム」対策として、サブエージェントが成果物を外部ストアに書き、軽い参照だけを調整役に返す。"pass lightweight references back to the coordinator" / "prevents information loss during multi-stage processing" — [同上](https://www.anthropic.com/engineering/multi-agent-research-system)
- (同)向かない領域: "require all agents to share the same context" な領域は現時点でマルチエージェントに不向き。 — [同上](https://www.anthropic.com/engineering/multi-agent-research-system)
- (2025-09-29)サブエージェントは探索を自分のコンテキストで行い、"returns only a condensed, distilled summary of its work (often 1,000-2,000 tokens)." この記事は「サブエージェントに何を渡すか」の指針は述べていない(返す側の要約のみ)。 — [Anthropic, Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- (Claude Code 公式ドキュメント、2026-11 取得)"Each subagent starts with a fresh, isolated context window. It doesn't see your conversation history, the skills you've already invoked, or the files Claude has already read. Claude composes a delegation message that summarizes the task, and the subagent works from there." 例外は fork(親の会話を引き継ぐ)。親に効いている規則をサブエージェントに効かせるには委譲プロンプトに書き直す必要がある: "restate it in the prompt you give Claude when delegating." — [Claude Code Docs, Subagents](https://code.claude.com/docs/en/sub-agents)
- (同)使い分け: 検索結果やログで親の会話が埋まる副作業はサブエージェント、"Latency matters" のときは親の会話で行う("A subagent that isn't a fork starts fresh and may need time to gather context")。 — [同上](https://code.claude.com/docs/en/sub-agents)
- (同)再開: "Resumed subagents retain their full conversation history, including all previous tool calls, results, and reasoning." — [同上](https://code.claude.com/docs/en/sub-agents)

**Cognition**
- (2025-06-12、Walden Yan)原則 1: "Share context, and share full agent traces, not just individual messages"。原則 2: "Actions carry implicit decisions, and conflicting decisions carry bad results"。 — [Cognition, Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents)
- (同)情報が落ちる理由: "most real-world tasks have many layers of nuance that all have the potential to be miscommunicated." 会話は "most likely multi-turn" で "any number of details could have consequences on the interpretation of the task." — [同上](https://cognition.com/blog/dont-build-multi-agents)
- (同)許容される形として Claude Code のサブタスクを挙げる: "the subtask agent is usually only tasked with answering a question, not writing any code." 利点は "all the subagent's investigative work does not need to remain in the history of the main agent." ただし "The subtask agent lacks context from the main agent"。 — [同上](https://cognition.com/blog/dont-build-multi-agents)
- (同)代替案として履歴を "key details, events, and decisions" に圧縮する専用モデルを挙げるが "hard to get right" と述べる。 — [同上](https://cognition.com/blog/dont-build-multi-agents)

**LangChain**
- (2025-06-16、Harrison Chase)Cognition と Anthropic の記事は "actually have a lot in common" とし、"Context engineering is critical to making agentic systems work reliably." "The key insight is that read actions are inherently more parallelizable than write actions." マルチエージェントが向くのは "tasks that involve heavy parallelization"。 — [LangChain, How and when to build multi-agent systems](https://www.langchain.com/blog/how-and-when-to-build-multi-agent-systems)

**OpenAI**
- (Agents SDK ドキュメント、2026-11 取得)agents-as-tools: "By default, `Agent.as_tool()` expects an object with one string field, `input`"。親の会話は自動では渡らない: "the parent run's conversation state is not inherited automatically." 共有するには "explicitly pass the same `session` to both." 構造化入力は `parameters`(Pydantic / dataclass)、"`input_builder=...` lets you fully customize how structured tool arguments become nested agent input."、"`include_input_schema=True` includes the full JSON Schema in the generated nested input." 返り値の加工は `custom_output_extractor`。入れ子の進捗は `on_stream`。`max_turns` も指定できる。 — [OpenAI Agents SDK, Tools](https://openai.github.io/openai-agents-python/tools/)
- (同)handoffs は逆に既定で全履歴を渡す: 新しいエージェントは "the entire previous conversation history" を見る。`input_filter` で絞る。`input_type` は "model-generated metadata"(引き継ぎ理由など)用で "does not replace the next agent's main input"。履歴を要約に畳む `nest_handoff_history` は opt-in ベータ。 — [OpenAI Agents SDK, Handoffs](https://openai.github.io/openai-agents-python/handoffs/)
- (A practical guide to building agents、PDF p.16–21 を直接確認。発行日は読んだページに記載なし)"Our general recommendation is to maximize a single agent's capabilities first. More agents can provide intuitive separation of concepts, but can introduce additional complexity and overhead, so often a single agent with tools is sufficient." 分割の目安は "Complex logic" と "Tool overload"("The issue isn't solely the number of tools, but their similarity or overlap. Some implementations successfully manage more than 15 well-defined, distinct tools while others struggle with fewer than 10 overlapping tools.")。manager パターン(agents as tools)は "ideal for workflows where you only want one agent to control workflow execution and have access to the user." handoff は "transferring the latest conversation state"。 — [OpenAI, A practical guide to building agents (PDF)](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)

**情報損失の実証(検索の委譲)**
- (arXiv 2611.16526v1、2026-11-12、Ruhr University Bochum)Lost in Delegation。構成は「ツールなし / 単一エージェント+Web 検索 / 強制委譲 / 任意委譲」、モデルは Claude Sonnet 4.5・GPT-5・gpt-oss-120b・Qwen3-30B-A3B-Thinking(オーケストレーターと実行役は同一モデル)。平均正答率(カットオフ前 / 後): 単一 0.77 / 0.75、任意委譲 0.74 / 0.64、強制委譲 0.77 / 0.66。32 のモデル×データ×カットオフ条件のうち、任意委譲は 22、強制委譲は 21 で単一より悪い。最大の落差は GPT-5 のカットオフ後 GDP で 0.89 → 0.43(任意)/ 0.35(強制)。 — [Stojanovska et al., Lost in Delegation](https://arxiv.org/html/2611.16526)
- (同)失敗の中身: 実行役の取得失敗がオーケストレーターに伝わらない("This failure is not reported to the orchestrator, leading to repeated requests that encounter the same obstacle.")。オーケストレーターの書き直しがタスクを変える例(本の題名の質問が "the most notable film or short film titled exactly 'The Calamity Club'…" になり実行役が 1913 と推測)。正しい実行役の答えを却下する例。取得失敗(403)の発生率は単一 13%、委譲 17〜20%、該当項目の正答率は単一 約 73% に対し委譲 52〜54%。重複検索は単一 7%、委譲 11%。 — [同上](https://arxiv.org/html/2611.16526)
- (同)例外: Qwen3-30B は 8 条件中 6 条件で強制委譲が単一を上回った(カットオフ後 Products で 0.33 → 0.58)。 — [同上](https://arxiv.org/html/2611.16526)
- (同)試した緩和策は効果が小さい: 「アクセス不能ページを報告させる」で GPT-5 GDP は 0.43 → 0.51(任意)だが単一の 0.89 に届かず、gpt-oss は逆に低下(0.70 → 0.62)。**ユーザーの原文を実行役に渡す緩和策は試していない。** 著者は "mechanisms for selectively communicating evidence and failures" 等を今後の方向として挙げる。限界: 独立した事実質問の小規模データ、同一モデルの組のみ。 — [同上](https://arxiv.org/html/2611.16526)
- (arXiv 2503.13657、v1 2025-03-17 / v3 2025-10-26、UC Berkeley ほか)MAST: 7 フレームワーク 1,600+ トレースから 14 の失敗モードを 3 分類("system design issues" / "inter-agent misalignment" / "task verification")、注釈者間一致 κ = 0.88。 — [Cemri et al., Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657)

**クエリ書き換えそのものの害**
- (arXiv 2603.13301、2026-03-02、Adobe。プレプリント)プロンプトだけの LLM クエリ書き換えは FiQA で nDCG@10 を平均 9.0% 下げ(p<0.001)、TREC-COVID では +5.1%(多重比較補正後は限界的)、SciFact は有意差なし。害の原因: "rewriting substitutes domain-specific terms on already well-matched queries"、失敗の型は terminology drift / context injection / over-specification / over-formalization。書き換えの約 95% が語の置換を含む。書き換えるか否かのゲーティングは AUC 0.593 で「常に書き換えない」と有意差なし。推奨は never-rewriting を "the safe default for well-optimized verticals with stable jargon"。対象は密ベクトル検索・英語で、書き換え器は Ministral 8B。 — [Kotte, Not All Queries Need Rewriting](https://arxiv.org/html/2603.13301)

### Inferences
- 現行の連鎖は OpenAI のいう agents-as-tools(入力は文字列 1 個、親の会話は渡らない)に当たり、Cognition が警告する「個別メッセージだけの共有」の典型。ハンドオフ型(全履歴を渡す)にはできなくても、`ask` の入力に「ユーザーの原文」と「会話から分かっている前提」を別フィールドで渡せば、原則 1 に近づけられる。
- 2603.13301 の 4 つの失敗の型(用語のずれ・文脈の注入・過剰な限定・過剰な整形)は、チャット LLM が `ask` に渡す質問を「きれいな自然文」に直すときに起きることとほぼ同じで、下流が SaaS のキーワード検索(語の一致が効く)であるほど害が大きいと推測できる。ただし同論文は密ベクトル検索の結果であり、キーワード検索・日本語での直接の測定ではない。
- Lost in Delegation の「失敗が上流に報告されない」は、`ask` の返り値に「実行したクエリ・ソースごとのヒット数ではなく取得できた文書・失敗したソース」を構造化して含める根拠になる(本リポジトリでは不変条件 3 により未認可候補の件数は外に出せないので、返せるのは認可済みの結果に限る)。
- Qwen3-30B だけ委譲で改善した結果は、弱いモデルでは「1 コンテキストに全部載せる」負荷の方が委譲の情報損失より大きい場合があることを示唆する。ただし同一モデル同士の組でしか測っていないので、「強いフロント+弱いサブ」の組み合わせには直接は当てはまらない。

### Gaps
- Microsoft(AutoGen / Semantic Kernel / Magentic-One)の文脈受け渡しの指針は今回一次資料を確認できていない。
- Google ADK の AgentTool の説明文は取得に失敗した(`google.github.io/adk-docs` は `adk.dev` に転送され、該当節が切れていた)。「AgentTool は呼び出し元に答えを返し、sub-agent は制御を引き継ぐ」という一般的な理解は未検証のまま。
- 「ユーザーの原文をそのまま下流に渡すと精度がどれだけ戻るか」を測った公開実験は見つからなかった(Lost in Delegation も未実施と明記)。自前の ablation が必要(§5)。
- 日本語・企業内キーワード検索での書き換え劣化の定量データは見つからなかった。

## 2. 上流 LLM 向け「エージェントに聞く」ツールのスキーマ設計

### Takeaway
実在の MCP サーバーの説明文は「いつこのツールを使い、いつ別のツールを使うか」「返るもの」「遅さ」を書くところまでで、「ユーザーの言葉をそのまま渡せ」と明示している例は今回確認した範囲では Claude Code の Agent ツールのブリーフ指針だけだった。Perplexity は入力を単一の query ではなく `messages` 配列にして会話を渡せる形にしている。ツール説明の改善だけで上流モデルのクエリの癖が直った実例(Anthropic の "2025" 付加)がある。

### Cited Findings

**実際の説明文(原文)**
- Perplexity 公式 MCP(`perplexityai/modelcontextprotocol`、2026-11 取得の main)。`perplexity_ask`: "Answer a question using web-grounded AI (Perplexity Agent API, [preset] preset). Best for: quick factual questions, summaries, explanations, and general Q&A. Returns a text response with numbered citations. Fastest and cheapest option. Supports filtering by recency (hour/day/week/month/year), domain restrictions, and search token budgets. For in-depth multi-source research, use perplexity_research instead. For step-by-step reasoning and analysis, use perplexity_reason instead." — [perplexityai/modelcontextprotocol server.ts](https://raw.githubusercontent.com/perplexityai/modelcontextprotocol/main/src/server.ts)
- 同 `perplexity_research`: "Conduct deep, multi-source research on a topic (...). Best for: literature reviews, comprehensive overviews, investigative queries needing many sources. Returns a detailed response with numbered citations. Significantly slower than other tools (can take minutes). For quick factual questions, use perplexity_ask instead. ..." 入力は `messages` のみ。 — [同上](https://raw.githubusercontent.com/perplexityai/modelcontextprotocol/main/src/server.ts)
- 同: ask / reason / research の入力は query 文字列ではなく `messages`("Array of conversation messages"、各要素は `role` = system / user / assistant と `content`)。ask と reason には `search_recency_filter`("Filter search results by recency. Use 'hour' for very recent news, 'day' for today's updates, 'week' for this week, etc.")と `search_domain_filter` がある。 — [同上](https://raw.githubusercontent.com/perplexityai/modelcontextprotocol/main/src/server.ts)
- 同 `perplexity_search`(合成なしの生検索を並置): "Search the web and return a ranked list of results with titles, URLs, snippets, and dates. ... Returns formatted results (title, URL, snippet, date) with no AI synthesis. ... For AI-generated answers with citations, use perplexity_ask instead." `query` は "Search query string"。`search_type` の説明は "'fast' is lower latency and lower cost; prefer it for routine lookups inside agent loops, and keep 'web' for rare or ambiguous questions." — [同上](https://raw.githubusercontent.com/perplexityai/modelcontextprotocol/main/src/server.ts)
- Exa MCP(2026-11 取得の README)。既定は `web_search_exa`("Search the web for any topic and get clean, ready-to-use content")と `web_fetch_exa`。エージェント型は任意有効の `agent_run`("Run an Exa Agent for multi-step research, list-building, enrichment, and structured output")。README には `deep_researcher_start` / `deep_researcher_check` の記載は無かった(名称が変わった可能性)。 — [exa-labs/exa-mcp-server README](https://raw.githubusercontent.com/exa-labs/exa-mcp-server/main/README.md)
- Glean MCP: 既定サーバーは検索・チャット・文書読み取り(`glean_search` / `chat` / `read_document`)を持つと文書にあるが、ホストに見える説明文そのものは公開文書から確認できなかった。Glean の指針は利用者側のプロンプトに関するもの: "Hosts choose which tools to call, so name the data or action you want when you test."(例 "Search Glean for our engineering onboarding guide.") — [Glean Developers, MCP guide](https://developers.glean.com/guides/mcp)、[Glean Docs, About Glean MCP server](https://docs.glean.com/administration/platform/mcp/about)
- Claude Code の Agent ツールのプロンプト(非公式ミラー。npm 配布物からの抽出とされ、版により文言が違う可能性あり): "When spawning a fresh agent (with a `subagent_type`), it starts with zero context." / "Brief the agent like a smart colleague who just walked into the room" / "it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters." / "Explain what you're trying to accomplish and why." / "Describe what you've already learned or ruled out." / "Give enough context about the surrounding problem that the agent can make judgment calls" / "For fresh agents, terse command-style prompts produce shallow, generic work." / "**Never delegate understanding.**" / "Lookups: hand over the exact command. Investigations: hand over the question" / "The result returned by the agent is not visible to the user." — [claude-code-sourcemap ミラー, Agent system prompt](https://claude-code-sourcemap-site.pages.dev/prompts/09-agent-system/en)(同種の抽出: [Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts))

**ツール説明の書き方(Anthropic、2025-09-11)**
- "think of how you would describe your tool to a new hire on your team"、"input parameters should be unambiguously named"(例: `user` ではなく `user_id`)。 — [Anthropic, Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- 説明文で上流モデルのクエリの癖を直した実例: "Claude was needlessly appending `2025` to the tool's `query` parameter, biasing search results and degrading performance" → "we steered Claude in the right direction by improving the tool description"。 — [同上](https://www.anthropic.com/engineering/writing-tools-for-agents)
- 返り値: "exposing a simple `response_format` enum parameter in your tool"(concise / detailed)、エラーは "prompt-engineer your error responses to clearly communicate specific and actionable improvements"。 — [同上](https://www.anthropic.com/engineering/writing-tools-for-agents)
- (2025-06-13)"Bad tool descriptions can send agents down completely wrong paths." — [Anthropic, multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)

**使える MCP の機能(仕様 2025-11-25)**
- Elicitation: サーバーがクライアント経由でユーザーに追加情報を求める。"enabling user input requests to occur *nested* inside other MCP server features." form モードのスキーマは "limited to flat objects with primitive properties only"(string / number / boolean / enum)。応答は accept / decline / cancel。クライアントが `elicitation` capability を宣言している場合のみ送れる("Servers **MUST NOT** send elicitation requests with modes that are not supported by the client.")。 — [MCP Spec 2025-11-25, Elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)
- 構造化出力: "**Structured** content is returned as a JSON object in the `structuredContent` field of a result." 後方互換のため "SHOULD also return the serialized JSON in a TextContent block." `outputSchema` があればサーバーは準拠必須。ツール結果に `resource_link` を返せる。コンテンツ注釈で `audience`(user / assistant)を付けられる。 — [MCP Spec 2025-11-25, Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- エラー: "**Tool Execution Errors** contain actionable feedback that language models can use to self-correct and retry with adjusted parameters." 入力検証エラーはプロトコルエラーではなくツール実行エラー(`isError: true`)で返す。 — [同上](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- 2025-11-25 版の主な追加: sampling のツール呼び出し対応("Add tool calling support to sampling via `tools` and `toolChoice` parameters")、実験的な tasks("tracking durable requests with polling and deferred result retrieval")、URL モードの elicitation、ツールごとの `execution.taskSupport`。 — [MCP Spec 2025-11-25, Key Changes](https://modelcontextprotocol.io/specification/2025-11-25/changelog)

### Inferences
- `ask` の入力スキーマ案(各社の実例と指針からの組み立て。そのまま実証された形ではない): `user_message_verbatim`(ユーザーの直近の発話を一字一句)、`conversation_context`(会話から分かっている前提・既に試したこと)、`must_keep_terms`(固有名詞・ID・エラー文字列をそのまま)、`time_range`、`sources`(enum)、`response_format`。パラメータ名に verbatim を入れるのは Anthropic の「曖昧でない名前」の指針に沿う。Perplexity の `messages` 配列は「会話をそのまま渡す」別解。
- 説明文には「翻訳・要約・言い換えをしない。固有名詞と識別子は原文の表記のまま」「いつ `ask` でなく生の `search` を使うか」「所要時間」を書く。"2025" の例から、説明文の変更だけで上流モデルの引数の癖は変えられる見込みがあるが、LibreChat 側のモデルが弱い場合に従うかは未検証で、評価で確かめる必要がある(§5 のホップ別 ablation)。
- 上流モデルが従わなくても損失を抑える保険として、サーバー側で `user_message_verbatim` を検索クエリ候補の 1 つとして必ず機械的に流す(§3 の決定的ファンアウト)設計が考えられる。
- Elicitation は「証拠不足のときサブエージェントがユーザーに聞き返す」正規の経路だが、クライアントの capability に依存する。LibreChat の対応状況は未確認。非対応なら「聞き返しの質問を結果として返し、上流 LLM に尋ねさせる」形になる。
- 本リポジトリ固有の制約: `user_message_verbatim` や会話文脈を `ask` が受け取ると、監査ログ・生クエリ表に書く対象が増える(ADR-019、Slack 有効時の生クエリの未決事項に関係)。スキーマ変更の前に扱いを決める必要がある。

### Gaps
- Atlassian Rovo MCP、Tavily、Firecrawl deep research、OpenAI deep research MCP(`search` / `fetch` 規約)の説明文は今回取得していない。
- Glean の `chat` / `search` の説明文字列は公開文書からは得られなかった(接続したホストの tools/list で確認するしかない)。
- Exa の旧 `deep_researcher_*` ツールの説明文は現行 README に無く、未確認。
- MCP サーバーの `instructions`(initialize 応答)と progress 通知については仕様ページを今回取得しておらず、引用なし。MCP 仕様 2026-07-28 版(ステートレス)での elicitation / sampling / tasks の扱いも未確認(本リポジトリは同版を設計前提としているので要確認)。
- 「ユーザー原文フィールドを設けると上流モデルが実際に原文を入れるか」の公開測定は見つからなかった。

## 3. 入れ子エージェント以外のアーキテクチャ案

### Takeaway
OpenAI・実務者の既定は「まず単一エージェント+ツールを使い切る」で、サブエージェントは親のコンテキストが検索ノイズで埋まることが測定上の問題になってから足す。検索の委譲はフロンティアモデルでも単一エージェントに負ける条件が多い一方、約 30B 級のモデルでは委譲が有利な条件もあった。弱いモデル向けの「万能の足場」は実証されておらず(計画→実行→提出の分解プロンプトは試した全モデルで悪化)、介入はモデルごとに効き方が違う。

### Cited Findings
- 単一エージェント優先: "maximize a single agent's capabilities first ... often a single agent with tools is sufficient." ツール数より重複が問題("more than 15 well-defined, distinct tools" を扱える実装もある)。 — [OpenAI, A practical guide to building agents (PDF)](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)
- 合成つき(ask)と合成なし(search)を同じサーバーに並べ、説明文で使い分けを誘導する実例(案 (d) に相当): Perplexity の `perplexity_search`("no AI synthesis")と `perplexity_ask`。Exa も既定は生の検索・取得で、エージェント型は任意。Glean も search / chat / read_document を併置。 — [perplexityai/modelcontextprotocol](https://raw.githubusercontent.com/perplexityai/modelcontextprotocol/main/src/server.ts)、[exa-mcp-server README](https://raw.githubusercontent.com/exa-labs/exa-mcp-server/main/README.md)、[Glean Docs](https://docs.glean.com/administration/platform/mcp/about)
- 単一 vs 委譲の実測(検索): 単一 0.77 / 0.75、任意委譲 0.74 / 0.64、強制委譲 0.77 / 0.66。単一エージェントの検索予算は 2n 回検索・3n 回ページ取得、実行役は各 2 回検索・3 回取得。Qwen3-30B は 8 条件中 6 条件で強制委譲が優位。 — [Lost in Delegation](https://arxiv.org/html/2611.16526)
- コスト: エージェントはチャットの約 4 倍、"multi-agent systems use about 15× more tokens than chats." 一方、内部評価では主 Opus 4+副 Sonnet 4 の構成が "outperformed single-agent Claude Opus 4 by 90.2% on our internal research eval."(幅優先の調査タスク。強モデル依存) — [Anthropic, multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- コンテキスト分離の利点と遅延: サブエージェントは "Preserve context by keeping exploration and implementation out of your main conversation"、ただし遅延が重要なら親で行う。 — [Claude Code Docs, Subagents](https://code.claude.com/docs/en/sub-agents)
- 小型オープンモデルの実力(arXiv 2605.00334、2026-05-01、Harvard ほか。プレプリント、30 タスクの合成ベンチ): 0.27B〜32B の 16 モデルと GPT-5 を比較。gemma4:26b と GPT-5 は総合で同等(差 +0.4 pp、90% CI [−4.0, +5.1])。段階別では短い構造化ツール利用(A0 / A)は 100%、段階 B は 73.3% vs 82.2%、C は 53.3% vs 51.1%、D は 40.0% vs 42.2%、長期計画の E は 0% vs 10.2%。"Small and mid-sized open-weight models are already sufficient for much of the short-horizon, structured tool use work"、"The gap appears most clearly on long-horizon planning tasks." — [Karmakar & Chatterjee, AgentFloor](https://arxiv.org/html/2605.00334)
- (同)足場の効果: 計画 / 実行 / 提出の分解プロンプトは "The data go the other way on every model in the sweep."(試した 4 モデル全てで悪化、ministral-3:8b は −33 pp)。効いた介入はモデル固有("each effective intervention we tested helped one model and was null on others")。例: 明示的な提出指示で ministral-3:8b の E1 が 0/5 → 5/5、推論の無効化は Qwen3 32B の段階 B に効くが 8B / 14B では悪化。 — [同上](https://arxiv.org/html/2605.00334)
- 実務者ブログ(二次情報・測定方法不明、参考程度): 「単一エージェントから始め、コンテキストが律速になったらサブエージェントを足す」「返るのは最終テキストだけで、途中の検索は失われる」。 — [Beer and Code, Subagents: isolate context](https://blog.beerandcode.com.br/en/tutorials/subagents-context-isolation)、[DEV, Single agent vs multi-agent](https://dev.to/joancomadran/single-agent-vs-multi-agent-when-subagents-are-worth-it-5146)

### Inferences
- 4 案の整理(引用した証拠からの推論):
  - (a) 生の `search` / `fetch` をフロント LLM に直接見せる: ホップが 1 つ減り、ユーザーの言葉とクエリの距離が最短。フロントが強いモデルで、コネクタ数が少なく説明文が重ならないなら第一候補(OpenAI の指針、Lost in Delegation)。欠点は検索結果がチャットのコンテキストを埋めること、フロントが弱いモデルだと検索構文を誤ること、引用の検証や run 単位の監査をサーバー側で握れないこと。
  - (b) 薄いルーター+決定的ファンアウト: LLM に任せるのは「キーワード抽出」程度の短い構造化作業にとどめ、原文クエリ・抽出キーワード・ソース別の構文変換をコードで並列に流す。AgentFloor の「短い構造化ツール利用は小型モデルで足りる、長期計画は足りない」に最も合う。ただし同論文は検索品質ではなくツール操作の合成ベンチであり、検索で決定的ファンアウトが優位という直接の実証ではない。
  - (c) 入れ子エージェント+厚いブリーフ: 現行の延長。§1・§2 の対策(原文・文脈・固有語の受け渡し、失敗の報告、証拠の返却)が前提。フロントのコンテキスト節約とサーバー側での引用検証・監査の利点は残る。
  - (d) 併置(`ask` と直接 `search`): Perplexity / Exa / Glean が採る形。既知項目検索(キーワードで足りる)は `search`、複数文書の統合は `ask` と説明文で分ける。ツールの重複は誤選択を招く(OpenAI)ので、使い分けを説明文に書く必要がある。
- 「サブエージェントが約 27B のローカルモデル」という条件では、自由な ReAct ループの 3 ターンより、(b) の決定的な初手(原文そのまま+抽出キーワード)を必ず実行し、その後に限定的なエージェントループを置く混成が妥当と推測する。根拠は AgentFloor(段階 B〜C で 5〜7 割)と書き換え劣化(2603.13301)の組み合わせで、検索タスクでの直接比較ではない。
- AgentFloor の「分解プロンプトは全モデルで悪化」は、弱いモデルには「プロンプトで手順を縛る」より「コードで手順を固定する」方が安全という解釈と整合するが、同論文はコード側の固定を比較していない。
- 本リポジトリでは (a) / (d) でもソースアクセスは Gateway 経由(不変条件 2)のままにできる。変わるのは AnswerRun(run API)と引用検証の扱いで、Orchestrator を通らない検索は run に紐づかない。

### Gaps
- フロント強・サブ弱(またはその逆)の異種モデルの組での検索委譲の測定は見つからなかった(Lost in Delegation は同一モデルのみと限界に明記)。
- 「固定のクエリ生成ステップ / 構造化出力 / プログラムによるファンアウト」が弱いモデルの検索品質を上げるという直接の比較実験は見つからなかった。
- 検索結果に出た「推論トークン予算を固定すると単一エージェントが多段推論でマルチエージェントと同等以上(2026-04 の論文)」は二次情報のみで原典未確認。 — [FlowHunt の紹介記事](https://www.flowhunt.io/blog/multi-agent-ai-system/)
- Anthropic "Building effective agents"(workflow と agent の区別、最も単純な解から始める)は今回取得しておらず引用なし。

## 4. ターン予算と停止条件

### Takeaway
公開されている目安は「単純な事実確認は 1 エージェントで 3〜10 回のツール呼び出し」で、固定の小さな上限ではなく質問の複雑さに応じて増やす。並列呼び出しが時間短縮の主手段。証拠が足りないときに答えてしまう傾向は強いモデルにもあり、「十分な文脈か」の判定を別に置いて棄権・聞き返しに回すと正答率が上がる。

### Cited Findings
- 努力量の目安(プロンプトに埋め込む規則): 単純な事実確認は "just 1 agent with 3-10 tool calls."、複雑な調査は "more than 10 subagents with clearly divided responsibilities."(強モデル・Web 調査での値) — [Anthropic, multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- 検索戦略: "start with short, broad queries" から絞り込む。 — [同上](https://www.anthropic.com/engineering/multi-agent-research-system)
- 並列化: "the lead agent spins up 3-5 subagents in parallel rather than serially." ツールの並列呼び出しと合わせ "cut research time by up to 90% for complex queries." — [同上](https://www.anthropic.com/engineering/multi-agent-research-system)
- run の終了条件の一般形: "Common exit conditions include tool calls, a certain structured output, errors, or reaching a maximum number of turns." — [OpenAI, A practical guide to building agents (PDF) p.14](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)
- 探索の深さを呼び出し側が指定する例: Claude Code の Explore は "**quick** for targeted lookups, **medium** for balanced exploration, or **very thorough** for comprehensive analysis." — [Claude Code Docs, Subagents](https://code.claude.com/docs/en/sub-agents)
- 速さの段を引数で分ける例: Perplexity は ask("Fastest and cheapest option")と research("Significantly slower than other tools (can take minutes)")を別ツールにし、search に `search_type: fast` を持つ。 — [perplexityai/modelcontextprotocol](https://raw.githubusercontent.com/perplexityai/modelcontextprotocol/main/src/server.ts)
- 予算を増やしても効くとは限らない: ステップ予算の倍増は GPT-5 の 1 タスクにしか効かなかった。 — [AgentFloor](https://arxiv.org/html/2605.00334)
- 委譲時の予算の実例: 実行役 1 体あたり検索 2 回・ページ取得 3 回。委譲では重複検索が増え(7% → 11%)、「重複を避けよ」という指示はほぼ無効(Qwen 19.4% → 17.7%、GPT-5 は 4.4% → 6.6% に増加)。 — [Lost in Delegation](https://arxiv.org/html/2611.16526)
- Sufficient Context(arXiv 2411.06037、v1 2024-11-09 / v3 2025-04-23、Google。ICLR 2025): 定義は "if it contains all the necessary information to provide a definitive answer to the query"。大きいモデル(Gemini 1.5 Pro、GPT-4o、Claude 3.5)は文脈が不十分なとき "often output incorrect answers instead of abstaining"、小さいモデル(Mistral 3、Gemma 2)は "hallucinate or abstain often, even with sufficient context."。選択的生成で応答中の正答割合が "2--10% for Gemini, GPT, and Gemma" 改善。 — [Joren et al., Sufficient Context](https://arxiv.org/abs/2411.06037)
- (2025-05-14、Google Research ブログ)十分性の自動判定は "at least 93% of the time" 正しい。不十分な文脈は無文脈より悪い場合がある: "Gemma goes from providing incorrect answers on 10.2% of questions with no context up to 66.1%"。 — [Google Research, The role of sufficient context](https://research.google/blog/deeper-insights-into-retrieval-augmented-generation-the-role-of-sufficient-context/)
- 答えられない質問での停止は現行モデルでも弱い(検索結果の要約のみ・原典未読): HopRefusalBench(2026、889 問)で最良モデルの target-aware な正しい停止率は 42.9%、結末の分類は target-aware refusal / pseudorefusal / hallucinated completion / search-budget exhaustion。 — [HopRefusalBench](https://arxiv.org/html/2608.01358)
- ユーザーへの聞き返しの経路: MCP elicitation(ツール呼び出しの中に入れ子で発生できる)。長時間処理は tasks(実験的、ポーリングと遅延取得)。 — [MCP Spec, Elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)、[MCP Spec, Key Changes](https://modelcontextprotocol.io/specification/2025-11-25/changelog)

### Inferences
- 現行の「約 3 ターン」は Anthropic の単純質問の目安(3〜10 回)の下端。ターン数より「1 ターンで何本のクエリを並列に出すか」を増やす方が、対話用途の時間上限とローカルモデルの直列の遅さの両方に合う(ターン = LLM 推論 1 回、検索は並列)。
- 停止判定はエージェント任せにせず、「取得した文書だけで質問に答えられるか」を判定する独立した 1 回の LLM 呼び出し(十分 / 不十分 / 不足している情報)を置き、不十分なら「見つかった範囲+不足点+試したクエリ」を返す設計が Sufficient Context と整合する。小さいモデルは十分な文脈でも棄権・誤答が多いという結果があるので、判定の精度は自前の評価で確かめる(§5 の答えられない質問セット)。
- 呼び出し側が深さを選ぶ引数(quick / thorough)は実例が複数あり、固定上限と動的予算の中間として実装が軽い。

### Gaps
- 対話用途での時間上限の具体値や、進捗通知が待ち時間の許容に与える効果を測った資料は見つからなかった。MCP の progress 通知の仕様ページは今回未取得。
- 弱いモデルでの最適ターン数の実証はない(AgentFloor の予算倍増の結果は検索タスクではない)。
- HopRefusalBench は検索結果の要約のみで、数値の原典確認はしていない。

## 5. エージェント検索の評価と観測

### Takeaway
各社の実務指針は「実際の失敗から 20〜50 件で始める」「トレースを読んで最初の上流の失敗を分類する(誤り分析)」「検索は IR 指標で先に切り分け、回答は検証済みの LLM 判定で二値評価」「答えられる / 答えられないの両側を入れる」で一致している。ホップごとの損失を測る公開の標準手法は見つからず、遷移失敗行列と oracle クエリの ablation を自前で組むのが現実的。

### Cited Findings

**始め方と評価セット**
- (2025-06-13)"started with a set of about 20 queries representing real usage patterns." LLM 判定は "a single LLM call with a single prompt outputting scores from 0.0-1.0 and a pass-fail grade" が最も安定、観点は factual accuracy / citation accuracy / completeness / source quality / tool efficiency。人手評価も必要("People testing agents find edge cases that evals miss.")。 — [Anthropic, multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- (2026-01-09)"20-50 simple tasks drawn from real failures is a great start." 両側を入れる: "Test both the cases where a behavior should occur and where it shouldn't." / "One-sided evals create one-sided optimization." 経路ではなく結果を採点: "it's often better to grade what the agent produced, not the path it took." — [Anthropic, Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- (同)調査・検索エージェント向けの採点: "Groundedness checks verify that claims are supported by retrieved sources" / "coverage checks define key facts a good answer must include" / "source quality checks confirm the consulted sources are authoritative" / "LLM-based rubrics should be frequently calibrated against expert human judgment"。 — [同上](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- (同)能力評価と回帰評価の区別: 能力評価は "should start at a low pass rate"、回帰評価は "should have a nearly 100% pass rate"。非決定性は試行を繰り返して pass@k("at least one correct solution in k attempts")と pass^k("all k trials succeed")で見る。飽和: "Eval saturation occurs when an agent passes all of the solvable tasks"。 — [同上](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- (2025-06-16)"Start small with evals, even ~20 datapoints is enough" — [LangChain, How and when to build multi-agent systems](https://www.langchain.com/blog/how-and-when-to-build-multi-agent-systems)
- 検索評価用の組の合成: "Generate this synthetically by taking documents from your corpus, extracting key facts" "then generating questions those facts would answer." "This reverse process gives you query-document pairs for measuring retrieval performance without manual annotation." 合成データの限界: "Synthetic data cannot tell you how common a failure is in production." 生成は次元(dimensions)を決めて構造化する。 — [Hamel Husain & Shreya Shankar, AI Evals FAQ(2026-09-18 版)](https://hamel.dev/blog/posts/evals-faq/)
- ツール評価の作り方(2025-09-11): 課題は "inspired by real-world uses and be based on realistic data sources and services"、過学習防止に "held-out test sets"。 — [Anthropic, Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- 企業内検索のベンチの参考(検索結果の要約のみ・原典未読): HERB(EMNLP 2025 Industry、企業内の異種データ 39,190 件、答えられない質問 699 件を含む)。最良のエージェント型 RAG でも平均スコア 32.96 と報告。 — [Benchmarking Deep Search over Heterogeneous Enterprise Data](https://aclanthology.org/2025.emnlp-industry.34/)

**指標**
- 検索を先に切り分ける: "Recall@k (of all relevant documents, how many did you retrieve in the top k?)"、"Precision@k"、"MRR (how high up was the first relevant document?)"。"debug retrieval first using IR metrics, then tackle generation quality using properly validated LLM judges." — [Hamel & Shankar, FAQ](https://hamel.dev/blog/posts/evals-faq/)
- 二値で採点: "Binary evaluations force clearer thinking and more consistent labeling." LLM 判定は人手ラベルに対する TPR / TNR で検証する。汎用指標への警告: "Generic evaluations waste time and create false confidence when you use them as quality measures."(トレースの選別には使える) — [同上](https://hamel.dev/blog/posts/evals-faq/)
- 収集する運用指標: "the total number of tool calls, the total token consumption, and tool errors"、"the total runtime of individual tool calls and tasks"。 — [Anthropic, Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- 委譲の研究が使った観測量(トレースから取れる): 連続クエリ対の重複率、取得失敗率と該当項目の正答率、再委譲率、実行役の答えへの異議率。 — [Lost in Delegation](https://arxiv.org/html/2611.16526)
- 書き換えの診断量: 書き換え前後での正解文書との語彙の重なりの変化、置換率。 — [Not All Queries Need Rewriting](https://arxiv.org/html/2603.13301)

**トレースの誤り分析**
- "Error analysis is **the most important activity in evals**." 自由記述(open coding)→ 失敗分類に整理(axial coding、"the most important step")、"We recommend reviewing at least 100 traces." 新しい失敗の型が出なくなるまで続ける。 — [Hamel & Shankar, FAQ](https://hamel.dev/blog/posts/evals-faq/)
- 多段のトレースは最初の上流の失敗だけを注釈する: "Look at the entire trace and focus on the first upstream failure." "Downstream failures often cascade from the first issue"。 — [同上](https://hamel.dev/blog/posts/evals-faq/)
- エージェントの評価の順序: まず "Treat the agent as a black box and decide whether it met the user's goal."、次に段階別の診断("Tool choice"、"Parameter extraction: check whether the inputs were complete and well-formed.")。遷移失敗行列: "Create a matrix where rows represent the last successful state and columns represent where the first failure occurred." "Early stage improvements have more impact since errors cascade in LLM chains." — [同上](https://hamel.dev/blog/posts/evals-faq/)
- 引き継ぎ境界: "Many failures occur at handoff boundaries where AI hands off too early, too late, or without proper context." "Sometimes the best improvement reduces handoffs entirely rather than improving handoff execution."(原文は人への引き継ぎの文脈) — [同上](https://hamel.dev/blog/posts/evals-faq/)
- トレースの読み方: "Review the raw transcripts (including tool calls and tool responses)"、"You won't know if your graders are working well unless you read the transcripts and grades from many trials." 本番トレース: "Adding full production tracing let us diagnose why agents failed and fix issues systematically." — [Anthropic, Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents)、[Anthropic, Demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)、[Anthropic, multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- 既成の失敗分類: MAST の 3 分類・14 モード(system design issues / inter-agent misalignment / task verification)。 — [Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657)

### Inferences
- ホップ別 ablation の設計案(公開の標準手法は無く、上記の原則からの組み立て)。同じ質問セット・同じ正解文書で、最終ホップ(SaaS 検索)に入るクエリだけを差し替えて recall@k を比べる:
  1. 人が書いたキーワード(oracle / 直接入力の基準。オーナーの「直接打った方が良い」の定量化)
  2. ユーザー原文をそのまま検索に投入
  3. ユーザー原文を Orchestrator に直接渡して出たクエリ(フロントのホップを除外)
  4. フロント LLM が `ask` に渡した質問を Orchestrator に渡して出たクエリ(現行)
  1−3 が Orchestrator のクエリ生成の損失、3−4 がフロント → `ask` のホップの損失。4 の入力はチャット UI での実走ログ(`ask` の引数)から採る。
- 遷移失敗行列の状態は、この連鎖では「フロントが `ask` を呼んだ → 引数に固有語が残っている → 正しいソースを選んだ → クエリが 1 件以上ヒット → 正解文書が上位 k に入った → 正解文書を fetch した → 回答が正解文書に基づく → 引用が正しい」と置ける。依頼文にある失敗分類(ソース違い、構文誤り、語彙の不一致、早すぎる打ち切り、取得したが読まず、誤読)は各遷移の失敗に対応する。
- 評価セットは 3 種を分けて持つ: 既知項目(題名・ID・固有語で 1 文書に当たる。recall@k と MRR)、複数文書(coverage の要点リスト。本リポジトリの v3 プロンプトの不合格はここに集中)、答えられない質問(正しい棄権を二値で採点。HERB・HopRefusalBench が同種の区分を採る)。Anthropic の「両側を入れる」に対応。
- 追加で追うと有用な運用指標(引用元の観測量からの類推): ゼロ件率、クエリの言い換え再試行率、連続クエリの重複率、`ask` の引数とユーザー原文の語彙の重なり(固有語の保持率)、run あたりのツール呼び出し数と所要時間。
- 本リポジトリの制約との関係: 語彙の重なりやクエリ列の分析には生クエリが必要で、生クエリ表の保持期間と Slack 有効時の扱い(未決事項)に依存する。未認可候補の件数は評価・メトリクスにも出せない(不変条件 3)ので、ゼロ件率は「認可済み結果が 0 件」として定義する必要がある。合成コーパスでの dev-eval ならこの制約は緩い。
- ローカルモデルは非決定性と品質のばらつきが大きいので、同一質問の複数回試行(本リポジトリは既に 20 問 × 2 回)と pass^k の併記が妥当。

### Gaps
- RAGAS、TREC RAG(2024〜2026 のトラック)、LangSmith / Braintrust の評価ガイドは今回一次資料を取得しておらず引用なし。citation precision / faithfulness の定義(原子的主張単位の支持判定など)を採る場合は別途確認が必要。
- 「フロント → オーケストレーターのホップでの損失」を分離して測った公開事例は見つからなかった。
- 企業内・日本語・キーワード検索バックエンドでのエージェント検索評価の公開データは見つからなかった。
- HERB の数値は検索結果の要約に基づき、原典未確認。
