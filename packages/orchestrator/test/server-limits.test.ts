/**
 * T-021 受け入れ条件5: 同時実行上限と質問長の上限が固定文言のエラーで効く(ADR-018 決定7)。
 *
 * - maxConcurrentRuns: 1 で ask を2本同時に呼ぶと、2本目は待たずに busy(固定文言)。
 *   1本目は完了し、枠が空けば次の ask は通る
 * - maxConcurrentFeedback: 1 で feedback を2本同時に呼ぶと、2本目は busy(run とは別枠。
 *   セキュリティレビュー m2)
 * - maxQuestionChars を超える質問は question_too_long(固定文言)。LLM も Gateway の
 *   ツール呼び出しも起きない。空の質問・不正な引数は invalid_request
 * - HTTP 層(セキュリティレビュー S2): JSON-RPC のバッチは 400(invalid_request)で、Gateway
 *   への呼び出しは preflight の tools/list だけ。本文が上限(既定 64 KiB)を超えたら 413
 *   (payload_too_large、connection: close)。JSON として読めない本文は 400
 * - RunLimiter / ServerLimits / InFlightRequests の単体
 */
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLogger } from "@leisen/audit";
import {
  BUSY_TEXT,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_CONCURRENT_FEEDBACK,
  DEFAULT_MAX_CONCURRENT_RUNS,
  DEFAULT_MAX_QUESTION_CHARS,
  InFlightRequests,
  MAX_QUESTION_CHARS,
  McpGatewayClient,
  Orchestrator,
  RunLimiter,
  ScriptedLlmClient,
  ServerLimits,
  createOrchestratorHttpServer,
  questionTooLongText,
  type GatewayClientFactory,
} from "../src/index.js";
import {
  ALICE_TOKEN,
  BOB_TOKEN,
  CorpusConnector,
  EXPENSE_POLICY,
  startGateway,
  type GatewayHarness,
} from "./helpers/harness.js";
import {
  RAW_BODIES,
  countingGatewayClients,
  rawPost,
  searchThenSubmit,
  startOrchestratorServer,
  type OrchestratorServerHarness,
  type OrchestratorServerOptions,
} from "./helpers/orchestrator-server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

interface ToolResult {
  readonly isError: boolean;
  readonly text: string;
  readonly structured: Record<string, unknown>;
}

async function askTool(client: Client, args: Record<string, unknown>): Promise<ToolResult> {
  const result = await client.callTool({ name: "ask", arguments: args });
  const [first] = result.content as { type: string; text: string }[];
  return {
    isError: result.isError === true,
    text: first?.text ?? "",
    structured: result.structuredContent as Record<string, unknown>,
  };
}

async function setup(
  llm: ScriptedLlmClient,
  limits: { maxConcurrentRuns?: number; maxQuestionChars?: number },
): Promise<{ gateway: GatewayHarness; server: OrchestratorServerHarness }> {
  const gateway = await startGateway({
    connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])],
  });
  cleanups.push(() => gateway.close());
  const server = await startOrchestratorServer({ gatewayUrl: gateway.url, llm, limits });
  cleanups.push(() => server.close());
  return { gateway, server };
}

describe("同時実行の上限(busy)", () => {
  it("maxConcurrentRuns: 1 で2本同時に ask すると、2本目は待たずに busy。1本目は回答し、枠が空けば通る", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const answer = searchThenSubmit();
    const llm = new ScriptedLlmClient(async (context) => {
      if (context.turnIndex === 0) {
        // 1本目の run が LLM に到達した(= 枠を持っている)ことを知らせ、ゲートが開くまで止まる
        markStarted();
        await gate;
      }
      return answer(context);
    });
    const { gateway, server } = await setup(llm, { maxConcurrentRuns: 1 });
    const alice = await server.connect(ALICE_TOKEN);
    const bob = await server.connect(BOB_TOKEN);

    const first = askTool(alice, { question: "経費精算の締め日は?" });
    await started;
    expect(server.limits.runs.active).toBe(1);
    const second = await askTool(bob, { question: "経費精算の締め日は?" });

    expect(second).toEqual({
      isError: true,
      text: BUSY_TEXT,
      structured: { errorClass: "busy" },
    });
    expect(BUSY_TEXT).toBe("混み合っています。しばらくして再度お試しください。");
    // busy の ask は Gateway のツール呼び出しも AnswerRun も作らない(bob の記録がない)
    expect(gateway.toolInvocations().some((record) => record.userId === "bob")).toBe(false);

    openGate();
    const firstResult = await first;
    expect(firstResult.isError).toBe(false);
    expect(firstResult.structured["outcome"]).toBe("resolved");
    expect(server.limits.runs.active).toBe(0);

    // 枠が空いたので次の ask は通る
    const third = await askTool(bob, { question: "経費精算の締め日は?" });
    expect(third.structured["outcome"]).toBe("resolved");
    const users = gateway
      .answerRuns()
      .filter((record) => record.finalOutcome !== "pending")
      .map((record) => record.userId);
    expect(users).toEqual(["alice", "bob"]);
  });
});

