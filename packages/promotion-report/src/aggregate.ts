/**
 * 昇格判定レポートの集計(T-014、ADR-006「有効化は証拠駆動」)。
 *
 * 2層監査ログ(ADR-011)から、ソース別未解決率(AnswerRun単位)・
 * 再検索回数分布(run 内の search 呼び出し件数)・失敗クエリを集計する。
 * SQL版のサンプルは docs/audit-queries.md。将来の管理画面化を見据え、
 * この集計は表示(render.ts / cli.ts)から分離した純粋関数にする。
 *
 * 入力の重複: 監査 JSONL は at-least-once で同じレコードが複数行に現れうるため、
 * 冪等キー(requestId / runId / accessId / purgeId)で重複を除いてから集計する
 * (dedupeAuditRecords)。
 *
 * AnswerRun と ToolInvocation の結合は (runId, userId)(docs/audit-queries.md §0)。
 * runId は呼び出し元の申告で Gateway は認証しないため、runId だけで結合すると、別の
 * 利用者が同じ runId を申告した呼び出しを他人の run に混ぜうる。同じ runId の AnswerRun が
 * あるのに userId が一致しない ToolInvocation は、どの run の呼び出しか確定できないので
 * 集計(ソース別・再検索回数)から除外し、run ごとの件数だけを警告(userMismatchWarnings)に
 * 出す。警告に userId・文書ID・クエリは出さない。AnswerRun のない runId の ToolInvocation
 * (runId 未申告の単発呼び出し等)は不一致ではなく、ソース別の呼び出し数にだけ数える。
 *
 * iteration(ADR-011 追記、ADR-017 決定2)は run 内のツール呼び出しの通番(0 始まり。
 * describe / search / fetch / list をすべて含み、並列呼び出しも個別に採番)であり、run 内の
 * 順序付けにだけ意味がある。回数の集計には使わない(max(iteration)+1 は describe や fetch の
 * 呼び出しまで数えてしまう。ADR-017 確認事項4)。
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
import {
  auditRecordIdempotencyKey,
  type AnswerRunRecord,
  type AuditAccessRecord,
  type AuditRecord,
  type RawQueryRecord,
  type ToolInvocationRecord,
} from "@kp/gateway";
import {
  classifySource,
  type PromotionEligibility,
  type SourcesMeta,
} from "./sources.js";

export interface SourceStat {
  sourceId: string;
  eligibility: PromotionEligibility;
  /**
   * このソースを探索した(describe 以外 — search / fetch / list — の呼び出しがあった)、
   * 結果確定済み(resolved/unresolved)run数。describe は数えない: T-007 の Orchestrator は
   * run の冒頭で全ソースに describe を呼ぶため、数えると全ソースが全 run に現れる
   */
  runs: number;
  unresolvedRuns: number;
  /** unresolvedRuns / runs。runs=0 なら null */
  unresolvedRate: number | null;
  /** 全未解決runに占める、このソースを検索していたrunの割合(5.1「ソース起因の割合」の近似) */
  shareOfUnresolved: number | null;
  /**
   * ツール呼び出し総数(describe を含む。結果確定済みrun以外・AnswerRun のない単発呼び出しも
   * 含む。userId が AnswerRun と一致せず除外したものは含まない)
   */
  invocations: number;
}

/**
 * 再検索回数分布の1区分。再検索回数 = run 内の search の ToolInvocation の件数
 * (重複行を除き、(runId, userId) で束ねたもの)。0回 = 検索なし、1回 = 1発、
 * 2回以上 = 再検索。describe / fetch / list の呼び出しは数えない。
 */
export interface SearchCountBucket {
  /** run 内の search 呼び出し件数 */
  searchCount: number;
  runs: number;
  unresolvedRuns: number;
}

/**
 * (runId, userId) 結合の不一致の警告(docs/audit-queries.md §0)。同じ runId の AnswerRun が
 * あるのに userId が一致しない ToolInvocation を集計から除外した件数。原因(実装の不具合・
 * runId の申告の偽装)の調査は §0 のクエリで行う。内容は runId と件数のみ(userId・
 * 文書ID・クエリは出さない)。
 */
