/**
 * ADR-022 決定 10: Gateway の認可サーバーを使う構成で、Orchestrator は受けたトークンを
 * Gateway に転送せず、RFC 8693 で Gateway 宛てに交換してから使う。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  GatewayTokenExchanger,
  protectedResourceMetadataUrl,
  ScriptedLlmClient,
  TokenExchangeError,
  type TokenExchanger,
} from "../src/index.js";
import { ALICE_TOKEN, CorpusConnector, EXPENSE_POLICY, startGateway } from "./helpers/harness.js";
import { RAW_BODIES, rawPost, searchThenSubmit, startOrchestratorServer } from "./helpers/orchestrator-server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fakeFetch(handler: (form: URLSearchParams, headers: Headers) => Response) {
  const calls: URLSearchParams[] = [];
  const impl = (async (_url: string | URL | Request, init: RequestInit = {}) => {
    const form = new URLSearchParams(String(init.body));
    calls.push(form);
    return handler(form, new Headers(init.headers));
  }) as typeof fetch;
  return { impl, calls };
}

describe("GatewayTokenExchanger", () => {
  it("token-exchange グラントを Orchestrator の資格情報で送り、期限までキャッシュする", async () => {
    let now = 0;
    const f = fakeFetch((form, headers) => {
      expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
      expect(form.get("subject_token")).toBe("client-token");
      expect(form.get("resource")).toBe("https://gw.example/mcp");
      expect(headers.get("authorization")).toBe(`Basic ${Buffer.from("leisen-orchestrator:cred-0123456789abcdef").toString("base64")}`);
      return new Response(JSON.stringify({ access_token: "gw-token", expires_in: 120 }), { status: 200 });
    });
    const exchanger = new GatewayTokenExchanger({
      tokenEndpoint: "http://gateway:8787/token",
      gatewayResource: "https://gw.example/mcp",
      credential: "cred-0123456789abcdef",
      fetchImpl: f.impl,
      now: () => now,
    });
    expect(await exchanger.exchange("client-token")).toBe("gw-token");
    expect(await exchanger.exchange("client-token")).toBe("gw-token");
    expect(f.calls).toHaveLength(1);
    now = 100_000; // 期限の 30 秒前を過ぎたら取り直す
    await exchanger.exchange("client-token");
    expect(f.calls).toHaveLength(2);
  });

  it("4xx は invalid、5xx・到達不能は unavailable", async () => {
    let status = 400;
    const f = fakeFetch(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status }));
    const exchanger = new GatewayTokenExchanger({ tokenEndpoint: "http://x/token", gatewayResource: "r", credential: "c", fetchImpl: f.impl });
    await expect(exchanger.exchange("t")).rejects.toMatchObject({ kind: "invalid" });
    status = 502;
    await expect(exchanger.exchange("t")).rejects.toMatchObject({ kind: "unavailable" });
    const down = new GatewayTokenExchanger({
      tokenEndpoint: "http://x/token",
      gatewayResource: "r",
      credential: "c",
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(down.exchange("t")).rejects.toBeInstanceOf(TokenExchangeError);
  });

  it("minLifetimeMs: キャッシュの残りが足りれば使い、足りなければ min_lifetime を添えて交換し直す", async () => {
    let now = 0;
    let expiresIn = 300;
    const f = fakeFetch(() => new Response(JSON.stringify({ access_token: `gw-${f.calls.length}`, expires_in: expiresIn }), { status: 200 }));
    const exchanger = new GatewayTokenExchanger({ tokenEndpoint: "http://x/token", gatewayResource: "r", credential: "c", fetchImpl: f.impl, now: () => now });
    await exchanger.exchange("client-token");
    expect(f.calls[0]?.get("min_lifetime")).toBeNull();
    // 残り 300 秒 - 余裕 30 秒 > 200 秒: キャッシュを使う
    expect(await exchanger.exchange("client-token", { minLifetimeMs: 200_000 })).toBe("gw-1");
    expect(f.calls).toHaveLength(1);
    // 120 秒後は残り 180 秒: 足りないので min_lifetime(秒、切り上げ)を添えて取り直す
    now = 120_000;
    expiresIn = 900;
    expect(await exchanger.exchange("client-token", { minLifetimeMs: 200_500 })).toBe("gw-2");
    expect(f.calls[1]?.get("min_lifetime")).toBe("201");
  });

  it("minLifetimeMs の交換を Gateway が拒否したら invalid(呼び出し元が 401 を返す)", async () => {
    const f = fakeFetch(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const exchanger = new GatewayTokenExchanger({ tokenEndpoint: "http://x/token", gatewayResource: "r", credential: "c", fetchImpl: f.impl });
    await expect(exchanger.exchange("t", { minLifetimeMs: 690_000 })).rejects.toMatchObject({ kind: "invalid" });
  });

  it("保護リソースメタデータの URL は resource のパスを well-known の後ろに付ける", () => {
    expect(protectedResourceMetadataUrl("https://x.example/ask/mcp")).toBe("https://x.example/.well-known/oauth-protected-resource/ask/mcp");
  });
});

describe("leisen-ask serve の受け口(認可サーバーを使う構成)", () => {
  async function setup(exchanger: TokenExchanger, askTokenLifetimeMs?: number) {
    const gateway = await startGateway({ connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])] });
    cleanups.push(() => gateway.close());
    const server = await startOrchestratorServer({
      gatewayUrl: gateway.url,
      llm: new ScriptedLlmClient(searchThenSubmit()),
      tokenExchange: exchanger,
      ...(askTokenLifetimeMs !== undefined ? { askTokenLifetimeMs } : {}),
      protectedResource: { resource: "https://leisen.example/ask/mcp", authorizationServer: "https://leisen.example" },
    });
    cleanups.push(() => server.close());
    return server;
  }

  const exchanger = (map: Record<string, string | TokenExchangeError>): TokenExchanger => ({
    async exchange(token) {
      const value = map[token] ?? new TokenExchangeError("invalid", "unknown");
      if (value instanceof TokenExchangeError) throw value;
      return value;
    },
  });

  it("交換後の Gateway 宛てトークンで preflight を通す(受けたトークンは Gateway に送らない)", async () => {
    const server = await setup(exchanger({ "orchestrator-audience-token": ALICE_TOKEN }));
    const res = await rawPost(server.url, RAW_BODIES["tools/list"], "Bearer orchestrator-audience-token");
    expect(res.status).toBe(200);
  });

  it("交換の拒否は 401(resource_metadata 付き)、Gateway 不達は 503", async () => {
    const server = await setup(
      exchanger({ down: new TokenExchangeError("unavailable", "x") }),
    );
    const invalid = await rawPost(server.url, RAW_BODIES["tools/list"], "Bearer bad");
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toBe(
      'Bearer error="invalid_token", resource_metadata="https://leisen.example/.well-known/oauth-protected-resource/ask/mcp"',
    );
    expect((await rawPost(server.url, RAW_BODIES["tools/list"], "Bearer down")).status).toBe(503);
    const missing = await rawPost(server.url, RAW_BODIES["tools/list"]);
    expect(missing.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("ask の前だけ、run に要る残り時間を添えて交換し直し、拒否されたら 401 でクライアントに更新させる", async () => {
    const seen: (number | undefined)[] = [];
    let refuseLong = true;
    const server = await setup(
      {
        async exchange(token, options) {
          seen.push(options?.minLifetimeMs);
          if (token !== "orchestrator-audience-token") throw new TokenExchangeError("invalid", "unknown");
          if (options?.minLifetimeMs !== undefined && refuseLong) throw new TokenExchangeError("invalid", "expires soon");
          return ALICE_TOKEN;
        },
      },
      690_000,
    );
    // ask 以外(tools/list)は残り時間を求めない
    expect((await rawPost(server.url, RAW_BODIES["tools/list"], "Bearer orchestrator-audience-token")).status).toBe(200);
    expect(seen).toEqual([undefined]);
    // ask: 残り時間が足りない(Gateway が拒否)なら 401 で、理由を添える
    const refused = await rawPost(server.url, RAW_BODIES["tools/call"], "Bearer orchestrator-audience-token");
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(refused.headers.get("www-authenticate")).toContain("expires before the answer run can finish");
    expect(seen).toEqual([undefined, undefined, 690_000]);
    // 更新後(足りる)なら ask を受ける
    refuseLong = false;
    expect((await rawPost(server.url, RAW_BODIES["tools/call"], "Bearer orchestrator-audience-token")).status).toBe(200);
  });

  it("保護リソースメタデータを公開する", async () => {
    const server = await setup(exchanger({}));
    const origin = new URL(server.url).origin;
    const body = (await (await fetch(`${origin}/.well-known/oauth-protected-resource/ask/mcp`)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ resource: "https://leisen.example/ask/mcp", authorization_servers: ["https://leisen.example"] });
  });
});
