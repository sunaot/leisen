/**
 * LLM バックエンドのプラグイン境界(ADR-017 決定1): 能力フラグによる要求の組み方、
 * プロバイダ+モデルでの価格表の引き当て(スナップショット付き ID を含む)、
 * createLlmClient による生成の集約。Orchestrator の経路は ScriptedLlmClient(高速な
 * 単体経路)と実 Gateway(port 0)で検証する。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  ANTHROPIC_CAPABILITIES,
  AnthropicLlmClient,
  DEFAULT_PRICING,
  OPENAI_COMPATIBLE_BASE_CAPABILITIES,
  OpenAiCompatibleLlmClient,
  Orchestrator,
  ScriptedLlmClient,
  UsageMeter,
  adaptRequestToCapabilities,
  createLlmClient,
  findModelPrice,
  orchestratorSettingsSchema,
  scriptedSubmit,
  scriptedToolUse,
  type LlmRequest,
  type ModelPrice,
  type ScriptedTurnOptions,
} from "../src/index.js";
import {
  CorpusConnector,
  EXPENSE_POLICY,
  startGateway,
  type GatewayHarness,
} from "./helpers/harness.js";

const harnesses: GatewayHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

async function setup(): Promise<GatewayHarness> {
  const harness = await startGateway({
    connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])],
  });
  harnesses.push(harness);
  return harness;
}

/** 応答の model と使用量(1ターン 入力 1000 / 出力 500)。 */
function servedBy(model: string): ScriptedTurnOptions {
  return { model, usage: { inputTokens: 1_000, outputTokens: 500 } };
}

const PRICE: ModelPrice = {
  inputPerMTok: 1,
  outputPerMTok: 2,
  cacheWritePerMTok: 1.25,
  cacheReadPerMTok: 0.1,
};

