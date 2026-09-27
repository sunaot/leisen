/**
 * Anthropic Messages API のモックサーバー(テスト内蔵。CI で Anthropic 経路を固定する)。
 *
 * `POST /v1/messages`(beta の `?beta=true` を含む)を受け、脚本(受けた要求と直前の
 * user ターンの要約を見て次の応答を返す関数)どおりに Messages API 形式(content blocks・
 * stop_reason・usage)で応答する。実クライアントは公式 SDK をこのサーバーへ向けて使う
 * (`new Anthropic({ baseURL: server.url, apiKey: "dev-only-key" })`)。
 *
 * 記録するもの(検証用): 要求本文(model・tools[].strict・thinking・output_config.effort・
 * tool_choice・system など)、`x-api-key` / `Authorization` ヘッダの有無(値は記録しない)、
 * `anthropic-version` / `anthropic-beta` の値。
 *
 * ストリーミングは実装しない(AnthropicLlmClient は非ストリーミングの messages.create のみ。
 * `stream: true` の要求は 400 で拒否する)。
 */
import type { ScriptToolResult } from "../../src/index.js";
import type { ScriptView } from "./script.js";
import {
  isRecord,
  parseJsonOrUndefined,
  startMockHttpServer,
  type MockHttpReply,
} from "./mock-http.js";

export interface AnthropicMockRequest {
  readonly path: string;
  readonly body: Record<string, unknown>;
  /** x-api-key ヘッダの有無(値は記録しない) */
  readonly hasApiKey: boolean;
  /** Authorization ヘッダの有無(値は記録しない) */
  readonly hasAuthorization: boolean;
  readonly anthropicVersion: string | undefined;
  readonly anthropicBeta: string | undefined;
}

export interface AnthropicMockContext extends ScriptView {
  readonly request: AnthropicMockRequest;
  /** 0 始まりの要求番号 */
  readonly turnIndex: number;
}

export type AnthropicMockStep = (context: AnthropicMockContext) => MockHttpReply;

export interface MockAnthropicServer {
  /** SDK の baseURL に渡す値(SDK は {url}/v1/messages を呼ぶ) */
  readonly url: string;
  readonly requests: AnthropicMockRequest[];
  readonly scriptErrors: unknown[];
  close(): Promise<void>;
}

export async function startMockAnthropicServer(
  script: readonly AnthropicMockStep[] | AnthropicMockStep,
): Promise<MockAnthropicServer> {
  const requests: AnthropicMockRequest[] = [];
  const server = await startMockHttpServer((http) => {
    if (http.method !== "POST" || !http.path.startsWith("/v1/messages")) {
      return anthropicError(404, "not_found_error");
    }
    if (!isRecord(http.body)) {
      return anthropicError(400, "invalid_request_error");
    }
    const header = (name: string): string | undefined => {
      const value = http.headers[name];
      return typeof value === "string" ? value : undefined;
    };
    const request: AnthropicMockRequest = {
      path: http.path,
      body: http.body,
      hasApiKey: header("x-api-key") !== undefined,
      hasAuthorization: header("authorization") !== undefined,
      anthropicVersion: header("anthropic-version"),
      anthropicBeta: header("anthropic-beta"),
    };
    const turnIndex = requests.length;
    requests.push(request);
    if (http.body["stream"] === true) {
      return anthropicError(400, "invalid_request_error");
    }
    const step = typeof script === "function" ? script : script[turnIndex];
    if (step === undefined) {
      throw new Error(`mock Anthropic script exhausted at request ${turnIndex}`);
    }
    return step({ request, turnIndex, ...anthropicScriptView(http.body["messages"]) });
  });
  return {
    url: server.url,
    requests,
    scriptErrors: server.scriptErrors,
    close: () => server.close(),
  };
}

// ---------------------------------------------------------------------------
// 要求(Messages API 形式)から直前の user ターンを読む
// ---------------------------------------------------------------------------

