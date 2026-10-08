/**
 * 開発用の簡易評価(合成コーパスに対する質問セットの回帰チェック)。
 *
 * - T-008(評価ハーネス)の前段。kp-ask を `--json` で質問ごとに起動し、結果を期待値と
 *   突き合わせて Markdown の表にする(起動は bin/dev-eval.ts)。本モジュールは副作用の
 *   ない部分(質問セットの検証・判定・集計・表)だけを持つ
 * - 対象は合成データ(examples/fixtures/dev-corpus.yaml)だけを想定する。質問文・回答本文は
 *   表に出さない(表に出すのは質問 ID・結果・引用した文書 ID・計測値)。実データの質問セットの
 *   扱いは T-008 で決める
 * - 判定: 期待した outcome か、resolved を期待した質問は期待した文書のどれかを引用したか、
 *   回答本文に URL が残っていないか(sanitize の契約。プロンプトで URL を求める質問を含める)
 */
import { z } from "zod";
import { answerSchema, type Answer } from "./answer.js";

export const devEvalQuestionSchema = z.strictObject({
  /** 表に出す識別子(英数字・-・_) */
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
  question: z.string().min(1).max(2000),
  expect: z.strictObject({
    outcome: z.enum(["resolved", "unresolved"]),
    /** resolved を期待する場合に、少なくとも1つを引用すべき文書(`sourceId:documentId`) */
    citeAnyOf: z.array(z.string().min(3)).min(1).optional(),
  }),
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

/** kp-ask --json の失敗の表現(README「kp-ask の出力契約」) */
const failureSchema = z.object({
  outcome: z.literal("error"),
  errorClass: z.string(),
  message: z.string().optional(),
});

/** kp-ask 1 回分の生の結果(bin/dev-eval.ts が集める) */
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

/** kp-ask --json の stdout(JSON がちょうど1つ。整形済み)を読む。 */
function parseStdout(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/** kp-ask 1 回分の結果を判定する。 */
export function judgeRun(run: DevEvalRawRun): DevEvalResult {
  const base = { id: run.question.id, attempt: run.attempt, elapsedMs: run.elapsedMs };
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
          ? `kp-ask が回答を返せなかった(${failure.data.errorClass}、終了コード ${String(run.exitCode)})`
          : `kp-ask の出力を解釈できなかった(終了コード ${String(run.exitCode)})`,
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

export interface DevEvalSummary {
  readonly total: number;
  readonly pass: number;
  readonly fail: number;
  readonly error: number;
  readonly medianElapsedMs?: number;
  readonly meanLlmTurns?: number;
  readonly meanToolCalls?: number;
  readonly hitLimit: number;
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
  lines.push("");
  lines.push("| 質問 | 回 | 判定 | outcome | 引用 | LLM ターン | ツール呼び出し | 入力 / 出力トークン | 秒 | 理由 |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    lines.push(
      [
        "",
        cell(r.id),
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
