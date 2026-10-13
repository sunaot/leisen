/**
 * Gateway・Orchestrator・昇格判定レポートを結線したゴールデンテスト(T-023 受け入れ条件、ADR-019)。
 *
 * 実 Gateway(JSONL の監査ストアと生クエリ表)に対して Orchestrator が run を実行し、利用者が
 * フィードバックし、別の run を開始したまま終わらせず、Gateway を再起動して finish を再送したあと、
 * 昇格判定レポート(leisen-promotion-report)で Gateway の audit.jsonl を 1 つ読んで集計する:
 * - run が集計される(run > 0)、失敗クエリに質問原文が表示される
 * - フィードバックが Gateway の再起動と finish の再送のあとも残る(部分レコードは消えない)
 * - finish のない期限切れの run が「放棄」と数えられる
 * 秘密情報の実値は使わない(不変条件6)。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BufferedAuditSink,
  JsonlAuditStore,
  JsonlRawQueryStore,
  parseAuditRecord,
  type AuditRecord,
} from "@leisen/audit";
import { mergeAnswerRunRecords, runCli } from "@leisen/promotion-report";
import { Orchestrator, ScriptedLlmClient, scriptedSubmit, scriptedToolUse } from "../src/index.js";
import {
  ALICE_TOKEN,
  CorpusConnector,
  EXPENSE_POLICY,
  startGateway,
  type GatewayHarness,
  type GatewayHarnessOptions,
} from "./helpers/harness.js";

const QUESTION = "有給休暇の繰越は何日までですか?";
const ABANDONED_QUESTION = "終了を申告しない run の質問";
/** Gateway と Orchestrator の時計: 実時刻の 1 時間前に固定する(レポート時点で runId の有効期間 600 秒が過ぎている) */
const T0 = Date.now() - 60 * 60 * 1000;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function jsonlGateway(dir: string, nowMs: number): Promise<GatewayHarness> {
  const options: GatewayHarnessOptions = {
    connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])],
    // 監査ストアと生クエリ表を JSONL にする(リファレンス構成の audit.sink: jsonl と同じ部品)
    wrapSink: () =>
      new BufferedAuditSink(new JsonlAuditStore(join(dir, "audit.jsonl")), { retryBaseDelayMs: 1 }),
    rawQueryStore: new JsonlRawQueryStore(join(dir, "raw-queries.jsonl")),
    now: () => nowMs,
  };
  const harness = await startGateway(options);
  cleanups.push(() => harness.close());
  return harness;
}

