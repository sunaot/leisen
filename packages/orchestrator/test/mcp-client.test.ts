/**
 * McpGatewayClient: 実 Gateway(port 0)に Streamable HTTP で接続する。
 * - 毎リクエストに `Authorization: Bearer <セッショントークン>` を付ける
 * - ツール結果の isError を正規化エラー(errorClass を本文の JSON から読む)に写す
 * - 結果の `_meta` から Gateway が認証した userId を読む(成功・失敗とも。H1)
 * - セッショントークンをエラー・例外メッセージ・シリアライズ結果に出さない(不変条件6)
 * - 接続先はループバック以外 https 必須、資格情報・クエリ・フラグメント付きは拒否(m3)
 * - 接続(initialize → notifications/initialized)にも呼び出しの signal が効き、close は接続の
 *   完了を待たない(応答しない Gateway で止まらない。セキュリティレビュー m1)
 */
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GATEWAY_RESULT_META_KEYS, IdpError } from "@kp/gateway";
import {
  GatewayClientError,
  McpGatewayClient,
  buildGatewayMeta,
  normalizeCallResult,
} from "../src/index.js";
import {
  ALICE_TOKEN,
  BOB_TOKEN,
  CorpusConnector,
  EXPENSE_POLICY,
  startGateway,
  type GatewayHarness,
} from "./helpers/harness.js";
import { startMockHttpServer, startStalledMcpServer } from "./helpers/mock-http.js";

const harnesses: GatewayHarness[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
  for (const close of closers.splice(0)) {
    await close();
  }
});

async function setup(notConnected: string[] = []): Promise<GatewayHarness> {
  const harness = await startGateway({
    connectors: [
      new CorpusConnector("alpha", [EXPENSE_POLICY]),
      new CorpusConnector("beta", []),
    ],
    notConnected,
  });
  harnesses.push(harness);
  return harness;
}

const META = buildGatewayMeta({ runId: "run-mcp-client", iteration: 0 });

async function rejectionOf(promise: Promise<unknown>): Promise<GatewayClientError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(GatewayClientError);
  return error as GatewayClientError;
}

function expectNoToken(error: unknown, token: string): void {
  const err = error as Error;
  expect(err.message).not.toContain(token);
  expect(String(err.stack)).not.toContain(token);
  expect(JSON.stringify(err)).not.toContain(token);
  expect(inspect(err, { depth: 5 })).not.toContain(token);
}

