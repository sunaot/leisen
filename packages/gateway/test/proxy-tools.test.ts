/**
 * MCPツール面のSDK非依存ロジックのユニットテスト(T-003、ADR-001 追補3)。
 * tools.ts / meta.ts をMCP SDKのAPIを使わずに検証する。SDKへの依存を
 * mcp.ts / http.ts に閉じ込めること(SDK差し替え時の手戻りを限定する)は
 * 末尾のimport境界テストで固定する。
 * MCP境界を通した検証は mcp-proxy.test.ts / http-transport.test.ts。
 *
 * セキュリティレビュー(2026-09-27)の反映分:
 * - TM-B2: permission_denied / not_found を同一の not_available に正規化する
 *   (監査レコードは元の分類を保持)
 * - M2: `_meta` の申告キーの誤記(裸キー・名前空間内の未知キー)を invalid_request で
 *   拒否する(ADR-015 の既定拒否を迂回させない)
 * - minor-1: コネクタの結果を既知フィールドだけに射影する(不変条件3、TM-A1)
 * - minor-2: 結果の直列化失敗も正規化エラーにする
 * - minor-8 / minor-10: 裸キーとprefix付きキーを混在させない、runId・sourceId の
 *   クライアント制御の値をそのまま監査に残さない
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ConnectorError,
  type FetchResult,
  type ListResult,
  type SearchResult,
  type SourceDescription,
} from "@kp/connector-sdk";
import {
  AuditLogger,
  GATEWAY_META_KEYS,
  Gateway,
  GatewayError,
  META_KEY_PREFIX,
  callContextFromMeta,
  declarationFromMeta,
  listTools,
  normalizeToolError,
  resolveCallContext,
  runToolCall,
  type DeploymentConfig,
  type Identity,
  type ToolCallOutcome,
} from "../src/index.js";
import {
  CollectingAuditSink,
  MockConnector,
  testConfig,
  testIdpAdapter,
} from "./helpers/proxy.js";

function build(
  options: { alpha?: MockConnector; config?: DeploymentConfig } = {},
) {
  const alpha = options.alpha ?? new MockConnector("alpha");
  const beta = new MockConnector("beta");
  const sink = new CollectingAuditSink();
  const gateway = new Gateway({
    config: options.config ?? testConfig(),
    idpAdapter: testIdpAdapter(),
    connectors: [alpha, beta],
    auditLogger: new AuditLogger(sink),
  });
  return { gateway, alpha, beta, sink };
}

const K = GATEWAY_META_KEYS;

type ScriptedResults = Partial<
  Record<"search" | "fetch" | "list" | "describe", unknown>
>;

/**
 * IF の型を外れた値(実行時の混入)を返すコネクタ。呼び出し記録は MockConnector に
 * 任せ、戻り値だけを差し替える。
 */
class ScriptedConnector extends MockConnector {
  constructor(
    sourceId: string,
    private readonly scripted: ScriptedResults,
  ) {
    super(sourceId);
  }

  override async search(
    ...args: Parameters<MockConnector["search"]>
  ): Promise<SearchResult> {
    const base = await super.search(...args);
    return (this.scripted.search ?? base) as SearchResult;
  }

  override async fetch(
    ...args: Parameters<MockConnector["fetch"]>
  ): Promise<FetchResult> {
    const base = await super.fetch(...args);
    return (this.scripted.fetch ?? base) as FetchResult;
  }

  override async list(
    ...args: Parameters<MockConnector["list"]>
  ): Promise<ListResult> {
    const base = await super.list(...args);
    return (this.scripted.list ?? base) as ListResult;
  }

  override async describe(
    ...args: Parameters<MockConnector["describe"]>
  ): Promise<SourceDescription> {
    const base = await super.describe(...args);
    return (this.scripted.describe ?? base) as SourceDescription;
  }
}

function expectSucceeded(
  outcome: ToolCallOutcome,
): Extract<ToolCallOutcome, { ok: true }> {
  if (!outcome.ok) {
    throw new Error(`expected success, got ${outcome.error.errorClass}`);
  }
  return outcome;
}