describe("能力フラグ: Orchestrator は対応している機能だけを要求に付ける", () => {
  it("Anthropic 相当(既定): strict・thinking adaptive・effort・キャッシュのブレークポイントを付ける", async () => {
    const harness = await setup();
    const llm = new ScriptedLlmClient([
      () => scriptedSubmit({ answer: "不明です。", citations: [], confidence: 0 }),
    ]);

    await new Orchestrator({ llm }).run({
      question: "経費精算の締め日は?",
      userId: "alice",
      gateway: harness.client(),
    });

    const request = llm.requests[0];
    expect(request?.thinking).toBe("adaptive");
    expect(request?.effort).toBe(true);
    expect(request?.tools.every((tool) => tool.strict === true)).toBe(true);
    expect(request?.system[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("OpenAI 互換相当: strict・thinking・effort・cache_control を付けない(ツール名・スキーマは同じ)", async () => {
    const harness = await setup();
    const llm = new ScriptedLlmClient(
      [() => scriptedSubmit({ answer: "不明です。", citations: [], confidence: 0 })],
      { provider: "openai_compatible", capabilities: OPENAI_COMPATIBLE_BASE_CAPABILITIES },
    );

    await new Orchestrator({ llm }).run({
      question: "経費精算の締め日は?",
      userId: "alice",
      gateway: harness.client(),
    });

    const request = llm.requests[0];
    expect(request).not.toHaveProperty("thinking");
    expect(request).not.toHaveProperty("effort");
    expect(request?.tools.some((tool) => "strict" in tool)).toBe(false);
    expect(request?.tools.map((tool) => tool.name)).toEqual([
      "describe",
      "fetch",
      "list",
      "search",
      "submit_answer",
    ]);
    expect(request?.system.some((block) => "cache_control" in block)).toBe(false);
  });

  it("adaptRequestToCapabilities: 入力を変更せず、同じ入力に同じ出力を返す(キャッシュの prefix を揺らさない)", () => {
    const base: LlmRequest = {
      system: [{ type: "text", text: "固定部", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "質問" }],
      tools: [
        {
          name: "search",
          strict: true,
          input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
        },
      ],
      maxTokens: 1_000,
    };
    const snapshot = structuredClone(base);

    const adapted = adaptRequestToCapabilities(OPENAI_COMPATIBLE_BASE_CAPABILITIES, base);

    expect(base).toEqual(snapshot);
    expect(adapted).toEqual(adaptRequestToCapabilities(OPENAI_COMPATIBLE_BASE_CAPABILITIES, base));
    expect(adapted.tools[0]).not.toHaveProperty("strict");
    expect(adapted.system[0]).toEqual({ type: "text", text: "固定部" });
    // 能力が揃っていれば正準形のまま(thinking / effort を足すだけ)
    const full = adaptRequestToCapabilities(ANTHROPIC_CAPABILITIES, base);
    expect(full.tools).toBe(base.tools);
    expect(full.system).toBe(base.system);
    expect(full).toMatchObject({ thinking: "adaptive", effort: true });
  });
});

describe("価格表: プロバイダ+モデルで引く", () => {
  it("findModelPrice: 完全一致、日付スナップショット付き ID は元の ID の行(日付以外の接尾辞は写さない)", () => {
    const table: Readonly<Record<string, ModelPrice>> = {
      ...DEFAULT_PRICING,
      "gpt-4o": PRICE,
    };
    const opus5 = DEFAULT_PRICING["claude-opus-5"];
    expect(findModelPrice(table, "claude-opus-5")).toBe(opus5);
    expect(findModelPrice(table, "claude-opus-5-20260401")).toBe(opus5);
    expect(findModelPrice(table, "claude-opus-5@20260401")).toBe(opus5);
    expect(findModelPrice(table, "gpt-4o-2024-08-06")).toBe(PRICE);
    // claude-opus-5-5 は別モデル。表にあればその行、なければ claude-opus-5 の単価で数えない
    expect(findModelPrice(table, "claude-opus-5-5")).toBe(DEFAULT_PRICING["claude-opus-5-5"]);
    expect(findModelPrice({ "claude-opus-5": PRICE }, "claude-opus-5-5")).toBeUndefined();
    expect(findModelPrice({ "claude-opus-5": PRICE }, "claude-opus-5-5-20261001")).toBeUndefined();
    // 継承プロパティを単価と取り違えない
    expect(findModelPrice(table, "constructor")).toBeUndefined();
    expect(findModelPrice(table, "toString-20260401")).toBeUndefined();
  });

  it("設定の既定: anthropic は既定の価格表、openai_compatible は空(ローカル推論の費用は不明のまま)", () => {
    const settings = orchestratorSettingsSchema.parse({});
    expect(settings.pricing.anthropic).toEqual(DEFAULT_PRICING);
    expect(settings.pricing.openai_compatible).toEqual({});
    // 旧形式(モデル → 単価のフラットな表)は受けない(取り違えて 0 円にしない)
    expect(
      orchestratorSettingsSchema.safeParse({ pricing: { "claude-opus-5": PRICE } }).success,
    ).toBe(false);
  });

  it("OpenAI 互換で価格表にないモデル: costLimitPerQuery 未設定なら探索を止めず、費用は不明のまま", async () => {
    const harness = await setup();
    // Anthropic の価格表にある名前でも、プロバイダが違えばその単価を使わない
    const llm = new ScriptedLlmClient(
      [
        () =>
          scriptedToolUse([{ name: "search", input: { source: "alpha", query: "締め日" } }], servedBy("claude-opus-5")),
        () => scriptedSubmit({ answer: "不明です。", citations: [], confidence: 0 }, servedBy("claude-opus-5")),
      ],
      { provider: "openai_compatible", capabilities: OPENAI_COMPATIBLE_BASE_CAPABILITIES },
    );

    const answer = await new Orchestrator({ llm }).run({
      question: "経費精算の締め日は?",
      userId: "alice",
      gateway: harness.client(),
    });

    expect(harness.toolInvocations(answer.runId).filter((r) => r.tool === "search")).toHaveLength(1);
    expect(answer.usage).toMatchObject({ inputTokens: 2_000, outputTokens: 1_000, llmTurns: 2 });
    expect(answer.usage.estimatedCost).toBeUndefined();
    expect(answer.warnings).toContain(
      "価格表にないモデル(claude-opus-5)を使ったため、費用を概算できません。",
    );
  });

  it("OpenAI 互換で価格表にないモデル: costLimitPerQuery が設定されていれば確認できないため到達扱い", async () => {
    const harness = await setup();
    const llm = new ScriptedLlmClient(
      [
        () => scriptedToolUse([{ name: "search", input: { source: "alpha", query: "締め日" } }], servedBy("local-model")),
        () => scriptedSubmit({ answer: "不明です。", citations: [], confidence: 0 }),
      ],
      { provider: "openai_compatible", capabilities: OPENAI_COMPATIBLE_BASE_CAPABILITIES },
    );

    const answer = await new Orchestrator({
      llm,
      settings: { costLimitPerQuery: 1 },
    }).run({ question: "経費精算の締め日は?", userId: "alice", gateway: harness.client() });

    expect(harness.toolInvocations(answer.runId).filter((r) => r.tool === "search")).toHaveLength(0);
    expect(harness.answerRuns().at(-1)?.failureReason).toBe("cost_limit_reached");
  });

  it("OpenAI 互換の価格表を設定すれば、そのプロバイダの行で概算する", async () => {
    const harness = await setup();
    const llm = new ScriptedLlmClient(
      [() => scriptedSubmit({ answer: "不明です。", citations: [], confidence: 0 }, servedBy("hosted-model-2026-04-01"))],
      { provider: "openai_compatible", capabilities: OPENAI_COMPATIBLE_BASE_CAPABILITIES },
    );

    const answer = await new Orchestrator({
      llm,
      settings: { pricing: { openai_compatible: { "hosted-model": PRICE } } },
    }).run({ question: "経費精算の締め日は?", userId: "alice", gateway: harness.client() });

    // 1000 × $1 + 500 × $2(100万トークンあたり)
    expect(answer.usage.estimatedCost).toBeCloseTo(0.002, 10);
    expect(answer.warnings).toEqual([]);
  });

  it("UsageMeter: usage のない応答は費用不明(上限設定時は到達扱い、未設定なら判定しない)", () => {
    const meter = new UsageMeter(DEFAULT_PRICING);
    meter.add([
      {
        model: "claude-opus-5",
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        usageMissing: true,
      },
    ]);
    expect(meter.usageMissing).toBe(true);
    expect(meter.estimatedCost).toBeUndefined();
    expect(meter.unknownModels).toEqual([]);
    expect(meter.reached(undefined)).toBe(false);
    expect(meter.reached(100)).toBe(true);
  });
});

describe("createLlmClient: 生成の集約(provider で実装を選ぶ)", () => {
  it("anthropic → AnthropicLlmClient(SDK クライアントを差し替えられる)", () => {
    const client = createLlmClient(
      { provider: "anthropic", model: "claude-opus-5-5", effort: "medium" },
      {
        anthropicClient: {
          apiKey: "dev-only-key",
          authToken: null,
          credentials: null,
          messages: { create: async () => Promise.reject(new Error("unused")) },
          beta: { messages: { create: async () => Promise.reject(new Error("unused")) } },
        },
      },
    );
    expect(client).toBeInstanceOf(AnthropicLlmClient);
    expect(client.provider).toBe("anthropic");
    expect((client as AnthropicLlmClient).settings).toMatchObject({
      model: "claude-opus-5-5",
      effort: "medium",
    });
  });

  it("openai_compatible → OpenAiCompatibleLlmClient(既定のタイムアウト・再試行)", () => {
    const client = createLlmClient({
      provider: "openai_compatible",
      baseUrl: "http://localhost:1234/v1",
      model: "openai/gpt-oss-20b",
    });
    expect(client).toBeInstanceOf(OpenAiCompatibleLlmClient);
    expect(client.provider).toBe("openai_compatible");
    expect((client as OpenAiCompatibleLlmClient).model).toBe("openai/gpt-oss-20b");
  });

  it.each([
    ["provider なし", { model: "x" }],
    ["未知の provider", { provider: "gemini", model: "x" }],
    ["openai_compatible で baseUrl なし", { provider: "openai_compatible", model: "x" }],
    ["openai_compatible で model なし", { provider: "openai_compatible", baseUrl: "http://localhost:1234/v1" }],
    ["anthropic に openai_compatible の項目", { provider: "anthropic", baseUrl: "http://localhost:1234/v1" }],
  ])("%s は拒否", (_label, config) => {
    expect(() => createLlmClient(config as Parameters<typeof createLlmClient>[0])).toThrow();
  });
});
