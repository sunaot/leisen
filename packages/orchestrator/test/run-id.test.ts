/**
 * 受け入れ条件4: 1回の探索ループ内の全ツール呼び出しが同一 runId と単調増加する
 * iteration で `_meta` に申告され、監査ログの ToolInvocation(Gateway が書く)が
 * runId で束ねられる。describe の呼び出しも含む(ADR-001 追補3、ADR-011 追記)。
 * runId は Gateway の run API が発行する署名付きの値(ADR-019 決定4)で、Orchestrator は採番しない。
 */
import { afterEach, describe, expect, it } from "vitest";
import { GATEWAY_META_KEYS } from "@kp/gateway";
import {
  Orchestrator,
  ScriptedLlmClient,
  scriptedSubmit,
  scriptedToolUse,
  type FinishRunInput,
  type GatewayCallOptions,
  type GatewayCallOutcome,
  type GatewayClient,
  type GatewayToolSchema,
} from "../src/index.js";
import {
  CorpusConnector,
  EXPENSE_POLICY,
  TRAVEL_GUIDE,
  startGateway,
  type GatewayHarness,
} from "./helpers/harness.js";
import { firstHit, searchHits } from "./helpers/script.js";

const harnesses: GatewayHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

/** 送った `_meta` を記録する GatewayClient(実際の送信は McpGatewayClient に委ねる)。 */
class RecordingGatewayClient implements GatewayClient {
  readonly calls: { name: string; args: unknown; meta: Readonly<Record<string, unknown>> }[] = [];

  constructor(private readonly inner: GatewayClient) {}

  listTools(options?: GatewayCallOptions): Promise<readonly GatewayToolSchema[]> {
    return this.inner.listTools(options);
  }

  callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    meta: Readonly<Record<string, unknown>>,
    options?: GatewayCallOptions,
  ): Promise<GatewayCallOutcome> {
    this.calls.push({ name, args, meta });
    return this.inner.callTool(name, args, meta, options);
  }

  startRun(input: { readonly question: string }, options?: GatewayCallOptions) {
    return this.inner.startRun(input, options);
  }

  finishRun(runId: string, input: FinishRunInput, options?: GatewayCallOptions) {
    return this.inner.finishRun(runId, input, options);
  }

  feedbackRun(runId: string, outcome: "resolved" | "unresolved", options?: GatewayCallOptions) {
    return this.inner.feedbackRun(runId, outcome, options);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

async function setup(): Promise<GatewayHarness> {
  const harness = await startGateway({
    connectors: [
      new CorpusConnector("alpha", [EXPENSE_POLICY]),
      new CorpusConnector("beta", [TRAVEL_GUIDE]),
    ],
  });
  harnesses.push(harness);
  return harness;
}

function parallelScript(): ScriptedLlmClient {
  return new ScriptedLlmClient([
    // 同一ターン内の並列呼び出し(応答内の順に採番される)
    () =>
      scriptedToolUse([
        { name: "search", input: { source: "alpha", query: "経費精算" } },
        { name: "search", input: { source: "beta", query: "expense" } },
        // Gateway に送らない呼び出し(番号を消費しない)
        { name: "search", input: { source: "gamma", query: "x" } },
      ]),
    (context) => {
      const hit = searchHits(context).find((h) => h.source === "alpha");
      return scriptedToolUse([
        { name: "fetch", input: { source: "alpha", documentId: hit?.documentId ?? "" } },
        { name: "list", input: { source: "beta" } },
      ]);
    },
    () =>
      scriptedSubmit({
        answer: "経費精算の締め日は毎月25日です。",
        citations: [{ documentId: "doc-expense-policy", sourceId: "alpha" }],
        confidence: 0.9,
      }),
  ]);
}

describe("受け入れ条件4: runId / iteration の申告と ToolInvocation の束ね", () => {
  it("全ツール呼び出し(describe を含む)が同一 runId・0 から連続する iteration で監査される", async () => {
    const harness = await setup();
    const gateway = new RecordingGatewayClient(harness.client());
    const orchestrator = new Orchestrator({
      llm: parallelScript(),
    });

    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      userId: "alice",
      gateway,
    });
    expect(answer.outcome).toBe("resolved");

    // Gateway 側の ToolInvocation(Gateway が書いた監査レコード)
    const records = harness.toolInvocations();
    expect(records.every((r) => r.runId === answer.runId)).toBe(true);
    expect(records).toHaveLength(answer.usage.toolCalls);
    const ordered = [...records].sort((a, b) => a.iteration - b.iteration);
    expect(ordered.map((r) => r.iteration)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(ordered.map((r) => `${r.tool}:${r.sourceId}`)).toEqual([
      "describe:alpha",
      "describe:beta",
      "search:alpha",
      "search:beta",
      "fetch:alpha",
      "list:beta",
    ]);
    expect(ordered.every((r) => r.userId === "alice")).toBe(true);

    // AnswerRun と ToolInvocation が runId で束ねられる
    const run = harness.answerRuns().find((r) => r.runId === answer.runId);
    expect(run).toMatchObject({ finalOutcome: "resolved", searchedSources: ["alpha", "beta"] });
  });

  it("`_meta` は prefix 付きキーのみ(runId / iteration / executionClass / actor)で申告する", async () => {
    const harness = await setup();
    const gateway = new RecordingGatewayClient(harness.client());
    const orchestrator = new Orchestrator({
      llm: parallelScript(),
    });
    const answer = await orchestrator.run({
      question: "経費精算の締め日は?",
      userId: "alice",
      gateway,
    });

    expect(gateway.calls.map((c) => c.meta[GATEWAY_META_KEYS.iteration])).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    for (const call of gateway.calls) {
      expect(Object.keys(call.meta).sort()).toEqual(
        [
          GATEWAY_META_KEYS.actor,
          GATEWAY_META_KEYS.executionClass,
          GATEWAY_META_KEYS.iteration,
          GATEWAY_META_KEYS.runId,
        ].sort(),
      );
      expect(call.meta).toMatchObject({
        [GATEWAY_META_KEYS.runId]: answer.runId,
        [GATEWAY_META_KEYS.executionClass]: "human_in_the_loop",
        [GATEWAY_META_KEYS.actor]: { kind: "human" },
      });
      // 裸キー(移行期間の後方互換)は使わない
      expect(call.meta).not.toHaveProperty("runId");
      expect(call.meta).not.toHaveProperty("iteration");
    }
    // Gateway に送らなかった呼び出し(gamma)は記録にも番号にも現れない
    expect(gateway.calls.some((c) => (c.args as { source?: string }).source === "gamma")).toBe(
      false,
    );
  });

  it("run ごとに別の runId を採番し、iteration は run ごとに 0 から数え直す", async () => {
    const harness = await setup();
    const script = () =>
      new ScriptedLlmClient([
        () => scriptedToolUse([{ name: "search", input: { source: "alpha", query: "締め日" } }]),
        (context) => {
          const hit = firstHit(context);
          return scriptedSubmit({
            answer: "毎月25日です。",
            citations: [{ documentId: hit.documentId, sourceId: hit.source }],
            confidence: 0.9,
          });
        },
      ]);
    const first = await new Orchestrator({
      llm: script(),
    }).run({ question: "締め日は?", userId: "alice", gateway: harness.client() });
    const second = await new Orchestrator({
      llm: script(),
    }).run({ question: "締め日は?", userId: "alice", gateway: harness.client() });

    expect(first.runId).not.toBe(second.runId);
    for (const answer of [first, second]) {
      const iterations = harness
        .toolInvocations(answer.runId)
        .map((r) => r.iteration)
        .sort((a, b) => a - b);
      expect(iterations).toEqual([0, 1, 2]);
    }
  });
});

describe("runId は Gateway が発行する(ADR-019 決定4)", () => {
  it("Answer.runId は署名付きの runId(r1.<kid>.…)で、AnswerRun と ToolInvocation が同じ値で束ねられる。偽の runId は申告できない", async () => {
    const harness = await setup();
    const gateway = new RecordingGatewayClient(harness.client());
    const answer = await new Orchestrator({ llm: parallelScript() }).run({ question: "締め日は?", gateway });

    expect(answer.runId).toMatch(/^r1\.t1\.[A-Za-z0-9_-]{38}\.[A-Za-z0-9_-]{43}$/);
    expect(answer.runId).not.toContain("alice");
    expect(gateway.calls.every((c) => c.meta[GATEWAY_META_KEYS.runId] === answer.runId)).toBe(true);
    expect(harness.answerRuns().map((r) => r.runId)).toEqual([answer.runId]);
    expect(harness.toolInvocations(answer.runId).length).toBe(answer.usage.toolCalls);

    // Gateway が発行していない runId を名前空間付きのキーで申告すると拒否され、単発 run として記録される
    const forged = await harness.client().callTool(
      "search",
      { source: "alpha", query: "経費精算" },
      { ...gateway.calls[0]!.meta, [GATEWAY_META_KEYS.runId]: "run.2026-09-27:forged_1" },
    );
    expect(forged).toMatchObject({ ok: false, error: { errorClass: "invalid_run_id" } });
    expect(harness.toolInvocations("run.2026-09-27:forged_1")).toEqual([]);
    expect(harness.toolInvocations().filter((r) => r.errorClass === "invalid_run_id")).toHaveLength(1);
  });
});