describe("callContextFromMeta (runId / iteration)", () => {
  it.each([undefined, null, "run-1", 42, ["run-1"]])(
    "treats a non-object _meta (%j) as undeclared",
    (meta) => {
      expect(callContextFromMeta(meta)).toEqual({});
    },
  );

  it("reads prefixed keys and falls back to bare keys only when no prefixed key is present", () => {
    expect(callContextFromMeta({ [K.runId]: "p", [K.iteration]: 1 })).toEqual({
      runId: "p",
      iteration: 1,
    });
    expect(callContextFromMeta({ runId: "b", iteration: 2 })).toEqual({
      runId: "b",
      iteration: 2,
    });
  });

  it("ignores every bare key once any prefixed key is present (no per-key mixing, minor-8)", () => {
    expect(
      callContextFromMeta({ [K.runId]: "p", runId: "b", iteration: 5 }),
    ).toEqual({ runId: "p" });
    expect(callContextFromMeta({ [K.iteration]: 3, runId: "b" })).toEqual({
      iteration: 3,
    });
    expect(
      callContextFromMeta({
        [K.executionClass]: "human_in_the_loop",
        runId: "b",
        iteration: 2,
      }),
    ).toEqual({});
  });

  it("accepts a runId only within [A-Za-z0-9._:-]{1,128} (minor-10)", () => {
    for (const runId of [
      "run:2026-09-27_a.b",
      "0f8fad5b-d9cb-469f-a165-70867728950e",
      "r".repeat(128),
    ]) {
      expect(callContextFromMeta({ [K.runId]: runId })).toEqual({ runId });
    }
    for (const runId of [
      "r".repeat(129),
      "r".repeat(5000),
      "run 1",
      "run/1",
      "run\n1",
      "ラン-1",
    ]) {
      expect(callContextFromMeta({ [K.runId]: runId, [K.iteration]: 2 })).toEqual({
        iteration: 2,
      });
    }
  });

  it("applies the same runId / iteration rules to in-process call contexts", () => {
    const newRunId = () => "generated-run";
    expect(resolveCallContext({ runId: "r".repeat(129), iteration: 3 }, newRunId)).toEqual({
      runId: "generated-run",
      iteration: 0,
    });
    expect(resolveCallContext({ runId: "run-1", iteration: -1 }, newRunId)).toEqual({
      runId: "run-1",
      iteration: 0,
    });
    expect(resolveCallContext({ runId: "run-1", iteration: 4 }, newRunId)).toEqual({
      runId: "run-1",
      iteration: 4,
    });
  });

  it("drops invalid values per key without falling back to bare keys", () => {
    expect(
      callContextFromMeta({ [K.runId]: "", runId: "b", [K.iteration]: 2.5 }),
    ).toEqual({});
    expect(callContextFromMeta({ [K.runId]: "p", [K.iteration]: -1 })).toEqual({
      runId: "p",
    });
  });
});

describe("declarationFromMeta (execution class / actor)", () => {
  it("returns no declaration when the keys are absent", () => {
    expect(declarationFromMeta(undefined)).toEqual({});
    expect(declarationFromMeta({ unrelated: true })).toEqual({});
  });

  it("parses valid declarations", () => {
    const actor = { kind: "agent", agentId: "a1", onBehalfOfChain: ["alice"] };
    expect(
      declarationFromMeta({ [K.executionClass]: "scheduled", [K.actor]: actor }),
    ).toEqual({ executionClass: "scheduled", actor });
  });

  it.each([
    { [K.executionClass]: "Scheduled" },
    { [K.executionClass]: null },
    { [K.actor]: { kind: "robot" } },
  ])("throws invalid_request for %j", (meta) => {
    expect(() => declarationFromMeta(meta)).toThrow(GatewayError);
    try {
      declarationFromMeta(meta);
    } catch (error) {
      expect((error as GatewayError).errorClass).toBe("invalid_request");
    }
  });

  // M2: 誤記を黙って無視すると申告が落ち、human_in_the_loop として通ってしまう
  it.each([
    ["a bare executionClass key", { executionClass: "scheduled" }],
    [
      "a lower-cased key inside the gateway prefix",
      { [`${META_KEY_PREFIX}executionclass`]: "autonomous" },
    ],
    [
      "an upper-cased gateway prefix",
      { ["IO.GITHUB.SUNAOT.LEISEN/executionClass"]: "scheduled" },
    ],
    [
      "a bare actor key",
      { actor: { kind: "agent", agentId: "a1", onBehalfOfChain: ["alice"] } },
    ],
    ["a bare execution_class key", { execution_class: "autonomous" }],
    ["an unknown key inside the gateway prefix", { [`${META_KEY_PREFIX}runid`]: "run-1" }],
  ])(
    "rejects %s as invalid_request without echoing the key or the value (M2)",
    (_label, meta) => {
      let caught: unknown;
      try {
        declarationFromMeta(meta);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GatewayError);
      const error = caught as GatewayError;
      expect(error.errorClass).toBe("invalid_request");
      for (const [key, value] of Object.entries(meta)) {
        expect(error.message).not.toContain(key);
        if (typeof value === "string") {
          expect(error.message).not.toContain(value);
        }
      }
    },
  );

  it("still accepts unrelated keys (MCP-defined, other namespaces, legacy runId) next to the documented ones", () => {
    expect(
      declarationFromMeta({
        progressToken: 1,
        "io.modelcontextprotocol/related-task": { taskId: "t" },
        "com.example/executionClass": "scheduled",
        runId: "run-bare",
        iteration: 1,
        [K.executionClass]: "human_in_the_loop",
        [K.actor]: { kind: "human" },
      }),
    ).toEqual({ executionClass: "human_in_the_loop", actor: { kind: "human" } });
  });
});

