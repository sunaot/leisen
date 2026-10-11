/**
 * 受け入れ条件3: 監査ログの AnswerRun(finalOutcome, userFeedback)が利用者フィードバックで
 * 更新できる。あわせて AnswerRun の書き方(describe フェーズの後に pending → 最終状態、
 * runId で上書き)、書き込み失敗時の fail-closed(ADR-011 §4)、終了処理の例外でも
 * AnswerRun を error で閉じること(セキュリティレビュー m6)、フィードバックの利用者照合が
 * 必須であること(m4)を検証する。
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
} from "../src/index.js";
import {
  CorpusConnector,
  EXPENSE_POLICY,
  startGateway,
  type GatewayHarness,
  TEST_DOC_ID_AUDIT,
} from "./helpers/harness.js";
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

/** 書き込まれた AnswerRun を順に記録しつつストアへ流すシンク。 */
class TappingSink implements AuditSink {
  readonly written: AuditRecord[] = [];
  failWrites = false;

  constructor(private readonly inner: AuditSink) {}

  async write(record: AuditRecord): Promise<void> {
    if (this.failWrites) {
      throw new Error("injected audit failure: dev-only-sink-detail");
    }
    this.written.push(record);
    await this.inner.write(record);
  }
}

describe("AnswerRun の書き方", () => {
  it("開始時に pending、終了時に同じ runId で最終状態を書く(ストアは runId で上書き)", async () => {
    const harness = await setup();
    const store = new InMemoryAuditStore();
    const sink = new TappingSink(new BufferedAuditSink(store));
    const orchestrator = new Orchestrator({
      docIdAudit: TEST_DOC_ID_AUDIT,
      llm: resolvingScript(),
      auditLogger: new AuditLogger(sink),
      now: () => Date.parse("2026-09-27T09:00:00.000Z"),
    });

    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      userId: "alice",
      gateway: harness.client(),
    });

    expect(sink.written.map((r) => r.recordType === "answer_run" && r.finalOutcome)).toEqual([
      "pending",
      "resolved",
    ]);
    expect(sink.written[0]).toMatchObject({
      runId: answer.runId,
      endedAt: null,
      confidence: null,
      searchedSources: [],
      citedDocIds: [],
    });
    // 質問は digest のみ(原文を監査に載せない)
    expect(JSON.stringify(sink.written)).not.toContain("締め日は?");
    expect(store.records()).toHaveLength(1);
    expect(store.records()[0]).toMatchObject({
      runId: answer.runId,
      finalOutcome: "resolved",
      startedAt: "2026-09-27T09:00:00.000Z",
      endedAt: "2026-09-27T09:00:00.000Z",
    });
  });

  it("pending を書けなければ LLM を呼ばず、describe より後の Gateway 呼び出しもせずに失敗する(fail-closed)", async () => {
    const harness = await setup();
    const sink = new TappingSink(new BufferedAuditSink(new InMemoryAuditStore()));
    sink.failWrites = true;
    const llm = resolvingScript();
    const orchestrator = new Orchestrator({ llm, auditLogger: new AuditLogger(sink), docIdAudit: TEST_DOC_ID_AUDIT });

    const error = await orchestrator
      .run({ question: "経費精算の締め日は?", userId: "alice", gateway: harness.client() })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(OrchestratorError);
    expect(error).toMatchObject({ errorClass: "audit_write_failed" });
    expect(String((error as Error).message)).not.toContain("dev-only-sink-detail");
    expect(llm.requests).toHaveLength(0);
    // pending は利用者の確認(describe の結果の `_meta`)の後に書くため、describe だけは
    // Gateway に届いて監査されている(H1)。検索・取得には進まない
    expect(harness.toolInvocations().map((r) => r.tool)).toEqual(["describe"]);
  });

  it("終了処理(Answer の組み立て・最終状態の記録)で例外が起きても AnswerRun を error で閉じる(m6)", async () => {
    const harness = await setup();
    const times = [
      Date.parse("2026-09-27T09:00:00.000Z"), // run 開始
      Number.NaN, // 最終状態の endedAt(toISOString が RangeError を投げる)
      Date.parse("2026-09-27T09:00:05.000Z"), // error で閉じる記録の endedAt
    ];
    const orchestrator = new Orchestrator({
      docIdAudit: TEST_DOC_ID_AUDIT,
      llm: resolvingScript(),
      auditLogger: harness.auditLogger,
      now: () => times.shift() ?? Date.now(),
    });

    await expect(
      orchestrator.run({ question: "経費精算の締め日は?", gateway: harness.client() }),
    ).rejects.toBeInstanceOf(RangeError);

    const runs = harness.answerRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      userId: "alice",
      finalOutcome: "error",
      failureReason: "internal_error",
      startedAt: "2026-09-27T09:00:00.000Z",
      endedAt: "2026-09-27T09:00:05.000Z",
    });
  });

  it("最終状態を書けなければ回答を返さない(fail-closed)", async () => {
    const harness = await setup();
    const sink = new TappingSink(new BufferedAuditSink(new InMemoryAuditStore()));
    const scripted = resolvingScript();
    const llm = {
      provider: scripted.provider,
      capabilities: scripted.capabilities,
      complete: async (...args: Parameters<ScriptedLlmClient["complete"]>) => {
        const turn = await scripted.complete(...args);
        if (scripted.requests.length === 2) {
          sink.failWrites = true; // submit_answer の直後から書き込みに失敗させる
        }
        return turn;
      },
    };
    const orchestrator = new Orchestrator({ llm, auditLogger: new AuditLogger(sink), docIdAudit: TEST_DOC_ID_AUDIT });

    await expect(
      orchestrator.run({ question: "経費精算の締め日は?", userId: "alice", gateway: harness.client() }),
    ).rejects.toMatchObject({ errorClass: "audit_write_failed" });
  });
});