async function readAudit(dir: string): Promise<AuditRecord[]> {
  return (await readFile(join(dir, "audit.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => parseAuditRecord(JSON.parse(line)));
}

describe("Gateway + Orchestrator + 昇格判定レポート(ゴールデン)", () => {
  it("run が集計され、質問原文が表示され、フィードバックが再起動後も残り、finish のない期限切れの run が放棄と数えられる", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t023-golden-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    // --- 1. 最初の Gateway プロセス: 未解決で終わる run と、フィードバック、終わらない run ---
    const first = await jsonlGateway(dir, T0);
    const llm = new ScriptedLlmClient([
      () => scriptedToolUse([{ name: "search", input: { source: "alpha", query: "有給 繰越" } }]),
      // 出典なしの提出 → unresolved
      () => scriptedSubmit({ answer: "該当する文書が見つかりませんでした。", citations: [], confidence: 0.1 }),
    ]);
    const answer = await new Orchestrator({ llm, now: () => T0 }).run({
      question: QUESTION,
      gateway: first.client(ALICE_TOKEN),
    });
    expect(answer.outcome).toBe("unresolved");
    await first.client(ALICE_TOKEN).feedbackRun(answer.runId, "unresolved");
    const abandoned = await first.client(ALICE_TOKEN).startRun({ question: ABANDONED_QUESTION });
    expect(abandoned.runId).not.toBe(answer.runId);
    await first.auditLogger.flush();
    await first.close();
    cleanups.pop();

    // --- 2. 再起動(同じファイル・同じ署名鍵): 期限内の finish の再送を受ける ---
    const second = await jsonlGateway(dir, T0 + 60_000);
    await second.client(ALICE_TOKEN).finishRun(answer.runId, {
      outcome: "unresolved",
      confidence: 0.1,
      searchedSources: ["alpha"],
      citations: [],
      failureReason: "no_verified_citations",
    });
    await second.auditLogger.flush();
    await second.close();
    cleanups.pop();

    // --- 3. レポート(監査ストアは Gateway の audit.jsonl だけ) ---
    const records = await readAudit(dir);
    expect(records.map((r) => r.recordType)).toEqual(
      expect.arrayContaining(["answer_run", "tool_invocation", "answer_run_finish", "answer_run_feedback"]),
    );
    // 統合: finish を再送しても feedback は残る
    const merged = mergeAnswerRunRecords(records).runs;
    expect(merged).toHaveLength(2);
    expect(merged.find((r) => r.runId === answer.runId)).toMatchObject({
      userId: "alice",
      finalOutcome: "unresolved",
      userFeedback: "unresolved",
      searchedSources: ["alpha"],
    });
    expect(merged.find((r) => r.runId === abandoned.runId)).toMatchObject({
      finalOutcome: "pending",
      userFeedback: null,
    });

    const sourcesPath = join(dir, "sources.json");
    await writeFile(sourcesPath, JSON.stringify({ alpha: { nativeSearch: "full", slack: false } }));
    const metaPath = join(dir, "meta-audit.jsonl");
    const args = [
      "--audit", join(dir, "audit.jsonl"),
      "--raw-queries", join(dir, "raw-queries.jsonl"),
      "--sources", sourcesPath,
      "--accessor", "auditor-1",
      "--meta-audit-out", metaPath,
    ];
    const json: string[] = [];
    const errors: string[] = [];
    expect(
      await runCli([...args, "--format", "json"], { stdout: (l) => json.push(l), stderr: (l) => errors.push(l) }),
    ).toBe(0);
    expect(errors).toEqual([]);
    const body = JSON.parse(json.join("\n")) as Record<string, unknown>;
    expect(body).toMatchObject({
      totalRuns: 2,
      resolvedRuns: 0,
      unresolvedRuns: 1,
      undecidedRuns: 1,
      abandonedRuns: 1,
      orphanPartialRecordCount: 0,
      userMismatchPartialRecordCount: 0,
      duplicateRecordCount: 0,
      // 再送した finish は更新として数える(重複ではない)
      updatedRecordCount: 1,
      userMismatchWarnings: [],
    });
    expect(body["failedQueries"]).toEqual([
      expect.objectContaining({ runId: answer.runId, status: "available", rawQuery: QUESTION, searchedSources: ["alpha"] }),
    ]);
    expect(body["sourceStats"]).toEqual([
      expect.objectContaining({ sourceId: "alpha", runs: 1, unresolvedRuns: 1, eligibility: "eligible" }),
    ]);

    const text: string[] = [];
    expect(await runCli(args, { stdout: (l) => text.push(l), stderr: (l) => errors.push(l) })).toBe(0);
    const rendered = text.join("\n");
    expect(rendered).toContain("run数: 2(resolved=0 unresolved=1 未確定=1 放棄=1)");
    expect(rendered).toContain(JSON.stringify(QUESTION));
    // 放棄した run の質問は失敗クエリ(未解決)ではないので原文は出ない
    expect(rendered).not.toContain(ABANDONED_QUESTION);
    // レポートの実行はメタ監査に残る(audit_log と raw_query)
    const meta = (await readFile(metaPath, "utf8")).trim().split("\n").map((l) => parseAuditRecord(JSON.parse(l)));
    expect(meta.map((r) => r.recordType === "audit_access" && r.target)).toEqual([
      "audit_log", "raw_query", "audit_log", "raw_query",
    ]);
  });
});
