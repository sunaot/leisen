/**
 * 昇格判定レポートの集計(T-014、ADR-006「有効化は証拠駆動」)。
 *
 * 2層監査ログ(ADR-011)から、ソース別未解決率(AnswerRun単位)・
 * 再検索回数分布(run 内の search 呼び出し件数)・失敗クエリを集計する。
 * SQL版のサンプルは docs/audit-queries.md。将来の管理画面化を見据え、
 * この集計は表示(render.ts / cli.ts)から分離した純粋関数にする。
 *
 * 入力の重複と更新: 監査 JSONL は at-least-once で同じレコードが複数行に現れうるため、
 * 冪等キー(requestId / runId / recordId / accessId / purgeId)で1件にまとめてから集計する
 * (dedupeAuditRecords)。同じキーで内容も同じ行は「重複」(再送)、内容が変わった行は
 * 「更新」(ADR-019 より前の構成で Orchestrator が書き直した AnswerRun の pending → 最終状態 →
 * フィードバック。issue #38)として別に数え、後のレコードを採る。ただし AnswerRun の pending は
 * 確定済み(pending 以外)の状態を置き換えない(--audit のファイルの順序が前後しても、集計は
 * 最終状態を使う)。
 *
 * run の統合(ADR-019 決定3・8、T-023): Gateway は run を書き直さず追記する — 開始時に pending の
 * `answer_run`、終了時に `answer_run_finish`、フィードバック時に `answer_run_feedback`(部分レコード。
 * 冪等キーは recordId)。runId ごとに pending を土台に、recordedAt の最新(同時刻は recordId)の
 * finish と feedback をフィールド単位で重ねる(mergeAnswerRunRecords)。userId が pending と
 * 一致する部分レコードだけを統合し、pending のない部分レコードは「孤立」、userId の違うものは
 * 「不一致」として件数だけを警告に出す。より新しい部分レコードに置き換えられた古いもの(finish の
 * 再送など)は「更新」に数える。finish を再送しても feedback は別レコードなので消えない。
 * 有効期間(署名付き runId の payload。署名のない旧形式は runTtlSeconds)を過ぎても finish のない
 * pending の run は「放棄」と数える(finish を送らずに unresolved を隠せないようにする)。
 *
 * AnswerRun と ToolInvocation の結合は (runId, userId)(docs/audit-queries.md §0)。
 * runId を申告する tools/call は Gateway が署名・本人・actor・期限を検証する(ADR-019)が、
 * 旧形式の runId の申告は検証されないため、runId だけで結合すると、別の利用者が同じ runId を
 * 申告した呼び出しを他人の run に混ぜうる。同じ runId の AnswerRun があるのに userId が一致しない
 * ToolInvocation は、どの run の呼び出しか確定できないので集計(ソース別・再検索回数)から除外し、
 * run ごとの件数だけを警告(userMismatchWarnings)に出す。警告に userId・文書ID・クエリは
 * 出さない。AnswerRun のない runId の ToolInvocation(runId 未申告の単発呼び出し、拒否された申告の
 * `invalid_run_id` の単発 run 等)は不一致ではなく、ソース別の呼び出し数にだけ数える。
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
  type AnswerRunFeedbackRecord,
  type AnswerRunFinishRecord,
  type AnswerRunRecord,
  type AuditAccessRecord,
  type AuditRecord,
  type RawQueryRecord,
  type ToolInvocationRecord,
} from "@leisen/audit";
import { DEFAULT_RUN_ID_TTL_SEC, decodeRunIdPayload } from "@leisen/gateway";
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

/**
 * 失敗クエリの原文の有無。
 * - available: 生クエリ表に原文がある
 * - expired: 原文がなく、run の開始が生クエリ表の保持期間(rawQueryRetentionDays)より前。
 *   保持期間切れ(短期保持の設計どおり。issue #18)
 * - not_recorded: 原文がなく、run の開始が保持期間内。書かれなかった(永続化不可のソースが
 *   有効な構成では質問原文を生クエリ表に書かない。ADR-019 決定7)か、書き込みに失敗した
 * - not_loaded: 生クエリ表を渡していない(rawQueries 未指定)
 * - no_digest: AnswerRun に最終質問の digest がない
 */
export type FailedQueryStatus = "available" | "expired" | "not_recorded" | "not_loaded" | "no_digest";

export interface FailedQuery {
  runId: string;
  startedAt: string;
  finalQueryDigest: string | null;
  /**
   * 生クエリ原文。rawQueryテーブル(短期保持、既定30日 — ADR-013 §3)に
   * 残っている場合のみ(status: "available")。それ以外は null で、理由は status。
   */
  rawQuery: string | null;
  status: FailedQueryStatus;
  failureReason: string | null;
  searchedSources: readonly string[];
}

