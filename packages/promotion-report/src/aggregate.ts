/**
 * 昇格判定レポートの集計(T-014、ADR-006「有効化は証拠駆動」)。
 *
 * 2層監査ログ(ADR-011)から、ソース別未解決率(AnswerRun単位)・
 * 再検索回数分布(runIdで束ねたToolInvocation)・失敗クエリを集計する。
 * SQL版のサンプルは docs/audit-queries.md。将来の管理画面化を見据え、
 * この集計は表示(render.ts / cli.ts)から分離した純粋関数にする。
 *
 * 扱わないもの:
 * - **post-filtering前の候補件数**: フィールド自体が監査スキーマに存在しない
 *   (ADR-011/012、existence leak対策)。本モジュールでも導入しない
 * - **分離テレメトリ**(ADR-011 §2): 本レポートの対象外。入力にも取らない
 * - **Slack由来のdocId等のメタデータ**: そもそも記録されない(ADR-013 §2)。
 *   sourceId はデプロイ設定上の識別子でありSlack由来データではない
 *
 * 監査ログへのアクセス自体がメタ監査の対象(ADR-013 §3)。本集計は
 * audit_access レコード(purpose: promotion_report)を生成して返すので、
 * 呼び出し側は必ずそれを監査ストアに書き込むこと。
 */
import { randomUUID } from "node:crypto";
import type {
  AnswerRunRecord,
  AuditAccessRecord,
  AuditRecord,
  RawQueryRecord,
  ToolInvocationRecord,
} from "@kp/gateway";
import {
  classifySource,
  type PromotionEligibility,
  type SourcesMeta,
} from "./sources.js";

export interface SourceStat {
  sourceId: string;
  eligibility: PromotionEligibility;
  /** このソースへのツール呼び出しがあった、結果確定済み(resolved/unresolved)run数 */
  runs: number;
  unresolvedRuns: number;
  /** unresolvedRuns / runs。runs=0 なら null */
  unresolvedRate: number | null;
  /** 全未解決runに占める、このソースを検索していたrunの割合(5.1「ソース起因の割合」の近似) */
  shareOfUnresolved: number | null;
  /** ツール呼び出し総数(結果確定済みrun以外も含む) */
  invocations: number;
}

export interface IterationBucket {
  /** searchツールの反復回数(max(iteration)+1) */
  searchIterations: number;
  runs: number;
  unresolvedRuns: number;
}

export interface FailedQuery {
  runId: string;
  startedAt: string;
  finalQueryDigest: string | null;
  /**
   * 生クエリ原文。rawQueryテーブル(短期保持、既定30日 — ADR-013 §3)に
   * 残っている場合のみ。保持期間切れは null + status: "expired_or_missing"。
   */
  rawQuery: string | null;
  status: "available" | "expired_or_missing" | "no_digest";
  failureReason: string | null;
  searchedSources: readonly string[];
}

export interface PromotionReport {
  /** ISO 8601(レポート生成時刻) */
  generatedAt: string;
  inputRecordCount: number;
  totalRuns: number;
  resolvedRuns: number;
  unresolvedRuns: number;
  /** finalOutcome が pending / error のrun。率の分母に入れない */
  undecidedRuns: number;
  /** shareOfUnresolved 降順(判定対象外・未分類は後方) */
  sourceStats: SourceStat[];
  iterationDistribution: IterationBucket[];
  /** 未解決run(startedAt降順) */
  failedQueries: FailedQuery[];
  /**
   * 本集計の実行を表すメタ監査レコード(ADR-013 §3)。呼び出し側が
   * 監査ストアへ書き込む義務を負う。rawQueryを参照した場合は
   * target: "raw_query" のレコードも含まれる。
   */
  metaAuditRecords: AuditRecord[];
}

