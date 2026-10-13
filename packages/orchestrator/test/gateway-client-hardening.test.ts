/**
 * McpGatewayClient の接続先の堅牢化(T-023 セキュリティレビューの反映)。
 * - リダイレクトを追わない: Gateway の前段が別オリジンへの 307 を返しても、Orchestrator の資格情報と
 *   質問(本文)を転送しない(Node の fetch は Authorization を外すが他のヘッダと本文は転送する)
 * - run API のパスは MCP のパスと同じディレクトリの runs(Gateway と同じ規則)。接頭辞付きで公開した
 *   Gateway でも、同じホストのオリジン直下(別のバックエンドになりうる)へは送らない
 */
import { afterEach, describe, expect, it } from "vitest";
import { ORCHESTRATOR_CREDENTIAL_HEADER } from "@leisen/gateway";
import { GatewayClientError, McpGatewayClient, Orchestrator, ScriptedLlmClient, scriptedSubmit, scriptedToolUse } from "../src/index.js";
import {
  ALICE_TOKEN,
  CorpusConnector,
  EXPENSE_POLICY,
  TEST_ORCHESTRATOR_CREDENTIAL,
  startGateway,
} from "./helpers/harness.js";
import { firstHit } from "./helpers/script.js";
import { startMockHttpServer } from "./helpers/mock-http.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe("リダイレクトを追わない", () => {
  it("run API・MCP への要求が別オリジンへ 307 で転送されても、資格情報と本文を送らず失敗する", async () => {
    const received: { path: string; hasCredential: boolean; body: unknown }[] = [];
    const sink = await startMockHttpServer((request) => {
      received.push({
        path: request.path,
        hasCredential: request.headers[ORCHESTRATOR_CREDENTIAL_HEADER] !== undefined,
        body: request.body,
      });
      return { status: 201, body: { runId: "r1.k1.x.y", expiresAt: "2030-01-01T00:00:00Z", feedbackUntil: "2030-01-02T00:00:00Z" } };
    });
    cleanups.push(() => sink.close());
    const redirecting = await startMockHttpServer((request) => ({
      status: 307,
      headers: { location: `${sink.url}${request.path}` },
    }));
    cleanups.push(() => redirecting.close());

    const client = new McpGatewayClient({
      url: `${redirecting.url}/mcp`,
      sessionToken: ALICE_TOKEN,
      orchestratorCredential: TEST_ORCHESTRATOR_CREDENTIAL,
    });
    cleanups.push(() => client.close());

    await expect(client.startRun({ question: "秘密にしたい質問" })).rejects.toBeInstanceOf(GatewayClientError);
    await expect(client.listTools()).rejects.toBeInstanceOf(GatewayClientError);
    await expect(client.feedbackRun("r1.k1.x.y", "resolved")).rejects.toBeInstanceOf(GatewayClientError);
    expect(received).toEqual([]);
  });
});

describe("run API のパスは MCP のパスと同じディレクトリ", () => {
  it("接頭辞付き(/leisen/mcp)の Gateway に対して /leisen/runs を使い、run が記録される", async () => {
    const harness = await startGateway({
      connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])],
      httpPath: "/leisen/mcp",
    });
    cleanups.push(() => harness.close());
    expect(harness.url).toMatch(/\/leisen\/mcp$/);
    const llm = new ScriptedLlmClient([
      () => scriptedToolUse([{ name: "search", input: { source: "alpha", query: "締め日" } }]),
      (context) => {
        const hit = firstHit(context);
        return scriptedSubmit({
          answer: "経費精算の締め日は毎月25日です。",
          citations: [{ documentId: hit.documentId, sourceId: hit.source }],
          confidence: 0.9,
        });
      },
    ]);

    const answer = await new Orchestrator({ llm }).run({ question: "締め日は?", gateway: harness.client() });

    expect(answer.outcome).toBe("resolved");
    expect(harness.answerRuns()).toEqual([expect.objectContaining({ runId: answer.runId, finalOutcome: "resolved" })]);
    // オリジン直下の /runs は Gateway にはない
    const origin = new URL(harness.url).origin;
    const response = await fetch(`${origin}/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${ALICE_TOKEN}`, "content-type": "application/json", [ORCHESTRATOR_CREDENTIAL_HEADER]: TEST_ORCHESTRATOR_CREDENTIAL },
      body: JSON.stringify({ question: "q" }),
    });
    expect(response.status).toBe(404);
  });
});
