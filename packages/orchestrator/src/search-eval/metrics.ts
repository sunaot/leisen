/**
 * 比較実験の指標と集計(副作用なし)。
 *
 * 1 回の試行(方式 × 条件 × 質問 × 回)のトレースから次を求める:
 * - recall@k: 正解の文書のうち、その試行のいずれかの search で k 位以内に返った割合
 *   (search を複数回呼んだ場合は、文書ごとに最もよい順位を使う)
 * - 最初の正解の順位: 正解の文書の最もよい順位(どの search でも返らなければなし)
 * - fetch 率・引用率: 正解の文書のうち fetch した / 最終回答で引用した割合(条件 3・4 のみ)
 * - 棄権: 答えられない質問で、最終回答が resolved 以外だったか(条件 3・4 のみ)
 * - 0 件の search の数(認可済みの結果が 0 件だった search)
 */
import type { SearchEvalCategory, SearchEvalQuestion } from "./questions.js";
import {
  SEARCH_EVAL_CONDITIONS,
  type AnswerTraceEvent,
  type SearchEvalCondition,
  type TraceEvent,
} from "./trace.js";

export const DEFAULT_RECALL_KS: readonly number[] = [1, 5, 10];

/** 1 回の試行の指標。 */
export interface CaseMetrics {
  readonly mode: string;
  readonly condition: SearchEvalCondition;
  readonly questionId: string;
  readonly category: SearchEvalCategory;
  readonly attempt: number;
  /** 正解の文書の数(unanswerable は 0) */
  readonly relevantCount: number;
  /** k → recall(relevantCount が 0 なら undefined) */
  readonly recallAt: Readonly<Record<number, number>> | undefined;
  readonly firstRelevantRank: number | undefined;
  readonly searches: number;
  readonly zeroHitSearches: number;
  /** 条件 3・4 のみ */
  readonly fetchedRate?: number;
  readonly citedRate?: number;
  readonly outcome?: string;
  /** unanswerable で resolved 以外に終わった(条件 3・4 のみ) */
  readonly abstained?: boolean;
  /** 試行を完了できなかった(UI 側 LLM が ask を呼ばない等)の分類 */
  readonly errorClass?: string;
}

function docKey(source: string, documentId: string): string {
  return `${source}:${documentId}`;
}

const isOrchestratorCondition = (condition: SearchEvalCondition) =>
  condition === "orchestrator-utterance" || condition === "orchestrator-ui";

/** 1 回の試行のトレース(同じ文脈のイベント)から指標を求める。 */
export function caseMetrics(
  question: SearchEvalQuestion,
  context: { readonly mode: string; readonly condition: SearchEvalCondition; readonly attempt: number },
  events: readonly TraceEvent[],
  ks: readonly number[] = DEFAULT_RECALL_KS,
): CaseMetrics {
  const relevant = new Set(question.relevant);
  const bestRank = new Map<string, number>();
  let searches = 0;
  let zeroHitSearches = 0;
  const fetched = new Set<string>();
  let answer: AnswerTraceEvent | undefined;
  let errorClass: string | undefined;
  for (const event of events) {
    switch (event.type) {
      case "search":
        searches += 1;
        if (event.errorClass === undefined && event.hits.length === 0) {
          zeroHitSearches += 1;
        }
        for (const hit of event.hits) {
          const key = docKey(event.source, hit.documentId);
          const current = bestRank.get(key);
          if (current === undefined || hit.rank < current) {
            bestRank.set(key, hit.rank);
          }
        }
        break;
      case "fetch":
        if (event.errorClass === undefined) {
          fetched.add(docKey(event.source, event.documentId));
        }
        break;
      case "answer":
        answer = event;
        break;
      case "case_error":
        errorClass = event.errorClass;
        break;
      default:
        break;
    }
  }
  const relevantRanks = [...relevant].flatMap((key) => {
    const rank = bestRank.get(key);
    return rank === undefined ? [] : [rank];
  });
  const recallAt =
    relevant.size === 0
      ? undefined
      : Object.fromEntries(
          ks.map((k) => [k, relevantRanks.filter((rank) => rank <= k).length / relevant.size]),
        );
  const firstRelevantRank = relevantRanks.length === 0 ? undefined : Math.min(...relevantRanks);
  const orchestrated = isOrchestratorCondition(context.condition);
  const cited = new Set((answer?.citations ?? []).map((c) => docKey(c.sourceId, c.documentId)));
  const share = (set: ReadonlySet<string>) =>
    relevant.size === 0 ? 0 : [...relevant].filter((key) => set.has(key)).length / relevant.size;
  return {
    mode: context.mode,
    condition: context.condition,
    questionId: question.id,
    category: question.category,
    attempt: context.attempt,
    relevantCount: relevant.size,
    recallAt,
    firstRelevantRank,
    searches,
    zeroHitSearches,
    ...(orchestrated && relevant.size > 0 ? { fetchedRate: share(fetched), citedRate: share(cited) } : {}),
    ...(orchestrated && answer !== undefined ? { outcome: answer.outcome } : {}),
    ...(orchestrated && question.category === "unanswerable"
      ? { abstained: answer !== undefined && answer.outcome !== "resolved" }
      : {}),
    ...(errorClass !== undefined ? { errorClass } : {}),
  };
}