export interface PromotionReportInput {
  records: readonly AuditRecord[];
  /** sourceId → 分類メタ。分類のないソースは unclassified 扱い */
  sources: SourcesMeta;
  /**
   * rawQueryテーブルの中身(保持期間内のレコードのみ存在する前提)。
   * 省略時は原文参照を行わず、target: "raw_query" のメタ監査も生成しない。
   */
  rawQueries?: readonly RawQueryRecord[];
  /** レポート実行者(監査閲覧担当)のユーザーID。メタ監査に記録する */
  accessorUserId: string;
  /** テスト用に注入可能な現在時刻 */
  now?: Date;
}

type AnswerRun = AnswerRunRecord & { recordType: "answer_run" };
type ToolInvocation = ToolInvocationRecord & { recordType: "tool_invocation" };

function isDecided(run: AnswerRun): boolean {
  return run.finalOutcome === "resolved" || run.finalOutcome === "unresolved";
}

/**
 * パッケージ外向けの入口。メタ監査の書き込み(ADR-013 §3)を型で強制する:
 * writeMetaAudit が成功するまでレポートを返さない(fail-closed、不変条件2)。
 * 集計だけの aggregatePromotionReport は誤用(集計結果の利用+メタ監査未記録)
 * を防ぐため index.ts から公開しない。
 */
export async function generatePromotionReport(
  input: PromotionReportInput,
  writeMetaAudit: (records: readonly AuditRecord[]) => Promise<void>,
): Promise<PromotionReport> {
  const report = aggregatePromotionReport(input);
  await writeMetaAudit(report.metaAuditRecords);
  return report;
}

