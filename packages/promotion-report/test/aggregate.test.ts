import { describe, expect, it } from "vitest";
import {
  digestQuery,
  validateRecord,
  type AuditRecord,
  type RawQueryRecord,
} from "@kp/gateway";
import {
  aggregatePromotionReport,
  dedupeAuditRecords,
  dedupeAuditRecordsDetailed,
  generatePromotionReport,
  type PromotionReportInput,
} from "../src/aggregate.js";
import {
  answerRun,
  fixtureRecords,
  fixtureRawQueries,
  fixtureSources,
  FIXED_NOW,
  invocation,
  runInvocations,
} from "./fixture.js";

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
    expect(report.totalRuns).toBe(6);
    expect(report.resolvedRuns).toBe(2);
    expect(report.unresolvedRuns).toBe(3);
    expect(report.undecidedRuns).toBe(1);
    expect(report.userMismatchWarnings).toEqual([]);

    // eligible(share降順)→ 適用外 → Slack対象外 → 未分類 の順。
    // runs は describe 以外の呼び出しがあった run(全 run の冒頭の describe は数えない)。
    // invocations は describe(6 run × 1件)を含む全呼び出し数
    expect(report.sourceStats).toEqual([
      {
        sourceId: "wiki",
        eligibility: "eligible",
        // run-1, run-3(unresolved)と run-6(list → fetch、resolved)
        runs: 3,
        unresolvedRuns: 2,
        unresolvedRate: 2 / 3,
        shareOfUnresolved: 2 / 3,
        invocations: 6 + 5,
      },
      {
        sourceId: "gdrive",
        eligibility: "eligible",
        runs: 2,
        unresolvedRuns: 1,
        unresolvedRate: 0.5,
        shareOfUnresolved: 1 / 3,
        // run-4(pending)の呼び出しも invocations には数える
        invocations: 6 + 6,
      },
      {
        sourceId: "fileshare",
        eligibility: "exempt_index_required",
        runs: 1,
        unresolvedRuns: 1,
        unresolvedRate: 1,
        shareOfUnresolved: 1 / 3,
        invocations: 6 + 1,
      },
      {
        sourceId: "slack",
        eligibility: "excluded_slack",
        runs: 1,
        unresolvedRuns: 1,
        unresolvedRate: 1,
        shareOfUnresolved: 1 / 3,
        invocations: 6 + 1,
      },
      {
        sourceId: "legacy",
        eligibility: "unclassified",
        runs: 1,
        unresolvedRuns: 0,
        unresolvedRate: 0,
        shareOfUnresolved: 0,
        invocations: 6 + 1,
      },
    ]);

    // 再検索回数分布(run 内の search 件数): run-6=0回(検索なし), run-2=1回, run-5=1回,
    // run-3=2回, run-1=3回(run-4はpendingのため入れない)。max(iteration)+1 で数えると
    // describe 5件と fetch の分が混ざり run-1 は 9回になる
    expect(report.searchCountDistribution).toEqual([
      { searchCount: 0, runs: 1, unresolvedRuns: 0 },
      { searchCount: 1, runs: 2, unresolvedRuns: 1 },
      { searchCount: 2, runs: 1, unresolvedRuns: 1 },
      { searchCount: 3, runs: 1, unresolvedRuns: 1 },
    ]);
    // 結果確定済みrunは全件いずれかの区分に入る
    expect(
      report.searchCountDistribution.reduce((sum, b) => sum + b.runs, 0),
    ).toBe(report.resolvedRuns + report.unresolvedRuns);
  });

  it("再検索回数は run 内の search の件数で数え、describe / fetch / list と iteration の採番に影響されない", () => {
    // T-007 の実際の並び(orchestrator の run-id.test.ts と同じ): 全ソースへ describe →
    // 同一ターンで search を2ソースへ並列(個別に採番)→ fetch と list
    const records: AuditRecord[] = [
      answerRun(
        "run-a",
        "alice",
        "2026-07-10T10:00:00Z",
        "resolved",
        ["alpha", "beta"],
        digestQuery("経費精算の締め日は?"),
      ),
      invocation("run-a", "alice", "alpha", "describe", 0, "2026-07-10T10:00:01Z"),
      invocation("run-a", "alice", "beta", "describe", 1, "2026-07-10T10:00:01Z"),
      invocation("run-a", "alice", "alpha", "search", 2, "2026-07-10T10:00:02Z"),
      invocation("run-a", "alice", "beta", "search", 3, "2026-07-10T10:00:02Z"),
      invocation("run-a", "alice", "alpha", "fetch", 4, "2026-07-10T10:00:03Z"),
      invocation("run-a", "alice", "beta", "list", 5, "2026-07-10T10:00:03Z"),
    ];
    const report = aggregatePromotionReport({ ...baseInput(), records });
    // max(iteration)+1 なら 4回(describe 2件を含む)になる
    expect(report.searchCountDistribution).toEqual([
      { searchCount: 2, runs: 1, unresolvedRuns: 0 },
    ]);

    // 記録の順(iteration の順)に依存しない
    const reversed = aggregatePromotionReport({
      ...baseInput(),
      records: [...records].reverse(),
    });
    expect(reversed.searchCountDistribution).toEqual(report.searchCountDistribution);
  });

  it("再検索回数は重複行(at-least-once の再送)を除いて数える", () => {
    const startedAt = "2026-07-10T10:00:00Z";
    // describe の後に search 1回だけの run。その search の行(同じ requestId)が3回書かれた
    const search = invocation("run-d", "u1", "gdrive", "search", 5, "2026-07-10T10:00:06Z");
    const records: AuditRecord[] = [
      answerRun("run-d", "u1", startedAt, "unresolved", ["gdrive"], digestQuery("q")),
      ...runInvocations("run-d", "u1", startedAt, []),
      search,
      search,
      search,
    ];
    const report = aggregatePromotionReport({ ...baseInput(), records });

    expect(report.duplicateRecordCount).toBe(2);
    expect(report.searchCountDistribution).toEqual([
      { searchCount: 1, runs: 1, unresolvedRuns: 1 },
    ]);
    const gdrive = report.sourceStats.find((s) => s.sourceId === "gdrive");
    expect(gdrive?.invocations).toBe(2); // describe 1 + search 1
  });

  it("(runId, userId) で結合し、userId が AnswerRun と一致しない ToolInvocation は集計から除外して runId と件数だけを警告に出す", () => {
    const baseline = aggregatePromotionReport(baseInput());
    expect(baseline.userMismatchWarnings).toEqual([]);

    // 別の利用者(u-other)が run-3(u2、unresolved)と run-4(u1、pending)の runId を
    // 申告した呼び出し。run-3 では run が使っていないソース(legacy)も呼んでいる
    const foreign: AuditRecord[] = [
      ...runInvocations("run-3", "u-other", "2026-07-11T09:40:00Z", [
        ["search", "wiki"],
        ["search", "legacy"],
        ["fetch", "gdrive"],
      ]),
      invocation("run-4", "u-other", "gdrive", "search", 0, "2026-07-11T12:10:00Z"),
    ];
    // at-least-once の重複行も含む
    const records = [...fixtureRecords(), ...foreign, ...foreign];
    const report = aggregatePromotionReport({ ...baseInput(), records });

    // ソース別(run 数・呼び出し数)と再検索回数分布は、不一致の呼び出しがないときと同じ
    expect(report.sourceStats).toEqual(baseline.sourceStats);
    expect(report.searchCountDistribution).toEqual(baseline.searchCountDistribution);
    expect(report.totalRuns).toBe(baseline.totalRuns);

    // 警告は runId と件数(重複行を除く)だけ。未確定(pending)の run の不一致も出す
    expect(report.userMismatchWarnings).toEqual([
      { runId: "run-3", invocations: 5 + 3 },
      { runId: "run-4", invocations: 1 },
    ]);
    for (const warning of report.userMismatchWarnings) {
      expect(Object.keys(warning).sort()).toEqual(["invocations", "runId"]);
    }
    // 不一致の利用者の userId はレポートのどこにも出ない
    expect(JSON.stringify(report)).not.toContain("u-other");
  });

  it("AnswerRun のない runId の呼び出し(runId 未申告の単発呼び出し等)は不一致ではなく、呼び出し数にだけ数える", () => {
    const baseline = aggregatePromotionReport(baseInput());
    const single = invocation("single-1", "u3", "gdrive", "search", 0, "2026-07-11T19:00:00Z");
    const report = aggregatePromotionReport({
      ...baseInput(),
      records: [...fixtureRecords(), single],
    });

    expect(report.userMismatchWarnings).toEqual([]);
    expect(report.searchCountDistribution).toEqual(baseline.searchCountDistribution);
    const gdrive = report.sourceStats.find((s) => s.sourceId === "gdrive");
    const baselineGdrive = baseline.sourceStats.find((s) => s.sourceId === "gdrive");
    expect(gdrive).toEqual({
      ...baselineGdrive,
      invocations: (baselineGdrive?.invocations ?? 0) + 1,
    });
  });

  it("ソース別の run 数に describe を数えない(run の冒頭の全ソースへの describe で全ソースが全 run に現れない)", () => {
    const startedAt = "2026-07-10T10:00:00Z";
    const records: AuditRecord[] = [
      answerRun("run-x", "u1", startedAt, "unresolved", ["gdrive"], digestQuery("q")),
      ...runInvocations("run-x", "u1", startedAt, [["search", "gdrive"]]),
    ];
    const report = aggregatePromotionReport({ ...baseInput(), records });
    const bySource = new Map(report.sourceStats.map((s) => [s.sourceId, s]));

    expect(bySource.get("gdrive")).toMatchObject({
      runs: 1,
      unresolvedRuns: 1,
      invocations: 2,
    });
    // describe だけのソースは run に数えない(呼び出し数には数える)
    for (const sourceId of ["wiki", "slack", "fileshare", "legacy"]) {
      expect(bySource.get(sourceId)).toMatchObject({
        runs: 0,
        unresolvedRuns: 0,
        unresolvedRate: null,
        invocations: 1,
      });
    }
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
    expect(withMeta.searchCountDistribution).toEqual(
      withoutMeta.searchCountDistribution,
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

  it("JSONL の重複行(at-least-once の再送)を冪等キーで除いて集計する(二重計上しない)", () => {
    const baseline = aggregatePromotionReport(baseInput());
    const records = fixtureRecords();
    // 全レコードの再送に加え、途中のバッチ(先頭5件)がもう一度書かれた状況
    const duplicated = [...records, ...records.slice(0, 5), ...records];
    const report = aggregatePromotionReport({ ...baseInput(), records: duplicated });

    expect(report.inputRecordCount).toBe(duplicated.length);
    expect(report.duplicateRecordCount).toBe(duplicated.length - records.length);
    expect(report.totalRuns).toBe(baseline.totalRuns);
    expect(report.resolvedRuns).toBe(baseline.resolvedRuns);
    expect(report.unresolvedRuns).toBe(baseline.unresolvedRuns);
    expect(report.undecidedRuns).toBe(baseline.undecidedRuns);
    // invocations(ツール呼び出し数)と再検索回数(search の件数)を含めて重複のない場合と一致する
    expect(report.sourceStats).toEqual(baseline.sourceStats);
    expect(report.searchCountDistribution).toEqual(baseline.searchCountDistribution);
    expect(report.failedQueries).toEqual(baseline.failedQueries);
    expect(report.userMismatchWarnings).toEqual([]);
    expect(baseline.duplicateRecordCount).toBe(0);
  });

  it("同じ冪等キーのレコードは後のものを採る(answer_run の runId、audit_access の accessId)", () => {
    const records = fixtureRecords();
    const pendingRun4 = records.find(
      (r) => r.recordType === "answer_run" && r.runId === "run-4",
    );
    expect(pendingRun4?.recordType).toBe("answer_run");
    // run-4 は pending の後に resolved として書き直された
    const resolvedRun4 = {
      ...(pendingRun4 as AuditRecord & { recordType: "answer_run" }),
      finalOutcome: "resolved" as const,
      endedAt: "2026-07-11T12:00:30Z",
    };
    const access = records.find((r) => r.recordType === "audit_access");
    const deduped = dedupeAuditRecords([...records, resolvedRun4, access as AuditRecord]);
    expect(deduped).toHaveLength(records.length);
    expect(deduped).toContainEqual(resolvedRun4);

    const report = aggregatePromotionReport({
      ...baseInput(),
      records: [...records, resolvedRun4],
    });
    expect(report.totalRuns).toBe(6);
    expect(report.resolvedRuns).toBe(3);
    expect(report.undecidedRuns).toBe(0);
    // pending → resolved の書き直しは重複ではなく更新(issue #38)
    expect(report.duplicateRecordCount).toBe(0);
    expect(report.updatedRecordCount).toBe(1);
  });

  it("pending → 最終状態 → フィードバックは更新として数え(重複にしない)、集計は最終状態を使う(issue #38)", () => {
    const startedAt = "2026-07-10T10:00:00Z";
    const pending = answerRun("run-u", "u1", startedAt, "pending", [], digestQuery("q"));
    const final = answerRun("run-u", "u1", startedAt, "unresolved", ["gdrive"], digestQuery("q"));
    const feedback = { ...(final as AuditRecord & { recordType: "answer_run" }), userFeedback: "unresolved" as const };

    const report = aggregatePromotionReport({
      ...baseInput(),
      records: [pending, pending, final, feedback, feedback],
    });

    expect(report.inputRecordCount).toBe(5);
    expect(report.duplicateRecordCount).toBe(2); // 同じ内容の再送(pending と feedback の2回目)
    expect(report.updatedRecordCount).toBe(2); // pending → 最終状態、最終状態 → フィードバック
    expect(report.totalRuns).toBe(1);
    expect(report.unresolvedRuns).toBe(1);
    expect(report.undecidedRuns).toBe(0);
  });

  it("ファイルの順序が前後して pending が最終状態の後に来ても、最終状態で集計する", () => {
    const startedAt = "2026-07-10T10:00:00Z";
    const pending = answerRun("run-r", "u1", startedAt, "pending", [], digestQuery("q"));
    const final = answerRun("run-r", "u1", startedAt, "resolved", ["gdrive"], digestQuery("q"));

    const deduped = dedupeAuditRecordsDetailed([final, pending]);
    expect(deduped.records).toEqual([final]);
    expect(deduped).toMatchObject({ duplicates: 0, updates: 1 });

    const report = aggregatePromotionReport({ ...baseInput(), records: [final, pending, pending] });
    expect(report.resolvedRuns).toBe(1);
    expect(report.undecidedRuns).toBe(0);
    expect(report).toMatchObject({ duplicateRecordCount: 1, updatedRecordCount: 1 });
  });

  it("重複の判定はキーの順序に依らない(同じ内容を別の順序で書いた行も重複)", () => {
    const record = fixtureRecords()[0] as AuditRecord;
    const reordered = Object.fromEntries(Object.entries(record).reverse()) as AuditRecord;
    expect(dedupeAuditRecordsDetailed([record, reordered])).toMatchObject({
      duplicates: 1,
      updates: 0,
    });
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
