/**
 * LLMクライアントのポート(T-007)。
 *
 * Orchestrator本体はこのIFにのみ依存し、実プロバイダ(Claude API)は
 * 薄いラッパー(anthropic.ts)で差し替える(開発ルール: 外部SaaSクライアントは
 * 薄いラッパー越し。テストはScriptedLlmで再現可能にする)。
 * Claude Messages APIのツール使用ループを表現できる最小の型に絞る。
 */

/** ツール定義。inputSchema はJSON Schema(Messages APIの input_schema)。 */
export interface LlmToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface LlmTextBlock {
  readonly type: "text";
  readonly text: string;
}

/** アシスタント応答中のツール呼び出し要求。 */
export interface LlmToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** ツール実行結果(userメッセージとして返す)。contentはJSON文字列等。 */
export interface LlmToolResultBlock {
  readonly type: "tool_result";
  readonly toolUseId: string;
  readonly content: string;
  readonly isError?: boolean;
}

export type LlmAssistantBlock = LlmTextBlock | LlmToolUseBlock;
export type LlmUserBlock = LlmTextBlock | LlmToolResultBlock;

export type LlmMessage =
  | { readonly role: "assistant"; readonly content: readonly LlmAssistantBlock[] }
  | { readonly role: "user"; readonly content: readonly LlmUserBlock[] };

export interface LlmRequest {
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly LlmToolDefinition[];
  readonly maxTokens?: number;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface LlmResponse {
  readonly content: readonly LlmAssistantBlock[];
  readonly stopReason: "end_turn" | "tool_use" | "max_tokens";
  readonly usage: LlmUsage;
  /**
   * この呼び出しのコスト推定(導入先の課金通貨、pricing設定時のみ)。
   * orchestrator.costLimitPerQuery(deployment.yaml)の消費側。
   */
  readonly costEstimate?: number;
}

export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** LLM層の正規化エラー分類。生のプロバイダ応答を上位へ流さない(TM-A2)。 */
export type LlmErrorClass =
  | "llm_rate_limited"
  | "llm_unavailable"
  | "invalid_request"
  | "misconfigured";

export class LlmError extends Error {
  constructor(
    public readonly errorClass: LlmErrorClass,
    /** メッセージに秘密情報(APIキー等)・応答本文を含めないこと(不変条件6) */
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}
