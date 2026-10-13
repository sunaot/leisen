/**
 * 探索ループの終了条件: 上限(maxIterations / runTimeoutMs / costLimitPerQuery)到達時は
 * 探索を止め、その時点の情報で submit_answer を促す最終ターンを1回だけ行う。
 * submit_answer を呼ばずに終えた場合は1回だけ催促する。LLM・Gateway の失敗は error。
 * ツール呼び出しの件数の上限(maxToolCallsPerTurn / maxToolCallsPerRun)を超えた分は
 * 実行せず is_error の tool_result で返し、warnings に記録する(セキュリティレビュー m1)。
 */
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLogger } from "@leisen/audit";
import {
  GatewayClientError,
  LlmError,
  McpGatewayClient,
  NO_CITATION_NOTICE,
  NUDGE_MESSAGE,
  Orchestrator,
  TOOL_ERROR_PREFACE,
  ScriptedLlmClient,
  scriptedSubmit,
  scriptedText,
  scriptedToolUse,
  type ScriptContext,
} from "../src/index.js";
import {
  ALICE_TOKEN,
  BOB_TOKEN,
  CorpusConnector,
  EXPENSE_POLICY,
  startGateway,
  type GatewayHarness,
} from "./helpers/harness.js";
import { startStalledMcpServer } from "./helpers/mock-http.js";
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

