/**
 * LLM クライアントの生成を1か所に集約する(T-007、ADR-017 決定1)。
 *
 * 設定(llmBackendConfigSchema。provider で実装を選ぶ)を zod で検証し、対応する
 * LlmClient を作る。leisen-ask・リファレンスデプロイ(T-012)・評価ハーネス(T-008)は
 * ここを通して作り、実装クラスを直接選ばない。資格情報の値は設定に載らない
 * (Anthropic は SDK が環境から、OpenAI 互換は apiKeyEnv が指す環境変数から読む)。
 */
import { llmBackendConfigSchema, type LlmBackendConfigInput } from "../config.js";
import { AnthropicLlmClient, type AnthropicMessagesApi } from "./anthropic.js";
import { OpenAiCompatibleLlmClient } from "./openai-compatible.js";
import type { LlmClient } from "./types.js";

/** 生成時に差し替えられる依存(テスト・組み込み用)。 */
export interface LlmClientDependencies {
  /** anthropic: SDK クライアント(既定: `new Anthropic()`。資格情報・接続先は環境から) */
  readonly anthropicClient?: AnthropicMessagesApi;
  /** openai_compatible: HTTP クライアント(既定: グローバル fetch) */
  readonly fetch?: typeof fetch;
  /** openai_compatible: apiKeyEnv を読む環境(既定: process.env) */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * 設定から LlmClient を作る。設定が不正なら ZodError を投げる(入力値はメッセージに
 * 含まれない。呼び出し側は固定文言に置き換えて表示する)。
 */
export function createLlmClient(
  config: LlmBackendConfigInput,
  dependencies: LlmClientDependencies = {},
): LlmClient {
  const parsed = llmBackendConfigSchema.parse(config);
  switch (parsed.provider) {
    case "anthropic":
      return new AnthropicLlmClient({
        ...parsed,
        ...(dependencies.anthropicClient !== undefined
          ? { client: dependencies.anthropicClient }
          : {}),
      });
    case "openai_compatible":
      return new OpenAiCompatibleLlmClient({
        ...parsed,
        ...(dependencies.fetch !== undefined ? { fetch: dependencies.fetch } : {}),
        ...(dependencies.env !== undefined ? { env: dependencies.env } : {}),
      });
  }
}
