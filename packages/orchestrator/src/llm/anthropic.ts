/**
 * Claude API の LlmClient 実装(T-007、ADR-017 決定1)。公式 SDK
 * `@anthropic-ai/sdk` を薄く包む。
 *
 * - 資格情報は SDK が環境から解決する(`new Anthropic()`: ANTHROPIC_API_KEY /
 *   ANTHROPIC_AUTH_TOKEN / `ant auth login` のプロファイル等)。キーをコード・設定に書かない
 * - モデル・effort・タイムアウト・再試行回数・server-side fallbacks は設定注入
 *   (config.ts の anthropicLlmSettingsSchema)
 * - thinking は adaptive 固定、tool_choice は auto(Claude Opus 5.5 / Fable 5.1 は
 *   強制ツール指定を 400 にするため。submit_answer の提出はプロンプトで指示し、
 *   ツール定義の strict: true で引数の形を保証する)
 * - prefill(末尾が assistant の履歴)は送らない(現行モデルでは 400)
 * - 非ストリーミング(messages.create)。1ターンの出力はツール呼び出しか
 *   submit_answer で短く、途中経過を表示しないため。ストリーミングにする場合は
 *   eager_input_streaming 時の入力検証(スキル「Eager input streaming」)が別途要る
 * - stop_reason の refusal / max_tokens / pause_turn / model_context_window_exceeded は
 *   続行できない応答として LlmError に写す(content を読む前に判定する)
 * - SDK の型付き例外は具体的なものから順に正規化分類へ写す。例外メッセージ(API の
 *   応答本文を含みうる)は外へ流さない
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  anthropicLlmSettingsSchema,
  type AnthropicLlmSettings,
  type AnthropicLlmSettingsInput,
} from "../config.js";
import { LlmError } from "../errors.js";
import type {
  LlmAttemptUsage,
  LlmCallOptions,
  LlmClient,
  LlmRequest,
  LlmTurn,
} from "./types.js";

/** server-side fallbacks の `"default"` 形式に対応する beta ヘッダ(配列形式は別ヘッダ)。 */
export const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** SDK のリクエストオプション(timeout / maxRetries / signal)。 */
type RequestOptions = NonNullable<Parameters<Anthropic["messages"]["create"]>[1]>;

/**
 * このクラスが使う SDK クライアントの面(`new Anthropic()` がそのまま満たす)。
 * テストでは messages.create を差し替えたフェイクを渡す(ネットワークなし)。
 * apiKey / authToken / credentials は資格情報欠落の判定にだけ読む(値は外へ出さない)。
 */
export interface AnthropicMessagesApi {
  readonly apiKey: string | null;
  readonly authToken: string | null;
  readonly credentials: unknown;
  readonly messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: RequestOptions,
    ): PromiseLike<Anthropic.Message>;
  };
  readonly beta: {
    readonly messages: {
      create(
        body: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
        options?: RequestOptions,
      ): PromiseLike<Anthropic.Beta.Messages.BetaMessage>;
    };
  };
}

export interface AnthropicLlmClientOptions extends AnthropicLlmSettingsInput {
  /** 差し替え用の SDK クライアント。省略時は `new Anthropic()`(資格情報は環境から) */
  readonly client?: AnthropicMessagesApi;
}

export class AnthropicLlmClient implements LlmClient {
  readonly settings: AnthropicLlmSettings;
  // 資格情報を持つ SDK クライアントは ES の private に持つ(JSON 化・inspect に出さない)
  readonly #client: AnthropicMessagesApi;

  constructor(options: AnthropicLlmClientOptions = {}) {
    const { client, ...settings } = options;
    this.settings = anthropicLlmSettingsSchema.parse(settings);
    this.#client =
      client ??
      new Anthropic({
        timeout: this.settings.timeoutMs,
        maxRetries: this.settings.maxRetries,
      });
  }

  async complete(
    request: LlmRequest,
    options: LlmCallOptions = {},
  ): Promise<LlmTurn> {
    assertNoPrefill(request.messages);
    const body: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.settings.model,
      max_tokens: request.maxTokens,
      system: [...request.system],
      messages: [...request.messages],
      tools: [...request.tools],
      tool_choice: { type: "auto" },
      thinking: { type: "adaptive" },
      output_config: { effort: this.settings.effort },
      // 会話の末尾まで自動でキャッシュする(system 固定部の明示ブレークポイントと併用。
      // スキル「The robust combination for agent loops」)
      cache_control: { type: "ephemeral" },
    };
    // timeout / maxRetries はリクエスト単位でも渡す(差し替えたクライアントにも効かせる)
    const requestOptions: RequestOptions = {
      timeout: this.settings.timeoutMs,
      maxRetries: this.settings.maxRetries,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    };

