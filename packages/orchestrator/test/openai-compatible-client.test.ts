/**
 * OpenAiCompatibleLlmClient の単体テスト(偽の fetch を注入。ネットワークに出ない)。
 * 変換の対応表(要求・応答)、finish_reason / usage の写し方、エラー分類と再試行、
 * 秘密情報(キー・ベース URL のクエリ・応答本文)を例外に載せないことを検証する。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  LlmError,
  OpenAiCompatibleLlmClient,
  type LlmRequest,
  type OpenAiCompatibleLlmClientOptions,
} from "../src/index.js";

interface FakeCall {
  readonly url: string;
  readonly init: RequestInit;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function fakeFetch(
  respond: (call: FakeCall, index: number) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const call: FakeCall = {
      url: String(input),
      init: init ?? {},
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function completion(
  message: Record<string, unknown>,
  finishReason: string | null = "stop",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "chatcmpl-unit",
    object: "chat.completion",
    created: 0,
    model: "local-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: null, refusal: null, ...message },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    ...extra,
  };
}

const TEXT_REPLY = completion({ content: "ok" });

function client(
  fetchImpl: typeof fetch,
  options: Partial<OpenAiCompatibleLlmClientOptions> = {},
): OpenAiCompatibleLlmClient {
  return new OpenAiCompatibleLlmClient({
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "local-model",
    retryBaseDelayMs: 1,
    ...options,
    fetch: fetchImpl,
  });
}

const TOOL: Anthropic.Tool = {
  name: "search",
  description: "検索する",
  strict: true,
  input_schema: {
    type: "object",
    properties: { source: { type: "string", enum: ["alpha"] }, query: { type: "string" } },
    required: ["source", "query"],
    additionalProperties: false,
  },
};

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    system: [
      { type: "text", text: "固定部", cache_control: { type: "ephemeral" } },
      { type: "text", text: "可変部" },
    ],
    messages: [{ role: "user", content: [{ type: "text", text: "質問" }] }],
    tools: [TOOL],
    maxTokens: 4_000,
    ...overrides,
  };
}

async function failureOf(promise: Promise<unknown>): Promise<LlmError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LlmError);
  return error as LlmError;
}

describe("要求の変換(Anthropic 形式 → Chat Completions)", () => {
  it("system・user・assistant(text / tool_use / thinking)・tool_result・後続テキストの対応表", async () => {
    const { fetch, calls } = fakeFetch(() => json(TEXT_REPLY));

    await client(fetch).complete(
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "質問" }] },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "", signature: "sig-dev-only" },
              { type: "text", text: "検索します。" },
              { type: "tool_use", id: "call_a", name: "search", input: { source: "alpha", query: "q" } },
              // 引数を解釈できなかった呼び出し(input: null)は {} として戻す
              { type: "tool_use", id: "call_b", name: "fetch", input: null },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_a",
                content: [
                  { type: "text", text: "前置き" },
                  { type: "text", text: '{"tool":"search"}' },
                ],
              },
              {
                type: "tool_result",
                tool_use_id: "call_b",
                is_error: true,
                content: '{"errorClass":"invalid_request","message":"ツールの引数が不正です。"}',
              },
              { type: "text", text: "[オーケストレーター] 上限です" },
            ],
          },
        ],
      }),
    );

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.redirect).toBe("manual");
    expect(call?.headers["content-type"]).toBe("application/json");
    expect(call?.headers).not.toHaveProperty("authorization");
    expect(call?.body["messages"]).toEqual([
      { role: "system", content: "固定部\n\n可変部" },
      { role: "user", content: "質問" },
      {
        role: "assistant",
        content: "検索します。",
        tool_calls: [
          {
            id: "call_a",
            type: "function",
            function: { name: "search", arguments: '{"source":"alpha","query":"q"}' },
          },
          { id: "call_b", type: "function", function: { name: "fetch", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_a", content: '前置き\n{"tool":"search"}' },
      {
        role: "tool",
        tool_call_id: "call_b",
        content: '{"errorClass":"invalid_request","message":"ツールの引数が不正です。"}',
      },
      { role: "user", content: "[オーケストレーター] 上限です" },
    ]);
  });

  it("tools は function 形式(strict を付けない)、tool_choice auto、max_tokens、stream: false", async () => {
    const { fetch, calls } = fakeFetch(() => json(TEXT_REPLY));

    await client(fetch).complete(request());

    const body = calls[0]?.body;
    expect(body).toEqual({
      model: "local-model",
      messages: [
        { role: "system", content: "固定部\n\n可変部" },
        { role: "user", content: "質問" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "search",
            description: "検索する",
            parameters: TOOL.input_schema,
          },
        },
      ],
      tool_choice: "auto",
      max_tokens: 4_000,
      stream: false,
    });
  });

  it("ツールがなければ tools / tool_choice を送らない", async () => {
    const { fetch, calls } = fakeFetch(() => json(TEXT_REPLY));
    await client(fetch).complete(request({ tools: [] }));
    expect(calls[0]?.body).not.toHaveProperty("tools");
    expect(calls[0]?.body).not.toHaveProperty("tool_choice");
  });

  it("reasoning_effort は設定があり、要求が effort を求めたときだけ送る", async () => {
    const { fetch, calls } = fakeFetch(() => json(TEXT_REPLY));
    const withEffort = client(fetch, { reasoningEffort: "high" });

    await withEffort.complete(request({ effort: true }));
    await withEffort.complete(request());
    await client(fetch).complete(request({ effort: true, thinking: "adaptive" }));

    expect(calls[0]?.body["reasoning_effort"]).toBe("high");
    expect(calls[1]?.body).not.toHaveProperty("reasoning_effort");
    expect(calls[2]?.body).not.toHaveProperty("reasoning_effort");
    // thinking は Chat Completions に標準の指定がないため送らない
    expect(calls[2]?.body).not.toHaveProperty("thinking");
  });

  it("写せないブロック(画像など)は送らずに llm_invalid_request", async () => {
    const { fetch, calls } = fakeFetch(() => json(TEXT_REPLY));
    const error = await failureOf(
      client(fetch).complete(
        request({
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "url", url: "https://example.test/dev-only.png" } },
              ],
            },
          ],
        }),
      ),
    );
    expect(error.errorClass).toBe("llm_invalid_request");
    expect(calls).toHaveLength(0);
  });

  it("末尾が assistant の履歴(prefill)は送らない", async () => {
    const { fetch, calls } = fakeFetch(() => json(TEXT_REPLY));
    const error = await failureOf(
      client(fetch).complete(
        request({
          messages: [
            { role: "user", content: "質問" },
            { role: "assistant", content: "回答: " },
          ],
        }),
      ),
    );
    expect(error.errorClass).toBe("llm_invalid_request");
    expect(calls).toHaveLength(0);
  });

  it("ベース URL の末尾スラッシュ・クエリを保って /chat/completions を足す(endpoint にクエリを出さない)", async () => {
    const { fetch, calls } = fakeFetch(() => json(TEXT_REPLY));
    const llm = client(fetch, { baseUrl: "http://127.0.0.1:1234/v1/?api-version=dev-only" });

    await llm.complete(request());

    expect(calls[0]?.url).toBe("http://127.0.0.1:1234/v1/chat/completions?api-version=dev-only");
    expect(llm.endpoint).toBe("http://127.0.0.1:1234/v1/chat/completions");
  });
});

describe("応答の変換(Chat Completions → Anthropic 形式)", () => {
  it("content → text、tool_calls → tool_use(arguments を JSON として読む)、tool_calls → tool_use", async () => {
    const { fetch } = fakeFetch(() =>
      json(
        completion(
          {
            content: "調べます。",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "search", arguments: '{"source":"alpha","query":"締め日"}' },
              },
              // 仕様外だが意味が一意な形: オブジェクトのまま / 二重に JSON 化された文字列 / 空文字
              { id: "call_2", type: "function", function: { name: "list", arguments: { source: "alpha" } } },
              {
                id: "call_3",
                type: "function",
                function: { name: "fetch", arguments: JSON.stringify('{"source":"alpha","documentId":"d1"}') },
              },
              { id: "call_4", function: { name: "describe", arguments: "" } },
            ],
          },
          "tool_calls",
        ),
      ),
    );

    const turn = await client(fetch).complete(request());

    expect(turn.message.stop_reason).toBe("tool_use");
    expect(turn.message.model).toBe("local-model");
    expect(turn.message.content).toEqual([
      { type: "text", text: "調べます。", citations: null },
      { type: "tool_use", id: "call_1", name: "search", input: { source: "alpha", query: "締め日" }, caller: { type: "direct" } },
      { type: "tool_use", id: "call_2", name: "list", input: { source: "alpha" }, caller: { type: "direct" } },
      { type: "tool_use", id: "call_3", name: "fetch", input: { source: "alpha", documentId: "d1" }, caller: { type: "direct" } },
      { type: "tool_use", id: "call_4", name: "describe", input: {}, caller: { type: "direct" } },
    ]);
    expect(turn.invalidToolUseIds).toBeUndefined();
  });

  it.each([
    ["壊れた JSON", '{"source": "alpha", "query":'],
    ["配列", "[1, 2]"],
    ["数値", "42"],
  ])("arguments が%sなら input を null にして invalidToolUseIds に入れる(落とさない)", async (_label, raw) => {
    const { fetch } = fakeFetch(() =>
      json(
        completion(
          { tool_calls: [{ id: "call_bad", type: "function", function: { name: "search", arguments: raw } }] },
          "tool_calls",
        ),
      ),
    );

    const turn = await client(fetch).complete(request());

    expect(turn.message.content).toEqual([
      { type: "tool_use", id: "call_bad", name: "search", input: null, caller: { type: "direct" } },
    ]);
    expect(turn.invalidToolUseIds).toEqual(["call_bad"]);
  });

  it("tool_call の id が無い・重複する場合は一意な id を振り直す", async () => {
    const { fetch } = fakeFetch(() =>
      json(
        completion(
          {
            tool_calls: [
              { type: "function", function: { name: "search", arguments: "{}" } },
              { id: "dup", type: "function", function: { name: "search", arguments: "{}" } },
              { id: "dup", type: "function", function: { name: "search", arguments: "{}" } },
            ],
          },
          "tool_calls",
        ),
      ),
    );

    const turn = await client(fetch).complete(request());

    const ids = turn.message.content.map((block) => (block.type === "tool_use" ? block.id : ""));
    expect(new Set(ids).size).toBe(3);
    expect(ids[1]).toBe("dup");
    expect(ids[0]).toMatch(/^call_kp_/);
    expect(ids[2]).toMatch(/^call_kp_/);
  });

  it.each([
    ["stop(tool_calls なし)", "stop", false, "end_turn"],
    ["stop(tool_calls あり。stop を返すサーバー)", "stop", true, "tool_use"],
    ["null(tool_calls なし)", null, false, "end_turn"],
    ["function_call(旧形式)", "function_call", true, "tool_use"],
  ] as const)("finish_reason %s → %s", async (_label, finishReason, withCalls, stopReason) => {
    const { fetch } = fakeFetch(() =>
      json(
        completion(
          withCalls
            ? { tool_calls: [{ id: "c", type: "function", function: { name: "search", arguments: "{}" } }] }
            : { content: "ok" },
          finishReason,
        ),
      ),
    );
    const turn = await client(fetch).complete(request());
    expect(turn.message.stop_reason).toBe(stopReason);
  });

  it.each([
    ["length", "llm_max_tokens", undefined],
    ["content_filter", "llm_refusal", "content_filter"],
    ["eos_unknown", "llm_unexpected_response", undefined],
  ] as const)("finish_reason %s は content を読まずに %s", async (finishReason, errorClass, category) => {
    const { fetch } = fakeFetch(() =>
      json(
        completion(
          { content: "dev-only-partial", tool_calls: [{ id: "c", type: "function", function: { name: "search", arguments: '{"sou' } }] },
          finishReason,
        ),
      ),
    );
    const error = await failureOf(client(fetch).complete(request()));
    expect(error.errorClass).toBe(errorClass);
    expect(error.refusalCategory).toBe(category);
    expect(error.message).not.toContain("dev-only");
  });

  it("message.refusal があれば llm_refusal", async () => {
    const { fetch } = fakeFetch(() => json(completion({ refusal: "dev-only-refusal-text" })));
    const error = await failureOf(client(fetch).complete(request()));
    expect(error.errorClass).toBe("llm_refusal");
    expect(error.message).not.toContain("dev-only");
  });

  it.each([
    ["function 以外の tool_call(custom)", { tool_calls: [{ id: "c", type: "custom", custom: { name: "x", input: "" } }] }],
    ["関数名のない tool_call", { tool_calls: [{ id: "c", type: "function", function: { arguments: "{}" } }] }],
  ])("%s は llm_unexpected_response", async (_label, message) => {
    const { fetch } = fakeFetch(() => json(completion(message, "tool_calls")));
    expect((await failureOf(client(fetch).complete(request()))).errorClass).toBe(
      "llm_unexpected_response",
    );
  });

  it("usage: prompt_tokens からキャッシュ分を分け、completion_tokens を出力に写す", async () => {
    const { fetch } = fakeFetch(() =>
      json(
        completion({ content: "ok" }, "stop", {
          usage: {
            prompt_tokens: 100,
            completion_tokens: 10,
            total_tokens: 110,
            prompt_tokens_details: { cached_tokens: 40 },
          },
        }),
      ),
    );
    const turn = await client(fetch).complete(request());
    expect(turn.message.usage).toMatchObject({
      input_tokens: 60,
      output_tokens: 10,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 0,
    });
    expect(turn.attempts).toBeUndefined();
  });

  it("usage を返さない応答は、トークン 0・費用不明(usageMissing)として返す", async () => {
    const { fetch } = fakeFetch(() => json(completion({ content: "ok" }, "stop", { usage: undefined, model: undefined })));
    const turn = await client(fetch).complete(request());
    expect(turn.message.model).toBe("local-model"); // 応答に model が無ければ設定の値
    expect(turn.attempts).toEqual([
      {
        model: "local-model",
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        usageMissing: true,
      },
    ]);
  });

  it.each([
    ["choices が空", { id: "x", choices: [] }, "llm_unexpected_response"],
    ["choices が無い", { id: "x" }, "llm_unexpected_response"],
    ["200 でエラー本文", { error: { message: "dev-only-model-crashed" } }, "llm_unavailable"],
  ])("%s は %s(本文を載せない)", async (_label, body, errorClass) => {
    const { fetch } = fakeFetch(() => json(body));
    const error = await failureOf(client(fetch).complete(request()));
    expect(error.errorClass).toBe(errorClass);
    expect(error.message).not.toContain("dev-only");
  });

  it("JSON でない応答本文は llm_unexpected_response(本文の断片を載せない)", async () => {
    const { fetch } = fakeFetch(
      () => new Response("dev-only-not-json <html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    const error = await failureOf(client(fetch).complete(request()));
    expect(error.errorClass).toBe("llm_unexpected_response");
    expect(error.message).not.toContain("dev-only");
  });
});

describe("HTTP の失敗の分類と再試行", () => {
  it.each([
    [401, undefined, false, "llm_credentials_missing"],
    [401, undefined, true, "llm_authentication_failed"],
    [403, undefined, false, "llm_permission_denied"],
    [404, undefined, false, "llm_invalid_request"],
    [400, undefined, false, "llm_invalid_request"],
    [400, "context_length_exceeded", false, "llm_context_window_exceeded"],
    [422, undefined, false, "llm_invalid_request"],
    [408, undefined, false, "llm_timeout"],
    [409, undefined, false, "llm_unavailable"],
    [307, undefined, false, "llm_invalid_request"],
  ] as const)("%i(code: %s、キー送信: %s)→ %s(再試行しない)", async (status, code, withKey, errorClass) => {
    const { fetch, calls } = fakeFetch(() =>
      json({ error: { message: "dev-only-detail", code: code ?? null } }, status),
    );
    const llm = client(fetch, {
      maxRetries: 2,
      ...(withKey ? { apiKeyEnv: "KP_TEST_KEY", env: { KP_TEST_KEY: "dev-only-key" } } : {}),
    });

    const error = await failureOf(llm.complete(request()));

    expect(error.errorClass).toBe(errorClass);
    expect(calls).toHaveLength(1);
    expect(error.message).not.toContain("dev-only");
  });

  it("429 は再試行し、続けて成功すれば応答を返す", async () => {
    const { fetch, calls } = fakeFetch((_call, index) =>
      index === 0 ? json({ error: { message: "slow down" } }, 429) : json(TEXT_REPLY),
    );
    const turn = await client(fetch, { maxRetries: 1 }).complete(request());
    expect(turn.message.content).toEqual([{ type: "text", text: "ok", citations: null }]);
    expect(calls).toHaveLength(2);
  });

  it.each([
    [429, "llm_rate_limited"],
    [503, "llm_unavailable"],
  ] as const)("%i が再試行後も続けば %s(試行は maxRetries + 1 回)", async (status, errorClass) => {
    const { fetch, calls } = fakeFetch(() => json({ error: { message: "dev-only" } }, status));
    const error = await failureOf(client(fetch, { maxRetries: 2 }).complete(request()));
    expect(error.errorClass).toBe(errorClass);
    expect(calls).toHaveLength(3);
  });

  it("接続失敗は再試行し、続けば llm_unavailable", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      throw new TypeError("fetch failed: connect ECONNREFUSED dev-only-host");
    }) as typeof fetch;
    const error = await failureOf(client(fetchImpl, { maxRetries: 2 }).complete(request()));
    expect(error.errorClass).toBe("llm_unavailable");
    expect(error.message).not.toContain("dev-only");
    expect(attempts).toBe(3);
  });

  it("1リクエストのタイムアウトは再試行せず llm_timeout", async () => {
    let attempts = 0;
    const hanging = ((_input: unknown, init?: RequestInit) => {
      attempts += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }) as typeof fetch;
    const error = await failureOf(
      client(hanging, { timeoutMs: 20, maxRetries: 2 }).complete(request()),
    );
    expect(error.errorClass).toBe("llm_timeout");
    expect(attempts).toBe(1);
  });

  it("呼び出し側の中断(送信中・再試行の待機中)は llm_aborted", async () => {
    const hanging = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const inFlight = new AbortController();
    const pending = client(hanging).complete(request(), { signal: inFlight.signal });
    inFlight.abort();
    expect((await failureOf(pending)).errorClass).toBe("llm_aborted");

    const { fetch } = fakeFetch(() => json({ error: { message: "busy" } }, 503));
    const backoff = new AbortController();
    const waiting = client(fetch, { maxRetries: 3, retryBaseDelayMs: 10_000 }).complete(request(), {
      signal: backoff.signal,
    });
    setTimeout(() => backoff.abort(), 20);
    const started = Date.now();
    expect((await failureOf(waiting)).errorClass).toBe("llm_aborted");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("資格情報と設定", () => {
  it("apiKeyEnv の環境変数を Authorization: Bearer で送る(前後の空白は除く)", async () => {
    const { fetch, calls } = fakeFetch(() => json(TEXT_REPLY));
    await client(fetch, {
      apiKeyEnv: "KP_TEST_KEY",
      env: { KP_TEST_KEY: "  dev-only-key\n" },
      extraHeaders: { "x-kp-route": "dev-only-route" },
    }).complete(request());
    expect(calls[0]?.headers["authorization"]).toBe("Bearer dev-only-key");
    expect(calls[0]?.headers["x-kp-route"]).toBe("dev-only-route");
  });

  it.each([
    ["未設定", {}],
    ["空", { KP_TEST_KEY: "" }],
    ["空白を含む", { KP_TEST_KEY: "dev only key" }],
  ])("apiKeyEnv の環境変数が%sなら送信前に llm_credentials_missing", async (_label, env) => {
    const { fetch, calls } = fakeFetch(() => json(TEXT_REPLY));
    const error = await failureOf(
      client(fetch, { apiKeyEnv: "KP_TEST_KEY", env }).complete(request()),
    );
    expect(error.errorClass).toBe("llm_credentials_missing");
    expect(calls).toHaveLength(0);
  });

  it("例外のメッセージにキー・ベース URL のクエリ・応答本文を含めない", async () => {
    const { fetch } = fakeFetch(() =>
      json({ error: { message: "dev-only-body-detail" } }, 400),
    );
    const error = await failureOf(
      client(fetch, {
        baseUrl: "http://127.0.0.1:1234/v1?token=dev-only-query-secret",
        apiKeyEnv: "KP_TEST_KEY",
        env: { KP_TEST_KEY: "dev-only-key-value" },
      }).complete(request()),
    );
    const rendered = `${error.message} ${String(error)} ${JSON.stringify(error)}`;
    expect(rendered).not.toContain("dev-only");
  });

  it.each([
    ["http(s) 以外のベース URL", { baseUrl: "ftp://127.0.0.1/v1" }],
    ["ループバック以外の http のベース URL", { baseUrl: "http://dev-only-gpu-box.example.test/v1" }],
    ["資格情報付きのベース URL", { baseUrl: "http://user:dev-only-password@127.0.0.1/v1" }],
    ["環境変数名でない apiKeyEnv", { apiKeyEnv: "dev-only-key-value!" }],
    ["Authorization を含む extraHeaders", { extraHeaders: { Authorization: "Bearer dev-only-key" } }],
    ["改行を含む extraHeaders の値", { extraHeaders: { "x-kp-route": "dev-only\r\nx-injected: 1" } }],
    ["ASCII 以外の extraHeaders の値", { extraHeaders: { "x-kp-route": "dev-only-経路" } }],
    ["空のモデル名", { model: "" }],
  ])("設定の検証: %s は拒否(入力値をメッセージに含めない)", (_label, options) => {
    let thrown: unknown;
    try {
      client(fakeFetch(() => json(TEXT_REPLY)).fetch, options);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(String(thrown)).not.toContain("dev-only");
  });

  it("ベース URL は https、http はループバック(localhost / 127.0.0.1 / [::1])だけを受ける", () => {
    const { fetch } = fakeFetch(() => json(TEXT_REPLY));
    for (const baseUrl of [
      "https://llm.example.test/v1",
      "http://localhost:1234/v1",
      "http://127.0.0.1:1234/v1",
      "http://[::1]:1234/v1",
    ]) {
      expect(client(fetch, { baseUrl }).endpoint).toBe(`${baseUrl}/chat/completions`);
    }
  });

  it("能力フラグ: strict・思考・キャッシュは非対応、effort は reasoningEffort 設定時のみ", () => {
    const { fetch } = fakeFetch(() => json(TEXT_REPLY));
    expect(client(fetch).capabilities).toEqual({
      strictTools: false,
      thinking: "none",
      effort: false,
      parallelToolCalls: false,
      promptCaching: false,
    });
    expect(client(fetch, { reasoningEffort: "low", maxContextTokens: 32_768 }).capabilities).toMatchObject({
      effort: true,
      maxContextTokens: 32_768,
    });
    expect(client(fetch).provider).toBe("openai_compatible");
  });
});
