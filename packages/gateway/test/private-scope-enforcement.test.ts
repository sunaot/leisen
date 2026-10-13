/**
 * プライベート領域の方針の強制(ADR-016 追補2 決定3・4)。
 *
 * 方針(privateScopes)を無視して private の結果も返す試験用コネクタ
 * (PolicyIgnoringConnector)で、Gateway が落とす経路を検証する。
 * - excluded(既定): search / list / describe は private の結果を落とす。fetch は本文を捨てて
 *   private_scope_excluded(固定文言)。scope の欠落・未知の値は private とみなす
 * - included(確認フラグ付き): そのまま返す(scope は正規化して返す)
 * - 監査: returnedHitCount は落とした後の件数、private_scope_excluded は errorClass だけ、
 *   docId・落とした件数はどこにも出さない(監査・ログ・LLM 向けの応答)
 * - 起動時: excluded + unsupported(宣言なしの v0.3 を含む)は拒否、included は通る
 * 合成データのみ。資格情報はスタブ(秘密情報を含めない)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectorError,
  type ConnectorCapabilities,
  type FetchResult,
  type ListResult,
  type SearchResult,
  type SourceDescription,
} from "@leisen/connector-sdk";
import { AuditLogger } from "@leisen/audit";
import {
  DeploymentConfigError,
  Gateway,
  GatewayError,
  PRIVATE_SCOPE_EXCLUDED_MESSAGE,
  runToolCall,
  type DeploymentConfig,
  type GatewaySession,
} from "../src/index.js";
import {
  CollectingAuditSink,
  MockConnector,
  testConfig,
  testIdpAdapter,
} from "./helpers/proxy.js";

/** private の文書の識別に使う目印(どの出力にも現れてはならない) */
const PRIVATE_MARK = "dev-only-private-canary";

/**
 * 方針を無視するコネクタ(classified を宣言しつつ、private の結果も返す)。
 * scope の欠落・未知の値を混ぜ、Gateway の正規化も検証する。
 */
class PolicyIgnoringConnector extends MockConnector {
  override readonly capabilities: ConnectorCapabilities;

  constructor(
    sourceId: string,
    /** "none" は宣言なし(v0.3 のプラグイン) */
    handling: ConnectorCapabilities["privateScopeHandling"] | "none" = "classified",
    private readonly fetchScope: unknown = "private",
  ) {
    super(sourceId);
    this.capabilities = {
      nativeSearch: "full",
      ingest: false,
      ...(handling !== "none" ? { privateScopeHandling: handling } : {}),
    } as ConnectorCapabilities;
  }

  override async search(
    ...args: Parameters<MockConnector["search"]>
  ): Promise<SearchResult> {
    await super.search(...args);
    const hit = (documentId: string, scope: unknown) => ({
      documentId,
      title: `title ${documentId}`,
      snippet: `snippet ${documentId}`,
      url: `https://example.test/${documentId}`,
      ...(scope !== undefined ? { scope } : {}),
    });
    return {
      hits: [
        hit("shared-1", "shared"),
        hit(`${PRIVATE_MARK}-dm`, "private"),
        hit(`${PRIVATE_MARK}-missing`, undefined),
        hit(`${PRIVATE_MARK}-unknown`, "Shared"),
        hit("shared-2", "shared"),
      ],
      nextCursor: "next",
    } as unknown as SearchResult;
  }

  override async fetch(
    ...args: Parameters<MockConnector["fetch"]>
  ): Promise<FetchResult> {
    await super.fetch(...args);
    const [, documentId] = args;
    return {
      documentId,
      title: `title ${documentId}`,
      content: `${PRIVATE_MARK} body`,
      url: `https://example.test/${documentId}`,
      ...(this.fetchScope !== undefined ? { scope: this.fetchScope } : {}),
    } as unknown as FetchResult;
  }

  override async list(...args: Parameters<MockConnector["list"]>): Promise<ListResult> {
    await super.list(...args);
    return {
      entries: [
        { id: "team", name: "team", kind: "channel", scope: "shared" },
        { id: `${PRIVATE_MARK}-dm`, name: `${PRIVATE_MARK} dm`, kind: "channel", scope: "private" },
        { id: `${PRIVATE_MARK}-nolabel`, name: "no label", kind: "channel" },
      ],
    } as unknown as ListResult;
  }

  override async describe(
    ...args: Parameters<MockConnector["describe"]>
  ): Promise<SourceDescription> {
    const base = await super.describe(...args);
    return {
      ...base,
      topContainers: [
        { id: "team", name: "team", kind: "channel", scope: "shared" },
        { id: `${PRIVATE_MARK}-dm`, name: `${PRIVATE_MARK} dm`, kind: "channel", scope: "private" },
      ],
    };
  }
}

function excludedConfig(): DeploymentConfig {
  return testConfig();
}

function includedConfig(): DeploymentConfig {
  return testConfig({
    connectors: [
      { id: "alpha", privateScopes: "included", confirmPrivateScopesIncluded: true },
      { id: "beta" },
    ],
  });
}

