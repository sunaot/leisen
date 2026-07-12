/**
 * Gatewayコアパイプラインのテスト(T-003受け入れ条件)。
 * - 資格情報取得失敗時にコネクタ呼び出しが行われない
 * - 監査ログがリクエストごとに正確に1レコード、書き込み失敗時fail-closed
 * - scheduled/autonomous区分の呼び出し拒否(ADR-015)
 * - snippetのMAX_SNIPPET_CHARS強制truncate(ADR-016)
 * - ソース別レート制御・タイムアウト
 */
import { describe, expect, it } from "vitest";
import { ConnectorError, MAX_SNIPPET_CHARS } from "@kp/connector-sdk";
import {
  AuditLogger,
  Gateway,
  GatewayError,
  IdpError,
  InMemoryRawQueryStore,
  digestQuery,
  type GatewaySession,
  type GatewayToolResult,
} from "../src/index.js";
import {
  CollectingAuditSink,
  FailingAuditSink,
  MockConnector,
  StubCredentialProvider,
  testConfig,
  testIdpAdapter,
} from "./helpers/proxy.js";

interface BuildOverrides {
  config?: ReturnType<typeof testConfig>;
  connectors?: MockConnector[];
  idpAdapter?: ReturnType<typeof testIdpAdapter>;
  sink?: CollectingAuditSink | FailingAuditSink;
  rawQueryStore?: InMemoryRawQueryStore | FailingRawQueryStore;
}

/** append失敗を注入するrawQueryストア(補助テーブル失敗の許容テスト用)。 */
class FailingRawQueryStore extends InMemoryRawQueryStore {
  override async append(): Promise<void> {
    throw new Error("injected raw query store failure");
  }
}

function build(overrides: BuildOverrides = {}) {
  const connectors = overrides.connectors ?? [
    new MockConnector("alpha"),
    new MockConnector("beta"),
  ];
  const sink = overrides.sink ?? new CollectingAuditSink();
  const gateway = new Gateway({
    config: overrides.config ?? testConfig(),
    idpAdapter: overrides.idpAdapter ?? testIdpAdapter(),
    connectors,
    auditLogger: new AuditLogger(sink),
    ...(overrides.rawQueryStore !== undefined
      ? { rawQueryStore: overrides.rawQueryStore }
      : {}),
  });
  return { gateway, connectors, sink };
}

async function search(
  gateway: Gateway,
  session: GatewaySession,
  sourceId = "alpha",
  query = "q",
): Promise<GatewayToolResult> {
  return gateway.handleToolCall(session, { tool: "search", sourceId, query });
}

async function expectGatewayError(
  promise: Promise<unknown>,
  errorClass: string,
): Promise<GatewayError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    const ge = error as GatewayError;
    expect(ge.errorClass).toBe(errorClass);
    return ge;
  }
  throw new Error(`expected GatewayError(${errorClass}) but call succeeded`);
}

describe("session establishment", () => {
  it("binds the authenticated identity to the session", async () => {
    const { gateway } = build();
    const session = await gateway.establishSession("session-alice");
    expect(session.identity.userId).toBe("alice");
    expect(session.executionClass).toBe("human_in_the_loop");
    expect(session.actor).toEqual({ kind: "human" });
  });

  it("rejects unknown session tokens as unauthenticated", async () => {
    const { gateway } = build();
    await expectGatewayError(
      gateway.establishSession("no-such-token"),
      "unauthenticated",
    );
  });

  it("rejects an agent actor without an on-behalf-of chain (ADR-015)", async () => {
    const { gateway } = build();
    await expectGatewayError(
      gateway.establishSession("session-alice", {
        actor: { kind: "agent", agentId: "a1", onBehalfOfChain: [] },
      }),
      "invalid_request",
    );
  });
});

