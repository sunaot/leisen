/**
 * AnthropicLlmClient(薄いラッパー)のユニットテスト。
 * fetchを注入し、実API・実キーなしで検証する(不変条件6)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnthropicLlmClient, LlmError } from "../src/index.js";

const KEY_ENV = "KP_TEST_ANTHROPIC_KEY";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const WIRE_RESPONSE = {
  content: [
    { type: "text", text: "考えます" },
    { type: "tool_use", id: "tu_1", name: "search", input: { query: "q" } },
  ],
  stop_reason: "tool_use",
  usage: { input_tokens: 1000, output_tokens: 500 },
};

describe("AnthropicLlmClient", () => {
  beforeEach(() => {
    process.env[KEY_ENV] = "test-key-not-a-real-secret";
  });
  afterEach(() => {
    delete process.env[KEY_ENV];
  });

  function client(
    fetchImpl: typeof fetch,
    overrides: Partial<ConstructorParameters<typeof AnthropicLlmClient>[0]> = {},
  ) {
    return new AnthropicLlmClient({
      apiKeyEnv: KEY_ENV,
      model: "test-model",
      fetchImpl,
      retryBaseDelayMs: 1,
      ...overrides,
    });
  }

  it("APIキーの環境変数が未設定なら構築を拒否する(値はエラーに含めない)", () => {
    delete process.env[KEY_ENV];
    expect(() => client(fetch)).toThrowError(
      expect.objectContaining({ errorClass: "misconfigured" }),
    );
  });

  it("リクエストをMessages APIの形へ写像し、応答を正規化する", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init ?? {} };
      return jsonResponse(WIRE_RESPONSE);
    };
    const response = await client(fetchImpl, {
      pricing: { inputPerMTok: 3, outputPerMTok: 15 },
    }).complete({
      system: "system prompt",
      messages: [
        { role: "user", content: [{ type: "text", text: "質問" }] },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_0", name: "search", input: { q: 1 } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "tu_0",
              content: '{"hits":[]}',
              isError: true,
            },
          ],
        },
      ],
      tools: [
        {
          name: "search",
          description: "検索",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      maxTokens: 1234,
    });

    expect(captured?.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key-not-a-real-secret");
    expect(headers["anthropic-version"]).toBeDefined();
    const body = JSON.parse(String(captured?.init.body));
    expect(body).toMatchObject({
      model: "test-model",
      max_tokens: 1234,
      system: "system prompt",
      tools: [{ name: "search", input_schema: { type: "object", properties: {} } }],
    });
    expect(body.messages[2].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "tu_0",
      content: '{"hits":[]}',
      is_error: true,
    });

    expect(response.stopReason).toBe("tool_use");
    expect(response.content).toEqual([
      { type: "text", text: "考えます" },
      { type: "tool_use", id: "tu_1", name: "search", input: { query: "q" } },
    ]);
    expect(response.usage).toEqual({ inputTokens: 1000, outputTokens: 500 });
    // 1000*3/1e6 + 500*15/1e6
    expect(response.costEstimate).toBeCloseTo(0.0105, 10);
  });

  it("429は再試行し、Retry-Afterを尊重して回復する", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return jsonResponse(WIRE_RESPONSE);
    };
    const response = await client(fetchImpl).complete({
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
      tools: [],
    });
    expect(calls).toBe(2);
    expect(response.stopReason).toBe("tool_use");
  });

  it("再試行上限を超えたrate limitはllm_rate_limitedとして失敗する", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("", { status: 429 });
    await expect(
      client(fetchImpl, { maxRetries: 1 }).complete({
        system: "s",
        messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
        tools: [],
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ errorClass: "llm_rate_limited" }),
    );
  });

  it("認証拒否(401)はmisconfiguredへ正規化し、応答本文・キーを流さない", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('{"error": "bad key test-key-not-a-real-secret"}', {
        status: 401,
      });
    let caught: unknown;
    try {
      await client(fetchImpl).complete({
        system: "s",
        messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
        tools: [],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LlmError);
    const message = (caught as LlmError).message;
    expect((caught as LlmError).errorClass).toBe("misconfigured");
    expect(message).not.toContain("test-key-not-a-real-secret");
    expect(message).not.toContain("bad key");
  });

  it("タイムアウトはllm_unavailableとして失敗する", async () => {
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    await expect(
      client(fetchImpl, { timeoutMs: 5, maxRetries: 0 }).complete({
        system: "s",
        messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
        tools: [],
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ errorClass: "llm_unavailable" }),
    );
  });
});
