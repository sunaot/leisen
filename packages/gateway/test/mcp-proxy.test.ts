/**
 * MCPサーバー面のテスト(T-003受け入れ条件)。InMemoryTransport で
 * createGatewayMcpServer(ユーザー状態を持たない部品)を直接検証する:
 * - モックコネクタ2つを登録し、search / fetch がプロキシ経由で通ること、
 *   認証注入・監査1件・エラー正規化・snippet truncate がMCP境界でも保たれること
 * - 利用者は extra.authInfo(本テストではHTTP層の代役として付与)からリクエスト
 *   ごとに解決され、1つのサーバーインスタンスを複数ユーザーで共有しても混線
 *   しないこと、Identity のないリクエストは fail-closed で拒否されること
 *   (ADR-001 追補3 決定1・2)
 * - `_meta` の名前空間prefix付き申告(runId / iteration の4ケース、実行区分・
 *   actor)(決定3・4、ADR-011 追記、ADR-015)。申告キーの誤記は invalid_request(M2。
 *   再レビュー S1 で骨格 — NFKC・小文字化・英数字以外の除去 — による照合に拡張)
 * - LLM へ返るエラーで permission_denied / not_found を区別しない(TM-B2)、
 *   結果は既知フィールドだけに射影される(TM-A1)、AuthInfo は gatewayAuthInfo が
 *   発行したものだけを信用しセッショントークンを token に載せない
 *   (セキュリティレビュー 2026-09-27)
 * HTTP層(Authorizationヘッダ・HTTPステータス)は http-transport.test.ts で検証する。
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  McpError,
  type CallToolResult,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ConnectorError,
  MAX_SNIPPET_CHARS,
  type SearchResult,
} from "@kp/connector-sdk";
import {
  AuditLogger,
  GATEWAY_AUTH_INFO_TOKEN,
  GATEWAY_META_KEYS,
  GATEWAY_REJECTION_ERROR_CODE,
  Gateway,
  META_KEY_PREFIX,
  createGatewayMcpServer,
  digestQuery,
  gatewayAuthInfo,
  type AuditRecord,
} from "../src/index.js";
import {
  CollectingAuditSink,
  MockConnector,
  testConfig,
  testIdpAdapter,
} from "./helpers/proxy.js";

function buildGateway(alphaSnippet?: string) {
  const alpha = new MockConnector(
    "alpha",
    alphaSnippet !== undefined ? { snippet: alphaSnippet } : {},
  );
  const beta = new MockConnector("beta");
  const sink = new CollectingAuditSink();
  const gateway = new Gateway({
    config: testConfig(),
    idpAdapter: testIdpAdapter(),
    connectors: [alpha, beta],
    auditLogger: new AuditLogger(sink),
  });
  return { gateway, alpha, beta, sink };
}

/**
 * HTTP層(http.ts)の代役: クライアント発の各メッセージに AuthInfo を付けて
 * サーバーへ渡す。authFor が undefined を返したメッセージは未認証のまま届く。
 */
