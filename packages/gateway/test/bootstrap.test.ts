/**
 * 起動コード(assembleGateway)のテスト。
 * (a) dev設定(mock IdP + dev-fixture、セッション・資格情報は env 注入)で組み立て、
 *     port 0 で listen し SDK の Streamable HTTP クライアントで tools/list・search・fetch
 * (b) Authorization なしは 401 でコネクタ・監査に未到達
 * (c) audit.sink: jsonl で監査レコードが1行ずつ書かれ parseAuditRecord で読み戻せる
 * (d) 有効なコネクタの auth.provider 欠落は起動拒否(スキーマ検証は通る)
 * (e) 未知の kind は unknown_connector_kind
 * (f) connectorFactories(プログラム登録)が組み込み・プラグインより優先
 * (g) loadModule 注入で動的 import 経路(createConnector / default / なし・失敗)
 * (h) NODE_ENV=production で開発用構成を拒否(assertNotProduction 経由)
 * (i) audit.sink の未知の値を拒否
 * (j) gateway.http.host が非ループバックなら confirmExposedHost: true を要求(T-012)
 * (k) モック IdP のセッション表(KP_MOCK_SESSIONS)が空なら警告する(起動は拒否しない。issue #38)
 * 秘密情報の実値は使わない(不変条件6)。
 */
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ConnectorError } from "@kp/connector-sdk";
import {
  digestQuery,
  parseAuditRecord,
} from "@kp/audit";
import {
  assembleGateway,
  createDevFixtureConnector,
  DeploymentConfigError,
  KEYCLOAK_ANY_CLIENT_WARNING,
  loadDeploymentConfig,
  MOCK_IDP_NO_SESSIONS_REJECTED,
  MOCK_IDP_NO_SESSIONS_WARNING,
  parseDeploymentConfig,
  type AssembleGatewayOptions,
  type AssembledGateway,
  type ConfigIssueCode,
  type ConnectorFactory,
  type DeploymentConfig,
  DEV_ORCHESTRATOR_CREDENTIAL,
  DEV_RUN_ID_KEY_EXAMPLE,
} from "../src/index.js";
import { MockConnector } from "./helpers/proxy.js";

const EXAMPLES_DIR = fileURLToPath(new URL("../../../examples/", import.meta.url));
const DEV_CONFIG_PATH = join(EXAMPLES_DIR, "deployment.dev.yaml");
const DEV_ENV = {
  KP_MOCK_SESSIONS: "dev-token=alice,dev-token-bob=bob",
  KP_MOCK_TOKEN_DEV_DOCS: "dev-only-token",
};

/** run API(ADR-019)の秘密。本番の組み立てには必須(テスト用の値。32 バイトの base64) */
const PROD_RUN_ENV = {
  KP_RUN_ID_KEY: Buffer.alloc(32, 7).toString("base64"),
  KP_ORCHESTRATOR_CREDENTIAL: "test-orchestrator-credential-0001",
};

/** run API の一時鍵・開発用資格情報の警告を除く(他の警告の検査用)。 */
function withoutRunApiWarnings(warnings: readonly string[]): string[] {
  return warnings.filter((w) => !w.startsWith("run API:"));
}

const opened: AssembledGateway[] = [];
const clients: Client[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  for (const assembled of opened.splice(0)) {
    assembled.httpServer.closeAllConnections();
    await assembled.close().catch(() => undefined);
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kp-bootstrap-"));
  tempDirs.push(dir);
  return dir;
}

async function assemble(options: AssembleGatewayOptions): Promise<AssembledGateway> {
  const assembled = await assembleGateway(options);
  opened.push(assembled);
  return assembled;
}

async function rejection(options: AssembleGatewayOptions): Promise<DeploymentConfigError> {
  const error = await assembleGateway(options).then(
    (assembled) => {
      opened.push(assembled);
      return undefined;
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DeploymentConfigError);
  return error as DeploymentConfigError;
}

function codes(error: DeploymentConfigError): ConfigIssueCode[] {
  return error.issues.map((i) => i.code);
}

const BASE_YAML = `schemaVersion: 1
deployment:
  name: bootstrap-test
idp:
  adapter:
    kind: mock
`;

function config(rest: string): DeploymentConfig {
  return parseDeploymentConfig(BASE_YAML + rest);
}

function devConfig(): DeploymentConfig {
  return loadDeploymentConfig(DEV_CONFIG_PATH);
}

async function listen(assembled: AssembledGateway): Promise<URL> {
  assembled.httpServer.listen(0, "127.0.0.1");
  await once(assembled.httpServer, "listening");
  const { port } = assembled.httpServer.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${port}/mcp`);
}

async function connect(url: URL, sessionToken: string): Promise<Client> {
  const client = new Client({ name: "bootstrap-test", version: "0.0.1" });
  clients.push(client);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${sessionToken}` } },
  });
  // SDKの型宣言が exactOptionalPropertyTypes に非対応のため型だけ合わせる
  // (src/proxy/http.ts と同じ理由)
  await client.connect(transport as Transport);
  return client;
}

function structured<T>(result: unknown): T {
  const call = result as CallToolResult;
  expect(call.isError).toBeFalsy();
  return call.structuredContent as T;
}

function toolError(result: unknown): { errorClass: string } {
  const call = result as CallToolResult;
  expect(call.isError).toBe(true);
  const content = call.content[0];
  if (!content || content.type !== "text") {
    throw new Error("expected text content");
  }
  return JSON.parse(content.text) as { errorClass: string };
}

/** 呼び出しを記録する MockConnector を返す factory(connectorFactories 用)。 */
function mockFactory(created: MockConnector[] = []): ConnectorFactory {
  return ({ sourceId }) => {
    const connector = new MockConnector(sourceId);
    created.push(connector);
    return connector;
  };
}

/** Connector IF の形をした最小のプラグイン実装(connector-sdk に依存しない)。 */
function pluginConnector(sourceId: string) {
  return {
    sourceId,
    capabilities: { nativeSearch: "full", ingest: false, privateScopeHandling: "classified" },
    async search() {
      return { hits: [] };
    },
    async fetch(_auth: unknown, documentId: string) {
      return { documentId, title: "t", content: "c", url: "u", scope: "shared" };
    },
    async list() {
      return { entries: [] };
    },
    async describe() {
      return {
        sourceId,
        displayName: sourceId,
        summary: "plugin",
        topContainers: [],
        supportedFilters: [],
      };
    },
  };
}