describe("McpGatewayClient", () => {
  it("初期化・tools/list・tools/call のすべてに利用者のセッショントークンを Bearer で付ける", async () => {
    const harness = await setup();
    const client = harness.client(ALICE_TOKEN);

    const tools = await client.listTools();
    const outcome = await client.callTool(
      "search",
      { source: "alpha", query: "経費精算" },
      META,
    );

    expect(tools.map((t) => t.name).sort()).toEqual(["describe", "fetch", "list", "search"]);
    expect(outcome).toMatchObject({
      ok: true,
      result: { hits: [expect.objectContaining({ documentId: "doc-expense-policy" })] },
    });
    // initialize / notifications/initialized / tools/list / tools/call(毎リクエスト認証)
    expect(harness.idp.authenticatedTokens.length).toBeGreaterThanOrEqual(3);
    expect(new Set(harness.idp.authenticatedTokens)).toEqual(new Set([ALICE_TOKEN]));
    // `_meta` は Gateway に届き、監査レコードに記録される
    expect(harness.toolInvocations("run-mcp-client")).toHaveLength(1);
  });

  it("ツール結果の isError を正規化エラー(errorClass / message)に写す", async () => {
    const harness = await setup(["beta"]);
    const client = harness.client();

    const outcome = await client.callTool("search", { source: "beta", query: "x" }, META);

    expect(outcome).toEqual({
      ok: false,
      error: { errorClass: "source_not_connected", message: "source not connected" },
      userId: "alice",
    });
  });

  it("結果の `_meta` から Gateway が認証した userId を読む(利用者ごとに異なる。H1)", async () => {
    const harness = await setup();
    const [forAlice, forBob] = await Promise.all([
      harness.client(ALICE_TOKEN).callTool("search", { source: "alpha", query: "経費精算" }, META),
      harness.client(BOB_TOKEN).callTool("search", { source: "alpha", query: "経費精算" }, META),
    ]);
    expect(forAlice).toMatchObject({ ok: true, userId: "alice" });
    expect(forBob).toMatchObject({ ok: true, userId: "bob" });
  });

  it("Gateway が拒否したトークンは unauthenticated。トークンをエラーに出さない", async () => {
    const harness = await setup();
    const token = "dev-only-secret-session-token-zzz";
    const client = harness.client(token);

    const error = await rejectionOf(client.listTools());

    expect(error.errorClass).toBe("unauthenticated");
    expectNoToken(error, token);
    // クライアント自体をシリアライズ・表示してもトークンは出ない
    expect(JSON.stringify(client)).not.toContain(token);
    expect(inspect(client, { depth: 10 })).not.toContain(token);
  });

  it("IdP 不達(503)・接続不能は gateway_unavailable", async () => {
    const harness = await setup();
    harness.idp.failWith = new IdpError("idp_unavailable", "introspection unreachable");
    const error = await rejectionOf(harness.client().listTools());
    expect(error.errorClass).toBe("gateway_unavailable");

    // listen していないポート
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const unreachable = new McpGatewayClient({
      url: `http://127.0.0.1:${port}/mcp`,
      sessionToken: ALICE_TOKEN,
    });
    closers.push(() => unreachable.close());
    const refused = await rejectionOf(unreachable.listTools());
    expect(refused.errorClass).toBe("gateway_unavailable");
    expectNoToken(refused, ALICE_TOKEN);
  });

  it.each([
    ["initialize に応答しない", false],
    ["notifications/initialized に応答しない", true],
  ])("Gateway が %s とき、接続も呼び出しの signal で打ち切る(1リクエストの期限を待たない)", async (_label, respondToInitialize) => {
    const stalled = await startStalledMcpServer({ respondToInitialize });
    closers.push(() => stalled.close());
    // 1リクエストの期限は既定(60 秒)のまま
    const client = new McpGatewayClient({ url: `${stalled.url}/mcp`, sessionToken: ALICE_TOKEN });
    closers.push(() => client.close());

    const started = Date.now();
    const error = await rejectionOf(client.listTools({ signal: AbortSignal.timeout(100) }));

    expect(error.errorClass).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(2_000);
    expectNoToken(error, ALICE_TOKEN);
    expect(stalled.methods).not.toContain("tools/list");
  });

  it("接続の途中(initialize に応答しない Gateway)でも close は待たずに閉じ、進行中の呼び出しは失敗する", async () => {
    const stalled = await startStalledMcpServer({ respondToInitialize: false });
    closers.push(() => stalled.close());
    const client = new McpGatewayClient({ url: `${stalled.url}/mcp`, sessionToken: ALICE_TOKEN });
    const pending = rejectionOf(client.listTools());
    for (let i = 0; i < 100 && stalled.methods.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(stalled.methods).toEqual(["initialize"]);

    const started = Date.now();
    await client.close();
    const error = await pending;

    expect(Date.now() - started).toBeLessThan(2_000);
    expectNoToken(error, ALICE_TOKEN);
    // 閉じた後の呼び出しは接続し直さない
    expect((await rejectionOf(client.listTools())).errorClass).toBe("gateway_protocol_error");
    expect(stalled.methods).toEqual(["initialize"]);
  });

  it("誤ったパスは gateway_protocol_error", async () => {
    const harness = await setup();
    const client = new McpGatewayClient({
      url: harness.url.replace("/mcp", "/not-mcp"),
      sessionToken: ALICE_TOKEN,
    });
    closers.push(() => client.close());
    expect((await rejectionOf(client.listTools())).errorClass).toBe("gateway_protocol_error");
  });

  it.each([
    [403, "gateway_forbidden"],
    [401, "unauthenticated"],
    [404, "gateway_protocol_error"],
    [415, "gateway_protocol_error"],
    [409, "gateway_rejected"],
    [429, "gateway_unavailable"],
    [503, "gateway_unavailable"],
  ] as const)("HTTP %s は %s(応答本文を例外に載せない。issue #38)", async (status, errorClass) => {
    const server = await startMockHttpServer(() => ({
      status,
      body: { jsonrpc: "2.0", id: null, error: { code: -32000, message: "dev-only upstream detail" } },
    }));
    closers.push(() => server.close());
    const client = new McpGatewayClient({ url: `${server.url}/mcp`, sessionToken: ALICE_TOKEN });
    closers.push(() => client.close());

    const error = await rejectionOf(client.listTools());

    expect(error.errorClass).toBe(errorClass);
    expect(error.message).not.toContain("dev-only upstream detail");
    expectNoToken(error, ALICE_TOKEN);
  });

  it("URL・トークンの形を構築時に検証する(URL に資格情報を載せない)", () => {
    expect(() => new McpGatewayClient({ url: "not a url", sessionToken: "t" })).toThrow(
      GatewayClientError,
    );
    expect(
      () => new McpGatewayClient({ url: "ftp://gateway.example.test/mcp", sessionToken: "t" }),
    ).toThrow(GatewayClientError);
    expect(
      () =>
        new McpGatewayClient({
          url: "https://user:dev-only-pass@gateway.example.test/mcp",
          sessionToken: "t",
        }),
    ).toThrow("the gateway URL must not contain credentials");
    expect(
      () => new McpGatewayClient({ url: "http://127.0.0.1/mcp", sessionToken: "" }),
    ).toThrow(GatewayClientError);
  });

  it.each([
    "http://gateway.example.test/mcp",
    "http://10.0.0.5:8787/mcp",
    "http://127.0.0.2/mcp",
    "http://localhost.example.test/mcp",
  ])("ループバック以外への http(%s)は拒否する(セッショントークンを平文で送らない。m3)", (url) => {
    let caught: unknown;
    try {
      new McpGatewayClient({ url, sessionToken: "dev-only-t" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GatewayClientError);
    expect(caught).toMatchObject({ errorClass: "gateway_protocol_error" });
    // 固定文言(URL をエコーしない)
    expect((caught as Error).message).not.toContain(new URL(url).hostname);
  });

  it.each([
    "http://localhost:8787/mcp",
    "http://127.0.0.1:8787/mcp",
    "http://[::1]:8787/mcp",
    "https://gateway.example.test/mcp",
  ])("ループバックの http と https(%s)は受け付ける", (url) => {
    const client = new McpGatewayClient({ url, sessionToken: "dev-only-t" });
    closers.push(() => client.close());
    expect(client.endpoint).toBe(new URL(url).href);
  });

  it.each([
    "https://gateway.example.test/mcp?token=dev-only-leak",
    "https://gateway.example.test/mcp#frag",
    "https://gateway.example.test/mcp?",
    "http://127.0.0.1:8787/mcp#",
  ])("クエリ・フラグメント付きの URL(%s)は拒否する(m3)", (url) => {
    let caught: unknown;
    try {
      new McpGatewayClient({ url, sessionToken: "dev-only-t" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GatewayClientError);
    expect((caught as Error).message).toBe(
      "the gateway URL must not contain a query string or a fragment",
    );
    expect((caught as Error).message).not.toContain("dev-only-leak");
  });
});

describe("normalizeCallResult", () => {
  it("structuredContent を優先し、無ければ本文の JSON を読む", () => {
    expect(
      normalizeCallResult({ content: [{ type: "text", text: "{}" }], structuredContent: { a: 1 } }),
    ).toEqual({ ok: true, result: { a: 1 } });
    expect(normalizeCallResult({ content: [{ type: "text", text: '{"b":2}' }] })).toEqual({
      ok: true,
      result: { b: 2 },
    });
  });

  it("読めない結果・エラーは gateway_protocol_error に丸める(生の本文を流さない)", () => {
    expect(normalizeCallResult({ content: [{ type: "text", text: "not json" }] })).toMatchObject({
      ok: false,
      error: { errorClass: "gateway_protocol_error" },
    });
    expect(
      normalizeCallResult({
        isError: true,
        content: [{ type: "text", text: "Error: raw exception text" }],
      }),
    ).toMatchObject({ ok: false, error: { errorClass: "gateway_protocol_error" } });
    expect(
      normalizeCallResult({
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ errorClass: "Raw Error Text", message: "x" }),
          },
        ],
      }),
    ).toMatchObject({ ok: false, error: { errorClass: "gateway_protocol_error" } });
  });

  it("結果の `_meta` の userId を読み、形が不正なら読まない(H1)", () => {
    const key = GATEWAY_RESULT_META_KEYS.userId;
    const text = [{ type: "text", text: "{}" }];
    expect(
      normalizeCallResult({ content: text, structuredContent: { a: 1 }, _meta: { [key]: "alice" } }),
    ).toEqual({ ok: true, result: { a: 1 }, userId: "alice" });
    expect(
      normalizeCallResult({
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ errorClass: "rate_limited", message: "m" }) }],
        _meta: { [key]: "bob" },
      }),
    ).toMatchObject({ ok: false, userId: "bob" });
    for (const value of ["", 42, null, ["alice"], "a\u0000b", "a\u200Bb", "x".repeat(257)]) {
      expect(
        normalizeCallResult({ content: text, structuredContent: {}, _meta: { [key]: value } }),
      ).toEqual({ ok: true, result: {} });
    }
    // 名前空間外の userId・`_meta` 以外の場所は読まない
    expect(
      normalizeCallResult({ content: text, structuredContent: {}, _meta: { userId: "alice" } }),
    ).toEqual({ ok: true, result: {} });
    expect(
      normalizeCallResult({ content: text, structuredContent: {}, [key]: "alice" }),
    ).toEqual({ ok: true, result: {} });
  });

  it("rate_limited の retryAfterMs を保つ", () => {
    expect(
      normalizeCallResult({
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ errorClass: "rate_limited", message: "m", retryAfterMs: 1500 }),
          },
        ],
      }),
    ).toEqual({
      ok: false,
      error: { errorClass: "rate_limited", message: "m", retryAfterMs: 1500 },
    });
  });
});
