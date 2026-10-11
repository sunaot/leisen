/**
 * AnswerRun の主体を Gateway が認証した userId に束縛する(T-007 セキュリティレビュー
 * 2026-09-27 H1)。
 * - describe の結果の `_meta`(GATEWAY_RESULT_META_KEYS.userId)から利用者を得て、AnswerRun
 *   (pending)はその後に書く。startedAt は run の開始時刻
 * - 呼び出し元の申告(RunInput.userId)が食い違えば fail-closed: run を error
 *   (failureReason: user_mismatch)で閉じ、LLM・検索に進まない
 * - describe フェーズで利用者を確認できなければ(報告なし・食い違い・HTTP の認証失敗)
 *   AnswerRun を書かずに error で終える
 * - run の途中で別の利用者が報告されたら user_mismatch で止める
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  AuditLogger,
  BufferedAuditSink,
  InMemoryAuditStore,
  type AuditRecord,
  type AuditSink,
} from "@kp/audit";
import {
  Orchestrator,
  OrchestratorError,
  ScriptedLlmClient,
  scriptedSubmit,
  scriptedToolUse,
  type GatewayCallOptions,
  type GatewayCallOutcome,
  type GatewayClient,
  type GatewayToolSchema,
} from "../src/index.js";
import {
  BOB_TOKEN,
  CorpusConnector,
  EXPENSE_POLICY,
  TEST_DOC_ID_AUDIT,
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

async function setup(): Promise<GatewayHarness> {
  const harness = await startGateway({
    connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])],
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

function answerRunsIn(store: InMemoryAuditStore) {
  return store.records().flatMap((r) => (r.recordType === "answer_run" ? [r] : []));
}

describe("H1: AnswerRun.userId は Gateway が認証した値", () => {
  it("申告がなければ Gateway が認証した userId を記録する(ToolInvocation と runId・userId で結合できる)", async () => {
    const harness = await setup();
    const orchestrator = new Orchestrator({
      docIdAudit: TEST_DOC_ID_AUDIT,
      llm: resolvingScript(),
      auditLogger: harness.auditLogger,
    });

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
    const orchestrator = new Orchestrator({
      docIdAudit: TEST_DOC_ID_AUDIT,
      llm,
      auditLogger: harness.auditLogger,
    });

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
    // 記録する主体は申告(alice)ではなく Gateway が認証した bob
    expect(harness.answerRuns()).toEqual([
      expect.objectContaining({
        runId: answer.runId,
        userId: "bob",
        finalOutcome: "error",
        failureReason: "user_mismatch",
      }),
    ]);
    // 申告した利用者(alice)は、この run にフィードバックできない
    await expect(
      orchestrator.recordFeedback(answer.runId, "resolved", { userId: "alice" }),
    ).rejects.toMatchObject({ errorClass: "feedback_forbidden" });
  });

  it("AnswerRun(pending)は describe の後に書き、startedAt は run の開始時刻", async () => {
    const harness = await setup();
    const events: string[] = [];
    const inner = harness.client();
    const gateway: GatewayClient = {
      listTools: (options?: GatewayCallOptions): Promise<readonly GatewayToolSchema[]> =>
        inner.listTools(options),
      callTool: (name, args, meta, options): Promise<GatewayCallOutcome> => {
        events.push(`gateway:${name}`);
        return inner.callTool(name, args, meta, options);
      },
      close: () => inner.close(),
    };
    const store = new InMemoryAuditStore();
    const buffered = new BufferedAuditSink(store);
    const sink: AuditSink = {
      async write(record: AuditRecord) {
        if (record.recordType === "answer_run") {
          events.push(`answer_run:${record.finalOutcome}`);
        }
        await buffered.write(record);
      },
    };
    const times = [Date.parse("2026-09-27T09:00:00.000Z")];
    const orchestrator = new Orchestrator({
      docIdAudit: TEST_DOC_ID_AUDIT,
      llm: resolvingScript(),
      auditLogger: new AuditLogger(sink),
      now: () => times.shift() ?? Date.parse("2026-09-27T09:00:07.000Z"),
    });

    await orchestrator.run({ question: "経費精算の締め日は?", userId: "alice", gateway });

    expect(events).toEqual([
      "gateway:describe",
      "answer_run:pending",
      "gateway:search",
      "answer_run:resolved",
    ]);
    expect(answerRunsIn(store)[0]).toMatchObject({
      userId: "alice",
      startedAt: "2026-09-27T09:00:00.000Z",
      endedAt: "2026-09-27T09:00:07.000Z",
    });
  });

  it("申告の userId が空文字なら invalid_input(Gateway にアクセスしない)", async () => {
    const gateway = new FakeGatewayClient(["alpha"], () => describeOk("alpha", "alice"));
    const orchestrator = new Orchestrator({
      docIdAudit: TEST_DOC_ID_AUDIT,
      llm: new ScriptedLlmClient([]),
      auditLogger: new AuditLogger(new BufferedAuditSink(new InMemoryAuditStore())),
    });
    await expect(
      orchestrator.run({ question: "q", userId: "  ", gateway }),
    ).rejects.toBeInstanceOf(OrchestratorError);
    expect(gateway.calls).toEqual([]);
  });
});

describe("H1: 利用者を確認できないときは AnswerRun を書かない", () => {
  function orchestratorWith(store: InMemoryAuditStore, llm = new ScriptedLlmClient([])) {
    return new Orchestrator({
      docIdAudit: TEST_DOC_ID_AUDIT,
      llm,
      auditLogger: new AuditLogger(new BufferedAuditSink(store)),
    });
  }

  it("Gateway が describe の結果で利用者を報告しなければ error(user_unverified)で、申告値でも記録しない", async () => {
    const store = new InMemoryAuditStore();
    const llm = new ScriptedLlmClient([]);
    const gateway = new FakeGatewayClient(["alpha"], () => describeOk("alpha"));

    const answer = await orchestratorWith(store, llm).run({
      question: "経費精算の締め日は?",
      userId: "alice",
      gateway,
    });

    expect(answer.outcome).toBe("error");
    expect(answer.answer).toContain("user_unverified");
    expect(llm.requests).toHaveLength(0);
    expect(answerRunsIn(store)).toEqual([]);
  });

  it("describe の結果の userId が食い違えば AnswerRun を書かない(user_unverified)", async () => {
    const store = new InMemoryAuditStore();
    const gateway = new FakeGatewayClient(["alpha", "beta"], (call) =>
      describeOk(String(call.args["source"]), call.args["source"] === "alpha" ? "alice" : "bob"),
    );

    const answer = await orchestratorWith(store).run({ question: "q", gateway });

    expect(answer.outcome).toBe("error");
    expect(answer.answer).toContain("user_unverified");
    expect(answerRunsIn(store)).toEqual([]);
  });

  it("describe フェーズで HTTP の認証に失敗したら(一部のソースだけでも)AnswerRun を書かない", async () => {
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
      close: () => valid.close(),
    };
    const llm = new ScriptedLlmClient([]);
    const orchestrator = new Orchestrator({
      docIdAudit: TEST_DOC_ID_AUDIT,
      llm,
      auditLogger: harness.auditLogger,
    });

    const answer = await orchestrator.run({ question: "q", gateway });

    expect(answer.outcome).toBe("error");
    expect(answer.answer).toContain("gateway_unauthenticated");
    expect(llm.requests).toHaveLength(0);
    expect(harness.answerRuns()).toEqual([]);
  });

  it("run の途中で Gateway が別の利用者を報告したら user_mismatch で止める(AnswerRun は認証済みの利用者で error)", async () => {
    const store = new InMemoryAuditStore();
    const llm = new ScriptedLlmClient([
      () => scriptedToolUse([{ name: "search", input: { source: "alpha", query: "締め日" } }]),
      () => scriptedSubmit({ answer: "不明", citations: [], confidence: 0 }),
    ]);
    const gateway = new FakeGatewayClient(["alpha"], (call) =>
      call.name === "describe"
        ? describeOk("alpha", "alice")
        : searchHit("alpha", "doc-1", "mallory"),
    );

    const answer = await orchestratorWith(store, llm).run({ question: "q", gateway });

    expect(answer.outcome).toBe("error");
    expect(answer.answer).toContain("user_mismatch");
    // 食い違った結果は台帳に入れず、LLM にも渡さない(2ターン目を呼ばない)
    expect(llm.requests).toHaveLength(1);
    expect(answerRunsIn(store)).toEqual([
      expect.objectContaining({ userId: "alice", finalOutcome: "error", failureReason: "user_mismatch" }),
    ]);
  });
});
