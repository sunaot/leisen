/**
 * AnthropicLlmClient の単体テスト。SDK の messages.create を差し替えたフェイクで、
 * リクエストの形・stop_reason の扱い・型付き例外の分類を検証する(ネットワークなし)。
 * 実 SDK を使うテストは偽の fetch を注入し、外部へは出ない。
 */
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  AnthropicLlmClient,
  LlmError,
  SERVER_SIDE_FALLBACK_BETA,
  ScriptedLlmClient,
  buildSystemPrompt,
  loadExplorePrompt,
  scriptedMessage,
  submitAnswerTool,
  type AnthropicMessagesApi,
  type LlmRequest,
} from "../src/index.js";

type CreateBody = Anthropic.MessageCreateParamsNonStreaming;
type BetaCreateBody = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

interface FakeCall {
  readonly body: CreateBody | BetaCreateBody;
  readonly options: Record<string, unknown> | undefined;
}

function fakeClient(
  respond: (body: CreateBody | BetaCreateBody) => Anthropic.Message | Anthropic.Beta.Messages.BetaMessage,
  credentials: { apiKey?: string | null } = {},
): { client: AnthropicMessagesApi; calls: FakeCall[]; betaCalls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const betaCalls: FakeCall[] = [];
  const client: AnthropicMessagesApi = {
    apiKey: credentials.apiKey ?? null,
    authToken: null,
    credentials: null,
    messages: {
      create: async (body, options) => {
        calls.push({ body, options: options as Record<string, unknown> | undefined });
        return respond(body) as Anthropic.Message;
      },
    },
    beta: {
      messages: {
        create: async (body, options) => {
          betaCalls.push({ body, options: options as Record<string, unknown> | undefined });
          return respond(body) as Anthropic.Beta.Messages.BetaMessage;
        },
      },
    },
  };
  return { client, calls, betaCalls };
}

function throwingClient(error: unknown, credentials: { apiKey?: string | null } = {}) {
  return fakeClient(() => {
    throw error;
  }, credentials).client;
}

async function request(): Promise<LlmRequest> {
  const fixed = await loadExplorePrompt();
  return {
    system: buildSystemPrompt(fixed),
    messages: [{ role: "user", content: [{ type: "text", text: "質問:\n締め日は?" }] }],
    tools: [submitAnswerTool(["alpha"])],
    maxTokens: 16_000,
  };
}

const endTurn = () =>
  scriptedMessage([{ type: "text", text: "ok", citations: null }], "end_turn").message;

async function failureOf(promise: Promise<unknown>): Promise<LlmError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LlmError);
  return error as LlmError;
}

describe("リクエストの形", () => {
  it("既定: claude-opus-5・adaptive thinking・effort high・tool_choice auto・strict ツール・固定部が先頭", async () => {
    const { client, calls } = fakeClient(endTurn);
    const llm = new AnthropicLlmClient({ client });
    const signal = new AbortController().signal;

    await llm.complete(await request(), { signal });

    expect(calls).toHaveLength(1);
    const body = calls[0]?.body as CreateBody;
    expect(body.model).toBe("claude-opus-5");
    expect(body.max_tokens).toBe(16_000);
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools?.every((tool) => "strict" in tool && tool.strict === true)).toBe(true);
    // prefill なし(末尾は user)
    expect(body.messages.at(-1)?.role).toBe("user");
    // system: 固定部だけ(キャッシュのブレークポイント付き。ソース一覧は user ターン、H3)
    const system = body.system as Anthropic.TextBlockParam[];
    expect(system).toHaveLength(1);
    expect(system[0]?.text).toBe(await loadExplorePrompt());
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });
    // 非推奨・禁止パラメータを送らない
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    // タイムアウト・再試行・中断はリクエスト単位でも渡す
    expect(calls[0]?.options).toEqual({ timeout: 60_000, maxRetries: 2, signal });
  });

  it("モデル・effort・タイムアウト・再試行回数を設定注入できる", async () => {
    const { client, calls } = fakeClient(endTurn);
    const llm = new AnthropicLlmClient({
      client,
      model: "claude-opus-5-5",
      effort: "medium",
      timeoutMs: 5_000,
      maxRetries: 0,
    });

    await llm.complete(await request());

    expect(calls[0]?.body).toMatchObject({
      model: "claude-opus-5-5",
      output_config: { effort: "medium" },
    });
    expect(calls[0]?.options).toEqual({ timeout: 5_000, maxRetries: 0 });
  });

  it("末尾が assistant の履歴(prefill)は送らずに失敗させる", async () => {
    const { client, calls } = fakeClient(endTurn);
    const llm = new AnthropicLlmClient({ client });
    const base = await request();

    const error = await failureOf(
      llm.complete({
        ...base,
        messages: [...base.messages, { role: "assistant", content: "回答: " }],
      }),
    );

    expect(error.errorClass).toBe("llm_invalid_request");
    expect(calls).toHaveLength(0);
  });
});

