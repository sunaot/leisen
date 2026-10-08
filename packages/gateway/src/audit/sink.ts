/**
 * 監査シンク(T-001、ADR-011 §4)。
 *
 * - AuditSink.write は Promise を返す。実運用のシンクは永続ストアへの書き込み・
 *   retry・local buffer・at-least-once・shutdown時flushを担うため非同期。
 * - 永続sink(BufferedAuditSink)とstdoutデバッグsink(StdoutDebugAuditSink)を
 *   分離する。stdout は at-least-once を保証しないため本番監査に使わない。
 * - 書き込み失敗時の挙動は ADR-011: 既定 fail-closed(監査レコードを書けない
 *   ツール呼び出しは失敗させる)+ローカルバッファによる緩和。本モジュールでは
 *   「バッファ容量内なら受理(後続で再試行)、容量超過・flush不能は例外」を
 *   実装し、ツール呼び出しを失敗させる判断はGateway統合(T-003)が担う。
 */
import {
  type AuditRecord,
  validateRecord,
} from "./schema.js";

export interface AuditSink {
  write(record: AuditRecord): Promise<void>;
  /** shutdown時にバッファを永続化しきる。stdout等では no-op。 */
  flush?(): Promise<void>;
}

/**
 * デバッグ用シンク: 構造化JSONをstdoutへ。開発・ローカル用。
 * 注意: stdout単体では at-least-once を保証しない。本番監査には使わない。
 */
export class StdoutDebugAuditSink implements AuditSink {
  async write(record: AuditRecord): Promise<void> {
    validateRecord(record);
    process.stdout.write(JSON.stringify({ kind: "audit", ...record }) + "\n");
  }
}

/**
 * 永続ストアへの書き込み口。実装は監査ストア(append-only構成を標準とする、
 * TM-F1)ごとに用意する。**再試行により同一レコードが複数回渡りうる
 * (at-least-once)ため、requestId / runId / accessId / purgeId で冪等に
 * 処理すること。**
 */
export interface AuditStoreWriter {
  writeBatch(records: readonly AuditRecord[]): Promise<void>;
}

export interface BufferedAuditSinkOptions {
  /** ローカルバッファの上限。超過時のwriteは例外(fail-closedの可視化) */
  maxBufferSize?: number;
  /** writeBatch の再試行回数(初回を除く) */
  maxRetries?: number;
  /** 再試行の初期待機ms(指数バックオフ) */
  retryBaseDelayMs?: number;
}

const DEFAULT_OPTIONS: Required<BufferedAuditSinkOptions> = {
  maxBufferSize: 1000,
  maxRetries: 3,
  retryBaseDelayMs: 100,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 本番用の永続sink。
 * - write: 検証→ローカルバッファ→書き込み試行(retry付き)。永続化に失敗しても
 *   バッファ容量内であれば受理し、レコードはバッファに残して後続の
 *   write/flush で再送する(at-least-once)。容量超過は例外。
 * - flush: バッファを永続化しきる。しきれない場合は例外(shutdown時に欠落へ
 *   気づけるようにする — TM-F2)。
 */
export class BufferedAuditSink implements AuditSink {
  private readonly options: Required<BufferedAuditSinkOptions>;
  private buffer: AuditRecord[] = [];
  /** flushの直列化(順序保存・同時実行防止) */
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly writer: AuditStoreWriter,
    options: BufferedAuditSinkOptions = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async write(record: AuditRecord): Promise<void> {
    validateRecord(record);
    if (this.buffer.length >= this.options.maxBufferSize) {
      // バッファでも吸収できない状態。ADR-011のfail-closed既定では
      // ツール呼び出し自体を失敗させる(判断はT-003のGateway統合)。
      throw new Error(
        "audit local buffer overflow: record rejected (fail-closed)",
      );
    }
    this.buffer.push(record);
    // 永続化失敗はここでは飲み込む(レコードはバッファに残り再送される)。
    await this.runExclusive(() => this.tryDrain()).catch(() => {});
  }

  async flush(): Promise<void> {
    await this.runExclusive(() => this.tryDrain());
    if (this.buffer.length > 0) {
      throw new Error(
        `audit flush incomplete: ${this.buffer.length} record(s) still buffered`,
      );
    }
  }

  /** テスト・監視用: 未永続レコード数。 */
  bufferedCount(): number {
    return this.buffer.length;
  }

  private runExclusive(task: () => Promise<void>): Promise<void> {
    const next = this.pending.then(task, task);
    // 失敗を保持したままにしない(次のrunExclusiveを妨げない)
    this.pending = next.catch(() => {});
    return next;
  }

  private async tryDrain(): Promise<void> {
    while (this.buffer.length > 0) {
      const batch = [...this.buffer];
      await this.writeBatchWithRetry(batch);
      // 成功した分だけ取り除く(tryDrain中のwriteは末尾に追記されている)
      this.buffer = this.buffer.slice(batch.length);
    }
  }

  private async writeBatchWithRetry(
    batch: readonly AuditRecord[],
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      if (attempt > 0) {
        await delay(this.options.retryBaseDelayMs * 2 ** (attempt - 1));
      }
      try {
        await this.writer.writeBatch(batch);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("audit writeBatch failed");
  }
}

/** レコード種別ごとの時刻フィールドを取り出す(保持期限判定用)。 */
export function recordTimestamp(record: AuditRecord): string {
  return record.recordType === "answer_run" ? record.startedAt : record.timestamp;
}

/**
 * 開発・テスト用のインメモリ監査ストア。writeBatch は requestId 等の
 * 冪等キーで重複を除去する(at-least-once 再送の受け側の参照実装)。
 */
export class InMemoryAuditStore implements AuditStoreWriter {
  private byKey = new Map<string, AuditRecord>();

  async writeBatch(records: readonly AuditRecord[]): Promise<void> {
    for (const record of records) {
      this.byKey.set(auditRecordIdempotencyKey(record), record);
    }
  }

  async purgeBefore(cutoffIso: string): Promise<number> {
    const cutoff = Date.parse(cutoffIso);
    if (Number.isNaN(cutoff)) {
      throw new Error("cutoffIso must be a valid ISO 8601 timestamp");
    }
    let deleted = 0;
    for (const [key, record] of this.byKey) {
      if (Date.parse(recordTimestamp(record)) < cutoff) {
        this.byKey.delete(key);
        deleted++;
      }
    }
    return deleted;
  }

  records(): readonly AuditRecord[] {
    return [...this.byKey.values()];
  }
}

/**
 * 監査レコードの冪等キー(レコード種別ごと: tool_invocation は requestId、answer_run は
 * runId、audit_access は accessId、retention_purge は purgeId)。at-least-once の再送で
 * 同じレコードが複数回書かれうるため(BufferedAuditSink、JSONL の重複行)、読み手・
 * 受け手はこのキーで重複を除く。同じキーのレコードは後から書かれたものを採る
 * (InMemoryAuditStore、promotion-report の集計)。
 */
export function auditRecordIdempotencyKey(record: AuditRecord): string {
  switch (record.recordType) {
    case "answer_run":
      return `answer_run:${record.runId}`;
    case "tool_invocation":
      return `tool_invocation:${record.requestId}`;
    case "audit_access":
      return `audit_access:${record.accessId}`;
    case "retention_purge":
      return `retention_purge:${record.purgeId}`;
  }
}

export class AuditLogger {
  constructor(private readonly sink: AuditSink) {}

  async log(record: AuditRecord): Promise<void> {
    validateRecord(record);
    await this.sink.write(record);
  }

  async flush(): Promise<void> {
    await this.sink.flush?.();
  }
}
