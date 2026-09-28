/**
 * T-021 受け入れ条件5: 同時実行上限と質問長の上限が固定文言のエラーで効く(ADR-018 決定7)。
 *
 * - maxConcurrentRuns: 1 で ask を2本同時に呼ぶと、2本目は待たずに busy(固定文言)。
 *   1本目は完了し、枠が空けば次の ask は通る
 * - maxQuestionChars を超える質問は question_too_long(固定文言)。LLM も Gateway の
 *   ツール呼び出しも起きない。空の質問・不正な引数は invalid_request
 * - RunLimiter / ServerLimits / InFlightRequests の単体
 */
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUSY_TEXT,
  DEFAULT_MAX_CONCURRENT_RUNS,
  DEFAULT_MAX_QUESTION_CHARS,
  InFlightRequests,
  MAX_QUESTION_CHARS,
  RunLimiter,
  ScriptedLlmClient,
  ServerLimits,
  questionTooLongText,
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
  searchThenSubmit,
  startOrchestratorServer,
  type OrchestratorServerHarness,
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
    const users = (await server.answerRunLines())
      .filter((record) => record.finalOutcome !== "pending")
      .map((record) => record.userId);
    expect(users).toEqual(["alice", "bob"]);
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
    expect(await server.answerRunLines()).toEqual([]);
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
