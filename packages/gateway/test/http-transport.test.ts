/**
 * Streamable HTTPトランスポートの統合テスト(T-003 残作業の受け入れ条件、
 * ADR-001 追補3)。実際に http.Server を port 0 で listen し、SDK の
 * StreamableHTTPClientTransport(requestInit.headers に Authorization)と
 * 生の fetch で検証する:
 * - Authorization欠落・不正・失効、IdP不達がJSON-RPCディスパッチ前に正規化
 *   エラーのみで拒否され、コネクタ呼び出し・監査記録のいずれにも到達しない
 * - 同一Gatewayを複数ユーザーで交互・並行に使ってもユーザーコンテキストが
 *   混線しない(不変条件4)
 * - tools/list がユーザー・接続に依存しない(ADR-012)
 * - tools/call の結果の `_meta` に、そのリクエストで認証した userId が載る(tools/list には
 *   載らない。T-007 セキュリティレビュー H1)
 * - `_meta` の runId / iteration・実行区分がリクエストごとに扱われる。申告キーの
 *   誤記(裸キー・prefix内の大文字小文字違い。再レビュー S1 で前後の空白・区切りの
 *   違い・prefix の綴り違い・全角/ゼロ幅文字も)は既定値で通さず invalid_request(M2)
 * - GET / DELETE は 405、GET /healthz は認証不要で状態のみを返す
 */
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AuthContext } from "@kp/connector-sdk";
import {
  AuditLogger,
  digestQuery,
  type AuditRecord,
} from "@kp/audit";
import {
  GATEWAY_META_KEYS,
  GATEWAY_REJECTION_ERROR_CODE,
  GATEWAY_RESULT_META_KEYS,
  Gateway,
  IdpError,
  META_KEY_PREFIX,
  createGatewayHttpServer,
  type CredentialProvider,
  type DeploymentConfig,
  type Identity,
  type IdpAdapter,
} from "../src/index.js";
import {
  CollectingAuditSink,
  MockConnector,
  StubCredentialProvider,
  testConfig,
  testIdpAdapter,
} from "./helpers/proxy.js";

/** 認証の失敗注入・失効・呼び出し回数の観測ができるIdP(MockIdpAdapterに委譲)。 */
class ControllableIdpAdapter implements IdpAdapter {
  authenticateCalls = 0;
  failWith: Error | undefined;
  readonly revokedTokens = new Set<string>();

  constructor(private readonly inner: IdpAdapter) {}

  async authenticate(sessionToken: string): Promise<Identity> {
    this.authenticateCalls += 1;
    if (this.failWith) {
      throw this.failWith;
    }
    if (this.revokedTokens.has(sessionToken)) {
      throw new IdpError("unauthenticated", "session token is no longer active");
    }
    return this.inner.authenticate(sessionToken);
  }

  getCredential(identity: Identity, sourceId: string): Promise<AuthContext> {
    return this.inner.getCredential(identity, sourceId);
  }

  invalidateUser(userId: string): void {
    this.inner.invalidateUser(userId);
  }
}

/** 特定ユーザーだけ未接続(source_not_connected)として振る舞うプロバイダ。 */
class NotConnectedForUser implements CredentialProvider {
  readonly method = "oauth_individual" as const;
  private readonly connected: StubCredentialProvider;

  constructor(
    public readonly sourceId: string,
    private readonly userId: string,
  ) {
    this.connected = new StubCredentialProvider(sourceId);
  }

  async getCredential(identity: Identity) {
    if (identity.userId === this.userId) {
      throw new IdpError("source_not_connected", "source not connected");
    }
    return this.connected.getCredential(identity);
  }
}

interface HarnessOptions {
  config?: DeploymentConfig;
  providers?: CredentialProvider[];
  connectorDelayMs?: number;
  path?: string;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function startHarness(options: HarnessOptions = {}) {
  const connectorOptions =
    options.connectorDelayMs !== undefined
      ? { delayMs: options.connectorDelayMs }
      : {};
  const alpha = new MockConnector("alpha", connectorOptions);
  const beta = new MockConnector("beta", connectorOptions);
  const sink = new CollectingAuditSink();
  const idp = new ControllableIdpAdapter(testIdpAdapter(options.providers));
  const gateway = new Gateway({
    config: options.config ?? testConfig(),
    idpAdapter: idp,
    connectors: [alpha, beta],
    auditLogger: new AuditLogger(sink),
  });
  const server = createGatewayHttpServer(
    gateway,
    options.path !== undefined ? { path: options.path } : {},
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const mcpUrl = new URL(`${origin}${options.path ?? "/mcp"}`);

  const clients: Client[] = [];
  cleanups.push(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** SDKのStreamable HTTPクライアント。Authorizationは requestInit.headers で付ける。 */
  async function connect(sessionToken: string): Promise<Client> {
    const client = new Client({ name: "test-orchestrator", version: "0.0.1" });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers: { Authorization: `Bearer ${sessionToken}` } },
    });
    // SDKの型宣言が exactOptionalPropertyTypes に非対応のため型だけ合わせる
    // (src/proxy/http.ts と同じ理由)
    await client.connect(transport as Transport);
    return client;
  }

