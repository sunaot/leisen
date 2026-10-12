import { describe, expect, it } from "vitest";
import {
  AuditLogger,
  FORBIDDEN_KEYS,
  answerRunRecordSchema,
  auditAccessRecordSchema,
  retentionPurgeRecordSchema,
  toolInvocationRecordSchema,
  type AnswerRunRecord,
  type AuditAccessRecord,
  type AuditRecord,
  type AuditSink,
  type ToolInvocationRecord,
  digestQuery,
  parseAuditRecord,
  validateRecord,
} from "../src/index.js";

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

function baseAccess(): AuditRecord {
  const record: AuditAccessRecord = {
    accessId: "acc-1",
    accessorUserId: "auditor-1",
    timestamp: new Date().toISOString(),
    purpose: "violation_detection",
    target: "audit_log",
    scopeDescription: "canary verification 2026-07",
  };
  return { recordType: "audit_access", ...record };
}

describe("audit record validation (ADR-011, zod)", () => {
  it("accepts well-formed records of both layers", () => {
    expect(() => validateRecord(baseInvocation())).not.toThrow();
    expect(() => validateRecord(baseRun())).not.toThrow();
  });

  it("accepts meta-audit and retention purge records (ADR-013 §3)", () => {
    expect(() => validateRecord(baseAccess())).not.toThrow();
    expect(() =>
      validateRecord({
        recordType: "retention_purge",
        purgeId: "purge-1",
        timestamp: new Date().toISOString(),
        target: "raw_query",
        retentionDays: 30,
        cutoff: new Date().toISOString(),
        deletedCount: 12,
      }),
    ).not.toThrow();
  });

  it("rejects records missing identity fields", () => {
    const record = { ...baseInvocation(), userId: "" } as AuditRecord;
    expect(() => validateRecord(record)).toThrow(/identity/);
    const run = { ...baseRun(), runId: "" } as AuditRecord;
    expect(() => validateRecord(run)).toThrow(/identity/);
  });

  it("rejects forbidden secret fields at runtime", () => {
    const record = { ...baseInvocation(), accessToken: "secret" } as AuditRecord;
    expect(() => validateRecord(record)).toThrow(/forbidden/);
  });

  it("rejects forbidden fields nested inside objects", () => {
    const run = baseRun();
    const record = {
      ...run,
      actor: { kind: "human", token: "secret" },
    } as AuditRecord;
    expect(() => validateRecord(record)).toThrow(/forbidden/);
  });

  it("rejects pre-filter candidate count fields (existence leak, ADR-012)", () => {
    for (const key of ["hitCount", "candidateCount", "preFilterCount"]) {
      const record = { ...baseInvocation(), [key]: 12 } as AuditRecord;
      expect(() => validateRecord(record)).toThrow(/forbidden/);
    }
  });

  it("rejects unknown fields not in the schema (strict)", () => {
    const record = { ...baseInvocation(), extraField: "x" } as AuditRecord;
    expect(() => validateRecord(record)).toThrow(/invalid audit record/);
  });

  it("rejects raw query text in digest fields", () => {
    const record = { ...baseInvocation(), queryDigest: "raw query text" } as AuditRecord;
    expect(() => validateRecord(record)).toThrow(/sha256/);
  });

  it("rejects malformed timestamps and out-of-range values", () => {
    expect(() =>
      validateRecord({ ...baseInvocation(), timestamp: "yesterday" } as AuditRecord),
    ).toThrow(/invalid audit record/);
    expect(() =>
      validateRecord({ ...baseInvocation(), returnedHitCount: -1 } as AuditRecord),
    ).toThrow(/invalid audit record/);
    expect(() =>
      validateRecord({ ...baseRun(), confidence: 1.5 } as AuditRecord),
    ).toThrow(/invalid audit record/);
  });

  it("requires on-behalf-of chain for agent actors (ADR-015)", () => {
    const run = baseRun();
    const record = {
      ...run,
      actor: { kind: "agent", agentId: "batch-1", onBehalfOfChain: [] },
    } as AuditRecord;
    expect(() => validateRecord(record)).toThrow(/onBehalfOfChain/);
  });

  it("accepts agent actors with a delegation chain", () => {
    const run = baseRun();
    const record = {
      ...run,
      actor: {
        kind: "agent",
        agentId: "batch-1",
        onBehalfOfChain: ["agent:batch-1", "user-1"],
      },
    } as AuditRecord;
    expect(() => validateRecord(record)).not.toThrow();
  });

  it("rejects raw error text in errorClass / failureReason (TM-A2)", () => {
    expect(() =>
      validateRecord({
        ...baseInvocation(),
        errorClass: "Error: ECONNRESET at fetchDoc (secret-report.pdf)",
      } as AuditRecord),
    ).toThrow(/reason code/);
    expect(() =>
      validateRecord({
        ...baseInvocation(),
        errorClass: "permission_denied",
      } as AuditRecord),
    ).not.toThrow();
    expect(() =>
      validateRecord({
        ...baseRun(),
        finalOutcome: "unresolved",
        failureReason: "検索失敗: 四半期統合計画.docx が見つかりません",
      } as AuditRecord),
    ).toThrow(/reason code/);
    expect(() =>
      validateRecord({
        ...baseRun(),
        finalOutcome: "unresolved",
        failureReason: "source_unreachable",
      } as AuditRecord),
    ).not.toThrow();
  });

  it("parseAuditRecord returns a typed record for unknown input", () => {
    const parsed = parseAuditRecord(JSON.parse(JSON.stringify(baseInvocation())));
    expect(parsed.recordType).toBe("tool_invocation");
    expect(() => parseAuditRecord({ recordType: "bogus" })).toThrow();
  });

  it("parseAuditRecord rejects forbidden keys in unknown input", () => {
    const tainted = {
      ...JSON.parse(JSON.stringify(baseInvocation())),
      token: "secret",
    };
    expect(() => parseAuditRecord(tainted)).toThrow(/forbidden/);
  });

  it("rejects raw query text fields on audit records (rawQuery belongs to its own table)", () => {
    const record = {
      ...baseInvocation(),
      rawQuery: "四半期レビューの議事録",
    } as AuditRecord;
    expect(() => validateRecord(record)).toThrow(/forbidden/);
  });
});

describe("schema shape (type-level absence of forbidden fields)", () => {
  const shapes = {
    answer_run: answerRunRecordSchema.shape,
    tool_invocation: toolInvocationRecordSchema.shape,
    audit_access: auditAccessRecordSchema.shape,
    retention_purge: retentionPurgeRecordSchema.shape,
  };

  it("no schema declares secret or candidate-count fields", () => {
    for (const [name, shape] of Object.entries(shapes)) {
      const keys = Object.keys(shape);
      for (const forbidden of FORBIDDEN_KEYS) {
        expect(keys, `${name} must not declare ${forbidden}`).not.toContain(
          forbidden,
        );
      }
    }
  });

  it("tool_invocation exposes returnedHitCount as the only count of hits", () => {
    const keys = Object.keys(shapes.tool_invocation);
    const countKeys = keys.filter((k) => /count/i.test(k));
    expect(countKeys.sort()).toEqual(
      ["fetchedDocCount", "retryCount", "returnedHitCount"].sort(),
    );
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

  it("propagates sink failures (fail-closed default is decided by the caller)", async () => {
    const sink: AuditSink = {
      write: async () => {
        throw new Error("store unavailable");
      },
    };
    const logger = new AuditLogger(sink);
    await expect(logger.log(baseInvocation())).rejects.toThrow(/unavailable/);
  });
});
