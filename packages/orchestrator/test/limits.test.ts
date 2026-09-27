/**
 * 探索ループの終了条件: 上限(maxIterations / runTimeoutMs / costLimitPerQuery)到達時は
 * 探索を止め、その時点の情報で submit_answer を促す最終ターンを1回だけ行う。
 * submit_answer を呼ばずに終えた場合は1回だけ催促する。LLM・Gateway の失敗は error。
 */
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  LlmError,
  NO_CITATION_NOTICE,
  NUDGE_MESSAGE,
  Orchestrator,
  ScriptedLlmClient,
  scriptedSubmit,
  scriptedText,
  scriptedToolUse,
  type ScriptContext,
} from "../src/index.js";
import {
  BOB_TOKEN,
  CorpusConnector,
  EXPENSE_POLICY,
  startGateway,
  type GatewayHarness,
} from "./helpers/harness.js";
import { firstHit, isFinalInstruction, searchHits } from "./helpers/script.js";

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

function searchCount(harness: GatewayHarness, runId: string): number {
  return harness.toolInvocations(runId).filter((r) => r.tool === "search").length;
}

describe("maxIterations", () => {
  it("ツール呼び出しターンが上限に達したら探索を止め、最終ターンで回答を促す", async () => {
    const harness = await setup();
    let seen: { documentId: string; source: string } | undefined;
    const llm = new ScriptedLlmClient((context: ScriptContext) => {
      const hit = searchHits(context)[0];
      if (hit !== undefined) {
        seen = hit;
      }
      if (isFinalInstruction(context)) {
        return scriptedSubmit({
          answer: "経費精算の締め日は毎月25日です。",
          citations: seen ? [{ documentId: seen.documentId, sourceId: seen.source }] : [],
          confidence: 0.7,
        });
      }
      // 満足せずに検索を続けるモデル
      return scriptedToolUse([
        { name: "search", input: { source: "alpha", query: `締め日 ${context.turnIndex}` } },
      ]);
    });
    const orchestrator = new Orchestrator({
      llm,
      auditLogger: harness.auditLogger,
      settings: { maxIterations: 2 },
    });

    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      userId: "alice",
      gateway: harness.client(),
    });

    expect(searchCount(harness, answer.runId)).toBe(2);
    expect(llm.requests).toHaveLength(3);
    // 最終ターンの要求: 2回目のツール結果と最終指示が同じ user メッセージに入っている
    const last = llm.requests[2]?.messages.at(-1);
    expect(last?.role).toBe("user");
    expect(Array.isArray(last?.content) && last.content.map((b) => b.type)).toEqual([
      "tool_result",
      "text",
    ]);
    expect(answer.outcome).toBe("resolved");
    expect(answer.warnings).toContain(
      "探索の上限(maxIterations=2)に達したため、その時点の情報で回答しています。",
    );
    expect(harness.answerRuns()[0]?.failureReason).toBeNull();
  });

  it("最終ターンでも提出しなければ unresolved(failureReason: max_iterations_reached)", async () => {
    const harness = await setup();
    const llm = new ScriptedLlmClient(() =>
      scriptedToolUse([{ name: "search", input: { source: "alpha", query: "締め日" } }]),
    );
    const orchestrator = new Orchestrator({
      llm,
      auditLogger: harness.auditLogger,
      settings: { maxIterations: 1 },
    });

    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      userId: "alice",
      gateway: harness.client(),
    });

    // 1ターン目は実行、最終ターンで要求されたツールは実行しない
    expect(searchCount(harness, answer.runId)).toBe(1);
    expect(llm.requests).toHaveLength(2);
    expect(answer.outcome).toBe("unresolved");
    expect(answer.answer.startsWith(NO_CITATION_NOTICE)).toBe(true);
    expect(answer.warnings).toContain("上限到達後に要求されたツール呼び出し 1 件は実行していません。");
    expect(harness.answerRuns()[0]?.failureReason).toBe("max_iterations_reached");
  });
});

