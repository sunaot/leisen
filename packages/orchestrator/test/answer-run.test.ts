/**
 * 受け入れ条件3(改訂、ADR-019): AnswerRun は Gateway の run API が書く。
 * - run の開始(POST /runs)で Gateway が pending を書き(userId は認証値、質問は digest)、終了
 *   (POST /runs/{runId}/finish)で部分レコード answer_run_finish が追記される。Orchestrator は
 *   監査ストアに触れない
 * - 開始を申告できなければ LLM を呼ばず、Gateway にもそれ以上アクセスしない(fail-closed)
 * - 終了を記録できなければ回答を返さない(audit_write_failed)。想定外の失敗でも run を error で閉じる
 * - フィードバックは本人のトークンで POST /runs/{runId}/feedback に申告し、Gateway が runId の署名で
 *   本人を検証する(他人・未知の runId は拒否)。finish の再送でフィードバックは消えない
 */
import { afterEach, describe, expect, it } from "vitest";
import { digestQuery, type AuditRecord, type AuditSink } from "@kp/audit";
import {
  GatewayClientError,
  Orchestrator,
  OrchestratorError,
  ScriptedLlmClient,
  scriptedSubmit,
  scriptedToolUse,
} from "../src/index.js";
import {
  ALICE_TOKEN,
  BOB_TOKEN,
  CorpusConnector,
  EXPENSE_POLICY,
  startGateway,
  type GatewayHarness,
  type GatewayHarnessOptions,
} from "./helpers/harness.js";
import { firstHit } from "./helpers/script.js";

const harnesses: GatewayHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

async function setup(options: Partial<GatewayHarnessOptions> = {}): Promise<GatewayHarness> {
  const harness = await startGateway({
    connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])],
    ...options,
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

/** Gateway の監査シンクの書き込みを記録し、失敗を注入できる装飾(ストアには通したものだけが残る)。 */
class Tap {
  readonly written: AuditRecord[] = [];
  failWrites = false;

  wrap(inner: AuditSink): AuditSink {
    return {
      write: async (record: AuditRecord) => {
        if (this.failWrites) {
          throw new Error("injected audit failure: dev-only-sink-detail");
        }
        this.written.push(record);
        await inner.write(record);
      },
    };
  }
}

function tapped(): { sink: Tap; wrapSink: (inner: AuditSink) => AuditSink } {
  const sink = new Tap();
  return { sink, wrapSink: (inner) => sink.wrap(inner) };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the run to fail");
    },
    (e: unknown) => e,
  );
}

describe("AnswerRun の書き方(Gateway の run API)", () => {
  it("開始時に Gateway が pending を書き、終了時に同じ runId の answer_run_finish が追記される(Orchestrator は書かない)", async () => {
    const { sink, wrapSink } = tapped();
    const harness = await setup({ wrapSink });
    const orchestrator = new Orchestrator({ llm: resolvingScript() });

    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      userId: "alice",
      gateway: harness.client(),
    });

    expect(answer.outcome).toBe("resolved");
    expect(answer.runId).toMatch(/^r1\.t1\.[A-Za-z0-9_-]{38}\.[A-Za-z0-9_-]{43}$/);
    const runRecords = sink.written.filter((r) => r.recordType !== "tool_invocation");
    expect(runRecords.map((r) => r.recordType)).toEqual(["answer_run", "answer_run_finish"]);
    expect(runRecords[0]).toMatchObject({
      runId: answer.runId,
      userId: "alice",
      actor: { kind: "human" },
      finalOutcome: "pending",
      finalQueryDigest: digestQuery("経費精算の締め日は?"),
      endedAt: null,
      confidence: null,
      searchedSources: [],
      citedDocIds: [],
    });
    expect(runRecords[1]).toMatchObject({
      runId: answer.runId,
      userId: "alice",
      finalOutcome: "resolved",
      confidence: 0.9,
      searchedSources: ["alpha"],
      citedDocIds: ["alpha:doc-expense-policy"],
      failureReason: null,
    });
    // 質問の原文・回答本文は監査レコードに載らない(原文は生クエリ表)
    expect(JSON.stringify(runRecords)).not.toContain("締め日は?");
    expect(JSON.stringify(runRecords)).not.toContain("毎月25日");
    // pending は最初のツール呼び出し(describe)より前に書かれる
    const firstTool = sink.written.findIndex((r) => r.recordType === "tool_invocation");
    expect(firstTool).toBeGreaterThan(0);
    expect(sink.written[0]?.recordType).toBe("answer_run");
    // 統合すると最終状態
    expect(harness.answerRuns()).toEqual([
      expect.objectContaining({ runId: answer.runId, finalOutcome: "resolved", userFeedback: null }),
    ]);
  });

  it("開始を申告できなければ(監査ストアに書けない)LLM を呼ばず、Gateway にもそれ以上アクセスしない(fail-closed)", async () => {
    const { sink, wrapSink } = tapped();
    sink.failWrites = true;
    const harness = await setup({ wrapSink });
    const llm = resolvingScript();
    const orchestrator = new Orchestrator({ llm });

    const error = await rejectionOf(
      orchestrator.run({ question: "経費精算の締め日は?", gateway: harness.client() }),
    );

    expect(error).toBeInstanceOf(GatewayClientError);
    expect(error).toMatchObject({ errorClass: "audit_write_failed" });
    expect(String(error)).not.toContain("dev-only-sink-detail");
    expect(llm.requests).toHaveLength(0);
    expect(harness.toolInvocations()).toEqual([]);
    expect(sink.written).toEqual([]);
  });

  it("Orchestrator の資格情報が Gateway と一致しなければ run を始められない(orchestrator_credential_rejected)", async () => {
    const harness = await setup();
    const llm = resolvingScript();
    const orchestrator = new Orchestrator({ llm });

    const error = await rejectionOf(
      orchestrator.run({
        question: "経費精算の締め日は?",
        gateway: harness.client(ALICE_TOKEN, "wrong-orchestrator-credential-0"),
      }),
    );

    expect(error).toMatchObject({ errorClass: "orchestrator_credential_rejected" });
    expect(llm.requests).toHaveLength(0);
    expect(harness.answerRuns()).toEqual([]);
  });

  it("終了を記録できなければ回答を返さない(audit_write_failed、fail-closed)", async () => {
    const { sink, wrapSink } = tapped();
    const harness = await setup({ wrapSink });
    const llm = new ScriptedLlmClient([
      () => scriptedToolUse([{ name: "search", input: { source: "alpha", query: "締め日" } }]),
      (context) => {
        // 最終状態を書く直前に監査ストアを壊す
        sink.failWrites = true;
        const hit = firstHit(context);
        return scriptedSubmit({
          answer: "経費精算の締め日は毎月25日です。",
          citations: [{ documentId: hit.documentId, sourceId: hit.source }],
          confidence: 0.9,
        });
      },
    ]);
    const orchestrator = new Orchestrator({ llm });

    const error = await rejectionOf(
      orchestrator.run({ question: "経費精算の締め日は?", gateway: harness.client() }),
    );

    expect(error).toBeInstanceOf(OrchestratorError);
    expect(error).toMatchObject({ errorClass: "audit_write_failed" });
    expect(String(error)).not.toContain("dev-only-sink-detail");
    // pending は残り、finish は書けていない
    expect(sink.written.map((r) => r.recordType)).toEqual(["answer_run", "tool_invocation", "tool_invocation"]);
  });

  it("探索中の想定外の例外でも run を error で閉じてから投げ直す(m6)", async () => {
    const { sink, wrapSink } = tapped();
    const harness = await setup({ wrapSink });
    const llm = new ScriptedLlmClient([
      () => {
        throw new TypeError("dev-only implementation bug");
      },
    ]);
    const orchestrator = new Orchestrator({ llm });

    const error = await rejectionOf(
      orchestrator.run({ question: "経費精算の締め日は?", gateway: harness.client() }),
    );

    expect(error).toBeInstanceOf(TypeError);
    const finishes = sink.written.filter((r) => r.recordType === "answer_run_finish");
    expect(finishes).toEqual([
      expect.objectContaining({ finalOutcome: "error", failureReason: "internal_error", confidence: null }),
    ]);
    expect(harness.answerRuns()).toEqual([
      expect.objectContaining({ finalOutcome: "error", failureReason: "internal_error" }),
    ]);
  });
});

