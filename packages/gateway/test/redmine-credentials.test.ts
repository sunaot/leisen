/**
 * Redmine の OAuth2(6.1 以降、Doorkeeper)を Token Vault で使う経路(ADR-024 追補)。
 * - プリセット redmine: 端点を endpoints.apiBaseUrl(Redmine の基点 URL)から導く
 * - 本人照合 identityCheck: username: /users/current.json の login と IdP の preferred_username
 * Redmine の応答は fetch の注入でモックする(実機での確認は ADR-024 追補に記録)。
 */
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { parseAuditRecord } from "@leisen/audit";
import { assembleGateway, parseDeploymentConfig, DeploymentConfigError, type AssembledGateway } from "../src/index.js";
import { resolveEndpoints, SourceOAuthClient, usernameMatches } from "../src/credentials/oauth.js";
import { parseMockSessions } from "../src/idp/mock.js";
import { jsonResponse, mockFetch } from "./helpers/mock-fetch.js";

const EXAMPLES_DIR = fileURLToPath(new URL("../../../examples/", import.meta.url));
const REDMINE = "https://redmine.example.test/redmine";
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

function redmineMock(state: { login: string | undefined; revoked: string[]; lookupStatus: number }) {
  return mockFetch({
    [`POST ${REDMINE}/oauth/token`]: (req) => {
      const form = req.form();
      return jsonResponse({
        access_token: `rm_access_${form.get("code") ?? "refreshed"}`,
        refresh_token: "rm_refresh_0",
        token_type: "Bearer",
        expires_in: 7200,
        scope: "view_project view_issues",
      });
    },
    [`GET ${REDMINE}/users/current.json`]: () =>
      state.lookupStatus !== 200
        ? new Response(null, { status: state.lookupStatus, headers: state.lookupStatus === 302 ? { location: "https://evil.example/" } : {} })
        : jsonResponse({ user: { id: 5, ...(state.login !== undefined ? { login: state.login } : {}), firstname: "Alice" } }),
    [`POST ${REDMINE}/oauth/revoke`]: (req) => {
      state.revoked.push(String(req.form().get("token")));
      return jsonResponse({});
    },
  });
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

async function startGateway(sessions: string) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dir = await mkdtemp(join(tmpdir(), "leisen-redmine-"));
  dirs.push(dir);
  const auditPath = join(dir, "audit.jsonl");
  const config = parseDeploymentConfig(`
schemaVersion: 1
deployment: { name: redmine-test }
idp: { adapter: { kind: mock } }
gateway:
  http: { host: 127.0.0.1, port: ${port}, path: /mcp }
  publicBaseUrl: ${base}
  credentials:
    store: { kind: sqlite, path: ${join(dir, "state.db")} }
    keys: { kind: local }
connectors:
  - id: redmine
    kind: redmine
    settings: { baseUrl: "${REDMINE}/" }
    auth:
      provider: token_vault
      oauth:
        preset: redmine
        clientId: redmine-app
        clientSecretEnv: REDMINE_APP_SECRET
        scopes: [view_project, view_issues]
        endpoints: { apiBaseUrl: ${REDMINE}/ }
audit:
  sink: jsonl
  jsonl: { path: ${auditPath} }
`);
  const rm = { login: "alice" as string | undefined, revoked: [] as string[], lookupStatus: 200 };
  const fetchMock = redmineMock(rm);
  const assembled = await assembleGateway({
    config,
    configDir: EXAMPLES_DIR,
    fetchImpl: fetchMock.impl,
    // 許可表の解決(kind: redmine → @leisen/connector-redmine)。実体はソースから読む
    loadModule: async () => import("../../connector-redmine/src/index.js"),
    env: {
      LEISEN_MOCK_SESSIONS: sessions,
      LEISEN_VAULT_KEY: randomBytes(32).toString("base64"),
      LEISEN_ESC_KEY: randomBytes(32).toString("base64"),
      REDMINE_APP_SECRET: "redmine-app-secret",
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
  return { base, rm, fetchMock, audit };
}

/** ログインして接続を始め、Redmine の認可画面への 302 を受けてコールバックを模す。 */
async function connect(base: string, token: string) {
  const browser = new Browser(base);
  const login = await browser.request("/connections");
  await browser.post("/login/mock", { state: hidden(await login.text(), "state"), token });
  const csrf = hidden(await (await browser.request("/connections")).text(), "csrf");
  const redirect = await browser.post("/connections/start", { csrf, source: "redmine" });
  expect(redirect.status).toBe(302);
  const location = new URL(redirect.headers.get("location") as string);
  return { browser, location, callback: () => browser.request(`/connections/callback?code=c1&state=${encodeURIComponent(location.searchParams.get("state") as string)}`) };
}

describe("プリセット redmine(Token Vault、identityCheck: username)", () => {
  it("認可 URL は Redmine の基点 URL の /oauth/authorize で、PKCE とスコープを載せる", async () => {
    const { base } = await startGateway("alice-token=alice;username=alice");
    const { location } = await connect(base, "alice-token");
    expect(location.origin + location.pathname).toBe(`${REDMINE}/oauth/authorize`);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("scope")).toBe("view_project view_issues");
  });

  it("ログイン名が一致すれば接続し、本人照合の照会は Bearer で /users/current.json を呼ぶ", async () => {
    const { base, fetchMock, audit } = await startGateway("alice-token=alice;username=Alice");
    const done = await (await connect(base, "alice-token")).callback();
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toContain("result=connected");
    const lookup = fetchMock.requests.find((r) => r.url === `${REDMINE}/users/current.json`);
    expect(lookup?.headers["authorization"]).toBe("Bearer rm_access_c1");
    const events = (await audit()).filter((r) => r.recordType === "credential_event").map((r) => (r as { event: string }).event);
    expect(events).toEqual(["connect_started", "connected"]);
    // 監査にトークン・ログイン名を残さない
    const raw = JSON.stringify(await audit());
    expect(raw).not.toContain("rm_access");
    expect(raw).not.toContain("Alice");
  });

  it.each([
    ["ログイン名が違う", "alice-token=alice;username=bob", "alice"],
    ["IdP にログイン名がない", "alice-token=alice", "alice"],
    ["Redmine がログイン名を返さない", "alice-token=alice;username=alice", undefined],
    ["IdP のログイン名が ASCII 以外(KELVIN SIGN)", "alice-token=alice;username=\u212Aato", "kato"],
    ["IdP のログイン名に前後の空白", "alice-token=alice;username= alice", "alice"],
  ])("本人照合: %s なら保管せず、トークンを失効させる", async (_label, sessions, login) => {
    const { base, rm, audit } = await startGateway(sessions);
    rm.login = login;
    const result = await (await connect(base, "alice-token")).callback();
    expect(result.status).toBe(403);
    expect(await result.text()).toContain("ログイン名");
    expect(rm.revoked).toEqual(["rm_refresh_0"]);
    const failed = (await audit()).find((r) => r.recordType === "credential_event" && r.event === "connect_failed");
    expect(failed).toMatchObject({ reason: "identity_mismatch", sourceId: "redmine" });
  });
});

describe("本人照合の照会の失敗", () => {
  it.each([500, 302, 401])("/users/current.json が HTTP %i なら保管せず失効させ、接続できない", async (status) => {
    const { base, rm, audit } = await startGateway("alice-token=alice;username=alice");
    rm.lookupStatus = status;
    const result = await (await connect(base, "alice-token")).callback();
    expect(result.status).toBe(502);
    expect(rm.revoked).toEqual(["rm_refresh_0"]);
    const failed = (await audit()).find((r) => r.recordType === "credential_event" && r.event === "connect_failed");
    expect(failed).toMatchObject({ sourceId: "redmine" });
    expect(String((failed as { reason?: string }).reason)).toMatch(/^oauth_(unavailable|rejected)$/);
  });
});

describe("設定の検査", () => {
  const RM_SETTINGS = `{ baseUrl: "${REDMINE}/" }`;
  const yaml = (oauth: string, kind = "redmine", settings = RM_SETTINGS) => `
schemaVersion: 1
deployment: { name: t }
idp: { adapter: { kind: mock } }
gateway:
  publicBaseUrl: http://127.0.0.1:1
  credentials: { store: { kind: sqlite, path: ./x.db } }
connectors:
  - id: d
    kind: ${kind}
    settings: ${settings}
    auth: { provider: token_vault, oauth: { clientId: a, clientSecretEnv: S, ${oauth} } }
`;
  const env = { S: "x", LEISEN_VAULT_KEY: randomBytes(32).toString("hex"), LEISEN_ESC_KEY: randomBytes(32).toString("hex") };
  const codes = async (oauth: string, kind?: string, settings?: string) => {
    const error = await assembleGateway({
      config: parseDeploymentConfig(yaml(oauth, kind, settings)),
      configDir: EXAMPLES_DIR,
      env,
      validateOnly: true,
      loadModule: async () => import("../../connector-redmine/src/index.js"),
    }).catch((e: unknown) => e);
    return error instanceof DeploymentConfigError ? error.issues.map((i) => i.code) : [];
  };

  it("preset redmine の identityCheck の既定は username", () => {
    const config = parseDeploymentConfig(yaml(`preset: redmine, endpoints: { apiBaseUrl: "${REDMINE}" }`));
    const auth = config.connectors[0]?.auth as { oauth: { identityCheck: string } };
    expect(auth.oauth.identityCheck).toBe("username");
    const github = parseDeploymentConfig(yaml("preset: github", "dev-fixture", "{ corpusFile: fixtures/dev-corpus.yaml }"));
    expect((github.connectors[0]?.auth as { oauth: { identityCheck: string } }).oauth.identityCheck).toBe("email");
  });

  it("preset redmine は endpoints.apiBaseUrl を要する", async () => {
    expect(await codes("preset: redmine")).toEqual(["oauth_endpoints_missing"]);
  });

  it("preset redmine の identityCheck: email、redmine 以外の username を拒否する", async () => {
    expect(await codes(`preset: redmine, identityCheck: email, endpoints: { apiBaseUrl: "${REDMINE}" }`)).toEqual(["identity_check_unsupported"]);
    expect(await codes("preset: github, identityCheck: username", "dev-fixture", "{ corpusFile: fixtures/dev-corpus.yaml }")).toEqual(["identity_check_unsupported"]);
  });

  it("preset redmine は kind: redmine を要し、apiBaseUrl はコネクタの baseUrl と同じ Redmine に限る", async () => {
    const ok = `preset: redmine, endpoints: { apiBaseUrl: "${REDMINE}" }`;
    expect(await codes(ok, "dev-fixture", "{ corpusFile: fixtures/dev-corpus.yaml }")).toEqual(["redmine_oauth_requires_redmine_connector"]);
    expect(await codes(ok, "redmine", `{ baseUrl: "https://other.example.test/redmine/" }`)).toEqual(["redmine_api_base_url_mismatch"]);
    expect(await codes(`preset: redmine, endpoints: { apiBaseUrl: "https://redmine.example.test/other" }`)).toEqual(["redmine_api_base_url_mismatch"]);
    expect(await codes(`preset: redmine, endpoints: { apiBaseUrl: "${REDMINE}?x=1" }`)).toEqual(["redmine_api_base_url_mismatch"]);
    expect(await codes(`preset: redmine, endpoints: { apiBaseUrl: "https://u:p@redmine.example.test/redmine" }`)).toEqual(["redmine_api_base_url_mismatch"]);
  });

  it("正しい preset redmine の設定は通る", async () => {
    expect(await codes(`preset: redmine, endpoints: { apiBaseUrl: "${REDMINE}" }`)).toEqual([]);
  });
});

describe("部品", () => {
  it("Redmine の端点は基点 URL から導く(末尾の / を除く)", () => {
    expect(resolveEndpoints("redmine", { apiBaseUrl: `${REDMINE}/` })).toEqual({
      authorizationEndpoint: `${REDMINE}/oauth/authorize`,
      tokenEndpoint: `${REDMINE}/oauth/token`,
      revocationEndpoint: `${REDMINE}/oauth/revoke`,
      apiBaseUrl: REDMINE,
    });
    expect(() => resolveEndpoints("redmine", {})).toThrow(/apiBaseUrl/);
  });

  it("username の照合はプリセット redmine に限る", () => {
    const base = { sourceId: "s", clientId: "c", clientSecret: "x", scopes: [], fetchIdentity: true } as const;
    expect(() => new SourceOAuthClient({ ...base, preset: "github", identityAttribute: "username" })).toThrow();
    expect(() => new SourceOAuthClient({ ...base, preset: "redmine", endpoints: { apiBaseUrl: REDMINE } })).toThrow();
    expect(() => new SourceOAuthClient({ ...base, preset: "redmine", endpoints: { apiBaseUrl: REDMINE }, identityAttribute: "username" })).not.toThrow();
  });

  it("ログイン名の照合は大文字小文字を区別しない完全一致", () => {
    expect(usernameMatches("Alice", ["alice"])).toBe(true);
    expect(usernameMatches("alice@corp.example", ["alice"])).toBe(false);
    expect(usernameMatches(undefined, ["alice"])).toBe(false);
    expect(usernameMatches(" ", ["alice"])).toBe(false);
    expect(usernameMatches(" alice", ["alice"])).toBe(false);
    // KELVIN SIGN(U+212A)は toLowerCase で "k" になるが、ASCII 以外は一致させない
    expect(usernameMatches("\u212Aato", ["kato"])).toBe(false);
    expect(usernameMatches("alice", [])).toBe(false);
  });

  it("モック IdP の username 属性", () => {
    expect(parseMockSessions("t=alice;email=a@example.com;username=alice")).toMatchObject({ t: { userId: "alice", email: "a@example.com", username: "alice" } });
  });
});