describe("(a) dev設定: 組み立てて MCP クライアントから使う", () => {
  it("mock IdP + dev-fixture で tools/list・search・fetch が通る(env 注入)", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const assembled = await assemble({
      config: devConfig(),
      env: DEV_ENV,
      configDir: EXAMPLES_DIR,
    });
    expect(assembled.auditSinkDescription).toContain("stdout");
    const url = await listen(assembled);
    const alice = await connect(url, "dev-token");

    const { tools } = await alice.listTools();
    expect(tools.map((t) => t.name)).toEqual(["search", "fetch", "list", "describe"]);
    const source = (tools[0]?.inputSchema.properties as Record<string, { enum?: string[] }>)[
      "source"
    ];
    expect(source?.enum).toEqual(["dev-docs"]);

    const search = structured<{ hits: { documentId: string; snippet: string }[] }>(
      await alice.callTool({
        name: "search",
        arguments: { source: "dev-docs", query: "VPN 接続" },
      }),
    );
    expect(search.hits[0]?.documentId).toBe("vpn-setup");
    expect(search.hits[0]?.snippet).toContain("VPN");

    const fetched = structured<{ documentId: string; content: string }>(
      await alice.callTool({
        name: "fetch",
        arguments: { source: "dev-docs", documentId: "vpn-setup" },
      }),
    );
    expect(fetched.documentId).toBe("vpn-setup");
    expect(fetched.content).toContain("VPN クライアント");

    // 監査レコードは stdout sink へ(1呼び出し=1レコード、本文・トークンなし)
    const auditLines = stdout.mock.calls
      .map(([chunk]) => String(chunk))
      .filter((line) => line.includes('"kind":"audit"'));
    expect(auditLines).toHaveLength(2);
    for (const line of auditLines) {
      expect(line).not.toContain("dev-only-token");
      expect(line).not.toContain("dev-token");
      expect(line).not.toContain("VPN");
    }
    const [searchRecord] = auditLines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(searchRecord).toMatchObject({
      userId: "alice",
      sourceId: "dev-docs",
      tool: "search",
      queryDigest: digestQuery("VPN 接続"),
      returnedHitCount: search.hits.length,
    });
  });

  it("資格情報は注入した env から読む(未注入のソースは source_not_connected)", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const assembled = await assemble({
      config: devConfig(),
      env: { KP_MOCK_SESSIONS: "dev-token=alice" },
      configDir: EXAMPLES_DIR,
    });
    const alice = await connect(await listen(assembled), "dev-token");
    const result = await alice.callTool({
      name: "search",
      arguments: { source: "dev-docs", query: "VPN" },
    });
    expect(toolError(result).errorClass).toBe("source_not_connected");
  });

  it("利用者ごとの資格情報(KP_MOCK_TOKEN_<SOURCE>__<USER>)も env から読む", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const created: MockConnector[] = [];
    const assembled = await assemble({
      config: devConfig(),
      env: {
        KP_MOCK_SESSIONS: "dev-token=alice,dev-token-bob=bob",
        KP_MOCK_TOKEN_DEV_DOCS__ALICE: "dev-only-alice",
        KP_MOCK_TOKEN_DEV_DOCS__BOB: "dev-only-bob",
      },
      configDir: EXAMPLES_DIR,
      connectorFactories: { "dev-fixture": mockFactory(created) },
    });
    const url = await listen(assembled);
    for (const [token, user] of [
      ["dev-token", "alice"],
      ["dev-token-bob", "bob"],
    ] as const) {
      const client = await connect(url, token);
      await client.callTool({ name: "search", arguments: { source: "dev-docs", query: user } });
    }
    const calls = created[0]?.calls ?? [];
    expect(calls.map((c) => [c.auth.userId, c.auth.credential])).toEqual([
      ["alice", expect.objectContaining({ accessToken: "dev-only-alice" })],
      ["bob", expect.objectContaining({ accessToken: "dev-only-bob" })],
    ]);
  });
});

