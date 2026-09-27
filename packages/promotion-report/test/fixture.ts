/**
 * 合成監査ログ(2層モデル)のテストフィクスチャ(T-014)。
 *
 * ToolInvocation は T-007 の Orchestrator が Gateway に書かせる実際の形に合わせる
 * (ADR-011 追記、ADR-017 決定2): iteration は run 内のツール呼び出しの通番(0 始まり)。
 * run の冒頭で全ソースに describe(iteration 0〜4、DEPLOYMENT_SOURCES の順)、続いて
 * LLM のツール呼び出し(search / fetch / list。同一ターン内の並列呼び出しも応答内の順に
 * 個別に採番)。
 *
 * run構成(describe の後の呼び出し):
 * - run-1 (u1) unresolved: gdrive+wiki。search 3回(gdrive と wiki を並列 → gdrive を fetch →
 *   wiki を再検索)。rawQuery原文あり(保持期間内)
 * - run-2 (u1) resolved:   gdrive+legacy(未分類ソース)。search 1回 → legacy を fetch
 * - run-3 (u2) unresolved: wiki+slack。search 2回。rawQuery原文なし(保持期間切れ)
 * - run-4 (u1) pending:    gdrive の search 2回 + fetch。率の分母に入れない
 * - run-5 (u2) unresolved: fileshare(nativeSearch:none)の search 1回。finalQueryDigestなし
 * - run-6 (u2) resolved:   wiki を list → fetch。search 0回(検索なし)
 */
import {
  digestQuery,
  type AuditRecord,
  type RawQueryRecord,
} from "@kp/gateway";
import type { SourcesMeta } from "../src/index.js";

export const FIXED_NOW = new Date("2026-07-12T09:00:00.000Z");

/** 導入先のソース(Gateway の search ツールの source の列挙)。describe はこの順に呼ばれる */
export const DEPLOYMENT_SOURCES = [
  "gdrive",
  "wiki",
  "slack",
  "fileshare",
  "legacy",
] as const;

type Tool = "search" | "fetch" | "list" | "describe";

export function answerRun(
  runId: string,
  userId: string,
  startedAt: string,
  finalOutcome: "resolved" | "unresolved" | "pending",
  searchedSources: string[],
  finalQueryDigest: string | null,
  failureReason: string | null = null,
): AuditRecord {
  return {
    recordType: "answer_run",
    runId,
    userId,
    actor: { kind: "human" },
    startedAt,
    endedAt: finalOutcome === "pending" ? null : startedAt,
    finalQueryDigest,
    finalOutcome,
    confidence: null,
    userFeedback: null,
    searchedSources,
    citedDocIds: [],
    failureReason,
  };
}

/**
 * ToolInvocation 1件。requestId(冪等キー)は Gateway が呼び出しごとに採番する値の代わりに
 * (runId, userId, iteration) から作る(同じ runId を別の利用者が申告した呼び出しとも衝突しない)。
 */
export function invocation(
  runId: string,
  userId: string,
  sourceId: string,
  tool: Tool,
  iteration: number,
  timestamp: string,
): AuditRecord {
  return {
    recordType: "tool_invocation",
    requestId: `req:${runId}:${userId}:${iteration}`,
    runId,
    iteration,
    userId,
    timestamp,
    sourceId,
    tool,
    queryDigest: tool === "search" ? digestQuery(`q-${runId}-${iteration}`) : null,
    filtersDigest: null,
    returnedHitCount: tool === "search" ? 3 : null,
    fetchedDocCount: tool === "fetch" ? 1 : 0,
    latencyMs: 120,
    errorClass: null,
    retryCount: 0,
  };
}

/** describe の後に LLM が呼ぶツール(応答内の順)。 */
export type LlmCall = readonly [tool: Exclude<Tool, "describe">, sourceId: string];

/**
 * T-007 の Orchestrator が1 run で Gateway に送る呼び出しの ToolInvocation を作る:
 * 全ソースへの describe(iteration 0〜)→ LLM のツール呼び出し。iteration は通し番号。
 */