export interface PromotionReport {
  /** ISO 8601(レポート生成時刻) */
  generatedAt: string;
  /** 入力レコード数(重複行を含む、読んだまま) */
  inputRecordCount: number;
  /**
   * 重複として集計から除いたレコード数(同じ冪等キーで内容も同じ行。at-least-once の再送による
   * JSONL の重複行)
   */
  duplicateRecordCount: number;
  /**
   * 更新として後のレコードに置き換えたレコード数: 同じ冪等キーで内容が変わった行(ADR-019 より前の
   * 構成の AnswerRun の pending → 最終状態 → フィードバック)と、同じ runId のより新しい部分レコード
   * (finish / feedback)に置き換えられた古い部分レコード(再送)。重複ではない。
   * inputRecordCount = 集計した件数 + duplicateRecordCount + updatedRecordCount
   */
  updatedRecordCount: number;
  /**
   * 統合できなかった部分レコード(answer_run_finish / answer_run_feedback)の件数。孤立 = 同じ runId の
   * pending の AnswerRun がない(pending の書き込み失敗・別ファイル・保持期間切れ)、不一致 = pending は
   * あるが userId が違う(Gateway は認証値で書くので、起きれば実装の不具合か署名鍵の問題)。
   * どちらも集計に入れない
   */
  orphanPartialRecordCount: number;
  userMismatchPartialRecordCount: number;
  totalRuns: number;
  resolvedRuns: number;
  unresolvedRuns: number;
  /** finalOutcome が pending / error のrun。率の分母に入れない(abandonedRuns を含む) */
  undecidedRuns: number;
  /**
   * 放棄: runId の有効期間(署名付き runId の payload。旧形式は runTtlSeconds)を過ぎても finish のない
   * pending の run(undecidedRuns の内数)。Orchestrator が finish を送れずに終わった(停止・障害)か、
   * 送らずに unresolved を隠した(ADR-019 帰結)
   */
  abandonedRuns: number;
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
  /**
   * 署名のない旧形式の runId(ADR-019 より前の構成)の pending の run を「放棄」と判定する有効期間
   * (秒)。署名付き runId は payload の有効期間を使う。既定は Gateway の既定(gateway.runs.ttlSec)
   */
  runTtlSeconds?: number;
  /**
   * 生クエリ表の保持期間(日。deployment.yaml の audit.rawQueryRetentionDays)。原文のない失敗クエリを
   * 「保持期間切れ」と「未記録」に分けるのに使う。既定 30
   */
  rawQueryRetentionDays?: number;
}

/** 生クエリ表の保持期間の既定(日。ADR-013 §3、設定スキーマの既定と同じ)。 */
export const DEFAULT_RAW_QUERY_RETENTION_DAYS = 30;

type AnswerRun = AnswerRunRecord & { recordType: "answer_run" };
type AnswerRunFinish = AnswerRunFinishRecord & { recordType: "answer_run_finish" };
type AnswerRunFeedback = AnswerRunFeedbackRecord & { recordType: "answer_run_feedback" };
type ToolInvocation = ToolInvocationRecord & { recordType: "tool_invocation" };

/** mergeAnswerRunRecords の結果。 */
export interface MergedAnswerRuns {
  /** runId ごとに統合した AnswerRun(pending の AnswerRun の出現順) */
  runs: AnswerRun[];
  /** 同じ runId の pending の AnswerRun がない部分レコードの数 */
  orphans: number;
  /** pending はあるが userId が違う部分レコードの数 */
  userMismatches: number;
  /** 同じ runId のより新しい部分レコードに置き換えられた古い部分レコードの数(再送・更新) */
  superseded: number;
}

/** a が b より新しいか(recordedAt。同時刻は recordId の文字列順)。 */
function isNewerPartial(
  a: AnswerRunFinish | AnswerRunFeedback,
  b: AnswerRunFinish | AnswerRunFeedback,
): boolean {
  const at = Date.parse(a.recordedAt);
  const bt = Date.parse(b.recordedAt);
  if (at !== bt) return at > bt;
  return a.recordId > b.recordId;
}

/**
 * run の記録を runId ごとに統合する(ADR-019 決定3・8)。重複除去済みのレコードを渡すこと。
 * pending の AnswerRun(または ADR-019 より前の構成の完全な AnswerRun)を土台に、userId が一致する
 * 部分レコードのうち recordedAt の最新(同時刻は recordId)の finish(結果の欄)と feedback
 * (userFeedback)を重ねる。finish を再送しても feedback は別レコードなので消えない。
 */
