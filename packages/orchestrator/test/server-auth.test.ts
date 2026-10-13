/**
 * T-021 受け入れ条件1: Orchestrator の MCP サーバー(leisen-ask serve の HTTP 層)の認証の前段。
 *
 * - Bearer なし・形式不正・無効な Bearer の initialize / tools/list / tools/call は 401
 *   (JSON-RPC のディスパッチ前、固定文言)。IdP 不達(Gateway の 503)と Gateway 不達は 503。
 *   応答しない Gateway も preflight 全体(initialize → notifications/initialized → tools/list)
 *   の期限で 503(セキュリティレビュー m1)
 * - 拒否したリクエストでは LLM(ScriptedLlmClient の要求数)もコネクタ(呼び出し記録)も
 *   呼ばれず、Gateway の監査(ToolInvocation)も増えない
 * - 有効な Bearer は Gateway の tools/list(preflight)を通ってからディスパッチされる。
 *   preflight の結果はキャッシュしない(トークンの失効に次のリクエストで従う)
 * - GET / DELETE は 405、未知のパスは 404、GET /healthz は認証不要
 * - 応答・エラーにトークンを載せない
 *
 * 実 Gateway(port 0、モック IdP、コーパス型のモックコネクタ)を相手にする。
 */
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { IdpError } from "@leisen/gateway";
import { PREFLIGHT_TIMEOUT_MS, ScriptedLlmClient } from "../src/index.js";
import {
  ALICE_TOKEN,
  CorpusConnector,
  EXPENSE_POLICY,
  startGateway,
  type GatewayHarness,
} from "./helpers/harness.js";
import {
  RAW_BODIES,
  connectMcpClient,
  rawPost,
  searchThenSubmit,
  startOrchestratorServer,
  type OrchestratorServerHarness,
} from "./helpers/orchestrator-server.js";
import { startStalledMcpServer } from "./helpers/mock-http.js";

const INVALID_TOKEN = "dev-only-invalid-token";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

interface Setup {
  readonly gateway: GatewayHarness;
  readonly server: OrchestratorServerHarness;
  readonly llm: ScriptedLlmClient;
  readonly alpha: CorpusConnector;
}

async function setup(options: { gatewayUrl?: string } = {}): Promise<Setup> {
  const alpha = new CorpusConnector("alpha", [EXPENSE_POLICY]);
  const gateway = await startGateway({ connectors: [alpha] });
  cleanups.push(() => gateway.close());
  const llm = new ScriptedLlmClient(searchThenSubmit());
  const server = await startOrchestratorServer({
    gatewayUrl: options.gatewayUrl ?? gateway.url,
    llm,
  });
  cleanups.push(() => server.close());
  return { gateway, server, llm, alpha };
}

/** 何も呼ばれていないこと(LLM・コネクタ・Gateway の監査)。 */
function expectNothingCalled({ llm, alpha, gateway }: Setup): void {
  expect(llm.requests).toHaveLength(0);
  expect(alpha.calls).toHaveLength(0);
  expect(gateway.toolInvocations()).toEqual([]);
}

async function rejectionOf(response: Response): Promise<{
  status: number;
  text: string;
  body: { error?: { message?: string; data?: { errorClass?: string } } };
}> {
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as never };
}

const METHODS = Object.keys(RAW_BODIES) as (keyof typeof RAW_BODIES)[];

describe("認証の前段: Bearer がない・形式不正(Gateway にも問い合わせない)", () => {
  it.each(METHODS)("%s: Authorization なしは 401(www-authenticate: Bearer)", async (method) => {
    const context = await setup();
    const response = await rawPost(context.server.url, RAW_BODIES[method]);
    const { status, body } = await rejectionOf(response);

    expect(status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.error).toEqual({
      code: -32000,
      message: "a valid bearer session token is required",
      data: { errorClass: "unauthenticated" },
    });
    expect(context.gateway.idp.authenticatedTokens).toEqual([]);
    expectNothingCalled(context);
  });

  it.each([
    ["Basic スキーム", "Basic ZGV2LW9ubHk6eA=="],
    ["空の Bearer", "Bearer "],
    ["トークンに空白", "Bearer dev-only-a dev-only-b"],
  ])("%s は 401(IdP に問い合わせない)", async (_label, authorization) => {
    const context = await setup();
    for (const method of METHODS) {
      const response = await rawPost(context.server.url, RAW_BODIES[method], authorization);
      expect((await rejectionOf(response)).status).toBe(401);
    }
    expect(context.gateway.idp.authenticatedTokens).toEqual([]);
    expectNothingCalled(context);
  });
});

