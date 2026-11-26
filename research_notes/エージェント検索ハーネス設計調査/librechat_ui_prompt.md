# LibreChat が UI 側 LLM に渡す入力(v0.8.7、リファレンス構成の場合)

調査日: 2026-11-26。目的は比較実験 `dev-search-eval` の条件 4(利用者の発言 → UI 側 LLM → 探索 LLM(`ask`)→ search)の
UI 側 LLM への入力を、実際の LibreChat の組み立てに合わせること(T-027)。

## 調べた版と取得方法

- このリポジトリのリファレンス構成(`deploy/compose/docker-compose.librechat.yml`)のイメージは
  `ghcr.io/librechat-ai/librechat:v0.8.7`(タグ固定)。`deploy/compose/librechat/librechat.yaml` は設定の version 1.3.13
- LibreChat 本体: `git clone --depth 1 --branch v0.8.7 https://github.com/danny-avila/LibreChat`。
  コミット **9e74cc0e57b395926122bd4062c1fcedc48ed465**(2026-06-24)。以下のパスはこのコミットのもの
- `@librechat/agents`: LibreChat v0.8.7 の `package-lock.json` が固定する **3.2.46**。npm の tarball
  (`https://registry.npmjs.org/@librechat/agents/-/agents-3.2.46.tgz`)を取得し、lockfile の integrity
  (`sha512-ppylwuFF3BOl...`)と一致することを確かめた。tarball の `src/` を読んだ
- 取得物は読むだけで、スクリプト・ビルド・テストは実行していない。**LibreChat を実際に動かしての確認はしていない**
  (以下の「確かめられたこと」はすべてソースコードを読んだ結果)

## リファレンス構成の設定(このリポジトリ)

`deploy/compose/librechat/librechat.yaml` の要点:

- MCP サーバー `leisen`: `type: streamable-http`、`url: http://orchestrator:8790/mcp`、
  `headers.Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}'`、`requiresOAuth: false`、**`startup: false`**、
  `timeout: 300000`、**`serverInstructions: true`**
- エンドポイント: `custom` に `LM Studio`(OpenAI 互換)だけ。`modelSpecs`・プリセット・`memory` の設定はない
- `endpoints.agents.capabilities`: `deferred_tools, file_search, artifacts, subagents, context, skills, tools, chain, ocr`
- 利用者の操作(`docs/ui-librechat.md` §1 の 4・5): エンドポイント「LM Studio」とモデルを選び、入力欄の下の
  MCP サーバーの選択から Leisen を選ぶ(通常の会話。内部ではエフェメラルなエージェントとして動く)

## 確かめられたこと

### 1. ツールの名前・説明・スキーマ

- 名前は `<MCP のツール名>_mcp_<サーバー名>`。リファレンス構成では **`ask_mcp_leisen`** と **`feedback_mcp_leisen`**
  - 区切り文字: `packages/data-provider/src/config.ts:2540` `mcp_delimiter = '_mcp_',`
  - 組み立て: `packages/api/src/mcp/registry/MCPServerInspector.ts:178`
    `` const name = `${tool.name}${Constants.mcp_delimiter}${serverName}`; ``
  - サーバー名は `librechat.yaml` の `mcpServers` のキー(`leisen`)。ツールのインスタンスを作る経路では
    `normalizeServerName`(`packages/api/src/mcp/utils.ts:337`、`^[a-zA-Z0-9_.-]+$` に合わない文字を `_` に置き換える)
    を通すが、`leisen` は変わらない
- 説明は MCP の `tools/list` の `description` をそのまま使う。切り詰め・加工はない
  (`MCPServerInspector.ts:183` `description: tool.description,`、`packages/api/src/tools/definitions.ts:176`
  `description: toolDef.function.description || undefined,`、`api/server/services/MCP.js:885` `description: description || '',`)。
  MCP の `title` はツール定義に入らない
- スキーマは MCP の `inputSchema` を `resolveJsonSchemaRefs` → `normalizeJsonSchema` にかけたもの
  (`packages/api/src/tools/definitions.ts` の `buildMcpParameters`、`api/server/services/MCP.js:748`)。
  `normalizeJsonSchema`(`packages/api/src/mcp/zod.ts:262`)が変えるのは `x-` で始まるキーの削除、`$defs` / `definitions` の削除、
  `const` → `enum` だけ。`ask` の inputSchema はどれも含まないので、**そのまま渡る**。Google / Vertex のときだけ
  `sanitizeGeminiSchema` がかかる(リファレンス構成では使わない)
- `outputSchema` は LLM に渡らない(`getToolFunctions` は `inputSchema` だけを `parameters` にする)
- ツールの順は MCP の `tools/list` の順(`Object.entries` の順)。`deferred_tools` の能力は有効だが、遅延読み込みは
  エージェントの設定でツールごとに `defer_loading` を付けたときだけ(`packages/api/src/tools/classification.ts:71`)。
  通常の会話(エフェメラルなエージェント)では付かないので、`ask_mcp_leisen` はそのまま LLM に渡る

### 2. MCP の `instructions` の扱い