export function mergeAnswerRunRecords(records: readonly AuditRecord[]): MergedAnswerRuns {
  const baseById = new Map<string, AnswerRun>();
  for (const record of records) {
    if (record.recordType === "answer_run") {
      baseById.set(record.runId, record);
    }
  }
  const latestFinish = new Map<string, AnswerRunFinish>();
  const latestFeedback = new Map<string, AnswerRunFeedback>();
  let orphans = 0;
  let userMismatches = 0;
  let superseded = 0;
  for (const record of records) {
    if (record.recordType !== "answer_run_finish" && record.recordType !== "answer_run_feedback") {
      continue;
    }
    const base = baseById.get(record.runId);
    if (base === undefined) {
      orphans += 1;
      continue;
    }
    if (base.userId !== record.userId) {
      userMismatches += 1;
      continue;
    }
    if (record.recordType === "answer_run_finish") {
      const current = latestFinish.get(record.runId);
      if (current === undefined || isNewerPartial(record, current)) {
        latestFinish.set(record.runId, record);
      }
      if (current !== undefined) superseded += 1;
    } else {
      const current = latestFeedback.get(record.runId);
      if (current === undefined || isNewerPartial(record, current)) {
        latestFeedback.set(record.runId, record);
      }
      if (current !== undefined) superseded += 1;
    }
  }
  const runs: AnswerRun[] = [];
  for (const base of baseById.values()) {
    const finish = latestFinish.get(base.runId);
    const feedback = latestFeedback.get(base.runId);
    runs.push({
      ...base,
      ...(finish !== undefined
        ? {
            endedAt: finish.endedAt,
            finalOutcome: finish.finalOutcome,
            confidence: finish.confidence,
            searchedSources: finish.searchedSources,
            citedDocIds: finish.citedDocIds,
            failureReason: finish.failureReason,
          }
        : {}),
      ...(feedback !== undefined ? { userFeedback: feedback.userFeedback } : {}),
    });
  }
  return { runs, orphans, userMismatches, superseded };
}

/**
 * run の有効期限(ms)。署名付き runId は payload の発行時刻 + 有効期間(Gateway が tools/call と
 * finish を受ける期限と同じ)、旧形式は開始時刻 + fallbackTtlSeconds。
 */
export function runExpiryMs(run: Pick<AnswerRun, "runId" | "startedAt">, fallbackTtlSeconds: number): number {
  const payload = decodeRunIdPayload(run.runId);
  if (payload !== undefined) {
    return (payload.issuedAt + payload.ttlSeconds) * 1000;
  }
  return Date.parse(run.startedAt) + fallbackTtlSeconds * 1000;
}

/** 放棄: 有効期限を過ぎても finish のない pending の run。 */
function isAbandoned(run: AnswerRun, nowMs: number, fallbackTtlSeconds: number): boolean {
  return run.finalOutcome === "pending" && runExpiryMs(run, fallbackTtlSeconds) <= nowMs;
}

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

/** キーの順序に依らない JSON(重複=同じ内容の判定用)。 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : nested,
  );
}

/**
 * 同じキーの後のレコードで置き換えるか。後のレコードを採る(InMemoryAuditStore と同じ)が、
 * AnswerRun の pending は確定済み(pending 以外)の状態を置き換えない(ファイルの順序が前後しても
 * 最終状態で集計する)。
 */
function supersedes(next: AuditRecord, current: AuditRecord): boolean {
  return !(
    next.recordType === "answer_run" &&
    current.recordType === "answer_run" &&
    next.finalOutcome === "pending" &&
    current.finalOutcome !== "pending"
  );
}

/** dedupeAuditRecordsDetailed の結果。 */
export interface DedupedAuditRecords {
  /** 冪等キーごとに1件(順序は最初の出現順) */
  records: AuditRecord[];
  /** 同じキーで内容も同じ行(at-least-once の再送)の数 */
  duplicates: number;
  /** 同じキーで内容が変わった行(AnswerRun の pending → 最終状態 → フィードバック)の数 */
  updates: number;
}

/**
 * 冪等キー(@leisen/audit の auditRecordIdempotencyKey: requestId / runId / recordId / accessId /
 * purgeId)で1件にまとめ、重複(同じ内容の再送)と更新(内容が変わった後の行)を分けて数える。
 * 監査 JSONL は at-least-once で、書き込みの成否が確定しない失敗の再送により同じレコードが
 * 複数行に現れうる(@leisen/audit の jsonl.ts)。ADR-019 より前の構成の AnswerRun は同じ runId で
 * pending → 最終状態 → フィードバックの行が並ぶ(書き直し)。Gateway の run API の部分レコードは
 * recordId ごとに別のキーなので、ここでは束ねず mergeAnswerRunRecords で統合する。
 */