export function runInvocations(
  runId: string,
  userId: string,
  startedAt: string,
  llmCalls: readonly LlmCall[],
): AuditRecord[] {
  const calls: (readonly [Tool, string])[] = [
    ...DEPLOYMENT_SOURCES.map((sourceId) => ["describe", sourceId] as const),
    ...llmCalls,
  ];
  const startedMs = Date.parse(startedAt);
  return calls.map(([tool, sourceId], iteration) =>
    invocation(
      runId,
      userId,
      sourceId,
      tool,
      iteration,
      new Date(startedMs + (iteration + 1) * 1000).toISOString(),
    ),
  );
}

export function fixtureRecords(): AuditRecord[] {
  return [
    answerRun(
      "run-1",
      "u1",
      "2026-07-10T10:00:00Z",
      "unresolved",
      ["gdrive", "wiki"],
      digestQuery("経費精算の締め日はいつ?"),
      "not_found_in_sources",
    ),
    ...runInvocations("run-1", "u1", "2026-07-10T10:00:00Z", [
      // 同一ターンの並列呼び出し(iteration 5, 6)
      ["search", "gdrive"],
      ["search", "wiki"],
      ["fetch", "gdrive"],
      ["search", "wiki"],
    ]),

    answerRun(
      "run-2",
      "u1",
      "2026-07-10T11:00:00Z",
      "resolved",
      ["gdrive", "legacy"],
      digestQuery("旅費規程"),
    ),
    ...runInvocations("run-2", "u1", "2026-07-10T11:00:00Z", [
      ["search", "gdrive"],
      ["fetch", "legacy"],
    ]),

    answerRun(
      "run-3",
      "u2",
      "2026-07-11T09:30:00Z",
      "unresolved",
      ["wiki", "slack"],
      digestQuery("退職手続きの流れ"),
      "not_found_in_sources",
    ),
    ...runInvocations("run-3", "u2", "2026-07-11T09:30:00Z", [
      ["search", "wiki"],
      ["search", "slack"],
    ]),

    answerRun(
      "run-4",
      "u1",
      "2026-07-11T12:00:00Z",
      "pending",
      ["gdrive"],
      null,
    ),
    ...runInvocations("run-4", "u1", "2026-07-11T12:00:00Z", [
      ["search", "gdrive"],
      ["search", "gdrive"],
      ["fetch", "gdrive"],
    ]),

    answerRun(
      "run-5",
      "u2",
      "2026-07-11T15:00:00Z",
      "unresolved",
      ["fileshare"],
      null,
      "source_unreachable",
    ),
    ...runInvocations("run-5", "u2", "2026-07-11T15:00:00Z", [
      ["search", "fileshare"],
    ]),

    answerRun(
      "run-6",
      "u2",
      "2026-07-11T18:00:00Z",
      "resolved",
      ["wiki"],
      digestQuery("会議室の予約方法"),
    ),
    ...runInvocations("run-6", "u2", "2026-07-11T18:00:00Z", [
      ["list", "wiki"],
      ["fetch", "wiki"],
    ]),

    // メタ監査レコードはrun集計に影響してはならない
    {
      recordType: "audit_access",
      accessId: "access-1",
      accessorUserId: "auditor-1",
      timestamp: "2026-07-11T16:00:00Z",
      purpose: "violation_detection",
      target: "audit_log",
      scopeDescription: null,
    },
    {
      recordType: "retention_purge",
      purgeId: "purge-1",
      timestamp: "2026-07-11T17:00:00Z",
      target: "raw_query",
      retentionDays: 30,
      cutoff: "2026-06-11T17:00:00Z",
      deletedCount: 12,
    },
  ];
}

export function fixtureRawQueries(): RawQueryRecord[] {
  // run-1 の原文のみ保持期間内。run-3 の原文は期限切れで存在しない
  return [
    {
      queryDigest: digestQuery("経費精算の締め日はいつ?"),
      rawQuery: "経費精算の締め日はいつ?",
      userId: "u1",
      timestamp: "2026-07-10T10:00:00Z",
    },
  ];
}

export function fixtureSources(): SourcesMeta {
  return {
    gdrive: { nativeSearch: "full", slack: false },
    wiki: { nativeSearch: "degraded", slack: false },
    slack: { nativeSearch: "degraded", slack: true },
    fileshare: { nativeSearch: "none", slack: false },
    // legacy は意図的に未分類
  };
}