describe("feedback の同時実行の上限(busy)", () => {
  it("maxConcurrentFeedback: 1 で2本同時に feedback すると、2本目は待たずに busy。run とは別枠で、枠が空けば通る", async () => {
    let gate: Promise<void> | undefined;
    let openGate: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    // feedback の申告(Gateway の run API)だけをゲートで止める
    const factory: GatewayClientFactory = (options) => {
      const inner = new McpGatewayClient(options);
      return {
        listTools: (callOptions) => inner.listTools(callOptions),
        callTool: (name, args, meta, callOptions) => inner.callTool(name, args, meta, callOptions),
        startRun: (input, callOptions) => inner.startRun(input, callOptions),
        finishRun: (runId, input, callOptions) => inner.finishRun(runId, input, callOptions),
        async feedbackRun(runId, outcome, callOptions) {
          if (gate !== undefined) {
            markStarted();
            await gate;
          }
          return inner.feedbackRun(runId, outcome, callOptions);
        },
        close: () => inner.close(),
      };
    };
    const gateway = await startGateway({
      connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])],
    });
    cleanups.push(() => gateway.close());
    const server = await startOrchestratorServer({
      gatewayUrl: gateway.url,
      llm: new ScriptedLlmClient(searchThenSubmit()),
      limits: { maxConcurrentFeedback: 1 },
      createGatewayClient: factory,
    });
    cleanups.push(() => server.close());
    const alice = await server.connect(ALICE_TOKEN);
    const asked = await askTool(alice, { question: "経費精算の締め日は?" });
    const runId = asked.structured["runId"] as string;

    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const first = alice.callTool({ name: "feedback", arguments: { runId, outcome: "resolved" } });
    await started;
    expect(server.limits.feedback.active).toBe(1);

    const second = await alice.callTool({
      name: "feedback",
      arguments: { runId, outcome: "unresolved" },
    });
    expect(second.isError).toBe(true);
    expect(second.structuredContent).toEqual({ errorClass: "busy" });
    expect(second.content).toEqual([{ type: "text", text: BUSY_TEXT }]);
    // feedback の枠が埋まっていても ask は別枠で通る
    const another = await askTool(alice, { question: "経費精算の締め日は?" });
    expect(another.structured["outcome"]).toBe("resolved");

    openGate();
    const firstResult = await first;
    expect(firstResult.isError).not.toBe(true);
    expect(firstResult.structuredContent).toEqual({ runId, outcome: "resolved" });
    expect(server.limits.feedback.active).toBe(0);

    // 枠が空いたので次の feedback は通る
    gate = undefined;
    const third = await alice.callTool({
      name: "feedback",
      arguments: { runId, outcome: "unresolved" },
    });
    expect(third.structuredContent).toEqual({ runId, outcome: "unresolved" });
    const feedbacks = gateway
      .records()
      .flatMap((record) =>
        record.recordType === "answer_run_feedback" && record.runId === runId ? [record.userFeedback] : [],
      );
    expect(feedbacks).toEqual(["resolved", "unresolved"]);
  });
});

