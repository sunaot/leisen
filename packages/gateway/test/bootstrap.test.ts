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
  assembleGateway,
  createDevFixtureConnector,
  DeploymentConfigError,
  digestQuery,
  loadDeploymentConfig,
  MOCK_IDP_NO_SESSIONS_REJECTED,
  MOCK_IDP_NO_SESSIONS_WARNING,
  parseAuditRecord,
  parseDeploymentConfig,
  type AssembleGatewayOptions,
  type AssembledGateway,
  type ConfigIssueCode,
  type ConnectorFactory,
  type DeploymentConfig,
} from "../src/index.js";
import { MockConnector } from "./helpers/proxy.js";

const EXAMPLES_DIR = fileURLToPath(new URL("../../../examples/", import.meta.url));
const DEV_CONFIG_PATH = join(EXAMPLES_DIR, "deployment.dev.yaml");
const DEV_ENV = {
  KP_MOCK_SESSIONS: "dev-token=alice,dev-token-bob=bob",
  KP_MOCK_TOKEN_DEV_DOCS: "dev-only-token",
};

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
    capabilities: { nativeSearch: "full", ingest: false },
    async search() {
      return { hits: [] };
    },
    async fetch(_auth: unknown, documentId: string) {
      return { documentId, title: "t", content: "c", url: "u" };
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
    expect(empty.warnings).toEqual([MOCK_IDP_NO_SESSIONS_WARNING]);
    expect(MOCK_IDP_NO_SESSIONS_WARNING).toContain("KP_MOCK_SESSIONS");

    const blank = await assemble({ config: config(""), env: { KP_MOCK_SESSIONS: "" } });
    expect(blank.warnings).toEqual([MOCK_IDP_NO_SESSIONS_WARNING]);

    const configured = await assemble({
      config: config(""),
      env: { KP_MOCK_SESSIONS: "dev-only-session=alice" },
    });
    expect(configured.warnings).toEqual([]);
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
      { sourceId: "wiki", settings: { baseUrl: "https://wiki.example.test" }, configDir: "/etc/kp" },
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
    capabilities: { nativeSearch: "full", ingest: false },
    async search(_auth, query) {
      return { hits: [{ documentId: "d1", title: settings.title + ":" + query, snippet: "", url: "u" }] };
    },
    async fetch(_auth, documentId) { return { documentId, title: "t", content: "c", url: "u" }; },
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
          ({ ...pluginConnector(sourceId), capabilities: { nativeSearch: "None", ingest: false } }) as never,
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
    });
  });
});

describe("(h) 本番(NODE_ENV=production)", () => {
  it("開発用の構成(mock IdP / mock_env / dev-fixture)を全件拒否する", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const error = await rejection({ config: devConfig(), env: DEV_ENV, configDir: EXAMPLES_DIR });
    expect(error.issues.map((i) => [i.code, i.path])).toEqual([
      ["dev_only_in_production", "idp.adapter.kind"],
      ["dev_only_in_production", "connectors[0].auth.provider"],
      ["dev_only_in_production", "connectors[0].kind"],
    ]);
    expect(error.message).toContain("disabled in production builds");
  });

  it("開発用の部品を使わない構成は本番でも組み立てられる", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const assembled = await assemble({
      config: parseDeploymentConfig(`schemaVersion: 1
deployment:
  name: prod-like
idp:
  adapter:
    kind: keycloak
    baseUrl: http://keycloak.example.test
    realm: kp
    clientId: kp-gateway
    clientSecretEnv: KP_TEST_CLIENT_SECRET
connectors:
  - id: parked
    enabled: false
audit:
  sink: stdout
`),
      env: { KP_TEST_CLIENT_SECRET: "dev-only-client-secret" },
    });
    expect(assembled.gateway.enabledSourceIds()).toEqual([]);
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
    baseUrl: http://keycloak.example.test
    realm: kp
    clientId: kp-gateway
    clientSecretEnv: KP_TEST_MISSING_SECRET
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
          ({ ...pluginConnector(sourceId), capabilities: { nativeSearch: "none", ingest: true } }) as never,
      },
    });
    expect(codes(error)).toEqual(["index_required_source_needs_search_layer"]);
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
