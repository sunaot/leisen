/**
 * 開発用の簡易評価(合成コーパスに対する質問セットの回帰チェック)。
 *
 * - T-008(評価ハーネス)の前段。leisen-ask を `--json` で質問ごとに起動し、結果を期待値と
 *   突き合わせて Markdown の表にする(起動は bin/dev-eval.ts)。本モジュールは副作用の
 *   ない部分(質問セットの検証・判定・集計・表)だけを持つ
 * - 対象は合成データ(examples/fixtures/dev-corpus.yaml)だけを想定する。質問文・回答本文は
 *   表に出さない(表に出すのは質問 ID・結果・引用した文書 ID・計測値)。実データの質問セットの
 *   扱いは T-008 で決める
 * - 判定: 期待した outcome か、resolved を期待した質問は期待した文書のどれかを引用したか
 *   (citeAnyOf)・すべてを引用したか(citeAllOf。複数文書にまたがる質問)、回答本文に URL が
 *   残っていないか(sanitize の契約。プロンプトで URL を求める質問を含める)
 * - 集計: 全体・質問の種類(category)ごと・質問ごと(--repeat のときの n 回中 k 回)
 */
import { z } from "zod";
import { answerSchema, type Answer } from "./answer.js";

/** 質問の種類(T-022)。種類ごとに合格数を集計する */
export const DEV_EVAL_CATEGORIES = [
  "baseline",
  "uncovered-doc",
  "paraphrase",
  "english",
  "multi-doc",
  "absent",
] as const;
export type DevEvalCategory = (typeof DEV_EVAL_CATEGORIES)[number];

export const devEvalQuestionSchema = z
  .strictObject({
    /** 表に出す識別子(英数字・-・_) */
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
    /** 質問の種類(省略時は種類別の集計で「(なし)」) */
    category: z.enum(DEV_EVAL_CATEGORIES).optional(),
    question: z.string().min(1).max(2000),
    expect: z.strictObject({
      outcome: z.enum(["resolved", "unresolved"]),
      /** resolved を期待する場合に、少なくとも1つを引用すべき文書(`sourceId:documentId`) */
      citeAnyOf: z.array(z.string().min(3)).min(1).optional(),
      /** resolved を期待する場合に、すべてを引用すべき文書(複数文書にまたがる質問) */
      citeAllOf: z.array(z.string().min(3)).min(1).optional(),
    }),
  })
  .superRefine((question, ctx) => {
    const { expect } = question;
    if (
      expect.outcome === "unresolved" &&
      (expect.citeAnyOf !== undefined || expect.citeAllOf !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "citeAnyOf / citeAllOf は outcome が resolved の質問にだけ書ける",
        path: ["expect"],
      });
    }
  });
export type DevEvalQuestion = z.infer<typeof devEvalQuestionSchema>;