- 組み立て(`packages/api/src/mcp/MCPManager.ts:305-331` `formatInstructionsForContext`)の全文:

  ```
  # MCP Server Instructions

  The following MCP servers are available with their specific instructions:

  ## ${serverName} MCP Server Instructions

  ${instructions}

  Please follow these instructions when using tools from the respective MCP servers.
  ```

  サーバーが複数なら `## … MCP Server Instructions` の節を `\n\n` でつなぐ。対象は、会話で選んだ MCP サーバー
  (`ephemeralAgent.mcp`)またはエージェントのツール名に `_mcp_` を含むサーバー(`packages/api/src/agents/context.ts:160`)
- `${instructions}` は、そのサーバーの設定の `serverInstructions` の値(`MCPManager.ts:292-293`
  `if (config.serverInstructions != null) { instructions[serverName] = config.serverInstructions as string; }`)
- `serverInstructions: true` のとき、サーバーの `initialize` の `instructions` で置き換えるのは、起動時の検査
  (`MCPServerInspector.inspectServer`)だけ(`MCPServerInspector.ts:144-148`
  `if (isEnabled(this.config.serverInstructions)) { this.config.serverInstructions = this.connection!.client.getInstructions(); }`)。
  その検査は次の条件のときだけ接続する(`MCPServerInspector.ts:75-81`):
  `this.config.startup !== false && !this.config.requiresOAuth && !hasCustomUserVars(this.config) && !hasRuntimeContextPlaceholders(this.config) && !this.config.obo`
- **リファレンス構成は `startup: false` で、ヘッダに `{{LIBRECHAT_OPENID_ACCESS_TOKEN}}`(実行時のプレースホルダ)を持つため、
  起動時の検査は接続せず、`serverInstructions` は真偽値の `true` のまま残る。** `serverInstructions` を書き換える箇所は
  この 1 か所だけで(`grep` で `getInstructions()` / `serverInstructions =` を `api/`・`packages/api/src` から探した。
  テストを除く)、利用者の接続時(`api/server/services/Tools/mcp.js` の `reinitMCPServer`)は書き換えない。
  `MCPServerInspector.inspect` の呼び出し元 4 か所(`packages/api/src/mcp/registry/MCPServersRegistry.ts:415, 473, 521, 669`)は
  どれも接続を渡さない。上流のテスト(`packages/api/src/mcp/registry/__tests__/MCPServerInspector.test.ts:84-100`)も、
  `startup: false` なら検査の結果に `serverInstructions` を足さないことを確かめている
- したがって、ソースコードから読む限り、リファレンス構成で UI 側 LLM に入るのは leisen の `SERVER_INSTRUCTIONS` ではなく、
  `${instructions}` の位置に文字列 **`true`** が入った定型文である(`true as string` は型の注釈だけで、テンプレート
  リテラルで `"true"` になる)。`librechat.yaml` の「Orchestrator が initialize で返す instructions を UI 側の LLM に渡す」
  というコメントの意図とは食い違う。**実機では未確認**(LibreChat を動かしてシステムプロンプトを見ていない)
- `serverInstructions` に文字列を書いた場合は、その文字列がそのまま `${instructions}` に入る(`MCPManager.ts:292-293`、
  上流のテスト `packages/api/src/mcp/__tests__/MCPManager.test.ts:251` 以降)

### 3. LibreChat 自身が足すシステムプロンプト

- システムメッセージ = `instructions`(安定部)+ `additional_instructions`(動的な末尾)
  - `instructions` = `[基本の instructions, MCP の instructions].filter(Boolean).join('\n\n').trim()`
    (`packages/api/src/agents/context.ts:98-106` `buildAgentInstructions`)
  - 基本の instructions は、通常の会話では会話のパラメータの `promptPrefix`(利用者が「カスタム指示」に書く)
    (`packages/api/src/agents/load.ts:100-104`)、保存したエージェントではその instructions
  - `packages/api/src/agents/run.ts:986` `const systemContent = [toolInstructions, agent.instructions ?? ''].join('\n').trim();`
    (`toolInstructions` は web_search のツールの文脈だけ。`api/server/services/ToolService.js:966`)
  - `@librechat/agents` 3.2.46 の `src/agents/AgentContext.ts:538-556` が安定部を、`:563-585` が動的な末尾を作り、
    OpenAI 互換では `new SystemMessage([stable, dynamic].filter(p => p !== '').join('\n\n'))`(`:948-952`)。
    Anthropic で `promptCache` が有効なときは、安定部を `cache_control` 付きの text ブロックにし、動的な末尾を
    別のブロック(または人間ターンの末尾)に置く(`:902-917`)。文面は同じ
- 条件付きで足されるもの(どれも `additional_instructions` 側):
  - 日付・時刻: 自動では足さない。instructions に `{{current_date}}` / `{{current_datetime}}` / `{{iso_datetime}}` を書いたときだけ
    置き換え、動的な末尾に移す(`packages/api/src/agents/initialize.ts:1146-1158`)
  - artifacts: 利用者が会話で artifacts を有効にしたとき(`load.ts:142` `if (ephemeralAgent?.artifacts)`)だけ、
    `generateArtifactsPrompt` の文を足す(`initialize.ts:1161-1167`)
  - ファイル・RAG の文脈、メモリ: ファイルを添付したとき、`memory` を設定したときだけ
    (`api/server/controllers/agents/client.js:509-525`、`useMemory` は `appConfig.memory` がなければ何もしない)
  - skills: 利用者が使えるスキルがあるときだけカタログを足す(`initialize.ts:1178` 以降)
  - web_search / execute_code / file_search の文脈: そのツールを有効にしたときだけ(`ToolService.js:966-1006`)。
    リファレンス構成は web_search・execute_code を能力から外している
