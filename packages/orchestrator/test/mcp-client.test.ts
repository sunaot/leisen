/**
 * McpGatewayClient: 実 Gateway(port 0)に Streamable HTTP で接続する。
 * - 毎リクエストに `Authorization: Bearer <セッショントークン>` を付ける
 * - ツール結果の isError を正規化エラー(errorClass を本文の JSON から読む)に写す
 * - セッショントークンをエラー・例外メッセージ・シリアライズ結果に出さない(不変条件6)
 */
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GATEWAY_META_KEYS, IdpError } from "@kp/gateway";
import {
  GatewayClientError,
  McpGatewayClient,
  normalizeCallResult,
} from "../src/index.js";
import {
  ALICE_TOKEN,
  CorpusConnector,
  EXPENSE_POLICY,
  startGateway,
  type GatewayHarness,
} from "./helpers/harness.js";

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

const META = {
  [GATEWAY_META_KEYS.runId]: "run-mcp-client",
  [GATEWAY_META_KEYS.iteration]: 0,
};

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
    });
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

  it("誤ったパスは gateway_protocol_error", async () => {
    const harness = await setup();
    const client = new McpGatewayClient({
      url: harness.url.replace("/mcp", "/not-mcp"),
      sessionToken: ALICE_TOKEN,
    });
    closers.push(() => client.close());
    expect((await rejectionOf(client.listTools())).errorClass).toBe("gateway_protocol_error");
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
          url: "http://user:dev-only-pass@gateway.example.test/mcp",
          sessionToken: "t",
        }),
    ).toThrow(GatewayClientError);
    expect(
      () => new McpGatewayClient({ url: "http://127.0.0.1/mcp", sessionToken: "" }),
    ).toThrow(GatewayClientError);
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