describe("受け入れ条件3: フィードバック(POST /runs/{runId}/feedback)", () => {
  it("本人のトークンで申告すると answer_run_feedback が追記され、統合した AnswerRun の userFeedback になる", async () => {
    const harness = await setup();
    const answer = await new Orchestrator({ llm: resolvingScript() }).run({
      question: "経費精算の締め日は?",
      gateway: harness.client(ALICE_TOKEN),
    });

    await harness.client(ALICE_TOKEN).feedbackRun(answer.runId, "resolved");

    const feedbacks = harness.records().filter((r) => r.recordType === "answer_run_feedback");
    expect(feedbacks).toEqual([
      expect.objectContaining({ runId: answer.runId, userId: "alice", userFeedback: "resolved" }),
    ]);
    expect(harness.answerRuns()).toEqual([
      expect.objectContaining({ runId: answer.runId, finalOutcome: "resolved", userFeedback: "resolved" }),
    ]);
    // 付け直せる(最新が採られる)。finish の再送でも消えない
    await harness.client(ALICE_TOKEN).feedbackRun(answer.runId, "unresolved");
    await harness.client(ALICE_TOKEN).finishRun(answer.runId, {
      outcome: "resolved",
      confidence: 0.9,
      searchedSources: ["alpha"],
      citations: [],
      failureReason: null,
    });
    expect(harness.answerRuns()[0]).toMatchObject({ finalOutcome: "resolved", userFeedback: "unresolved" });
  });

  it("他人の runId・未知の runId・資格情報なしのフィードバックは拒否し、記録を変えない(理由は区別しない)", async () => {
    const harness = await setup();
    const answer = await new Orchestrator({ llm: resolvingScript() }).run({
      question: "経費精算の締め日は?",
      gateway: harness.client(ALICE_TOKEN),
    });
    const before = harness.records().length;

    await expect(harness.client(BOB_TOKEN).feedbackRun(answer.runId, "resolved")).rejects.toMatchObject({
      errorClass: "run_not_accepted",
    });
    await expect(
      harness.client(ALICE_TOKEN).feedbackRun("8b3c7c1e-7e0d-4a4f-9d4e-0d7b3f1f3a2a", "resolved"),
    ).rejects.toMatchObject({ errorClass: "run_not_accepted" });
    await expect(harness.client(ALICE_TOKEN, null).feedbackRun(answer.runId, "resolved")).rejects.toMatchObject({
      errorClass: "orchestrator_credential_rejected",
    });
    expect(harness.records()).toHaveLength(before);
    expect(harness.answerRuns()[0]).toMatchObject({ userFeedback: null });
  });
});
