import { describe, expect, it } from "vitest";
import {
  BufferedAuditSink,
  InMemoryAuditStore,
  digestQuery,
  type AuditRecord,
  type AuditStoreWriter,
} from "../src/index.js";

function invocation(requestId: string): AuditRecord {
  return {
    recordType: "tool_invocation",
    requestId,
    runId: "run-1",
    iteration: 0,
    userId: "user-1",
    timestamp: new Date().toISOString(),
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

/** 指定回数失敗してから成功するwriter(at-least-once検証用)。 */
class FlakyWriter implements AuditStoreWriter {
  readonly store = new InMemoryAuditStore();
  attempts = 0;
  constructor(public failuresBeforeSuccess: number) {}

  async writeBatch(records: readonly AuditRecord[]): Promise<void> {
    this.attempts++;
    if (this.failuresBeforeSuccess > 0) {
      this.failuresBeforeSuccess--;
      throw new Error("store temporarily unavailable");
    }
    await this.store.writeBatch(records);
  }
}

describe("BufferedAuditSink (ADR-011 §4)", () => {
  it("persists records through the writer", async () => {
    const writer = new FlakyWriter(0);
    const sink = new BufferedAuditSink(writer);
    await sink.write(invocation("req-1"));
    expect(writer.store.records()).toHaveLength(1);
    expect(sink.bufferedCount()).toBe(0);
  });

  it("retries transient failures with backoff", async () => {
    const writer = new FlakyWriter(2);
    const sink = new BufferedAuditSink(writer, { retryBaseDelayMs: 1 });
    await sink.write(invocation("req-1"));
    expect(writer.attempts).toBe(3);
    expect(writer.store.records()).toHaveLength(1);
  });

  it("keeps records in the local buffer across an outage and delivers them later (at-least-once)", async () => {
    const writer = new FlakyWriter(10); // retry上限(既定3+初回)を超える障害
    const sink = new BufferedAuditSink(writer, {
      maxRetries: 1,
      retryBaseDelayMs: 1,
    });
    await sink.write(invocation("req-1")); // 永続化失敗するが受理される
    expect(sink.bufferedCount()).toBe(1);
    expect(writer.store.records()).toHaveLength(0);

    writer.attempts = 0;
    writer.failuresBeforeSuccess = 0; // 障害解消
    await sink.write(invocation("req-2"));
    // 先にバッファされていた req-1 も一緒に届く
    expect(writer.store.records().map((r) => (r.recordType === "tool_invocation" ? r.requestId : ""))).toEqual(
      expect.arrayContaining(["req-1", "req-2"]),
    );
    expect(sink.bufferedCount()).toBe(0);
  });

  it("rejects writes when the local buffer overflows (fail-closed)", async () => {
    const writer = new FlakyWriter(1000);
    const sink = new BufferedAuditSink(writer, {
      maxBufferSize: 2,
      maxRetries: 0,
      retryBaseDelayMs: 1,
    });
    await sink.write(invocation("req-1"));
    await sink.write(invocation("req-2"));
    await expect(sink.write(invocation("req-3"))).rejects.toThrow(
      /buffer overflow/,
    );
  });

  it("flush drains the buffer, and throws if records remain (shutdown visibility, TM-F2)", async () => {
    const writer = new FlakyWriter(2);
    const sink = new BufferedAuditSink(writer, {
      maxRetries: 0,
      retryBaseDelayMs: 1,
    });
    await sink.write(invocation("req-1")); // 失敗→バッファ滞留
    expect(sink.bufferedCount()).toBe(1);
    // まだ障害中: flushは例外で欠落を可視化する
    await expect(sink.flush()).rejects.toThrow(/flush incomplete|unavailable/);
    // 障害解消後のflushで永続化しきる
    await sink.flush();
    expect(sink.bufferedCount()).toBe(0);
    expect(writer.store.records()).toHaveLength(1);
  });

  it("validates records before buffering", async () => {
    const writer = new FlakyWriter(0);
    const sink = new BufferedAuditSink(writer);
    const bad = { ...invocation("req-1"), candidateCount: 5 } as AuditRecord;
    await expect(sink.write(bad)).rejects.toThrow(/forbidden/);
    expect(sink.bufferedCount()).toBe(0);
  });

  it("StdoutDebugAuditSink validates records before writing", async () => {
    const { StdoutDebugAuditSink } = await import("../src/index.js");
    const sink = new StdoutDebugAuditSink();
    const bad = { ...invocation("req-1"), snippet: "本文断片" } as AuditRecord;
    await expect(sink.write(bad)).rejects.toThrow(/forbidden/);
  });

  it("store writer deduplicates at-least-once redelivery by idempotency key", async () => {
    const store = new InMemoryAuditStore();
    const record = invocation("req-1");
    await store.writeBatch([record]);
    await store.writeBatch([record]); // 再送
    expect(store.records()).toHaveLength(1);
  });
});
