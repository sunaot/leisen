/**
 * 昇格判定レポートのテキスト表示(T-014)。
 *
 * 集計(aggregate.ts)と分離してあり、将来の管理画面はここを差し替えて
 * PromotionReport をそのまま消費する。判定ガイド(product-design.md 5.1)を
 * 出力に含める。
 */
import type {
  FailedQuery,
  PromotionReport,
  SearchCountBucket,
  SourceStat,
  UserMismatchWarning,
} from "./aggregate.js";
import type { PromotionEligibility } from "./sources.js";

const ELIGIBILITY_LABEL: Record<PromotionEligibility, string> = {
  eligible: "判定対象",
  exempt_index_required: "適用外(index-required、ADR-007)",
  excluded_slack: "対象外(Slack、ADR-014)",
  unclassified: "未分類(sourcesメタに追加してください)",
};

function pct(value: number | null): string {
  return value === null ? "-" : `${(value * 100).toFixed(1)}%`;
}

function renderSourceRow(s: SourceStat): string {
  return [
    `  ${s.sourceId}`,
    `runs=${s.runs}`,
    `unresolved=${s.unresolvedRuns}`,
    `rate=${pct(s.unresolvedRate)}`,
    `share=${pct(s.shareOfUnresolved)}`,
    `calls=${s.invocations}`,
    `[${ELIGIBILITY_LABEL[s.eligibility]}]`,
  ].join("  ");
}

/**
 * 再検索回数(run 内の search 呼び出し件数)の区分名。
 * 0回 = 検索なし、1回 = 1発、2回以上 = 再検索。
 */
function searchCountLabel(searchCount: number): string {
  if (searchCount === 0) return "検索なし";
  if (searchCount === 1) return "1発";
  return "再検索";
}

function renderSearchCountBucket(b: SearchCountBucket): string {
  return `  ${b.searchCount}回(${searchCountLabel(b.searchCount)}): runs=${b.runs} unresolved=${b.unresolvedRuns}`;
}

/**
 * (runId, userId) 結合の不一致の警告。件数と runId だけを出す(userId・文書ID・クエリは
 * 出さない)。不一致がなければ節ごと出さない。
 */
function renderUserMismatchWarnings(
  warnings: readonly UserMismatchWarning[],
): string[] {
  if (warnings.length === 0) return [];
  const total = warnings.reduce((sum, w) => sum + w.invocations, 0);
  return [
    "## 警告: userId が AnswerRun と一致しない ToolInvocation(集計から除外)",
    "",
    `  runId は同じだが userId が AnswerRun と異なる ToolInvocation を ${total} 件(${warnings.length} run)、`,
    "  ソース別未解決率・再検索回数分布の集計から除外しました。実装の不具合か runId の申告の",
    "  偽装が考えられます。docs/audit-queries.md §0 のクエリで原因を調べてください。",
    ...warnings.map((w) => `  run=${w.runId}  除外=${w.invocations}件`),
    "",
  ];
}

function renderFailedQuery(f: FailedQuery): string {
  const digest = f.finalQueryDigest
    ? `${f.finalQueryDigest.slice(0, 12)}…`
    : "(digestなし)";
  const query =
    f.status === "available"
      ? JSON.stringify(f.rawQuery)
      : f.status === "expired_or_missing"
        ? `(原文は保持期間切れ: digest=${digest})`
        : "(最終質問が記録されていません)";
  const reason = f.failureReason ? `  reason=${f.failureReason}` : "";
  const sources =
    f.searchedSources.length > 0 ? f.searchedSources.join(",") : "-";
  return `  ${f.startedAt}  run=${f.runId}  sources=${sources}${reason}\n    ${query}`;
}

/** 判定ガイド(product-design.md 5.1 の昇格基準)。 */
export function renderJudgmentGuide(): string {
  return [
    "## 判定ガイド(product-design.md 5.1 の昇格基準)",
    "",
    "次の3条件を満たすソースのみ検索層を有効化(昇格)する:",
    "  1. 未解決クエリに占めるそのソース起因の割合が高い(目安: 上位2ソースに集中)",
    "     → 上表の share を見る",
    "  2. 失敗原因が「文書は存在するのにネイティブ検索で到達できない」であることを",
    "     サンプリング調査で確認済み → 下の失敗クエリ原文を使って手動調査する",
    "  3. 反復回数を増やしても解決率が改善しない(探索戦略の調整では吸収不能)",
    "     → 再検索回数分布で、再検索(search 2回以上)の run でも unresolved が減らないことを見る",
    "",
    "注意:",
    "- **Slackは昇格判定の対象外**(ADR-014: RTS API/API Termsにより中央インデックス化が",
    "  原則不可)。オンデマンド検索ソースとして扱い、本レポートの判定に含めない",
    "- nativeSearch \"none\"(index-required)のソースは検索層が必須であり、",
    "  証拠駆動ゲートの適用外(ADR-007)",
    "- post-filtering前の候補件数・分離テレメトリは本レポートでは扱わない(ADR-011/012)",
    "- 失敗クエリの原文はrawQueryテーブルの保持期間内(既定30日、ADR-013 §3)のみ",
    "  表示される。期限切れはdigestのみとなり判定材料にならないため、",
    "  レポートは保持期間内に定期実行すること",
    "- 有効化の操作は deployment.yaml の connectors[].searchLayer.enabled(T-010)",
  ].join("\n");
}

export function renderPromotionReportText(report: PromotionReport): string {
  const lines: string[] = [
    "# 昇格判定レポート(T-014)",
    "",
    `生成時刻: ${report.generatedAt}`,
    `入力レコード数: ${report.inputRecordCount}` +
      (report.duplicateRecordCount > 0
        ? `(重複 ${report.duplicateRecordCount} 件を除いて集計)`
        : ""),
    `run数: ${report.totalRuns}(resolved=${report.resolvedRuns} unresolved=${report.unresolvedRuns} 未確定=${report.undecidedRuns})`,
    "",
    ...renderUserMismatchWarnings(report.userMismatchWarnings),
    "## ソース別未解決率(AnswerRun単位)",
    "",
  ];
  if (report.sourceStats.length === 0) {
    lines.push("  (ツール呼び出しの記録がありません)");
  } else {
    lines.push(...report.sourceStats.map(renderSourceRow));
  }

  lines.push(
    "",
    "## 再検索回数分布(run内のsearch呼び出し件数: 0回=検索なし、1回=1発、2回以上=再検索)",
    "",
    "  結果確定済み(resolved/unresolved)のrunごとに search の呼び出しを数える(重複行を除き、",
    "  (runId, userId) で束ねたもの)。describe / fetch / list の呼び出しは数えない",
    "",
  );
  if (report.searchCountDistribution.length === 0) {
    lines.push("  (結果確定済みのrunがありません)");
  } else {
    lines.push(...report.searchCountDistribution.map(renderSearchCountBucket));
  }

  lines.push("", "## 失敗クエリ(未解決run、新しい順)", "");
  if (report.failedQueries.length === 0) {
    lines.push("  (未解決runはありません)");
  } else {
    lines.push(...report.failedQueries.map(renderFailedQuery));
  }

  lines.push("", renderJudgmentGuide(), "");
  return lines.join("\n");
}