export const devEvalQuestionSetSchema = z
  .strictObject({
    version: z.literal(1),
    description: z.string().optional(),
    questions: z.array(devEvalQuestionSchema).min(1).max(100),
  })
  .superRefine((set, ctx) => {
    const seen = new Set<string>();
    for (const [index, question] of set.questions.entries()) {
      if (seen.has(question.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate question id: ${question.id}`,
          path: ["questions", index, "id"],
        });
      }
      seen.add(question.id);
    }
  });
export type DevEvalQuestionSet = z.infer<typeof devEvalQuestionSetSchema>;

/** leisen-ask --json の失敗の表現(README「leisen-ask の出力契約」) */
const failureSchema = z.object({
  outcome: z.literal("error"),
  errorClass: z.string(),
  message: z.string().optional(),
});

/** leisen-ask 1 回分の生の結果(bin/dev-eval.ts が集める) */
export interface DevEvalRawRun {
  readonly question: DevEvalQuestion;
  /** 何回目か(1 始まり。--repeat) */
  readonly attempt: number;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly elapsedMs: number;
  /** 打ち切った(dev-eval 側のタイムアウト)なら true */
  readonly timedOut: boolean;
}

export type DevEvalVerdict = "pass" | "fail" | "error";

export interface DevEvalResult {
  readonly id: string;
  readonly category?: DevEvalCategory;
  readonly attempt: number;
  readonly verdict: DevEvalVerdict;
  /** 不合格・エラーの理由(固定文言と ID だけ。回答本文は含めない) */
  readonly reasons: readonly string[];
  readonly outcome: Answer["outcome"] | "error";
  readonly citedDocIds: readonly string[];
  readonly llmTurns?: number;
  readonly toolCalls?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly elapsedMs: number;
  /** 探索の上限で打ち切った(warnings から判定) */
  readonly hitLimit: boolean;
}

const URL_PATTERN = /https?:\/\/|www\./iu;
const LIMIT_WARNING_PATTERN = /上限/u;

/** leisen-ask --json の stdout(JSON がちょうど1つ。整形済み)を読む。 */
function parseStdout(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/** leisen-ask 1 回分の結果を判定する。 */
export function judgeRun(run: DevEvalRawRun): DevEvalResult {
  const base = {
    id: run.question.id,
    ...(run.question.category === undefined ? {} : { category: run.question.category }),
    attempt: run.attempt,
    elapsedMs: run.elapsedMs,
  };
  if (run.timedOut) {
    return {
      ...base,
      verdict: "error",
      reasons: ["dev-eval のタイムアウトで打ち切った"],
      outcome: "error",
      citedDocIds: [],
      hitLimit: false,
    };
  }
  const parsed = parseStdout(run.stdout);
  const answer = answerSchema.safeParse(parsed);
  if (!answer.success) {
    const failure = failureSchema.safeParse(parsed);
    return {
      ...base,
      verdict: "error",
      reasons: [
        failure.success
          ? `leisen-ask が回答を返せなかった(${failure.data.errorClass}、終了コード ${String(run.exitCode)})`
          : `leisen-ask の出力を解釈できなかった(終了コード ${String(run.exitCode)})`,
      ],
      outcome: "error",
      citedDocIds: [],
      hitLimit: false,
    };
  }
  const data = answer.data;
  const citedDocIds = data.citations.map((c) => `${c.sourceId}:${c.documentId}`);
  const metrics = {
    outcome: data.outcome,
    citedDocIds,
    llmTurns: data.usage.llmTurns,
    toolCalls: data.usage.toolCalls,
    inputTokens: data.usage.inputTokens,
    outputTokens: data.usage.outputTokens,
    hitLimit: data.warnings.some((w) => LIMIT_WARNING_PATTERN.test(w)),
  };
  if (data.outcome === "error") {
    // error の回答文はシステムの固定文言で、正規化コードを括弧で添える(src/failure-text.ts)
    const code = /\(([a-z][a-z0-9_]*)\)/u.exec(data.answer)?.[1];
    return {
      ...base,
      ...metrics,
      verdict: "error",
      reasons: [`run が error で終わった${code === undefined ? "" : `(${code})`}`],
    };
  }
  const reasons: string[] = [];
  const { expect } = run.question;
  if (data.outcome !== expect.outcome) {
    reasons.push(`outcome が ${data.outcome}(期待 ${expect.outcome})`);
  }
  if (expect.outcome === "resolved" && expect.citeAnyOf !== undefined) {
    const expected = new Set(expect.citeAnyOf);
    if (!citedDocIds.some((id) => expected.has(id))) {
      reasons.push(`期待した文書を引用していない(期待 ${expect.citeAnyOf.join(" / ")})`);
    }
  }
  if (expect.outcome === "resolved" && expect.citeAllOf !== undefined) {
    const cited = new Set(citedDocIds);
    const missing = expect.citeAllOf.filter((id) => !cited.has(id));
    if (missing.length > 0) {
      reasons.push(`期待した文書の一部を引用していない(不足 ${missing.join(", ")})`);
    }
  }
  if (URL_PATTERN.test(data.answer)) {
    reasons.push("回答本文に URL が残っている");
  }
  return { ...base, ...metrics, verdict: reasons.length === 0 ? "pass" : "fail", reasons };
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** 合格数の内訳(種類ごと・質問ごと) */
export interface DevEvalTally {
  readonly key: string;
  readonly pass: number;
  readonly total: number;
}

export interface DevEvalSummary {
  readonly total: number;
  readonly pass: number;
  readonly fail: number;
  readonly error: number;
  readonly medianElapsedMs?: number;
  readonly meanLlmTurns?: number;
  readonly meanToolCalls?: number;
  readonly hitLimit: number;
  /** 種類ごとの合格数(DEV_EVAL_CATEGORIES の順、種類なしは末尾の「(なし)」) */
  readonly byCategory: readonly DevEvalTally[];
  /** 質問ごとの合格数(初出順。--repeat のときに n 回中 k 回を見る) */
  readonly byQuestion: readonly DevEvalTally[];
}

const NO_CATEGORY = "(なし)";

function tally(
  results: readonly DevEvalResult[],
  keyOf: (result: DevEvalResult) => string,
  order: readonly string[] = [],
): DevEvalTally[] {
  const counts = new Map<string, { pass: number; total: number }>();
  for (const key of order) {
    if (results.some((r) => keyOf(r) === key)) {
      counts.set(key, { pass: 0, total: 0 });
    }
  }
  for (const result of results) {
    const key = keyOf(result);
    const entry = counts.get(key) ?? { pass: 0, total: 0 };
    counts.set(key, {
      pass: entry.pass + (result.verdict === "pass" ? 1 : 0),
      total: entry.total + 1,
    });
  }
  return [...counts].map(([key, { pass, total }]) => ({ key, pass, total }));
}

export function summarize(results: readonly DevEvalResult[]): DevEvalSummary {
  const count = (verdict: DevEvalVerdict) => results.filter((r) => r.verdict === verdict).length;
  const mean = (values: readonly number[]) =>
    values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length;
  const turns = results.flatMap((r) => (r.llmTurns === undefined ? [] : [r.llmTurns]));
  const calls = results.flatMap((r) => (r.toolCalls === undefined ? [] : [r.toolCalls]));
  const medianElapsedMs = median(results.map((r) => r.elapsedMs));
  const meanLlmTurns = mean(turns);
  const meanToolCalls = mean(calls);
  return {
    total: results.length,
    pass: count("pass"),
    fail: count("fail"),
    error: count("error"),
    ...(medianElapsedMs === undefined ? {} : { medianElapsedMs }),
    ...(meanLlmTurns === undefined ? {} : { meanLlmTurns }),
    ...(meanToolCalls === undefined ? {} : { meanToolCalls }),
    hitLimit: results.filter((r) => r.hitLimit).length,
    byCategory: tally(results, (r) => r.category ?? NO_CATEGORY, [...DEV_EVAL_CATEGORIES, NO_CATEGORY]),
    byQuestion: tally(results, (r) => r.id),
  };
}

const VERDICT_MARK: Readonly<Record<DevEvalVerdict, string>> = {
  pass: "○",
  fail: "×",
  error: "!",
};

function cell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

/** 結果を Markdown にする(質問文・回答本文は含めない)。 */
export function formatReport(
  results: readonly DevEvalResult[],
  context: { readonly label?: string; readonly promptVersion: string },
): string {
  const lines: string[] = [];
  const summary = summarize(results);
  lines.push(`## dev-eval${context.label === undefined ? "" : `: ${cell(context.label)}`}`);
  lines.push("");
  lines.push(`- プロンプト: ${context.promptVersion}`);
  lines.push(
    `- 合格 ${summary.pass} / ${summary.total}(不合格 ${summary.fail}、エラー ${summary.error})、` +
      `上限到達 ${summary.hitLimit}`,
  );
  const parts: string[] = [];
  if (summary.medianElapsedMs !== undefined) {
    parts.push(`所要時間の中央値 ${seconds(summary.medianElapsedMs)} 秒`);
  }
  if (summary.meanLlmTurns !== undefined) {
    parts.push(`LLM ターンの平均 ${summary.meanLlmTurns.toFixed(1)}`);
  }
  if (summary.meanToolCalls !== undefined) {
    parts.push(`ツール呼び出しの平均 ${summary.meanToolCalls.toFixed(1)}`);
  }
  if (parts.length > 0) {
    lines.push(`- ${parts.join("、")}`);
  }
  if (summary.byCategory.some((t) => t.key !== NO_CATEGORY)) {
    lines.push("");
    lines.push("| 種類 | 合格 |");
    lines.push("|---|---|");
    for (const t of summary.byCategory) {
      lines.push(`| ${cell(t.key)} | ${t.pass} / ${t.total} |`);
    }
  }
  if (summary.byQuestion.some((t) => t.total > 1)) {
    lines.push("");
    lines.push("| 質問 | 合格回数 |");
    lines.push("|---|---|");
    for (const t of summary.byQuestion) {
      lines.push(`| ${cell(t.key)} | ${t.pass} / ${t.total} |`);
    }
  }
  lines.push("");
  lines.push("| 質問 | 種類 | 回 | 判定 | outcome | 引用 | LLM ターン | ツール呼び出し | 入力 / 出力トークン | 秒 | 理由 |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    lines.push(
      [
        "",
        cell(r.id),
        r.category ?? "—",
        String(r.attempt),
        VERDICT_MARK[r.verdict],
        r.outcome,
        r.citedDocIds.length === 0 ? "—" : cell(r.citedDocIds.join(", ")),
        r.llmTurns === undefined ? "—" : String(r.llmTurns),
        r.toolCalls === undefined ? "—" : String(r.toolCalls),
        r.inputTokens === undefined || r.outputTokens === undefined
          ? "—"
          : `${r.inputTokens} / ${r.outputTokens}`,
        seconds(r.elapsedMs),
        r.reasons.length === 0 ? "" : cell(r.reasons.join("; ")),
        "",
      ].join(" | ").trim(),
    );
  }
  return lines.join("\n");
}
