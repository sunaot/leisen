/**
 * (iii) リクエスト単位認証(ADR-001追補3 決定1)とサーバーインスタンスの共有可否(決定2)。
 */
import { describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Server, createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { Client as V1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as V1Transport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport as V1TransportIF } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ALICE, MODERN, envelope, postRaw, startGateway } from "./helpers.js";

describe("(iii) per-request authentication", () => {
  it("answers a missing or unknown bearer token with HTTP 401 before any MCP processing", async () => {
    const gw = await startGateway();
    const modern = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { source: "alpha", query: "q" }, _meta: envelope() } };
    const headers = { "mcp-protocol-version": MODERN, "mcp-method": "tools/call", "mcp-name": "search" };
    const legacy = { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "0" } } };
    try {
      const replies = await Promise.all([
        postRaw(gw.url, modern, headers),
        postRaw(gw.url, modern, { ...headers, authorization: "Bearer session-mallory" }),
        postRaw(gw.url, legacy),
      ]);
      expect(replies.map((r) => r.status)).toEqual([401, 401, 401]);
      expect(replies[0]?.headers.get("www-authenticate")).toMatch(/^Bearer/);
    } finally {
      await gw.close();
    }
    expect(gw.alpha.calls).toHaveLength(0);
    expect(gw.sink.records).toHaveLength(0);
  });

  it("resolves the user from each request: alice (2026 era) and bob (2025 era) interleave on one endpoint", async () => {
    const gw = await startGateway();
    const alice = new Client({ name: "alice-agent", version: "0" }, { versionNegotiation: { mode: "auto" } });
    const bob = new V1Client({ name: "bob-agent", version: "0" });
    try {
      await alice.connect(new StreamableHTTPClientTransport(gw.url, { requestInit: { headers: ALICE } }));
      await bob.connect(new V1Transport(gw.url, { requestInit: { headers: { authorization: "Bearer session-bob" } } }) as V1TransportIF);
      const search = { name: "search", arguments: { source: "alpha", query: "q" } };
      await Promise.all([alice.callTool(search), bob.callTool(search), alice.callTool(search), bob.callTool(search)]);
    } finally {
      await alice.close();
      await bob.close();
      await gw.close();
    }
    expect(gw.alpha.calls.map((c) => c.auth.userId).sort()).toEqual(["alice", "alice", "bob", "bob"]);
    const invocations = gw.sink.records.flatMap((r) => (r.recordType === "tool_invocation" ? [r] : []));
    expect(invocations.map((r) => r.userId).sort()).toEqual(["alice", "alice", "bob", "bob"]);
    // runId 未申告: リクエストごとにセッションが変わるため呼び出し単位の新規 runId、iteration 0
    // (決定3の「単発run」がそのまま得られる)
    expect(new Set(invocations.map((r) => r.runId)).size).toBe(4);
    expect(invocations.every((r) => r.iteration === 0)).toBe(true);
  });
});

describe("(iii) sharing one Server instance across requests", () => {
  function probeServer(): Server {
    const server = new Server({ name: "probe", version: "0" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", async () => ({ tools: [{ name: "probe", inputSchema: { type: "object" as const } }] }));
    return server;
  }
  const toolsList = (handler: McpHttpHandler, id: number) =>
    handler.fetch(
      new Request("http://in-process.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": MODERN, "mcp-method": "tools/list" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: { _meta: envelope() } }),
      }),
    ).then((res) => res.status);
  const within = (status: Promise<number>) =>
    Promise.race([status, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1500))]);

  it("a shared instance works sequentially but silently hangs one of two concurrent requests", async () => {
    const errors: Error[] = [];
    const shared = probeServer();
    const handler = createMcpHandler(() => shared, { onerror: (e) => errors.push(e) });
    expect([await within(toolsList(handler, 1)), await within(toolsList(handler, 2))]).toEqual([200, 200]);
    const concurrent = await Promise.all([within(toolsList(handler, 3)), within(toolsList(handler, 4))]);
    console.log("shared instance, 2 concurrent requests:", JSON.stringify(concurrent), "onerror calls:", errors.length);
    expect(concurrent.sort()).toEqual([200, "timeout"]);
    expect(errors).toHaveLength(0);
    await handler.close();
  });

  it("a fresh instance per request (the factory is the shareable, stateless part) serves concurrent requests", async () => {
    let built = 0;
    const handler = createMcpHandler(() => {
      built += 1;
      return probeServer();
    });
    expect(await Promise.all([1, 2, 3].map((id) => within(toolsList(handler, id))))).toEqual([200, 200, 200]);
    expect(built).toBe(3);
    await handler.close();
  });
});