- **リファレンス構成で、利用者がカスタム指示・ファイル・artifacts を使わずに Leisen だけを選んだ通常の会話では、
  システムメッセージは上の MCP の定型文だけ**(`${instructions}` は `true`)。日付・ツールの使い方の説明は入らない

### 4. 利用者が書く instructions

- 通常の会話: 会話のパラメータの「カスタム指示」(`promptPrefix`)。リファレンス構成では既定で空
  (`modelSpecs` もプリセットも定義していない)
- エージェント: エージェントビルダーで書いた instructions。リファレンス構成には既定のエージェントはない
- どちらも MCP の定型文の前に `\n\n` でつながる(`context.ts:98-106`)

### 5. ツールの結果の戻り方

- `MCPManager.callTool` の結果を `formatToolContent`(`packages/api/src/mcp/parsers.ts:141`)で文字列にする。
  使うのは `content` の text だけ(複数なら `\n\n` でつなぐ)。**`structuredContent` は LLM に渡らない**
  (`parsers.ts` に `structuredContent` の扱いがない)。`content` が空なら `(No response)`
- 認識しないプロバイダ(`RECOGNIZED_PROVIDERS` にない名前)は `parseAsString` で同じく text をつなぐ(`parsers.ts:145-147`)
- `isError` は LibreChat 側で見ていない(text がそのまま返る)。例外になったときは
  `[MCP][leisen][ask] tool call failed: …` の文がツールの結果になる(`api/server/services/MCP.js` の `_call` の catch)

### 6. 会話履歴

- 会話のメッセージを親子関係でたどった列(`getMessagesForConversation`)を `formatMessage` で整え、
  過去のツール呼び出しは `@librechat/agents` の `formatAgentMessages`(`src/messages/format.ts:1173`)で
  AI のツール呼び出しとツールの結果のメッセージに戻す(`client.js:294-372, 1239`)。長い場合は要約・切り詰めがある
  (summarization / pruning。詳細は読んでいない)
- 利用者の発言の本文は text のまま渡る(`formatMessage` は `name` フィールドを付けることがあるが、本文は変えない。
  `src/messages/format.ts:146-200`)。引用(quotes)やファイルの文脈を付けたときだけ本文の前に足す

### 7. モデル(エンドポイント)ごとの違い

- ツールのスキーマの変換は Google / Vertex のときだけ(`sanitizeGeminiSchema`)。OpenAI 互換・Anthropic では同じ
- システムメッセージの文面は同じで、Anthropic(`promptCache`)・OpenRouter・Bedrock のときにキャッシュの区切りが付く
  (`AgentContext.ts:902-946`)
- リファレンス構成のエンドポイントは OpenAI 互換(LM Studio)だけ

## 確かめられなかったこと

- 実機の LibreChat が実際に送るリクエストの全文(システムメッセージに `true` が入ることを含む)。LibreChat を動かしていない
- LangChain(`@langchain/openai` 等)の `bindTools` がツール定義を API の形に変える際の細部(`strict` の付与、
  説明・スキーマの加工の有無)。`@librechat/agents` の `createSchemaOnlyTool`(`src/tools/schema.ts:9-28`)までは
  名前・説明・スキーマをそのまま渡すことを確かめたが、その先の LangChain のパッケージは読んでいない
- カスタムエンドポイント(LM Studio)の `provider` の値が `formatToolContent` でどう判定されるか
  (どちらの経路でも text をつなぐ点は同じ)
- 利用者が UI で artifacts・ファイル・カスタム指示を使った場合の全文(条件付きの文の本文は読んでいない)
- 会話履歴の要約・切り詰めの規則

## 比較実験(条件 4)への反映

- `--ui-prompt librechat`: リファレンス構成どおり。ツール名は `ask_mcp_leisen` / `feedback_mcp_leisen`、説明とスキーマは
  `orchestratorToolDefinitions` のまま、システムメッセージは MCP の定型文で `${instructions}` を `true` にしたもの。
  UI 側 LLM が書いた `ask` の引数はすべて、`leisen-ask serve` と同じ検証(`runOrchestratorTool`)を通して探索 LLM に渡す
- `--ui-prompt librechat-instructions`: `serverInstructions` に `SERVER_INSTRUCTIONS` の文字列を書いた場合
  (定型文の `${instructions}` に leisen の指示が入る)。リファレンス構成の設定を変えた場合の比較用
- 再現に入れていないもの: 利用者のカスタム指示・artifacts・ファイル・メモリ(リファレンス構成の既定では入らない)、
  会話履歴(1 発言だけ)、LangChain の変換の細部(未確認)
