/**
 * rawQueryテーブル(T-001、ADR-011 §3)。
 *
 * - 生クエリの原文は監査レコード本体に置かず、この短期保持の別テーブルに置く。
 *   監査レコード側の queryDigest と結合して T-014 が失敗クエリの原文参照に使う
 *   (結合例は docs/audit-queries.md)。
 * - 質問文自体に機密が含まれる前提で扱う(TM-F4)。保持期間は deployment.yaml
 *   から注入する(既定30日、ADR-013 §3)。期限超過分の削除は retention.ts。
 * - 監査ログ本体とはアクセス経路も分離する(AuditSink には流さない)。
 */
import { z } from "zod";
import { digestQuery } from "./schema.js";

export const rawQueryRecordSchema = z.strictObject({
  /** 監査レコードとの結合キー(SHA-256) */
  queryDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "must be a sha256 hex digest"),
  /** 生クエリ原文。機密を含みうる(TM-F4)。短期保持 */
  rawQuery: z.string().min(1),
  /** 権限の主体(誰の質問か) */
  userId: z.string().min(1),
  /** ISO 8601 */
  timestamp: z.iso.datetime({ offset: true }),
});

export type RawQueryRecord = z.infer<typeof rawQueryRecordSchema>;

export interface RawQueryStore {
  append(record: RawQueryRecord): Promise<void>;
  findByDigest(queryDigest: string): Promise<readonly RawQueryRecord[]>;
  /** cutoff(ISO 8601)より前のレコードを削除し、削除件数を返す。 */
  purgeBefore(cutoffIso: string): Promise<number>;
}

/**
 * レコードを検証する。digestが原文と一致しない登録は結合を壊すため拒否する。
 */
export function validateRawQueryRecord(record: RawQueryRecord): void {
  rawQueryRecordSchema.parse(record);
  if (digestQuery(record.rawQuery) !== record.queryDigest) {
    throw new Error("queryDigest does not match sha256(rawQuery)");
  }
}

/** 開発・テスト用のインメモリ実装。永続実装はT-003以降のデプロイ構成で選ぶ。 */
export class InMemoryRawQueryStore implements RawQueryStore {
  private records: RawQueryRecord[] = [];

  async append(record: RawQueryRecord): Promise<void> {
    validateRawQueryRecord(record);
    this.records.push(record);
  }

  async findByDigest(queryDigest: string): Promise<readonly RawQueryRecord[]> {
    return this.records.filter((r) => r.queryDigest === queryDigest);
  }

  async purgeBefore(cutoffIso: string): Promise<number> {
    const cutoff = Date.parse(cutoffIso);
    if (Number.isNaN(cutoff)) {
      throw new Error("cutoffIso must be a valid ISO 8601 timestamp");
    }
    const before = this.records.length;
    this.records = this.records.filter(
      (r) => Date.parse(r.timestamp) >= cutoff,
    );
    return before - this.records.length;
  }

  /** テスト検査用 */
  size(): number {
    return this.records.length;
  }
}