function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const texts = content.flatMap((part) =>
    isRecord(part) && part["type"] === "text" && typeof part["text"] === "string"
      ? [part["text"]]
      : [],
  );
  return texts.at(-1) ?? "";
}

export function anthropicScriptView(messages: unknown): ScriptView {
  const empty: ScriptView = { lastToolResults: [], lastUserTexts: [] };
  if (!Array.isArray(messages)) {
    return empty;
  }
  const last: unknown = messages.at(-1);
  if (!isRecord(last) || last["role"] !== "user") {
    return empty;
  }
  const content = last["content"];
  if (typeof content === "string") {
    return { lastToolResults: [], lastUserTexts: [content] };
  }
  const toolUses = new Map<string, { name: string; input: unknown }>();
  for (const message of messages) {
    if (isRecord(message) && message["role"] === "assistant" && Array.isArray(message["content"])) {
      for (const block of message["content"]) {
        if (isRecord(block) && block["type"] === "tool_use" && typeof block["id"] === "string") {
          toolUses.set(block["id"], { name: String(block["name"]), input: block["input"] });
        }
      }
    }
  }
  const lastToolResults: ScriptToolResult[] = [];
  const lastUserTexts: string[] = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (!isRecord(block)) {
      continue;
    }
    if (block["type"] === "text" && typeof block["text"] === "string") {
      lastUserTexts.push(block["text"]);
    } else if (block["type"] === "tool_result" && typeof block["tool_use_id"] === "string") {
      const text = toolResultText(block["content"]);
      const use = toolUses.get(block["tool_use_id"]);
      lastToolResults.push({
        toolUseId: block["tool_use_id"],
        toolName: use?.name,
        toolInput: use?.input,
        isError: block["is_error"] === true,
        text,
        json: parseJsonOrUndefined(text),
      });
    }
  }
  return { lastToolResults, lastUserTexts };
}

// ---------------------------------------------------------------------------
// 応答の組み立て(Messages API 形式)
// ---------------------------------------------------------------------------

export interface AnthropicMockUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
}

export interface AnthropicMockMessageOptions {
  /** 応答の model(既定 claude-opus-5) */
  readonly model?: string;
  readonly usage?: AnthropicMockUsage;
  /** 先頭に thinking ブロック(本文は空、署名付き)を入れる */
  readonly thinking?: boolean;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_mock_${String(idCounter).padStart(4, "0")}`;
}

/** 任意の content・stop_reason の応答。 */
export function anthropicMessage(
  content: readonly Record<string, unknown>[],
  stopReason: string,
  options: AnthropicMockMessageOptions = {},
): MockHttpReply {
  return {
    status: 200,
    body: {
      id: nextId("msg"),
      type: "message",
      role: "assistant",
      model: options.model ?? "claude-opus-5",
      content: [
        ...(options.thinking === true
          ? [{ type: "thinking", thinking: "", signature: nextId("sig") }]
          : []),
        ...content,
      ],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: 1_000,
        output_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        ...options.usage,
      },
    },
  };
}

/** ツール呼び出し(1応答内の並列呼び出しを含む)。 */
export function anthropicToolUse(
  calls: readonly { readonly name: string; readonly input: Record<string, unknown> }[],
  options: AnthropicMockMessageOptions = {},
): MockHttpReply {
  return anthropicMessage(
    calls.map((call) => ({
      type: "tool_use",
      id: nextId("toolu"),
      name: call.name,
      input: call.input,
    })),
    "tool_use",
    options,
  );
}

/** submit_answer の呼び出し。 */
export function anthropicSubmit(
  input: Record<string, unknown>,
  options: AnthropicMockMessageOptions = {},
): MockHttpReply {
  return anthropicToolUse([{ name: "submit_answer", input }], options);
}

/** API のエラー応答(Messages API のエラー形式)。 */
export function anthropicError(status: number, type: string): MockHttpReply {
  return {
    status,
    body: { type: "error", error: { type, message: "mock error from the Anthropic mock" } },
  };
}