    let turn: LlmTurn;
    try {
      if (this.settings.serverSideFallbacks) {
        const message = await this.#client.beta.messages.create(
          {
            ...body,
            betas: [SERVER_SIDE_FALLBACK_BETA],
            fallbacks: "default",
          },
          requestOptions,
        );
        turn = fromBetaMessage(message);
      } else {
        turn = {
          message: await this.#client.messages.create(body, requestOptions),
        };
      }
    } catch (error) {
      throw toLlmError(error, this.#client, options.signal);
    }
    assertUsableStop(turn.message);
    return turn;
  }
}

/** 末尾が assistant の履歴(prefill)は現行モデルで 400 になるため送らない。 */
function assertNoPrefill(messages: readonly Anthropic.MessageParam[]): void {
  const last = messages.at(-1);
  if (last === undefined) {
    throw new LlmError("llm_invalid_request", "messages must not be empty");
  }
  if (last.role === "assistant") {
    throw new LlmError(
      "llm_invalid_request",
      "assistant prefill is not supported by the current models",
    );
  }
}

/** stop_reason を content より先に判定し、続行できない応答を LlmError にする。 */
function assertUsableStop(message: Anthropic.Message): void {
  const reason = message.stop_reason;
  switch (reason) {
    case "end_turn":
    case "tool_use":
    case "stop_sequence":
      return;
    case "refusal":
      // 部分出力(ストリーミング時)や空 content を回答として扱わない
      throw new LlmError(
        "llm_refusal",
        "the model declined the request (stop_reason: refusal)",
        message.stop_details?.category ?? undefined,
      );
    case "max_tokens":
      // ツール入力・回答が途中で切れている。切れた入力でツールを実行しない
      throw new LlmError(
        "llm_max_tokens",
        "the response was cut off at max_tokens",
      );
    case "pause_turn":
      // サーバーツールを宣言しないため想定外。再開には末尾 assistant の送信が要り、
      // サーバーツール以外では prefill 扱いの 400 になるので再開しない
      throw new LlmError(
        "llm_pause_turn",
        "unexpected pause_turn without server tools",
      );
    case "model_context_window_exceeded":
      throw new LlmError(
        "llm_context_window_exceeded",
        "the conversation exceeded the model context window",
      );
    case null:
      throw new LlmError(
        "llm_unexpected_response",
        "the response has no stop_reason",
      );
    default: {
      const unknown: never = reason;
      void unknown;
      throw new LlmError(
        "llm_unexpected_response",
        "the response has an unknown stop_reason",
      );
    }
  }
}

/**
 * SDK の例外を正規化分類へ写す。具体的な型から順に判定する
 * (APIConnectionTimeoutError ⊂ APIConnectionError ⊂ APIError)。
 */
function toLlmError(
  error: unknown,
  client: AnthropicMessagesApi,
  signal: AbortSignal | undefined,
): LlmError {
  if (error instanceof LlmError) {
    return error;
  }
  if (error instanceof Anthropic.APIUserAbortError || signal?.aborted === true) {
    return new LlmError("llm_aborted", "the Claude API request was aborted");
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new LlmError("llm_timeout", "the Claude API request timed out");
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new LlmError("llm_unavailable", "could not connect to the Claude API");
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new LlmError("llm_rate_limited", "the Claude API rate limit was exceeded");
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new LlmError(
      "llm_authentication_failed",
      "the Claude API rejected the credentials (401)",
    );
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new LlmError(
      "llm_permission_denied",
      "the credentials are not allowed to use this model (403)",
    );
  }
  if (error instanceof Anthropic.NotFoundError) {
    // 不明なモデルID・組織で利用できないモデル
    return new LlmError("llm_invalid_request", "the model or endpoint was not found (404)");
  }
  if (
    error instanceof Anthropic.BadRequestError ||
    error instanceof Anthropic.UnprocessableEntityError
  ) {
    return new LlmError("llm_invalid_request", "the Claude API rejected the request");
  }
  if (error instanceof Anthropic.ConflictError) {
    return new LlmError("llm_unavailable", "the Claude API returned a conflict (409)");
  }
  if (error instanceof Anthropic.InternalServerError) {
    return error.type === "overloaded_error"
      ? new LlmError("llm_overloaded", "the Claude API is overloaded (529)")
      : new LlmError("llm_unavailable", "the Claude API returned a server error");
  }
  if (error instanceof Anthropic.APIError) {
    // 上記の型を持たないステータス(402 / 413 等)
    const status = error.status;
    return status !== undefined && status >= 400 && status < 500
      ? new LlmError("llm_invalid_request", "the Claude API rejected the request")
      : new LlmError("llm_unavailable", "the Claude API request failed");
  }
  // SDK は資格情報を解決できないとき、送信前に型なしの Error を投げる。メッセージの
  // 文字列一致ではなく、失敗後のクライアントの認証状態(解決は要求時に完了している)で判定する
  if (!hasResolvedCredentials(client)) {
    return new LlmError(
      "llm_credentials_missing",
      "no Claude API credentials could be resolved from the environment",
    );
  }
  return new LlmError("llm_client_error", "the Claude API client failed");
}