export function aggregatePromotionReport(
  input: PromotionReportInput,
): PromotionReport {
  const now = input.now ?? new Date();
  if (!input.accessorUserId) {
    throw new Error("accessorUserId is required (meta audit, ADR-013 §3)");
  }

  // メタ監査(audit_access / retention_purge)レコードは集計対象のrunデータではない
  const answerRuns = input.records.filter(
    (r): r is AnswerRun => r.recordType === "answer_run",
  );
  const invocations = input.records.filter(
    (r): r is ToolInvocation => r.recordType === "tool_invocation",
  );

  const runById = new Map(answerRuns.map((r) => [r.runId, r]));
  const decidedRuns = answerRuns.filter(isDecided);
  const unresolvedTotal = decidedRuns.filter(
    (r) => r.finalOutcome === "unresolved",
  ).length;

  // --- ソース別未解決率(docs/audit-queries.md §1 と同じ結合) ---
  const bySource = new Map<
    string,
    { runIds: Set<string>; unresolvedRunIds: Set<string>; invocations: number }
  >();
  for (const ti of invocations) {
    let stat = bySource.get(ti.sourceId);
    if (!stat) {
      stat = { runIds: new Set(), unresolvedRunIds: new Set(), invocations: 0 };
      bySource.set(ti.sourceId, stat);
    }
    stat.invocations += 1;
    const run = runById.get(ti.runId);
    if (run && isDecided(run)) {
      stat.runIds.add(ti.runId);
      if (run.finalOutcome === "unresolved") stat.unresolvedRunIds.add(ti.runId);
    }
  }

  const eligibilityOrder: Record<PromotionEligibility, number> = {
    eligible: 0,
    exempt_index_required: 1,
    excluded_slack: 2,
    unclassified: 3,
  };
  const sourceStats: SourceStat[] = [...bySource.entries()]
    .map(([sourceId, s]) => {
      const runs = s.runIds.size;
      const unresolvedRuns = s.unresolvedRunIds.size;
      return {
        sourceId,
        eligibility: classifySource(sourceId, input.sources),
        runs,
        unresolvedRuns,
        unresolvedRate: runs > 0 ? unresolvedRuns / runs : null,
        shareOfUnresolved:
          unresolvedTotal > 0 ? unresolvedRuns / unresolvedTotal : null,
        invocations: s.invocations,
      };
    })
    .sort(
      (a, b) =>
        eligibilityOrder[a.eligibility] - eligibilityOrder[b.eligibility] ||
        (b.shareOfUnresolved ?? 0) - (a.shareOfUnresolved ?? 0) ||
        a.sourceId.localeCompare(b.sourceId),
    );

  // --- 再検索回数分布(docs/audit-queries.md §2) ---
  const searchIterationsByRun = new Map<string, number>();
  for (const ti of invocations) {
    if (ti.tool !== "search") continue;
    const run = runById.get(ti.runId);
    if (!run || !isDecided(run)) continue;
    const prev = searchIterationsByRun.get(ti.runId) ?? -1;
    searchIterationsByRun.set(ti.runId, Math.max(prev, ti.iteration));
  }
  const buckets = new Map<number, IterationBucket>();
  for (const [runId, maxIteration] of searchIterationsByRun) {
    const searchIterations = maxIteration + 1;
    let bucket = buckets.get(searchIterations);
    if (!bucket) {
      bucket = { searchIterations, runs: 0, unresolvedRuns: 0 };
      buckets.set(searchIterations, bucket);
    }
    bucket.runs += 1;
    if (runById.get(runId)?.finalOutcome === "unresolved") {
      bucket.unresolvedRuns += 1;
    }
  }
  const iterationDistribution = [...buckets.values()].sort(
    (a, b) => a.searchIterations - b.searchIterations,
  );

  // --- 失敗クエリの原文表示(docs/audit-queries.md §3、LEFT JOIN相当) ---
  // digestのみでは判定材料にならないため原文を引くが、保持期間切れで
  // 原文が存在しないのは正常系(短期保持の設計どおり)。
  const rawByKey = new Map<string, string>();
  for (const rq of input.rawQueries ?? []) {
    // 同一digestが複数ユーザーに存在しうるため userId も結合キーに含める
    rawByKey.set(`${rq.queryDigest} ${rq.userId}`, rq.rawQuery);
  }
  const failedQueries: FailedQuery[] = answerRuns
    .filter((r) => r.finalOutcome === "unresolved")
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((run) => {
      let rawQuery: string | null = null;
      let status: FailedQuery["status"] = "no_digest";
      if (run.finalQueryDigest) {
        rawQuery =
          rawByKey.get(`${run.finalQueryDigest} ${run.userId}`) ?? null;
        status = rawQuery !== null ? "available" : "expired_or_missing";
      }
      return {
        runId: run.runId,
        startedAt: run.startedAt,
        finalQueryDigest: run.finalQueryDigest,
        rawQuery,
        status,
        failureReason: run.failureReason,
        searchedSources: run.searchedSources,
      };
    });

  // --- メタ監査(ADR-013 §3、TM-F3) ---
  const timestamp = now.toISOString();
  const metaAuditRecords: AuditRecord[] = [
    accessRecord(input.accessorUserId, timestamp, "audit_log", input.records.length),
  ];
  if (input.rawQueries !== undefined) {
    metaAuditRecords.push(
      accessRecord(input.accessorUserId, timestamp, "raw_query", input.rawQueries.length),
    );
  }

  return {
    generatedAt: timestamp,
    inputRecordCount: input.records.length,
    totalRuns: answerRuns.length,
    resolvedRuns: decidedRuns.length - unresolvedTotal,
    unresolvedRuns: unresolvedTotal,
    undecidedRuns: answerRuns.length - decidedRuns.length,
    sourceStats,
    iterationDistribution,
    failedQueries,
    metaAuditRecords,
  };
}

function accessRecord(
  accessorUserId: string,
  timestamp: string,
  target: AuditAccessRecord["target"],
  recordCount: number,
): AuditRecord {
  return {
    recordType: "audit_access",
    accessId: randomUUID(),
    accessorUserId,
    timestamp,
    purpose: "promotion_report",
    target,
    // 抽出条件の要約のみ。閲覧結果の内容は書かない(ADR-013 §3)
    scopeDescription: `T-014 promotion report over ${recordCount} records`,
  };
}
