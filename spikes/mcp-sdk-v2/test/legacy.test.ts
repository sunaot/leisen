/**
 * (ii) 旧フロー互換: v1 系 Client(2025年版の initialize フロー)→ v2 サーバー
 * (createMcpHandler の既定 legacy: 'stateless')。v1 の Transport 型は
 * exactOptionalPropertyTypes と噛み合わないため connect 時にキャストする(v1 側の既知事項)。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Client as V1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as V1Transport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server as V1Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport as V1ServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport as V1TransportIF } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
// ルートの lock にある v1 1.29.0(この worktree の packages/gateway が使う版)
import { Client as V1_29Client } from "../../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport as V1_29Transport } from "../../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";
import type { Transport as V1_29TransportIF } from "../../../node_modules/@modelcontextprotocol/sdk/dist/esm/shared/transport.js";
import { META_ITERATION, META_RUN_ID } from "../src/gateway-mcp-v2.js";
import { ALICE, listen, postRaw, recordingFetch, startGateway, type Exchange } from "./helpers.js";

const versionOf = (path: string): string =>
  (JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as { version: string }).version;

describe("(ii) 2025-era clients against the v2 server", () => {
  it(`v1 ${versionOf("../node_modules/@modelcontextprotocol/sdk/package.json")} Client: initialize → tools/list → tools/call, no session`, async () => {
    const gw = await startGateway();
    const exchanges: Exchange[] = [];
    const transport = new V1Transport(gw.url, { requestInit: { headers: ALICE }, fetch: recordingFetch(exchanges) });
    const client = new V1Client({ name: "v1-agent", version: "0.0.0" });
    try {
      await client.connect(transport as V1TransportIF);
      expect(transport.protocolVersion).toBe("2025-11-25");
      expect(transport.sessionId).toBeUndefined();
      const list = await client.listTools();
      expect(list.tools).toHaveLength(4);
      const result = await client.callTool({
        name: "search",
        arguments: { source: "alpha", query: "hello" },
        _meta: { [META_RUN_ID]: "run-v1", [META_ITERATION]: 1 },
      });
      expect(result.isError).toBeFalsy();
      // v1 の結果スキーマはルーズなので、付いていれば素通しで見える。2025年版の応答には付かない
      expect(result).not.toHaveProperty("resultType");
      expect(list).not.toHaveProperty("ttlMs");
      expect(list).not.toHaveProperty("cacheScope");
    } finally {
      await client.close();
      await gw.close();
    }
    const wire = exchanges.map((e) => [e.method, e.rpc ?? "-", e.status]);
    console.log("legacy wire [http, rpc, status]:", JSON.stringify(wire));
    expect(wire).toEqual([
      ["POST", "initialize", 200],
      ["POST", "notifications/initialized", 202],
      ["GET", "-", 405], // スタンドアロンSSEなし。v1 Client は 405 を許容する
      ["POST", "tools/list", 200],
      ["POST", "tools/call", 200],
    ]);
    for (const e of exchanges) {
      expect(e.res.get("mcp-session-id")).toBeNull();
      expect(e.req.get("mcp-method")).toBeNull();
    }
    expect(gw.sink.records[0]).toMatchObject({ userId: "alice", runId: "run-v1", iteration: 1 });
  });

  it(`v1 ${versionOf("../../../node_modules/@modelcontextprotocol/sdk/package.json")} Client (repo lock) also connects`, async () => {
    const gw = await startGateway();
    const transport = new V1_29Transport(gw.url, { requestInit: { headers: ALICE } });
    const client = new V1_29Client({ name: "v1-agent", version: "0.0.0" });
    try {
      await client.connect(transport as V1_29TransportIF);
      expect(transport.protocolVersion).toBe("2025-11-25");
      expect((await client.listTools()).tools).toHaveLength(4);
    } finally {
      await client.close();
      await gw.close();
    }
  });

  it("answers older 2025-era clients in their own version, with or without the version header", async () => {
    const gw = await startGateway();
    const initialize = (protocolVersion: string) =>
      postRaw(gw.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "raw", version: "0" } } }, ALICE);
    try {
      for (const [requested, answered] of [
        ["2025-06-18", "2025-06-18"],
        ["2025-03-26", "2025-03-26"],
        ["2024-11-05", "2024-11-05"],
        ["2026-07-28", "2025-11-25"], // initialize で modern 版を求めても 2025 年版で返す
      ] as const) {
        const reply = await initialize(requested);
        expect([requested, reply.status, reply.message?.["result"]]).toMatchObject([requested, 200, { protocolVersion: answered }]);
        expect(reply.headers.get("mcp-session-id")).toBeNull();
      }
      const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
      const headerless = await postRaw(gw.url, list, ALICE); // 2025-03-26 以前はヘッダを送らない
      const withHeader = await postRaw(gw.url, list, { ...ALICE, "mcp-protocol-version": "2025-06-18" });
      expect([headerless.status, withHeader.status]).toEqual([200, 200]);
      expect(Object.keys(headerless.message?.["result"] as object)).toEqual(["tools"]);
      // modern 版を名乗るヘッダで envelope がない要求は modern 経路の -32602
      const mixed = await postRaw(gw.url, list, { ...ALICE, "mcp-protocol-version": "2026-07-28" });
      expect([mixed.status, mixed.message]).toMatchObject([400, { error: { code: -32602 } }]);
      // v1 と同じく Accept に text/event-stream がないと 406
      const jsonOnly = await postRaw(gw.url, list, { ...ALICE, accept: "application/json" });
      expect(jsonOnly.status).toBe(406);
      // 2025年版のセッション操作(GET のスタンドアロンSSE、DELETE)はステートレスなので 405
      const [get, del] = await Promise.all([
        fetch(gw.url, { headers: ALICE }),
        fetch(gw.url, { method: "DELETE", headers: ALICE }),
      ]);
      expect([get.status, del.status]).toEqual([405, 405]);
    } finally {
      await gw.close();
    }
  });

  it("legacy: 'reject' (modern-only) refuses the 2025 initialize with -32022, so v1 clients cannot connect", async () => {
    const gw = await startGateway({ legacy: "reject" });
    const client = new V1Client({ name: "v1-agent", version: "0.0.0" });
    try {
      const init = await postRaw(gw.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "0" } } }, ALICE);
      expect([init.status, init.message]).toMatchObject([400, { error: { code: -32022, data: { supported: ["2026-07-28"] } } }]);
      await expect(
        client.connect(new V1Transport(gw.url, { requestInit: { headers: ALICE } }) as V1TransportIF),
      ).rejects.toThrow(/-32022/);
    } finally {
      await gw.close();
    }
  });

  it("(reverse, for T-005/T-006) v2 Client in 'auto' falls back to 2025-11-25 against a v1-only server", async () => {
    // v1 1.30.1 のステートレス構成(ADR-001追補3 申し送りと同じ: リクエストごとに Server + transport)
    const http = await listen((req, res) => {
      if (req.method !== "POST") return void res.writeHead(405).end();
      const server = new V1Server({ name: "v1-only", version: "0.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: "probe", inputSchema: { type: "object" } }] }));
      const transport = new V1ServerTransport({});
      res.on("close", () => void server.close());
      server.connect(transport as V1TransportIF)
        .then(() => transport.handleRequest(req, res))
        .catch(() => void (res.headersSent || res.writeHead(500).end()));
    });
    const exchanges: Exchange[] = [];
    const client = new Client({ name: "v2-gateway-as-client", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
    try {
      await client.connect(new StreamableHTTPClientTransport(http.url, { fetch: recordingFetch(exchanges) }));
      expect(client.getProtocolEra()).toBe("legacy");
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["probe"]);
    } finally {
      await client.close();
      await http.close();
    }
    const probe = exchanges[0];
    console.log("probe against v1 server:", probe?.rpc, probe?.status, "then", exchanges[1]?.rpc);
    expect([probe?.rpc, probe?.status, exchanges[1]?.rpc]).toEqual(["server/discover", 400, "initialize"]);
  });
});
