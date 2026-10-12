/**
 * @kp/orchestrator — 探索戦略 v1(T-007)。
 *
 * モジュール構成:
 * - orchestrator.ts   探索ループ(runId / iteration の採番、上限、出典検証、AnswerRun)
 * - failure-text.ts   outcome: error の回答文(失敗の分類ごとに次の行動を示す)
 * - answer.ts         回答スキーマ(zod)と submit_answer ツール
 * - citations.ts      証拠台帳(run 内で受け取った文書)と出典の検証
 * - sanitize.ts       回答本文の無害化(URL・リンク・画像・生の HTML を残さない)
 * - prompt.ts         system prompt(prompts/explore.v3.md、固定部のみ)、最初の
 *                     user ターン(ソース一覧・上限・質問)と制御メッセージ
 * - tools.ts          Gateway のツール定義 → strict な Claude ツール定義
 * - cost.ts           usage × 価格表の費用概算
 * - audit.ts          `_meta` の actor の既定値、永続化不可のソースの判定(AnswerRun の書き手は
 *                     Gateway の run API。ADR-019)
 * - config.ts         設定スキーマ(探索の上限・プロバイダ別の価格表、LLM バックエンドの選択)
 * - llm/              LlmClient IF と能力フラグ、createLlmClient(生成の集約)、
 *                     AnthropicLlmClient、OpenAiCompatibleLlmClient、ScriptedLlmClient(テスト用)
 * - gateway/          GatewayClient IF(tools/call と run API)、McpGatewayClient(Streamable HTTP +
 *                     run API の fetch)、Gateway へ送る `_meta` の組み立て(buildGatewayMeta)
 * - server/           MCP サーバー(T-021、ADR-018): ツール ask / feedback(tools.ts、
 *                     SDK 非依存)、回答の Markdown(render.ts)、SDK との接合(mcp.ts)、
 *                     Streamable HTTP と認証の前段 preflight(http.ts)、上限(limits.ts)
 * - bin/kp-ask.ts     CLI(bin/serve.ts: `kp-ask serve`、bin/credential-options.ts: Orchestrator の資格情報)
 */
export * from "./answer.js";
export * from "./audit.js";
export * from "./citations.js";
export * from "./config.js";
export * from "./cost.js";
export * from "./errors.js";
export * from "./failure-text.js";
export * from "./orchestrator.js";
export * from "./prompt.js";
export * from "./sanitize.js";
export * from "./tools.js";
export * from "./llm/types.js";
export * from "./llm/capabilities.js";
export * from "./llm/factory.js";
export * from "./llm/anthropic.js";
export * from "./llm/openai-compatible.js";
export * from "./llm/scripted.js";
export * from "./gateway/types.js";
export * from "./gateway/meta.js";
export * from "./gateway/mcp-client.js";
export * from "./server/limits.js";
export * from "./server/render.js";
export * from "./server/tools.js";
export * from "./server/mcp.js";
export * from "./server/http.js";