describe("(b) 認証のないリクエスト", () => {
  it("Authorization なしは 401 で、コネクタにも監査にも到達しない", async () => {
    const dir = await tempDir();
    const created: MockConnector[] = [];
    const assembled = await assemble({
      config: config(`connectors:
  - id: dev-docs
    kind: dev-fixture
    auth:
      provider: mock_env
audit:
  sink: jsonl
  jsonl:
    path: audit.jsonl
`),
      env: DEV_ENV,
      configDir: dir,
      connectorFactories: { "dev-fixture": mockFactory(created) },
    });
    const url = await listen(assembled);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search", arguments: { source: "dev-docs", query: "q" } },
      }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { data: { errorClass: "unauthenticated" } } });
    expect(created[0]?.calls).toHaveLength(0);
    await assembled.close();
    await expect(stat(join(dir, "audit.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("(k) モック IdP のセッション表が空(KP_MOCK_SESSIONS 未設定、issue #38)", () => {
  async function postToolsList(url: URL, token: string | undefined): Promise<number> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    await response.arrayBuffer();
    return response.status;
  }

  it("起動は拒否せず warnings に入れる(セッションがあれば警告しない)", async () => {
    const empty = await assemble({ config: config(""), env: {} });
    expect(withoutRunApiWarnings(empty.warnings)).toEqual([MOCK_IDP_NO_SESSIONS_WARNING]);
    expect(MOCK_IDP_NO_SESSIONS_WARNING).toContain("KP_MOCK_SESSIONS");

    const blank = await assemble({ config: config(""), env: { KP_MOCK_SESSIONS: "" } });
    expect(withoutRunApiWarnings(blank.warnings)).toEqual([MOCK_IDP_NO_SESSIONS_WARNING]);

    const configured = await assemble({
      config: config(""),
      env: { KP_MOCK_SESSIONS: "dev-only-session=alice" },
    });
    expect(withoutRunApiWarnings(configured.warnings)).toEqual([]);
  });

  it("稼働中は、Bearer トークンを 401 で拒否したときに最初の1回だけ warn を呼ぶ(トークンを含めない)", async () => {
    const warn = vi.fn();
    const assembled = await assemble({ config: config(""), env: {}, warn });
    const url = await listen(assembled);

    // Authorization のないリクエストは IdP に届かない(HTTP 層で 401)ので警告しない
    expect(await postToolsList(url, undefined)).toBe(401);
    expect(warn).not.toHaveBeenCalled();

    expect(await postToolsList(url, "dev-only-unknown-1")).toBe(401);
    expect(await postToolsList(url, "dev-only-unknown-2")).toBe(401);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(MOCK_IDP_NO_SESSIONS_REJECTED);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("dev-only-unknown");
  });

  it("セッションがある構成では未知のトークンを拒否しても warn を呼ばない", async () => {
    const warn = vi.fn();
    const assembled = await assemble({
      config: config(""),
      env: { KP_MOCK_SESSIONS: "dev-only-session=alice" },
      warn,
    });
    const url = await listen(assembled);
    expect(await postToolsList(url, "dev-only-unknown")).toBe(401);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("(c) audit.sink: jsonl", () => {
  it("監査レコードを1行ずつ追記し、parseAuditRecord で読み戻せる。生クエリは別ファイル", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "var"));
    const assembled = await assemble({
      config: config(`connectors:
  - id: dev-docs
    kind: dev-fixture
    auth:
      provider: mock_env
audit:
  sink: jsonl
  jsonl:
    path: var/audit.jsonl
    rawQueryPath: var/raw-queries.jsonl
`),
      env: DEV_ENV,
      configDir: dir,
    });
    expect(assembled.auditSinkDescription).toBe(
      `jsonl ${join(dir, "var", "audit.jsonl")} (raw queries: ${join(dir, "var", "raw-queries.jsonl")})`,
    );
    const alice = await connect(await listen(assembled), "dev-token");
    await alice.callTool({ name: "search", arguments: { source: "dev-docs", query: "VPN" } });
    await alice.callTool({ name: "search", arguments: { source: "dev-docs", query: "経費" } });
    await alice.callTool({
      name: "fetch",
      arguments: { source: "dev-docs", documentId: "sample-vpn" },
    });
    await alice.callTool({ name: "describe", arguments: { source: "no-such-source" } });
    await assembled.close();

    const lines = (await readFile(join(dir, "var", "audit.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l !== "");
    expect(lines).toHaveLength(4);
    const records = lines.map((line) => parseAuditRecord(JSON.parse(line)));
    expect(
      records.map((r) =>
        r.recordType === "tool_invocation" ? [r.userId, r.sourceId, r.tool, r.errorClass] : [],
      ),
    ).toEqual([
      ["alice", "dev-docs", "search", null],
      ["alice", "dev-docs", "search", null],
      ["alice", "dev-docs", "fetch", null],
      // 設定にないソースIDは監査に残さず固定値 "unknown" で記録する(TM 反映 minor-10)
      ["alice", "unknown", "describe", "unknown_source"],
    ]);
    // 監査ログ本体に生クエリ・本文を含めない。原文は rawQuery テーブルのみ(ADR-011 §3)
    const auditText = lines.join("\n");
    expect(auditText).not.toContain("経費");
    const raw = await assembled.rawQueryStore.findByDigest(digestQuery("経費"));
    expect(raw.map((r) => [r.rawQuery, r.userId])).toEqual([["経費", "alice"]]);
    expect(
      (await readFile(join(dir, "var", "raw-queries.jsonl"), "utf8")).trim().split("\n"),
    ).toHaveLength(2);
  });

  it("rawQueryPath がなければ生クエリはメモリにのみ保持する", async () => {
    const dir = await tempDir();
    const assembled = await assemble({
      config: config(`audit:
  sink: jsonl
  jsonl:
    path: audit.jsonl
`),
      configDir: dir,
    });
    expect(assembled.auditSinkDescription).toContain("raw queries: in memory only");
  });

  it("出力先のディレクトリがない・rawQueryPath が監査ログと同じ場合は起動を拒否する", async () => {
    const dir = await tempDir();
    const missingDir = await rejection({
      config: config(`audit:
  sink: jsonl
  jsonl:
    path: no-such-dir/audit.jsonl
`),
      configDir: dir,
    });
    expect(missingDir.issues).toEqual([
      expect.objectContaining({ code: "audit_sink_options_invalid", path: "audit.jsonl.path" }),
    ]);

    const samePath = await rejection({
      config: config(`audit:
  sink: jsonl
  jsonl:
    path: audit.jsonl
    rawQueryPath: ./audit.jsonl
`),
      configDir: dir,
    });
    expect(samePath.issues).toEqual([
      expect.objectContaining({
        code: "audit_sink_options_invalid",
        path: "audit.jsonl.rawQueryPath",
      }),
    ]);
  });

  it("出力先がディレクトリなら拒否する", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "audit.jsonl"));
    const error = await rejection({
      config: config(`audit:
  sink: jsonl
  jsonl:
    path: audit.jsonl
`),
      configDir: dir,
    });
    expect(codes(error)).toEqual(["audit_sink_options_invalid"]);
  });

  it("validate 相当(listen せずに組み立てて閉じる)ではファイルを作らない", async () => {
    const dir = await tempDir();
    const assembled = await assemble({
      config: config(`audit:
  sink: jsonl
  jsonl:
    path: audit.jsonl
    rawQueryPath: raw.jsonl
`),
      configDir: dir,
    });
    await assembled.close();
    await assembled.close(); // 冪等
    await expect(stat(join(dir, "audit.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(dir, "raw.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("(d) 本人資格情報の取得方式(auth.provider)", () => {
  it("有効なコネクタに auth.provider がない構成は、スキーマ検証は通るが起動時に拒否する", async () => {
    const parsed = config(`connectors:
  - id: dev-docs
    kind: dev-fixture
`);
    expect(parsed.connectors[0]?.auth).toBeUndefined();
    const error = await rejection({ config: parsed, env: DEV_ENV, configDir: EXAMPLES_DIR });
    expect(error.issues).toEqual([
      expect.objectContaining({
        code: "connector_auth_provider_missing",
        path: "connectors[0].auth.provider",
      }),
    ]);
  });

  it("無効化したコネクタは auth がなくてもよく、実体も構築しない(呼び出しは source_disabled)", async () => {
    const created: MockConnector[] = [];
    const assembled = await assemble({
      config: config(`connectors:
  - id: live
    kind: dev-fixture
    auth:
      provider: mock_env
  - id: parked
    kind: parked-kind
    enabled: false
`),
      env: { ...DEV_ENV, KP_MOCK_TOKEN_LIVE: "dev-only-token" },
      configDir: EXAMPLES_DIR,
      connectorFactories: { "parked-kind": mockFactory(created) },
      loadModule: async () => {
        throw new Error("must not load plugins for disabled connectors");
      },
    });
    expect(created).toHaveLength(0);
    expect(assembled.gateway.enabledSourceIds()).toEqual(["live"]);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const alice = await connect(await listen(assembled), "dev-token");
    const result = await alice.callTool({
      name: "search",
      arguments: { source: "parked", query: "q" },
    });
    // ツールスキーマの source enum に parked は含まれず、呼び出しても経路はない
    expect(toolError(result).errorClass).toBe("source_disabled");
  });
});

describe("(e)(g) コネクタ実装の解決", () => {
  it("未知の kind は unknown_connector_kind(失敗理由はモジュール指定子のみ)", async () => {
    const error = await rejection({
      config: config(`connectors:
  - id: acme
    kind: nonexistent-kind
    auth:
      provider: mock_env
`),
      env: DEV_ENV,
    });
    expect(error.issues).toEqual([
      expect.objectContaining({
        code: "unknown_connector_kind",
        path: "connectors[0].kind",
        message: expect.stringContaining('"@kp/connector-nonexistent-kind"'),
      }),
    ]);
  });

  it("kind 省略時は id を kind として解決する", async () => {
    const specifiers: string[] = [];
    await assemble({
      config: config(`connectors:
  - id: acme
    auth:
      provider: mock_env
`),
      loadModule: async (specifier) => {
        specifiers.push(specifier);
        return { createConnector: ({ sourceId }: { sourceId: string }) => pluginConnector(sourceId) };
      },
    });
    expect(specifiers).toEqual(["@kp/connector-acme"]);
  });

  it("名前付き export createConnector を factory として使い、init を渡す", async () => {
    const inits: unknown[] = [];
    const assembled = await assemble({
      config: config(`connectors:
  - id: wiki
    kind: acme-wiki
    auth:
      provider: mock_env
    settings:
      baseUrl: https://wiki.example.test
`),
      configDir: "/etc/kp",
      loadModule: async () => ({
        createConnector: (init: { sourceId: string }) => {
          inits.push(init);
          return pluginConnector(init.sourceId);
        },
        default: () => {
          throw new Error("default must not be used when createConnector exists");
        },
      }),
    });
    expect(inits).toEqual([
      {
        sourceId: "wiki",
        settings: { baseUrl: "https://wiki.example.test" },
        configDir: "/etc/kp",
        // 方針(ADR-016 追補2 決定1)。privateScopes の既定は excluded
        policy: { privateScopes: "excluded" },
      },
    ]);
    expect(assembled.gateway.enabledSourceIds()).toEqual(["wiki"]);
  });

  it("createConnector がなければ default export(関数)を使う", async () => {
    const assembled = await assemble({
      config: config(`connectors:
  - id: wiki
    kind: acme-wiki
    auth:
      provider: mock_env
`),
      loadModule: async () => ({
        default: ({ sourceId }: { sourceId: string }) => pluginConnector(sourceId),
      }),
    });
    expect(assembled.gateway.enabledSourceIds()).toEqual(["wiki"]);
  });

  it.each([
    ["factory の export がない", { something: 1 }],
    ["createConnector が関数でない", { createConnector: "nope" }],
    ["default が関数でない", { default: { createConnector: () => undefined } }],
  ])("%s場合は connector_plugin_invalid", async (_label, moduleNamespace) => {
    const error = await rejection({
      config: config(`connectors:
  - id: wiki
    kind: acme-wiki
    auth:
      provider: mock_env
`),
      loadModule: async () => moduleNamespace,
    });
    expect(codes(error)).toEqual(["connector_plugin_invalid"]);
  });

  it("import の失敗理由(例外文言)をメッセージに含めない", async () => {
    const error = await rejection({
      config: config(`connectors:
  - id: wiki
    kind: acme-wiki
    auth:
      provider: mock_env
`),
      loadModule: async () => {
        throw new Error("boom at /home/dev-only-internal-path with dev-only-detail");
      },
    });
    expect(codes(error)).toEqual(["unknown_connector_kind"]);
    expect(error.message).toContain('"@kp/connector-acme-wiki"');
    expect(error.message).not.toContain("dev-only");
  });

  it("module はパッケージ名ならそのまま、相対パスなら設定ファイルの所在ディレクトリ基準で解決する", async () => {
    const specifiers: string[] = [];
    await assemble({
      config: config(`connectors:
  - id: a
    kind: acme
    module: "@acme/kp-connector/wiki"
    auth:
      provider: mock_env
  - id: b
    kind: local
    module: ./plugins/local-connector.js
    auth:
      provider: mock_env
  - id: c
    kind: absolute
    module: /opt/kp/plugins/abs.js
    auth:
      provider: mock_env
`),
      configDir: "/etc/kp",
      loadModule: async (specifier) => {
        specifiers.push(specifier);
        return { createConnector: ({ sourceId }: { sourceId: string }) => pluginConnector(sourceId) };
      },
    });
    expect(specifiers).toEqual([
      "@acme/kp-connector/wiki",
      pathToFileURL("/etc/kp/plugins/local-connector.js").href,
      pathToFileURL("/opt/kp/plugins/abs.js").href,
    ]);
  });

  it("組み込みの kind に module を併用した構成は拒否する(module を黙って無視しない)", async () => {
    const loadModule = vi.fn(async () => ({}));
    const error = await rejection({
      config: config(`connectors:
  - id: dev-docs
    kind: dev-fixture
    module: ./plugins/my-fixture.js
    auth:
      provider: mock_env
`),
      env: DEV_ENV,
      configDir: EXAMPLES_DIR,
      loadModule,
    });
    expect(error.issues).toEqual([
      expect.objectContaining({
        code: "connector_plugin_invalid",
        path: "connectors[0].module",
      }),
    ]);
    expect(loadModule).not.toHaveBeenCalled();
  });

  it("既定の loadModule(動的 import)でファイルのプラグインを読み込める", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "plugins"));
    await writeFile(
      join(dir, "plugins", "echo-connector.mjs"),
      `export function createConnector({ sourceId, settings }) {
  return {
    sourceId,
    capabilities: { nativeSearch: "full", ingest: false, privateScopeHandling: "classified" },
    async search(_auth, query) {
      return { hits: [{ documentId: "d1", title: settings.title + ":" + query, snippet: "", url: "u", scope: "shared" }] };
    },
    async fetch(_auth, documentId) { return { documentId, title: "t", content: "c", url: "u", scope: "shared" }; },
    async list() { return { entries: [] }; },
    async describe() {
      return { sourceId, displayName: sourceId, summary: "echo", topContainers: [], supportedFilters: [] };
    },
  };
}
`,
    );
    const assembled = await assemble({
      config: config(`connectors:
  - id: echo
    kind: echo
    module: ./plugins/echo-connector.mjs
    auth:
      provider: mock_env
    settings:
      title: plugin
`),
      env: { ...DEV_ENV, KP_MOCK_TOKEN_ECHO: "dev-only-token" },
      configDir: dir,
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const alice = await connect(await listen(assembled), "dev-token");
    const result = structured<{ hits: { title: string }[] }>(
      await alice.callTool({ name: "search", arguments: { source: "echo", query: "hello" } }),
    );
    expect(result.hits[0]?.title).toBe("plugin:hello");
  });

  it("factory が Connector でないもの・別ソースのコネクタを返したら connector_plugin_invalid", async () => {
    const error = await rejection({
      config: config(`connectors:
  - id: a
    kind: not-a-connector
    auth:
      provider: mock_env
  - id: b
    kind: wrong-source
    auth:
      provider: mock_env
  - id: c
    kind: bad-capabilities
    auth:
      provider: mock_env
`),
      connectorFactories: {
        "not-a-connector": () => ({}) as never,
        "wrong-source": () => pluginConnector("someone-else") as never,
        "bad-capabilities": ({ sourceId }) =>
          ({ ...pluginConnector(sourceId), capabilities: { nativeSearch: "None", ingest: false, privateScopeHandling: "classified" } }) as never,
      },
    });
    expect(error.issues.map((i) => [i.code, i.path])).toEqual([
      ["connector_plugin_invalid", "connectors[0].kind"],
      ["connector_plugin_invalid", "connectors[1].id"],
      ["connector_plugin_invalid", "connectors[2].kind"],
    ]);
  });

  it("factory の失敗を設定の不備に写す(ZodError / ConnectorError / DeploymentConfigError / その他)", async () => {
    const settingsSchema = z.strictObject({ baseUrl: z.string().min(1) });
    const error = await rejection({
      config: config(`connectors:
  - id: zod
    kind: zod-kind
    auth:
      provider: mock_env
    settings:
      baseUrl: 42
  - id: conn
    kind: connector-error-kind
    auth:
      provider: mock_env
  - id: builtin
    kind: dev-fixture
    auth:
      provider: mock_env
    settings:
      corpusFile: no-such-corpus.yaml
  - id: crash
    kind: crash-kind
    auth:
      provider: mock_env
`),
      configDir: EXAMPLES_DIR,
      connectorFactories: {
        "zod-kind": ({ sourceId, settings }) => {
          settingsSchema.parse(settings);
          return pluginConnector(sourceId) as never;
        },
        "connector-error-kind": () => {
          throw new ConnectorError("invalid_request", "settings.baseUrl is required");
        },
        "crash-kind": () => {
          throw new TypeError("dev-only-internal-detail");
        },
      },
    });
    expect(error.issues.map((i) => [i.code, i.path])).toEqual([
      ["connector_settings_invalid", "connectors[0].settings.baseUrl"],
      ["connector_settings_invalid", "connectors[1].settings"],
      ["connector_settings_invalid", "connectors[2].settings.corpusFile"],
      ["connector_factory_failed", "connectors[3].kind"],
    ]);
    expect(error.message).toContain("settings.baseUrl is required");
    expect(error.message).toContain("(TypeError)");
    expect(error.message).not.toContain("dev-only-internal-detail");
  });
});

describe("(f) connectorFactories(プログラム登録)の優先", () => {
  it("同じ kind の組み込み実装より優先し、プラグインを読み込まない", async () => {
    const created: MockConnector[] = [];
    const loadModule = vi.fn(async () => ({}));
    const assembled = await assemble({
      config: devConfig(),
      env: DEV_ENV,
      configDir: EXAMPLES_DIR,
      connectorFactories: { "dev-fixture": mockFactory(created) },
      loadModule,
    });
    expect(created).toHaveLength(1);
    expect(loadModule).not.toHaveBeenCalled();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const alice = await connect(await listen(assembled), "dev-token");
    await alice.callTool({ name: "search", arguments: { source: "dev-docs", query: "q" } });
    expect(created[0]?.calls.map((c) => c.tool)).toEqual(["search"]);
  });

  it("継承プロパティ(constructor 等)を factory と誤認しない", async () => {
    const error = await rejection({
      config: config(`connectors:
  - id: odd
    kind: constructor
    auth:
      provider: mock_env
`),
      loadModule: async () => {
        throw new Error("not installed");
      },
    });
    expect(codes(error)).toEqual(["unknown_connector_kind"]);
  });

  it("組み込みの dev-fixture を使う場合も factory の契約(init)どおりに構築する", async () => {
    const factory = vi.fn(createDevFixtureConnector);
    await assemble({
      config: devConfig(),
      env: DEV_ENV,
      configDir: EXAMPLES_DIR,
      connectorFactories: { "dev-fixture": factory },
    });
    expect(factory).toHaveBeenCalledWith({
      sourceId: "dev-docs",
      settings: { corpusFile: "fixtures/dev-corpus.yaml" },
      configDir: EXAMPLES_DIR.replace(/\/$/, ""),
      policy: { privateScopes: "excluded" },
    });
  });
});

describe("(h) 本番(NODE_ENV=production)", () => {
  it("開発用の構成(mock IdP / mock_env / dev-fixture / audit.sink: stdout)を全件拒否する", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const error = await rejection({
      config: devConfig(),
      env: { ...DEV_ENV, ...PROD_RUN_ENV },
      configDir: EXAMPLES_DIR,
    });
    expect(error.issues.map((i) => [i.code, i.path])).toEqual([
      ["dev_only_in_production", "idp.adapter.kind"],
      ["dev_only_in_production", "connectors[0].auth.provider"],
      ["dev_only_in_production", "connectors[0].kind"],
      ["dev_only_in_production", "audit.sink"],
    ]);
    expect(error.message).toContain("disabled in production builds");
  });

  it("audit.sink: stdout は本番では単独でも拒否する(既定値のまま省略した場合を含む。issue #17)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const error = await rejection({
      config: parseDeploymentConfig(`schemaVersion: 1
deployment:
  name: prod-like
idp:
  adapter:
    kind: keycloak
    baseUrl: https://idp.example.test
    realm: kp
    clientId: kp-gateway
    clientSecretEnv: KP_TEST_CLIENT_SECRET
    allowedClients: [chat-ui]
connectors:
  - id: parked
    enabled: false
`),
      env: { KP_TEST_CLIENT_SECRET: "dev-only-client-secret", ...PROD_RUN_ENV },
    });
    expect(error.issues.map((i) => [i.code, i.path])).toEqual([
      ["dev_only_in_production", "audit.sink"],
    ]);
    expect(error.issues[0]?.message).toContain("audit sink 'stdout'");
  });

  it('keycloak の allowedClients: ["*"](azp 検証の無効化)は本番では拒否し、それ以外では WARNING を出す(issue #16)', async () => {
    const yaml = (clients: string) => `schemaVersion: 1
deployment:
  name: any-client
idp:
  adapter:
    kind: keycloak
    baseUrl: https://idp.example.test
    realm: kp
    clientId: kp-gateway
    clientSecretEnv: KP_TEST_CLIENT_SECRET
    allowedClients: ${clients}
connectors:
  - id: parked
    enabled: false
audit:
  sink: jsonl
  jsonl:
    path: audit.jsonl
`;
    const dir = await mkdtemp(join(tmpdir(), "kp-bootstrap-any-client-"));
    tempDirs.push(dir);
    const env = { KP_TEST_CLIENT_SECRET: "dev-only-client-secret", ...PROD_RUN_ENV };

    // 開発: 起動するが WARNING("*" が他の項目と混在していても同じ)
    const lenient = await assemble({
      config: parseDeploymentConfig(yaml("[chat-ui, '*']")),
      env,
      configDir: dir,
    });
    expect(lenient.warnings).toEqual([KEYCLOAK_ANY_CLIENT_WARNING]);
    const strict = await assemble({
      config: parseDeploymentConfig(yaml("[chat-ui]")),
      env,
      configDir: dir,
    });
    expect(strict.warnings).toEqual([]);

    // 本番: dev_only_in_production
    vi.stubEnv("NODE_ENV", "production");
    const error = await rejection({
      config: parseDeploymentConfig(yaml("['*']")),
      env,
      configDir: dir,
    });
    expect(error.issues.map((i) => [i.code, i.path])).toEqual([
      ["dev_only_in_production", "idp.adapter.allowedClients"],
    ]);
    expect(error.issues[0]?.message).toContain("allowedClients '*' (azp check disabled)");
    expect(error.message).not.toContain("dev-only-client-secret");
  });

  it("開発用の部品を使わない構成(https の IdP、jsonl シンク)は本番でも組み立てられる", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const dir = await mkdtemp(join(tmpdir(), "kp-bootstrap-prod-"));
    tempDirs.push(dir);
    const assembled = await assemble({
      config: parseDeploymentConfig(`schemaVersion: 1
deployment:
  name: prod-like
idp:
  adapter:
    kind: keycloak
    baseUrl: https://idp.example.test
    realm: kp
    clientId: kp-gateway
    clientSecretEnv: KP_TEST_CLIENT_SECRET
    allowedClients: [chat-ui]
connectors:
  - id: parked
    enabled: false
audit:
  sink: jsonl
  jsonl:
    path: audit.jsonl
    rawQueryPath: raw-queries.jsonl
`),
      env: { KP_TEST_CLIENT_SECRET: "dev-only-client-secret", ...PROD_RUN_ENV },
      configDir: dir,
    });
    expect(assembled.gateway.enabledSourceIds()).toEqual([]);
    expect(assembled.auditSinkDescription).toContain(join(dir, "audit.jsonl"));
  });
});

describe("(i) 監査シンク・IdP の不備と、不備の集約", () => {
  it("audit.sink の未知の値を拒否する", async () => {
    const error = await rejection({ config: config("audit:\n  sink: syslog\n") });
    expect(error.issues).toEqual([
      expect.objectContaining({ code: "unknown_audit_sink", path: "audit.sink" }),
    ]);
  });

  it("KP_MOCK_SESSIONS の形式不備は idp_adapter_misconfigured(値をエコーしない)", async () => {
    const error = await rejection({
      config: config(""),
      env: { KP_MOCK_SESSIONS: "dev-only-malformed-session" },
    });
    expect(codes(error)).toEqual(["idp_adapter_misconfigured"]);
    expect(error.message).not.toContain("dev-only-malformed-session");
  });

  it("複数の不備を1回の起動失敗にまとめる(clientSecret の値は出さない)", async () => {
    const error = await rejection({
      config: parseDeploymentConfig(`schemaVersion: 1
deployment:
  name: broken
idp:
  adapter:
    kind: keycloak
    baseUrl: https://keycloak.example.test
    realm: kp
    clientId: kp-gateway
    clientSecretEnv: KP_TEST_MISSING_SECRET
    allowedClients: [chat-ui]
connectors:
  - id: a
    kind: dev-fixture
  - id: b
    kind: nonexistent-kind
    auth:
      provider: mock_env
audit:
  sink: syslog
`),
      env: {},
      configDir: EXAMPLES_DIR,
    });
    expect(codes(error).sort()).toEqual(
      [
        "connector_auth_provider_missing",
        "secret_env_missing",
        "unknown_audit_sink",
        "unknown_connector_kind",
      ].sort(),
    );
  });

  it("capability 連動の検証は Gateway の構築時に行う(index-required ソースの検索層OFF)", async () => {
    const error = await rejection({
      config: config(`connectors:
  - id: files
    kind: files
    auth:
      provider: mock_env
`),
      connectorFactories: {
        files: ({ sourceId }) =>
          ({ ...pluginConnector(sourceId), capabilities: { nativeSearch: "none", ingest: true, privateScopeHandling: "classified" } }) as never,
      },
    });
    expect(codes(error)).toEqual(["index_required_source_needs_search_layer"]);
  });

  it("privateScopeHandling を宣言しない(v0.3 の)プラグインは excluded(既定)で起動を拒否する(ADR-016 追補2 決定3)", async () => {
    const v03 = ({ sourceId }: { sourceId: string }) =>
      ({ ...pluginConnector(sourceId), capabilities: { nativeSearch: "full", ingest: false } }) as never;
    const error = await rejection({
      config: config(`connectors:
  - id: legacy
    kind: legacy
    auth:
      provider: mock_env
`),
      connectorFactories: { legacy: v03 },
    });
    expect(codes(error)).toEqual(["private_scopes_unenforceable"]);

    // included(確認フラグ付き)なら同じプラグインでも起動できる。プライベートスコープを持つ
    // ソースが有効で privateScopeDocIds: hashed(既定)なら、引用 docId の HMAC 鍵が要る(ADR-019 決定5)
    const included = config(`connectors:
  - id: legacy
    kind: legacy
    privateScopes: included
    confirmPrivateScopesIncluded: true
    auth:
      provider: mock_env
`);
    const missingKey = await rejection({ config: included, connectorFactories: { legacy: v03 }, env: {} });
    expect(missingKey.issues.map((i) => [i.code, i.path])).toEqual([
      ["secret_env_missing", "audit.docIdHmacKeyEnv"],
    ]);
    expect(missingKey.message).toContain("KP_AUDIT_HMAC_KEY");
    const assembled = await assemble({
      config: included,
      connectorFactories: { legacy: v03 },
      env: { KP_AUDIT_HMAC_KEY: "dev-only-audit-hmac-key" },
    });
    expect(assembled.gateway.enabledSourceIds()).toEqual(["legacy"]);
  });

  it("privateScopes: consent は設定の読み込み(validate / serve の前段)で拒否する(#42 まで。ADR-016 追補2 決定6)", () => {
    let error: unknown;
    try {
      config(`connectors:
  - id: dev-docs
    kind: dev-fixture
    privateScopes: consent
    auth:
      provider: mock_env
`);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DeploymentConfigError);
    expect(codes(error as DeploymentConfigError)).toEqual(["private_scopes_consent_not_supported"]);
  });
});

describe("(j) gateway.http.host の非ループバック待ち受け(T-012)", () => {
  const exposed = (extra = "") =>
    config(`gateway:
  http:
    host: 0.0.0.0
${extra}connectors:
  - id: dev-docs
    kind: dev-fixture
    auth:
      provider: mock_env
`);

  it("confirmExposedHost なしの 0.0.0.0 は起動を拒否し、他の不備とまとめて返す", async () => {
    const error = await rejection({
      config: parseDeploymentConfig(`schemaVersion: 1
deployment:
  name: exposed
idp:
  adapter:
    kind: mock
gateway:
  http:
    host: 0.0.0.0
audit:
  sink: syslog
`),
      env: DEV_ENV,
    });
    expect(codes(error).sort()).toEqual(
      ["http_host_exposed_requires_confirmation", "unknown_audit_sink"].sort(),
    );
    expect(error.issues).toContainEqual(
      expect.objectContaining({
        code: "http_host_exposed_requires_confirmation",
        path: "gateway.http.host",
      }),
    );
  });

  it("confirmExposedHost: true なら組み立てられる(TLS 終端・Origin 検証を前段に委ねる前提の明示)", async () => {
    const assembled = await assemble({
      config: exposed("    confirmExposedHost: true\n"),
      env: DEV_ENV,
      configDir: EXAMPLES_DIR,
    });
    expect(assembled.gateway.enabledSourceIds()).toEqual(["dev-docs"]);
  });

  it("ループバック(既定 127.0.0.1)は確認フラグ不要", async () => {
    const assembled = await assemble({
      config: config(`connectors:
  - id: dev-docs
    kind: dev-fixture
    auth:
      provider: mock_env
`),
      env: DEV_ENV,
      configDir: EXAMPLES_DIR,
    });
    expect(assembled.gateway.enabledSourceIds()).toEqual(["dev-docs"]);
  });
});

describe("close()", () => {
  it("listen 中のサーバーを閉じ、監査バッファを flush する(冪等)", async () => {
    const dir = await tempDir();
    const assembled = await assemble({
      config: config(`connectors:
  - id: dev-docs
    kind: dev-fixture
    auth:
      provider: mock_env
audit:
  sink: jsonl
  jsonl:
    path: audit.jsonl
`),
      env: DEV_ENV,
      configDir: dir,
    });
    const url = await listen(assembled);
    const alice = await connect(url, "dev-token");
    await alice.callTool({ name: "search", arguments: { source: "dev-docs", query: "VPN" } });
    await alice.close();
    await Promise.all([assembled.close(), assembled.close()]);
    expect(assembled.httpServer.listening).toBe(false);
    expect((await readFile(join(dir, "audit.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
  });
});

describe("(l) run API(ADR-019)の署名鍵・Orchestrator の資格情報の解決", () => {
  const PROD_YAML = `schemaVersion: 1
deployment:
  name: prod-like
idp:
  adapter:
    kind: keycloak
    baseUrl: https://idp.example.test
    realm: kp
    clientId: kp-gateway
    clientSecretEnv: KP_TEST_CLIENT_SECRET
    allowedClients: [chat-ui]
connectors:
  - id: parked
    enabled: false
audit:
  sink: jsonl
  jsonl:
    path: audit.jsonl
`;
  const baseEnv = { KP_TEST_CLIENT_SECRET: "dev-only-client-secret" };

  async function prodDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "kp-bootstrap-runs-"));
    tempDirs.push(dir);
    return dir;
  }

  it("本番では署名鍵と Orchestrator の資格情報の環境変数が必須(未設定は起動拒否。鍵の代用はしない)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const error = await rejection({
      config: parseDeploymentConfig(PROD_YAML),
      env: baseEnv,
      configDir: await prodDir(),
    });
    expect(error.issues.map((i) => [i.code, i.path])).toEqual([
      ["run_signing_key_missing", "gateway.runs.signingKeyEnv"],
      ["run_orchestrator_credential_missing", "gateway.runs.orchestratorCredentialEnv"],
    ]);
    expect(error.message).toContain("KP_RUN_ID_KEY");
    expect(error.message).toContain("KP_ORCHESTRATOR_CREDENTIAL");
  });

  it("本番では 32 バイト未満の鍵・短い資格情報・開発用の例の値を拒否し、値をメッセージに出さない", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const dir = await prodDir();
    const short = await rejection({
      config: parseDeploymentConfig(PROD_YAML),
      env: { ...baseEnv, KP_RUN_ID_KEY: Buffer.alloc(31, 1).toString("hex"), KP_ORCHESTRATOR_CREDENTIAL: "too-short" },
      configDir: dir,
    });
    expect(short.issues.map((i) => [i.code, i.path])).toEqual([
      ["run_signing_key_invalid", "gateway.runs.signingKeyEnv"],
      ["run_orchestrator_credential_invalid", "gateway.runs.orchestratorCredentialEnv"],
    ]);
    expect(short.message).not.toContain(Buffer.alloc(31, 1).toString("hex"));
    expect(short.message).not.toContain("too-short");

    const dev = await rejection({
      config: parseDeploymentConfig(PROD_YAML),
      env: { ...baseEnv, KP_RUN_ID_KEY: DEV_RUN_ID_KEY_EXAMPLE, KP_ORCHESTRATOR_CREDENTIAL: DEV_ORCHESTRATOR_CREDENTIAL },
      configDir: dir,
    });
    expect(dev.issues.map((i) => [i.code, i.path])).toEqual([
      ["dev_only_in_production", "gateway.runs.signingKeyEnv"],
      ["dev_only_in_production", "gateway.runs.orchestratorCredentialEnv"],
    ]);
    expect(dev.message).not.toContain(DEV_RUN_ID_KEY_EXAMPLE);
    expect(dev.message).not.toContain(DEV_ORCHESTRATOR_CREDENTIAL);
  });

  it("本番で有効な鍵と資格情報があれば組み立てられ、説明には環境変数名と kid だけが出る(鍵の値は出ない)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const key = Buffer.alloc(32, 9).toString("base64url");
    const assembled = await assemble({
      config: parseDeploymentConfig(PROD_YAML),
      env: { ...baseEnv, KP_RUN_ID_KEY: key, KP_ORCHESTRATOR_CREDENTIAL: "prod-orchestrator-credential-1" },
      configDir: await prodDir(),
    });
    expect(assembled.warnings).toEqual([]);
    expect(assembled.runApiDescription).toMatch(
      /^\/runs \(signing key: env KP_RUN_ID_KEY, kid [0-9a-f]{8}; orchestrator credential: env KP_ORCHESTRATOR_CREDENTIAL; ttl 900s, feedback window 604800s\)$/,
    );
    expect(assembled.runApiDescription).not.toContain(key);
    expect(assembled.runApiDescription).not.toContain("prod-orchestrator-credential-1");
    expect(assembled.gateway.runs).toBeDefined();
    expect(assembled.gateway.verifyOrchestratorCredential("prod-orchestrator-credential-1")).toBe(true);
    expect(assembled.gateway.verifyOrchestratorCredential("prod-orchestrator-credential-2")).toBe(false);
    expect(assembled.gateway.verifyOrchestratorCredential(undefined)).toBe(false);
  });

  it("鍵の入れ替え: 1 つ前の鍵も読む。現行と同じ鍵・復号できない鍵は拒否する", async () => {
    const dir = await prodDir();
    const current = Buffer.alloc(32, 1).toString("base64");
    const previous = Buffer.alloc(32, 2).toString("hex");
    const rotated = await assemble({
      config: parseDeploymentConfig(PROD_YAML),
      env: { ...baseEnv, KP_RUN_ID_KEY: current, KP_RUN_ID_KEY_PREVIOUS: previous, KP_ORCHESTRATOR_CREDENTIAL: "test-orchestrator-credential-0001" },
      configDir: dir,
    });
    expect(rotated.runApiDescription).toMatch(/kid [0-9a-f]{8} \+ previous kid [0-9a-f]{8};/);

    const same = await rejection({
      config: parseDeploymentConfig(PROD_YAML),
      env: { ...baseEnv, KP_RUN_ID_KEY: current, KP_RUN_ID_KEY_PREVIOUS: current, KP_ORCHESTRATOR_CREDENTIAL: "test-orchestrator-credential-0001" },
      configDir: dir,
    });
    expect(same.issues.map((i) => [i.code, i.path])).toEqual([
      ["run_signing_key_invalid", "gateway.runs.previousSigningKeyEnv"],
    ]);
    const garbage = await rejection({
      config: parseDeploymentConfig(PROD_YAML),
      env: { ...baseEnv, KP_RUN_ID_KEY: "not base64!!", KP_ORCHESTRATOR_CREDENTIAL: "test-orchestrator-credential-0001" },
      configDir: dir,
    });
    expect(garbage.issues.map((i) => i.code)).toEqual(["run_signing_key_invalid"]);
  });

  it("秘密の使い回し・docId 鍵の形・資格情報の文字種・フィードバックの期間を検査する(値をメッセージに出さない)", async () => {
    const dir = await prodDir();
    const key = Buffer.alloc(32, 3).toString("base64url");
    // 署名鍵と資格情報が同じ値、docId の鍵が資格情報と同じ値
    const reused = await rejection({
      config: parseDeploymentConfig(PROD_YAML),
      env: { ...baseEnv, KP_RUN_ID_KEY: key, KP_ORCHESTRATOR_CREDENTIAL: key, KP_AUDIT_HMAC_KEY: key },
      configDir: dir,
    });
    expect(reused.issues.map((i) => [i.code, i.path])).toEqual([
      ["run_secret_reused", "gateway.runs"],
      ["run_secret_reused", "gateway.runs"],
    ]);
    expect(reused.message).toContain("KP_RUN_ID_KEY");
    expect(reused.message).toContain("KP_AUDIT_HMAC_KEY");
    expect(reused.message).not.toContain(key);

    // 資格情報に空白・非 ASCII、docId の鍵が短い
    const malformed = await rejection({
      config: parseDeploymentConfig(PROD_YAML),
      env: { ...baseEnv, KP_RUN_ID_KEY: key, KP_ORCHESTRATOR_CREDENTIAL: "has a space in the credential", KP_AUDIT_HMAC_KEY: "short-key" },
      configDir: dir,
    });
    expect(malformed.issues.map((i) => [i.code, i.path])).toEqual([
      ["run_orchestrator_credential_invalid", "gateway.runs.orchestratorCredentialEnv"],
      ["doc_id_hmac_key_invalid", "audit.docIdHmacKeyEnv"],
    ]);
    expect(malformed.message).not.toContain("has a space");
    const nonAscii = await rejection({
      config: parseDeploymentConfig(PROD_YAML),
      env: { ...baseEnv, KP_RUN_ID_KEY: key, KP_ORCHESTRATOR_CREDENTIAL: "資格情報は-ascii-でないと-ヘッダに乗らない" },
      configDir: dir,
    });
    expect(nonAscii.issues.map((i) => i.code)).toEqual(["run_orchestrator_credential_invalid"]);

    // 本番では docId の鍵の開発用の値(dev-only-…)を拒否し、本番以外では WARNING
    vi.stubEnv("NODE_ENV", "production");
    const devHmac = await rejection({
      config: parseDeploymentConfig(PROD_YAML),
      env: { ...baseEnv, KP_RUN_ID_KEY: key, KP_ORCHESTRATOR_CREDENTIAL: "prod-orchestrator-credential-1", KP_AUDIT_HMAC_KEY: "dev-only-audit-hmac-key" },
      configDir: dir,
    });
    expect(devHmac.issues.map((i) => [i.code, i.path])).toEqual([["dev_only_in_production", "audit.docIdHmacKeyEnv"]]);
    vi.stubEnv("NODE_ENV", "test");
    const warned = await assemble({
      config: parseDeploymentConfig(PROD_YAML),
      env: { ...baseEnv, KP_RUN_ID_KEY: key, KP_ORCHESTRATOR_CREDENTIAL: "prod-orchestrator-credential-1", KP_AUDIT_HMAC_KEY: "dev-only-audit-hmac-key" },
      configDir: dir,
    });
    expect(warned.warnings).toEqual([expect.stringMatching(/^audit: environment variable "KP_AUDIT_HMAC_KEY" holds a development-only value/)]);

    // フィードバックの期間は有効期間より短くできない
    const shortWindow = await rejection({
      config: parseDeploymentConfig(PROD_YAML + "gateway:\n  runs:\n    ttlSec: 900\n    feedbackWindowSec: 600\n"),
      env: { ...baseEnv, KP_RUN_ID_KEY: key, KP_ORCHESTRATOR_CREDENTIAL: "prod-orchestrator-credential-1" },
      configDir: dir,
    });
    expect(shortWindow.issues.map((i) => [i.code, i.path])).toEqual([
      ["run_feedback_window_too_short", "gateway.runs.feedbackWindowSec"],
    ]);
  });

  it("本番以外では未設定の鍵は起動ごとの一時鍵、未設定の資格情報は開発用の既定値になり、WARNING に残る", async () => {
    const assembled = await assemble({ config: config(""), env: { KP_MOCK_SESSIONS: "dev-only-session=alice" } });
    expect(assembled.warnings).toEqual([
      expect.stringMatching(/^run API: environment variable "KP_RUN_ID_KEY" is not set; using an ephemeral runId signing key/),
      expect.stringMatching(/^run API: environment variable "KP_ORCHESTRATOR_CREDENTIAL" is not set; using the development-only orchestrator credential/),
    ]);
    expect(assembled.runApiDescription).toMatch(/^\/runs \(signing key: ephemeral, kid [0-9a-f]{8}; orchestrator credential: development default;/);
    expect(assembled.gateway.verifyOrchestratorCredential(DEV_ORCHESTRATOR_CREDENTIAL)).toBe(true);

    const example = await assemble({
      config: config(""),
      env: { KP_MOCK_SESSIONS: "dev-only-session=alice", KP_RUN_ID_KEY: DEV_RUN_ID_KEY_EXAMPLE, KP_ORCHESTRATOR_CREDENTIAL: DEV_ORCHESTRATOR_CREDENTIAL },
    });
    expect(example.warnings).toEqual([
      expect.stringMatching(/^run API: environment variable "KP_RUN_ID_KEY" holds the published development example key/),
      expect.stringMatching(/^run API: environment variable "KP_ORCHESTRATOR_CREDENTIAL" holds the development-only orchestrator credential/),
    ]);
    expect(example.warnings.join("\n")).not.toContain(DEV_RUN_ID_KEY_EXAMPLE);
  });
});
