/**
 * run の監査レコードの組み立て(ADR-019 決定3・5・7・8、T-023)。
 * 引用 docId は申告の sourceId に頼らず構成全体で最も厳しい規則を全件にかける。
 */
import { describe, expect, it } from "vitest";
import { validateRecord, type Actor, type DocIdAuditConfig } from "@leisen/audit";
import {
  answerRunFeedbackRecord,
  answerRunFinishRecord,
  citedDocIdsForRun,
  pendingAnswerRunRecord,
  recordsRawQuestion,
  searchedSourcesForRun,
  type FinishDeclaration,
  type RunSourcePolicy,
} from "../src/run/index.js";

const HUMAN: Actor = { kind: "human" };
const HMAC: DocIdAuditConfig = { privateScopeDocIds: "hashed", hmacKey: "test-key-not-a-secret" };
const OMIT: DocIdAuditConfig = { privateScopeDocIds: "omitted" };

function policy(overrides: Partial<RunSourcePolicy> & { enabled?: string[] } = {}): RunSourcePolicy {
  const enabled = new Set(overrides.enabled ?? ["drive", "github"]);
  return {
    isEnabledSource: (id) => enabled.has(id),
    persistenceForbiddenSourceEnabled: overrides.persistenceForbiddenSourceEnabled ?? false,
    privateScopeSourceEnabled: overrides.privateScopeSourceEnabled ?? false,
  };
}

const envelope = {
  recordId: "rec-1",
  runId: "r1.k1.payload.sig",
  userId: "alice",
  recordedAt: "2026-10-11T12:00:05.000Z",
};

const finish: FinishDeclaration = {
  outcome: "resolved",
  confidence: 0.8,
  searchedSources: ["drive", "github", "drive", "slack", "nope"],
  citations: [
    { sourceId: "drive", documentId: "doc-1" },
    { sourceId: "github", documentId: "owner/repo#12" },
    { sourceId: "drive", documentId: "doc-1" },
    { sourceId: "slack", documentId: "C123:1700000000.000100" },
    { sourceId: "nope", documentId: "x" },
  ],
  failureReason: null,
};

describe("pending の AnswerRun(POST /runs)", () => {
  it("userId・actor・開始時刻と質問の digest だけを持ち、原文を含まない", () => {
    const record = pendingAnswerRunRecord({
      runId: envelope.runId,
      userId: "alice",
      actor: HUMAN,
      startedAt: "2026-10-11T12:00:00.000Z",
      question: "休暇の申請はどこで出す?",
    });
    expect(() => validateRecord(record)).not.toThrow();
    expect(record).toMatchObject({
      recordType: "answer_run",
      runId: envelope.runId,
      userId: "alice",
      actor: HUMAN,
      finalOutcome: "pending",
      endedAt: null,
      confidence: null,
      userFeedback: null,
      searchedSources: [],
      citedDocIds: [],
      failureReason: null,
    });
    expect(record.recordType === "answer_run" && record.finalQueryDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(record)).not.toContain("休暇");
  });

  it("質問原文を生クエリ表に書くのは永続化不可のソースがない構成だけ(決定7)", () => {
    expect(recordsRawQuestion(policy())).toBe(true);
    expect(recordsRawQuestion(policy({ persistenceForbiddenSourceEnabled: true }))).toBe(false);
  });
});

describe("引用 docId の記録(決定5)", () => {
  it("Slack が有効な構成では citedDocIds を記録しない(Slack 以外の sourceId で申告された Slack 形式の docId も残らない)", () => {
    const slackEnabled = policy({ enabled: ["drive", "slack"], persistenceForbiddenSourceEnabled: true, privateScopeSourceEnabled: true });
    const disguised = [
      { sourceId: "drive", documentId: "C123:1700000000.000100" },
      { sourceId: "drive", documentId: "doc-1" },
    ];
    expect(citedDocIdsForRun(disguised, slackEnabled, HMAC)).toEqual([]);
    const record = answerRunFinishRecord(envelope, { ...finish, citations: disguised }, slackEnabled, HMAC);
    expect(record).toMatchObject({ citedDocIds: [], searchedSources: ["drive", "slack"] });
    expect(JSON.stringify(record)).not.toContain("1700000000");
  });

  it("プライベートスコープを持つソースが有効なら、全件に privateScopeDocIds の規則(hashed)をかける", () => {
    const out = citedDocIdsForRun(finish.citations, policy({ privateScopeSourceEnabled: true }), HMAC);
    expect(out).toHaveLength(2);
    for (const id of out) {
      expect(id).toMatch(/^hmac:[0-9a-f]{64}$/);
    }
    expect(out.join()).not.toContain("doc-1");
    expect(out.join()).not.toContain("owner/repo");
    // 決定的(参照頻度の集計を保つ)
    expect(citedDocIdsForRun(finish.citations, policy({ privateScopeSourceEnabled: true }), HMAC)).toEqual(out);
  });

  it("omitted なら記録しない。hashed で鍵がなければ平文に倒さず例外(fail-closed)", () => {
    expect(citedDocIdsForRun(finish.citations, policy({ privateScopeSourceEnabled: true }), OMIT)).toEqual([]);
    expect(() =>
      citedDocIdsForRun(finish.citations, policy({ privateScopeSourceEnabled: true }), { privateScopeDocIds: "hashed" }),
    ).toThrow(/hmacKey/);
  });

  it("Slack もプライベートスコープもない構成では <sourceId>:<documentId> を記録し、有効でないソースの引用と重複は落とす", () => {
    expect(citedDocIdsForRun(finish.citations, policy(), HMAC)).toEqual(["drive:doc-1", "github:owner/repo#12"]);
  });

  it("searchedSources は有効なソースだけ・重複なし・申告の順", () => {
    expect(searchedSourcesForRun(finish.searchedSources, policy())).toEqual(["drive", "github"]);
    expect(searchedSourcesForRun(["github", "drive"], policy())).toEqual(["github", "drive"]);
  });
});

describe("部分レコード", () => {
  it("answer_run_finish は Gateway の時刻を endedAt にし、スキーマを通る", () => {
    const record = answerRunFinishRecord(envelope, finish, policy(), HMAC);
    expect(() => validateRecord(record)).not.toThrow();
    expect(record).toEqual({
      recordType: "answer_run_finish",
      recordId: "rec-1",
      runId: envelope.runId,
      userId: "alice",
      recordedAt: envelope.recordedAt,
      endedAt: envelope.recordedAt,
      finalOutcome: "resolved",
      confidence: 0.8,
      searchedSources: ["drive", "github"],
      citedDocIds: ["drive:doc-1", "github:owner/repo#12"],
      failureReason: null,
    });
  });

  it("error で終わった run の confidence は null、failureReason は正規化コード", () => {
    const record = answerRunFinishRecord(
      envelope,
      { ...finish, outcome: "error", confidence: 0.9, failureReason: "llm_unavailable" },
      policy(),
      HMAC,
    );
    expect(() => validateRecord(record)).not.toThrow();
    expect(record).toMatchObject({ finalOutcome: "error", confidence: null, failureReason: "llm_unavailable" });
  });

  it("answer_run_feedback は userFeedback だけを持ち、スキーマを通る", () => {
    const record = answerRunFeedbackRecord(envelope, "unresolved");
    expect(() => validateRecord(record)).not.toThrow();
    expect(record).toEqual({
      recordType: "answer_run_feedback",
      recordId: "rec-1",
      runId: envelope.runId,
      userId: "alice",
      recordedAt: envelope.recordedAt,
      userFeedback: "unresolved",
    });
  });
});
