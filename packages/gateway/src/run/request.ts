/**
 * run API のリクエスト本文の検証(ADR-019 決定3、T-023)。
 *
 * 本文の大きさ・質問の長さ・引用とソースの件数に上限をかける(期限内の runId で finish /
 * feedback を再送して監査ストアを埋めることを防ぐ。TM-I5 (d))。上限は deployment.yaml で
 * 変えられるよう、スキーマは上限を受け取って作る。利用者ごとの頻度の上限と本文の
 * バイト数の上限は HTTP 層(組み立て役)がかける。
 *
 * 検証に失敗したときのメッセージはパスと期待の形だけで、申告値をエコーしない。
 * executionClass / actor の申告は形だけを通し、意味の検証(ADR-015 の規則)は呼び出し側が
 * proxy/session.ts の validateDeclaration で行う(このモジュールは proxy/ に依存しない)。
 */
import { z } from "zod";
import { finishOutcomeSchema, reasonCodeSchema, userFeedbackSchema } from "@leisen/audit";

export interface RunRequestLimits {
  /** 質問の最大文字数 */
  readonly maxQuestionChars: number;
  /** 引用の最大件数 */
  readonly maxCitations: number;
  /** searchedSources の最大件数 */
  readonly maxSearchedSources: number;
  /** sourceId・documentId・failureReason 等の識別子の最大文字数 */
  readonly maxIdChars: number;
}

/** 既定の上限(T-023 で決めた案。deployment.yaml で変えられる)。 */
export const DEFAULT_RUN_REQUEST_LIMITS: RunRequestLimits = {
  maxQuestionChars: 4_000,
  maxCitations: 50,
  maxSearchedSources: 50,
  maxIdChars: 512,
};

/** `POST /runs` の本文。 */
export function startRunRequestSchema(limits: RunRequestLimits = DEFAULT_RUN_REQUEST_LIMITS) {
  return z.strictObject({
    question: z.string().min(1).max(limits.maxQuestionChars),
    /** 実行区分の申告(ADR-015)。意味の検証は呼び出し側 */
    executionClass: z.string().min(1).max(64).optional(),
    /** 呼び出し主体の申告(ADR-015)。形の検証は呼び出し側(actorSchema) */
    actor: z.unknown().optional(),
  });
}
export type StartRunRequest = z.infer<ReturnType<typeof startRunRequestSchema>>;

/** `POST /runs/{runId}/finish` の本文。 */
export function finishRunRequestSchema(limits: RunRequestLimits = DEFAULT_RUN_REQUEST_LIMITS) {
  const id = z.string().min(1).max(limits.maxIdChars);
  return z.strictObject({
    outcome: finishOutcomeSchema,
    confidence: z.number().min(0).max(1).nullable().default(null),
    searchedSources: z.array(id).max(limits.maxSearchedSources).default([]),
    citations: z
      .array(z.strictObject({ sourceId: id, documentId: id }))
      .max(limits.maxCitations)
      .default([]),
    failureReason: reasonCodeSchema.nullable().default(null),
    /** runId に束縛した actor(ADR-015)。省略時は human。形の検証は呼び出し側(actorSchema) */
    actor: z.unknown().optional(),
  });
}
export type FinishRunRequest = z.infer<ReturnType<typeof finishRunRequestSchema>>;

/** `POST /runs/{runId}/feedback` の本文。 */
export function feedbackRunRequestSchema() {
  return z.strictObject({
    outcome: userFeedbackSchema,
    /** runId に束縛した actor(ADR-015)。省略時は human。形の検証は呼び出し側(actorSchema) */
    actor: z.unknown().optional(),
  });
}
export type FeedbackRunRequest = z.infer<ReturnType<typeof feedbackRunRequestSchema>>;

export type RunRequestParse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

/**
 * 本文を検証する。失敗はパスと期待の形だけの固定的なメッセージ(申告値を含めない)。
 */
export function parseRunRequest<S extends z.ZodType>(
  schema: S,
  body: unknown,
): RunRequestParse<z.output<S>> {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  const issue = parsed.error.issues[0];
  const at = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
  // zod の unrecognized_keys の文言は申告されたキー名を含むため固定文言に写す(申告値をエコーしない)
  const detail = issue === undefined ? "unknown" : issue.code === "unrecognized_keys" ? "unknown field" : issue.message;
  return { ok: false, message: `invalid run request${at}: ${detail}` };
}
