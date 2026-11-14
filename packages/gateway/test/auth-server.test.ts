/**
 * 接続ページと認可サーバーの結合テスト(ADR-022、T-004)。モック IdP + dev-fixture コネクタで
 * Gateway を実際に listen させ、ブラウザ・MCP クライアント・Orchestrator の役を fetch で演じる。
 * ソース(GitHub)の OAuth は fetch の注入でモックする。
 *
 * 認可分岐を優先して確かめる: 未接続、本人照合の不一致、CSRF・state の取り違え、受け手の不一致、
 * リフレッシュトークンの再利用、利用停止、esc の step-up、監査の事象。
 */
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { parseAuditRecord } from "@leisen/audit";
import { assembleGateway, parseDeploymentConfig, DeploymentConfigError, type AssembledGateway } from "../src/index.js";
import { jsonResponse, mockFetch } from "./helpers/mock-fetch.js";

const EXAMPLES_DIR = fileURLToPath(new URL("../../../examples/", import.meta.url));
const opened: AssembledGateway[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const a of opened.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  server.close();
  await once(server, "close");
  return port;
}

const ORCH_CRED = "test-orchestrator-credential-0001";
const ADMIN_CRED = "a".repeat(40);
const CLIENT_REDIRECT = "http://127.0.0.1:9/callback";

/** GitHub の OAuth のモック。emails はメールアドレスの検証済み一覧。 */
function githubMock(state: { emails: string[]; refreshCount: number; revoked: string[] }) {
  return mockFetch({
    "POST https://github.com/login/oauth/access_token": (req) => {
      const form = req.form();
      if (form.get("grant_type") === "refresh_token") {
        state.refreshCount += 1;
        return jsonResponse({ access_token: `ghu_refreshed_${state.refreshCount}`, refresh_token: `ghr_${state.refreshCount}`, expires_in: 28800 });
      }
      return jsonResponse({ access_token: `ghu_${form.get("client_id")}_${form.get("code")}`, refresh_token: "ghr_0", expires_in: 28800 });
    },
    "GET https://api.github.com/user/emails": () => jsonResponse(state.emails.map((email) => ({ email, verified: true }))),
    "DELETE https://api.github.com/applications/vault-app/token": (req) => {
      state.revoked.push(String((req.json() as { access_token: string }).access_token));
      return new Response(null, { status: 204 });
    },
    "DELETE https://api.github.com/applications/esc-app/token": (req) => {
      state.revoked.push(String((req.json() as { access_token: string }).access_token));
      return new Response(null, { status: 204 });
    },
  });
}

async function startGateway(options: { authorizationServer?: boolean; acceptIdpTokens?: boolean } = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dir = await mkdtemp(join(tmpdir(), "leisen-auth-"));
  dirs.push(dir);
  const auditPath = join(dir, "audit.jsonl");
  const as = options.authorizationServer ?? true;
  const yaml = `
schemaVersion: 1
deployment: { name: auth-test }
idp: { adapter: { kind: mock } }
gateway:
  http: { host: 127.0.0.1, port: ${port}, path: /mcp }
  publicBaseUrl: ${base}
  credentials:
    store: { kind: sqlite, path: ${join(dir, "state.db")} }
    keys: { kind: local }
  authorizationServer:
    enabled: ${as}
    acceptIdpTokens: ${options.acceptIdpTokens ?? false}
    orchestratorResource: ${base}/ask/mcp
    clients:
      - { clientId: test-client, name: テストクライアント, redirectUris: ["${CLIENT_REDIRECT}"] }
connectors:
  - id: vault-docs
    kind: dev-fixture
    settings: { corpusFile: fixtures/dev-corpus.yaml }
    auth:
      provider: token_vault
      oauth: { preset: github, clientId: vault-app, clientSecretEnv: VAULT_APP_SECRET }
${as ? `  - id: esc-docs
    kind: dev-fixture
    settings: { corpusFile: fixtures/dev-corpus.yaml }
    auth:
      provider: esc
      oauth: { preset: github, clientId: esc-app, clientSecretEnv: ESC_APP_SECRET }
  - id: esc-other
    kind: dev-fixture
    settings: { corpusFile: fixtures/dev-corpus.yaml }
    auth:
      provider: esc
      oauth: { preset: github, clientId: esc-app, clientSecretEnv: ESC_APP_SECRET }` : ""}
audit:
  sink: jsonl
  jsonl: { path: ${auditPath} }
`;
  const config = parseDeploymentConfig(yaml);
  const gh = { emails: ["alice@example.com"], refreshCount: 0, revoked: [] as string[] };
  const fetchMock = githubMock(gh);
  const assembled = await assembleGateway({
    config,
    configDir: EXAMPLES_DIR,
    fetchImpl: fetchMock.impl,
    env: {
      LEISEN_MOCK_SESSIONS: "alice-token=alice;email=alice@example.com,bob-token=bob;email=bob@example.com",
      LEISEN_VAULT_KEY: randomBytes(32).toString("base64"),
      LEISEN_ESC_KEY: randomBytes(32).toString("base64"),
      LEISEN_ORCHESTRATOR_CREDENTIAL: ORCH_CRED,
      LEISEN_ADMIN_CREDENTIAL: ADMIN_CRED,
      VAULT_APP_SECRET: "vault-app-secret",
      ESC_APP_SECRET: "esc-app-secret",
    },
  });
  opened.push(assembled);
  assembled.httpServer.listen(port, "127.0.0.1");
  await once(assembled.httpServer, "listening");
  const audit = async () => {
    await assembled.auditLogger.flush();
    const text = await readFile(auditPath, "utf8").catch(() => "");
    return text.split("\n").filter((l) => l !== "").map((l) => parseAuditRecord(JSON.parse(l)));
  };
  return { base, gh, fetchMock, assembled, audit };
}

