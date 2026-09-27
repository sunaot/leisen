/**
 * OpenAI 互換 Chat Completions のモックサーバー(テスト内蔵。CI で OpenAI 互換経路を固定する)。
 *
 * `POST /v1/chat/completions` を受け、脚本(受けた要求と直前のツール結果の要約を見て次の
 * 応答を返す関数)どおりに Chat Completions 形式(choices[0].message の content /
 * tool_calls、finish_reason、usage)で応答する。実クライアントは OpenAiCompatibleLlmClient
 * を baseUrl = `${server.url}/v1` で使う(LM Studio 等と同じ形)。
 *
 * 記録するもの(検証用): 要求本文(model・messages・tools・tool_choice・max_tokens・stream・
 * reasoning_effort など)、`Authorization` ヘッダの有無とスキーム(値は記録しない)、
 * ヘッダ名の一覧。ストリーミングは実装しない(`stream: true` は 400)。
 */
import type { ScriptToolResult } from "../../src/index.js";
import type { ScriptView } from "./script.js";
import {
  isRecord,
  parseJsonOrUndefined,
  startMockHttpServer,
  type MockHttpReply,
} from "./mock-http.js";

export interface OpenAiMockRequest {
  /** パス+クエリ */
  readonly path: string;
  readonly body: Record<string, unknown>;
  /** Authorization ヘッダの有無(値は記録しない) */
  readonly hasAuthorization: boolean;
  /** Authorization のスキーム(例: Bearer)。値は記録しない */
  readonly authorizationScheme: string | undefined;
  /** 受けたヘッダ名(小文字) */
  readonly headerNames: readonly string[];
}

export interface OpenAiMockContext extends ScriptView {
  readonly request: OpenAiMockRequest;
  /** 0 始まりの要求番号 */
  readonly turnIndex: number;
}

export type OpenAiMockStep = (context: OpenAiMockContext) => MockHttpReply;

export interface MockOpenAiServer {
  readonly url: string;
  /** OpenAiCompatibleLlmClient の baseUrl に渡す値(`${url}/v1`) */
  readonly baseUrl: string;
  readonly requests: OpenAiMockRequest[];
  readonly scriptErrors: unknown[];
  close(): Promise<void>;
}

export async function startMockOpenAiServer(
  script: readonly OpenAiMockStep[] | OpenAiMockStep,
): Promise<MockOpenAiServer> {
  const requests: OpenAiMockRequest[] = [];
  const server = await startMockHttpServer((http) => {
    const pathname = new URL(http.path, "http://127.0.0.1").pathname;
    if (http.method !== "POST" || pathname !== "/v1/chat/completions") {
      return openAiError(404);
    }
    if (!isRecord(http.body)) {
      return openAiError(400);
    }
    const authorization = http.headers["authorization"];
    const request: OpenAiMockRequest = {
      path: http.path,
      body: http.body,
      hasAuthorization: typeof authorization === "string",
      authorizationScheme:
        typeof authorization === "string" ? authorization.split(" ")[0] : undefined,
      headerNames: Object.keys(http.headers),
    };
    const turnIndex = requests.length;
    requests.push(request);
    if (http.body["stream"] === true) {
      return openAiError(400);
    }
    const step = typeof script === "function" ? script : script[turnIndex];
    if (step === undefined) {
      throw new Error(`mock OpenAI script exhausted at request ${turnIndex}`);
    }
    return step({ request, turnIndex, ...openAiScriptView(http.body["messages"]) });
  });
  return {
    url: server.url,
    baseUrl: `${server.url}/v1`,
    requests,
    scriptErrors: server.scriptErrors,
    close: () => server.close(),
  };
}

// ---------------------------------------------------------------------------
// 要求(Chat Completions 形式)から直前のツール結果・user テキストを読む
// ---------------------------------------------------------------------------

/**
 * 最後の assistant メッセージ以降の tool / user メッセージを読む。tool メッセージの本文は
 * 「前置き\n{JSON}」(成功)または JSON(エラー)なので、全体→最終行の順に JSON として読む。
 * Chat Completions に is_error はないため、本文が `{ errorClass, message }` の形ならエラーとみなす。
 */