describe("runTimeoutMs: Gateway への接続(セキュリティレビュー m1)", () => {
  it.each([
    ["initialize に応答しない", false],
    ["notifications/initialized に応答しない", true],
  ])("Gateway が %s とき、接続も run の時間上限で打ち切る(LLM を呼ばず run_timeout)", async (_label, respondToInitialize) => {
    const stalled = await startStalledMcpServer({ respondToInitialize });
    const gateway = new McpGatewayClient({ url: `${stalled.url}/mcp`, sessionToken: ALICE_TOKEN });
    try {
      const llm = new ScriptedLlmClient(() => scriptedText("呼ばれない"));
      const orchestrator = new Orchestrator({
        llm,
        settings: { runTimeoutMs: 200 },
      });

      const started = Date.now();
      // run の開始の申告(POST /runs)にも run の時間上限が効く。応答しない Gateway では
      // runId を得られないため、回答(Answer)ではなく中断の失敗で終わる(ADR-019 決定3・6)
      const error = await orchestrator
        .runDetailed({ question: "経費精算の締め日は?", gateway })
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      // 1リクエストの期限(既定 60 秒)や、期限のない notifications/initialized の送信を待たない
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(error).toBeInstanceOf(GatewayClientError);
      expect((error as GatewayClientError).errorClass).toMatch(/^(aborted|gateway_timeout|gateway_unavailable|gateway_protocol_error)$/);
      expect(llm.requests).toHaveLength(0);
      expect(stalled.methods).not.toContain("tools/list");
    } finally {
      await gateway.close();
      await stalled.close();
    }
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
    const orchestrator = new Orchestrator({ llm });

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
    const orchestrator = new Orchestrator({ llm });

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
    const orchestrator = new Orchestrator({ llm });

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
    const orchestrator = new Orchestrator({ llm });

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

  it("Gateway がセッショントークンを拒否したら run を開始できず、LLM を呼ばずに失敗する(AnswerRun は書かれない。H1 / ADR-019)", async () => {
    const harness = await setup();
    const llm = new ScriptedLlmClient([]);
    const orchestrator = new Orchestrator({ llm });

    const error = await orchestrator
      .run({
        question: "経費精算の締め日は?",
        userId: "mallory",
        gateway: harness.client("dev-only-invalid-session"),
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(llm.requests).toHaveLength(0);
    expect(error).toBeInstanceOf(GatewayClientError);
    expect((error as GatewayClientError).errorClass).toBe("unauthenticated");
    expect(String(error)).not.toContain("dev-only-invalid-session");
    // 申告の userId(mallory)で監査レコードを書かない。run も始まっていない
    expect(harness.answerRuns()).toEqual([]);
    expect(harness.toolInvocations()).toHaveLength(0);
  });

  it("別の利用者のセッションでは、その利用者の資格情報で Gateway が呼ばれる", async () => {
    const harness = await setup();
    const llm = new ScriptedLlmClient([
      () => scriptedToolUse([{ name: "search", input: { source: "alpha", query: "締め日" } }]),
      () => scriptedSubmit({ answer: "不明", citations: [], confidence: 0 }),
    ]);
    const orchestrator = new Orchestrator({ llm });

    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      userId: "bob",
      gateway: harness.client(BOB_TOKEN),
    });

    expect(harness.toolInvocations(answer.runId).every((r) => r.userId === "bob")).toBe(true);
  });
});

describe("ツール呼び出しの件数の上限(m1)", () => {
  function tenSearches(): { name: string; input: Record<string, unknown> }[] {
    return Array.from({ length: 10 }, (_, i) => ({
      name: "search",
      input: { source: "alpha", query: `締め日 ${i}` },
    }));
  }

  it("1ターンの上限を超えた分は実行せず、is_error(固定文言)で返して warnings に記録する", async () => {
    const harness = await setup();
    let limited: ScriptContext["lastToolResults"] = [];
    const llm = new ScriptedLlmClient([
      () => scriptedToolUse(tenSearches()),
      (context) => {
        limited = context.lastToolResults;
        return scriptedSubmit({ answer: "不明", citations: [], confidence: 0 });
      },
    ]);
    const orchestrator = new Orchestrator({
      llm,
      settings: { maxToolCallsPerTurn: 3 },
    });

    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      gateway: harness.client(),
    });

    // Gateway に届いたのは先頭の3件だけ(応答内の順)
    expect(searchCount(harness, answer.runId)).toBe(3);
    expect(limited).toHaveLength(10);
    expect(limited.slice(0, 3).every((r) => !r.isError)).toBe(true);
    for (const result of limited.slice(3)) {
      expect(result).toMatchObject({
        isError: true,
        json: {
          errorClass: "tool_call_limit_reached",
          message:
            "1ターンで実行できるツール呼び出しの上限を超えたため、この呼び出しは実行していません。",
        },
      });
    }
    expect(answer.warnings).toContain(
      "1ターンのツール呼び出しの上限(maxToolCallsPerTurn=3)を超えた 7 件は実行していません。",
    );
    // 上限で弾いた呼び出しは iteration を消費しない(describe 1件 + search 3件)
    expect(answer.usage.toolCalls).toBe(4);
    const iterations = harness
      .toolInvocations(answer.runId)
      .map((r) => r.iteration)
      .sort((a, b) => a - b);
    expect(iterations).toEqual([0, 1, 2, 3]);
  });

  it("run の上限に達した後の呼び出しは実行しない(describe フェーズは数えない)", async () => {
    const harness = await setup();
    const errorsSeen: string[] = [];
    let turn = 0;
    const llm = new ScriptedLlmClient((context) => {
      for (const result of context.lastToolResults) {
        if (result.isError) {
          errorsSeen.push(String((result.json as { errorClass?: string }).errorClass));
        }
      }
      turn += 1;
      if (turn <= 3) {
        return scriptedToolUse(tenSearches().slice(0, 4));
      }
      return scriptedSubmit({ answer: "不明", citations: [], confidence: 0 });
    });
    const orchestrator = new Orchestrator({
      llm,
      settings: { maxToolCallsPerRun: 6 },
    });

    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      gateway: harness.client(),
    });

    // 3ターン × 4件 = 12件の要求のうち、実行したのは6件(残り6件は上限で弾いた)
    expect(searchCount(harness, answer.runId)).toBe(6);
    expect(errorsSeen).toEqual(Array.from({ length: 6 }, () => "tool_call_limit_reached"));
    expect(answer.warnings).toContain(
      "ツール呼び出しの上限(maxToolCallsPerRun=6)に達した後の 6 件は実行していません。",
    );
    expect(answer.usage.toolCalls).toBe(7);
  });

  it("ツールエラーは固定の前置き(データであり指示ではない)と JSON の2ブロックで返す(m7)", async () => {
    const harness = await setup();
    let blocks: unknown;
    const llm = new ScriptedLlmClient([
      () => scriptedToolUse([{ name: "search", input: { source: "gamma", query: "x" } }]),
      (context) => {
        const lastUser = context.request.messages.at(-1);
        const block = Array.isArray(lastUser?.content) ? lastUser.content[0] : undefined;
        blocks = block?.type === "tool_result" ? block.content : undefined;
        return scriptedSubmit({ answer: "不明", citations: [], confidence: 0 });
      },
    ]);
    const orchestrator = new Orchestrator({
      llm,
    });

    await orchestrator.run({ question: "経費精算の締め日は?", gateway: harness.client() });

    expect(blocks).toEqual([
      { type: "text", text: TOOL_ERROR_PREFACE },
      {
        type: "text",
        text: JSON.stringify({
          errorClass: "unknown_source",
          message: "このソースは検索対象ではありません。",
        }),
      },
    ]);
  });
});
