/**
 * run の部分レコード(answer_run_finish / answer_run_feedback。ADR-019 決定3・8)のスキーマ。
 */
import { describe, expect, it } from "vitest";
import {
  InMemoryAuditStore,
  auditRecordIdempotencyKey,
  parseAuditRecord,
  recordTimestamp,
  validateRecord,
  type AuditRecord,
} from "../src/index.js";

const finish: AuditRecord = {
  recordType: "answer_run_finish",
  recordId: "rec-1",
  runId: "r1.k1.p.s",
  userId: "alice",
  recordedAt: "2026-10-11T12:00:05.000Z",
  endedAt: "2026-10-11T12:00:05.000Z",
  finalOutcome: "unresolved",
  confidence: 0.3,
  searchedSources: ["drive"],
  citedDocIds: [],
  failureReason: null,
};

const feedback: AuditRecord = {
  recordType: "answer_run_feedback",
  recordId: "rec-2",
  runId: "r1.k1.p.s",
  userId: "alice",
  recordedAt: "2026-10-11T12:30:00.000Z",
  userFeedback: "resolved",
};

describe("answer_run_finish / answer_run_feedback", () => {
  it("検証を通り、parseAuditRecord で読み戻せる", () => {
    expect(() => validateRecord(finish)).not.toThrow();
    expect(() => validateRecord(feedback)).not.toThrow();
    expect(parseAuditRecord(JSON.parse(JSON.stringify(finish)))).toEqual(finish);
    expect(parseAuditRecord(JSON.parse(JSON.stringify(feedback)))).toEqual(feedback);
  });

  it("finish の結果は pending を取れず、未知のキー・禁止フィールドを拒否する", () => {
    expect(() => validateRecord({ ...finish, finalOutcome: "pending" } as unknown as AuditRecord)).toThrow(/finalOutcome/);
    expect(() => validateRecord({ ...finish, userFeedback: "resolved" } as unknown as AuditRecord)).toThrow();
    expect(() => validateRecord({ ...finish, snippet: "x" } as unknown as AuditRecord)).toThrow(/forbidden/);
    expect(() => validateRecord({ ...finish, failureReason: "Timeout: upstream" } as unknown as AuditRecord)).toThrow(/failureReason/);
    expect(() => validateRecord({ ...feedback, userFeedback: "error" } as unknown as AuditRecord)).toThrow(/userFeedback/);
    expect(() => validateRecord({ ...feedback, finalOutcome: "resolved" } as unknown as AuditRecord)).toThrow();
  });

  it("冪等キーは recordId、保持期限の時刻は recordedAt", () => {
    expect(auditRecordIdempotencyKey(finish)).toBe("answer_run_finish:rec-1");
    expect(auditRecordIdempotencyKey(feedback)).toBe("answer_run_feedback:rec-2");
    expect(recordTimestamp(finish)).toBe(finish.recordedAt);
    expect(recordTimestamp(feedback)).toBe(feedback.recordedAt);
  });

  it("finish の再送は冪等キーで重複を除き、feedback を消さない(InMemoryAuditStore)", async () => {
    const store = new InMemoryAuditStore();
    await store.writeBatch([finish, feedback, finish]);
    expect(store.records()).toHaveLength(2);
    expect(store.records().map((r) => r.recordType).sort()).toEqual(["answer_run_feedback", "answer_run_finish"]);
    // 別の recordId の finish(2 度目の申告)は別レコードとして残る(統合はレポート側)
    await store.writeBatch([{ ...finish, recordId: "rec-3", finalOutcome: "resolved" }]);
    expect(store.records()).toHaveLength(3);
    const purged = await store.purgeBefore("2026-10-11T12:10:00.000Z");
    expect(purged).toBe(2);
    expect(store.records().map((r) => r.recordType)).toEqual(["answer_run_feedback"]);
  });
});