describe("runTimeoutMs", () => {
  it("時間上限で進行中の LLM 呼び出しを打ち切り、最終ターンで回答を促す", async () => {
    const harness = await setup();
    let seen: { documentId: string; source: string } | undefined;
    const llm = new ScriptedLlmClient([
      () => scriptedToolUse([{ name: "search", input: { source: "alpha", query: "締め日" } }]),
      async (context) => {
        seen = firstHit(context);
        // 時間上限(200ms)で打ち切られる(中断シグナルに従い、待機も止める)
        await sleep(5_000, undefined, { signal: context.signal }).catch(() => undefined);
        return scriptedText("まだ考え中");
      },
      (context) => {
        expect(isFinalInstruction(context)).toBe(true);
        expect(context.lastUserTexts.join("")).toContain("探索の時間上限に達しました");
        return scriptedSubmit({
          answer: "経費精算の締め日は毎月25日です。",
          citations: seen ? [{ documentId: seen.documentId, sourceId: seen.source }] : [],
          confidence: 0.8,
        });
      },
    ]);
    const orchestrator = new Orchestrator({
      llm,
      auditLogger: harness.auditLogger,
      settings: { runTimeoutMs: 200 },
    });

    const started = Date.now();
    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      userId: "alice",
      gateway: harness.client(),
    });

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(llm.requests).toHaveLength(3);
    expect(answer.outcome).toBe("resolved");
    expect(answer.warnings).toContain(
      "探索の時間上限(runTimeoutMs=200)に達したため、その時点の情報で回答しています。",
    );
    // 打ち切ったターンの応答は履歴に入らない(最終要求の直前は指示の user ターン)
    const finalMessages = llm.requests[2]?.messages ?? [];
    expect(finalMessages.map((m) => m.role)).toEqual(["user", "assistant", "user", "user"]);
  });
});

describe("costLimitPerQuery", () => {
  it("概算費用が上限に達したら要求されたツールを実行せず、最終ターンで回答を促す", async () => {
    const harness = await setup();
    // claude-opus-5: 入力 $5 / 出力 $25(100万トークンあたり)→ 1ターン 0.0175
    const usage = { inputTokens: 1_000, outputTokens: 500 };
    const llm = new ScriptedLlmClient([
      () =>
        scriptedToolUse([{ name: "search", input: { source: "alpha", query: "締め日" } }], {
          usage,
        }),
      (context) => {
        expect(isFinalInstruction(context)).toBe(true);
        expect(context.lastToolResults[0]).toMatchObject({
          isError: true,
          json: { errorClass: "cost_limit_reached" },
        });
        return scriptedSubmit(
          { answer: "費用上限のため調べきれませんでした。", citations: [], confidence: 0.1 },
          { usage },
        );
      },
    ]);
    const orchestrator = new Orchestrator({
      llm,
      auditLogger: harness.auditLogger,
      settings: { costLimitPerQuery: 0.01 },
    });

    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      userId: "alice",
      gateway: harness.client(),
    });

    expect(searchCount(harness, answer.runId)).toBe(0);
    expect(answer.outcome).toBe("unresolved");
    expect(answer.usage.estimatedCost).toBeCloseTo(0.035, 10);
    expect(answer.usage).toMatchObject({ inputTokens: 2_000, outputTokens: 1_000, llmTurns: 2 });
    expect(answer.warnings).toContain(
      "費用の上限(costLimitPerQuery=0.01)に達したため、その時点の情報で回答しています。",
    );
    expect(harness.answerRuns()[0]?.failureReason).toBe("cost_limit_reached");
  });

  it("価格表にないモデルを使った場合は費用を確認できないため上限到達として扱う", async () => {
    const harness = await setup();
    const llm = new ScriptedLlmClient([
      () =>
        scriptedToolUse([{ name: "search", input: { source: "alpha", query: "締め日" } }], {
          model: "claude-unpriced-model",
        }),
      () => scriptedSubmit({ answer: "不明", citations: [], confidence: 0 }),
    ]);
    const orchestrator = new Orchestrator({
      llm,
      auditLogger: harness.auditLogger,
      settings: { costLimitPerQuery: 1 },
    });

    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      userId: "alice",
      gateway: harness.client(),
    });

    expect(searchCount(harness, answer.runId)).toBe(0);
    expect(answer.usage.estimatedCost).toBeUndefined();
    expect(answer.warnings).toContain(
      "価格表にないモデル(claude-unpriced-model)を使ったため、費用を概算できません。",
    );
  });
});