async function connectClient(
  gateway: Gateway,
  authFor: (message: JSONRPCMessage) => AuthInfo | undefined,
) {
  const server = createGatewayMcpServer(gateway);
  const client = new Client({ name: "test-orchestrator", version: "0.0.1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) => {
    const authInfo = authFor(message);
    return send(message, {
      ...options,
      ...(authInfo !== undefined ? { authInfo } : {}),
    });
  };
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

/** 1ユーザーとして接続する(トークン検証はHTTP層と同じ Gateway.authenticate)。 */
async function connectAs(sessionToken = "session-alice", alphaSnippet?: string) {
  const harness = buildGateway(alphaSnippet);
  const authInfo = gatewayAuthInfo(
    await harness.gateway.authenticate(sessionToken),
  );
  const client = await connectClient(harness.gateway, () => authInfo);
  return { ...harness, client };
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

describe("MCP proxy end-to-end (acceptance: search/fetch through the proxy)", () => {
  it("lists the four connector tools with enabled sources self-described", async () => {
    const { client } = await connectAs();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "describe",
      "fetch",
      "list",
      "search",
    ]);
    const search = tools.find((t) => t.name === "search");
    const sourceProp = (
      search?.inputSchema.properties as Record<string, { enum?: string[] }>
    )["source"];
    expect(sourceProp?.enum?.sort()).toEqual(["alpha", "beta"]);
  });

  it("routes search to the requested connector with the caller's credential", async () => {
    const { client, alpha, beta, sink } = await connectAs();
    const result = (await client.callTool({
      name: "search",
      arguments: { source: "alpha", query: "hello world" },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const payload = firstText(result) as {
      hits: { documentId: string; snippet: string }[];
    };
    expect(payload.hits).toHaveLength(1);
    expect(payload.hits[0]?.documentId).toBe("alpha-doc-1");

    // 本人資格情報で対象コネクタのみが呼ばれる
    expect(alpha.calls).toHaveLength(1);
    expect(alpha.calls[0]?.auth.userId).toBe("alice");
    expect(beta.calls).toHaveLength(0);
    // MCP経由でも監査は正確に1レコード
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({
      recordType: "tool_invocation",
      tool: "search",
      sourceId: "alpha",
      userId: "alice",
      queryDigest: digestQuery("hello world"),
      returnedHitCount: 1,
    });
  });

  it("truncates oversized snippets at the MCP boundary (ADR-016)", async () => {
    const oversized = "あ".repeat(MAX_SNIPPET_CHARS + 50);
    const { client } = await connectAs("session-alice", oversized);
    const result = (await client.callTool({
      name: "search",
      arguments: { source: "alpha", query: "q" },
    })) as CallToolResult;
    const payload = firstText(result) as { hits: { snippet: string }[] };
    expect(payload.hits[0]?.snippet).toBe(oversized.slice(0, MAX_SNIPPET_CHARS));
  });

  it("routes fetch to the other connector through the same proxy", async () => {
    const { client, alpha, beta, sink } = await connectAs();
    const result = (await client.callTool({
      name: "fetch",
      arguments: { source: "beta", documentId: "beta-doc-9" },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const payload = firstText(result) as { documentId: string; content: string };
    expect(payload.documentId).toBe("beta-doc-9");
    expect(payload.content).toContain("beta");
    expect(beta.calls).toHaveLength(1);
    expect(beta.calls[0]?.auth.credential).toMatchObject({
      kind: "oauth_bearer",
      accessToken: "stub-access-alice-beta",
    });
    expect(alpha.calls).toHaveLength(0);
    expect(sink.records[0]).toMatchObject({ tool: "fetch", fetchedDocCount: 1 });
  });

  it("supports list and describe through the proxy", async () => {
    const { client } = await connectAs();
    const list = (await client.callTool({
      name: "list",
      arguments: { source: "alpha" },
    })) as CallToolResult;
    expect((firstText(list) as { entries: unknown[] }).entries).toHaveLength(1);

    const describe = (await client.callTool({
      name: "describe",
      arguments: { source: "beta" },
    })) as CallToolResult;
    expect(firstText(describe)).toMatchObject({ sourceId: "beta" });
  });

  it("returns a normalized in-band error for unknown sources (no raw internals)", async () => {
    const { client } = await connectAs();
    const result = (await client.callTool({
      name: "search",
      arguments: { source: "gamma", query: "q" },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatchObject({ errorClass: "unknown_source" });
  });

  it("rejects malformed tool arguments as invalid_request before dispatch", async () => {
    const { client, alpha, beta, sink } = await connectAs();
    const result = (await client.callTool({
      name: "search",
      arguments: { source: "alpha" }, // queryなし
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatchObject({ errorClass: "invalid_request" });
    expect(alpha.calls).toHaveLength(0);
    expect(beta.calls).toHaveLength(0);
    expect(sink.records).toHaveLength(0);
  });

  it("never leaks the session token or access token through MCP responses", async () => {
    const { client } = await connectAs();
    const results = await Promise.all([
      client.listTools(),
      client.callTool({
        name: "search",
        arguments: { source: "alpha", query: "q" },
      }),
      client.callTool({
        name: "search",
        arguments: { source: "gamma", query: "q" },
      }),
    ]);
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain("session-alice");
    expect(serialized).not.toContain("stub-access-");
  });
});

describe("stateless server component (ADR-001 追補3 決定1・2)", () => {
  it("serves alice and bob from one server instance without mixing user contexts", async () => {
    const { gateway, alpha, sink } = buildGateway();
    const auth = {
      alice: gatewayAuthInfo(await gateway.authenticate("session-alice")),
      bob: gatewayAuthInfo(await gateway.authenticate("session-bob")),
    };
    // 同一サーバー・同一接続上で、メッセージごとに別ユーザーのAuthInfoが届く
    const client = await connectClient(gateway, (message) => {
      const query =
        "method" in message && message.method === "tools/call"
          ? (message.params?.["arguments"] as { query?: string } | undefined)?.query
          : undefined;
      return query?.startsWith("bob-") ? auth.bob : auth.alice;
    });

    const queries = ["alice-1", "bob-1", "alice-2", "bob-2", "bob-3", "alice-3"];
    await Promise.all(
      queries.map((query) =>
        client.callTool({ name: "search", arguments: { source: "alpha", query } }),
      ),
    );

    expect(alpha.calls).toHaveLength(queries.length);
    for (const call of alpha.calls) {
      const owner = call.target?.split("-")[0];
      expect(call.auth.userId).toBe(owner);
      expect(call.auth.credential).toMatchObject({
        accessToken: `stub-access-${owner}-alpha`,
      });
    }
    const records = toolRecords(sink.records);
    expect(records).toHaveLength(queries.length);
    for (const query of queries) {
      const record = records.find((r) => r.queryDigest === digestQuery(query));
      expect(record?.userId).toBe(query.split("-")[0]);
    }
  });

  it("fails closed for requests without a verified identity (no schema, no dispatch, no audit)", async () => {
    const { gateway, alpha, beta, sink } = buildGateway();
    const client = await connectClient(gateway, () => undefined);

    const listError = await client.listTools().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(listError).toBeInstanceOf(McpError);
    expect(listError).toMatchObject({
      code: GATEWAY_REJECTION_ERROR_CODE,
      data: { errorClass: "unauthenticated" },
    });

    const result = (await client.callTool({
      name: "search",
      arguments: { source: "alpha", query: "q" },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatchObject({ errorClass: "unauthenticated" });
    expect(alpha.calls).toHaveLength(0);
    expect(beta.calls).toHaveLength(0);
    expect(sink.records).toHaveLength(0);
  });

  it("does not carry the session token in AuthInfo.token", async () => {
    const { gateway } = buildGateway();
    const authInfo = gatewayAuthInfo(await gateway.authenticate("session-alice"));
    expect(authInfo.token).toBe(GATEWAY_AUTH_INFO_TOKEN);
    expect(authInfo.token).not.toContain("session-alice");
  });

  it("trusts only AuthInfo issued by gatewayAuthInfo, not a look-alike with a valid identity", async () => {
    const { gateway, alpha, sink } = buildGateway();
    const issued = gatewayAuthInfo(await gateway.authenticate("session-alice"));
    // 形は同じだが gatewayAuthInfo が発行していない(複製・他経路での組み立て)
    const lookAlike = { ...issued, extra: { ...issued.extra } };
    const client = await connectClient(gateway, () => lookAlike);
    const result = (await client.callTool({
      name: "search",
      arguments: { source: "alpha", query: "q" },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatchObject({ errorClass: "unauthenticated" });
    expect(alpha.calls).toHaveLength(0);
    expect(sink.records).toHaveLength(0);
  });

  it("does not trust an incomplete identity attached to the request", async () => {
    const { gateway, alpha, sink } = buildGateway();
    const forged = gatewayAuthInfo({
      userId: "",
      session: { subjectToken: "dev-only-forged" },
    });
    const client = await connectClient(gateway, () => forged);
    const result = (await client.callTool({
      name: "search",
      arguments: { source: "alpha", query: "q" },
    })) as CallToolResult;
    expect(firstText(result)).toMatchObject({ errorClass: "unauthenticated" });
    expect(alpha.calls).toHaveLength(0);
    expect(sink.records).toHaveLength(0);
  });
});

describe("_meta runId / iteration (ADR-001 追補3 決定3・4、ADR-011 追記)", () => {
  it("uses the provisional namespace prefix defined in one place", () => {
    expect(META_KEY_PREFIX).toBe("io.github.sunaot.leisen/");
    expect(GATEWAY_META_KEYS).toEqual({
      runId: `${META_KEY_PREFIX}runId`,
      iteration: `${META_KEY_PREFIX}iteration`,
      executionClass: `${META_KEY_PREFIX}executionClass`,
      actor: `${META_KEY_PREFIX}actor`,
    });
  });

  const K = GATEWAY_META_KEYS;
  it.each([
    [
      "prefixed keys",
      { [K.runId]: "run-prefixed", [K.iteration]: 3 },
      { runId: "run-prefixed", iteration: 3 },
    ],
    [
      "bare keys (migration period)",
      { runId: "run-bare", iteration: 2 },
      { runId: "run-bare", iteration: 2 },
    ],
    [
      "both (prefixed wins)",
      { [K.runId]: "run-prefixed", [K.iteration]: 4, runId: "run-bare", iteration: 9 },
      { runId: "run-prefixed", iteration: 4 },
    ],
  ] as const)("records the declared run for %s", async (_label, meta, expected) => {
    const { client, sink } = await connectAs();
    await client.callTool({
      name: "search",
      arguments: { source: "alpha", query: "q" },
      _meta: meta,
    });
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject(expected);
  });

  it.each([
    ["non-string runId / negative iteration", { [K.runId]: 42, [K.iteration]: -1 }],
    ["empty runId / fractional iteration", { [K.runId]: "", [K.iteration]: 1.5 }],
    ["string iteration", { [K.runId]: null, [K.iteration]: "3" }],
    // prefix付きキーがあれば裸キーへはフォールバックしない
    ["invalid prefixed runId shadows a valid bare key", { [K.runId]: "", runId: "run-bare" }],
  ] as const)(
    "treats invalid values as undeclared: single-shot run (%s)",
    async (_label, meta) => {
      const { client, alpha, sink } = await connectAs();
      const result = (await client.callTool({
        name: "search",
        arguments: { source: "alpha", query: "q" },
        _meta: meta,
      })) as CallToolResult;
      // 相関メタデータの不正で呼び出し自体は失敗させず、監査は単発runとして残す
      expect(result.isError).toBeFalsy();
      expect(alpha.calls).toHaveLength(1);
      const [record] = toolRecords(sink.records);
      expect(record?.iteration).toBe(0);
      expect(record?.runId).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it("gives each undeclared call its own single-shot run on the same connection", async () => {
    const { client, sink } = await connectAs();
    for (const query of ["first", "second"]) {
      await client.callTool({
        name: "search",
        arguments: { source: "alpha", query },
      });
    }
    const records = toolRecords(sink.records);
    expect(records.map((r) => r.iteration)).toEqual([0, 0]);
    expect(records[0]?.runId).not.toBe(records[1]?.runId);
  });
});

describe("_meta execution class / actor, declared per request (ADR-015)", () => {
  const K = GATEWAY_META_KEYS;

  it.each(["scheduled", "autonomous"] as const)(
    "rejects %s calls at the MCP boundary and audits the rejection",
    async (executionClass) => {
      const { client, alpha, sink } = await connectAs();
      const result = (await client.callTool({
        name: "search",
        arguments: { source: "alpha", query: "q" },
        _meta: {
          [K.executionClass]: executionClass,
          [K.actor]: { kind: "agent", agentId: "batch-1", onBehalfOfChain: ["alice"] },
        },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatchObject({
        errorClass: "execution_class_rejected",
      });
      expect(alpha.calls).toHaveLength(0);
      // 区分の拒否はGatewayコアの内側なので1レコード残る
      expect(sink.records).toHaveLength(1);
      expect(sink.records[0]).toMatchObject({
        errorClass: "execution_class_rejected",
        userId: "alice",
      });
    },
  );

  it("defaults to human_in_the_loop / human and accepts an explicit declaration", async () => {
    const { client, alpha } = await connectAs();
    const undeclared = (await client.callTool({
      name: "search",
      arguments: { source: "alpha", query: "q" },
    })) as CallToolResult;
    const declared = (await client.callTool({
      name: "search",
      arguments: { source: "alpha", query: "q" },
      _meta: { [K.executionClass]: "human_in_the_loop", [K.actor]: { kind: "human" } },
    })) as CallToolResult;
    expect(undeclared.isError).toBeFalsy();
    expect(declared.isError).toBeFalsy();
    expect(alpha.calls).toHaveLength(2);
  });

  it.each([
    ["unknown execution class", { [K.executionClass]: "cron" }],
    ["non-string execution class", { [K.executionClass]: 1 }],
    ["null execution class", { [K.executionClass]: null }],
    [
      "agent actor without on-behalf-of chain",
      { [K.actor]: { kind: "agent", agentId: "a1", onBehalfOfChain: [] } },
    ],
    ["malformed actor", { [K.actor]: "alice" }],
    // M2: レビューで実証された誤記(黙って無視されると human_in_the_loop で通っていた)
    ["bare executionClass key", { executionClass: "scheduled" }],
    [
      "lower-cased key inside the gateway prefix",
      { [`${META_KEY_PREFIX}executionclass`]: "autonomous" },
    ],
    // 再レビュー S1: 前後の空白・区切りの違い・prefix の綴り違い(骨格で照合する)
    ["prefixed key with a leading space", { [` ${K.executionClass}`]: "scheduled" }],
    ["':' instead of '/' after the prefix", { "io.github.sunaot.leisen:executionClass": "scheduled" }],
    ["misspelled prefix", { "io.github.sunaot.leisn/executionClass": "autonomous" }],
  ] as const)(
    "rejects an invalid declaration (%s) before dispatch instead of defaulting it",
    async (_label, meta) => {
      const { client, alpha, beta, sink } = await connectAs();
      const result = (await client.callTool({
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

describe("what reaches the LLM over MCP (security review 2026-09-27)", () => {
  async function connectWithAlpha(alpha: MockConnector) {
    const sink = new CollectingAuditSink();
    const gateway = new Gateway({
      config: testConfig(),
      idpAdapter: testIdpAdapter(),
      connectors: [alpha, new MockConnector("beta")],
      auditLogger: new AuditLogger(sink),
    });
    const authInfo = gatewayAuthInfo(await gateway.authenticate("session-alice"));
    const client = await connectClient(gateway, () => authInfo);
    return { client, sink };
  }

  it("returns identical tool results for permission_denied and not_found, while the audit keeps the original class (TM-B2)", async () => {
    const denied = await connectWithAlpha(
      new MockConnector("alpha", {
        failWith: new ConnectorError(
          "permission_denied",
          "GitHub API issues.get responded HTTP 403 (SAML SSO authorization required)",
        ),
      }),
    );
    const missing = await connectWithAlpha(
      new MockConnector("alpha", {
        failWith: new ConnectorError(
          "not_found",
          "GitHub API issues.get responded HTTP 404 (not found)",
        ),
      }),
    );
    const call = { name: "fetch", arguments: { source: "alpha", documentId: "issue:acme/secret#1" } };
    const fromDenied = (await denied.client.callTool(call)) as CallToolResult;
    const fromMissing = (await missing.client.callTool(call)) as CallToolResult;

    expect(fromDenied).toEqual(fromMissing);
    expect(fromDenied.isError).toBe(true);
    expect(firstText(fromDenied)).toEqual({
      errorClass: "not_available",
      message: "the requested document or source is not available to this user",
    });
    expect(JSON.stringify(fromDenied)).not.toMatch(/403|404|SAML|permission_denied|not_found/);
    expect(denied.sink.records[0]).toMatchObject({ errorClass: "permission_denied" });
    expect(missing.sink.records[0]).toMatchObject({ errorClass: "not_found" });
  });

  it("projects connector results to IF fields at the MCP boundary (TM-A1) and normalizes malformed ones", async () => {
    class LeakyConnector extends MockConnector {
      constructor(private readonly title: unknown) {
        super("alpha");
      }

      override async search(
        ...args: Parameters<MockConnector["search"]>
      ): Promise<SearchResult> {
        await super.search(...args);
        return {
          hits: [
            {
              documentId: "d1",
              title: this.title,
              snippet: "s",
              url: "https://example.test/d1",
              rawCandidates: ["unauthorized-candidate-title"],
            },
          ],
          totalCount: 987654,
          debug: { preFilter: { candidates: 17 } },
        } as unknown as SearchResult;
      }
    }

    const leaky = await connectWithAlpha(new LeakyConnector("t1"));
    const projected = (await leaky.client.callTool({
      name: "search",
      arguments: { source: "alpha", query: "q" },
    })) as CallToolResult;
    expect(projected.isError).toBeFalsy();
    expect(projected.structuredContent).toEqual({
      hits: [{ documentId: "d1", title: "t1", snippet: "s", url: "https://example.test/d1" }],
    });
    expect(JSON.stringify(projected)).not.toMatch(/totalCount|preFilter|candidate|987654/);

    // 必須フィールドの型不正(BigInt)は SDK の生の例外文言ではなく正規化エラーで返る
    const broken = await connectWithAlpha(new LeakyConnector(10n));
    const failed = (await broken.client.callTool({
      name: "search",
      arguments: { source: "alpha", query: "q" },
    })) as CallToolResult;
    expect(failed.isError).toBe(true);
    expect(firstText(failed)).toEqual({
      errorClass: "internal_error",
      message: "connector returned a malformed result",
    });
    expect(JSON.stringify(failed)).not.toMatch(/BigInt|serialize/);
  });
});