describe("stop_reason の扱い", () => {
  it("refusal は content を読まずに llm_refusal(カテゴリ付き)", async () => {
    const refusal = {
      ...scriptedMessage([{ type: "text", text: "部分出力", citations: null }], "refusal").message,
      stop_details: { type: "refusal" as const, category: "cyber" as const, explanation: null },
    };
    const llm = new AnthropicLlmClient({ client: fakeClient(() => refusal).client });

    const error = await failureOf(llm.complete(await request()));

    expect(error.errorClass).toBe("llm_refusal");
    expect(error.refusalCategory).toBe("cyber");
    expect(error.message).not.toContain("部分出力");
  });

  it("max_tokens は切れたツール入力を実行させないため llm_max_tokens", async () => {
    const truncated = scriptedMessage(
      [
        {
          type: "tool_use",
          id: "toolu_truncated",
          name: "submit_answer",
          input: { answer: "途中" },
          caller: { type: "direct" },
        },
      ],
      "max_tokens",
    ).message;
    const llm = new AnthropicLlmClient({ client: fakeClient(() => truncated).client });

    expect((await failureOf(llm.complete(await request()))).errorClass).toBe("llm_max_tokens");
  });

  it.each([
    ["pause_turn", "llm_pause_turn"],
    ["model_context_window_exceeded", "llm_context_window_exceeded"],
  ] as const)("%s は %s", async (stopReason, errorClass) => {
    const message = scriptedMessage([], stopReason).message;
    const llm = new AnthropicLlmClient({ client: fakeClient(() => message).client });

    expect((await failureOf(llm.complete(await request()))).errorClass).toBe(errorClass);
  });

  it("tool_use / end_turn はそのまま返す", async () => {
    const message = scriptedMessage(
      [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "search",
          input: { source: "alpha", query: "q" },
          caller: { type: "direct" },
        },
      ],
      "tool_use",
    ).message;
    const llm = new AnthropicLlmClient({ client: fakeClient(() => message).client });

    const turn = await llm.complete(await request());

    expect(turn.message).toBe(message);
    expect(turn.attempts).toBeUndefined();
  });
});