describe("質問長の上限(question_too_long)", () => {
  it("maxQuestionChars を超える質問は固定文言で断り、LLM も Gateway のツールも呼ばない", async () => {
    const llm = new ScriptedLlmClient(searchThenSubmit());
    const { gateway, server } = await setup(llm, { maxQuestionChars: 10 });
    const client = await server.connect(ALICE_TOKEN);
    const question = "経費精算の締め日はいつですか";

    const result = await askTool(client, { question });

    expect(result).toEqual({
      isError: true,
      text: questionTooLongText(10),
      structured: { errorClass: "question_too_long" },
    });
    expect(result.text).toBe("質問が長すぎます(10 文字まで)。短くして再度お試しください。");
    expect(result.text).not.toContain(question);
    expect(llm.requests).toHaveLength(0);
    expect(gateway.toolInvocations()).toEqual([]);
    expect(gateway.answerRuns()).toEqual([]);
  });

  it("上限ちょうどの長さ(前後の空白は数えない)は通る", async () => {
    const llm = new ScriptedLlmClient(searchThenSubmit());
    const { server } = await setup(llm, { maxQuestionChars: 10 });
    const client = await server.connect(ALICE_TOKEN);

    const result = await askTool(client, { question: "  経費精算の締め日は?  " });

    expect(result.isError).toBe(false);
    expect(result.structured["outcome"]).toBe("resolved");
  });

  it.each([
    [{ question: "   " }, "質問文を入力してください。"],
    [{ question: 42 }, "ツールの引数が不正です。"],
    [{}, "ツールの引数が不正です。"],
    [{ question: "締め日は?", userId: "alice" }, "ツールの引数が不正です。"],
  ])("空の質問・不正な引数 %j は invalid_request(%s)", async (args, text) => {
    const llm = new ScriptedLlmClient(searchThenSubmit());
    const { gateway, server } = await setup(llm, {});
    const client = await server.connect(ALICE_TOKEN);

    const result = await askTool(client, args);

    expect(result).toEqual({
      isError: true,
      text,
      structured: { errorClass: "invalid_request" },
    });
    expect(llm.requests).toHaveLength(0);
    expect(gateway.toolInvocations()).toEqual([]);
  });

  it("未知のツールは invalid_request(ツール名をエコーしない)", async () => {
    const llm = new ScriptedLlmClient(searchThenSubmit());
    const { server } = await setup(llm, {});
    const client = await server.connect(ALICE_TOKEN);

    const result = await client.callTool({ name: "dev-only-unknown-tool", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ errorClass: "invalid_request" });
    expect(JSON.stringify(result.content)).not.toContain("dev-only-unknown-tool");
  });
});

