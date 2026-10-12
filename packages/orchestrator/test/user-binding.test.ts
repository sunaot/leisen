/**
 * AnswerRun の主体を Gateway が認証した userId に束縛する(T-007 セキュリティレビュー
 * 2026-09-27 H1。ADR-019 で Gateway が書くことにより構造的に成り立つ)。
 * - AnswerRun(pending)は run の開始(POST /runs)で Gateway が認証値の userId で書く。
 *   Orchestrator からは指定できない。startedAt は Gateway の時刻
 * - 呼び出し元の申告(RunInput.userId)が describe の結果の `_meta` の userId と食い違えば
 *   fail-closed: run を error(failureReason: user_mismatch)で閉じ、LLM・検索に進まない
 * - describe フェーズで利用者を確認できなければ(報告なし・食い違い・HTTP の認証失敗)
 *   探索せず error で閉じる(run は Gateway に認証値で残る)
 * - run の途中で別の利用者が報告されたら user_mismatch で止める
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  Orchestrator,
  OrchestratorError,
  ScriptedLlmClient,
  scriptedSubmit,
  scriptedToolUse,
  type FinishRunInput,
  type GatewayCallOptions,
  type GatewayCallOutcome,
  type GatewayClient,
  type GatewayToolSchema,
  type StartRunResult,
} from "../src/index.js";
import {
  ALICE_TOKEN,
  BOB_TOKEN,
  CorpusConnector,
  EXPENSE_POLICY,
  startGateway,
  type GatewayHarness,
} from "./helpers/harness.js";
import { FakeGatewayClient, describeOk, searchHit } from "./helpers/fake-gateway.js";
import { firstHit } from "./helpers/script.js";

const harnesses: GatewayHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

async function setup(now?: () => number): Promise<GatewayHarness> {
  const harness = await startGateway({
    connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])],
    ...(now !== undefined ? { now } : {}),
  });
  harnesses.push(harness);
  return harness;
}

function resolvingScript(): ScriptedLlmClient {
  return new ScriptedLlmClient([
    () => scriptedToolUse([{ name: "search", input: { source: "alpha", query: "締め日" } }]),
    (context) => {
      const hit = firstHit(context);
      return scriptedSubmit({
        answer: "経費精算の締め日は毎月25日です。",
        citations: [{ documentId: hit.documentId, sourceId: hit.source }],
        confidence: 0.9,
      });
    },
  ]);
}

describe("H1: AnswerRun.userId は Gateway が認証した値", () => {
  it("申告がなければ Gateway が認証した userId で記録される(ToolInvocation と runId・userId で結合できる)", async () => {
    const harness = await setup();
    const orchestrator = new Orchestrator({ llm: resolvingScript() });

    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      gateway: harness.client(BOB_TOKEN),
    });

    expect(answer.outcome).toBe("resolved");
    const runs = harness.answerRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: answer.runId, userId: "bob", finalOutcome: "resolved" });
    const invocations = harness.toolInvocations(answer.runId);
    expect(invocations.length).toBeGreaterThan(0);
    expect(invocations.every((r) => r.userId === "bob")).toBe(true);
  });

  it("申告が Gateway の認証と食い違えば fail-closed(error・user_mismatch。LLM を呼ばず、describe より後の Gateway 呼び出しもしない)", async () => {
    const harness = await setup();
    const llm = resolvingScript();
    const orchestrator = new Orchestrator({ llm });

    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      userId: "alice", // bob のセッションで alice を名乗る
      gateway: harness.client(BOB_TOKEN),
    });

    expect(answer.outcome).toBe("error");
    expect(answer.answer).toContain("user_mismatch");
    expect(answer.citations).toEqual([]);
    expect(llm.requests).toHaveLength(0);
    expect(harness.toolInvocations(answer.runId).map((r) => r.tool)).toEqual(["describe"]);
    // 記録する主体は申告(alice)ではなく Gateway が認証した bob(Gateway が書く)
    expect(harness.answerRuns()).toEqual([
      expect.objectContaining({
        runId: answer.runId,
        userId: "bob",
        finalOutcome: "error",
        failureReason: "user_mismatch",
      }),
    ]);
    // 申告した利用者(alice)は、この run にフィードバックできない(runId は bob に束縛)
    await expect(
      harness.client(ALICE_TOKEN).feedbackRun(answer.runId, "resolved"),
    ).rejects.toMatchObject({ errorClass: "run_not_accepted" });
  });

  it("AnswerRun(pending)は run の開始(describe より前)に Gateway が書き、startedAt は Gateway の時刻", async () => {
    const events: string[] = [];
    // Gateway の時計: 最初のツール呼び出しが届くまでは 09:00:00(run の開始)、以降は 09:00:07
    const harness = await setup(() =>
      events.includes("gateway:describe")
        ? Date.parse("2026-09-27T09:00:07.000Z")
        : Date.parse("2026-09-27T09:00:00.000Z"),
    );
    const inner = harness.client();
    const gateway: GatewayClient = {
      listTools: (options?: GatewayCallOptions): Promise<readonly GatewayToolSchema[]> =>
        inner.listTools(options),
      callTool: (name, args, meta, options): Promise<GatewayCallOutcome> => {
        events.push(`gateway:${name}`);
        return inner.callTool(name, args, meta, options);
      },
      startRun: (input, options): Promise<StartRunResult> => {
        events.push("run:start");
        return inner.startRun(input, options);
      },
      finishRun: (runId, input: FinishRunInput, options) => {
        events.push(`run:finish:${input.outcome}`);
        return inner.finishRun(runId, input, options);
      },
      feedbackRun: (runId, outcome, options) => inner.feedbackRun(runId, outcome, options),
      close: () => inner.close(),
    };

    // Orchestrator の時計も Gateway と同じ日付にそろえる(runId の有効期間の判定に使う)
    await new Orchestrator({ llm: resolvingScript(), now: () => Date.parse("2026-09-27T09:00:00.000Z") }).run({
      question: "経費精算の締め日は?",
      userId: "alice",
      gateway,
    });

    expect(events).toEqual(["run:start", "gateway:describe", "gateway:search", "run:finish:resolved"]);
    expect(harness.records()[0]?.recordType).toBe("answer_run");
    expect(harness.answerRuns()[0]).toMatchObject({
      userId: "alice",
      startedAt: "2026-09-27T09:00:00.000Z",
      endedAt: "2026-09-27T09:00:07.000Z",
    });
  });

  it("申告の userId が空文字なら invalid_input(Gateway にアクセスしない)", async () => {
    const gateway = new FakeGatewayClient(["alpha"], () => describeOk("alpha", "alice"));
    const orchestrator = new Orchestrator({ llm: new ScriptedLlmClient([]) });
    await expect(
      orchestrator.run({ question: "q", userId: "  ", gateway }),
    ).rejects.toBeInstanceOf(OrchestratorError);
    expect(gateway.calls).toEqual([]);
    expect(gateway.started).toEqual([]);
  });
});

describe("H1: 利用者を確認できないときは探索せず error で閉じる", () => {
  function finishOf(gateway: FakeGatewayClient) {
    return gateway.finished.map((f) => [f.input.outcome, f.input.failureReason]);
  }

  it("Gateway が describe の結果で利用者を報告しなければ error(user_unverified)。LLM を呼ばず、run は error で閉じる", async () => {
    const llm = new ScriptedLlmClient([]);
    const gateway = new FakeGatewayClient(["alpha"], () => describeOk("alpha"));

    const answer = await new Orchestrator({ llm }).run({
      question: "経費精算の締め日は?",
      userId: "alice",
      gateway,
    });

    expect(answer.outcome).toBe("error");
    expect(answer.answer).toContain("user_unverified");
    expect(llm.requests).toHaveLength(0);
    expect(gateway.started).toHaveLength(1);
    expect(finishOf(gateway)).toEqual([["error", "user_unverified"]]);
  });

  it("describe の結果の userId が食い違えば user_unverified で閉じる", async () => {
    const gateway = new FakeGatewayClient(["alpha", "beta"], (call) =>
      describeOk(String(call.args["source"]), call.args["source"] === "alpha" ? "alice" : "bob"),
    );

    const answer = await new Orchestrator({ llm: new ScriptedLlmClient([]) }).run({ question: "q", gateway });

    expect(answer.outcome).toBe("error");
    expect(answer.answer).toContain("user_unverified");
    expect(finishOf(gateway)).toEqual([["error", "user_unverified"]]);
  });

  it("describe フェーズで HTTP の認証に失敗したら(一部のソースだけでも)探索せず error で閉じる(run は認証済みの利用者で残る)", async () => {
    const harness = await startGateway({
      connectors: [
        new CorpusConnector("alpha", [EXPENSE_POLICY]),
        new CorpusConnector("beta", []),
      ],
    });
    harnesses.push(harness);
    const valid = harness.client();
    const revoked = harness.client("dev-only-revoked");
    let calls = 0;
    // 1件目の describe は有効なセッション、2件目は失効したトークン(401)で送る
    const gateway: GatewayClient = {
      listTools: (options) => valid.listTools(options),
      callTool: (name, args, meta, options) => {
        calls += 1;
        return (calls === 1 ? valid : revoked).callTool(name, args, meta, options);
      },
      startRun: (input, options) => valid.startRun(input, options),
      finishRun: (runId, input, options) => valid.finishRun(runId, input, options),
      feedbackRun: (runId, outcome, options) => valid.feedbackRun(runId, outcome, options),
      close: () => valid.close(),
    };
    const llm = new ScriptedLlmClient([]);

    const answer = await new Orchestrator({ llm }).run({ question: "q", gateway });

    expect(answer.outcome).toBe("error");
    expect(answer.answer).toContain("gateway_unauthenticated");
    expect(llm.requests).toHaveLength(0);
    expect(harness.answerRuns()).toEqual([
      expect.objectContaining({ userId: "alice", finalOutcome: "error", failureReason: "gateway_unauthenticated" }),
    ]);
  });

  it("run の途中で Gateway が別の利用者を報告したら user_mismatch で止める(run は認証済みの利用者で error)", async () => {
    const llm = new ScriptedLlmClient([
      () => scriptedToolUse([{ name: "search", input: { source: "alpha", query: "締め日" } }]),
      () => scriptedSubmit({ answer: "不明", citations: [], confidence: 0 }),
    ]);
    const gateway = new FakeGatewayClient(["alpha"], (call) =>
      call.name === "describe"
        ? describeOk("alpha", "alice")
        : searchHit("alpha", "doc-1", "mallory"),
    );

    const answer = await new Orchestrator({ llm }).run({ question: "q", gateway });

    expect(answer.outcome).toBe("error");
    expect(answer.answer).toContain("user_mismatch");
    // 食い違った結果は台帳に入れず、LLM にも渡さない(2ターン目を呼ばない)
    expect(llm.requests).toHaveLength(1);
    expect(finishOf(gateway)).toEqual([["error", "user_mismatch"]]);
  });
});