function build(
  config: DeploymentConfig,
  alpha: MockConnector = new PolicyIgnoringConnector("alpha"),
) {
  const sink = new CollectingAuditSink();
  const gateway = new Gateway({
    config,
    idpAdapter: testIdpAdapter(),
    connectors: [alpha, new MockConnector("beta")],
    auditLogger: new AuditLogger(sink),
  });
  return { gateway, sink, alpha };
}

async function alice(gateway: Gateway): Promise<GatewaySession> {
  return gateway.resolveSession("session-alice");
}

async function rejection(promise: Promise<unknown>): Promise<GatewayError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(GatewayError);
  return error as GatewayError;
}

/** 標準出力・標準エラー・console への出力を捕捉する(デバッグログへの流出の検査)。 */
function captureOutput(): () => string {
  const chunks: string[] = [];
  const record = (...args: unknown[]) => {
    chunks.push(args.map(String).join(" "));
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(record as never);
  vi.spyOn(process.stderr, "write").mockImplementation(record as never);
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation(record as never);
  }
  return () => chunks.join("\n");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("excluded(既定): Gateway が private の結果を落とす", () => {
  it("search: private・scope 欠落・未知の値のヒットを落とし、returnedHitCount は落とした後の件数", async () => {
    const output = captureOutput();
    const { gateway, sink } = build(excludedConfig());
    const result = await gateway.handleToolCall(await alice(gateway), {
      tool: "search",
      sourceId: "alpha",
      query: "q",
    });
    expect(result.tool).toBe("search");
    if (result.tool !== "search") return;
    expect(result.result.hits.map((h) => [h.documentId, h.scope])).toEqual([
      ["shared-1", "shared"],
      ["shared-2", "shared"],
    ]);
    // 続きの有無はコネクタのカーソルのまま(落とした件数を示す値を足さない)
    expect(result.result).toEqual({ hits: expect.any(Array), nextCursor: "next" });

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({
      recordType: "tool_invocation",
      tool: "search",
      returnedHitCount: 2,
      errorClass: null,
    });
    // 監査レコード・ログに private の結果も落とした件数(3)を示す値も出さない
    const serialized = JSON.stringify(sink.records);
    expect(serialized).not.toContain(PRIVATE_MARK);
    expect(Object.keys(sink.records[0]!).sort()).toEqual(
      [
        "recordType",
        "requestId",
        "runId",
        "iteration",
        "userId",
        "timestamp",
        "sourceId",
        "tool",
        "queryDigest",
        "filtersDigest",
        "returnedHitCount",
        "fetchedDocCount",
        "latencyMs",
        "errorClass",
        "retryCount",
      ].sort(),
    );
    expect(output()).toBe("");
  });

  it("list / describe: private(と scope のない)区画を落とす", async () => {
    const { gateway, sink } = build(excludedConfig());
    const session = await alice(gateway);
    const listed = await gateway.handleToolCall(session, { tool: "list", sourceId: "alpha" });
    const described = await gateway.handleToolCall(session, {
      tool: "describe",
      sourceId: "alpha",
    });
    if (listed.tool !== "list" || described.tool !== "describe") {
      throw new Error("unexpected tool result");
    }
    expect(listed.result.entries).toEqual([
      { id: "team", name: "team", kind: "channel", scope: "shared" },
    ]);
    expect(described.result.topContainers).toEqual([
      { id: "team", name: "team", kind: "channel", scope: "shared" },
    ]);
    expect(JSON.stringify(sink.records)).not.toContain(PRIVATE_MARK);
  });

  it.each([
    ["private", "private"],
    ["scope の欠落", undefined],
    ["未知の値", "public"],
  ])("fetch: %s の結果は本文を捨てて private_scope_excluded(固定文言、docId を残さない)", async (_label, scope) => {
    const output = captureOutput();
    const { gateway, sink } = build(
      excludedConfig(),
      new PolicyIgnoringConnector("alpha", "classified", scope),
    );
    const documentId = `${PRIVATE_MARK}-doc`;
    const error = await rejection(
      gateway.handleToolCall(await alice(gateway), { tool: "fetch", sourceId: "alpha", documentId }),
    );
    expect(error.errorClass).toBe("private_scope_excluded");
    expect(error.message).toBe(PRIVATE_SCOPE_EXCLUDED_MESSAGE);
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({
      tool: "fetch",
      errorClass: "private_scope_excluded",
      fetchedDocCount: 0,
      returnedHitCount: null,
    });
    expect(JSON.stringify(sink.records)).not.toContain(PRIVATE_MARK);
    expect(output()).toBe("");
  });

  it("fetch: shared の結果はそのまま返す", async () => {
    const { gateway } = build(
      excludedConfig(),
      new PolicyIgnoringConnector("alpha", "classified", "shared"),
    );
    const result = await gateway.handleToolCall(await alice(gateway), {
      tool: "fetch",
      sourceId: "alpha",
      documentId: "doc",
    });
    expect(result.tool === "fetch" && result.result.scope).toBe("shared");
  });

  it("LLM 向けの応答(runToolCall)は固定文言だけで、本文・docId を含まない", async () => {
    const { gateway } = build(excludedConfig());
    const identity = await gateway.authenticate("session-alice");
    const outcome = await runToolCall(gateway, {
      identity,
      name: "fetch",
      arguments: { source: "alpha", documentId: `${PRIVATE_MARK}-doc` },
      meta: undefined,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toEqual({
      errorClass: "private_scope_excluded",
      message: PRIVATE_SCOPE_EXCLUDED_MESSAGE,
    });
    expect(outcome.text).not.toContain(PRIVATE_MARK);

    const search = await runToolCall(gateway, {
      identity,
      name: "search",
      arguments: { source: "alpha", query: "q" },
      meta: undefined,
    });
    expect(search.ok).toBe(true);
    // 落とした事実・件数を LLM に返さない
    expect(search.text).not.toContain(PRIVATE_MARK);
    expect(search.text).not.toMatch(/dropped|excluded|private/i);
  });

  it("コネクタ(enforced)が自ら private_scope_excluded で拒否した場合も固定文言にする", async () => {
    class EnforcingConnector extends MockConnector {
      override readonly capabilities: ConnectorCapabilities = {
        nativeSearch: "full",
        ingest: false,
        privateScopeHandling: "enforced",
      };

      override async fetch(): Promise<FetchResult> {
        throw new ConnectorError("private_scope_excluded", `${PRIVATE_MARK}: DM with someone`);
      }
    }
    const { gateway, sink } = build(excludedConfig(), new EnforcingConnector("alpha"));
    const error = await rejection(
      gateway.handleToolCall(await alice(gateway), {
        tool: "fetch",
        sourceId: "alpha",
        documentId: "dm",
      }),
    );
    expect(error.errorClass).toBe("private_scope_excluded");
    expect(error.message).toBe(PRIVATE_SCOPE_EXCLUDED_MESSAGE);
    expect(sink.records[0]).toMatchObject({ errorClass: "private_scope_excluded" });
  });
});

describe("included(確認フラグ付き): 落とさない", () => {
  it("search / fetch / list は private の結果も返し、scope は正規化する", async () => {
    const { gateway, sink } = build(includedConfig());
    const session = await alice(gateway);
    const searched = await gateway.handleToolCall(session, {
      tool: "search",
      sourceId: "alpha",
      query: "q",
    });
    if (searched.tool !== "search") throw new Error("unexpected tool result");
    expect(searched.result.hits.map((h) => h.scope)).toEqual([
      "shared",
      "private",
      "private",
      "private",
      "shared",
    ]);
    expect(sink.records[0]).toMatchObject({ returnedHitCount: 5 });

    const fetched = await gateway.handleToolCall(session, {
      tool: "fetch",
      sourceId: "alpha",
      documentId: "dm",
    });
    expect(fetched.tool === "fetch" && fetched.result.scope).toBe("private");

    const listed = await gateway.handleToolCall(session, { tool: "list", sourceId: "alpha" });
    expect(listed.tool === "list" && listed.result.entries.map((e) => e.scope)).toEqual([
      "shared",
      "private",
      "private",
    ]);
  });

  it("方針は sourceId ごと: 同じ Gateway の excluded のソースでは落とす", async () => {
    const sink = new CollectingAuditSink();
    const gateway = new Gateway({
      config: includedConfig(),
      idpAdapter: testIdpAdapter(),
      connectors: [new PolicyIgnoringConnector("alpha"), new PolicyIgnoringConnector("beta")],
      auditLogger: new AuditLogger(sink),
    });
    const session = await alice(gateway);
    const beta = await gateway.handleToolCall(session, { tool: "search", sourceId: "beta", query: "q" });
    expect(beta.tool === "search" && beta.result.hits).toHaveLength(2);
  });
});

describe("起動時の照合(ADR-016 追補2 決定3)", () => {
  function construct(config: DeploymentConfig, connector: MockConnector): unknown {
    try {
      build(config, connector);
      return undefined;
    } catch (error) {
      return error;
    }
  }

  it.each([
    ["unsupported", "unsupported"],
    ["宣言なし(v0.3)", "none"],
  ] as const)("excluded + %s のコネクタでは Gateway を構築できない", (_label, handling) => {
    const error = construct(excludedConfig(), new PolicyIgnoringConnector("alpha", handling));
    expect(error).toBeInstanceOf(DeploymentConfigError);
    expect((error as DeploymentConfigError).issues.map((i) => [i.code, i.path])).toEqual([
      ["private_scopes_unenforceable", "connectors[0].privateScopes"],
    ]);
  });

  it.each(["unsupported", "none"] as const)(
    "included(確認フラグ付き)は能力 %s でも構築でき、全結果を返す(scope のない結果は private として扱う)",
    async (handling) => {
      expect(construct(includedConfig(), new PolicyIgnoringConnector("alpha", handling))).toBeUndefined();
    },
  );
});
