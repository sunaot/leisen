/**
 * 保持期間と期限超過削除(T-001、ADR-013 §3)。
 *
 * - 保持期間は deployment.yaml から注入する(設定スキーマ本体はT-010)。
 *   既定値: 監査ログ本体365日 / rawQuery 30日 / 分離テレメトリ14日。
 * - 期限超過分の削除を定期ジョブで実施し、**削除実行そのものを監査レコード
 *   (retention_purge)として記録する**。
 */
import { randomUUID } from "node:crypto";
import type { AuditLogger } from "./sink.js";
import type { RetentionPurgeRecord } from "./schema.js";

export interface RetentionConfig {
  /** AnswerRun / ToolInvocation(2層監査ログ本体)の保持日数 */
  auditRetentionDays: number;
  /** rawQueryテーブルの保持日数 */
  rawQueryRetentionDays: number;
  /** 分離テレメトリ(ADR-011 §2)の保持日数 */
  telemetryRetentionDays: number;
}

/** ADR-013 §3 の既定値。 */
export const DEFAULT_RETENTION: RetentionConfig = {
  auditRetentionDays: 365,
  rawQueryRetentionDays: 30,
  telemetryRetentionDays: 14,
};

/**
 * deployment.yaml 由来の部分指定に既定値を合成する。0以下・非整数は
 * 設定ミス(事実上の無期限化や即時削除)として拒否する。
 */
export function resolveRetentionConfig(
  overrides: Partial<RetentionConfig> = {},
): RetentionConfig {
  const config = { ...DEFAULT_RETENTION, ...overrides };
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${key} must be a positive integer (days), got: ${value}`);
    }
  }
  return config;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function retentionCutoffIso(now: Date, retentionDays: number): string {
  return new Date(now.getTime() - retentionDays * MS_PER_DAY).toISOString();
}

/** 期限超過分を削除できるストア。 */
export interface PurgeableStore {
  purgeBefore(cutoffIso: string): Promise<number>;
}

export interface RetentionPurgeTargets {
  auditStore: PurgeableStore;
  rawQueryStore?: PurgeableStore;
  telemetryStore?: PurgeableStore;
}

/**
 * 保持期限超過分の削除を実行し、各区画の削除実行を監査ログに記録する。
 * 定期ジョブ(リファレンスデプロイ、T-012)から呼ぶ。
 */
export async function runRetentionPurge(
  now: Date,
  retention: RetentionConfig,
  targets: RetentionPurgeTargets,
  logger: AuditLogger,
): Promise<RetentionPurgeRecord[]> {
  const jobs: Array<{
    target: RetentionPurgeRecord["target"];
    retentionDays: number;
    store: PurgeableStore;
  }> = [
    {
      target: "audit_log",
      retentionDays: retention.auditRetentionDays,
      store: targets.auditStore,
    },
  ];
  if (targets.rawQueryStore) {
    jobs.push({
      target: "raw_query",
      retentionDays: retention.rawQueryRetentionDays,
      store: targets.rawQueryStore,
    });
  }
  if (targets.telemetryStore) {
    jobs.push({
      target: "telemetry",
      retentionDays: retention.telemetryRetentionDays,
      store: targets.telemetryStore,
    });
  }

  const results: RetentionPurgeRecord[] = [];
  for (const job of jobs) {
    const cutoff = retentionCutoffIso(now, job.retentionDays);
    const deletedCount = await job.store.purgeBefore(cutoff);
    const purgeRecord: RetentionPurgeRecord = {
      purgeId: randomUUID(),
      timestamp: now.toISOString(),
      target: job.target,
      retentionDays: job.retentionDays,
      cutoff,
      deletedCount,
    };
    await logger.log({ recordType: "retention_purge", ...purgeRecord });
    results.push(purgeRecord);
  }
  return results;
}
