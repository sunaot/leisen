/**
 * GatewayのHTTP面(T-012)のテスト。
 *
 * 認可分岐(トークン欠落・無効トークン・不明セッション)を最優先で検証する
 * (開発ルール)。happy pathはMCP SDKクライアントで初期化〜ツール呼び出しまで
 * 通し、監査レコードが記録されることを確認する(不変条件2)。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AuditLogger,
  Gateway,
  startGatewayHttpServer,
  type StartedGatewayHttpServer,
} from "../src/index.js";
import {
  CollectingAuditSink,
  MockConnector,
  testConfig,
  testIdpAdapter,
} from "./helpers/proxy.js";

let started: StartedGatewayHttpServer;
let auditSink: CollectingAuditSink;
let baseUrl: string;

beforeAll(async () => {
  auditSink = new CollectingAuditSink();
  const gateway = new Gateway({
    config: testConfig(),
    idpAdapter: testIdpAdapter(),
    connectors: [new MockConnector("alpha"), new MockConnector("beta")],
    auditLogger: new AuditLogger(auditSink),
  });
  started = await startGatewayHttpServer(gateway, { host: "127.0.0.1", port: 0 });
  baseUrl = `http://127.0.0.1:${started.port}`;
});

afterAll(async () => {
  await started.close();
});

const INITIALIZE_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.0" },
  },
};

function postMcp(headers: Record<string, string>, body: unknown) {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("healthz", () => {
  it("認証なしで200を返し、デプロイ情報を含まない", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("未知のパスは404", async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    expect(res.status).toBe(404);
  });
});

describe("認可分岐", () => {
  it("Authorizationヘッダなしの初期化は401", async () => {
    const res = await postMcp({}, INITIALIZE_BODY);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    const body = (await res.json()) as { error: { errorClass: string } };
    expect(body.error.errorClass).toBe("unauthenticated");
  });

  it("無効なトークンでの初期化は401で、トークン値をエコーしない", async () => {
    const res = await postMcp(
      { authorization: "Bearer bogus-token-value" },
      INITIALIZE_BODY,
    );
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain("bogus-token-value");
  });

  it("セッションIDなしの非initializeリクエストは、認証前に400で拒否される", async () => {
    // トークン付きでもinitializeでなければIdP認証(establishSession)まで
    // 到達させない(セキュリティレビュー minor-1: IdP呼び出しの増幅防止)
    const res = await postMcp(
      { authorization: "Bearer session-alice" },
      { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { errorClass: string } };
    expect(body.error.errorClass).toBe("invalid_request");
  });

  it("セッションIDなしのGETは400", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      headers: {
        authorization: "Bearer session-alice",
        accept: "text/event-stream",
      },
    });
    expect(res.status).toBe(400);
  });

  it("JSONでないボディは認証前に400で拒否される", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer session-alice",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("不明なmcp-session-idは404", async () => {
    const res = await postMcp(
      { "mcp-session-id": "no-such-session" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
    );
    expect(res.status).toBe(404);
  });
});

describe("MCPセッション(happy path)", () => {
  it("初期化→tools/list→search→セッション終了まで通る", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
      { requestInit: { headers: { authorization: "Bearer session-alice" } } },
    );
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "describe",
      "fetch",
      "list",
      "search",
    ]);

    const outcome = await client.callTool({
      name: "search",
      arguments: { source: "alpha", query: "hello" },
    });
    expect(outcome.isError).toBeFalsy();
    const result = outcome.structuredContent as {
      hits: { documentId: string }[];
    };
    expect(result.hits[0]?.documentId).toBe("alpha-doc-1");

    // 全ツール呼び出しが監査に1レコード残る(不変条件2)
    const records = auditSink.records.filter(
      (r) => r.recordType === "tool_invocation",
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      userId: "alice",
      sourceId: "alpha",
      tool: "search",
      returnedHitCount: 1,
    });
    // 生クエリは監査レコードに残らない(digestのみ、ADR-011)
    expect(JSON.stringify(records[0])).not.toContain("hello");

    await client.close();
  });

  it("ツールエラーは正規化エラー(errorClass)のみを返す", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
      { requestInit: { headers: { authorization: "Bearer session-alice" } } },
    );
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(transport);

    const outcome = await client.callTool({
      name: "search",
      arguments: { source: "no-such-source", query: "hello" },
    });
    expect(outcome.isError).toBe(true);
    const text = (outcome.content as { type: string; text: string }[])[0]?.text;
    expect(JSON.parse(text ?? "{}")).toMatchObject({
      errorClass: "unknown_source",
    });

    await client.close();
  });

  it("DELETEでセッションを終了すると同じセッションIDは404になる", async () => {
    const initRes = await postMcp(
      { authorization: "Bearer session-bob" },
      INITIALIZE_BODY,
    );
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await initRes.body?.cancel();

    const delRes = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId! },
    });
    expect(delRes.status).toBeLessThan(300);

    const afterRes = await postMcp(
      { "mcp-session-id": sessionId! },
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    );
    expect(afterRes.status).toBe(404);
  });
});