describe("HTTP 層の上限: バッチと本文サイズ(S2)", () => {
  interface HttpSetup {
    readonly gateway: GatewayHarness;
    readonly server: OrchestratorServerHarness;
    readonly llm: ScriptedLlmClient;
    readonly alpha: CorpusConnector;
    readonly counts: ReturnType<typeof countingGatewayClients>["counts"];
  }

  async function setupHttp(options: Partial<OrchestratorServerOptions> = {}): Promise<HttpSetup> {
    const alpha = new CorpusConnector("alpha", [EXPENSE_POLICY]);
    const gateway = await startGateway({ connectors: [alpha] });
    cleanups.push(() => gateway.close());
    const llm = new ScriptedLlmClient(searchThenSubmit());
    const { counts, factory } = countingGatewayClients();
    const server = await startOrchestratorServer({
      gatewayUrl: gateway.url,
      llm,
      createGatewayClient: factory,
      ...options,
    });
    cleanups.push(() => server.close());
    return { gateway, server, llm, alpha, counts };
  }

  /** 本文を文字列のまま POST する(MCP の Accept / Content-Type を付ける)。 */
  function postText(url: string, body: string): Promise<Response> {
    return fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${ALICE_TOKEN}`,
      },
      body,
    });
  }

  /** preflight(Gateway の tools/list 1回)以外に Gateway・ソース・LLM が呼ばれていない。 */
  async function expectOnlyPreflight(context: HttpSetup): Promise<void> {
    expect(context.counts).toEqual({ listTools: 1, callTool: 0, calledTools: [] });
    expect(context.gateway.toolInvocations()).toEqual([]);
    expect(context.alpha.calls).toEqual([]);
    expect(context.llm.requests).toHaveLength(0);
    expect(context.gateway.answerRuns()).toEqual([]);
  }

  it("100 件のバッチは 400(invalid_request)。Gateway への呼び出しは preflight の tools/list 1回だけで、describe も LLM も起きない", async () => {
    const context = await setupHttp();
    const batch = Array.from({ length: 100 }, (_, index) => ({
      jsonrpc: "2.0",
      id: index + 1,
      method: "tools/call",
      params:
        index % 2 === 0
          ? { name: "feedback", arguments: { runId: "dev-only-run", outcome: "resolved" } }
          : { name: "ask", arguments: { question: "経費精算の締め日は?" } },
    }));

    const response = await rawPost(context.server.url, batch, `Bearer ${ALICE_TOKEN}`);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message: "JSON-RPC batch requests are not accepted; send one message per request",
        data: { errorClass: "invalid_request" },
      },
    });
    await expectOnlyPreflight(context);
  });

  it.each([
    ["1件のバッチ", [RAW_BODIES["tools/list"]]],
    ["空のバッチ", []],
  ])("%s も 400(invalid_request)", async (_label, batch) => {
    const context = await setupHttp();
    const response = await rawPost(context.server.url, batch, `Bearer ${ALICE_TOKEN}`);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { data: unknown } }).error.data).toEqual({
      errorClass: "invalid_request",
    });
    await expectOnlyPreflight(context);
  });

  it("64 KiB を超える本文は 413(payload_too_large、connection: close)。本文をエコーせず、ツールは呼ばれない", async () => {
    const context = await setupHttp();
    // UTF-8 で 90,000 バイト(既定の上限 65,536 を超える)
    const question = "経".repeat(30_000);

    const response = await rawPost(
      context.server.url,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ask", arguments: { question } },
      },
      `Bearer ${ALICE_TOKEN}`,
    );

    expect(DEFAULT_MAX_BODY_BYTES).toBe(65_536);
    expect(response.status).toBe(413);
    expect(response.headers.get("connection")).toBe("close");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message: "the request body is too large",
        data: { errorClass: "payload_too_large" },
      },
    });
    expect(text).not.toContain("経経経");
    expect(text).not.toContain(ALICE_TOKEN);
    await expectOnlyPreflight(context);
  });

  it("Content-Length のない(chunked)本文も、受信中に上限を超えたら 413", async () => {
    const context = await setupHttp({ maxBodyBytes: 1_024 });
    const payload = new TextEncoder().encode(
      JSON.stringify({ ...RAW_BODIES["tools/list"], params: { pad: "x".repeat(8_000) } }),
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < payload.length; offset += 512) {
          controller.enqueue(payload.slice(offset, offset + 512));
        }
        controller.close();
      },
    });
    // 本文がストリームのときは duplex: "half" が要る(Node の fetch。型定義にはない)
    const init = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${ALICE_TOKEN}`,
      },
      body: stream,
      duplex: "half",
    } as RequestInit;

    const response = await fetch(context.server.url, init);

    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { data: unknown } }).error.data).toEqual({
      errorClass: "payload_too_large",
    });
    await expectOnlyPreflight(context);
  });

  it("上限(maxBodyBytes)ちょうどの本文は通り、1 バイト超えると 413", async () => {
    const body = JSON.stringify(RAW_BODIES["tools/list"]);
    const context = await setupHttp({ maxBodyBytes: Buffer.byteLength(body) });

    const exact = await postText(context.server.url, body);
    expect(exact.status).toBe(200);
    const listed = (await exact.json()) as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(["ask", "feedback"]);

    const over = await postText(context.server.url, `${body} `);
    expect(over.status).toBe(413);
  });

  it.each([
    ["JSON でない", "{dev-only-not-json"],
    ["空の本文", ""],
    ["数値", "42"],
    ["null", "null"],
    ["文字列", JSON.stringify("dev-only-text")],
  ])("%s 本文は 400(invalid_request。本文をエコーしない)", async (_label, body) => {
    const context = await setupHttp();
    const response = await postText(context.server.url, body);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message: "the request body must be a single JSON-RPC message (a JSON object)",
        data: { errorClass: "invalid_request" },
      },
    });
    expect(text).not.toContain("dev-only");
    await expectOnlyPreflight(context);
  });

  it("maxBodyBytes / preflightTimeoutMs / feedbackTimeoutMs の不正な値は構築時に拒否する", () => {
    const deps = {
      orchestrator: new Orchestrator({
        llm: new ScriptedLlmClient(searchThenSubmit()),
      }),
      gatewayUrl: "http://127.0.0.1:9/mcp",
      limits: new ServerLimits(),
    };
    expect(() => createOrchestratorHttpServer(deps, { maxBodyBytes: 0 })).toThrow(RangeError);
    expect(() => createOrchestratorHttpServer(deps, { maxBodyBytes: 1.5 })).toThrow(RangeError);
    expect(() => createOrchestratorHttpServer(deps, { preflightTimeoutMs: -1 })).toThrow(RangeError);
    expect(() =>
      createOrchestratorHttpServer({ ...deps, feedbackTimeoutMs: 0 }),
    ).toThrow(RangeError);
  });
});