  return { alpha, beta, sink, idp, origin, mcpUrl, connect };
}

const JSON_RPC_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

function rpc(method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
}

const INITIALIZE = rpc("initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "raw-http", version: "0.0.1" },
});
const TOOLS_LIST = rpc("tools/list");
const TOOL_CALL = rpc("tools/call", {
  name: "search",
  arguments: { source: "alpha", query: "q" },
});

async function post(
  url: URL,
  body: string,
  headers: Record<string, string> = {},
) {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...JSON_RPC_HEADERS, ...headers },
    body,
  });
  const text = await response.text();
  return { response, text };
}

/** HTTP層の拒否ボディ(JSON-RPCエラー応答、idなし)を検査する。 */
function expectRejectionBody(text: string, errorClass: string): void {
  expect(JSON.parse(text)).toEqual({
    jsonrpc: "2.0",
    id: null,
    error: {
      code: GATEWAY_REJECTION_ERROR_CODE,
      message: expect.any(String),
      data: { errorClass },
    },
  });
}

function firstText(result: CallToolResult): unknown {
  const content = result.content[0];
  if (!content || content.type !== "text") {
    throw new Error("expected text content");
  }
  return JSON.parse(content.text);
}

function toolRecords(records: readonly AuditRecord[]) {
  return records.flatMap((r) => (r.recordType === "tool_invocation" ? [r] : []));
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the request to be rejected");
    },
    (error: unknown) => error,
  );
}

