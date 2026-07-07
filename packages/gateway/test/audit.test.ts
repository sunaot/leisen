import { describe, expect, it } from "vitest";
import {
  AuditLogger,
  type AnswerRunRecord,
  type AuditRecord,
  type AuditSink,
  type ToolInvocationRecord,
  digestQuery,
  validateRecord,
} from "../src/audit/index.js";

function baseInvocation(): AuditRecord {
  const record: ToolInvocationRecord = {
    requestId: "req-1",
    runId: "run-1",
    iteration: 0,
    userId: "user-1",
    timestamp: new Date().toISOString(),
    sourceId: "gdrive",
    tool: "search",
    queryDigest: digestQuery("四半期レビューの議事録"),
    filtersDigest: null,
    returnedHitCount: 3,
    fetchedDocCount: 0,
    latencyMs: 420,
    errorClass: null,
    retryCount: 0,
  };
  return { recordType: "tool_invocation", ...record };
}

function baseRun(): AuditRecord {
  const record: AnswerRunRecord = {
    runId: "run-1",
    userId: "user-1",
    actor: { kind: "human" },
    startedAt: new Date().toISOString(),
    endedAt: null,
    finalQueryDigest: digestQuery("四半期レビューの議事録"),
    finalOutcome: "pending",
    confidence: null,
    userFeedback: null,
    searchedSources: ["gdrive"],
    citedDocIds: [],
    failureReason: null,
  };
  return { recordType: "answer_run", ...record };
}

describe("audit record validation (ADR-011)", () => {
  it("accepts well-formed records of both layers", () => {
    expect(() => validateRecord(baseInvocation())).not.toThrow();
    expect(() => validateRecord(baseRun())).not.toThrow();
  });

  it("rejects records missing identity fields", () => {
    const record = { ...baseInvocation(), userId: "" } as AuditRecord;
    expect(() => validateRecord(record)).toThrow(/identity/);
  });

  it("rejects forbidden secret fields at runtime", () => {
    const record = { ...baseInvocation(), accessToken: "secret" } as AuditRecord;
    expect(() => validateRecord(record)).toThrow(/forbidden/);
  });

  it("rejects pre-filter candidate count fields (existence leak, ADR-012)", () => {
    const withHitCount = { ...baseInvocation(), hitCount: 12 } as AuditRecord;
    expect(() => validateRecord(withHitCount)).toThrow(/forbidden/);
    const withCandidates = { ...baseInvocation(), candidateCount: 12 } as AuditRecord;
    expect(() => validateRecord(withCandidates)).toThrow(/forbidden/);
  });

  it("rejects malformed digests", () => {
    const record = { ...baseInvocation(), queryDigest: "raw query text" } as AuditRecord;
    expect(() => validateRecord(record)).toThrow(/sha256/);
  });

  it("requires on-behalf-of chain for agent actors (ADR-015)", () => {
    const run = baseRun();
    const record = {
      ...run,
      actor: { kind: "agent", agentId: "batch-1", onBehalfOfChain: [] },
    } as AuditRecord;
    expect(() => validateRecord(record)).toThrow(/onBehalfOfChain/);
  });
});

describe("AuditLogger", () => {
  it("writes exactly one record per call to the sink", async () => {
    const written: AuditRecord[] = [];
    const sink: AuditSink = {
      write: async (r) => {
        written.push(r);
      },
    };
    const logger = new AuditLogger(sink);
    await logger.log(baseInvocation());
    expect(written).toHaveLength(1);
    expect(written[0]?.recordType).toBe("tool_invocation");
  });
});
