/**
 * `ask` の追加の引数(ADR-026 決定1・2、T-031)— 型・上限・探索 LLM への渡し方。
 *
 * - 追加の引数はすべて省略可能。`question` は必須のまま(決定1)
 * - 探索 LLM への入力: 最初の user ターンの質問の後ろに、区分を分けて置く(決定2)。
 *   「利用者の発言(そのまま)」「UI 側 LLM による補足(利用者の発言ではない)」「利用者が
 *   入力したキーワード」「対象のソース・期間」。どれも利用者ターンの入力で、
 *   `[オーケストレーター]` の制御メッセージとしては書かない(利用者の入力に制御メッセージの
 *   権威を持たせない)。追加の引数がなければ何も足さない(従来の入力と同じ)
 * - クエリは探索 LLM が書く。ここでは検索を組み立てず、実行もしない(2026-11-25 方針)
 * - `sources` は run の有効ソースを絞る(orchestrator.ts)。利用者の指定による検索範囲の
 *   絞り込みであり、認可判定ではない(不変条件1)
 * - `period` は探索 LLM に filters.updatedAfter / updatedBefore に入れるよう伝えるだけ
 *   (Orchestrator は search の引数を書き換えない。ADR-026 確認事項5 の既定)
 * - `depth` は maxIterations を設定値以下の範囲で選ぶ(quick = 2、standard / thorough =
 *   設定値。上限は変えない。確認事項4 の既定)
 * - run API への申告(ADR-026 決定4)は文字列を含む引数(question / userMessage / context /
 *   keepTerms)だけ。正規化した JSON は Gateway が作る(生クエリ表の書き手は Gateway)
 *
 * 引数の値はログ・エラー文に出さない(ADR-026 決定6。question と同じ規律)。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { StartRunQuestion } from "./gateway/types.js";
import { escapePromptBrackets, neutralizeControlLines } from "./prompt.js";

/** `context` の上限(文字数。ADR-026 決定1)。 */
export const MAX_CONTEXT_CHARS = 1_000;
/** `keepTerms` の件数の上限(ADR-026 決定1)。 */
export const MAX_KEEP_TERMS = 10;
/** `keepTerms` の各要素の上限(文字数。ADR-026 決定1)。 */
export const MAX_KEEP_TERM_CHARS = 100;
/** `sources` の件数の上限(有効なソースの一覧が分からないときの防御的な上限)。 */
export const MAX_REQUESTED_SOURCES = 50;
/** `sources` の各要素の上限(文字数)。 */
export const MAX_SOURCE_ID_CHARS = 200;
/** depth: quick のときの maxIterations(設定値がこれより小さければ設定値)。 */
export const QUICK_MAX_ITERATIONS = 2;

export const ASK_DEPTHS = ["quick", "standard", "thorough"] as const;
export type AskDepth = (typeof ASK_DEPTHS)[number];

/** ISO 8601 の日付(YYYY-MM-DD)または日時(オフセット付き可)。 */
export const isoDateOrDateTimeSchema = z.union([
  z.iso.date(),
  z.iso.datetime({ offset: true }),
]);

/** 期間の指定(ISO 8601)。両方あるときは updatedAfter ≦ updatedBefore。 */
export const askPeriodSchema = z
  .strictObject({
    updatedAfter: isoDateOrDateTimeSchema.optional(),
    updatedBefore: isoDateOrDateTimeSchema.optional(),
  })
  .refine(
    (period) =>
      period.updatedAfter === undefined ||
      period.updatedBefore === undefined ||
      Date.parse(period.updatedAfter) <= Date.parse(period.updatedBefore),
  );
export type AskPeriod = z.infer<typeof askPeriodSchema>;

/** 追加の引数(question 以外)。 */
export interface AskInputExtras {
  /** 利用者の直近の発言そのもの */
  readonly userMessage?: string;
  /** 会話から分かっている前提(UI 側 LLM が補ったもの。利用者の発言ではない) */
  readonly context?: string;
  /** 変えてはならない語(利用者が入力したキーワード) */
  readonly keepTerms?: readonly string[];
  /** 利用者が対象に指定したソース */
  readonly sources?: readonly string[];
  /** 利用者が指定した期間 */
  readonly period?: AskPeriod;
  /** 探索の深さ */
  readonly depth?: AskDepth;
}

/**
 * 追加の引数の前後の空白を除き、空のものを落とす(空の文字列・空の配列は省略と同じ)。
 * keepTerms は空の要素を落とし、重複を除く(順は保つ)。sources も重複を除く。
 */
export function normalizeAskExtras(extras: AskInputExtras): AskInputExtras {
  const userMessage = extras.userMessage?.trim();
  const context = extras.context?.trim();
  const keepTerms = [
    ...new Set((extras.keepTerms ?? []).map((term) => term.trim()).filter((t) => t !== "")),
  ];
  const sources = [...new Set((extras.sources ?? []).filter((s) => s !== ""))];
  const period =
    extras.period !== undefined &&
    (extras.period.updatedAfter !== undefined || extras.period.updatedBefore !== undefined)
      ? {
          ...(extras.period.updatedAfter !== undefined
            ? { updatedAfter: extras.period.updatedAfter }
            : {}),
          ...(extras.period.updatedBefore !== undefined
            ? { updatedBefore: extras.period.updatedBefore }
            : {}),
        }
      : undefined;
  return {
    ...(userMessage !== undefined && userMessage !== "" ? { userMessage } : {}),
    ...(context !== undefined && context !== "" ? { context } : {}),
    ...(keepTerms.length > 0 ? { keepTerms } : {}),
    ...(sources.length > 0 ? { sources } : {}),
    ...(period !== undefined ? { period } : {}),
    ...(extras.depth !== undefined ? { depth: extras.depth } : {}),
  };
}

