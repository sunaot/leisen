/**
 * @kp/orchestrator — 探索戦略 v1(T-007)。
 *
 * モジュール構成:
 * - orchestrator.ts   探索ループ(runId / iteration の採番、上限、出典検証、AnswerRun)
 * - answer.ts         回答スキーマ(zod)と submit_answer ツール
 * - citations.ts      証拠台帳(run 内で受け取った文書)と出典・URL の検証
 * - prompt.ts         system prompt(prompts/explore.v1.md +ソース一覧)と制御メッセージ
 * - tools.ts          Gateway のツール定義 → strict な Claude ツール定義
 * - cost.ts           usage × 価格表の費用概算
 * - audit.ts          AnswerRun レコードの組み立て、stderr デバッグシンク
 * - config.ts         設定スキーマ(探索の上限・価格表、Claude API クライアント)
 * - llm/              LlmClient IF、AnthropicLlmClient、ScriptedLlmClient(テスト用)
 * - gateway/          GatewayClient IF、McpGatewayClient(Streamable HTTP)、
 *                     Gateway へ送る `_meta` の組み立て(buildGatewayMeta)
 * - bin/kp-ask.ts     CLI
 */
export * from "./answer.js";
export * from "./audit.js";
export * from "./citations.js";
export * from "./config.js";
export * from "./cost.js";
export * from "./errors.js";
export * from "./orchestrator.js";
export * from "./prompt.js";
export * from "./tools.js";
export * from "./llm/types.js";
export * from "./llm/anthropic.js";
export * from "./llm/scripted.js";
export * from "./gateway/types.js";
export * from "./gateway/meta.js";
export * from "./gateway/mcp-client.js";
