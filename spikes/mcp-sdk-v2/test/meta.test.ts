/**
 * (iv) _meta 独自キーの見え方と、ハンドラ ctx に届く HTTP 情報(両 era)。
 * createMcpHandler を fetch 経由でインプロセスに叩く(v2 で InMemoryTransport が
 * 2025年版しか繋がらないことの代替。docs/migration/support-2026-07-28.md「In-process testing」)。
 */
import { describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Server, createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { Client as V1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as V1Transport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport as V1TransportIF } from "@modelcontextprotocol/sdk/shared/transport.js";
import { META_ITERATION, META_RUN_ID } from "../src/gateway-mcp-v2.js";

function metaProbe(eras: string[]): Server {
  const server = new Server({ name: "meta-probe", version: "0" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/call", async (request, ctx) => ({
    content: [],
    structuredContent: {
      paramsMeta: request.params._meta ?? null,
      ctxMeta: ctx.mcpReq._meta ?? null,
      envelopeKeys: Object.keys(ctx.mcpReq.envelope ?? {}),
      authInfoClientId: ctx.http?.authInfo?.clientId ?? null,
      authorizationHeaderSeen: ctx.http?.req?.headers.has("authorization") ?? false,
      sessionId: ctx.sessionId ?? null,
      // @deprecated だが機能する。legacy はリクエストごとの新インスタンスで initialize を見ないため undefined
      negotiated: server.getNegotiatedProtocolVersion() ?? null,
      eras,
    },
  }));
  return server;
}

const meta = { [META_RUN_ID]: "run-x", [META_ITERATION]: 3 };
const edgeAuth: AuthInfo = { token: "opaque", clientId: "kp-gateway-edge", scopes: [] };

describe("(iv) custom _meta keys and handler context", () => {
  it("delivers prefixed _meta keys to both request.params._meta and ctx.mcpReq._meta in both eras", async () => {
    const eras: string[] = [];
    const handler = createMcpHandler((ctx) => {
      eras.push(ctx.era);
      return metaProbe(eras);
    });
    const url = new URL("http://in-process.test/mcp");
    const fetchInProcess = (input: string | URL, init?: RequestInit) =>
      handler.fetch(new Request(input, init), { authInfo: edgeAuth });
    const requestInit = { headers: { authorization: "Bearer opaque" } };
    const modern = new Client({ name: "v2", version: "0" }, { versionNegotiation: { mode: "auto" } });
    const legacy = new V1Client({ name: "v1", version: "0" });
    try {
      await modern.connect(new StreamableHTTPClientTransport(url, { fetch: fetchInProcess, requestInit }));
      await legacy.connect(new V1Transport(url, { fetch: fetchInProcess, requestInit }) as V1TransportIF);
      // v2 の CallToolResult.structuredContent は unknown(v1 は Record<string, unknown>)
      type Seen = Record<string, unknown> | undefined;
      const fromModern = (await modern.callTool({ name: "probe", arguments: {}, _meta: meta })).structuredContent as Seen;
      const fromLegacy = (await legacy.callTool({ name: "probe", arguments: {}, _meta: meta })).structuredContent as Seen;
      console.log("modern ctx:", JSON.stringify(fromModern));
      console.log("legacy ctx:", JSON.stringify(fromLegacy));
      for (const seen of [fromModern, fromLegacy]) {
        expect(seen).toMatchObject({
          paramsMeta: meta,
          ctxMeta: meta,
          authInfoClientId: "kp-gateway-edge",
          authorizationHeaderSeen: true,
          sessionId: null,
        });
      }
      // 予約キー io.modelcontextprotocol/* は _meta から外され envelope に移る(modern のみ)
      expect(fromModern?.["envelopeKeys"]).toEqual([
        "io.modelcontextprotocol/protocolVersion",
        "io.modelcontextprotocol/clientInfo",
        "io.modelcontextprotocol/clientCapabilities",
      ]);
      expect(Object.keys(fromModern?.["ctxMeta"] as object)).toEqual([META_RUN_ID, META_ITERATION]);
      expect(fromLegacy?.["envelopeKeys"]).toEqual([]);
      expect([fromModern?.["negotiated"], fromLegacy?.["negotiated"]]).toEqual(["2026-07-28", null]);
    } finally {
      await modern.close();
      await legacy.close();
      await handler.close();
    }
    // ファクトリはリクエストごと: modern は discover + call、legacy は initialize + initialized + call
    expect([...eras].sort()).toEqual(["legacy", "legacy", "legacy", "modern", "modern"]);
  });
});
