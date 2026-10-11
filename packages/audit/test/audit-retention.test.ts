import { describe, expect, it } from "vitest";
import {
  AuditLogger,
  DEFAULT_RETENTION,
  InMemoryAuditStore,
  InMemoryRawQueryStore,
  digestQuery,
  resolveRetentionConfig,
  retentionCutoffIso,
  runRetentionPurge,
  type AuditRecord,
} from "../src/index.js";

const NOW = new Date("2026-07-09T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function invocationAt(requestId: string, timestamp: string): AuditRecord {
  return {
    recordType: "tool_invocation",
    requestId,
    runId: "run-1",
    iteration: 0,
    userId: "user-1",
    timestamp,
    sourceId: "gdrive",
    tool: "search",
    queryDigest: digestQuery("q"),
    filtersDigest: null,
    returnedHitCount: 0,
    fetchedDocCount: 0,
    latencyMs: 10,
    errorClass: null,
    retryCount: 0,
  };
}

describe("retention config injection (ADR-013 §3)", () => {
  it("applies the documented defaults (365/30/14 days)", () => {
    expect(DEFAULT_RETENTION).toEqual({
      auditRetentionDays: 365,
      rawQueryRetentionDays: 30,
      telemetryRetentionDays: 14,
    });
    expect(resolveRetentionConfig()).toEqual(DEFAULT_RETENTION);
  });

  it("accepts deployment.yaml overrides", () => {
    const config = resolveRetentionConfig({ rawQueryRetentionDays: 7 });
    expect(config.rawQueryRetentionDays).toBe(7);
    expect(config.auditRetentionDays).toBe(365);
  });

  it("rejects zero, negative, and non-integer retention", () => {
    expect(() => resolveRetentionConfig({ auditRetentionDays: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => resolveRetentionConfig({ rawQueryRetentionDays: -5 })).toThrow(
      /positive integer/,
    );
    expect(() =>
      resolveRetentionConfig({ telemetryRetentionDays: 1.5 }),
    ).toThrow(/positive integer/);
  });

  it("computes cutoffs from now and retention days", () => {
    expect(retentionCutoffIso(NOW, 30)).toBe(
      new Date(NOW.getTime() - 30 * DAY_MS).toISOString(),
    );
  });
});

describe("runRetentionPurge (削除実行の記録)", () => {
  it("purges expired records and logs one retention_purge record per target", async () => {
    const auditStore = new InMemoryAuditStore();
    await auditStore.writeBatch([
      invocationAt("old", new Date(NOW.getTime() - 400 * DAY_MS).toISOString()),
      invocationAt("recent", new Date(NOW.getTime() - 1 * DAY_MS).toISOString()),
    ]);
    const rawQueryStore = new InMemoryRawQueryStore();
    await rawQueryStore.append({
      queryDigest: digestQuery("古いクエリ"),
      rawQuery: "古いクエリ",
      userId: "user-1",
      timestamp: new Date(NOW.getTime() - 31 * DAY_MS).toISOString(),
    });

    const logSink = new InMemoryAuditStore();
    const logger = new AuditLogger({
      write: (r) => logSink.writeBatch([r]),
    });

    const results = await runRetentionPurge(
      NOW,
      resolveRetentionConfig(),
      { auditStore, rawQueryStore },
      logger,
    );

    expect(results).toHaveLength(2);
    const byTarget = Object.fromEntries(results.map((r) => [r.target, r]));
    expect(byTarget["audit_log"]?.deletedCount).toBe(1);
    expect(byTarget["audit_log"]?.retentionDays).toBe(365);
    expect(byTarget["raw_query"]?.deletedCount).toBe(1);
    expect(byTarget["raw_query"]?.retentionDays).toBe(30);

    // 期限内レコードは残る
    expect(auditStore.records().map((r) => r.recordType)).toEqual([
      "tool_invocation",
    ]);
    // 削除実行そのものが監査レコードとして記録される
    const purgeLogs = logSink
      .records()
      .filter((r) => r.recordType === "retention_purge");
    expect(purgeLogs).toHaveLength(2);
  });

  it("purges the telemetry store with its own retention (14 days default)", async () => {
    const auditStore = new InMemoryAuditStore();
    let purgedCutoff: string | null = null;
    const telemetryStore = {
      purgeBefore: async (cutoff: string) => {
        purgedCutoff = cutoff;
        return 3;
      },
    };
    const logSink = new InMemoryAuditStore();
    const logger = new AuditLogger({ write: (r) => logSink.writeBatch([r]) });
    const results = await runRetentionPurge(
      NOW,
      resolveRetentionConfig(),
      { auditStore, telemetryStore },
      logger,
    );
    const telemetry = results.find((r) => r.target === "telemetry");
    expect(telemetry?.retentionDays).toBe(14);
    expect(telemetry?.deletedCount).toBe(3);
    expect(purgedCutoff).toBe(retentionCutoffIso(NOW, 14));
  });

  it("skips optional stores that are not configured", async () => {
    const auditStore = new InMemoryAuditStore();
    const logSink = new InMemoryAuditStore();
    const logger = new AuditLogger({ write: (r) => logSink.writeBatch([r]) });
    const results = await runRetentionPurge(
      NOW,
      resolveRetentionConfig(),
      { auditStore },
      logger,
    );
    expect(results.map((r) => r.target)).toEqual(["audit_log"]);
  });
});