describe("tool call pipeline", () => {
  it("proxies search to the target connector with the caller's credential", async () => {
    const { gateway, connectors } = build();
    const [alpha, beta] = connectors as [MockConnector, MockConnector];
    const session = await gateway.establishSession("session-alice");

    const outcome = await search(gateway, session, "alpha", "hello");
    expect(outcome.tool).toBe("search");
    if (outcome.tool !== "search") throw new Error("unreachable");
    expect(outcome.result.hits[0]?.documentId).toBe("alpha-doc-1");

    // 本人資格情報がコネクタへ渡っている(userId・ソース別スタブトークン)
    expect(alpha.calls).toHaveLength(1);
    expect(alpha.calls[0]?.auth.userId).toBe("alice");
    expect(alpha.calls[0]?.auth.credential).toMatchObject({
      kind: "oauth_bearer",
      accessToken: "stub-access-alice-alpha",
    });
    // 他ソースは呼ばれない
    expect(beta.calls).toHaveLength(0);
  });

  it("rejects sources that are not part of the deployment", async () => {
    const { gateway, sink } = build();
    const session = await gateway.establishSession("session-alice");
    await expectGatewayError(
      search(gateway, session, "gamma"),
      "unknown_source",
    );
    // 拒否も監査対象(1レコード)
    expect((sink as CollectingAuditSink).records).toHaveLength(1);
  });

  it("rejects disabled sources without calling the connector", async () => {
    const config = testConfig({
      connectors: [{ id: "alpha" }, { id: "beta", enabled: false }],
    });
    const { gateway, connectors } = build({ config });
    const [, beta] = connectors as [MockConnector, MockConnector];
    const session = await gateway.establishSession("session-alice");
    await expectGatewayError(
      search(gateway, session, "beta"),
      "source_disabled",
    );
    expect(beta.calls).toHaveLength(0);
  });
});

describe("credential failure (acceptance: connector must not be called)", () => {
  it.each([
    ["source_not_connected", new IdpError("source_not_connected", "not connected")],
    ["idp_unavailable", new IdpError("idp_unavailable", "idp down")],
  ] as const)(
    "does not call the connector when credential resolution fails (%s)",
    async (expectedClass, failure) => {
      const alpha = new MockConnector("alpha");
      const beta = new MockConnector("beta");
      const idpAdapter = testIdpAdapter([
        new StubCredentialProvider("alpha", failure),
        new StubCredentialProvider("beta"),
      ]);
      const sink = new CollectingAuditSink();
      const { gateway } = build({ connectors: [alpha, beta], idpAdapter, sink });
      const session = await gateway.establishSession("session-alice");

      await expectGatewayError(search(gateway, session, "alpha"), expectedClass);

      // 受け入れ条件: コネクタ呼び出しが行われない
      expect(alpha.calls).toHaveLength(0);
      // 失敗も正確に1レコード記録され、errorClassは正規化コード
      expect(sink.records).toHaveLength(1);
      expect(sink.records[0]).toMatchObject({
        recordType: "tool_invocation",
        sourceId: "alpha",
        tool: "search",
        errorClass: expectedClass,
        returnedHitCount: null,
        fetchedDocCount: 0,
      });
    },
  );
});