describe("request-scoped authentication before JSON-RPC dispatch (ADR-001 追補3 決定1)", () => {
  it.each([
    ["missing header", undefined, "Bearer", false],
    ["non-Bearer scheme", "Basic dev-only-credentials", "Bearer", false],
    ["empty bearer token", "Bearer ", "Bearer", false],
    ["malformed bearer value", "Bearer dev-only-a dev-only-b", "Bearer", false],
    [
      "unknown session token",
      "Bearer dev-only-unknown-token",
      'Bearer error="invalid_token"',
      true,
    ],
  ] as const)(
    "rejects a tools/call with %s: 401, normalized error only, no connector call, no audit",
    async (_label, authorization, wwwAuthenticate, reachesIdp) => {
      const { alpha, beta, sink, idp, mcpUrl } = await startHarness();
      const { response, text } = await post(
        mcpUrl,
        TOOL_CALL,
        authorization !== undefined ? { authorization } : {},
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(wwwAuthenticate);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expectRejectionBody(text, "unauthenticated");
      expect(text).not.toContain("dev-only-");
      // 受け入れ条件: コネクタ呼び出し・監査記録のいずれにも到達しない
      expect(alpha.calls).toHaveLength(0);
      expect(beta.calls).toHaveLength(0);
      expect(sink.records).toHaveLength(0);
      // 形式不正はIdPへ照会する前に拒否する
      expect(idp.authenticateCalls).toBe(reachesIdp ? 1 : 0);
    },
  );

  it("requires authentication for initialize and tools/list as well (no tool schema without auth)", async () => {
    const { mcpUrl, connect } = await startHarness();
    for (const body of [INITIALIZE, TOOLS_LIST]) {
      const { response, text } = await post(mcpUrl, body);
      expect(response.status).toBe(401);
      expectRejectionBody(text, "unauthenticated");
      expect(text).not.toContain("alpha");
      expect(text).not.toContain("inputSchema");
    }
    // SDKクライアントも初期化の時点で401を受ける
    const error = await rejectionOf(connect("dev-only-unknown-token"));
    expect(error).toBeInstanceOf(StreamableHTTPError);
    expect(error).toMatchObject({ code: 401 });
  });

  it("re-authenticates every request: a token revoked after connecting fails on the next call", async () => {
    const { alpha, sink, idp, connect } = await startHarness();
    const alice = await connect("session-alice");
    const ok = (await alice.callTool({
      name: "search",
      arguments: { source: "alpha", query: "before-revocation" },
    })) as CallToolResult;
    expect(ok.isError).toBeFalsy();

    const before = idp.authenticateCalls;
    idp.revokedTokens.add("session-alice");
    const error = await rejectionOf(
      alice.callTool({
        name: "search",
        arguments: { source: "alpha", query: "after-revocation" },
      }),
    );
    expect(error).toBeInstanceOf(StreamableHTTPError);
    expect(error).toMatchObject({ code: 401 });
    // 接続は同じでも、リクエストごとにIdPで再検証される
    expect(idp.authenticateCalls).toBe(before + 1);
    expect(alpha.calls).toHaveLength(1);
    expect(sink.records).toHaveLength(1);
  });

  it.each([
    [
      "IdP unreachable",
      new IdpError("idp_unavailable", "introspection unreachable (realm: dev-only-realm)"),
      503,
      "idp_unavailable",
    ],
    [
      "IdP misconfigured",
      new IdpError("misconfigured", "adapter misconfigured: dev-only-detail"),
      500,
      "misconfigured",
    ],
    [
      "unexpected exception",
      new Error("boom: dev-only-internal-detail"),
      500,
      "internal_error",
    ],
  ] as const)(
    "maps %s to a normalized %i without raw messages or dispatch",
    async (_label, failure, status, errorClass) => {
      const { alpha, beta, sink, idp, mcpUrl } = await startHarness();
      idp.failWith = failure;
      const { response, text } = await post(mcpUrl, TOOL_CALL, {
        authorization: "Bearer session-alice",
      });
      expect(response.status).toBe(status);
      expect(response.headers.get("www-authenticate")).toBeNull();
      expectRejectionBody(text, errorClass);
      expect(text).not.toContain("dev-only-");
      expect(text).not.toContain("boom");
      expect(text).not.toContain("session-alice");
      expect(alpha.calls).toHaveLength(0);
      expect(beta.calls).toHaveLength(0);
      expect(sink.records).toHaveLength(0);
    },
  );
});

describe("one gateway shared by several users (不変条件4、ADR-001 追補3 決定2)", () => {
  it("keeps alice and bob separate when their calls are interleaved and concurrent", async () => {
    const { alpha, beta, sink, connect } = await startHarness({
      connectorDelayMs: 15,
    });
    const alice = await connect("session-alice");
    const bob = await connect("session-bob");
    const clients = { alice, bob } as const;
    const search = (user: keyof typeof clients, query: string) =>
      clients[user].callTool({
        name: "search",
        arguments: { source: "alpha", query },
      });
    const fetchDoc = (user: keyof typeof clients, documentId: string) =>
      clients[user].callTool({
        name: "fetch",
        arguments: { source: "beta", documentId },
      });

    // 交互(逐次)
    await search("alice", "alice-seq-1");
    await search("bob", "bob-seq-1");
    await fetchDoc("alice", "alice-doc-1");
    await fetchDoc("bob", "bob-doc-1");
    // 並行(コネクタの遅延で呼び出しが重なる)
    const concurrent = Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0 ? (["alice", `alice-par-${i}`] as const) : (["bob", `bob-par-${i}`] as const),
    );
    const results = (await Promise.all(
      concurrent.map(([user, query]) => search(user, query)),
    )) as CallToolResult[];
    expect(results.every((r) => !r.isError)).toBe(true);

    // 各コネクタ呼び出しの本人資格情報が呼び出し元と一致する
    const calls = [...alpha.calls, ...beta.calls];
    expect(calls).toHaveLength(12);
    for (const call of calls) {
      const owner = call.target?.split("-")[0];
      expect(call.auth.userId).toBe(owner);
      expect(call.auth.credential).toMatchObject({
        accessToken: `stub-access-${owner}-${call.tool === "fetch" ? "beta" : "alpha"}`,
      });
    }

    // 監査レコードの userId も呼び出し元と一致する(1呼び出し=1レコード)
    const records = toolRecords(sink.records);
    expect(records).toHaveLength(12);
    const searches = [
      "alice-seq-1",
      "bob-seq-1",
      ...concurrent.map(([, query]) => query),
    ];
    for (const query of searches) {
      const matching = records.filter((r) => r.queryDigest === digestQuery(query));
      expect(matching).toHaveLength(1);
      expect(matching[0]?.userId).toBe(query.split("-")[0]);
    }
    expect(
      records
        .filter((r) => r.tool === "fetch")
        .map((r) => r.userId)
        .sort(),
    ).toEqual(["alice", "bob"]);
  });
});