describe("受け入れ条件3: recordFeedback による userFeedback の更新", () => {
  it("利用者フィードバックで AnswerRun の userFeedback を更新し、監査ストアから読み戻せる", async () => {
    const harness = await setup();
    const orchestrator = new Orchestrator({
      docIdAudit: TEST_DOC_ID_AUDIT,
      llm: resolvingScript(),
      auditLogger: harness.auditLogger,
    });
    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      userId: "alice",
      gateway: harness.client(),
    });
    const before = harness.answerRuns().find((r) => r.runId === answer.runId);
    expect(before).toMatchObject({ finalOutcome: "resolved", userFeedback: null });

    await orchestrator.recordFeedback(answer.runId, "unresolved", { userId: "alice" });
    const after = harness.answerRuns().filter((r) => r.runId === answer.runId);
    expect(after).toHaveLength(1);
    // userFeedback 以外(finalOutcome を含む)は変わらない
    expect(after[0]).toEqual({ ...before, userFeedback: "unresolved" });

    // 付け直し(最後の値が残る)
    await orchestrator.recordFeedback(answer.runId, "resolved", { userId: "alice" });
    expect(harness.answerRuns().find((r) => r.runId === answer.runId)?.userFeedback).toBe(
      "resolved",
    );
  });

  it("未知の runId・質問者以外のフィードバックは拒否し、AnswerRun を変えない", async () => {
    const harness = await setup();
    const orchestrator = new Orchestrator({
      docIdAudit: TEST_DOC_ID_AUDIT,
      llm: resolvingScript(),
      auditLogger: harness.auditLogger,
    });
    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      userId: "alice",
      gateway: harness.client(),
    });

    await expect(
      orchestrator.recordFeedback("run-unknown", "resolved", { userId: "alice" }),
    ).rejects.toMatchObject({ errorClass: "run_not_found" });
    await expect(
      orchestrator.recordFeedback(answer.runId, "unresolved", { userId: "bob" }),
    ).rejects.toMatchObject({ errorClass: "feedback_forbidden" });
    expect(harness.answerRuns().find((r) => r.runId === answer.runId)?.userFeedback).toBeNull();
  });

  it("フィードバックには利用者の userId が必須(省略・空文字は拒否。m4)", async () => {
    const harness = await setup();
    const orchestrator = new Orchestrator({
      docIdAudit: TEST_DOC_ID_AUDIT,
      llm: resolvingScript(),
      auditLogger: harness.auditLogger,
    });
    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      gateway: harness.client(),
    });

    // 型では必須だが、JS からの呼び出し・any 経由の省略も実行時に拒否する
    const recordWithout = orchestrator.recordFeedback.bind(orchestrator) as (
      runId: string,
      feedback: "resolved" | "unresolved",
      options?: { userId?: string },
    ) => Promise<void>;
    await expect(recordWithout(answer.runId, "resolved")).rejects.toMatchObject({
      errorClass: "invalid_input",
    });
    await expect(recordWithout(answer.runId, "resolved", {})).rejects.toMatchObject({
      errorClass: "invalid_input",
    });
    await expect(
      orchestrator.recordFeedback(answer.runId, "resolved", { userId: " " }),
    ).rejects.toMatchObject({ errorClass: "invalid_input" });
    expect(harness.answerRuns().find((r) => r.runId === answer.runId)?.userFeedback).toBeNull();

    // 照合先は Gateway が認証した userId(申告を省略した run でも alice に束縛されている)
    await orchestrator.recordFeedback(answer.runId, "resolved", { userId: "alice" });
    expect(harness.answerRuns().find((r) => r.runId === answer.runId)?.userFeedback).toBe(
      "resolved",
    );
  });

  it("保持する run 数(feedbackWindow)を超えた古い run は run_not_found になる", async () => {
    const harness = await setup();
    let counter = 0;
    const orchestrator = new Orchestrator({
      docIdAudit: TEST_DOC_ID_AUDIT,
      llm: new ScriptedLlmClient(() =>
        scriptedSubmit({ answer: "不明", citations: [], confidence: 0 }),
      ),
      auditLogger: harness.auditLogger,
      feedbackWindow: 1,
      ids: () => `run-${++counter}`,
    });
    const first = await orchestrator.run({ question: "q1", userId: "alice", gateway: harness.client() });
    const second = await orchestrator.run({ question: "q2", userId: "alice", gateway: harness.client() });

    await expect(
      orchestrator.recordFeedback(first.runId, "resolved", { userId: "alice" }),
    ).rejects.toMatchObject({ errorClass: "run_not_found" });
    await orchestrator.recordFeedback(second.runId, "unresolved", { userId: "alice" });
  });
});