describe("SDK の型付き例外の分類(具体的なものから順に)", () => {
  const headers = new Headers({ "request-id": "req_dev_only" });
  const body = (type: string) => ({
    type: "error",
    error: { type, message: "detail from the API: dev-only-detail" },
  });

  it.each([
    [new Anthropic.RateLimitError(429, body("rate_limit_error"), undefined, headers), "llm_rate_limited"],
    [
      new Anthropic.AuthenticationError(401, body("authentication_error"), undefined, headers),
      "llm_authentication_failed",
    ],
    [
      new Anthropic.PermissionDeniedError(403, body("permission_error"), undefined, headers),
      "llm_permission_denied",
    ],
    [new Anthropic.NotFoundError(404, body("not_found_error"), undefined, headers), "llm_invalid_request"],
    [
      new Anthropic.BadRequestError(400, body("invalid_request_error"), undefined, headers),
      "llm_invalid_request",
    ],
    [
      new Anthropic.InternalServerError(529, body("overloaded_error"), undefined, headers, "overloaded_error"),
      "llm_overloaded",
    ],
    [new Anthropic.InternalServerError(500, body("api_error"), undefined, headers, "api_error"), "llm_unavailable"],
    [new Anthropic.APIConnectionTimeoutError(), "llm_timeout"],
    [new Anthropic.APIConnectionError({ message: "socket hang up" }), "llm_unavailable"],
    [new Anthropic.APIUserAbortError(), "llm_aborted"],
  ] as const)("%o → %s(API の応答本文を載せない)", async (thrown, errorClass) => {
    const llm = new AnthropicLlmClient({
      client: throwingClient(thrown, { apiKey: "dev-only-not-a-real-key" }),
    });

    const error = await failureOf(llm.complete(await request()));

    expect(error.errorClass).toBe(errorClass);
    expect(error.message).not.toContain("dev-only");
  });

  it("資格情報を解決できないときの型なしエラーは llm_credentials_missing", async () => {
    const llm = new AnthropicLlmClient({
      client: throwingClient(new Error("Could not resolve authentication method.")),
    });

    expect((await failureOf(llm.complete(await request()))).errorClass).toBe(
      "llm_credentials_missing",
    );
  });

  it("資格情報があるのに型なしエラーなら llm_client_error(資格情報の問題と取り違えない)", async () => {
    const llm = new AnthropicLlmClient({
      client: throwingClient(new TypeError("unexpected"), { apiKey: "dev-only-not-a-real-key" }),
    });

    expect((await failureOf(llm.complete(await request()))).errorClass).toBe("llm_client_error");
  });

  it("実 SDK: 401 応答は llm_authentication_failed(偽の fetch。ネットワークに出ない)", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(body("authentication_error")), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    const llm = new AnthropicLlmClient({
      client: new Anthropic({ apiKey: "dev-only-not-a-real-key", fetch, maxRetries: 0 }),
    });

    const error = await failureOf(llm.complete(await request()));

    expect(error.errorClass).toBe("llm_authentication_failed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("server-side fallbacks(既定 off の設定フラグ)", () => {
  it("既定では beta を使わない", async () => {
    const { client, calls, betaCalls } = fakeClient(endTurn);
    await new AnthropicLlmClient({ client }).complete(await request());
    expect(calls).toHaveLength(1);
    expect(betaCalls).toHaveLength(0);
  });

  it("有効時は beta ヘッダと fallbacks: \"default\" を付け、fallback ブロックを除いて返す", async () => {
    const betaMessage: Anthropic.Beta.Messages.BetaMessage = {
      id: "msg_fallback",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      container: null,
      context_management: null,
      diagnostics: null,
      stop_reason: "tool_use",
      stop_sequence: null,
      stop_details: null,
      content: [
        { type: "thinking", thinking: "", signature: "sig-declined" },
        {
          type: "fallback",
          from: { model: "claude-opus-5" },
          to: { model: "claude-opus-4-8" },
          trigger: { type: "refusal", category: "cyber" },
        } as unknown as Anthropic.Beta.Messages.BetaContentBlock, // テスト用に最小限の形で組み立てる
        { type: "thinking", thinking: "", signature: "sig-served" },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "search",
          input: { source: "alpha", query: "q" },
        },
      ],
      usage: {
        cache_creation: null,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        fallback_credit: null,
        inference_geo: null,
        input_tokens: 100,
        output_tokens: 20,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: null,
        speed: null,
        iterations: [
          {
            type: "message",
            model: "claude-opus-5",
            input_tokens: 100,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation: null,
          },
          {
            type: "fallback_message",
            model: "claude-opus-4-8",
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation: null,
          },
        ] as unknown as Anthropic.Beta.Messages.BetaIterationsUsage,
      },
    };
    const { client, calls, betaCalls } = fakeClient(() => betaMessage);
    const llm = new AnthropicLlmClient({ client, serverSideFallbacks: true });

    const turn = await llm.complete(await request());

    expect(calls).toHaveLength(0);
    expect(betaCalls[0]?.body).toMatchObject({
      betas: [SERVER_SIDE_FALLBACK_BETA],
      fallbacks: "default",
      model: "claude-opus-5",
      thinking: { type: "adaptive" },
    });
    // fallback ブロックと、それより前(辞退したモデル)の thinking は履歴に戻さない
    expect(turn.message.content.map((b) => b.type)).toEqual(["thinking", "tool_use"]);
    expect(turn.message.content[0]).toMatchObject({ signature: "sig-served" });
    // 課金は試行ごと(辞退した試行を含む)
    expect(turn.attempts?.map((a) => a.model)).toEqual(["claude-opus-5", "claude-opus-4-8"]);
  });
});

describe("ScriptedLlmClient", () => {
  it("中断シグナルで llm_aborted になる", async () => {
    const controller = new AbortController();
    const llm = new ScriptedLlmClient(
      () => new Promise(() => undefined), // 返らないステップ
    );
    const pending = llm.complete(await request(), { signal: controller.signal });
    controller.abort();
    expect((await failureOf(pending)).errorClass).toBe("llm_aborted");
  });
});
