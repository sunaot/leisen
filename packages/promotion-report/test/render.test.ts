import { describe, expect, it } from "vitest";
import type { AuditRecord } from "@kp/gateway";
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
  invocation,
  runInvocations,
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
        "## 再検索回数分布(run内のsearch呼び出し件数: 0回=検索なし、1回=1発、2回以上=再検索)",
        "",
        "  結果確定済み(resolved/unresolved)のrunごとに search の呼び出しを数える(重複行を除き、",
        "  (runId, userId) で束ねたもの)。describe / fetch / list の呼び出しは数えない",
        "",
        "  (結果確定済みのrunがありません)",
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

  it("再検索回数分布: search の件数を 0回=検索なし / 1回=1発 / 2回以上=再検索 の区分名つきで表示する", () => {
    const text = renderedFixture();
    expect(text).toContain(
      [
        "  0回(検索なし): runs=1 unresolved=0",
        "  1回(1発): runs=2 unresolved=1",
        "  2回(再検索): runs=1 unresolved=1",
        "  3回(再検索): runs=1 unresolved=1",
      ].join("\n"),
    );
    expect(text).toContain("再検索(search 2回以上)の run でも unresolved が減らない");
  });

  it("userId 不一致の警告: 件数と runId だけをレポートの冒頭に表示し、不一致がなければ警告節を出さない", () => {
    expect(renderedFixture()).not.toContain("## 警告");

    // 別の利用者(u-other)が run-3 と run-4 の runId を申告した呼び出し
    const records = [
      ...fixtureRecords(),
      ...runInvocations("run-3", "u-other", "2026-07-11T09:40:00Z", [["search", "wiki"]]),
      invocation("run-4", "u-other", "gdrive", "search", 0, "2026-07-11T12:10:00Z"),
    ];
    const text = renderPromotionReportText(
      aggregatePromotionReport({
        records,
        sources: fixtureSources(),
        accessorUserId: "auditor-1",
        now: FIXED_NOW,
      }),
    );

    expect(text).toContain(
      "## 警告: userId が AnswerRun と一致しない ToolInvocation(集計から除外)",
    );
    expect(text).toContain("ToolInvocation を 7 件(2 run)");
    expect(text).toContain("docs/audit-queries.md §0");
    expect(text).toContain("  run=run-3  除外=6件\n  run=run-4  除外=1件\n");
    expect(text).not.toContain("u-other");
    expect(text.indexOf("## 警告")).toBeLessThan(text.indexOf("## ソース別未解決率"));
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

  it("pending → 最終状態の更新は重複と別に添える(更新を重複と表示しない。issue #38)", () => {
    const records = fixtureRecords();
    const pendingRun4 = records.find(
      (r) => r.recordType === "answer_run" && r.runId === "run-4",
    ) as AuditRecord & { recordType: "answer_run" };
    const resolvedRun4: AuditRecord = {
      ...pendingRun4,
      finalOutcome: "resolved",
      endedAt: "2026-07-11T12:00:30Z",
    };
    const render = (input: AuditRecord[]) =>
      renderPromotionReportText(
        aggregatePromotionReport({
          records: input,
          sources: fixtureSources(),
          accessorUserId: "auditor-1",
          now: FIXED_NOW,
        }),
      );

    const updated = render([...records, resolvedRun4]);
    expect(updated).toContain(
      `入力レコード数: ${records.length + 1}(同じ記録の更新 1 件(AnswerRun の pending → 最終状態など)は後の状態で集計)`,
    );
    expect(updated).not.toMatch(/入力レコード数: [^\n]*重複/);

    const both = render([...records, resolvedRun4, resolvedRun4]);
    expect(both).toContain(
      `入力レコード数: ${records.length + 2}(重複 1 件を除いて集計。同じ記録の更新 1 件(AnswerRun の pending → 最終状態など)は後の状態で集計)`,
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