describe("listTools / runToolCall (SDK-independent tool surface)", () => {
  it("refuses tool schemas without a verified identity and otherwise ignores the identity", async () => {
    const { gateway } = build();
    expect(listTools(gateway, undefined)).toEqual({
      ok: false,
      error: expect.objectContaining({ errorClass: "unauthenticated" }),
    });
    const alice = await gateway.authenticate("session-alice");
    const bob = await gateway.authenticate("session-bob");
    const forAlice = listTools(gateway, alice);
    expect(forAlice.ok).toBe(true);
    expect(listTools(gateway, bob)).toEqual(forAlice);
  });

  it("fails closed without an identity: no connector call, no audit record", async () => {
    const { gateway, alpha, sink } = build();
    const outcome = await runToolCall(gateway, {
      identity: undefined,
      name: "search",
      arguments: { source: "alpha", query: "q" },
      meta: undefined,
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: { errorClass: "unauthenticated" },
    });
    expect(alpha.calls).toHaveLength(0);
    expect(sink.records).toHaveLength(0);
  });

  it("builds a request-scoped session from the identity and _meta, then delegates to the core", async () => {
    const { gateway, alpha, sink } = build();
    const identity: Identity = await gateway.authenticate("session-bob");
    const outcome = await runToolCall(gateway, {
      identity,
      name: "search",
      arguments: { source: "alpha", query: "q" },
      meta: { [K.runId]: "run-unit", [K.iteration]: 1 },
    });
    expect(outcome.ok).toBe(true);
    expect(alpha.calls[0]?.auth.userId).toBe("bob");
    expect(sink.records[0]).toMatchObject({
      userId: "bob",
      runId: "run-unit",
      iteration: 1,
    });
  });

  it("normalizes argument and declaration errors before dispatch", async () => {
    const { gateway, alpha, sink } = build();
    const identity = await gateway.authenticate("session-alice");
    const badArgs = await runToolCall(gateway, {
      identity,
      name: "search",
      arguments: { source: "alpha" },
      meta: undefined,
    });
    const badDeclaration = await runToolCall(gateway, {
      identity,
      name: "search",
      arguments: { source: "alpha", query: "q" },
      meta: { [K.executionClass]: "cron" },
    });
    for (const outcome of [badArgs, badDeclaration]) {
      expect(outcome).toMatchObject({
        ok: false,
        error: { errorClass: "invalid_request" },
      });
      // text は正規化エラーそのものの直列化(MCP の text content に載る)
      if (!outcome.ok) {
        expect(JSON.parse(outcome.text)).toEqual(outcome.error);
      }
    }
    expect(alpha.calls).toHaveLength(0);
    expect(sink.records).toHaveLength(0);
  });

  it("returns the serialized result as text and the same content as result", async () => {
    const { gateway } = build();
    const identity = await gateway.authenticate("session-alice");
    const outcome = expectSucceeded(
      await runToolCall(gateway, {
        identity,
        name: "search",
        arguments: { source: "alpha", query: "q" },
        meta: undefined,
      }),
    );
    expect(JSON.parse(outcome.text)).toEqual(outcome.result);
    expect(outcome.result).toEqual({
      hits: [
        {
          documentId: "alpha-doc-1",
          title: "alpha doc 1",
          snippet: "snippet from alpha",
          url: "https://example.test/alpha/doc-1",
        },
      ],
    });
  });

  // M2: レビューで実証された2件(裸キー / prefix内の大文字小文字違い)
  it.each([
    ["a bare executionClass key", { executionClass: "scheduled" }],
    [
      "a lower-cased key inside the gateway prefix",
      { [`${META_KEY_PREFIX}executionclass`]: "autonomous" },
    ],
  ])(
    "rejects a misspelled declaration (%s) before dispatch: no connector call, no audit record (M2)",
    async (_label, meta) => {
      const { gateway, alpha, beta, sink } = build();
      const identity = await gateway.authenticate("session-alice");
      const outcome = await runToolCall(gateway, {
        identity,
        name: "search",
        arguments: { source: "alpha", query: "q" },
        meta,
      });
      expect(outcome).toMatchObject({
        ok: false,
        error: { errorClass: "invalid_request" },
      });
      expect(alpha.calls).toHaveLength(0);
      expect(beta.calls).toHaveLength(0);
      expect(sink.records).toHaveLength(0);
    },
  );

  it("keeps rejecting a correctly prefixed scheduled declaration by execution class (audited once)", async () => {
    const { gateway, alpha, sink } = build();
    const identity = await gateway.authenticate("session-alice");
    const outcome = await runToolCall(gateway, {
      identity,
      name: "search",
      arguments: { source: "alpha", query: "q" },
      meta: {
        [K.executionClass]: "scheduled",
        [K.actor]: { kind: "agent", agentId: "batch-1", onBehalfOfChain: ["alice"] },
      },
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: { errorClass: "execution_class_rejected" },
    });
    expect(alpha.calls).toHaveLength(0);
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({ errorClass: "execution_class_rejected" });
  });
});