/** Cookie を保つブラウザ役。 */
class Browser {
  readonly cookies = new Map<string, string>();
  constructor(readonly base: string) {}

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = path.startsWith("http") ? path : `${this.base}${path}`;
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    }
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

/** モック IdP のログインフォームを通す。 */
async function mockLogin(browser: Browser, page: Response, token: string): Promise<Response> {
  expect(page.status).toBe(200);
  const html = await page.text();
  return browser.post("/login/mock", { state: hidden(html, "state"), token });
}

/** ソースの認可画面への 302 から state を取り出し、ソースが返すコールバックを模す。 */
async function sourceCallback(browser: Browser, redirect: Response, code = "c1"): Promise<Response> {
  expect(redirect.status).toBe(302);
  const location = new URL(redirect.headers.get("location") as string);
  expect(location.origin).toBe("https://github.com");
  expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  return browser.request(`/connections/callback?code=${code}&state=${encodeURIComponent(location.searchParams.get("state") as string)}`);
}

async function mcpCall(base: string, token: string, source: string, path = "/mcp") {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { source, query: "設計" } } }),
  });
  const text = await response.text();
  return { response, text, isError: /"isError":true/.test(text) };
}

describe("接続ページ(token_vault)", () => {
  it("ログイン → 接続 → 本人のトークンで検索でき、解除でソースへ失効を依頼する", async () => {
    const { base, gh, audit } = await startGateway({ authorizationServer: false });
    // 未接続: source_not_connected に接続ページの URL が添えられる
    const before = await mcpCall(base, "alice-token", "vault-docs");
    expect(before.isError).toBe(true);
    expect(before.text).toContain("source_not_connected");
    expect(before.text).toContain(`${base}/connections?source=vault-docs`);

    const browser = new Browser(base);
    const loggedIn = await mockLogin(browser, await browser.request("/connections?source=vault-docs"), "alice-token");
    expect(loggedIn.status).toBe(302);
    expect(loggedIn.headers.get("location")).toBe("/connections?source=vault-docs");
    const page = await (await browser.request("/connections")).text();
    expect(page).toContain("未接続");
    const csrf = hidden(page, "csrf");
    const done = await sourceCallback(browser, await browser.post("/connections/start", { csrf, source: "vault-docs" }));
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toContain("result=connected");

    const after = await mcpCall(base, "alice-token", "vault-docs");
    expect(after.isError).toBe(false);
    // 他人(bob)には alice の接続を使わない(不変条件4)
    expect((await mcpCall(base, "bob-token", "vault-docs")).text).toContain("source_not_connected");

    const csrf2 = hidden(await (await browser.request("/connections")).text(), "csrf");
    await browser.post("/connections/disconnect", { csrf: csrf2, source: "vault-docs" });
    expect(gh.revoked).toEqual(["ghu_vault-app_c1"]);
    expect((await mcpCall(base, "alice-token", "vault-docs")).text).toContain("source_not_connected");

    const events = (await audit()).filter((r) => r.recordType === "credential_event");
    expect(events.map((r) => (r as { event: string }).event)).toEqual(["connect_started", "connected", "disconnected"]);
    // 監査にトークン・メールアドレスを残さない
    const raw = JSON.stringify(await audit());
    expect(raw).not.toContain("ghu_");
    expect(raw).not.toContain("alice@example.com");
  });

  it("本人照合: ソース側の検証済みメールが一致しなければ保管せず、トークンを失効させる", async () => {
    const { base, gh, audit } = await startGateway({ authorizationServer: false });
    gh.emails = ["alice@personal.example"];
    const browser = new Browser(base);
    await mockLogin(browser, await browser.request("/connections"), "alice-token");
    const csrf = hidden(await (await browser.request("/connections")).text(), "csrf");
    const result = await sourceCallback(browser, await browser.post("/connections/start", { csrf, source: "vault-docs" }));
    expect(result.status).toBe(403);
    expect(await result.text()).toContain("一致しません");
    expect(gh.revoked).toHaveLength(1);
    expect((await mcpCall(base, "alice-token", "vault-docs")).text).toContain("source_not_connected");
    const failed = (await audit()).find((r) => r.recordType === "credential_event" && r.event === "connect_failed");
    expect(failed).toMatchObject({ reason: "identity_mismatch", sourceId: "vault-docs" });
  });

  it("CSRF トークンのない操作と、別のブラウザに渡した state を拒否する", async () => {
    const { base } = await startGateway({ authorizationServer: false });
    const alice = new Browser(base);
    await mockLogin(alice, await alice.request("/connections"), "alice-token");
    expect((await alice.post("/connections/start", { source: "vault-docs" })).status).toBe(403);
    const csrf = hidden(await (await alice.request("/connections")).text(), "csrf");
    const redirect = await alice.post("/connections/start", { csrf, source: "vault-docs" });
    // bob のブラウザで alice の state を使う(接続の乗っ取り)
    const bob = new Browser(base);
    await mockLogin(bob, await bob.request("/connections"), "bob-token");
    const hijack = await sourceCallback(bob, redirect);
    expect(hijack.status).toBe(400);
    expect((await mcpCall(base, "bob-token", "vault-docs")).text).toContain("source_not_connected");
  });

  it("ログインの state をほかのブラウザで使わせない(nonce Cookie)", async () => {
    const { base } = await startGateway({ authorizationServer: false });
    const a = new Browser(base);
    const html = await (await a.request("/connections")).text();
    const b = new Browser(base);
    const res = await b.post("/login/mock", { state: hidden(html, "state"), token: "alice-token" });
    expect(res.status).toBe(400);
  });
});