describe("authenticated userId in tool results over HTTP (T-007 security review H1)", () => {
  it("returns the userId authenticated for each request, differing between alice and bob", async () => {
    const { connect } = await startHarness({
      providers: [
        new StubCredentialProvider("alpha"),
        new NotConnectedForUser("beta", "bob"),
      ],
    });
    const alice = await connect("session-alice");
    const bob = await connect("session-bob");
    const call = (client: Client, source: string) =>
      client.callTool({
        name: "search",
        arguments: { source, query: "q" },
      }) as Promise<CallToolResult>;

    const [aliceOk, bobOk, bobNotConnected] = await Promise.all([
      call(alice, "alpha"),
      call(bob, "alpha"),
      call(bob, "beta"),
    ]);
    const key = GATEWAY_RESULT_META_KEYS.userId;
    expect(aliceOk._meta?.[key]).toBe("alice");
    expect(bobOk._meta?.[key]).toBe("bob");
    // 失敗(isError)の結果にも載る
    expect(bobNotConnected.isError).toBe(true);
    expect(firstText(bobNotConnected)).toMatchObject({ errorClass: "source_not_connected" });
    expect(bobNotConnected._meta?.[key]).toBe("bob");

    const [aliceTools, bobTools] = await Promise.all([alice.listTools(), bob.listTools()]);
    expect(aliceTools._meta?.[key]).toBeUndefined();
    expect(bobTools).toEqual(aliceTools);
  });
});

describe("tools/list does not depend on the user or the connection (ADR-012)", () => {
  it("returns identical tools to alice and bob, including a source bob cannot access", async () => {
    const { connect } = await startHarness({
      providers: [
        new StubCredentialProvider("alpha"),
        new NotConnectedForUser("beta", "bob"),
      ],
    });
    const alice = await connect("session-alice");
    const bob = await connect("session-bob");
    const aliceAgain = await connect("session-alice");

    const [forAlice, forBob, forAliceAgain] = await Promise.all([
      alice.listTools(),
      bob.listTools(),
      aliceAgain.listTools(),
    ]);
    expect(forBob).toEqual(forAlice);
    expect(forAliceAgain).toEqual(forAlice);
    const search = forBob.tools.find((t) => t.name === "search");
    const sourceProp = (
      search?.inputSchema.properties as Record<string, { enum?: string[] }>
    )["source"];
    expect(sourceProp?.enum).toEqual(["alpha", "beta"]);

    // bob は beta を使えないが、ソースの可視性で認可状態を漏らさない
    const denied = (await bob.callTool({
      name: "search",
      arguments: { source: "beta", query: "q" },
    })) as CallToolResult;
    expect(firstText(denied)).toMatchObject({ errorClass: "source_not_connected" });
  });

  it("derives the source enum from deployment.yaml only (disabled sources are omitted for everyone)", async () => {
    const { connect } = await startHarness({
      config: testConfig({
        connectors: [{ id: "alpha" }, { id: "beta", enabled: false }],
      }),
    });
    for (const token of ["session-alice", "session-bob"]) {
      const { tools } = await (await connect(token)).listTools();
      for (const tool of tools) {
        const sourceProp = (
          tool.inputSchema.properties as Record<string, { enum?: string[] }>
        )["source"];
        expect(sourceProp?.enum).toEqual(["alpha"]);
      }
    }
  });
});

