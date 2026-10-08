/**
 * e2e(Anthropic 経路): 実 Gateway(port 0、モック IdP、コーパス型コネクタ)+ 実 LLM
 * クライアント(AnthropicLlmClient と公式 SDK)+ モック Anthropic Messages API サーバー。
 *
 * SDK は `new Anthropic({ baseURL: モック, apiKey: "dev-only-key" })` で明示注入する
 * (環境変数に頼らない)。ネットワークは 127.0.0.1 のみで、Claude API には出ない。
 * 既存のシナリオ(1発ヒット / 再検索 / 未解決 / 未接続ソース)を HTTP の形まで通し、
 * 要求の形(model・strict・thinking・effort・tool_choice・system の固定部が先頭)を
 * モック側の記録で検証する。
 */
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  AnthropicLlmClient,
  CONFIDENCE_CAP_WITHOUT_CITATIONS,
  NO_CITATION_NOTICE,
  Orchestrator,
  loadExplorePrompt,
  type Answer,
} from "../src/index.js";
import {
  CorpusConnector,
  EXPENSE_POLICY,
  TRAVEL_GUIDE,
  TEST_DOC_ID_AUDIT,
  startGateway,
  type GatewayHarness,
  type GatewayHarnessOptions,
} from "./helpers/harness.js";
import {
  anthropicError,
  anthropicMessage,
  anthropicSubmit,
  anthropicToolUse,
  startMockAnthropicServer,
  type AnthropicMockStep,
  type MockAnthropicServer,
} from "./helpers/mock-anthropic-server.js";
import { fetchedDocuments, firstHit, searchHits } from "./helpers/script.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

interface Setup {
  readonly harness: GatewayHarness;
  readonly mock: MockAnthropicServer;
  readonly orchestrator: Orchestrator;
}

async function setup(
  options: GatewayHarnessOptions,
  script: readonly AnthropicMockStep[],
): Promise<Setup> {
  const harness = await startGateway(options);
  cleanups.push(() => harness.close());
  const mock = await startMockAnthropicServer(script);
  cleanups.push(() => mock.close());
  const llm = new AnthropicLlmClient({
    client: new Anthropic({ baseURL: mock.url, apiKey: "dev-only-key" }),
    maxRetries: 0,
  });
  return {
    harness,
    mock,
    orchestrator: new Orchestrator({
      llm,
      auditLogger: harness.auditLogger,
      docIdAudit: TEST_DOC_ID_AUDIT,
    }),
  };
}

/** 利用者 alice のセッションで1問を探索する(run の呼び出しはここに集める)。 */
function ask(context: Setup, question: string): Promise<Answer> {
  return context.orchestrator.run({
    question,
    userId: "alice",
    gateway: context.harness.client(),
  });
}

interface WireBlock {
  readonly type: string;
  readonly id?: string;
  readonly tool_use_id?: string;
}
interface WireMessage {
  readonly role: string;
  readonly content: readonly WireBlock[];
}

function wireMessages(mock: MockAnthropicServer, index: number): WireMessage[] {
  return mock.requests[index]?.body["messages"] as WireMessage[];
}

