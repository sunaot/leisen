import { describe, expect, it } from "vitest";
import {
  digestQuery,
  validateRecord,
  type AuditRecord,
  type RawQueryRecord,
} from "@kp/gateway";
import {
  aggregatePromotionReport,
  generatePromotionReport,
  type PromotionReportInput,
} from "../src/aggregate.js";
import { fixtureRecords, fixtureRawQueries, fixtureSources, FIXED_NOW } from "./fixture.js";

function baseInput(): PromotionReportInput {
  return {
    records: fixtureRecords(),
    sources: fixtureSources(),
    rawQueries: fixtureRawQueries(),
    accessorUserId: "auditor-1",
    now: FIXED_NOW,
  };
}

describe("aggregatePromotionReport(合成2層ログのゴールデンテスト)", () => {
  it("run集計・ソース別未解決率・分布・失敗クエリを期待値どおり返す", () => {
    const report = aggregatePromotionReport(baseInput());

    expect(report.generatedAt).toBe(FIXED_NOW.toISOString());
    expect(report.totalRuns).toBe(5);
    expect(report.resolvedRuns).toBe(1);
    expect(report.unresolvedRuns).toBe(3);
    expect(report.undecidedRuns).toBe(1);

    // eligible(share降順)→ 適用外 → Slack対象外 → 未分類 の順
    expect(report.sourceStats).toEqual([
      {
        sourceId: "wiki",
        eligibility: "eligible",
        runs: 2,
        unresolvedRuns: 2,
        unresolvedRate: 1,
        shareOfUnresolved: 2 / 3,
        invocations: 3,
      },
      {
        sourceId: "gdrive",
        eligibility: "eligible",
        runs: 2,
        unresolvedRuns: 1,
        unresolvedRate: 0.5,
        shareOfUnresolved: 1 / 3,
        // run-4(pending)の呼び出しも invocations には数える
        invocations: 6,
      },
      {
        sourceId: "fileshare",
        eligibility: "exempt_index_required",
        runs: 1,
        unresolvedRuns: 1,
        unresolvedRate: 1,
        shareOfUnresolved: 1 / 3,
        invocations: 1,
      },
      {
        sourceId: "slack",
        eligibility: "excluded_slack",
        runs: 1,
        unresolvedRuns: 1,
        unresolvedRate: 1,
        shareOfUnresolved: 1 / 3,
        invocations: 1,
      },
      {
        sourceId: "legacy",
        eligibility: "unclassified",
        runs: 1,
        unresolvedRuns: 0,
        unresolvedRate: 0,
        shareOfUnresolved: 0,
        invocations: 1,
      },
    ]);

    // 再検索回数分布: run-2=1回, run-5=1回, run-3=2回, run-1=3回
    // (run-4はpendingのため分母に入れない)
    expect(report.iterationDistribution).toEqual([
      { searchIterations: 1, runs: 2, unresolvedRuns: 1 },
      { searchIterations: 2, runs: 1, unresolvedRuns: 1 },
      { searchIterations: 3, runs: 1, unresolvedRuns: 1 },
    ]);
  });

  it("失敗クエリ: 保持期間内は原文、期間切れはdigestのみ+期限切れ、digest欠落も区別する", () => {
    const report = aggregatePromotionReport(baseInput());

    expect(report.failedQueries.map((f) => [f.runId, f.status])).toEqual([
      ["run-5", "no_digest"],
      ["run-3", "expired_or_missing"],
      ["run-1", "available"],
    ]);
    const available = report.failedQueries.find((f) => f.runId === "run-1");
    expect(available?.rawQuery).toBe("経費精算の締め日はいつ?");
    const expired = report.failedQueries.find((f) => f.runId === "run-3");
    expect(expired?.rawQuery).toBeNull();
    expect(expired?.finalQueryDigest).toBe(digestQuery("退職手続きの流れ"));
  });

  it("rawQueryの結合はdigestとuserIdの両方で行う(他ユーザーの同文クエリを表示しない)", () => {
    const input = baseInput();
    // run-1(u1)のdigestに一致するが別ユーザーのrawQueryのみ存在する状況
    const foreign: RawQueryRecord = {
      queryDigest: digestQuery("経費精算の締め日はいつ?"),
      rawQuery: "経費精算の締め日はいつ?",
      userId: "u-other",
      timestamp: "2026-07-10T00:00:00Z",
    };
    input.rawQueries = [foreign];
    const report = aggregatePromotionReport(input);
    const f = report.failedQueries.find((x) => x.runId === "run-1");
    expect(f?.status).toBe("expired_or_missing");
    expect(f?.rawQuery).toBeNull();
  });

  it("audit_access / retention_purge レコードはrun集計に影響しない", () => {
    const input = baseInput();
    const withoutMeta = aggregatePromotionReport({
      ...input,
      records: input.records.filter(
        (r) => r.recordType === "answer_run" || r.recordType === "tool_invocation",
      ),
    });
    const withMeta = aggregatePromotionReport(input);
    expect(withMeta.sourceStats).toEqual(withoutMeta.sourceStats);
    expect(withMeta.iterationDistribution).toEqual(
      withoutMeta.iterationDistribution,
    );
    expect(withMeta.failedQueries).toEqual(withoutMeta.failedQueries);
  });

  it("メタ監査: audit_logとraw_queryのaudit_accessレコードを生成し、スキーマ検証を通る", () => {
    const report = aggregatePromotionReport(baseInput());
    expect(report.metaAuditRecords).toHaveLength(2);
    for (const record of report.metaAuditRecords) {
      validateRecord(record);
      expect(record.recordType).toBe("audit_access");
      if (record.recordType === "audit_access") {
        expect(record.purpose).toBe("promotion_report");
        expect(record.accessorUserId).toBe("auditor-1");
      }
    }
    const targets = report.metaAuditRecords.map(
      (r) => r.recordType === "audit_access" && r.target,
    );
    expect(targets).toEqual(["audit_log", "raw_query"]);
  });

  it("rawQueries未指定ならraw_queryへのアクセス記録は生成しない", () => {
    const { rawQueries: _omit, ...rest } = baseInput();
    const report = aggregatePromotionReport(rest);
    expect(report.metaAuditRecords).toHaveLength(1);
    expect(
      report.metaAuditRecords[0]?.recordType === "audit_access" &&
        report.metaAuditRecords[0].target,
    ).toBe("audit_log");
    // rawQueryを見ていないので全件 期限切れ/未保持 扱い
    expect(
      report.failedQueries
        .filter((f) => f.finalQueryDigest !== null)
        .every((f) => f.status === "expired_or_missing"),
    ).toBe(true);
  });

  it("generatePromotionReport: メタ監査の書き込み成功前にレポートを返さない(fail-closed)", async () => {
    const written: unknown[] = [];
    const report = await generatePromotionReport(baseInput(), async (records) => {
      written.push(...records);
    });
    expect(written).toEqual(report.metaAuditRecords);

    await expect(
      generatePromotionReport(baseInput(), async () => {
        throw new Error("audit store unavailable");
      }),
    ).rejects.toThrow("audit store unavailable");
  });

  it("accessorUserId空はメタ監査が書けないため拒否する(ADR-013 §3)", () => {
    expect(() =>
      aggregatePromotionReport({ ...baseInput(), accessorUserId: "" }),
    ).toThrow(/accessorUserId/);
  });

  it("post-filtering前候補件数に相当するフィールドを出力に含めない(ADR-011/012)", () => {
    const report = aggregatePromotionReport(baseInput());
    const banned = new Set(["hitCount", "candidateCount", "preFilterCount", "totalCount"]);
    const scan = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(scan);
      if (value === null || typeof value !== "object") return;
      for (const [key, nested] of Object.entries(value)) {
        expect(banned.has(key), `forbidden key in report: ${key}`).toBe(false);
        scan(nested);
      }
    };
    scan(report);
  });
});
