/**
 * esa(ADR-023)を Token Vault と ESC の両方で使う結合テスト。
 *
 * Gateway(モック IdP)に本物の connector-esa を載せ、esa の OAuth(api.esa.io)は fetch の注入で
 * モックし、esa のリモート MCP サーバーは公式 SDK のサーバーを 127.0.0.1 で動かしたフェイクにする。
 * 確かめること:
 * - 認可要求・コード交換・更新に RFC 8707 の resource=https://mcp.esa.io を載せ、scope は mcp
 * - 本人照合は GET /v1/user の email。不一致なら保管せず失効を依頼する
 * - 上流の MCP サーバーには本人の esa トークンだけが届く(他人の・IdP のトークンは届かない)
 * - ESC: Gateway が発行するトークンは暗号文で、esa のトークンが見えない
 */
import { once } from "node:events";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { assembleGateway, parseDeploymentConfig, type AssembledGateway } from "../src/index.js";
import { jsonResponse, mockFetch, type RecordedRequest } from "./helpers/mock-fetch.js";

const opened: AssembledGateway[] = [];
const dirs: string[] = [];
const servers: HttpServer[] = [];

afterEach(async () => {
  for (const a of opened.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

const CLIENT_REDIRECT = "http://127.0.0.1:9/callback";
const ESA_RESOURCE = "https://mcp.esa.io";

async function freePort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  server.close();
  await once(server, "close");
  return port;
}

/** esa のリモート MCP サーバーのフェイク。受けた Authorization を記録する。 */
async function startFakeEsaMcp(validTokens: () => Set<string>) {
  const seen: string[] = [];
  const http = createServer((req, res) => {
    void (async () => {
      const authorization = req.headers.authorization ?? "";
      seen.push(authorization);
      if (!validTokens().has(authorization.replace(/^Bearer /, ""))) {
        res.writeHead(401).end("Missing or invalid Authorization header");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req as IncomingMessage) chunks.push(chunk as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      const server = new Server({ name: "fake-esa", version: "0.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
      server.setRequestHandler(CallToolRequestSchema, () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify([
              {
                url: "https://example-team.esa.io/posts/42",
                wip: "Shipped",
                category_and_title_and_tags: "設計/認可/本人の資格情報 #adr",
                body_md: "esa の投稿の本文",
                updated_at: "2026-11-01T10:00:00+09:00",
              },
            ]),
          },
        ],
      }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport as Transport);
      await transport.handleRequest(req, res, text === "" ? undefined : (JSON.parse(text) as unknown));
    })();
  });
  servers.push(http);
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/`, seen };
}

/** esa の OAuth(api.esa.io)のモック。 */
function esaOAuthMock(state: { email: string; issued: Set<string>; revoked: string[]; tokenRequests: RecordedRequest[] }) {
  let n = 0;
  return mockFetch({
    "POST https://api.esa.io/oauth/token": (req) => {
      state.tokenRequests.push(req);
      const form = req.form();
      if (form.get("resource") !== ESA_RESOURCE) {
        return jsonResponse({ error: "invalid_target" }, 400);
      }
      n += 1;
      const access = `esa-access-${form.get("client_id")}-${n}`;
      state.issued.add(access);
      return jsonResponse({ access_token: access, refresh_token: `esa-refresh-${n}`, token_type: "Bearer", expires_in: 7200, scope: "mcp" });
    },
    "GET https://api.esa.io/v1/user": (req) =>
      state.issued.has(String(req.headers["authorization"]).replace(/^Bearer /, ""))
        ? jsonResponse({ id: 1, name: "Alice", screen_name: "alice", email: state.email })
        : jsonResponse({ error: "unauthorized" }, 401),
    "POST https://api.esa.io/oauth/revoke": (req) => {
      state.revoked.push(String(req.form().get("token")));
      return new Response(null, { status: 200 });
    },
  });
}

async function startGateway(provider: "token_vault" | "esc") {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dir = await mkdtemp(join(tmpdir(), "leisen-esa-"));
  dirs.push(dir);
  const esa = { email: "alice@example.com", issued: new Set<string>(), revoked: [] as string[], tokenRequests: [] as RecordedRequest[] };
  const mcp = await startFakeEsaMcp(() => esa.issued);
  const yaml = `
schemaVersion: 1
deployment: { name: esa-test }
idp: { adapter: { kind: mock } }
gateway:
  http: { host: 127.0.0.1, port: ${port}, path: /mcp }
  publicBaseUrl: ${base}
  credentials:
    store: { kind: sqlite, path: ${join(dir, "state.db")} }
    keys: { kind: local }
  authorizationServer:
    enabled: ${provider === "esc"}
    orchestratorResource: ${base}/ask/mcp
    clients:
      - { clientId: test-client, name: テストクライアント, redirectUris: ["${CLIENT_REDIRECT}"] }
connectors:
  - id: esa
    kind: esa
    settings: { team: example-team, mcpUrl: "${mcp.url}" }
    auth:
      provider: ${provider}
      oauth: { preset: esa, clientId: esa-app, clientSecretEnv: ESA_APP_SECRET, scopes: [mcp] }
audit:
  sink: jsonl
  jsonl: { path: ${join(dir, "audit.jsonl")} }
`;
  const oauth = esaOAuthMock(esa);
  const specifiers: string[] = [];
  const assembled = await assembleGateway({
    config: parseDeploymentConfig(yaml),
    configDir: dir,
    fetchImpl: oauth.impl,
    // 許可表の解決(kind: esa → @leisen/connector-esa)を確かめ、実体はソースから読む
    loadModule: async (specifier) => {
      specifiers.push(specifier);
      return import("../../connector-esa/src/index.js");
    },
    env: {
      LEISEN_MOCK_SESSIONS: "alice-token=alice;email=alice@example.com,bob-token=bob;email=bob@example.com",
      LEISEN_VAULT_KEY: randomBytes(32).toString("base64"),
      LEISEN_ESC_KEY: randomBytes(32).toString("base64"),
      LEISEN_ORCHESTRATOR_CREDENTIAL: "test-orchestrator-credential-0001",
      ESA_APP_SECRET: "esa-app-secret",
    },
  });
  opened.push(assembled);
  assembled.httpServer.listen(port, "127.0.0.1");
  await once(assembled.httpServer, "listening");
  expect(specifiers).toEqual(["@leisen/connector-esa"]);
  return { base, esa, mcp };
}

class Browser {
  readonly cookies = new Map<string, string>();
  constructor(readonly base: string) {}

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = path.startsWith("http") ? path : `${this.base}${path}`;
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const eq = (pair as string).indexOf("=");
      const name = (pair as string).slice(0, eq);
      const value = (pair as string).slice(eq + 1);
      if (value === "" || /Max-Age=0/.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  post(path: string, form: Record<string, string>): Promise<Response> {
    return this.request(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
  }
}

function hidden(html: string, name: string): string {
  const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (m === null) throw new Error(`hidden field ${name} not found`);
  return m[1] as string;
}

async function mockLogin(browser: Browser, page: Response, token: string): Promise<Response> {
  expect(page.status).toBe(200);
  return browser.post("/login/mock", { state: hidden(await page.text(), "state"), token });
}

/** esa の認可画面への 302 を検査し、esa が返すコールバックを模す。 */
async function esaCallback(browser: Browser, redirect: Response): Promise<Response> {
  expect(redirect.status).toBe(302);
  const location = new URL(redirect.headers.get("location") as string);
  expect(location.origin + location.pathname).toBe("https://api.esa.io/oauth/authorize");
  expect(location.searchParams.get("resource")).toBe(ESA_RESOURCE);
  expect(location.searchParams.get("scope")).toBe("mcp");
  expect(location.searchParams.get("response_type")).toBe("code");
  expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  return browser.request(`/connections/callback?code=esa-code&state=${encodeURIComponent(location.searchParams.get("state") as string)}`);
}

async function mcpSearch(base: string, token: string) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { source: "esa", query: "認可" } } }),
  });
  const text = await response.text();
  return { status: response.status, text, isError: /"isError":true/.test(text) };
}

describe("esa を Token Vault で使う", () => {
  it("接続ページで esa に接続すると、本人の esa トークンで MCP サーバーを呼ぶ", async () => {
    const { base, esa, mcp } = await startGateway("token_vault");
    const before = await mcpSearch(base, "alice-token");
    expect(before.text).toContain("source_not_connected");
    expect(mcp.seen).toHaveLength(0);

    const browser = new Browser(base);
    await mockLogin(browser, await browser.request("/connections?source=esa"), "alice-token");
    const csrf = hidden(await (await browser.request("/connections")).text(), "csrf");
    const done = await esaCallback(browser, await browser.post("/connections/start", { csrf, source: "esa" }));
    expect(done.headers.get("location")).toContain("result=connected");
    // コード交換にも resource を載せ、client secret は本文で送る(client_secret_post)
    const exchange = esa.tokenRequests[0]?.form();
    expect(exchange?.get("grant_type")).toBe("authorization_code");
    expect(exchange?.get("resource")).toBe(ESA_RESOURCE);
    expect(exchange?.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,}$/);

    const after = await mcpSearch(base, "alice-token");
    expect(after.isError).toBe(false);
    expect(after.text).toContain("本人の資格情報");
    expect(after.text).toContain("post:42");
    // 上流に届いたのは本人の esa トークンだけ(IdP のトークンは届かない)
    expect(mcp.seen.at(-1)).toBe("Bearer esa-access-esa-app-1");
    expect(mcp.seen.some((h) => h.includes("alice-token"))).toBe(false);
    // 他人(bob)には alice の接続を使わない(不変条件4)
    expect((await mcpSearch(base, "bob-token")).text).toContain("source_not_connected");

    const csrf2 = hidden(await (await browser.request("/connections")).text(), "csrf");
    await browser.post("/connections/disconnect", { csrf: csrf2, source: "esa" });
    // RFC 7009 で更新トークンの失効を依頼する
    expect(esa.revoked).toEqual(["esa-refresh-1"]);
  });

  it("本人照合: esa のメールアドレスが IdP と違えば保管せず、失効を依頼する", async () => {
    const { base, esa } = await startGateway("token_vault");
    esa.email = "alice@personal.example";
    const browser = new Browser(base);
    await mockLogin(browser, await browser.request("/connections?source=esa"), "alice-token");
    const csrf = hidden(await (await browser.request("/connections")).text(), "csrf");
    const done = await esaCallback(browser, await browser.post("/connections/start", { csrf, source: "esa" }));
    expect(done.status).toBe(403);
    expect(await done.text()).toContain("一致しません");
    expect(esa.revoked).toEqual(["esa-refresh-1"]);
    expect((await mcpSearch(base, "alice-token")).text).toContain("source_not_connected");
  });
});

describe("esa を ESC で使う", () => {
  it("同意画面で esa に接続し、Gateway が発行した暗号文のトークンで検索できる", async () => {
    const { base, mcp } = await startGateway("esc");
    const browser = new Browser(base);
    const verifier = randomBytes(32).toString("base64url");
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "test-client",
      redirect_uri: CLIENT_REDIRECT,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: "client-state",
      scope: "mcp",
    });
    const loggedIn = await mockLogin(browser, await browser.request(`/authorize?${params}`), "alice-token");
    const consent = await (await browser.request(loggedIn.headers.get("location") as string)).text();
    const back = await esaCallback(browser, await browser.post("/authorize/connect", { tx: hidden(consent, "tx"), csrf: hidden(consent, "csrf"), source: "esa" }));
    const html = await (await browser.request(back.headers.get("location") as string)).text();
    const decided = await browser.post("/authorize/decision", { tx: hidden(html, "tx"), csrf: hidden(html, "csrf"), decision: "allow" });
    const code = new URL(decided.headers.get("location") as string).searchParams.get("code") as string;
    const token = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CLIENT_REDIRECT, client_id: "test-client", code_verifier: verifier }),
    });
    const body = (await token.json()) as Record<string, string>;
    expect(body["scope"]).toBe("mcp source:esa");
    // 中継者(MCP クライアント)には esa のトークンが見えない
    expect(body["access_token"]).not.toContain("esa-access");

    const result = await mcpSearch(base, body["access_token"] as string);
    expect(result.isError).toBe(false);
    expect(result.text).toContain("post:42");
    expect(mcp.seen.at(-1)).toBe("Bearer esa-access-esa-app-1");
    expect(mcp.seen.some((h) => h.includes(body["access_token"] as string))).toBe(false);
  });
});

describe("設定の検証(ADR-023)", () => {
  const yaml = (preset: string) => `
schemaVersion: 1
deployment: { name: esa-config }
idp: { adapter: { kind: mock } }
connectors:
  - id: src
    kind: dev-fixture
    settings: { corpusFile: fixtures/dev-corpus.yaml }
    auth:
      provider: token_vault
      oauth: { preset: ${preset}, clientId: c, clientSecretEnv: S, resource: "https://mcp.example" }
audit: { sink: stdout }
`;

  it("oauth.resource は esa / custom のプリセットだけに書ける", () => {
    expect(() => parseDeploymentConfig(yaml("esa"))).not.toThrow();
    for (const preset of ["github", "google", "slack"]) {
      expect(() => parseDeploymentConfig(yaml(preset))).toThrow(/resource/);
    }
  });
});