export function dedupeAuditRecordsDetailed(records: readonly AuditRecord[]): DedupedAuditRecords {
  const byKey = new Map<string, AuditRecord>();
  // 見た内容は2回以上現れたキーについてだけ覚える(大半のキーは1回しか現れない)
  const contentsByKey = new Map<string, Set<string>>();
  let duplicates = 0;
  let updates = 0;
  for (const record of records) {
    const key = auditRecordIdempotencyKey(record);
    const current = byKey.get(key);
    if (current === undefined) {
      byKey.set(key, record);
      continue;
    }
    let contents = contentsByKey.get(key);
    if (contents === undefined) {
      // 最初の重なり: それまでに見たのは current(最初の行)だけ
      contents = new Set([canonicalJson(current)]);
      contentsByKey.set(key, contents);
    }
    const content = canonicalJson(record);
    if (contents.has(content)) {
      duplicates += 1;
    } else {
      contents.add(content);
      updates += 1;
    }
    if (supersedes(record, current)) {
      byKey.set(key, record);
    }
  }
  return { records: [...byKey.values()], duplicates, updates };
}

/** 冪等キーで1件にまとめたレコード(dedupeAuditRecordsDetailed の records)。 */
export function dedupeAuditRecords(records: readonly AuditRecord[]): AuditRecord[] {
  return dedupeAuditRecordsDetailed(records).records;
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
  const nowMs = now.getTime();
  const runTtlSeconds = input.runTtlSeconds ?? DEFAULT_RUN_ID_TTL_SEC;
  const rawQueryRetentionDays = input.rawQueryRetentionDays ?? DEFAULT_RAW_QUERY_RETENTION_DAYS;
  if (!input.accessorUserId) {
    throw new Error("accessorUserId is required (meta audit, ADR-013 §3)");
  }
  if (!Number.isInteger(runTtlSeconds) || runTtlSeconds < 1) {
    throw new Error("runTtlSeconds must be a positive integer");
  }
  if (!Number.isInteger(rawQueryRetentionDays) || rawQueryRetentionDays < 1) {
    throw new Error("rawQueryRetentionDays must be a positive integer");
  }

  // at-least-once の重複行を除き、更新(pending → 最終状態など)は後の状態にまとめてから数える
  // (二重計上しない)
  const { records, duplicates, updates } = dedupeAuditRecordsDetailed(input.records);

  // run の記録を runId ごとに統合する(pending + 最新の finish + 最新の feedback。ADR-019)。
  // メタ監査(audit_access / retention_purge)レコードは集計対象のrunデータではない
  const merged = mergeAnswerRunRecords(records);
  const answerRuns = merged.runs;
  const invocations = records.filter(
    (r): r is ToolInvocation => r.recordType === "tool_invocation",
  );

  // 統合後は runId ごとに AnswerRun が1件
  const runById = new Map(answerRuns.map((r) => [r.runId, r]));
  const decidedRuns = answerRuns.filter(isDecided);
  const abandonedRuns = answerRuns.filter((r) => isAbandoned(r, nowMs, runTtlSeconds)).length;
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
  const retentionMs = rawQueryRetentionDays * 24 * 3600 * 1000;
  const failedQueries: FailedQuery[] = answerRuns
    .filter((r) => r.finalOutcome === "unresolved")
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.runId.localeCompare(a.runId))
    .map((run) => {
      let rawQuery: string | null = null;
      let status: FailedQueryStatus = "no_digest";
      if (run.finalQueryDigest) {
        if (input.rawQueries === undefined) {
          status = "not_loaded";
        } else {
          rawQuery = rawByKey.get(`${run.finalQueryDigest}\u0000${run.userId}`) ?? null;
          if (rawQuery !== null) {
            status = "available";
          } else {
            // 原文がない理由を run の開始時刻で分ける: 保持期間より前なら期限切れ(正常系)、
            // 期間内なら書かれなかった(Slack 有効時の非記録・書き込み失敗。issue #18)
            status = Date.parse(run.startedAt) + retentionMs <= nowMs ? "expired" : "not_recorded";
          }
        }
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
    duplicateRecordCount: duplicates,
    updatedRecordCount: updates + merged.superseded,
    orphanPartialRecordCount: merged.orphans,
    userMismatchPartialRecordCount: merged.userMismatches,
    totalRuns: answerRuns.length,
    resolvedRuns: decidedRuns.length - unresolvedTotal,
    unresolvedRuns: unresolvedTotal,
    undecidedRuns: answerRuns.length - decidedRuns.length,
    abandonedRuns,
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
