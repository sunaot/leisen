/**
 * 監査レコードのzodスキーマ(T-001、ADR-011の2層モデル)。
 *
 * 設計意図:
 * - AnswerRun(会話/回答単位)と ToolInvocation(ツール呼び出し単位)の2層。
 *   runId で束ね、「ソース別未解決率」「再検索回数分布」(T-014)を集計可能にする。
 *   サンプルクエリは docs/audit-queries.md。
 * - run API(ADR-019)では AnswerRun を開始時の pending と、終了(answer_run_finish)・
 *   利用者フィードバック(answer_run_feedback)の部分レコードに分けて追記し、読み手が
 *   runId ごとにフィールド単位で統合する(Gateway は前の状態を読まない)。
 * - 秘密情報(トークン、認証ヘッダ、文書本文)のフィールドは存在させない。
 * - **post-filtering前の候補件数フィールドは存在させない(ADR-011/012)。**
 *   returnedHitCount は認可済み返却件数のみ。候補件数を追加してはならない
 *   (existence leak: 返却0件との差分から未認可文書の存在が漏れる)。
 * - 全スキーマ strict: 型に存在しないキーは実行時にも拒否する。加えて既知の
 *   危険キー(FORBIDDEN_KEYS)はネストも含めて明示エラーにする。
 * - 生クエリは queryDigest(SHA-256)のみ。原文は短期保持の別テーブル
 *   (rawquery.ts)に置き、digestで結合する。
 * - メタ監査(audit_access)と保持期限削除の実行記録(retention_purge)も
 *   監査レコードとして扱う(ADR-013 §3、TM-F3)。
 */
import { createHash } from "node:crypto";
import { z } from "zod";

const sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be a sha256 hex digest or null");

const isoTimestamp = z.iso.datetime({ offset: true });

const identityString = (field: string) =>
  z.string().min(1, `missing required identity field: ${field}`);

/**
 * 正規化済みの理由/分類コード(例: source_unreachable, permission_denied)。
 * 生の例外メッセージ・スタックトレースを入れない(TM-A2: 候補情報・トークン・
 * 原文の混入経路になる)。例外は定義済みエラー型に変換してから記録する。
 */
const reasonCode = z
  .string()
  .regex(
    /^[a-z][a-z0-9_.]{0,63}$/,
    "must be a normalized reason code (lower snake_case), not raw error text",
  );

/** 正規化済みの理由コード(run API の申告の検証にも使う。ADR-019)。 */
export const reasonCodeSchema = reasonCode;

/** 呼び出し主体(ADR-015)。agent の場合は on-behalf-of チェーンを記録する。 */
export const actorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("human") }),
  z.strictObject({
    kind: z.literal("agent"),
    agentId: identityString("agentId"),
    /** 委譲の連鎖(最終的な人間の userId まで)。 */
    onBehalfOfChain: z
      .array(z.string().min(1))
      .min(1, "agent actor requires a non-empty onBehalfOfChain (ADR-015)"),
  }),
]);

export const outcomeSchema = z.enum([
  "resolved",
  "unresolved",
  "error",
  "pending",
]);

/**
 * 会話/回答単位のレコード。利用者フィードバックはここを更新する。
 * citedDocIds は docid.ts の redaction を通した値のみを入れること
 * (プライベートスコープは hashed/omitted、Slack由来は常に不記録 — ADR-013 §2)。
 */
export const answerRunRecordSchema = z.strictObject({
  recordType: z.literal("answer_run"),
  runId: identityString("runId"),
  /** IdP上のユーザーID(権限の主体) */
  userId: identityString("userId"),
  actor: actorSchema,
  /** ISO 8601 */
  startedAt: isoTimestamp,
  endedAt: isoTimestamp.nullable(),
  /** 最終質問のSHA-256 */
  finalQueryDigest: sha256Hex.nullable(),
  finalOutcome: outcomeSchema,
  /** 0..1(Orchestrator申告) */
  confidence: z.number().min(0).max(1).nullable(),
  /** 利用者フィードバック(解決/未解決ボタン) */
  userFeedback: z.enum(["resolved", "unresolved"]).nullable(),
  searchedSources: z.array(z.string().min(1)),
  citedDocIds: z.array(z.string().min(1)),
  /** 正規化済みコードのみ。生のエラーメッセージ不可(TM-A2) */
  failureReason: reasonCode.nullable(),
});

