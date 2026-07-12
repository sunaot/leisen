/**
 * Claude API(Messages API)の薄いラッパー(T-007)。
 *
 * - SDKを追加せず fetch で最小実装する(依存追加を避け、ラッパー境界を薄く保つ)
 * - タイムアウト・再試行・価格はすべて設定注入(開発ルール: 制限値をコードに
 *   埋めない)。モデルIDも導入設定で指定する(既定値を埋め込まない)
 * - APIキーは環境変数「名」で受け取り(deployment.yamlの*Env参照方式と同じ、
 *   不変条件6)、値をログ・エラーに出さない。応答本文もエラーへ流さない(TM-A2)
 */
import {
  LlmError,
  type LlmAssistantBlock,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
} from "./types.js";

export interface AnthropicPricing {
  /** 入力100万トークンあたりの価格(導入先の課金通貨) */
  readonly inputPerMTok: number;
  /** 出力100万トークンあたりの価格 */
  readonly outputPerMTok: number;
}

export interface AnthropicLlmClientOptions {
  /** APIキーを保持する環境変数の「名前」(値ではない) */
  readonly apiKeyEnv: string;
  /** 利用するモデルID(deployment側で指定。コードに既定値を埋めない) */
  readonly model: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** 1応答の最大出力トークン */
  readonly maxTokens?: number;
  /** rate_limited / 一時的エラー時の再試行回数(初回を除く) */
  readonly maxRetries?: number;
  /** 再試行の初期待機ms(指数バックオフ) */
  readonly retryBaseDelayMs?: number;
  /** costEstimate算出用の価格。省略時はcostEstimateを返さない */
  readonly pricing?: AnthropicPricing;
  /** テスト用のfetch注入 */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const API_VERSION = "2023-06-01";

interface WireContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AnthropicLlmClient implements LlmClient {
  private readonly apiKey: string;
  private readonly options: AnthropicLlmClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicLlmClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    const key = process.env[options.apiKeyEnv];
    if (!key) {
      // 環境変数「名」だけをエラーに含める(値は存在しないので漏れない)
      throw new LlmError(
        "misconfigured",
        `LLM API key environment variable is not set: ${options.apiKeyEnv}`,
      );
    }
    this.apiKey = key;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const maxRetries = this.options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const baseDelay = this.options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    let lastError: LlmError | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await delay(lastError?.retryAfterMs ?? baseDelay * 2 ** (attempt - 1));
      }
      try {
        return await this.completeOnce(request);
      } catch (error) {
        if (
          error instanceof LlmError &&
          (error.errorClass === "llm_rate_limited" ||
            error.errorClass === "llm_unavailable")
        ) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    // maxRetries >= 0 のためここに来る時点で lastError は必ず設定済み
    throw lastError ?? new LlmError("llm_unavailable", "llm call failed");
  }

  private async completeOnce(request: LlmRequest): Promise<LlmResponse> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.options.baseUrl ?? DEFAULT_BASE_URL}/v1/messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": API_VERSION,
          },
          body: JSON.stringify(toWireRequest(request, this.options)),
          signal: controller.signal,
        },
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new LlmError(
          "llm_unavailable",
          `llm call timed out after ${timeoutMs}ms`,
        );
      }
      // ネットワーク例外のメッセージは接続先情報を含みうるため流さない
      throw new LlmError("llm_unavailable", "llm endpoint unreachable");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw toLlmError(response);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new LlmError("llm_unavailable", "llm returned a non-JSON response");
    }
    return parseWireResponse(body, this.options.pricing);
  }
}

function toWireRequest(
  request: LlmRequest,
  options: AnthropicLlmClientOptions,
): Record<string, unknown> {
  return {
    model: options.model,
    max_tokens: request.maxTokens ?? options.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: request.system,
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    })),
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content.map((block) => {
        switch (block.type) {
          case "text":
            return { type: "text", text: block.text };
          case "tool_use":
            return {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: block.input,
            };
          case "tool_result":
            return {
              type: "tool_result",
              tool_use_id: block.toolUseId,
              content: block.content,
              ...(block.isError !== undefined ? { is_error: block.isError } : {}),
            };
        }
      }),
    })),
  };
}

/** HTTPステータスを正規化エラーへ写像する。応答本文は読まない(TM-A2)。 */
function toLlmError(response: Response): LlmError {
  if (response.status === 429) {
    const retryAfterSec = Number(response.headers.get("retry-after"));
    return new LlmError(
      "llm_rate_limited",
      "llm rate limit exceeded",
      Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? retryAfterSec * 1000
        : undefined,
    );
  }
  if (response.status >= 500 || response.status === 529) {
    return new LlmError("llm_unavailable", `llm server error (${response.status})`);
  }
  if (response.status === 401 || response.status === 403) {
    return new LlmError("misconfigured", "llm credential rejected");
  }
  return new LlmError("invalid_request", `llm rejected request (${response.status})`);
}

function parseWireResponse(
  body: unknown,
  pricing: AnthropicPricing | undefined,
): LlmResponse {
  const record = body as {
    content?: WireContentBlock[];
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  if (!Array.isArray(record.content)) {
    throw new LlmError("llm_unavailable", "llm response missing content");
  }
  const content: LlmAssistantBlock[] = [];
  for (const block of record.content) {
    if (block.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
    } else if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      content.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      });
    }
    // 未知のブロック種別(thinking等)は探索ループの入力にならないため落とす
  }
  const stopReason =
    record.stop_reason === "tool_use" || record.stop_reason === "max_tokens"
      ? record.stop_reason
      : "end_turn";
  const inputTokens = record.usage?.input_tokens ?? 0;
  const outputTokens = record.usage?.output_tokens ?? 0;
  return {
    content,
    stopReason,
    usage: { inputTokens, outputTokens },
    ...(pricing !== undefined
      ? {
          costEstimate:
            (inputTokens * pricing.inputPerMTok +
              outputTokens * pricing.outputPerMTok) /
            1_000_000,
        }
      : {}),
  };
}