describe("e2e(Anthropic 経路・モック Messages API)", () => {
  it("(a) 1発ヒット: 要求の形(model・strict・thinking・effort・tool_choice・固定部が先頭)と、thinking を含む履歴の追記", async () => {
    const alpha = new CorpusConnector("alpha", [EXPENSE_POLICY]);
    const beta = new CorpusConnector("beta", [TRAVEL_GUIDE]);
    const context = await setup({ connectors: [alpha, beta] }, [
      () =>
        anthropicToolUse(
          [{ name: "search", input: { source: "alpha", query: "経費精算 締め日" } }],
          { thinking: true },
        ),
      (script) => {
        const hit = firstHit(script);
        return anthropicToolUse([
          { name: "fetch", input: { source: hit.source, documentId: hit.documentId } },
        ]);
      },
      (script) => {
        const document = fetchedDocuments(script)[0];
        return anthropicSubmit({
          answer: "経費精算の締め日は毎月25日です。",
          citations: [{ documentId: document?.documentId, sourceId: document?.source }],
          confidence: 0.9,
        });
      },
    ]);

    const answer = await ask(context, "経費精算の締め日はいつ?");

    const { mock, harness } = context;
    expect(mock.scriptErrors).toEqual([]);
    expect(answer.outcome).toBe("resolved");
    expect(answer.citations).toEqual([
      {
        documentId: "doc-expense-policy",
        sourceId: "alpha",
        title: "経費精算規程",
        url: "https://alpha.example.test/docs/doc-expense-policy",
      },
    ]);
    // 使用量はモックの usage(1ターン 入力 1000 / 出力 100)× 3ターン、価格は claude-opus-5
    expect(answer.usage).toMatchObject({
      llmTurns: 3,
      toolCalls: 4,
      inputTokens: 3_000,
      outputTokens: 300,
    });
    expect(answer.usage.estimatedCost).toBeCloseTo((3 * (1_000 * 5 + 100 * 25)) / 1_000_000, 10);

    // 要求の形(1回目)
    expect(mock.requests).toHaveLength(3);
    const first = mock.requests[0];
    expect(first?.path).toBe("/v1/messages");
    expect(first?.hasApiKey).toBe(true);
    expect(first?.anthropicVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first?.anthropicBeta).toBeUndefined(); // server-side fallbacks は既定 off
    expect(first?.body).toMatchObject({
      model: "claude-opus-5",
      max_tokens: 16_000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      tool_choice: { type: "auto" },
      cache_control: { type: "ephemeral" },
    });
    expect(first?.body["stream"]).not.toBe(true);
    const tools = first?.body["tools"] as { name: string; strict?: boolean }[];
    expect(tools.map((tool) => tool.name)).toEqual([
      "describe",
      "fetch",
      "list",
      "search",
      "submit_answer",
    ]);
    expect(tools.every((tool) => tool.strict === true)).toBe(true);
    // system の固定部(バージョン管理されたプロンプト)が先頭で、キャッシュのブレークポイント付き
    const system = first?.body["system"] as { type: string; text: string; cache_control?: unknown }[];
    expect(system[0]).toEqual({
      type: "text",
      text: await loadExplorePrompt(),
      cache_control: { type: "ephemeral" },
    });
    // prefill なし(末尾は user)
    expect(wireMessages(mock, 0).at(-1)?.role).toBe("user");

    // 2回目: 応答(thinking + tool_use)をそのまま追記し、tool_result を1つの user メッセージで返す
    const second = wireMessages(mock, 1);
    expect(second.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(second[1]?.content.map((block) => block.type)).toEqual(["thinking", "tool_use"]);
    expect(second[2]?.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: second[1]?.content[1]?.id,
    });

    // Gateway 経由で本人(alice)の資格情報で呼ばれ、監査に run で束ねられている
    expect(alpha.calls.map((call) => call.tool)).toEqual(["describe", "search", "fetch"]);
    expect(harness.toolInvocations(answer.runId)).toHaveLength(4);
  });

  it("(b) 再検索で到達: 初回 search が0件 → 英日変換で再検索 → resolved", async () => {
    const alpha = new CorpusConnector("alpha", [TRAVEL_GUIDE]);
    const context = await setup({ connectors: [alpha] }, [
      () =>
        anthropicToolUse([
          { name: "search", input: { source: "alpha", query: "出張費の払い戻し期限" } },
        ]),
      (script) => {
        if (searchHits(script).length !== 0) {
          throw new Error("the first search was expected to return no hits");
        }
        return anthropicToolUse([
          { name: "search", input: { source: "alpha", query: "expense reimbursement deadline" } },
        ]);
      },
      (script) => {
        const hit = firstHit(script);
        return anthropicSubmit({
          answer: "出張経費の精算は30日以内に申請します。",
          citations: [{ documentId: hit.documentId, sourceId: hit.source }],
          confidence: 0.8,
        });
      },
    ]);

    const answer = await ask(context, "出張費の払い戻しの期限は?");

    expect(context.mock.scriptErrors).toEqual([]);
    expect(answer.outcome).toBe("resolved");
    expect(answer.citations.map((citation) => citation.documentId)).toEqual(["doc-travel-guide"]);
    const searches = context.harness
      .toolInvocations(answer.runId)
      .filter((record) => record.tool === "search")
      .sort((a, b) => a.iteration - b.iteration);
    expect(searches.map((record) => record.returnedHitCount)).toEqual([0, 1]);
  });

  it("(c) 未解決: 並列の search が0件 → 出典なしで提出 → unresolved、注意書き、confidence ≤ 0.3", async () => {
    const context = await setup(
      {
        connectors: [
          new CorpusConnector("alpha", [EXPENSE_POLICY]),
          new CorpusConnector("beta", [TRAVEL_GUIDE]),
        ],
      },
      [
        () =>
          anthropicToolUse([
            { name: "search", input: { source: "alpha", query: "来期の組織変更" } },
            { name: "search", input: { source: "beta", query: "来期の組織変更" } },
          ]),
        (script) => {
          if (script.lastToolResults.length !== 2) {
            throw new Error("parallel tool results must come back in one user message");
          }
          return anthropicSubmit({
            answer: "来期の組織変更について書かれた文書は見つかりませんでした。",
            citations: [],
            confidence: 0.7,
            unresolvedReason: "該当する文書が見つからなかった",
          });
        },
      ],
    );

    const answer = await ask(context, "来期の組織変更は決まっている?");

    expect(context.mock.scriptErrors).toEqual([]);
    expect(answer.outcome).toBe("unresolved");
    expect(answer.answer.startsWith(NO_CITATION_NOTICE)).toBe(true);
    expect(answer.confidence).toBeLessThanOrEqual(CONFIDENCE_CAP_WITHOUT_CITATIONS);
    expect(answer.searchedSources).toEqual(["alpha", "beta"]);
    expect(context.harness.answerRuns().at(-1)?.failureReason).toBe("no_citations");
  });

  it("(d) 一部ソース未接続: ツール定義の source から外れ、要求されても Gateway に送らない", async () => {
    const beta = new CorpusConnector("beta", [TRAVEL_GUIDE]);
    const context = await setup(
      {
        connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY]), beta],
        notConnected: ["beta"],
      },
      [
        () =>
          anthropicToolUse([
            { name: "search", input: { source: "alpha", query: "経費精算" } },
            { name: "search", input: { source: "beta", query: "経費精算" } },
          ]),
        (script) => {
          const rejected = script.lastToolResults.find(
            (result) => (result.toolInput as { source?: string }).source === "beta",
          );
          if (rejected?.isError !== true) {
            throw new Error("the call to the unconnected source must be rejected");
          }
          const hit = firstHit(script);
          return anthropicSubmit({
            answer: "経費精算の締め日は毎月25日です。",
            citations: [{ documentId: hit.documentId, sourceId: "alpha" }],
            confidence: 0.85,
          });
        },
      ],
    );

    const answer = await ask(context, "経費精算の締め日は?");

    expect(context.mock.scriptErrors).toEqual([]);
    const tools = context.mock.requests[0]?.body["tools"] as {
      name: string;
      input_schema: { properties?: { source?: { enum?: string[] } } };
    }[];
    const search = tools.find((tool) => tool.name === "search");
    expect(search?.input_schema.properties?.source?.enum).toEqual(["alpha"]);
    expect(answer.outcome).toBe("resolved");
    expect(answer.skippedSources).toEqual([{ sourceId: "beta", reason: "source_not_connected" }]);
    expect(answer.answer).toContain("未接続のため検索していないソース: beta");
    expect(beta.calls).toEqual([]);
  });

  it("stop_reason: max_tokens は切れた入力を実行せず error(llm_max_tokens)", async () => {
    const context = await setup({ connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])] }, [
      () =>
        anthropicMessage(
          [{ type: "tool_use", id: "toolu_truncated", name: "search", input: { source: "alpha" } }],
          "max_tokens",
        ),
    ]);

    const answer = await ask(context, "経費精算の締め日は?");

    expect(answer.outcome).toBe("error");
    expect(context.harness.answerRuns().at(-1)?.failureReason).toBe("llm_max_tokens");
    expect(
      context.harness.toolInvocations(answer.runId).filter((record) => record.tool === "search"),
    ).toEqual([]);
  });

  it("429(再試行なしの設定)は error(llm_rate_limited)。応答本文を回答に載せない", async () => {
    const context = await setup({ connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])] }, [
      () => anthropicError(429, "rate_limit_error"),
    ]);

    const answer = await ask(context, "経費精算の締め日は?");

    expect(answer.outcome).toBe("error");
    expect(context.harness.answerRuns().at(-1)?.failureReason).toBe("llm_rate_limited");
    expect(answer.answer).not.toContain("mock error");
  });
});