describe("existence-hiding normalization (TM-B2)", () => {
  const NOT_AVAILABLE = {
    errorClass: "not_available",
    message: "the requested document or source is not available to this user",
  };

  it.each([
    ["fetch", { source: "alpha", documentId: "issue:acme/secret-repo#1" }],
    ["search", { source: "alpha", query: "merger plan" }],
  ] as const)(
    "%s: returns an identical not_available error for permission_denied and not_found while the audit keeps the original class",
    async (tool, args) => {
      const denied = build({
        alpha: new MockConnector("alpha", {
          failWith: new ConnectorError(
            "permission_denied",
            "GitHub API issues.get responded HTTP 403 (the organization requires SAML SSO authorization for this user's GitHub token)",
          ),
        }),
      });
      const missing = build({
        alpha: new MockConnector("alpha", {
          failWith: new ConnectorError(
            "not_found",
            "GitHub API issues.get responded HTTP 404 (not found)",
          ),
        }),
      });
      const [fromDenied, fromMissing] = await Promise.all(
        [denied, missing].map(async ({ gateway }) =>
          runToolCall(gateway, {
            identity: await gateway.authenticate("session-alice"),
            name: tool,
            arguments: args,
            meta: undefined,
          }),
        ),
      );

      // LLM/利用者に返る値は分類・文言・直列化とも完全一致
      expect(fromDenied).toEqual(fromMissing);
      expect(fromDenied).toEqual({
        ok: false,
        error: NOT_AVAILABLE,
        text: JSON.stringify(NOT_AVAILABLE),
      });
      // 監査レコードは元の分類を保持する(閲覧は高権限限定、TM-B2)
      expect(denied.sink.records).toHaveLength(1);
      expect(denied.sink.records[0]).toMatchObject({ errorClass: "permission_denied" });
      expect(missing.sink.records).toHaveLength(1);
      expect(missing.sink.records[0]).toMatchObject({ errorClass: "not_found" });
    },
  );

  it("normalizeToolError maps both classes to the same fixed error without retryAfterMs", () => {
    const fromDenied = normalizeToolError(
      new GatewayError("permission_denied", "HTTP 403 with SSO hint", 5000),
    );
    const fromMissing = normalizeToolError(new GatewayError("not_found", "HTTP 404"));
    expect(fromDenied).toEqual(fromMissing);
    expect(fromDenied).toEqual(NOT_AVAILABLE);
    expect(fromDenied).not.toHaveProperty("retryAfterMs");
  });
});