export function openAiScriptView(messages: unknown): ScriptView {
  if (!Array.isArray(messages)) {
    return { lastToolResults: [], lastUserTexts: [] };
  }
  let lastAssistant = -1;
  messages.forEach((message, index) => {
    if (isRecord(message) && message["role"] === "assistant") {
      lastAssistant = index;
    }
  });
  const calls = new Map<string, { name: string; input: unknown }>();
  const assistant: unknown = lastAssistant >= 0 ? messages[lastAssistant] : undefined;
  if (isRecord(assistant) && Array.isArray(assistant["tool_calls"])) {
    for (const call of assistant["tool_calls"]) {
      if (isRecord(call) && typeof call["id"] === "string" && isRecord(call["function"])) {
        calls.set(call["id"], {
          name: String(call["function"]["name"]),
          input: parseJsonOrUndefined(String(call["function"]["arguments"])),
        });
      }
    }
  }
  const lastToolResults: ScriptToolResult[] = [];
  const lastUserTexts: string[] = [];
  for (const message of messages.slice(lastAssistant + 1)) {
    if (!isRecord(message)) {
      continue;
    }
    if (message["role"] === "tool" && typeof message["tool_call_id"] === "string") {
      const content = typeof message["content"] === "string" ? message["content"] : "";
      const lastLine = content.split("\n").at(-1) ?? "";
      const whole = parseJsonOrUndefined(content);
      const json = whole ?? parseJsonOrUndefined(lastLine);
      const call = calls.get(message["tool_call_id"]);
      lastToolResults.push({
        toolUseId: message["tool_call_id"],
        toolName: call?.name,
        toolInput: call?.input,
        isError:
          isRecord(json) && typeof json["errorClass"] === "string" && !("tool" in json),
        text: whole !== undefined ? content : lastLine,
        json,
      });
    } else if (message["role"] === "user" && typeof message["content"] === "string") {
      lastUserTexts.push(message["content"]);
    }
  }
  return { lastToolResults, lastUserTexts };
}

// ---------------------------------------------------------------------------
// 応答の組み立て(Chat Completions 形式)
// ---------------------------------------------------------------------------

export interface OpenAiMockToolCall {
  readonly name: string;
  /** 引数(JSON 文字列にして送る) */
  readonly input?: Record<string, unknown>;
  /** arguments をそのまま送る(壊れた JSON のケース用。input より優先) */
  readonly rawArguments?: string;
  /** 省略時は連番の id */
  readonly id?: string;
}

export interface OpenAiMockUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly cached_tokens?: number;
}

export interface OpenAiMockCompletion {
  readonly content?: string | null;
  readonly toolCalls?: readonly OpenAiMockToolCall[];
  /** 既定: tool_calls があれば "tool_calls"、なければ "stop" */
  readonly finishReason?: string | null;
  /** null なら usage を省く */
  readonly usage?: OpenAiMockUsage | null;
  /** 応答の model(既定 mock-local-model) */
  readonly model?: string;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_mock_${String(idCounter).padStart(4, "0")}`;
}

export function openAiCompletion(completion: OpenAiMockCompletion): MockHttpReply {
  const toolCalls = (completion.toolCalls ?? []).map((call) => ({
    id: call.id ?? nextId("call"),
    type: "function",
    function: {
      name: call.name,
      arguments: call.rawArguments ?? JSON.stringify(call.input ?? {}),
    },
  }));
  const usage = completion.usage === null ? undefined : (completion.usage ?? {});
  const promptTokens = usage?.prompt_tokens ?? 1_200;
  const completionTokens = usage?.completion_tokens ?? 80;
  return {
    status: 200,
    body: {
      id: nextId("chatcmpl"),
      object: "chat.completion",
      created: 1_790_000_000,
      model: completion.model ?? "mock-local-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: completion.content ?? null,
            refusal: null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          logprobs: null,
          finish_reason:
            completion.finishReason !== undefined
              ? completion.finishReason
              : toolCalls.length > 0
                ? "tool_calls"
                : "stop",
        },
      ],
      ...(usage !== undefined
        ? {
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
              ...(usage.cached_tokens !== undefined
                ? { prompt_tokens_details: { cached_tokens: usage.cached_tokens } }
                : {}),
            },
          }
        : {}),
    },
  };
}

type CompletionOptions = Omit<OpenAiMockCompletion, "toolCalls" | "content">;

/** ツール呼び出し(1応答内の並列呼び出しを含む)。 */
export function openAiToolCalls(
  calls: readonly OpenAiMockToolCall[],
  options: CompletionOptions = {},
): MockHttpReply {
  return openAiCompletion({ ...options, toolCalls: calls });
}

/** submit_answer の呼び出し。 */
export function openAiSubmit(
  input: Record<string, unknown>,
  options: CompletionOptions = {},
): MockHttpReply {
  return openAiToolCalls([{ name: "submit_answer", input }], options);
}

/** テキストだけの応答。 */
export function openAiText(text: string, options: CompletionOptions = {}): MockHttpReply {
  return openAiCompletion({ ...options, content: text });
}

/** エラー応答(OpenAI 形式のエラー本文)。 */
export function openAiError(
  status: number,
  options: { readonly code?: string; readonly headers?: Readonly<Record<string, string>> } = {},
): MockHttpReply {
  return {
    status,
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
    body: {
      error: {
        message: "mock error from the OpenAI-compatible mock",
        type: "invalid_request_error",
        code: options.code ?? null,
      },
    },
  };
}
