/**
 * (i) 2026-07-28 版: v2 Client ↔ v2 サーバー(createMcpHandler + 実物の Gateway コア)。
 * server/discover・resultType・ttlMs/cacheScope・Mcp-Method/Mcp-Name の実挙動を固定する。
 */
import { describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";
import { META_ITERATION, META_RUN_ID } from "../src/gateway-mcp-v2.js";
import {
  ALICE, MODERN, envelope, postRaw, recordingFetch, resultOf, startGateway, type Exchange,
} from "./helpers.js";

describe("(i) 2026-07-28: v2 Client ↔ v2 server", () => {
  it("keeps the public version constants on the 2025 list; modern revisions are only visible on the wire", () => {
    // v1 1.30.1 と同一。定数の突き合わせでは v2 の 2026-07-28 対応を検知できない
    // (回帰テストは server/discover の supportedVersions で固定する: 下のテスト)
    expect(LATEST_PROTOCOL_VERSION).toBe("2025-11-25");
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"]);
  });

  it("negotiates via server/discover, then serves tools/list → tools/call without a session", async () => {
    const gw = await startGateway();
    const exchanges: Exchange[] = [];
    const client = new Client(
      { name: "v2-orchestrator", version: "0.0.0" },
      { versionNegotiation: { mode: "auto" } }, // 既定は 'legacy'(2025年版の initialize)
    );
    try {
      await client.connect(
        new StreamableHTTPClientTransport(gw.url, {
          requestInit: { headers: ALICE },
          fetch: recordingFetch(exchanges),
        }),
      );
      expect(client.getProtocolEra()).toBe("modern");
      const { tools } = await client.listTools();
      await client.listTools(); // ttlMs 内はクライアントのキャッシュが返す(POST は増えない)
      expect(tools.map((t) => t.name).sort()).toEqual(["describe", "fetch", "list", "search"]);
      const result = await client.callTool({
        name: "search",
        arguments: { source: "alpha", query: "hello" },
        _meta: { [META_RUN_ID]: "run-v2", [META_ITERATION]: 2 },
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
      await gw.close();
    }

    const wire = exchanges.map((e) => [e.method, e.rpc, e.status, e.req.get("mcp-method"), e.req.get("mcp-name")]);
    console.log("modern wire [http, rpc, status, Mcp-Method, Mcp-Name]:", JSON.stringify(wire));
    expect(wire).toEqual([
      ["POST", "server/discover", 200, "server/discover", null],
      ["POST", "tools/list", 200, "tools/list", null],
      ["POST", "tools/call", 200, "tools/call", "search"],
    ]);
    for (const e of exchanges) {
      expect(e.req.get("mcp-protocol-version")).toBe(MODERN);
      expect(e.req.get("mcp-session-id")).toBeNull();
      expect(e.res.get("mcp-session-id")).toBeNull();
      expect(e.res.get("content-type")).toMatch(/^application\/json/); // responseMode 'auto' の既定
    }

    const [discover, list, call] = await Promise.all(exchanges.map(resultOf));
    console.log("discover result:", JSON.stringify(discover));
    // 自動付与: resultType は全結果、ttlMs/cacheScope は cacheable な結果のみ
    expect(discover).toMatchObject({
      supportedVersions: [MODERN],
      resultType: "complete",
      ttlMs: 0, // cacheHints 未指定の既定値
      cacheScope: "private",
    });
    expect(list).toMatchObject({ resultType: "complete", ttlMs: 300000, cacheScope: "private" });
    expect(call).toMatchObject({
      resultType: "complete",
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "kp-gateway" } },
    });
    expect(call).not.toHaveProperty("ttlMs");

    // (iv) prefix 付き _meta が監査レコードまで届く(ctx.mcpReq._meta 経由)
    expect(gw.sink.records).toHaveLength(1);
    expect(gw.sink.records[0]).toMatchObject({ userId: "alice", runId: "run-v2", iteration: 2 });
  });

  it("rejects modern requests whose MCP-Protocol-Version / Mcp-Method / Mcp-Name are missing or disagree", async () => {
    const gw = await startGateway();
    const call = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search", arguments: { source: "alpha", query: "q" }, _meta: envelope() },
    };
    const full = { ...ALICE, "mcp-protocol-version": MODERN, "mcp-method": "tools/call", "mcp-name": "search" };
    const omit = (key: string) => Object.fromEntries(Object.entries(full).filter(([k]) => k !== key));
    const cases: Array<[string, Record<string, string>, number, number | null]> = [
      ["all headers", full, 200, null],
      ["no Mcp-Method", omit("mcp-method"), 400, -32020],
      ["no Mcp-Name", omit("mcp-name"), 400, -32020],
      ["no MCP-Protocol-Version", omit("mcp-protocol-version"), 400, -32020],
      ["Mcp-Name != params.name", { ...full, "mcp-name": "fetch" }, 400, -32020],
      ["Mcp-Method != method", { ...full, "mcp-method": "tools/list" }, 400, -32020],
      ["header version != envelope", { ...full, "mcp-protocol-version": "2025-11-25" }, 400, -32020],
    ];
    try {
      for (const [label, headers, status, code] of cases) {
        const reply = await postRaw(gw.url, call, headers);
        const error = reply.message?.["error"] as { code?: number } | undefined;
        console.log(`${label}: HTTP ${reply.status} code=${error?.code ?? "-"}`);
        expect([label, reply.status, error?.code ?? null]).toEqual([label, status, code]);
      }
      const future = { ...envelope(), "io.modelcontextprotocol/protocolVersion": "2099-01-01" };
      const unsupported = await postRaw(
        gw.url,
        { ...call, params: { ...call.params, _meta: future } },
        { ...full, "mcp-protocol-version": "2099-01-01" },
      );
      expect(unsupported.status).toBe(400);
      expect(unsupported.message).toMatchObject({ error: { code: -32022, data: { supported: [MODERN] } } });
    } finally {
      await gw.close();
    }
    // ヘッダで拒否された要求はハンドラに届かない(監査は正常系の1件のみ)
    expect(gw.sink.records).toHaveLength(1);
  });
});
