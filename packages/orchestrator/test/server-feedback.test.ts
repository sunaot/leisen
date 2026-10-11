/**
 * T-021 受け入れ条件3(ADR-019 で改訂): feedback は run の利用者本人だけが記録でき、他人の run は拒否される。
 *
 * - 本人確認は Gateway が runId の署名で行う(POST /runs/{runId}/feedback。Orchestrator は run を
 *   覚えず、describe も呼ばない)。記録は Gateway の監査に answer_run_feedback として残る
 * - alice の run に alice のトークン → 記録(統合した AnswerRun の userFeedback になる)
 * - bob のトークン・未知の runId → run_not_accepted(理由は区別しない。runId をエコーしない)
 * - 不正な引数 → invalid_request(Gateway に問い合わせない)
 * - Gateway の run API が応答しなければ期限(feedbackTimeoutMs)で失敗を返し、同時実行の枠を返す
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  FEEDBACK_NOT_ACCEPTED_TEXT,
  FEEDBACK_TIMEOUT_MS,
  McpGatewayClient,
  ScriptedLlmClient,
  type GatewayClientFactory,
} from "../src/index.js";
import {
  ALICE_TOKEN,
  BOB_TOKEN,
  CorpusConnector,
  EXPENSE_POLICY,
  startGateway,
  type GatewayHarness,
} from "./helpers/harness.js";
import {
  searchThenSubmit,
  startOrchestratorServer,
  type OrchestratorServerHarness,
} from "./helpers/orchestrator-server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function setup(
  connectors: CorpusConnector[] = [new CorpusConnector("alpha", [EXPENSE_POLICY])],
): Promise<{ gateway: GatewayHarness; server: OrchestratorServerHarness }> {
  const gateway = await startGateway({ connectors });
  cleanups.push(() => gateway.close());
  const server = await startOrchestratorServer({
    gatewayUrl: gateway.url,
    llm: new ScriptedLlmClient(searchThenSubmit()),
  });
  cleanups.push(() => server.close());
  return { gateway, server };
}

interface ToolResult {
  readonly isError: boolean;
  readonly text: string;
  readonly structured: Record<string, unknown>;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  await client.listTools();
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: string; text: string }[];
  return {
    isError: result.isError === true,
    text: first?.text ?? "",
    structured: result.structuredContent as Record<string, unknown>,
  };
}

async function askAs(server: OrchestratorServerHarness, token: string): Promise<string> {
  const client = await server.connect(token);
  const { structured } = await call(client, "ask", { question: "経費精算の締め日は?" });
  expect(structured["outcome"]).toBe("resolved");
  return structured["runId"] as string;
}

function feedbackRecords(gateway: GatewayHarness, runId: string) {
  return gateway
    .records()
    .flatMap((record) =>
      record.recordType === "answer_run_feedback" && record.runId === runId ? [record] : [],
    );
}

describe("feedback: 本人だけが記録できる(Gateway が runId の署名で検証する)", () => {
  it("alice の run に alice のトークン → answer_run_feedback が Gateway の監査に残り、統合した AnswerRun の userFeedback になる", async () => {
    const { gateway, server } = await setup();
    const runId = await askAs(server, ALICE_TOKEN);
    const client = await server.connect(ALICE_TOKEN);

    const result = await call(client, "feedback", { runId, outcome: "resolved" });

    expect(result).toEqual({
      isError: false,
      text: "フィードバック(解決した)を記録しました。",
      structured: { runId, outcome: "resolved" },
    });
    expect(feedbackRecords(gateway, runId)).toEqual([
      expect.objectContaining({ userId: "alice", userFeedback: "resolved" }),
    ]);
    expect(gateway.answerRuns().find((run) => run.runId === runId)).toMatchObject({
      finalOutcome: "resolved",
      userFeedback: "resolved",
    });
    // 本人確認のための describe は呼ばない(ToolInvocation は run のものだけ)
    expect(gateway.toolInvocations().map((record) => record.tool)).toEqual(["describe", "search"]);

    // 同じ利用者は評価を付け直せる(最新が採られる)
    const again = await call(client, "feedback", { runId, outcome: "unresolved" });
    expect(again.text).toBe("フィードバック(解決しなかった)を記録しました。");
    expect(gateway.answerRuns().find((run) => run.runId === runId)).toMatchObject({ userFeedback: "unresolved" });
  });

  it("bob のトークンで alice の run に feedback すると run_not_accepted(記録は変わらない)", async () => {
    const { gateway, server } = await setup();
    const runId = await askAs(server, ALICE_TOKEN);
    const before = gateway.records().length;
    const bob = await server.connect(BOB_TOKEN);

    const result = await call(bob, "feedback", { runId, outcome: "unresolved" });

    expect(result.isError).toBe(true);
    expect(result.structured).toEqual({ errorClass: "run_not_accepted" });
    expect(result.text).toBe(FEEDBACK_NOT_ACCEPTED_TEXT);
    expect(result.text).not.toContain(runId);
    expect(gateway.records()).toHaveLength(before);
  });

  it("未知の runId は run_not_accepted(runId をエコーしない)", async () => {
    const { gateway, server } = await setup();
    const client = await server.connect(ALICE_TOKEN);
    const unknown = "dev-only-unknown-run";

    const result = await call(client, "feedback", { runId: unknown, outcome: "resolved" });

    expect(result.isError).toBe(true);
    expect(result.structured).toEqual({ errorClass: "run_not_accepted" });
    expect(result.text).not.toContain(unknown);
    expect(gateway.answerRuns()).toEqual([]);
  });

  it.each([
    [{ runId: "r-1", outcome: "maybe" }],
    [{ runId: "", outcome: "resolved" }],
    [{ outcome: "resolved" }],
    [{ runId: "r-1", outcome: "resolved", userId: "alice" }],
  ])("不正な引数 %j は invalid_request(Gateway に問い合わせない)", async (args) => {
    const { gateway, server } = await setup();
    const client = await server.connect(ALICE_TOKEN);

    const result = await call(client, "feedback", args);

    expect(result.isError).toBe(true);
    expect(result.structured).toEqual({ errorClass: "invalid_request" });
    expect(gateway.toolInvocations()).toEqual([]);
    expect(gateway.records()).toEqual([]);
  });

  it("Gateway が監査ストアに書けない(503 audit_write_failed)ときは利用者にエラーで返り、上流の文言を載せない", async () => {
    let failWrites = false;
    const gateway = await startGateway({
      connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])],
      wrapSink: (inner) => ({
        write: async (record) => {
          if (failWrites) throw new Error("injected audit failure: dev-only-sink-detail");
          await inner.write(record);
        },
      }),
    });
    cleanups.push(() => gateway.close());
    const server = await startOrchestratorServer({
      gatewayUrl: gateway.url,
      llm: new ScriptedLlmClient(searchThenSubmit()),
    });
    cleanups.push(() => server.close());
    const runId = await askAs(server, ALICE_TOKEN);
    const client = await server.connect(ALICE_TOKEN);
    failWrites = true;

    const result = await call(client, "feedback", { runId, outcome: "resolved" });

    expect(result.isError).toBe(true);
    expect(result.structured).toEqual({ errorClass: "audit_write_failed" });
    expect(result.text).not.toContain("dev-only-sink-detail");
    expect(result.text).not.toContain(runId);
    expect(feedbackRecords(gateway, runId)).toEqual([]);
  });

  it("Gateway の run API が応答しなければ、期限(feedbackTimeoutMs)で失敗を返して枠を返す", async () => {
    const gateway = await startGateway({
      connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])],
    });
    cleanups.push(() => gateway.close());
    // tools/list は実 Gateway、feedback の申告は応答しない(signal にも従わない)クライアント
    const factory: GatewayClientFactory = (options) => {
      const inner = new McpGatewayClient(options);
      return {
        listTools: (callOptions) => inner.listTools(callOptions),
        callTool: (name, args, meta, callOptions) => inner.callTool(name, args, meta, callOptions),
        startRun: (input, callOptions) => inner.startRun(input, callOptions),
        finishRun: (runId, input, callOptions) => inner.finishRun(runId, input, callOptions),
        feedbackRun: () => new Promise(() => undefined),
        close: () => inner.close(),
      };
    };
    const server = await startOrchestratorServer({
      gatewayUrl: gateway.url,
      llm: new ScriptedLlmClient(searchThenSubmit()),
      createGatewayClient: factory,
      feedbackTimeoutMs: 200,
    });
    cleanups.push(() => server.close());
    const client = await server.connect(ALICE_TOKEN);

    const started = Date.now();
    const result = await call(client, "feedback", { runId: "dev-only-run", outcome: "resolved" });

    expect(result.isError).toBe(true);
    expect(result.structured).toEqual({ errorClass: "gateway_timeout" });
    expect(result.text).toBe("フィードバックを記録できませんでした。時間をおいて再度お試しください。");
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(FEEDBACK_TIMEOUT_MS).toBe(10_000);
    expect(server.limits.feedback.active).toBe(0);
    expect(gateway.records()).toEqual([]);
  });
});
