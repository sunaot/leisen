/**
 * MCPプロキシE2E(T-003受け入れ条件):
 * モックコネクタ2つを登録し、MCPクライアント(InMemoryTransport)から
 * search / fetch がプロキシ経由で通ること、認証注入・監査・エラー正規化が
 * MCP境界でも保たれることを検証する。
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AuditLogger,
  Gateway,
  createGatewayMcpServer,
  digestQuery,
  type SessionDeclaration,
} from "../src/index.js";
import {
  CollectingAuditSink,
  MockConnector,
  testConfig,
  testIdpAdapter,
} from "./helpers/proxy.js";

async function connect(
  sessionToken = "session-alice",
  declaration: SessionDeclaration = {},
) {
  const alpha = new MockConnector("alpha");
  const beta = new MockConnector("beta");
  const sink = new CollectingAuditSink();
  const gateway = new Gateway({
    config: testConfig(),
    idpAdapter: testIdpAdapter(),
    connectors: [alpha, beta],
    auditLogger: new AuditLogger(sink),
  });

  // トランスポート層でセッショントークンを検証し、確立済みセッションに
  // 束縛されたMCPサーバーを接続する(1接続=1セッション)
  const session = await gateway.establishSession(sessionToken, declaration);
  const server = createGatewayMcpServer(gateway, session);
  const client = new Client({ name: "test-orchestrator", version: "0.0.1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { gateway, session, server, client, alpha, beta, sink };
}

function firstText(result: CallToolResult): unknown {
  const content = result.content[0];
  if (!content || content.type !== "text") {
    throw new Error("expected text content");
  }
  return JSON.parse(content.text);
}

describe("MCP proxy end-to-end (acceptance: search/fetch through the proxy)", () => {
  it("lists the four connector tools with enabled sources self-described", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "describe",
      "fetch",
      "list",
      "search",
    ]);
    const search = tools.find((t) => t.name === "search");
    const sourceProp = (
      search?.inputSchema.properties as Record<string, { enum?: string[] }>
    )["source"];
    expect(sourceProp?.enum?.sort()).toEqual(["alpha", "beta"]);
  });

  it("routes search to the requested connector and returns truncated hits", async () => {
    const { client, alpha, beta, sink } = await connect();
    const result = (await client.callTool({
      name: "search",
      arguments: { source: "alpha", query: "hello world" },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const payload = firstText(result) as {
      hits: { documentId: string; snippet: string }[];
    };
    expect(payload.hits).toHaveLength(1);
    expect(payload.hits[0]?.documentId).toBe("alpha-doc-1");

    // 本人資格情報で対象コネクタのみが呼ばれる
    expect(alpha.calls).toHaveLength(1);
    expect(alpha.calls[0]?.auth.userId).toBe("alice");
    expect(beta.calls).toHaveLength(0);
    // MCP経由でも監査は正確に1レコード
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({
      recordType: "tool_invocation",
      tool: "search",
      sourceId: "alpha",
      userId: "alice",
      queryDigest: digestQuery("hello world"),
      returnedHitCount: 1,
    });
  });

  it("routes fetch to the other connector through the same proxy", async () => {
    const { client, alpha, beta, sink } = await connect();
    const result = (await client.callTool({
      name: "fetch",
      arguments: { source: "beta", documentId: "beta-doc-9" },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const payload = firstText(result) as { documentId: string; content: string };
    expect(payload.documentId).toBe("beta-doc-9");
    expect(payload.content).toContain("beta");
    expect(beta.calls).toHaveLength(1);
    expect(beta.calls[0]?.auth.credential).toMatchObject({
      kind: "oauth_bearer",
      accessToken: "stub-access-alice-beta",
    });
    expect(alpha.calls).toHaveLength(0);
    expect(sink.records[0]).toMatchObject({ tool: "fetch", fetchedDocCount: 1 });
  });

  it("supports list and describe through the proxy", async () => {
    const { client } = await connect();
    const list = (await client.callTool({
      name: "list",
      arguments: { source: "alpha" },
    })) as CallToolResult;
    expect((firstText(list) as { entries: unknown[] }).entries).toHaveLength(1);

    const describe = (await client.callTool({
      name: "describe",
      arguments: { source: "beta" },
    })) as CallToolResult;
    expect(firstText(describe)).toMatchObject({ sourceId: "beta" });
  });

  it("honours orchestrator-declared runId/iteration via _meta (ADR-011)", async () => {
    const { client, sink } = await connect();
    await client.callTool({
      name: "search",
      arguments: { source: "alpha", query: "q" },
      _meta: { runId: "run-e2e", iteration: 3 },
    });
    expect(sink.records[0]).toMatchObject({ runId: "run-e2e", iteration: 3 });
  });

  it("returns a normalized in-band error for unknown sources (no raw internals)", async () => {
    const { client } = await connect();
    const result = (await client.callTool({
      name: "search",
      arguments: { source: "gamma", query: "q" },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatchObject({ errorClass: "unknown_source" });
  });

  it("rejects malformed tool arguments as invalid_request", async () => {
    const { client, alpha, beta } = await connect();
    const result = (await client.callTool({
      name: "search",
      arguments: { source: "alpha" }, // queryなし
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatchObject({ errorClass: "invalid_request" });
    expect(alpha.calls).toHaveLength(0);
    expect(beta.calls).toHaveLength(0);
  });

  it("rejects scheduled sessions at the MCP boundary too (ADR-015)", async () => {
    const { client, alpha } = await connect("session-alice", {
      executionClass: "scheduled",
      actor: { kind: "agent", agentId: "cron-1", onBehalfOfChain: ["alice"] },
    });
    const result = (await client.callTool({
      name: "search",
      arguments: { source: "alpha", query: "q" },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatchObject({
      errorClass: "execution_class_rejected",
    });
    expect(alpha.calls).toHaveLength(0);
  });

  it("never leaks the session token or access token through MCP responses", async () => {
    const { client } = await connect();
    const results = await Promise.all([
      client.listTools(),
      client.callTool({
        name: "search",
        arguments: { source: "alpha", query: "q" },
      }),
      client.callTool({
        name: "search",
        arguments: { source: "gamma", query: "q" },
      }),
    ]);
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain("session-alice");
    expect(serialized).not.toContain("stub-access-");
  });
});