/** 解決済みの資格情報があるか(空文字の環境変数は SDK が文字列として保持するため欠落とみなす)。 */
function hasResolvedCredentials(client: AnthropicMessagesApi): boolean {
  return (
    (client.apiKey ?? "") !== "" ||
    (client.authToken ?? "") !== "" ||
    (client.credentials !== null && client.credentials !== undefined)
  );
}

/**
 * server-side fallbacks(beta)の応答を非 beta の Message に写す。サーバーツール・
 * MCP・compaction を使わない本構成で現れるブロック型だけを受け付ける。
 * `fallback` ブロックは監査用の切り替え目印で履歴に戻さなくてよい(スキル
 * 「Echoing fallback turns back」: keep or drop)。最後の `fallback` より前の
 * thinking / redacted_thinking / tool_use は辞退したモデルの出力なので落とす
 * (非ストリーミングでは辞退した部分出力は元々含まれないが、規則どおりに扱う)。
 */
function fromBetaMessage(beta: Anthropic.Beta.Messages.BetaMessage): LlmTurn {
  let lastFallback = -1;
  beta.content.forEach((block, index) => {
    if (block.type === "fallback") {
      lastFallback = index;
    }
  });
  const content: Anthropic.ContentBlock[] = [];
  beta.content.forEach((block, index) => {
    const beforeSwitch = index < lastFallback;
    switch (block.type) {
      case "fallback":
        return;
      case "text":
        content.push({ type: "text", text: block.text, citations: null });
        return;
      case "thinking":
        if (!beforeSwitch) {
          content.push({
            type: "thinking",
            thinking: block.thinking,
            signature: block.signature,
          });
        }
        return;
      case "redacted_thinking":
        if (!beforeSwitch) {
          content.push({ type: "redacted_thinking", data: block.data });
        }
        return;
      case "tool_use":
        if (block.caller !== undefined && block.caller.type !== "direct") {
          throw new LlmError(
            "llm_unexpected_response",
            "unexpected programmatic tool call",
          );
        }
        if (!beforeSwitch) {
          content.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input,
            caller: { type: "direct" },
          });
        }
        return;
      default:
        throw new LlmError(
          "llm_unexpected_response",
          "unexpected content block type in the response",
        );
    }
  });

  const stopReason = beta.stop_reason;
  if (stopReason === "compaction") {
    throw new LlmError(
      "llm_unexpected_response",
      "unexpected compaction stop without context management",
    );
  }
  const usage = beta.usage;
  const message: Anthropic.Message = {
    id: beta.id,
    type: "message",
    role: "assistant",
    model: beta.model,
    content,
    container: null,
    stop_reason: stopReason,
    stop_sequence: beta.stop_sequence,
    stop_details:
      beta.stop_details === null
        ? null
        : {
            type: "refusal",
            category: beta.stop_details.category,
            explanation: beta.stop_details.explanation,
          },
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      cache_creation: null,
      inference_geo: usage.inference_geo,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: usage.service_tier,
    },
  };

  // 課金の正は usage.iterations(辞退した試行・フォールバック先の試行を含む)
  const attempts: LlmAttemptUsage[] = [];
  for (const iteration of usage.iterations ?? []) {
    if (iteration.type === "message" || iteration.type === "fallback_message") {
      attempts.push({
        model: iteration.model ?? beta.model,
        inputTokens: iteration.input_tokens,
        outputTokens: iteration.output_tokens,
        cacheCreationInputTokens: iteration.cache_creation_input_tokens,
        cacheReadInputTokens: iteration.cache_read_input_tokens,
      });
    }
  }
  return attempts.length > 0 ? { message, attempts } : { message };
}