describe("audit logging (acceptance: exactly one record per request)", () => {
  it("writes exactly one tool_invocation record per request, success or failure", async () => {
    const alpha = new MockConnector("alpha");
    const beta = new MockConnector("beta", {
      failWith: new ConnectorError("permission_denied", "denied by source"),
    });
    const sink = new CollectingAuditSink();
    const { gateway } = build({ connectors: [alpha, beta], sink });
    const session = await gateway.establishSession("session-alice");

    await search(gateway, session, "alpha", "first");
    await gateway.handleToolCall(session, {
      tool: "fetch",
      sourceId: "alpha",
      documentId: "alpha-doc-1",
    });
    await expectGatewayError(
      search(gateway, session, "beta", "second"),
      "permission_denied",
    );

    expect(sink.records).toHaveLength(3);
    const requestIds = sink.records.map((r) =>
      r.recordType === "tool_invocation" ? r.requestId : "",
    );
    expect(new Set(requestIds).size).toBe(3);

    expect(sink.records[0]).toMatchObject({
      tool: "search",
      sourceId: "alpha",
      userId: "alice",
      queryDigest: digestQuery("first"),
      returnedHitCount: 1,
      errorClass: null,
      iteration: 0,
    });
    expect(sink.records[1]).toMatchObject({
      tool: "fetch",
      fetchedDocCount: 1,
      queryDigest: null,
      iteration: 1,
    });
    expect(sink.records[2]).toMatchObject({
      tool: "search",
      sourceId: "beta",
      errorClass: "permission_denied",
      returnedHitCount: null,
    });
  });

  it("uses the orchestrator-declared runId/iteration when provided", async () => {
    const sink = new CollectingAuditSink();
    const { gateway } = build({ sink });
    const session = await gateway.establishSession("session-alice");
    await gateway.handleToolCall(
      session,
      { tool: "search", sourceId: "alpha", query: "q" },
      { runId: "run-42", iteration: 7 },
    );
    expect(sink.records[0]).toMatchObject({ runId: "run-42", iteration: 7 });
  });

  it("fails closed when the audit write fails (default failureMode)", async () => {
    const alpha = new MockConnector("alpha");
    const sink = new FailingAuditSink();
    const { gateway } = build({ connectors: [alpha, new MockConnector("beta")], sink });
    const session = await gateway.establishSession("session-alice");

    // コネクタ呼び出しは成功しているが、監査が書けないため結果は返さない
    await expectGatewayError(
      search(gateway, session, "alpha"),
      "audit_write_failed",
    );
    expect(alpha.calls).toHaveLength(1);
    expect(sink.attempts).toBe(1);
  });

  it("returns the result despite audit failure only in confirmed fail-open mode", async () => {
    const config = testConfig({
      audit: { failureMode: "fail-open", confirmFailOpen: true },
    });
    const { gateway } = build({ config, sink: new FailingAuditSink() });
    const session = await gateway.establishSession("session-alice");
    const outcome = await search(gateway, session, "alpha");
    expect(outcome.tool).toBe("search");
  });

  it("records the raw query in the separate short-retention store (ADR-011 §3)", async () => {
    const rawQueryStore = new InMemoryRawQueryStore();
    const sink = new CollectingAuditSink();
    const { gateway } = build({ rawQueryStore, sink });
    const session = await gateway.establishSession("session-alice");
    await search(gateway, session, "alpha", "社内の秘密の質問");

    const found = await rawQueryStore.findByDigest(
      digestQuery("社内の秘密の質問"),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.userId).toBe("alice");
    // 監査レコード側は原文を持たずdigestのみ(結合キー一致)
    expect(sink.records[0]).toMatchObject({
      queryDigest: digestQuery("社内の秘密の質問"),
    });
    expect(JSON.stringify(sink.records[0])).not.toContain("社内の秘密の質問");
  });

  it("tolerates raw-query store failure once the audit record is persisted", async () => {
    // rawQueryは監査本体と別の短期補助テーブル(ADR-011 §3)。監査レコードが
    // 書けている以上、原文保存の失敗でツール呼び出しを拒否しない
    const sink = new CollectingAuditSink();
    const { gateway } = build({ sink, rawQueryStore: new FailingRawQueryStore() });
    const session = await gateway.establishSession("session-alice");
    const outcome = await search(gateway, session, "alpha");
    expect(outcome.tool).toBe("search");
    expect(sink.records).toHaveLength(1);
  });
});

describe("execution class policy (acceptance: scheduled/autonomous rejected)", () => {
  it.each(["scheduled", "autonomous"] as const)(
    "rejects %s calls and never reaches the connector (ADR-015)",
    async (executionClass) => {
      const alpha = new MockConnector("alpha");
      const sink = new CollectingAuditSink();
      const { gateway } = build({ connectors: [alpha, new MockConnector("beta")], sink });
      const session = await gateway.establishSession("session-alice", {
        executionClass,
        actor: {
          kind: "agent",
          agentId: "batch-1",
          onBehalfOfChain: ["alice"],
        },
      });

      await expectGatewayError(
        search(gateway, session, "alpha"),
        "execution_class_rejected",
      );
      expect(alpha.calls).toHaveLength(0);
      // 拒否も監査に1レコード残る
      expect(sink.records).toHaveLength(1);
      expect(sink.records[0]).toMatchObject({
        errorClass: "execution_class_rejected",
      });
    },
  );

  it("allows human-in-the-loop calls (Phase 1 default)", async () => {
    const { gateway } = build();
    const session = await gateway.establishSession("session-alice", {
      executionClass: "human_in_the_loop",
    });
    const outcome = await search(gateway, session);
    expect(outcome.tool).toBe("search");
  });
});