/** 方式 × 条件 × 種類ごとの集計。 */
export interface MetricsSummaryRow {
  readonly mode: string;
  readonly condition: SearchEvalCondition;
  readonly category: SearchEvalCategory | "all-answerable";
  readonly cases: number;
  readonly meanRecallAt: Readonly<Record<number, number>> | undefined;
  /** 正解が 1 件以上どこかの順位で返った試行の数 */
  readonly found: number;
  readonly medianFirstRank: number | undefined;
  readonly meanFetchedRate: number | undefined;
  readonly meanCitedRate: number | undefined;
  /** unanswerable の棄権の数(条件 3・4) */
  readonly abstained: number | undefined;
  readonly meanSearches: number;
  readonly zeroHitSearchRate: number | undefined;
  readonly errors: number;
}

function mean(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function summarizeGroup(
  rows: readonly CaseMetrics[],
  key: Pick<MetricsSummaryRow, "mode" | "condition" | "category">,
  ks: readonly number[],
): MetricsSummaryRow {
  const recalls = rows.flatMap((r) => (r.recallAt === undefined ? [] : [r.recallAt]));
  const ranks = rows.flatMap((r) => (r.firstRelevantRank === undefined ? [] : [r.firstRelevantRank]));
  const fetchedRates = rows.flatMap((r) => (r.fetchedRate === undefined ? [] : [r.fetchedRate]));
  const citedRates = rows.flatMap((r) => (r.citedRate === undefined ? [] : [r.citedRate]));
  const abstentions = rows.flatMap((r) => (r.abstained === undefined ? [] : [r.abstained]));
  const searches = rows.reduce((a, r) => a + r.searches, 0);
  const zero = rows.reduce((a, r) => a + r.zeroHitSearches, 0);
  return {
    ...key,
    cases: rows.length,
    meanRecallAt:
      recalls.length === 0
        ? undefined
        : Object.fromEntries(ks.map((k) => [k, mean(recalls.map((r) => r[k] ?? 0)) ?? 0])),
    found: ranks.length,
    medianFirstRank: median(ranks),
    meanFetchedRate: mean(fetchedRates),
    meanCitedRate: mean(citedRates),
    abstained: abstentions.length === 0 ? undefined : abstentions.filter((a) => a).length,
    meanSearches: rows.length === 0 ? 0 : searches / rows.length,
    zeroHitSearchRate: searches === 0 ? undefined : zero / searches,
    errors: rows.filter((r) => r.errorClass !== undefined).length,
  };
}

const CATEGORY_ORDER: readonly (SearchEvalCategory | "all-answerable")[] = [
  "known-item",
  "multi-doc",
  "all-answerable",
  "unanswerable",
];

/** 方式(出現順)× 条件(定義順)× 種類(known-item / multi-doc / 両方 / unanswerable)で集計する。 */
export function summarizeMetrics(
  rows: readonly CaseMetrics[],
  ks: readonly number[] = DEFAULT_RECALL_KS,
): MetricsSummaryRow[] {
  const modes = [...new Set(rows.map((r) => r.mode))];
  const out: MetricsSummaryRow[] = [];
  for (const mode of modes) {
    for (const condition of SEARCH_EVAL_CONDITIONS) {
      const subset = rows.filter((r) => r.mode === mode && r.condition === condition);
      if (subset.length === 0) {
        continue;
      }
      for (const category of CATEGORY_ORDER) {
        const group =
          category === "all-answerable"
            ? subset.filter((r) => r.category !== "unanswerable")
            : subset.filter((r) => r.category === category);
        if (group.length > 0) {
          out.push(summarizeGroup(group, { mode, condition, category }, ks));
        }
      }
    }
  }
  return out;
}

const CONDITION_LABEL: Readonly<Record<SearchEvalCondition, string>> = {
  keywords: "1 キーワード直接",
  utterance: "2 発言を直接",
  "orchestrator-utterance": "3 発言→探索LLM",
  "orchestrator-ui": "4 UI LLM→探索LLM",
};

function pct(value: number | undefined): string {
  return value === undefined ? "—" : `${(value * 100).toFixed(0)}%`;
}

function cell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

/**
 * 結果を Markdown にする。出すのは方式・条件・質問 ID・指標だけ(質問文・クエリ・回答本文は
 * トレースの JSONL に残し、表には出さない)。
 */
export function formatMetricsReport(
  rows: readonly CaseMetrics[],
  context: { readonly label?: string; readonly corpusSize: number; readonly ks?: readonly number[] },
): string {
  const ks = context.ks ?? DEFAULT_RECALL_KS;
  const lines: string[] = [];
  lines.push(`## dev-search-eval${context.label === undefined ? "" : `: ${cell(context.label)}`}`);
  lines.push("");
  lines.push(`- コーパス ${context.corpusSize} 件(合成)。試行 ${rows.length} 件`);
  lines.push(
    "- recall@k は正解の文書のうち試行中のいずれかの search で k 位以内に返った割合の平均、" +
      "順位は最初の正解の順位の中央値(返った試行のみ)、fetch / 引用は正解の文書のうち fetch / 引用した割合の平均",
  );
  lines.push("");
  const header = [
    "方式",
    "条件",
    "種類",
    "試行",
    ...ks.map((k) => `recall@${k}`),
    "正解が返った",
    "順位(中央値)",
    "fetch",
    "引用",
    "棄権",
    "search/試行",
    "0件の search",
    "エラー",
  ];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`|${header.map(() => "---").join("|")}|`);
  for (const row of summarizeMetrics(rows, ks)) {
    lines.push(
      `| ${[
        cell(row.mode),
        CONDITION_LABEL[row.condition],
        row.category,
        String(row.cases),
        ...ks.map((k) => pct(row.meanRecallAt?.[k])),
        row.category === "unanswerable" ? "—" : `${row.found} / ${row.cases}`,
        row.medianFirstRank === undefined ? "—" : String(row.medianFirstRank),
        pct(row.meanFetchedRate),
        pct(row.meanCitedRate),
        row.abstained === undefined ? "—" : `${row.abstained} / ${row.cases}`,
        row.meanSearches.toFixed(1),
        pct(row.zeroHitSearchRate),
        String(row.errors),
      ].join(" | ")} |`,
    );
  }
  // 質問ごと: 方式 × 条件の最初の正解の順位(返らなければ ×、unanswerable は返ったヒット数ではなく —)
  const modes = [...new Set(rows.map((r) => r.mode))];
  const conditions = SEARCH_EVAL_CONDITIONS.filter((c) => rows.some((r) => r.condition === c));
  const questionIds = [...new Set(rows.map((r) => r.questionId))];
  lines.push("");
  lines.push("質問ごとの最初の正解の順位(× = どの search でも返らなかった。--repeat のときは試行ごとに / で区切る。unanswerable は条件 3・4 の棄権を ○ / ×)");
  lines.push("");
  const columns = modes.flatMap((mode) => conditions.map((condition) => ({ mode, condition })));
  lines.push(`| 質問 | 種類 | ${columns.map((c) => `${cell(c.mode)} ${c.condition === "keywords" ? "1" : c.condition === "utterance" ? "2" : c.condition === "orchestrator-utterance" ? "3" : "4"}`).join(" | ")} |`);
  lines.push(`|---|---|${columns.map(() => "---").join("|")}|`);
  for (const id of questionIds) {
    const category = rows.find((r) => r.questionId === id)?.category ?? "known-item";
    const cells = columns.map(({ mode, condition }) => {
      const matching = rows.filter((r) => r.questionId === id && r.mode === mode && r.condition === condition);
      if (matching.length === 0) {
        return "";
      }
      return matching
        .map((r) => {
          if (r.errorClass !== undefined) {
            return "!";
          }
          if (category === "unanswerable") {
            return r.abstained === undefined ? "—" : r.abstained ? "○" : "×";
          }
          return r.firstRelevantRank === undefined ? "×" : String(r.firstRelevantRank);
        })
        .join("/");
    });
    lines.push(`| ${cell(id)} | ${category} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}