describe("result projection to connector-sdk fields (minor-1, 不変条件3 / TM-A1)", () => {
  it("drops fields outside the IF (totalCount, debug.preFilter, extra hit fields, non-string meta)", async () => {
    const leaky = new ScriptedConnector("alpha", {
      search: {
        hits: [
          {
            documentId: "d1",
            title: "t1",
            snippet: "s1",
            url: "https://example.test/d1",
            anchor: { kind: "section", value: "h1", label: "H1", preFilterRank: 3 },
            updatedAt: "2026-09-01T00:00:00Z",
            meta: { type: "issue", candidateTotal: 42, nested: { preFilter: 7 } },
            score: 0.93,
            rawCandidates: ["unauthorized-candidate-title"],
          },
        ],
        nextCursor: "c2",
        totalCount: 987654,
        debug: { preFilter: { candidates: 17, dropped: 16 } },
      },
      fetch: {
        documentId: "d1",
        title: "t1",
        content: "body",
        url: "https://example.test/d1",
        nextPageCursor: "p2",
        totalPages: 99,
        debug: { preFilter: 1 },
      },
      list: {
        entries: [
          { id: "c1", name: "n1", kind: "folder", childCount: 3, hiddenChildren: 5 },
        ],
        nextCursor: "l2",
        totalCount: 10,
      },
      describe: {
        sourceId: "alpha",
        displayName: "Alpha",
        summary: "summary",
        topContainers: [{ id: "c1", name: "n1", kind: "space", aclSnapshot: ["x"] }],
        supportedFilters: ["updatedAfter", "unsupportedFilter"],
        debug: { preFilter: 2 },
      },
    });
    const { gateway, sink } = build({ alpha: leaky });
    const identity = await gateway.authenticate("session-alice");
    const call = (name: string, args: Record<string, unknown>) =>
      runToolCall(gateway, { identity, name, arguments: args, meta: undefined }).then(
        expectSucceeded,
      );

    const search = await call("search", { source: "alpha", query: "q" });
    const fetched = await call("fetch", { source: "alpha", documentId: "d1" });
    const listed = await call("list", { source: "alpha" });
    const described = await call("describe", { source: "alpha" });

    expect(search.result).toEqual({
      hits: [
        {
          documentId: "d1",
          title: "t1",
          snippet: "s1",
          url: "https://example.test/d1",
          anchor: { kind: "section", value: "h1", label: "H1" },
          updatedAt: "2026-09-01T00:00:00Z",
          meta: { type: "issue" },
        },
      ],
      nextCursor: "c2",
    });
    expect(fetched.result).toEqual({
      documentId: "d1",
      title: "t1",
      content: "body",
      url: "https://example.test/d1",
      nextPageCursor: "p2",
    });
    expect(listed.result).toEqual({
      entries: [{ id: "c1", name: "n1", kind: "folder", childCount: 3 }],
      nextCursor: "l2",
    });
    expect(described.result).toEqual({
      sourceId: "alpha",
      displayName: "Alpha",
      summary: "summary",
      topContainers: [{ id: "c1", name: "n1", kind: "space" }],
      supportedFilters: ["updatedAfter"],
    });
    for (const outcome of [search, fetched, listed, described]) {
      expect(outcome.text).not.toMatch(
        /totalCount|preFilter|candidate|score|hiddenChildren|aclSnapshot|totalPages|987654/i,
      );
    }
    // 監査の returnedHitCount は射影後(認可済み返却分)の件数
    expect(sink.records[0]).toMatchObject({ tool: "search", returnedHitCount: 1 });
  });

  it("rejects a result whose required field has the wrong type (a BigInt title) as internal_error, audited, without raw text (minor-1 / minor-2)", async () => {
    const broken = new ScriptedConnector("alpha", {
      search: {
        hits: [{ documentId: "d1", title: 12345678901234567890n, snippet: "", url: "u" }],
      },
    });
    const { gateway, sink } = build({ alpha: broken });
    const outcome = await runToolCall(gateway, {
      identity: await gateway.authenticate("session-alice"),
      name: "search",
      arguments: { source: "alpha", query: "q" },
      meta: undefined,
    });
    expect(outcome).toEqual({
      ok: false,
      error: { errorClass: "internal_error", message: "connector returned a malformed result" },
      text: JSON.stringify({
        errorClass: "internal_error",
        message: "connector returned a malformed result",
      }),
    });
    expect(outcome.text).not.toMatch(/BigInt|12345678901234567890/);
    expect(sink.records[0]).toMatchObject({ errorClass: "internal_error", returnedHitCount: null });
  });
});

