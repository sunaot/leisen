/**
 * OpenAI 互換 Chat Completions の LlmClient 実装(T-007、ADR-017 決定1 の参照実装の1つ)。
 * LM Studio / vLLM / llama.cpp server / Ollama 等の OpenAI 互換エンドポイント
 * (`POST {baseUrl}/chat/completions`)を、新規依存なしで fetch から呼ぶ。
 *
 * 形式の対応(会話の内部表現は Anthropic SDK の型。README「OpenAI 互換バックエンド」に表):
 * - 要求: system ブロック → system メッセージ1件(テキストを連結)/ user の text → user /
 *   tool_result → tool メッセージ(tool_call_id。本文はテキストを連結)/ assistant の text →
 *   content、tool_use → tool_calls[](function.arguments は JSON 文字列)/ thinking は送らない /
 *   ツール定義 → { type: "function", function: { name, description, parameters } }
 *   (strict は付けない)/ tool_choice: "auto" / max_tokens / stream: false /
 *   reasoning_effort(設定時かつ要求が effort を求めたときだけ)
 * - 応答: choices[0].message.content → text、tool_calls → tool_use(arguments を JSON.parse。
 *   読めなければ input を null にして invalidToolUseIds に入れる。Orchestrator が不正な入力
 *   として is_error の tool_result を返す)/ finish_reason: stop → end_turn(tool_calls が
 *   あれば tool_use)、tool_calls → tool_use、length → llm_max_tokens、content_filter →
 *   llm_refusal / usage: prompt_tokens(cached_tokens を除く)→ input_tokens、cached_tokens →
 *   cache_read_input_tokens、completion_tokens → output_tokens。usage がなければ費用は不明扱い
 * - 秘密情報: API キーは apiKeyEnv の環境変数から読み、private フィールドにだけ持つ。例外の
 *   メッセージは固定文言で、キー・ベース URL(クエリを含む)・応答本文を含めない
 * - 再試行: 429 / 5xx / 接続失敗のみ(指数バックオフ、Retry-After を尊重)。タイムアウトは
 *   再試行しない(遅い生成を繰り返さない)。リダイレクトは追わない(キーを別の宛先へ送らない)
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  openAiCompatibleLlmSettingsSchema,
  type OpenAiCompatibleLlmSettings,
  type OpenAiCompatibleLlmSettingsInput,
  type ReasoningEffort,
} from "../config.js";
import { LlmError } from "../errors.js";
import { OPENAI_COMPATIBLE_BASE_CAPABILITIES } from "./capabilities.js";
import { assertNoPrefill, assertUsableStop } from "./stop.js";
import type {
  LlmAttemptUsage,
  LlmCallOptions,
  LlmCapabilities,
  LlmClient,
  LlmRequest,
  LlmTurn,
} from "./types.js";

/** 再試行の待機の基準(ms)。n 回目の待機は基準 × 2^n(上限 8 秒、ゆらぎ付き)。 */
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8_000;
/** Retry-After の指示を尊重する上限。超える・読めない指示は既定のバックオフにする。 */
const MAX_RETRY_AFTER_MS = 60_000;
/** Authorization ヘッダに載せられるキー(空白・制御文字を含まない)。 */
const USABLE_KEY = /^[\x21-\x7e]+$/;

export interface OpenAiCompatibleLlmClientOptions extends OpenAiCompatibleLlmSettingsInput {
  /** バックエンドの種別(llmBackendConfigSchema の値をそのまま渡せるように受ける) */
  readonly provider?: "openai_compatible";
  /** HTTP クライアント(既定: グローバル fetch)。テストで差し替える */
  readonly fetch?: typeof fetch;
  /** apiKeyEnv を読む環境(既定: process.env) */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 再試行の待機の基準(ms、既定 500)。テストで短くする */
  readonly retryBaseDelayMs?: number;
}

// ---------------------------------------------------------------------------
// Chat Completions の要求の形(本クライアントが送るものに限る。OpenAI API リファレンス準拠)
// ---------------------------------------------------------------------------

interface ChatToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

type ChatMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      /** tool_calls があるときはテキストがなければ null(仕様: tool_calls 指定時は任意) */
      readonly content: string | null;
      readonly tool_calls?: readonly ChatToolCall[];
    }
  | { readonly role: "tool"; readonly tool_call_id: string; readonly content: string };