/** ツール呼び出し単位のレコード。 */
export const toolInvocationRecordSchema = z.strictObject({
  recordType: z.literal("tool_invocation"),
  requestId: identityString("requestId"),
  /** 親の AnswerRun */
  runId: identityString("runId"),
  /** 探索ループ内の反復連番(0始まり) */
  iteration: z.number().int().min(0, "iteration must be a non-negative integer"),
  userId: identityString("userId"),
  /** ISO 8601 */
  timestamp: isoTimestamp,
  sourceId: identityString("sourceId"),
  tool: z.enum(["search", "fetch", "list", "describe"]),
  /** 生クエリのSHA-256。集計・rawQueryテーブルとの結合キー */
  queryDigest: sha256Hex.nullable(),
  filtersDigest: sha256Hex.nullable(),
  /**
   * 認可済み返却件数のみ。post-filtering前の候補件数を
   * ここに(あるいは別フィールドとして)記録してはならない(ADR-011/012)。
   */
  returnedHitCount: z.number().int().min(0).nullable(),
  fetchedDocCount: z.number().int().min(0),
  latencyMs: z.number().min(0),
  /** 正規化済みコードのみ。生のエラーメッセージ不可(TM-A2) */
  errorClass: reasonCode.nullable(),
  retryCount: z.number().int().min(0),
});

/**
 * メタ監査: 監査ログ自体へのアクセスの記録(ADR-013 §3、TM-F3)。
 * 閲覧「結果」の内容は記録しない — 誰が・いつ・何の目的で・どの区画に
 * アクセスしたかのみ。
 */
export const auditAccessRecordSchema = z.strictObject({
  recordType: z.literal("audit_access"),
  accessId: identityString("accessId"),
  /** 監査閲覧担当(指名制ロール)のユーザーID */
  accessorUserId: identityString("accessorUserId"),
  /** ISO 8601 */
  timestamp: isoTimestamp,
  /** 閲覧目的(ADR-013 §3 の限定列挙。目的外利用は規程で禁止) */
  purpose: z.enum([
    "incident_investigation",
    "violation_detection",
    "promotion_report",
    "formal_inquiry",
  ]),
  /** アクセス先の区画 */
  target: z.enum(["audit_log", "raw_query", "telemetry"]),
  /** 抽出条件の要約(期間・対象ユーザー等)。閲覧結果の内容を書かない */
  scopeDescription: z.string().max(500).nullable(),
});

/**
 * 保持期限超過分の削除実行の記録(ADR-013 §3)。deletedCount は削除した
 * 監査レコード自体の件数であり、検索候補の件数ではない。
 */
export const retentionPurgeRecordSchema = z.strictObject({
  recordType: z.literal("retention_purge"),
  purgeId: identityString("purgeId"),
  /** ISO 8601(削除実行時刻) */
  timestamp: isoTimestamp,
  /** 削除対象の区画 */
  target: z.enum(["audit_log", "raw_query", "telemetry"]),
  /** 適用した保持日数(deployment.yamlから注入された値) */
  retentionDays: z.number().int().min(1),
  /** この時刻より古いレコードを削除した(ISO 8601) */
  cutoff: isoTimestamp,
  /** 削除した監査レコード件数 */
  deletedCount: z.number().int().min(0),
});

/** 終了時に申告できる結果(pending は開始時の AnswerRun だけが持つ)。 */
export const finishOutcomeSchema = z.enum(["resolved", "unresolved", "error"]);

/** 利用者フィードバック(解決/未解決ボタン)。 */
export const userFeedbackSchema = z.enum(["resolved", "unresolved"]);

/**
 * run の終了の部分レコード(ADR-019 決定3)。Gateway が run API の finish を受けて
 * 追記する。前の状態(pending の AnswerRun)を読まずに書けるよう、結果の欄だけを
 * 持つ。昇格判定レポートが runId ごとに pending と統合し、同じ runId に複数あれば
 * recordedAt の最新(同時刻は recordId)を採る。userId は Gateway の認証値で、
 * pending と一致するものだけを統合する。
 * citedDocIds は docid.ts の redaction を通した値のみ(AnswerRun と同じ)。
 */
export const answerRunFinishRecordSchema = z.strictObject({
  recordType: z.literal("answer_run_finish"),
  /** 冪等キー(Gateway が採番) */
  recordId: identityString("recordId"),
  runId: identityString("runId"),
  /** Gateway が認証した利用者(Orchestrator は指定できない) */
  userId: identityString("userId"),
  /** Gateway が記録した時刻(ISO 8601)。統合の「最新」を決める */
  recordedAt: isoTimestamp,
  /** ISO 8601 */
  endedAt: isoTimestamp,
  finalOutcome: finishOutcomeSchema,
  /** 0..1(Orchestrator申告。error のときは null) */
  confidence: z.number().min(0).max(1).nullable(),
  searchedSources: z.array(z.string().min(1)),
  citedDocIds: z.array(z.string().min(1)),
  /** 正規化済みコードのみ。生のエラーメッセージ不可(TM-A2) */
  failureReason: reasonCode.nullable(),
});