describe("result serialization inside runToolCall (minor-2)", () => {
  const circular: Record<string, unknown> = { hits: [] };
  circular["self"] = circular;

  it.each([
    ["a BigInt", { hits: [], nextCursor: 10n }],
    ["a circular structure", circular],
  ])(
    "normalizes a result containing %s to a fixed internal_error instead of the raw exception message",
    async (_label, result) => {
      const identity = await build().gateway.authenticate("session-alice");
      // Gatewayコアの射影を経ない値を返すスタブ(runToolCall の直列化の防御だけを検証する)
      const stub = {
        handleToolCall: async () => ({ tool: "search", result }),
      } as unknown as Gateway;
      const outcome = await runToolCall(stub, {
        identity,
        name: "search",
        arguments: { source: "alpha", query: "q" },
        meta: undefined,
      });
      expect(outcome).toEqual({
        ok: false,
        error: { errorClass: "internal_error", message: "tool result could not be serialized" },
        text: JSON.stringify({
          errorClass: "internal_error",
          message: "tool result could not be serialized",
        }),
      });
      expect(outcome.text).not.toMatch(/BigInt|circular/i);
    },
  );
});

describe("client-controlled values in audit records (minor-10)", () => {
  it("records a 5000-character runId as an undeclared single-shot run", async () => {
    const { gateway, sink } = build();
    const longRunId = "r".repeat(5000);
    const outcome = await runToolCall(gateway, {
      identity: await gateway.authenticate("session-alice"),
      name: "search",
      arguments: { source: "alpha", query: "q" },
      meta: { [K.runId]: longRunId, [K.iteration]: 4 },
    });
    expect(outcome.ok).toBe(true);
    expect(sink.records).toHaveLength(1);
    const [record] = sink.records;
    expect(record).toMatchObject({ iteration: 0 });
    expect(record?.recordType === "tool_invocation" ? record.runId : "").toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(JSON.stringify(record)).not.toContain(longRunId);
  });

  it("records a 5000-character unknown source as the fixed sourceId 'unknown'", async () => {
    const { gateway, alpha, beta, sink } = build();
    const longSource = "s".repeat(5000);
    const outcome = await runToolCall(gateway, {
      identity: await gateway.authenticate("session-alice"),
      name: "search",
      arguments: { source: longSource, query: "q" },
      meta: undefined,
    });
    expect(outcome).toMatchObject({ ok: false, error: { errorClass: "unknown_source" } });
    expect(alpha.calls).toHaveLength(0);
    expect(beta.calls).toHaveLength(0);
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({
      sourceId: "unknown",
      errorClass: "unknown_source",
    });
    expect(JSON.stringify(sink.records[0])).not.toContain(longSource);
  });

  it("keeps the configured sourceId for a disabled source (a value from deployment.yaml)", async () => {
    const { gateway, beta, sink } = build({
      config: testConfig({
        connectors: [{ id: "alpha" }, { id: "beta", enabled: false }],
      }),
    });
    const outcome = await runToolCall(gateway, {
      identity: await gateway.authenticate("session-alice"),
      name: "search",
      arguments: { source: "beta", query: "q" },
      meta: undefined,
    });
    expect(outcome).toMatchObject({ ok: false, error: { errorClass: "source_disabled" } });
    expect(beta.calls).toHaveLength(0);
    expect(sink.records[0]).toMatchObject({
      sourceId: "beta",
      errorClass: "source_disabled",
    });
  });
});

describe("normalizeToolError", () => {
  it("never passes raw exception messages through (TM-A2)", () => {
    expect(normalizeToolError(new Error("raw dev-only-internal detail"))).toEqual({
      errorClass: "internal_error",
      message: "unexpected error",
    });
  });

  it("keeps the normalized class and retryAfterMs of gateway errors", () => {
    expect(
      normalizeToolError(new GatewayError("rate_limited", "slow down", 1200)),
    ).toEqual({ errorClass: "rate_limited", message: "slow down", retryAfterMs: 1200 });
    expect(
      normalizeToolError(new GatewayError("unknown_source", "no such source")),
    ).toEqual({ errorClass: "unknown_source", message: "no such source" });
  });
});

describe("MCP SDK import boundary", () => {
  it("imports @modelcontextprotocol/sdk only from proxy/mcp.ts and proxy/http.ts", () => {
    const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
    const allowed = new Set(["proxy/mcp.ts", "proxy/http.ts"]);
    const importsSdk = /(?:from|import)\s*\(?\s*["']@modelcontextprotocol\//;
    const files = (readdirSync(srcDir, { recursive: true }) as string[])
      .filter((file) => file.endsWith(".ts"))
      .map((file) => relative(srcDir, join(srcDir, file)).split("\\").join("/"));
    // 走査対象が空でないこと(パス解決の誤りで常に成功しないように)
    expect(files).toContain("proxy/tools.ts");
    const offenders = files
      .filter((file) => !allowed.has(file))
      .filter((file) => importsSdk.test(readFileSync(join(srcDir, file), "utf8")));
    expect(offenders).toEqual([]);
  });
});