describe("_meta declarations over HTTP (ADR-011 追記、ADR-015)", () => {
  it("rejects a prefixed runId that this gateway did not issue (invalid_run_id, recorded as a single-shot run; ADR-019 決定4)", async () => {
    // 署名付き runId の受理は test/run-api.test.ts。ここでは run API のない構成で、名前空間付きの
    // キーの runId が「未申告扱い」ではなく拒否になることを固定する
    const { alpha, sink, connect } = await startHarness();
    const alice = await connect("session-alice");
    const result = (await alice.callTool({
      name: "search",
      arguments: { source: "alpha", query: "q" },
      _meta: {
        [GATEWAY_META_KEYS.runId]: "run-http-1",
        [GATEWAY_META_KEYS.iteration]: 2,
      },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatchObject({ errorClass: "invalid_run_id" });
    expect(JSON.stringify(result)).not.toContain("run-http-1");
    expect(alpha.calls).toHaveLength(0);
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({
      errorClass: "invalid_run_id",
      iteration: 0,
      userId: "alice",
    });
    expect(sink.records[0]?.recordType === "tool_invocation" ? sink.records[0].runId : "").toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it("records undeclared calls as single-shot runs (distinct runId, iteration 0)", async () => {
    const { sink, connect } = await startHarness();
    const alice = await connect("session-alice");
    for (const query of ["first", "second", "third"]) {
      await alice.callTool({
        name: "search",
        arguments: { source: "alpha", query },
      });
    }
    const records = toolRecords(sink.records);
    expect(records.map((r) => r.iteration)).toEqual([0, 0, 0]);
    expect(new Set(records.map((r) => r.runId)).size).toBe(3);
  });

  it.each(["scheduled", "autonomous"] as const)(
    "rejects a %s execution class declared in _meta (audited, connector not called)",
    async (executionClass) => {
      const { alpha, sink, connect } = await startHarness();
      const alice = await connect("session-alice");
      const result = (await alice.callTool({
        name: "search",
        arguments: { source: "alpha", query: "q" },
        _meta: {
          [GATEWAY_META_KEYS.executionClass]: executionClass,
          [GATEWAY_META_KEYS.actor]: {
            kind: "agent",
            agentId: "batch-1",
            onBehalfOfChain: ["alice"],
          },
        },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatchObject({
        errorClass: "execution_class_rejected",
      });
      expect(alpha.calls).toHaveLength(0);
      expect(sink.records).toHaveLength(1);
      expect(sink.records[0]).toMatchObject({
        errorClass: "execution_class_rejected",
      });
    },
  );

  // セキュリティレビュー 2026-09-27 M2: 以前は申告が黙って無視され、
  // human_in_the_loop としてコネクタまで到達していた(ADR-015 の既定拒否の迂回)
  it.each([
    ["a bare executionClass key", { executionClass: "scheduled" }],
    [
      "a lower-cased key inside the gateway prefix",
      { [`${META_KEY_PREFIX}executionclass`]: "autonomous" },
    ],
    // 再レビュー S1: 旧実装ではHTTP経由でもコネクタまで届いていた変種(骨格で照合する)
    [
      "a leading space before the prefixed key",
      { [` ${GATEWAY_META_KEYS.executionClass}`]: "scheduled" },
    ],
    [
      "'.' instead of '/' after the prefix",
      { "io.github.sunaot.leisen.executionClass": "scheduled" },
    ],
    ["a package-like prefix", { "kp.gateway/executionClass": "autonomous" }],
    ["a zero-width space inside a bare key", { "execution​Class": "scheduled" }],
    [
      "a trailing space after a bare actor",
      { "actor ": { kind: "agent", agentId: "a1", onBehalfOfChain: ["alice"] } },
    ],
  ])(
    "rejects a misspelled declaration key (%s) as invalid_request: connector not called, not audited",
    async (_label, meta) => {
      const { alpha, beta, sink, connect } = await startHarness();
      const alice = await connect("session-alice");
      const result = (await alice.callTool({
        name: "search",
        arguments: { source: "alpha", query: "q" },
        _meta: meta,
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatchObject({ errorClass: "invalid_request" });
      expect(alpha.calls).toHaveLength(0);
      expect(beta.calls).toHaveLength(0);
      expect(sink.records).toHaveLength(0);
    },
  );
});

describe("HTTP surface", () => {
  it("serves stateless JSON responses without issuing an MCP session id", async () => {
    const { mcpUrl } = await startHarness();
    const { response, text } = await post(mcpUrl, INITIALIZE, {
      authorization: "Bearer session-alice",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(text)).toMatchObject({
      result: { serverInfo: { name: "kp-gateway" } },
    });
  });

  it("answers GET / DELETE on the MCP path with 405 before authentication", async () => {
    const { idp, mcpUrl } = await startHarness();
    const requests: RequestInit[] = [
      { method: "GET", headers: { accept: "text/event-stream" } },
      {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          authorization: "Bearer session-alice",
        },
      },
      { method: "DELETE", headers: { authorization: "Bearer session-alice" } },
      { method: "PUT", headers: { authorization: "Bearer session-alice" } },
    ];
    for (const init of requests) {
      const response = await fetch(mcpUrl, init);
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expectRejectionBody(await response.text(), "invalid_request");
    }
    expect(idp.authenticateCalls).toBe(0);
  });

  it("serves an unauthenticated health check that reveals status only", async () => {
    const { idp, origin } = await startHarness();
    const response = await fetch(`${origin}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });

    const post = await fetch(`${origin}/healthz`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
    await post.text();
    expect(idp.authenticateCalls).toBe(0);
  });

  it("returns 404 elsewhere and honours a configured MCP path", async () => {
    const { origin, connect, alpha } = await startHarness({
      path: "/gateway/mcp",
    });
    const { response, text } = await post(new URL(`${origin}/mcp`), TOOL_CALL, {
      authorization: "Bearer session-alice",
    });
    expect(response.status).toBe(404);
    expectRejectionBody(text, "not_found");

    const alice = await connect("session-alice");
    const result = (await alice.callTool({
      name: "search",
      arguments: { source: "alpha", query: "q" },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(alpha.calls).toHaveLength(1);
  });
});