/**
 * 利用者フィードバックの部分レコード(ADR-019 決定8)。Gateway が run API の
 * feedback を受けて追記する。finish の再送で消えない(AnswerRun 全体を書き直さない)。
 */
export const answerRunFeedbackRecordSchema = z.strictObject({
  recordType: z.literal("answer_run_feedback"),
  /** 冪等キー(Gateway が採番) */
  recordId: identityString("recordId"),
  runId: identityString("runId"),
  /** Gateway が認証した利用者 */
  userId: identityString("userId"),
  /** Gateway が記録した時刻(ISO 8601) */
  recordedAt: isoTimestamp,
  userFeedback: userFeedbackSchema,
});

export const auditRecordSchema = z.discriminatedUnion("recordType", [
  answerRunRecordSchema,
  toolInvocationRecordSchema,
  answerRunFinishRecordSchema,
  answerRunFeedbackRecordSchema,
  auditAccessRecordSchema,
  retentionPurgeRecordSchema,
]);

export type Actor = z.infer<typeof actorSchema>;
export type Outcome = z.infer<typeof outcomeSchema>;
export type FinishOutcome = z.infer<typeof finishOutcomeSchema>;
export type UserFeedback = z.infer<typeof userFeedbackSchema>;
export type AnswerRunRecord = Omit<
  z.infer<typeof answerRunRecordSchema>,
  "recordType"
>;
export type ToolInvocationRecord = Omit<
  z.infer<typeof toolInvocationRecordSchema>,
  "recordType"
>;
export type AnswerRunFinishRecord = Omit<
  z.infer<typeof answerRunFinishRecordSchema>,
  "recordType"
>;
export type AnswerRunFeedbackRecord = Omit<
  z.infer<typeof answerRunFeedbackRecordSchema>,
  "recordType"
>;
export type AuditAccessRecord = Omit<
  z.infer<typeof auditAccessRecordSchema>,
  "recordType"
>;
export type RetentionPurgeRecord = Omit<
  z.infer<typeof retentionPurgeRecordSchema>,
  "recordType"
>;
export type AuditRecord = z.infer<typeof auditRecordSchema>;

/**
 * 禁止フィールド。zod strict による未知キー拒否が本命の防御だが、既知の
 * 危険キーはネストした位置に現れても明示的なエラーで拒否する
 * (スキーマ改訂時にうっかり通す事故への防波堤)。
 */
export const FORBIDDEN_KEYS: readonly string[] = [
  "accessToken",
  "authorization",
  "content",
  "token",
  "credential",
  "snippet",
  "rawQuery", // 原文はrawQueryテーブル(別保持)のみ。監査レコードにはdigestだけ
  "hitCount", // 旧v0.1の曖昧フィールド。returnedHitCountのみ許可(ADR-011)
  "candidateCount",
  "preFilterCount",
];

export function digestQuery(rawQuery: string): string {
  return createHash("sha256").update(rawQuery, "utf8").digest("hex");
}

function assertNoForbiddenKeysDeep(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoForbiddenKeysDeep(item, `${path}[${i}]`));
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      throw new Error(
        `audit record must not contain forbidden field: ${path ? `${path}.` : ""}${key}`,
      );
    }
    assertNoForbiddenKeysDeep(nested, path ? `${path}.${key}` : key);
  }
}

/**
 * レコードを検証する。禁止フィールドの混入(ネスト含む)と型に存在しない
 * キーは実行時にも拒否する。
 */
export function validateRecord(record: AuditRecord): void {
  assertNoForbiddenKeysDeep(record, "");
  const result = auditRecordSchema.safeParse(record);
  if (!result.success) {
    const issue = result.error.issues[0];
    const at = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    throw new Error(`invalid audit record${at}: ${issue?.message ?? "unknown"}`);
  }
}

/** 未知の入力を検証済みAuditRecordとしてパースする(取り込み経路用)。 */
export function parseAuditRecord(input: unknown): AuditRecord {
  assertNoForbiddenKeysDeep(input, "");
  return auditRecordSchema.parse(input);
}
