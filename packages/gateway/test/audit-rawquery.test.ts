import { describe, expect, it } from "vitest";
import {
  InMemoryRawQueryStore,
  digestQuery,
  validateRawQueryRecord,
  type RawQueryRecord,
} from "../src/audit/index.js";

function record(rawQuery: string, timestamp: string): RawQueryRecord {
  return {
    queryDigest: digestQuery(rawQuery),
    rawQuery,
    userId: "user-1",
    timestamp,
  };
}

describe("rawQuery table (ADR-011 §3)", () => {
  it("validates that queryDigest matches sha256(rawQuery) — join key integrity", () => {
    const good = record("経費精算の締め日", new Date().toISOString());
    expect(() => validateRawQueryRecord(good)).not.toThrow();
    const bad = { ...good, queryDigest: digestQuery("別のクエリ") };
    expect(() => validateRawQueryRecord(bad)).toThrow(/does not match/);
  });

  it("joins with audit records via queryDigest", async () => {
    const store = new InMemoryRawQueryStore();
    const raw = record("経費精算の締め日", new Date().toISOString());
    await store.append(raw);
    // 監査レコード側は digest のみを持つ(schema.ts)。digestで原文を引く
    const found = await store.findByDigest(digestQuery("経費精算の締め日"));
    expect(found).toHaveLength(1);
    expect(found[0]?.rawQuery).toBe("経費精算の締め日");
  });

  it("purges records older than the retention cutoff and reports the count", async () => {
    const store = new InMemoryRawQueryStore();
    const now = Date.parse("2026-07-09T00:00:00.000Z");
    const old = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();
    await store.append(record("古いクエリ", old));
    await store.append(record("新しいクエリ", recent));
    const cutoff = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    const deleted = await store.purgeBefore(cutoff);
    expect(deleted).toBe(1);
    expect(store.size()).toBe(1);
    expect(await store.findByDigest(digestQuery("古いクエリ"))).toHaveLength(0);
  });

  it("rejects an invalid cutoff", async () => {
    const store = new InMemoryRawQueryStore();
    await expect(store.purgeBefore("not-a-date")).rejects.toThrow(/ISO 8601/);
  });
});
