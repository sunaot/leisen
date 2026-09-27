/**
 * MCPツール面のSDK非依存ロジックのユニットテスト(T-003、ADR-001 追補3)。
 * tools.ts / meta.ts をMCP SDKのAPIを使わずに検証する。SDKへの依存を
 * mcp.ts / http.ts に閉じ込めること(SDK差し替え時の手戻りを限定する)は
 * 末尾のimport境界テストで固定する。
 * MCP境界を通した検証は mcp-proxy.test.ts / http-transport.test.ts。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AuditLogger,
  GATEWAY_META_KEYS,
  Gateway,
  GatewayError,
  callContextFromMeta,
  declarationFromMeta,
  listTools,
  normalizeToolError,
  runToolCall,
  type Identity,
} from "../src/index.js";
import {
  CollectingAuditSink,
  MockConnector,
  testConfig,
  testIdpAdapter,
} from "./helpers/proxy.js";

function build() {
  const alpha = new MockConnector("alpha");
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

const K = GATEWAY_META_KEYS;

describe("callContextFromMeta (runId / iteration)", () => {
  it.each([undefined, null, "run-1", 42, ["run-1"]])(
    "treats a non-object _meta (%j) as undeclared",
    (meta) => {
      expect(callContextFromMeta(meta)).toEqual({});
    },
  );

  it("reads prefixed keys, falls back to bare keys, and prefers prefixed ones", () => {
    expect(callContextFromMeta({ [K.runId]: "p", [K.iteration]: 1 })).toEqual({
      runId: "p",
      iteration: 1,
    });
    expect(callContextFromMeta({ runId: "b", iteration: 2 })).toEqual({
      runId: "b",
      iteration: 2,
    });
    expect(
      callContextFromMeta({ [K.runId]: "p", runId: "b", iteration: 5 }),
    ).toEqual({ runId: "p", iteration: 5 });
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
    expect(outcome).toEqual({
      ok: false,
      error: expect.objectContaining({ errorClass: "unauthenticated" }),
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
      expect(outcome).toEqual({
        ok: false,
        error: expect.objectContaining({ errorClass: "invalid_request" }),
      });
    }
    expect(alpha.calls).toHaveLength(0);
    expect(sink.records).toHaveLength(0);
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