describe("認証の前段: 無効な Bearer(Gateway の判断に従う)", () => {
  it.each(METHODS)("%s: Gateway が拒否したトークンは 401(invalid_token)。トークンをエコーしない", async (method) => {
    const context = await setup();
    const response = await rawPost(
      context.server.url,
      RAW_BODIES[method],
      `Bearer ${INVALID_TOKEN}`,
    );
    const { status, text, body } = await rejectionOf(response);

    expect(status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
    expect(body.error?.data?.errorClass).toBe("unauthenticated");
    expect(body.error?.message).toBe("a valid bearer session token is required");
    expect(text).not.toContain(INVALID_TOKEN);
    // Gateway の IdP が検証した(preflight)が、ツール呼び出しには進んでいない
    expect(context.gateway.idp.authenticatedTokens).toContain(INVALID_TOKEN);
    expectNothingCalled(context);
  });

  it("SDK の MCP クライアントも無効なトークンでは接続できない(initialize が 401)", async () => {
    const context = await setup();
    await expect(connectMcpClient(context.server.url, INVALID_TOKEN)).rejects.toMatchObject({
      code: 401,
    });
    await expect(connectMcpClient(context.server.url)).rejects.toMatchObject({ code: 401 });
    expectNothingCalled(context);
  });
});

describe("認証の前段: Gateway・IdP に届かない", () => {
  it.each(METHODS)("%s: IdP 不達(Gateway の 503)は 503 gateway_unavailable", async (method) => {
    const context = await setup();
    context.gateway.idp.failWith = new IdpError("idp_unavailable", "dev-only idp down");
    const response = await rawPost(context.server.url, RAW_BODIES[method], `Bearer ${ALICE_TOKEN}`);
    const { status, text, body } = await rejectionOf(response);

    expect(status).toBe(503);
    expect(body.error).toEqual({
      code: -32000,
      message: "the gateway is unavailable",
      data: { errorClass: "gateway_unavailable" },
    });
    expect(text).not.toContain("dev-only idp down");
    expect(text).not.toContain(ALICE_TOKEN);
    expectNothingCalled(context);
  });

  it("Gateway に接続できなければ 503(LLM は呼ばない)", async () => {
    // 閉じたポート(接続拒否)
    const closed = createServer();
    closed.listen(0, "127.0.0.1");
    await once(closed, "listening");
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const context = await setup({ gatewayUrl: `http://127.0.0.1:${port}/mcp` });
    for (const method of METHODS) {
      const response = await rawPost(context.server.url, RAW_BODIES[method], `Bearer ${ALICE_TOKEN}`);
      const { status, body } = await rejectionOf(response);
      expect(status).toBe(503);
      expect(body.error?.data?.errorClass).toBe("gateway_unavailable");
    }
    expectNothingCalled(context);
  });

  it.each([
    ["initialize に応答しない", false],
    ["initialize には応答し、notifications/initialized に応答しない", true],
  ])("Gateway が %s なら preflight 全体の期限で 503(LLM は呼ばない)", async (_label, respondToInitialize) => {
    const stalled = await startStalledMcpServer({ respondToInitialize });
    cleanups.push(() => stalled.close());
    const llm = new ScriptedLlmClient(searchThenSubmit());
    const server = await startOrchestratorServer({
      gatewayUrl: `${stalled.url}/mcp`,
      llm,
      preflightTimeoutMs: 200,
    });
    cleanups.push(() => server.close());

    const started = Date.now();
    const response = await rawPost(server.url, RAW_BODIES["tools/list"], `Bearer ${ALICE_TOKEN}`);
    const { status, text, body } = await rejectionOf(response);

    expect(status).toBe(503);
    expect(body.error).toEqual({
      code: -32000,
      message: "the gateway is unavailable",
      data: { errorClass: "gateway_unavailable" },
    });
    expect(text).not.toContain(ALICE_TOKEN);
    // 既定は 10 秒。ここでは 200ms で打ち切られ、1リクエストの期限(同じ 200ms)の積み重ねを待たない
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(PREFLIGHT_TIMEOUT_MS).toBe(10_000);
    expect(stalled.methods[0]).toBe("initialize");
    if (respondToInitialize) {
      expect(stalled.methods).toContain("notifications/initialized");
      expect(stalled.methods).not.toContain("tools/list");
    }
    expect(llm.requests).toHaveLength(0);
  });

  it("Gateway の URL のパスを誤っている(Gateway が 404)なら 500 internal_error", async () => {
    const alpha = new CorpusConnector("alpha", [EXPENSE_POLICY]);
    const gateway = await startGateway({ connectors: [alpha] });
    cleanups.push(() => gateway.close());
    const context = await setup({ gatewayUrl: gateway.url.replace(/\/mcp$/, "/wrong") });
    const response = await rawPost(
      context.server.url,
      RAW_BODIES["tools/list"],
      `Bearer ${ALICE_TOKEN}`,
    );
    const { status, body } = await rejectionOf(response);
    expect(status).toBe(500);
    expect(body.error).toEqual({
      code: -32000,
      message: "internal error",
      data: { errorClass: "internal_error" },
    });
    expect(context.llm.requests).toHaveLength(0);
  });
});

describe("有効な Bearer", () => {
  it("preflight(Gateway の tools/list)を通ってから tools/list をディスパッチする", async () => {
    const context = await setup();
    const client = await connectMcpClient(context.server.url, ALICE_TOKEN);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(["ask", "feedback"]);
    } finally {
      await client.close();
    }
    // Gateway は利用者のトークンで検証している(Orchestrator は検証しない)
    expect(context.gateway.idp.authenticatedTokens).toContain(ALICE_TOKEN);
    expectNothingCalled(context);
  });

  it("preflight の結果をキャッシュしない: IdP が止まれば次のリクエストから 503", async () => {
    const context = await setup();
    const first = await rawPost(context.server.url, RAW_BODIES["tools/list"], `Bearer ${ALICE_TOKEN}`);
    expect(first.status).toBe(200);
    context.gateway.idp.failWith = new IdpError("idp_unavailable", "dev-only idp down");
    const second = await rawPost(context.server.url, RAW_BODIES["tools/list"], `Bearer ${ALICE_TOKEN}`);
    expect(second.status).toBe(503);
  });
});

describe("ルーティング", () => {
  it("GET / DELETE の /mcp は 405(Allow: POST)。認証より前に返す", async () => {
    const context = await setup();
    for (const method of ["GET", "DELETE", "PUT"]) {
      const response = await fetch(context.server.url, {
        method,
        headers: { authorization: `Bearer ${ALICE_TOKEN}` },
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(((await response.json()) as { error: { data: unknown } }).error.data).toEqual({
        errorClass: "invalid_request",
      });
    }
    expect(context.gateway.idp.authenticatedTokens).toEqual([]);
  });

  it("GET /healthz は認証不要で {status: ok}。POST は 405、未知のパスは 404", async () => {
    const context = await setup();
    const health = await fetch(`${context.server.origin}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const postHealth = await fetch(`${context.server.origin}/healthz`, { method: "POST" });
    expect(postHealth.status).toBe(405);
    expect(postHealth.headers.get("allow")).toBe("GET");

    const unknown = await rawPost(`${context.server.origin}/other`, RAW_BODIES["tools/list"], `Bearer ${ALICE_TOKEN}`);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { data: unknown } }).error.data).toEqual({
      errorClass: "not_found",
    });
    expect(context.gateway.idp.authenticatedTokens).toEqual([]);
  });
});