describe("RunLimiter / ServerLimits", () => {
  it("空きがあるだけ枠を取り、なければ undefined(待たせない)。解放は1回だけ効く", () => {
    const limiter = new RunLimiter(2);
    const a = limiter.tryAcquire();
    const b = limiter.tryAcquire();
    expect(a).toBeTypeOf("function");
    expect(b).toBeTypeOf("function");
    expect(limiter.tryAcquire()).toBeUndefined();
    expect(limiter.active).toBe(2);
    a?.();
    a?.();
    expect(limiter.active).toBe(1);
    expect(limiter.tryAcquire()).toBeTypeOf("function");
    expect(limiter.active).toBe(2);
  });

  it("既定は 4 本・4000 文字。範囲外の設定は拒否する", () => {
    const limits = new ServerLimits();
    expect(limits.runs.maxConcurrentRuns).toBe(DEFAULT_MAX_CONCURRENT_RUNS);
    expect(DEFAULT_MAX_CONCURRENT_RUNS).toBe(4);
    expect(limits.maxQuestionChars).toBe(DEFAULT_MAX_QUESTION_CHARS);
    expect(DEFAULT_MAX_QUESTION_CHARS).toBe(4000);
    // feedback は run と別枠(既定 4)
    expect(limits.feedback.max).toBe(DEFAULT_MAX_CONCURRENT_FEEDBACK);
    expect(DEFAULT_MAX_CONCURRENT_FEEDBACK).toBe(4);
    expect(limits.feedback).not.toBe(limits.runs);
    expect(new ServerLimits({ maxConcurrentFeedback: 2 }).feedback.max).toBe(2);
    expect(() => new ServerLimits({ maxConcurrentFeedback: 0 })).toThrow(RangeError);
    expect(() => new ServerLimits({ maxConcurrentFeedback: 257 })).toThrow(RangeError);
    expect(() => new ServerLimits({ maxConcurrentRuns: 0 })).toThrow(RangeError);
    expect(() => new ServerLimits({ maxConcurrentRuns: 1.5 })).toThrow(RangeError);
    expect(() => new ServerLimits({ maxQuestionChars: 0 })).toThrow(RangeError);
    // Orchestrator 自身の上限を超える値は受けない
    expect(() => new ServerLimits({ maxQuestionChars: MAX_QUESTION_CHARS + 1 })).toThrow(RangeError);
    expect(new ServerLimits({ maxQuestionChars: MAX_QUESTION_CHARS }).maxQuestionChars).toBe(
      MAX_QUESTION_CHARS,
    );
  });
});

describe("InFlightRequests(停止時の待ち合わせ)", () => {
  function fakeResponse(): ServerResponse & EventEmitter {
    return new EventEmitter() as ServerResponse & EventEmitter;
  }

  it("応答の close で数から外し、0 になれば whenIdle が true で解決する", async () => {
    const inFlight = new InFlightRequests();
    expect(await inFlight.whenIdle(10)).toBe(true);
    const a = fakeResponse();
    const b = fakeResponse();
    inFlight.track(a);
    inFlight.track(b);
    expect(inFlight.count).toBe(2);
    const idle = inFlight.whenIdle(5_000);
    a.emit("close");
    expect(inFlight.count).toBe(1);
    b.emit("close");
    expect(await idle).toBe(true);
    expect(inFlight.count).toBe(0);
  });

  it("上限時間内に終わらなければ false", async () => {
    const inFlight = new InFlightRequests();
    const pending = fakeResponse();
    inFlight.track(pending);
    expect(await inFlight.whenIdle(20)).toBe(false);
    expect(inFlight.count).toBe(1);
  });
});