export interface UserMismatchWarning {
  runId: string;
  /** 集計から除外した ToolInvocation の件数(重複行を除いた後) */
  invocations: number;
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
  /** 入力レコード数(重複行を含む、読んだまま) */
  inputRecordCount: number;
  /**
   * 冪等キーの重複として集計から除いたレコード数(at-least-once の再送による
   * JSONL の重複行。同じキーは後のレコードを採る)
   */
  duplicateRecordCount: number;
  totalRuns: number;
  resolvedRuns: number;
  unresolvedRuns: number;
  /** finalOutcome が pending / error のrun。率の分母に入れない */
  undecidedRuns: number;
  /** shareOfUnresolved 降順(判定対象外・未分類は後方) */
  sourceStats: SourceStat[];
  /**
   * 再検索回数分布(searchCount 昇順)。結果確定済みrunを1件ずつ、いずれかの区分に入れる
   * (search のないrunは 0回。区分の runs の合計 = resolvedRuns + unresolvedRuns)
   */
  searchCountDistribution: SearchCountBucket[];
  /** 未解決run(startedAt降順) */
  failedQueries: FailedQuery[];
  /**
   * 警告: runId は同じだが userId が AnswerRun と一致しない ToolInvocation(runId 昇順)。
   * これらは sourceStats / searchCountDistribution の集計から除外してある
   */
  userMismatchWarnings: UserMismatchWarning[];
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

/** 集計に使う ToolInvocation と、(runId, userId) で束ねた AnswerRun。 */
interface CountedInvocation {
  invocation: ToolInvocation;
  /** 同じ runId・同じ userId の AnswerRun。AnswerRun のない runId(単発呼び出し等)は undefined */
  run: AnswerRun | undefined;
}

/**
 * ToolInvocation を AnswerRun に (runId, userId) で結合する(docs/audit-queries.md §0)。
 * 同じ runId の AnswerRun があるのに userId が異なるものは counted に入れず、runId ごとの
 * 件数だけを mismatchedByRunId に数える。
 */
function joinInvocationsToRuns(
  invocations: readonly ToolInvocation[],
  runById: ReadonlyMap<string, AnswerRun>,
): { counted: CountedInvocation[]; mismatchedByRunId: Map<string, number> } {
  const counted: CountedInvocation[] = [];
  const mismatchedByRunId = new Map<string, number>();
  for (const invocation of invocations) {
    const run = runById.get(invocation.runId);
    if (run !== undefined && run.userId !== invocation.userId) {
      mismatchedByRunId.set(
        invocation.runId,
        (mismatchedByRunId.get(invocation.runId) ?? 0) + 1,
      );
      continue;
    }
    counted.push({ invocation, run });
  }
  return { counted, mismatchedByRunId };
}

/**
 * 冪等キー(gateway の auditRecordIdempotencyKey: requestId / runId / accessId /
 * purgeId)で重複を除く。監査 JSONL は at-least-once で、書き込みの成否が確定しない
 * 失敗の再送により同じレコードが複数行に現れうる(gateway の audit/jsonl.ts)。
 * 同じキーは後のレコードを採る(InMemoryAuditStore と同じ)。順序は最初の出現順。
 */
export function dedupeAuditRecords(records: readonly AuditRecord[]): AuditRecord[] {
  const byKey = new Map<string, AuditRecord>();
  for (const record of records) {
    byKey.set(auditRecordIdempotencyKey(record), record);
  }
  return [...byKey.values()];
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

  // at-least-once の重複行を除いてから数える(二重計上しない)
  const records = dedupeAuditRecords(input.records);

  // メタ監査(audit_access / retention_purge)レコードは集計対象のrunデータではない
  const answerRuns = records.filter(
    (r): r is AnswerRun => r.recordType === "answer_run",
  );
  const invocations = records.filter(
    (r): r is ToolInvocation => r.recordType === "tool_invocation",
  );

  // 重複除去後は runId ごとに AnswerRun が1件(同じ runId は後のレコード)
  const runById = new Map(answerRuns.map((r) => [r.runId, r]));
  const decidedRuns = answerRuns.filter(isDecided);
  const unresolvedTotal = decidedRuns.filter(
    (r) => r.finalOutcome === "unresolved",
  ).length;

  // --- AnswerRun と ToolInvocation の結合((runId, userId)、docs/audit-queries.md §0) ---
  const { counted, mismatchedByRunId } = joinInvocationsToRuns(invocations, runById);

  // --- ソース別未解決率(docs/audit-queries.md §1 と同じ結合) ---
  const bySource = new Map<
    string,
    { runIds: Set<string>; unresolvedRunIds: Set<string>; invocations: number }
  >();
  for (const { invocation: ti, run } of counted) {
    let stat = bySource.get(ti.sourceId);
    if (!stat) {
      stat = { runIds: new Set(), unresolvedRunIds: new Set(), invocations: 0 };
      bySource.set(ti.sourceId, stat);
    }
    stat.invocations += 1;
    // describe はソースの説明の取得で、そのソースを探索したことにならない
    // (Orchestrator は run の冒頭で全ソースに describe を呼ぶ)。run の所属には数えない
    if (ti.tool === "describe") continue;
    if (run && isDecided(run)) {
      stat.runIds.add(run.runId);
      if (run.finalOutcome === "unresolved") stat.unresolvedRunIds.add(run.runId);
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
  // 再検索回数 = 結果確定済みrun内の search の ToolInvocation の件数。重複行は
  // dedupeAuditRecords で除去済み(tool_invocation の冪等キーは requestId)で、
  // (runId, userId) で束ねたものだけを数える。0回 = 検索なし、1回 = 1発、
  // 2回以上 = 再検索。iteration は describe / fetch / list も採番する通番のため使わない。
  const searchCountByRunId = new Map<string, number>();
  for (const { invocation: ti, run } of counted) {
    if (ti.tool !== "search" || !run || !isDecided(run)) continue;
    searchCountByRunId.set(run.runId, (searchCountByRunId.get(run.runId) ?? 0) + 1);
  }
  const buckets = new Map<number, SearchCountBucket>();
  for (const run of decidedRuns) {
    const searchCount = searchCountByRunId.get(run.runId) ?? 0;
    let bucket = buckets.get(searchCount);
    if (!bucket) {
      bucket = { searchCount, runs: 0, unresolvedRuns: 0 };
      buckets.set(searchCount, bucket);
    }
    bucket.runs += 1;
    if (run.finalOutcome === "unresolved") bucket.unresolvedRuns += 1;
  }
  const searchCountDistribution = [...buckets.values()].sort(
    (a, b) => a.searchCount - b.searchCount,
  );

  // --- (runId, userId) の不一致の警告(runId と件数のみ) ---
  const userMismatchWarnings: UserMismatchWarning[] = [...mismatchedByRunId]
    .map(([runId, count]) => ({ runId, invocations: count }))
    .sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));

  // --- 失敗クエリの原文表示(docs/audit-queries.md §3、LEFT JOIN相当) ---
  // digestのみでは判定材料にならないため原文を引くが、保持期間切れで
  // 原文が存在しないのは正常系(短期保持の設計どおり)。
  const rawByKey = new Map<string, string>();
  for (const rq of input.rawQueries ?? []) {
    // 同一digestが複数ユーザーに存在しうるため userId も結合キーに含める
    rawByKey.set(`${rq.queryDigest}\u0000${rq.userId}`, rq.rawQuery);
  }
  const failedQueries: FailedQuery[] = answerRuns
    .filter((r) => r.finalOutcome === "unresolved")
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((run) => {
      let rawQuery: string | null = null;
      let status: FailedQuery["status"] = "no_digest";
      if (run.finalQueryDigest) {
        rawQuery =
          rawByKey.get(`${run.finalQueryDigest}\u0000${run.userId}`) ?? null;
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
    duplicateRecordCount: input.records.length - records.length,
    totalRuns: answerRuns.length,
    resolvedRuns: decidedRuns.length - unresolvedTotal,
    unresolvedRuns: unresolvedTotal,
    undecidedRuns: answerRuns.length - decidedRuns.length,
    sourceStats,
    searchCountDistribution,
    failedQueries,
    userMismatchWarnings,
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