describe("snippet truncation (acceptance: MAX_SNIPPET_CHARS enforced)", () => {
  it("truncates oversized snippets returned by a connector", async () => {
    const oversized = "あ".repeat(MAX_SNIPPET_CHARS + 200);
    const alpha = new MockConnector("alpha", { snippet: oversized });
    const { gateway } = build({ connectors: [alpha, new MockConnector("beta")] });
    const session = await gateway.establishSession("session-alice");

    const outcome = await search(gateway, session, "alpha");
    if (outcome.tool !== "search") throw new Error("unreachable");
    expect(outcome.result.hits[0]?.snippet).toHaveLength(MAX_SNIPPET_CHARS);
    expect(outcome.result.hits[0]?.snippet).toBe(
      oversized.slice(0, MAX_SNIPPET_CHARS),
    );
  });

  it("leaves snippets within the limit untouched", async () => {
    const { gateway } = build();
    const session = await gateway.establishSession("session-alice");
    const outcome = await search(gateway, session, "alpha");
    if (outcome.tool !== "search") throw new Error("unreachable");
    expect(outcome.result.hits[0]?.snippet).toBe("snippet from alpha");
  });
});

describe("per-source limits from deployment config", () => {
  it("rate-limits per source and reports retryAfterMs", async () => {
    const config = testConfig({
      connectors: [
        { id: "alpha", limits: { maxRequestsPerMinute: 2 } },
        { id: "beta" },
      ],
    });
    const alpha = new MockConnector("alpha");
    const beta = new MockConnector("beta");
    const sink = new CollectingAuditSink();
    const { gateway } = build({ config, connectors: [alpha, beta], sink });
    const session = await gateway.establishSession("session-alice");

    await search(gateway, session, "alpha");
    await search(gateway, session, "alpha");
    const error = await expectGatewayError(
      search(gateway, session, "alpha"),
      "rate_limited",
    );
    expect(error.retryAfterMs).toBeGreaterThan(0);
    expect(alpha.calls).toHaveLength(2);

    // 制限はソース別(betaは影響を受けない)。拒否分も含め監査は4レコード
    await search(gateway, session, "beta");
    expect(beta.calls).toHaveLength(1);
    expect(sink.records).toHaveLength(4);
  });

  it("times out slow connector calls using the configured timeoutMs", async () => {
    const config = testConfig({
      connectors: [{ id: "alpha", limits: { timeoutMs: 20 } }, { id: "beta" }],
    });
    const alpha = new MockConnector("alpha", { delayMs: 200 });
    const sink = new CollectingAuditSink();
    const { gateway } = build({ config, connectors: [alpha, new MockConnector("beta")], sink });
    const session = await gateway.establishSession("session-alice");

    await expectGatewayError(search(gateway, session, "alpha"), "timeout");
    expect(sink.records[0]).toMatchObject({ errorClass: "timeout" });
  });
});

describe("assembly validation", () => {
  it("rejects a config that references an unregistered connector", () => {
    const config = testConfig({ connectors: [{ id: "alpha" }, { id: "ghost" }] });
    expect(
      () =>
        new Gateway({
          config,
          idpAdapter: testIdpAdapter(),
          connectors: [new MockConnector("alpha")],
          auditLogger: new AuditLogger(new CollectingAuditSink()),
        }),
    ).toThrow(/ghost/);
  });

  it("rejects duplicate connector registrations", () => {
    expect(
      () =>
        new Gateway({
          config: testConfig({ connectors: [{ id: "alpha" }] }),
          idpAdapter: testIdpAdapter(),
          connectors: [new MockConnector("alpha"), new MockConnector("alpha")],
          auditLogger: new AuditLogger(new CollectingAuditSink()),
        }),
    ).toThrow(/duplicate/);
  });
});