describe("submit_answer の催促", () => {
  it("submit_answer を呼ばずに終えたら1回だけ催促する", async () => {
    const harness = await setup();
    const llm = new ScriptedLlmClient([
      () => scriptedText("締め日は25日だと思います。"),
      (context) => {
        expect(context.lastUserTexts).toEqual([NUDGE_MESSAGE]);
        return scriptedSubmit({ answer: "不明です。", citations: [], confidence: 0.1 });
      },
    ]);
    const orchestrator = new Orchestrator({ llm, auditLogger: harness.auditLogger });

    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      userId: "alice",
      gateway: harness.client(),
    });

    expect(llm.requests).toHaveLength(2);
    expect(answer.outcome).toBe("unresolved");
  });

  it("催促後も提出しなければ unresolved(モデルの自由文は回答にしない)", async () => {
    const harness = await setup();
    const llm = new ScriptedLlmClient(() => scriptedText("締め日は10日です(根拠なし)。"));
    const orchestrator = new Orchestrator({ llm, auditLogger: harness.auditLogger });

    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      userId: "alice",
      gateway: harness.client(),
    });

    expect(llm.requests).toHaveLength(2);
    expect(answer.outcome).toBe("unresolved");
    expect(answer.answer.startsWith(NO_CITATION_NOTICE)).toBe(true);
    expect(answer.answer).not.toContain("10日");
    expect(answer.confidence).toBe(0);
    expect(harness.answerRuns()[0]?.failureReason).toBe("answer_not_submitted");
  });

  it("submit_answer と同じターンの他のツール呼び出しは実行しない", async () => {
    const harness = await setup();
    const llm = new ScriptedLlmClient([
      () =>
        scriptedToolUse([
          { name: "search", input: { source: "alpha", query: "締め日" } },
          {
            name: "submit_answer",
            input: { answer: "不明", citations: [], confidence: 0 },
          },
        ]),
    ]);
    const orchestrator = new Orchestrator({ llm, auditLogger: harness.auditLogger });

    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      userId: "alice",
      gateway: harness.client(),
    });

    expect(searchCount(harness, answer.runId)).toBe(0);
    expect(answer.warnings).toContain(
      "submit_answer と同じターンで要求されたツール呼び出し 1 件は実行していません。",
    );
  });
});

describe("失敗時は outcome: error", () => {
  it("LLM の正規化エラーは error で終え、AnswerRun にコードだけを残す", async () => {
    const harness = await setup();
    const llm = new ScriptedLlmClient([
      () => {
        throw new LlmError("llm_rate_limited", "the Claude API rate limit was exceeded");
      },
    ]);
    const orchestrator = new Orchestrator({ llm, auditLogger: harness.auditLogger });

    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      userId: "alice",
      gateway: harness.client(),
    });

    expect(answer.outcome).toBe("error");
    expect(answer.confidence).toBe(0);
    expect(harness.answerRuns()[0]).toMatchObject({
      finalOutcome: "error",
      confidence: null,
      failureReason: "llm_rate_limited",
    });
  });

  it("Gateway がセッショントークンを拒否したら LLM を呼ばずに error", async () => {
    const harness = await setup();
    const llm = new ScriptedLlmClient([]);
    const orchestrator = new Orchestrator({ llm, auditLogger: harness.auditLogger });

    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      userId: "mallory",
      gateway: harness.client("dev-only-invalid-session"),
    });

    expect(llm.requests).toHaveLength(0);
    expect(answer.outcome).toBe("error");
    expect(answer.answer).not.toContain("dev-only-invalid-session");
    expect(harness.answerRuns()[0]?.failureReason).toBe("gateway_unauthenticated");
    expect(harness.toolInvocations()).toHaveLength(0);
  });

  it("別の利用者のセッションでは、その利用者の資格情報で Gateway が呼ばれる", async () => {
    const harness = await setup();
    const llm = new ScriptedLlmClient([
      () => scriptedToolUse([{ name: "search", input: { source: "alpha", query: "締め日" } }]),
      () => scriptedSubmit({ answer: "不明", citations: [], confidence: 0 }),
    ]);
    const orchestrator = new Orchestrator({ llm, auditLogger: harness.auditLogger });

    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      userId: "bob",
      gateway: harness.client(BOB_TOKEN),
    });

    expect(harness.toolInvocations(answer.runId).every((r) => r.userId === "bob")).toBe(true);
  });
});