/** /authorize から code を得て、トークンに交換する。 */
async function authorize(base: string, options: { connect?: string[]; resource?: string; token?: string } = {}) {
  const browser = new Browser(base);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: "test-client",
    redirect_uri: CLIENT_REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "client-state",
    scope: "mcp",
    ...(options.resource !== undefined ? { resource: options.resource } : {}),
  });
  const loggedIn = await mockLogin(browser, await browser.request(`/authorize?${params}`), options.token ?? "alice-token");
  expect(loggedIn.status).toBe(302);
  let consentUrl = loggedIn.headers.get("location") as string;
  for (const source of options.connect ?? []) {
    const html = await (await browser.request(consentUrl)).text();
    const back = await sourceCallback(
      browser,
      await browser.post("/authorize/connect", { tx: hidden(html, "tx"), csrf: hidden(html, "csrf"), source }),
      `code-${source}`,
    );
    expect(back.status).toBe(302);
    consentUrl = back.headers.get("location") as string;
  }
  const html = await (await browser.request(consentUrl)).text();
  const decided = await browser.post("/authorize/decision", { tx: hidden(html, "tx"), csrf: hidden(html, "csrf"), decision: "allow" });
  const location = new URL(decided.headers.get("location") as string);
  expect(location.origin + location.pathname).toBe(CLIENT_REDIRECT);
  expect(location.searchParams.get("state")).toBe("client-state");
  expect(location.searchParams.get("iss")).toBe(base);
  const code = location.searchParams.get("code") as string;
  const token = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CLIENT_REDIRECT, client_id: "test-client", code_verifier: verifier }),
  });
  return { status: token.status, body: (await token.json()) as Record<string, string>, code, verifier };
}

