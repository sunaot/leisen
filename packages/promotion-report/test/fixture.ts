/**
 * 合成監査ログ(2層モデル)のテストフィクスチャ(T-014)。
 *
 * run構成:
 * - run-1 (u1) unresolved: gdrive+wiki、search3反復。rawQuery原文あり(保持期間内)
 * - run-2 (u1) resolved:   gdrive+legacy(未分類ソース)、search1反復
 * - run-3 (u2) unresolved: wiki+slack、search2反復。rawQuery原文なし(保持期間切れ)
 * - run-4 (u1) pending:    gdriveへの呼び出しのみ。率の分母に入れない
 * - run-5 (u2) unresolved: fileshare(nativeSearch:none)、finalQueryDigestなし
 */
import {
  digestQuery,
  type AuditRecord,
  type RawQueryRecord,
} from "@kp/gateway";
import type { SourcesMeta } from "../src/index.js";

export const FIXED_NOW = new Date("2026-07-12T09:00:00.000Z");

function answerRun(
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

function invocation(
  runId: string,
  userId: string,
  sourceId: string,
  tool: "search" | "fetch",
  iteration: number,
  timestamp: string,
): AuditRecord {
  return {
    recordType: "tool_invocation",
    requestId: `${runId}-${sourceId}-${tool}-${iteration}`,
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
    invocation("run-1", "u1", "gdrive", "search", 0, "2026-07-10T10:00:01Z"),
    invocation("run-1", "u1", "wiki", "search", 1, "2026-07-10T10:00:05Z"),
    invocation("run-1", "u1", "wiki", "search", 2, "2026-07-10T10:00:09Z"),
    invocation("run-1", "u1", "gdrive", "fetch", 2, "2026-07-10T10:00:12Z"),

    answerRun(
      "run-2",
      "u1",
      "2026-07-10T11:00:00Z",
      "resolved",
      ["gdrive", "legacy"],
      digestQuery("旅費規程"),
    ),
    invocation("run-2", "u1", "gdrive", "search", 0, "2026-07-10T11:00:01Z"),
    invocation("run-2", "u1", "legacy", "fetch", 0, "2026-07-10T11:00:03Z"),

    answerRun(
      "run-3",
      "u2",
      "2026-07-11T09:30:00Z",
      "unresolved",
      ["wiki", "slack"],
      digestQuery("退職手続きの流れ"),
      "not_found_in_sources",
    ),
    invocation("run-3", "u2", "wiki", "search", 0, "2026-07-11T09:30:01Z"),
    invocation("run-3", "u2", "slack", "search", 1, "2026-07-11T09:30:05Z"),

    answerRun(
      "run-4",
      "u1",
      "2026-07-11T12:00:00Z",
      "pending",
      ["gdrive"],
      null,
    ),
    invocation("run-4", "u1", "gdrive", "search", 0, "2026-07-11T12:00:01Z"),
    invocation("run-4", "u1", "gdrive", "search", 1, "2026-07-11T12:00:04Z"),
    invocation("run-4", "u1", "gdrive", "fetch", 1, "2026-07-11T12:00:06Z"),

    answerRun(
      "run-5",
      "u2",
      "2026-07-11T15:00:00Z",
      "unresolved",
      ["fileshare"],
      null,
      "source_unreachable",
    ),
    invocation("run-5", "u2", "fileshare", "search", 0, "2026-07-11T15:00:01Z"),

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
