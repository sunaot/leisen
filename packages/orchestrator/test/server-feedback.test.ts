/**
 * T-021 受け入れ条件3: feedback は run の利用者本人だけが更新でき、他人の run は拒否される。
 *
 * - 本人確認: Gateway の tools/list の最初のソースに describe を1回呼び、結果の `_meta` の
 *   userId(Gateway が認証した利用者)で recordFeedback する。監査に describe が1件残る
 *   (feedback 用に別に採番した runId。対象 run の ToolInvocation には混ぜない)
 * - alice の run に alice のトークン → 更新(JSONL に userFeedback 付きの行が追記される)
 * - bob のトークン → feedback_forbidden(JSONL は変わらない)
 * - 未知の runId → run_not_found、不正な引数 → invalid_request、利用者を確認できない → user_unverified
 * - エラーの文言は固定文言で、入力(runId)をエコーしない
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedLlmClient } from "../src/index.js";
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
  let counter = 0;
  const server = await startOrchestratorServer({
    gatewayUrl: gateway.url,
    llm: new ScriptedLlmClient(searchThenSubmit()),
    newVerificationRunId: () => `feedback-check-${(counter += 1)}`,
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

describe("feedback: 本人だけが更新できる", () => {
  it("alice の run に alice のトークン → userFeedback 付きの AnswerRun を JSONL に追記する", async () => {
    const { gateway, server } = await setup();
    const runId = await askAs(server, ALICE_TOKEN);
    const client = await server.connect(ALICE_TOKEN);

    const result = await call(client, "feedback", { runId, outcome: "resolved" });

    expect(result).toEqual({
      isError: false,
      text: "フィードバック(解決した)を記録しました。",
      structured: { runId, outcome: "resolved" },
    });
    const runs = (await server.answerRunLines()).filter((record) => record.runId === runId);
    expect(runs.map((record) => [record.finalOutcome, record.userFeedback])).toEqual([
      ["pending", null],
      ["resolved", null],
      ["resolved", "resolved"],
    ]);
    expect(runs.at(-1)?.userId).toBe("alice");
    // 本人確認の describe は feedback 用の runId で1件。対象 run の ToolInvocation は増えない
    expect(gateway.toolInvocations("feedback-check-1")).toEqual([
      expect.objectContaining({ tool: "describe", sourceId: "alpha", userId: "alice", iteration: 0 }),
    ]);
    expect(gateway.toolInvocations(runId).map((record) => record.tool)).toEqual([
      "describe",
      "search",
    ]);

    // 同じ利用者は評価を付け直せる(後の行が採られる)
    const again = await call(client, "feedback", { runId, outcome: "unresolved" });
    expect(again.text).toBe("フィードバック(解決しなかった)を記録しました。");
    expect((await server.answerRunLines()).at(-1)).toMatchObject({
      runId,
      userFeedback: "unresolved",
    });
  });

  it("bob のトークンで alice の run に feedback すると feedback_forbidden(JSONL は変わらない)", async () => {
    const { server } = await setup();
    const runId = await askAs(server, ALICE_TOKEN);
    const before = await server.answerRunLines();
    const bob = await server.connect(BOB_TOKEN);

    const result = await call(bob, "feedback", { runId, outcome: "unresolved" });

    expect(result.isError).toBe(true);
    expect(result.structured).toEqual({ errorClass: "feedback_forbidden" });
    expect(result.text).toBe(
      "この回答にはフィードバックを記録できません(質問した本人だけが記録できます)。",
    );
    expect(result.text).not.toContain(runId);
    expect(await server.answerRunLines()).toEqual(before);
  });

  it("未知の runId は run_not_found(runId をエコーしない)", async () => {
    const { server } = await setup();
    const client = await server.connect(ALICE_TOKEN);
    const unknown = "dev-only-unknown-run";

    const result = await call(client, "feedback", { runId: unknown, outcome: "resolved" });

    expect(result.isError).toBe(true);
    expect(result.structured).toEqual({ errorClass: "run_not_found" });
    expect(result.text).not.toContain(unknown);
    expect(await server.answerRunLines()).toEqual([]);
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
  });

  it("Gateway に検索できるソースがなく利用者を確認できなければ user_unverified", async () => {
    const { server } = await setup([]);
    const client = await server.connect(ALICE_TOKEN);

    const result = await call(client, "feedback", { runId: "r-1", outcome: "resolved" });

    expect(result.isError).toBe(true);
    expect(result.structured).toEqual({ errorClass: "user_unverified" });
  });
});