async function tokenRequest(base: string, form: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

describe("MCP 認可サーバーと ESC", () => {
  it("メタデータを公開し、トークンのない MCP 要求の 401 に resource_metadata を添える", async () => {
    const { base } = await startGateway();
    const prm = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    expect(prm).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] });
    const asm = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(asm).toMatchObject({ issuer: base, code_challenge_methods_supported: ["S256"] });
    expect(asm["registration_endpoint"]).toBeUndefined();
    const res = await mcpCall(base, "", "esc-docs");
    expect(res.response.status).toBe(401);
    expect(res.response.headers.get("www-authenticate")).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("IdP のトークンの直接提示は拒否する(acceptIdpTokens: false)", async () => {
    const { base } = await startGateway();
    expect((await mcpCall(base, "alice-token", "vault-docs")).response.status).toBe(401);
  });

  it("同意画面で esc のソースを接続し、発行されたトークンで検索できる。未接続の esc は step-up(403)", async () => {
    const { base, audit } = await startGateway();
    const { status, body } = await authorize(base, { connect: ["esc-docs"] });
    expect(status).toBe(200);
    expect(body["token_type"]).toBe("Bearer");
    expect(body["scope"]).toBe("mcp source:esc-docs");
    // ESC は暗号文: 中継者にはソースのトークンが見えない
    expect(body["access_token"]).not.toContain("ghu_");
    expect(Buffer.from((body["access_token"] as string).split(".")[3] as string, "base64url").toString("latin1")).not.toContain("ghu_");
    const ok = await mcpCall(base, body["access_token"] as string, "esc-docs");
    expect(ok.response.status).toBe(200);
    expect(ok.isError).toBe(false);
    const stepUp = await mcpCall(base, body["access_token"] as string, "esc-other");
    expect(stepUp.response.status).toBe(403);
    expect(stepUp.response.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(stepUp.response.headers.get("www-authenticate")).toContain("source:esc-other");
    const events = (await audit()).filter((r) => r.recordType === "credential_event").map((r) => (r as { event: string }).event);
    expect(events).toEqual(["connect_started", "connected", "token_issued"]);
  });

  it("認可コードは 1 回限り。PKCE の不一致・他クライアントは invalid_grant", async () => {
    const { base } = await startGateway();
    const first = await authorize(base);
    expect(first.status).toBe(200);
    const replay = await tokenRequest(base, { grant_type: "authorization_code", code: first.code, redirect_uri: CLIENT_REDIRECT, client_id: "test-client", code_verifier: first.verifier });
    expect(replay).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    // コードの再利用で系列を拒否する: 最初に出したトークンも使えなくなる
    expect((await mcpCall(base, first.body["access_token"] as string, "vault-docs")).response.status).toBe(401);
  });

  it("リフレッシュでトークンを入れ替え、使用済みの再提示で系列ごと拒否する", async () => {
    const { base, audit } = await startGateway();
    const { body } = await authorize(base, { connect: ["esc-docs"] });
    const refreshed = await tokenRequest(base, { grant_type: "refresh_token", refresh_token: body["refresh_token"] as string, client_id: "test-client" });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body["refresh_token"]).not.toBe(body["refresh_token"]);
    expect((await mcpCall(base, refreshed.body["access_token"] as string, "esc-docs")).isError).toBe(false);
    const reuse = await tokenRequest(base, { grant_type: "refresh_token", refresh_token: body["refresh_token"] as string, client_id: "test-client" });
    expect(reuse).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    expect((await mcpCall(base, refreshed.body["access_token"] as string, "esc-docs")).response.status).toBe(401);
    const second = await tokenRequest(base, { grant_type: "refresh_token", refresh_token: refreshed.body["refresh_token"] as string, client_id: "test-client" });
    expect(second.status).toBe(400);
    expect((await audit()).some((r) => r.recordType === "credential_event" && r.event === "token_reuse_detected")).toBe(true);
  });

  it("別のクライアントとしてのリフレッシュ・登録されていないクライアントを拒否する", async () => {
    const { base } = await startGateway();
    const { body } = await authorize(base);
    expect((await tokenRequest(base, { grant_type: "refresh_token", refresh_token: body["refresh_token"] as string, client_id: "unknown" })).status).toBe(401);
    const res = await fetch(`${base}/authorize?client_id=test-client&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&response_type=code`, { redirect: "manual" });
    expect(res.status).toBe(400); // 登録外のリダイレクト先へは飛ばさない
  });

  it("Orchestrator 宛てのトークンは Gateway で使えず、RFC 8693 の交換で Gateway 宛てになる", async () => {
    const { base } = await startGateway();
    const { body } = await authorize(base, { connect: ["esc-docs"], resource: `${base}/ask/mcp` });
    expect((await mcpCall(base, body["access_token"] as string, "esc-docs")).response.status).toBe(401);
    const exchangeForm = {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: body["access_token"] as string,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      resource: `${base}/mcp`,
    };
    const basic = (secret: string) => ({ authorization: `Basic ${Buffer.from(`leisen-orchestrator:${secret}`).toString("base64")}` });
    expect((await tokenRequest(base, exchangeForm, basic("wrong-credential-000000000"))).status).toBe(401);
    const exchanged = await tokenRequest(base, exchangeForm, basic(ORCH_CRED));
    expect(exchanged.status).toBe(200);
    expect(exchanged.body["issued_token_type"]).toBe("urn:ietf:params:oauth:token-type:access_token");
    expect(exchanged.body["refresh_token"]).toBeUndefined();
    expect((await mcpCall(base, exchanged.body["access_token"] as string, "esc-docs")).isError).toBe(false);
    // Gateway 宛てのトークンを交換に出しても受けない(受け手の取り違え)
    expect((await tokenRequest(base, { ...exchangeForm, subject_token: exchanged.body["access_token"] as string }, basic(ORCH_CRED))).status).toBe(400);
  });

  it("/revoke で系列を失効させ、esc のソースのトークンもソースへ失効を依頼する", async () => {
    const { base, gh } = await startGateway();
    const { body } = await authorize(base, { connect: ["esc-docs"] });
    const res = await fetch(`${base}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: body["refresh_token"] as string, client_id: "test-client" }),
    });
    expect(res.status).toBe(200);
    expect(gh.revoked).toEqual(["ghu_esc-app_code-esc-docs"]);
    expect((await mcpCall(base, body["access_token"] as string, "esc-docs")).response.status).toBe(401);
  });

  it("利用停止: 管理 API で Vault の削除とソースへの失効、発行済みトークンの拒否", async () => {
    const { base, gh } = await startGateway();
    const browser = new Browser(base);
    await mockLogin(browser, await browser.request("/connections"), "alice-token");
    const csrf = hidden(await (await browser.request("/connections")).text(), "csrf");
    await sourceCallback(browser, await browser.post("/connections/start", { csrf, source: "vault-docs" }));
    const { body } = await authorize(base, { connect: ["esc-docs"] });
    expect((await mcpCall(base, body["access_token"] as string, "vault-docs")).isError).toBe(false);

    const unauthorized = await fetch(`${base}/admin/deprovision`, { method: "POST", body: JSON.stringify({ userId: "alice" }) });
    expect(unauthorized.status).toBe(401);
    const res = await fetch(`${base}/admin/deprovision`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_CRED}`, "content-type": "application/json" },
      body: JSON.stringify({ userId: "alice" }),
    });
    expect(await res.json()).toEqual({ revokedAtSource: 1, deleted: 1, sourceRevocationFailed: [] });
    expect(gh.revoked).toContain("ghu_vault-app_c1");
    expect((await mcpCall(base, body["access_token"] as string, "esc-docs")).response.status).toBe(401);
    expect((await tokenRequest(base, { grant_type: "refresh_token", refresh_token: body["refresh_token"] as string, client_id: "test-client" })).status).toBe(400);
  });
});