/**
 * 追加の引数が上限に収まるか(Orchestrator の防御的な検証。サーバー側の検証は
 * server/tools.ts)。userMessage の上限は question と同じ値を渡す。理由は返さない
 * (呼び出し側は固定文言で拒否する)。
 */
export function askExtrasWithinLimits(
  extras: AskInputExtras,
  maxQuestionChars: number,
): boolean {
  if (extras.userMessage !== undefined && extras.userMessage.length > maxQuestionChars) {
    return false;
  }
  if (extras.context !== undefined && extras.context.length > MAX_CONTEXT_CHARS) {
    return false;
  }
  if (
    extras.keepTerms !== undefined &&
    (extras.keepTerms.length > MAX_KEEP_TERMS ||
      extras.keepTerms.some((term) => term.length > MAX_KEEP_TERM_CHARS))
  ) {
    return false;
  }
  if (
    extras.sources !== undefined &&
    (extras.sources.length > MAX_REQUESTED_SOURCES ||
      extras.sources.some((s) => s.length > MAX_SOURCE_ID_CHARS))
  ) {
    return false;
  }
  if (extras.period !== undefined && !askPeriodSchema.safeParse(extras.period).success) {
    return false;
  }
  if (extras.depth !== undefined && !(ASK_DEPTHS as readonly string[]).includes(extras.depth)) {
    return false;
  }
  return true;
}

/** depth から run の maxIterations を選ぶ(設定値を超えない)。 */
export function maxIterationsForDepth(
  depth: AskDepth | undefined,
  configured: number,
): number {
  return depth === "quick" ? Math.min(QUICK_MAX_ITERATIONS, configured) : configured;
}

/** run API で申告する質問(文字列を含む引数だけ。ADR-026 決定4)。 */
export function startRunQuestion(question: string, extras: AskInputExtras): StartRunQuestion {
  return {
    question,
    ...(extras.userMessage !== undefined ? { userMessage: extras.userMessage } : {}),
    ...(extras.context !== undefined ? { context: extras.context } : {}),
    ...(extras.keepTerms !== undefined ? { keepTerms: [...extras.keepTerms] } : {}),
  };
}

/** 探索 LLM に渡す区分があるか(depth は探索の上限にだけ効き、区分にしない)。 */
function hasPromptSections(extras: AskInputExtras): boolean {
  return (
    extras.userMessage !== undefined ||
    extras.context !== undefined ||
    extras.keepTerms !== undefined ||
    extras.sources !== undefined ||
    extras.period !== undefined
  );
}

/** 区分の見出し(利用者ターンの入力。`[オーケストレーター]` で始めない)。 */
export const ASK_USER_MESSAGE_HEADING = "利用者の発言(そのまま。UI 側で言い換えていない):";
export const ASK_CONTEXT_HEADING =
  "UI 側 LLM による補足(利用者の発言ではない。会話から補った前提。検索語に入れるかは区別して判断する):";
export const ASK_KEEP_TERMS_HEADING =
  "利用者が入力したキーワード(表記を変えずに使う。最初のターンで、これらの語をそのまま使った検索を 1 本出す):";
export const ASK_SOURCES_HEADING = "対象のソース(利用者の指定。これ以外のソースは検索できない):";
export const ASK_PERIOD_HEADING =
  "期間(利用者の指定。search の filters.updatedAfter / updatedBefore に入れる。そのソースの supportedFilters にない場合は入れない):";

/**
 * 引用の JSON 文字列(改行・制御文字をエスケープし、`<` `>` `[` `]` と全角の `［` `］` `【` `】`
 * も \u エスケープする)。
 */
function quoted(text: string): string {
  return escapePromptBrackets(JSON.stringify(text));
}

/**
 * 追加の引数の区分(最初の user ターンで質問の後ろに置く)。区分がなければ空の配列
 * (従来の最初の user ターンと同じになる)。userMessage / context は question と同じく
 * 利用者ターンの文として置き、行頭の `[オーケストレーター]`(全角の `［ ］`、`【 】` を含む)の
 * 体裁だけを無害化する(neutralizeControlLines。制御メッセージに見せない)。keepTerms は1語ずつ
 * JSON 文字列で引用する(語の境界を明確にする)。sources は Gateway の有効ソースの値(呼び出し側で検証済み)。
 */
export function buildAskInputSections(extras: AskInputExtras): Anthropic.TextBlockParam[] {
  if (!hasPromptSections(extras)) {
    return [];
  }
  const parts: string[] = [];
  if (extras.userMessage !== undefined) {
    parts.push(`${ASK_USER_MESSAGE_HEADING}\n${neutralizeControlLines(extras.userMessage)}`);
  }
  if (extras.context !== undefined) {
    parts.push(`${ASK_CONTEXT_HEADING}\n${neutralizeControlLines(extras.context)}`);
  }
  if (extras.keepTerms !== undefined) {
    parts.push(
      `${ASK_KEEP_TERMS_HEADING}\n${extras.keepTerms.map((term) => `- ${quoted(term)}`).join("\n")}`,
    );
  }
  if (extras.sources !== undefined) {
    parts.push(`${ASK_SOURCES_HEADING}\n${extras.sources.join(", ")}`);
  }
  if (extras.period !== undefined) {
    const lines = [
      ...(extras.period.updatedAfter !== undefined
        ? [`- updatedAfter: ${extras.period.updatedAfter}`]
        : []),
      ...(extras.period.updatedBefore !== undefined
        ? [`- updatedBefore: ${extras.period.updatedBefore}`]
        : []),
    ];
    parts.push(`${ASK_PERIOD_HEADING}\n${lines.join("\n")}`);
  }
  return [{ type: "text", text: parts.join("\n\n") }];
}
