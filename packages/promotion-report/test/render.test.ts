import { describe, expect, it } from "vitest";
import { aggregatePromotionReport } from "../src/aggregate.js";
import {
  renderJudgmentGuide,
  renderPromotionReportText,
} from "../src/index.js";
import {
  FIXED_NOW,
  fixtureRawQueries,
  fixtureRecords,
  fixtureSources,
} from "./fixture.js";

function renderedFixture(): string {
  return renderPromotionReportText(
    aggregatePromotionReport({
      records: fixtureRecords(),
      sources: fixtureSources(),
      rawQueries: fixtureRawQueries(),
      accessorUserId: "auditor-1",
      now: FIXED_NOW,
    }),
  );
}

describe("renderPromotionReportText", () => {
  it("空データのゴールデン(全文一致)", () => {
    const text = renderPromotionReportText(
      aggregatePromotionReport({
        records: [],
        sources: {},
        accessorUserId: "auditor-1",
        now: FIXED_NOW,
      }),
    );
    expect(text).toBe(
      [
        "# 昇格判定レポート(T-014)",
        "",
        "生成時刻: 2026-07-12T09:00:00.000Z",
        "入力レコード数: 0",
        "run数: 0(resolved=0 unresolved=0 未確定=0)",
        "",
        "## ソース別未解決率(AnswerRun単位)",
        "",
        "  (ツール呼び出しの記録がありません)",
        "",
        "## 再検索回数分布(runIdで束ねたsearch呼び出し)",
        "",
        "  (search呼び出しの記録がありません)",
        "",
        "## 失敗クエリ(未解決run、新しい順)",
        "",
        "  (未解決runはありません)",
        "",
        renderJudgmentGuide(),
        "",
      ].join("\n"),
    );
  });

  it("失敗クエリ: 保持期間内は原文、期限切れはdigestのみ+期限切れ表示", () => {
    const text = renderedFixture();
    expect(text).toContain('"経費精算の締め日はいつ?"');
    expect(text).toContain("(原文は保持期間切れ: digest=");
    expect(text).toContain("(最終質問が記録されていません)");
  });

  it("判定ガイドに5.1の基準・Slack対象外・index-required適用外・保持期間の注意を含む", () => {
    const text = renderedFixture();
    expect(text).toContain("判定ガイド(product-design.md 5.1 の昇格基準)");
    expect(text).toContain("Slackは昇格判定の対象外");
    expect(text).toContain("ADR-014");
    expect(text).toContain("証拠駆動ゲートの適用外(ADR-007)");
    expect(text).toContain("既定30日、ADR-013 §3");
    expect(text).toContain("searchLayer.enabled");
  });

  it("重複行を除いた場合は入力レコード数に除外件数を添える(なければ添えない)", () => {
    expect(renderedFixture()).toContain(`入力レコード数: ${fixtureRecords().length}\n`);
    const records = fixtureRecords();
    const text = renderPromotionReportText(
      aggregatePromotionReport({
        records: [...records, ...records.slice(0, 3)],
        sources: fixtureSources(),
        accessorUserId: "auditor-1",
        now: FIXED_NOW,
      }),
    );
    expect(text).toContain(
      `入力レコード数: ${records.length + 3}(重複 3 件を除いて集計)`,
    );
  });

  it("ソース行に判定対象/対象外/適用外/未分類のラベルが付く", () => {
    const text = renderedFixture();
    expect(text).toContain("  slack  ");
    expect(text).toContain("[対象外(Slack、ADR-014)]");
    expect(text).toContain("[適用外(index-required、ADR-007)]");
    expect(text).toContain("[未分類(sourcesメタに追加してください)]");
    expect(text).toContain("[判定対象]");
  });
});