describe("セキュリティレビューの指摘の回帰(HTTP)", () => {
  it("M1: ログイン後の戻り先は接続ページ配下だけ(タブ・別オリジンへ飛ばさない)", async () => {
    const { base } = await startGateway({ authorizationServer: false });
    for (const ret of ["/%09/evil.example", "//evil.example", "https://evil.example/", "/connections\t/evil"]) {
      const browser = new Browser(base);
      const done = await mockLogin(browser, await browser.request(`/login?return=${encodeURIComponent(decodeURIComponent(ret))}`), "alice-token");
      expect(done.headers.get("location")).toBe("/connections");
    }
  });

  it("M4: 利用停止の後は、それより前のブラウザのセッションで接続できない", async () => {
    const { base } = await startGateway({ authorizationServer: false });
    const browser = new Browser(base);
    await mockLogin(browser, await browser.request("/connections"), "alice-token");
    expect((await browser.request("/connections")).status).toBe(200);
    await fetch(`${base}/admin/deprovision`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_CRED}`, "content-type": "application/json" },
      body: JSON.stringify({ userId: "alice" }),
    });
    // セッションは無効になり、ログインからやり直しになる(モック IdP のフォーム)
    const again = await browser.request("/connections");
    expect(await again.text()).toContain("開発用ログイン");
  });

  it("M6: 未認証の /authorize を大量に送っても取引は作られず、正規の認可は通る", async () => {
    const { base } = await startGateway();
    const challenge = "a".repeat(43);
    for (let i = 0; i < 50; i++) {
      await fetch(`${base}/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent(CLIENT_REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256`, { redirect: "manual" });
    }
    expect((await authorize(base)).status).toBe(200);
  });

  it("L3: 不正な Basic ヘッダは 401 の JSON", async () => {
    const { base } = await startGateway();
    const res = await tokenRequest(base, { grant_type: "refresh_token", refresh_token: "x" }, { authorization: `Basic ${Buffer.from("%E0%A4%A:x").toString("base64")}` });
    expect(res).toMatchObject({ status: 401, body: { error: "invalid_client" } });
  });
});

describe("起動時の検証", () => {
  it("examples/deployment.credentials.yaml は秘密を環境変数で与えれば検証を通る", async () => {
    const { loadDeploymentConfig } = await import("../src/index.js");
    const dir = await mkdtemp(join(tmpdir(), "leisen-example-"));
    dirs.push(dir);
    const loaded = loadDeploymentConfig(join(EXAMPLES_DIR, "deployment.credentials.yaml"));
    const config = { ...loaded, audit: { ...loaded.audit, jsonl: { path: join(dir, "audit.jsonl") } } };
    const assembled = await assembleGateway({
      config,
      configDir: EXAMPLES_DIR,
      validateOnly: true,
      env: {
        LEISEN_KEYCLOAK_CLIENT_SECRET: "x",
        LEISEN_ESC_KEY: randomBytes(32).toString("base64"),
        LEISEN_GITHUB_APP_SECRET: "y",
        LEISEN_ESA_CLIENT_SECRET: "e",
        LEISEN_LIBRECHAT_CLIENT_SECRET: "z",
        LEISEN_ADMIN_CREDENTIAL: "q".repeat(40),
      },
    });
    opened.push(assembled);
    expect(assembled.credentialsDescription).toContain("github=token_vault");
    expect(assembled.credentialsDescription).toContain("esa=token_vault");
    expect(assembled.credentialsDescription).toContain("authorization server on");
  });

  it("esc は認可サーバーの有効化を要し、鍵・publicBaseUrl の欠落を列挙する", async () => {
    const config = parseDeploymentConfig(`
schemaVersion: 1
deployment: { name: t }
idp: { adapter: { kind: mock } }
connectors:
  - id: d
    kind: dev-fixture
    settings: { corpusFile: fixtures/dev-corpus.yaml }
    auth: { provider: esc, oauth: { preset: github, clientId: a, clientSecretEnv: S } }
`);
    const error = await assembleGateway({ config, configDir: EXAMPLES_DIR, env: { S: "x" }, validateOnly: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeploymentConfigError);
    const codes = (error as DeploymentConfigError).issues.map((i) => i.code);
    expect(codes).toContain("credentials_config_missing");
  });

  it("identityCheck: none は確認フラグを要する", async () => {
    const config = parseDeploymentConfig(`
schemaVersion: 1
deployment: { name: t }
idp: { adapter: { kind: mock } }
gateway:
  publicBaseUrl: http://127.0.0.1:1
  credentials: { store: { kind: sqlite, path: ./x.db } }
connectors:
  - id: d
    kind: dev-fixture
    settings: { corpusFile: fixtures/dev-corpus.yaml }
    auth: { provider: token_vault, oauth: { preset: github, clientId: a, clientSecretEnv: S, identityCheck: none } }
`);
    const env = { S: "x", LEISEN_VAULT_KEY: randomBytes(32).toString("hex"), LEISEN_ESC_KEY: randomBytes(32).toString("hex") };
    const error = await assembleGateway({ config, configDir: EXAMPLES_DIR, env, validateOnly: true }).catch((e: unknown) => e);
    expect((error as DeploymentConfigError).issues.map((i) => i.code)).toEqual(["identity_check_disabled_requires_confirmation"]);
  });
});
