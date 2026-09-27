/**
 * 受け入れ条件1: モックコネクタに対する再現可能なシナリオテスト
 * (1発ヒット / 再検索で到達 / 未解決 / 一部ソース未接続)。
 *
 * すべて ScriptedLlmClient(脚本)と実 Gateway(port 0、Streamable HTTP)で動かす。
 * ネットワークは 127.0.0.1 のみで、Claude API には出ない。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIDENCE_CAP_WITHOUT_CITATIONS,
  NO_CITATION_NOTICE,
  Orchestrator,
  ScriptedLlmClient,
  scriptedSubmit,
  scriptedToolUse,
} from "../src/index.js";
import {
  CorpusConnector,
  EXPENSE_POLICY,
  TRAVEL_GUIDE,
  startGateway,
  type GatewayHarness,
  type GatewayHarnessOptions,
} from "./helpers/harness.js";
import { fetchedDocuments, firstHit, searchHits } from "./helpers/script.js";

const harnesses: GatewayHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

async function setup(options: GatewayHarnessOptions): Promise<GatewayHarness> {
  const harness = await startGateway(options);
  harnesses.push(harness);
  return harness;
}

function sourceEnum(tool: Anthropic.Tool | undefined): unknown {
  const properties = tool?.input_schema.properties as
    | Record<string, { enum?: unknown }>
    | undefined;
  return properties?.["source"]?.enum;
}

describe("受け入れ条件1: 再現可能なシナリオ", () => {
  it("(a) 1発ヒット: search → fetch → submit_answer(出典付き)で resolved", async () => {
    const alpha = new CorpusConnector("alpha", [EXPENSE_POLICY]);
    const beta = new CorpusConnector("beta", [TRAVEL_GUIDE]);
    const harness = await setup({ connectors: [alpha, beta] });
    const llm = new ScriptedLlmClient([
      () =>
        scriptedToolUse([
          { name: "search", input: { source: "alpha", query: "経費精算 締め日" } },
        ]),
      (context) => {
        const hit = firstHit(context);
        return scriptedToolUse([
          { name: "fetch", input: { source: hit.source, documentId: hit.documentId } },
        ]);
      },
      (context) => {
        const document = fetchedDocuments(context)[0];
        expect(document).toBeDefined();
        return scriptedSubmit({
          answer: "経費精算の締め日は毎月25日です。",
          citations: [
            {
              documentId: document?.documentId,
              sourceId: document?.source,
              quote: "締め日は毎月25日",
            },
          ],
          confidence: 0.9,
        });
      },
    ]);
    const orchestrator = new Orchestrator({ llm, auditLogger: harness.auditLogger });

    const answer = await orchestrator.run({
      question: "経費精算の締め日はいつ?",
      userId: "alice",
      gateway: harness.client(),
    });

    expect(answer.outcome).toBe("resolved");
    expect(answer.answer).toBe("経費精算の締め日は毎月25日です。");
    expect(answer.citations).toEqual([
      {
        documentId: "doc-expense-policy",
        sourceId: "alpha",
        title: "経費精算規程",
        url: "https://alpha.example.test/docs/doc-expense-policy",
      },
    ]);
    expect(answer.searchedSources).toEqual(["alpha"]);
    expect(answer.skippedSources).toEqual([]);
    expect(answer.confidence).toBe(0.9);
    expect(answer.warnings).toEqual([]);
    // describe ×2(alpha, beta)+ search + fetch
    expect(answer.usage).toMatchObject({ llmTurns: 3, toolCalls: 4 });

    // コネクタは Gateway 経由で本人(alice)の資格情報で呼ばれている
    expect(alpha.calls.map((c) => c.tool)).toEqual(["describe", "search", "fetch"]);
    expect(alpha.calls.every((c) => c.userId === "alice")).toBe(true);
    expect(beta.calls.map((c) => c.tool)).toEqual(["describe"]);

    const runs = harness.answerRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId: answer.runId,
      userId: "alice",
      actor: { kind: "human" },
      finalOutcome: "resolved",
      confidence: 0.9,
      userFeedback: null,
      searchedSources: ["alpha"],
      citedDocIds: ["alpha:doc-expense-policy"],
      failureReason: null,
    });
    expect(runs[0]?.endedAt).not.toBeNull();
  });

  it("(b) 再検索で到達: 初回 search が0件 → 英日変換で再検索 → ヒット → resolved", async () => {
    const alpha = new CorpusConnector("alpha", [TRAVEL_GUIDE]);
    const harness = await setup({ connectors: [alpha] });
    const llm = new ScriptedLlmClient([
      () =>
        scriptedToolUse([
          { name: "search", input: { source: "alpha", query: "出張費の払い戻し期限" } },
        ]),
      (context) => {
        // 初回は0件(日本語の語が英語の文書に一致しない)
        expect(searchHits(context)).toEqual([]);
        return scriptedToolUse([
          {
            name: "search",
            input: { source: "alpha", query: "expense reimbursement deadline" },
          },
        ]);
      },
      (context) => {
        const hit = firstHit(context);
        return scriptedSubmit({
          answer: "出張経費の精算は30日以内に申請します。",
          citations: [{ documentId: hit.documentId, sourceId: hit.source }],
          confidence: 0.8,
        });
      },
    ]);
    const orchestrator = new Orchestrator({ llm, auditLogger: harness.auditLogger });

    const answer = await orchestrator.run({
      question: "出張費の払い戻しの期限は?",
      userId: "alice",
      gateway: harness.client(),
    });

    expect(answer.outcome).toBe("resolved");
    expect(answer.citations.map((c) => c.documentId)).toEqual(["doc-travel-guide"]);
    expect(answer.searchedSources).toEqual(["alpha"]);
    expect(alpha.calls.filter((c) => c.tool === "search").map((c) => c.target)).toEqual([
      "出張費の払い戻し期限",
      "expense reimbursement deadline",
    ]);
    // Gateway の監査: 2回の search が同じ run に束ねられ、返却件数は 0 → 1
    const searches = harness
      .toolInvocations(answer.runId)
      .filter((r) => r.tool === "search")
      .sort((a, b) => a.iteration - b.iteration);
    expect(searches.map((r) => r.returnedHitCount)).toEqual([0, 1]);
  });

  it("(c) 未解決: 何も見つからず citation なしで提出 → unresolved、注意書き、confidence ≤ 0.3", async () => {
    const alpha = new CorpusConnector("alpha", [EXPENSE_POLICY]);
    const beta = new CorpusConnector("beta", [TRAVEL_GUIDE]);
    const harness = await setup({ connectors: [alpha, beta] });
    const llm = new ScriptedLlmClient([
      () =>
        scriptedToolUse([
          { name: "search", input: { source: "alpha", query: "来期の組織変更" } },
          { name: "search", input: { source: "beta", query: "来期の組織変更" } },
        ]),
      (context) => {
        expect(searchHits(context)).toEqual([]);
        expect(context.lastToolResults).toHaveLength(2);
        return scriptedToolUse([
          { name: "search", input: { source: "beta", query: "reorganization" } },
        ]);
      },
      () =>
        scriptedSubmit({
          answer:
            "来期の組織変更について書かれた文書は見つかりませんでした。alpha と beta を日本語と英語で検索しました。",
          citations: [],
          confidence: 0.7,
          unresolvedReason: "該当する文書が見つからなかった",
        }),
    ]);
    const orchestrator = new Orchestrator({ llm, auditLogger: harness.auditLogger });

    const answer = await orchestrator.run({
      question: "来期の組織変更は決まっている?",
      userId: "alice",
      gateway: harness.client(),
    });

    expect(answer.outcome).toBe("unresolved");
    expect(answer.answer.startsWith(NO_CITATION_NOTICE)).toBe(true);
    expect(answer.answer).toContain("未解決の理由: 該当する文書が見つからなかった");
    expect(answer.citations).toEqual([]);
    expect(answer.confidence).toBeLessThanOrEqual(CONFIDENCE_CAP_WITHOUT_CITATIONS);
    expect(answer.searchedSources).toEqual(["alpha", "beta"]);
    expect(harness.answerRuns()[0]).toMatchObject({
      finalOutcome: "unresolved",
      confidence: CONFIDENCE_CAP_WITHOUT_CITATIONS,
      citedDocIds: [],
      failureReason: "no_citations",
    });
  });

  it("(d) 一部ソース未接続: beta は skippedSources に入り、search は alpha のみ、回答に未接続の旨", async () => {
    const alpha = new CorpusConnector("alpha", [EXPENSE_POLICY]);
    const beta = new CorpusConnector("beta", [TRAVEL_GUIDE]);
    const harness = await setup({ connectors: [alpha, beta], notConnected: ["beta"] });
    const llm = new ScriptedLlmClient([
      (context) => {
        // 未接続の beta はツール定義の source enum・ソース一覧から外れている
        for (const name of ["search", "fetch", "list", "describe"]) {
          expect(sourceEnum(context.request.tools.find((t) => t.name === name))).toEqual([
            "alpha",
          ]);
        }
        const runContext = context.request.system[1]?.text ?? "";
        expect(runContext).toContain("未接続のため検索できない: beta");
        expect(runContext).not.toContain('"sourceId":"beta"');
        // (強制されないモデルを想定して)beta も並行に要求しても Gateway には送られない
        return scriptedToolUse([
          { name: "search", input: { source: "alpha", query: "経費精算" } },
          { name: "search", input: { source: "beta", query: "経費精算" } },
        ]);
      },
      (context) => {
        const rejected = context.lastToolResults.find(
          (r) => (r.toolInput as { source?: string }).source === "beta",
        );
        expect(rejected).toMatchObject({ isError: true, json: { errorClass: "unknown_source" } });
        const hit = firstHit(context);
        return scriptedSubmit({
          answer: "経費精算の締め日は毎月25日です。",
          citations: [{ documentId: hit.documentId, sourceId: "alpha" }],
          confidence: 0.85,
        });
      },
    ]);
    const orchestrator = new Orchestrator({ llm, auditLogger: harness.auditLogger });

    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      userId: "alice",
      gateway: harness.client(),
    });

    expect(answer.outcome).toBe("resolved");
    expect(answer.skippedSources).toEqual([
      { sourceId: "beta", reason: "source_not_connected" },
    ]);
    expect(answer.searchedSources).toEqual(["alpha"]);
    expect(answer.answer).toContain("未接続のため検索していないソース: beta");
    // beta のコネクタには一度も到達していない(資格情報の取得で止まる)
    expect(beta.calls).toEqual([]);

    const records = harness.toolInvocations(answer.runId);
    expect(records.filter((r) => r.sourceId === "beta")).toEqual([
      expect.objectContaining({ tool: "describe", errorClass: "source_not_connected" }),
    ]);
    expect(records.filter((r) => r.tool === "search").map((r) => r.sourceId)).toEqual([
      "alpha",
    ]);
  });

  it("全ソースが未接続なら LLM を呼ばずに unresolved(接続の案内付き)で終える", async () => {
    const alpha = new CorpusConnector("alpha", [EXPENSE_POLICY]);
    const harness = await setup({ connectors: [alpha], notConnected: ["alpha"] });
    const llm = new ScriptedLlmClient([]);
    const orchestrator = new Orchestrator({ llm, auditLogger: harness.auditLogger });

    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      userId: "alice",
      gateway: harness.client(),
    });

    expect(llm.requests).toHaveLength(0);
    expect(answer.outcome).toBe("unresolved");
    expect(answer.skippedSources).toEqual([
      { sourceId: "alpha", reason: "source_not_connected" },
    ]);
    expect(answer.answer).toContain("未接続のため検索していないソース: alpha");
    expect(harness.answerRuns()[0]?.failureReason).toBe("no_searchable_sources");
  });
});