interface ChatTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: Anthropic.Tool.InputSchema;
  };
}

interface ChatCompletionsRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ChatTool[];
  readonly tool_choice?: "auto";
  readonly max_tokens: number;
  readonly stream: false;
  readonly reasoning_effort?: ReasoningEffort;
}

// ---------------------------------------------------------------------------
// 応答の検証(寛容に読む: 未知のフィールドは無視し、欠けてよいものは任意にする)
// ---------------------------------------------------------------------------

const tokenCountSchema = z.number().nullable().optional();

const responseSchema = z.object({
  id: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  choices: z.array(
    z.object({
      message: z.object({
        content: z.union([z.string(), z.array(z.unknown())]).nullable().optional(),
        refusal: z.string().nullable().optional(),
        tool_calls: z
          .array(
            z.object({
              id: z.string().nullable().optional(),
              type: z.string().nullable().optional(),
              function: z
                .object({
                  name: z.string().nullable().optional(),
                  // 仕様は JSON 文字列。オブジェクトで返すサーバーもあるため型を問わず受ける
                  arguments: z.unknown().optional(),
                })
                .nullable()
                .optional(),
            }),
          )
          .nullable()
          .optional(),
      }),
      finish_reason: z.string().nullable().optional(),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: tokenCountSchema,
      completion_tokens: tokenCountSchema,
      prompt_tokens_details: z
        .object({ cached_tokens: tokenCountSchema })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});
type ChatCompletionsResponse = z.infer<typeof responseSchema>;
type ResponseMessage = ChatCompletionsResponse["choices"][number]["message"];

export class OpenAiCompatibleLlmClient implements LlmClient {
  readonly provider = "openai_compatible" as const;
  readonly capabilities: LlmCapabilities;
  /** 要求に載せるモデル名 */
  readonly model: string;
  readonly #settings: OpenAiCompatibleLlmSettings;
  /** {baseUrl}/chat/completions(クエリを含みうるので外に出さない) */
  readonly #url: URL;
  /** apiKeyEnv の値。apiKeyEnv 未指定なら undefined、指定されていて空なら "" */
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #retryBaseDelayMs: number;

  constructor(options: OpenAiCompatibleLlmClientOptions) {
    const {
      provider: _provider,
      fetch: fetchImpl,
      env,
      retryBaseDelayMs,
      ...settings
    } = options;
    this.#settings = openAiCompatibleLlmSettingsSchema.parse(settings);
    this.#url = chatCompletionsUrl(this.#settings.baseUrl);
    this.model = this.#settings.model;
    const apiKeyEnv = this.#settings.apiKeyEnv;
    this.#apiKey =
      apiKeyEnv === undefined ? undefined : ((env ?? process.env)[apiKeyEnv] ?? "").trim();
    this.#fetch = fetchImpl ?? globalThis.fetch;
    this.#retryBaseDelayMs = retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.capabilities = Object.freeze({
      ...OPENAI_COMPATIBLE_BASE_CAPABILITIES,
      effort: this.#settings.reasoningEffort !== undefined,
      ...(this.#settings.maxContextTokens !== undefined
        ? { maxContextTokens: this.#settings.maxContextTokens }
        : {}),
    });
  }

  /** 接続先(表示用。クエリ・資格情報を含まない)。 */
  get endpoint(): string {
    return `${this.#url.origin}${this.#url.pathname}`;
  }

  async complete(request: LlmRequest, options: LlmCallOptions = {}): Promise<LlmTurn> {
    try {
      assertNoPrefill(request.messages);
      if (this.#apiKey !== undefined && !USABLE_KEY.test(this.#apiKey)) {
        // 送信前に止める(Anthropic SDK が資格情報を解決できないときと同じ扱い)
        throw new LlmError(
          "llm_credentials_missing",
          "the environment variable named by apiKeyEnv does not hold a usable API key",
        );
      }
      const payload = JSON.stringify(this.#requestBody(request));
      const body = await this.#send(payload, options.signal);
      return this.#turnFrom(body);
    } catch (error) {
      if (error instanceof LlmError) {
        throw error;
      }
      if (options.signal?.aborted === true) {
        throw new LlmError("llm_aborted", "the OpenAI-compatible request was aborted");
      }
      // 実装の想定外。元の例外のメッセージは載せない
      throw new LlmError("llm_client_error", "the OpenAI-compatible client failed");
    }
  }

  #requestBody(request: LlmRequest): ChatCompletionsRequest {
    const tools = request.tools.map(toChatTool);
    const reasoningEffort = this.#settings.reasoningEffort;
    return {
      model: this.#settings.model,
      messages: toChatMessages(request.system, request.messages),
      // tool_choice はツールがあるときだけ送る(ツールなしの tool_choice を拒むサーバーがある)
      ...(tools.length > 0 ? { tools, tool_choice: "auto" as const } : {}),
      max_tokens: request.maxTokens,
      stream: false,
      // thinking は Chat Completions に標準の指定がないため送らない(能力フラグ thinking: none)
      ...(request.effort === true && reasoningEffort !== undefined
        ? { reasoning_effort: reasoningEffort }
        : {}),
    };
  }

  #headers(): Record<string, string> {
    return {
      ...this.#settings.extraHeaders,
      "content-type": "application/json",
      accept: "application/json",
      ...(this.#apiKey !== undefined ? { authorization: `Bearer ${this.#apiKey}` } : {}),
    };
  }

  /** 要求を送り、成功した応答の JSON を返す。失敗は LlmError に正規化する。 */
  async #send(payload: string, signal: AbortSignal | undefined): Promise<unknown> {
    const headers = this.#headers();
    for (let attempt = 0; ; attempt += 1) {
      if (isAborted(signal)) {
        throw abortedError();
      }
      const timeout = AbortSignal.timeout(this.#settings.timeoutMs);
      const attemptSignal =
        signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
      /** 再試行する場合の直前の HTTP ステータス(接続失敗なら undefined)と応答ヘッダ */
      let retryStatus: number | undefined;
      let retryHeaders: Headers | undefined;
      try {
        const response = await this.#fetch(this.#url, {
          method: "POST",
          headers,
          body: payload,
          signal: attemptSignal,
          // リダイレクトを追わない(Authorization を別の宛先へ送らない)。3xx はエラー
          redirect: "manual",
        });
        if (response.ok) {
          return parseJsonBody(await response.text());
        }
        if (!isRetryableStatus(response.status)) {
          throw errorForStatus(
            response.status,
            await errorCodeOf(response),
            this.#apiKey !== undefined,
          );
        }
        await response.body?.cancel().catch(() => undefined);
        retryStatus = response.status;
        retryHeaders = response.headers;
      } catch (error) {
        if (error instanceof LlmError) {
          throw error;
        }
        if (isAborted(signal)) {
          throw abortedError();
        }
        if (timeout.aborted) {
          throw new LlmError("llm_timeout", "the OpenAI-compatible request timed out");
        }
        // 接続失敗(接続拒否・名前解決・切断)。再試行の対象
      }
      if (attempt >= this.#settings.maxRetries) {
        throw exhaustedError(retryStatus);
      }
      try {
        await sleep(
          this.#retryDelayMs(attempt, retryHeaders),
          undefined,
          signal === undefined ? {} : { signal },
        );
      } catch {
        throw abortedError();
      }
    }
  }

  #retryDelayMs(attempt: number, headers: Headers | undefined): number {
    const hinted = retryAfterMs(headers);
    if (hinted !== undefined) {
      return hinted;
    }
    const delay = Math.min(this.#retryBaseDelayMs * 2 ** attempt, MAX_RETRY_DELAY_MS);
    return delay * (1 - Math.random() * 0.25);
  }

  /** 応答を Anthropic.Message の形に写す(終了理由を content より先に判定する)。 */
  #turnFrom(raw: unknown): LlmTurn {
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) {
      throw isRecord(raw) && isRecord(raw["error"])
        ? new LlmError(
            "llm_unavailable",
            "the OpenAI-compatible endpoint returned an error object",
          )
        : new LlmError(
            "llm_unexpected_response",
            "the OpenAI-compatible response could not be parsed",
          );
    }
    const body = parsed.data;
    const choice = body.choices[0];
    if (choice === undefined) {
      throw new LlmError(
        "llm_unexpected_response",
        "the OpenAI-compatible response has no choices",
      );
    }
    const toolCalls = choice.message.tool_calls ?? [];
    const stopReason = stopReasonOf(choice.finish_reason, toolCalls.length > 0);
    const refusal = choice.message.refusal;
    if (typeof refusal === "string" && refusal.trim() !== "") {
      throw new LlmError("llm_refusal", "the model declined the request (refusal)");
    }

    const { content, invalidToolUseIds } = contentBlocksOf(choice.message);
    const model =
      typeof body.model === "string" && body.model !== "" ? body.model : this.#settings.model;
    const promptTokens = tokenCount(body.usage?.prompt_tokens);
    const completionTokens = tokenCount(body.usage?.completion_tokens);
    const cachedTokens = Math.min(
      tokenCount(body.usage?.prompt_tokens_details?.cached_tokens) ?? 0,
      promptTokens ?? 0,
    );
    const message: Anthropic.Message = {
      id: typeof body.id === "string" && body.id !== "" ? body.id : `chatcmpl_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model,
      content,
      container: null,
      stop_reason: stopReason,
      stop_sequence: null,
      stop_details: null,
      usage: {
        // Chat Completions の prompt_tokens はキャッシュ分を含む。Anthropic の形に合わせて分ける
        input_tokens: (promptTokens ?? 0) - cachedTokens,
        output_tokens: completionTokens ?? 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cachedTokens,
        cache_creation: null,
        inference_geo: null,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: null,
      },
    };
    assertUsableStop(message);

    const usageMissing = promptTokens === undefined || completionTokens === undefined;
    const attempts: LlmAttemptUsage[] | undefined = usageMissing
      ? [
          {
            model,
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: cachedTokens,
            usageMissing: true,
          },
        ]
      : undefined;
    return {
      message,
      ...(attempts !== undefined ? { attempts } : {}),
      ...(invalidToolUseIds.length > 0 ? { invalidToolUseIds } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// 要求の変換(Anthropic 形式 → Chat Completions)
// ---------------------------------------------------------------------------

/** {baseUrl}/chat/completions。ベース URL のクエリは保つ(外には出さない)。 */
function chatCompletionsUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
  return url;
}

function toChatTool(tool: Anthropic.Tool): ChatTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description !== undefined && tool.description !== ""
        ? { description: tool.description }
        : {}),
      // strict は付けない(サーバーごとに扱いが違う。能力フラグ strictTools: false)
      parameters: tool.input_schema,
    },
  };
}

function unsupportedBlock(): LlmError {
  return new LlmError(
    "llm_invalid_request",
    "the conversation contains a content block the OpenAI-compatible backend cannot carry",
  );
}

function toChatMessages(
  system: readonly Anthropic.TextBlockParam[],
  messages: readonly Anthropic.MessageParam[],
): ChatMessage[] {
  const out: ChatMessage[] = [];
  const systemText = system
    .map((block) => block.text)
    .filter((text) => text !== "")
    .join("\n\n");
  if (systemText !== "") {
    out.push({ role: "system", content: systemText });
  }
  for (const message of messages) {
    switch (message.role) {
      case "user":
        out.push(...fromUser(message.content));
        break;
      case "assistant":
        out.push(fromAssistant(message.content));
        break;
      case "system": {
        const text = textOnly(message.content);
        if (text !== "") {
          out.push({ role: "system", content: text });
        }
        break;
      }
    }
  }
  return out;
}

/**
 * user ターン: tool_result は tool メッセージ(assistant の tool_calls の直後に置く必要が
 * あるため先に並べる)、テキストは続く user メッセージ1件にまとめる。
 */
function fromUser(content: Anthropic.MessageParam["content"]): ChatMessage[] {
  if (typeof content === "string") {
    return [{ role: "user", content }];
  }
  const toolMessages: ChatMessage[] = [];
  const texts: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case "tool_result":
        toolMessages.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: toolResultText(block),
        });
        break;
      case "text":
        texts.push(block.text);
        break;
      default:
        throw unsupportedBlock();
    }
  }
  const text = texts.join("\n\n");
  if (text === "" && toolMessages.length > 0) {
    return toolMessages;
  }
  return [...toolMessages, { role: "user", content: text }];
}

/** tool_result の本文(テキストを改行で連結。Chat Completions には is_error がないので本文だけ)。 */
function toolResultText(block: Anthropic.ToolResultBlockParam): string {
  const content = block.content;
  if (content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => {
      if (part.type !== "text") {
        throw unsupportedBlock();
      }
      return part.text;
    })
    .join("\n");
}

function fromAssistant(content: Anthropic.MessageParam["content"]): ChatMessage {
  if (typeof content === "string") {
    return { role: "assistant", content };
  }
  const texts: string[] = [];
  const toolCalls: ChatToolCall[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        texts.push(block.text);
        break;
      case "tool_use":
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            // 解釈できなかった引数(input: null)は空オブジェクトとして戻す。壊れた JSON を
            // 送り返すと、引数を JSON として読むサーバーでは次の要求が失敗する
            arguments: isRecord(block.input) ? JSON.stringify(block.input) : "{}",
          },
        });
        break;
      case "thinking":
      case "redacted_thinking":
        // 他形式に写せない(署名付きの思考ブロック)。送らない
        break;
      default:
        throw unsupportedBlock();
    }
  }
  const text = texts.join("\n\n");
  if (toolCalls.length === 0) {
    return { role: "assistant", content: text };
  }
  return { role: "assistant", content: text === "" ? null : text, tool_calls: toolCalls };
}

function textOnly(content: Anthropic.MessageParam["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) => {
      if (block.type !== "text") {
        throw unsupportedBlock();
      }
      return block.text;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// 応答の変換(Chat Completions → Anthropic 形式)
// ---------------------------------------------------------------------------

/**
 * finish_reason を stop_reason に写す。続行できないもの(length / content_filter / 未知)は
 * content を読む前に LlmError にする。finish_reason を返さないサーバーには tool_calls の
 * 有無で推定する。
 */
function stopReasonOf(
  finishReason: string | null | undefined,
  hasToolCalls: boolean,
): "end_turn" | "tool_use" {
  switch (finishReason) {
    case "stop":
    case "tool_calls":
    case "function_call":
    case null:
    case undefined:
      // tool_calls があるのに "stop" を返すサーバーもあるため、呼び出しの有無で決める
      return hasToolCalls ? "tool_use" : "end_turn";
    case "length":
      // 出力・ツール入力が途中で切れている。切れた入力でツールを実行しない
      throw new LlmError(
        "llm_max_tokens",
        "the response was cut off at max_tokens (finish_reason: length)",
      );
    case "content_filter":
      throw new LlmError(
        "llm_refusal",
        "the response was withheld by a content filter (finish_reason: content_filter)",
        "content_filter",
      );
    default:
      throw new LlmError(
        "llm_unexpected_response",
        "the response has an unknown finish_reason",
      );
  }
}

function contentBlocksOf(message: ResponseMessage): {
  content: Anthropic.ContentBlock[];
  invalidToolUseIds: string[];
} {
  const content: Anthropic.ContentBlock[] = [];
  const text = textOf(message.content);
  if (text.trim() !== "") {
    content.push({ type: "text", text, citations: null });
  }
  const invalidToolUseIds: string[] = [];
  const seen = new Set<string>();
  for (const call of message.tool_calls ?? []) {
    if (call.type !== undefined && call.type !== null && call.type !== "function") {
      throw new LlmError(
        "llm_unexpected_response",
        "the response contains an unsupported tool call type",
      );
    }
    const name = call.function?.name;
    if (typeof name !== "string" || name === "") {
      throw new LlmError(
        "llm_unexpected_response",
        "the response contains a tool call without a function name",
      );
    }
    // id が無い・同じ応答内で重複するサーバーがある。tool_result との対応を保つため振り直す
    let id = typeof call.id === "string" && call.id.trim() !== "" ? call.id : undefined;
    if (id === undefined || seen.has(id)) {
      id = `call_kp_${randomUUID().replaceAll("-", "")}`;
    }
    seen.add(id);
    const input = parseArguments(call.function?.arguments);
    if (input === undefined) {
      invalidToolUseIds.push(id);
    }
    content.push({
      type: "tool_use",
      id,
      name,
      input: input ?? null,
      caller: { type: "direct" },
    });
  }
  return { content, invalidToolUseIds };
}

function textOf(content: ResponseMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    // 仕様は文字列だが、テキストのパーツ配列で返すサーバーもある
    return content
      .flatMap((part) =>
        isRecord(part) && typeof part["text"] === "string" ? [part["text"]] : [],
      )
      .join("");
  }
  return "";
}

/**
 * function.arguments を JSON オブジェクトとして読む。読めなければ undefined(呼び出し側で
 * 不正な入力として扱う)。仕様外の形(オブジェクトのまま・二重に JSON 化された文字列・
 * 空文字)も、意味が一意なものは受ける。
 */
function parseArguments(raw: unknown): Record<string, unknown> | undefined {
  if (isRecord(raw)) {
    return raw;
  }
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  if (raw.trim() === "") {
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
    if (typeof value === "string") {
      value = JSON.parse(value);
    }
  } catch {
    return undefined;
  }
  return isRecord(value) ? value : undefined;
}

function tokenCount(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

// ---------------------------------------------------------------------------
// HTTP の失敗の分類(メッセージは固定文言。応答本文・URL・キーを載せない)
// ---------------------------------------------------------------------------

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** 中断済みか(await をまたいで読み直すため関数にする。プロパティの絞り込みを持ち越さない)。 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function abortedError(): LlmError {
  return new LlmError("llm_aborted", "the OpenAI-compatible request was aborted");
}

/** 再試行し尽くした(または再試行 0 回の)429 / 5xx / 接続失敗。 */
function exhaustedError(status: number | undefined): LlmError {
  if (status === 429) {
    return new LlmError(
      "llm_rate_limited",
      "the OpenAI-compatible endpoint rate limit was exceeded (429)",
    );
  }
  if (status !== undefined) {
    return new LlmError(
      "llm_unavailable",
      `the OpenAI-compatible endpoint returned a server error (${status})`,
    );
  }
  return new LlmError(
    "llm_unavailable",
    "could not connect to the OpenAI-compatible endpoint",
  );
}

function errorForStatus(
  status: number,
  errorCode: string | undefined,
  keySent: boolean,
): LlmError {
  if (status >= 300 && status <= 399) {
    return new LlmError(
      "llm_invalid_request",
      `the OpenAI-compatible endpoint redirected the request (${status}); set baseUrl to the final URL`,
    );
  }
  if (errorCode === "context_length_exceeded") {
    return new LlmError(
      "llm_context_window_exceeded",
      "the conversation exceeded the model context window",
    );
  }
  switch (status) {
    case 401:
      // キーを送らずに 401 なら資格情報が要る。送って 401 なら拒否された
      return keySent
        ? new LlmError(
            "llm_authentication_failed",
            "the OpenAI-compatible endpoint rejected the credentials (401)",
          )
        : new LlmError(
            "llm_credentials_missing",
            "the OpenAI-compatible endpoint requires credentials (401)",
          );
    case 403:
      return new LlmError(
        "llm_permission_denied",
        "the credentials are not allowed to use this model or endpoint (403)",
      );
    case 404:
      return new LlmError(
        "llm_invalid_request",
        "the model or endpoint was not found (404)",
      );
    case 408:
      return new LlmError(
        "llm_timeout",
        "the OpenAI-compatible endpoint timed out the request (408)",
      );
    case 409:
      return new LlmError(
        "llm_unavailable",
        "the OpenAI-compatible endpoint returned a conflict (409)",
      );
    default:
      return status >= 400 && status <= 499
        ? new LlmError(
            "llm_invalid_request",
            `the OpenAI-compatible endpoint rejected the request (${status})`,
          )
        : new LlmError(
            "llm_unexpected_response",
            `the OpenAI-compatible endpoint returned an unexpected status (${status})`,
          );
  }
}

/** エラー応答の error.code(OpenAI 形式のエラー本文。読めなければ undefined)。 */
async function errorCodeOf(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = JSON.parse(await response.text());
    if (isRecord(body) && isRecord(body["error"])) {
      const code = body["error"]["code"];
      return typeof code === "string" ? code : undefined;
    }
  } catch {
    // 本文が読めない・JSON でない
  }
  return undefined;
}

function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // SyntaxError のメッセージは本文の一部を含むため載せない
    throw new LlmError(
      "llm_unexpected_response",
      "the OpenAI-compatible response is not valid JSON",
    );
  }
}

/** Retry-After(秒または HTTP 日付)/ retry-after-ms の指示(0〜60 秒のものだけ採用)。 */
function retryAfterMs(headers: Headers | undefined): number | undefined {
  if (headers === undefined) {
    return undefined;
  }
  let value: number | undefined;
  const millis = headers.get("retry-after-ms");
  if (millis !== null) {
    const parsed = Number.parseFloat(millis);
    value = Number.isFinite(parsed) ? parsed : undefined;
  }
  const after = headers.get("retry-after");
  if (value === undefined && after !== null) {
    const seconds = Number.parseFloat(after);
    value = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(after) - Date.now();
  }
  return value !== undefined &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_RETRY_AFTER_MS
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
