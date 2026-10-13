/**
 * Gateway へ送る `_meta` の組み立て(buildGatewayMeta。T-007、セキュリティ再レビュー S3):
 * - キー集合が @leisen/gateway の GATEWAY_META_KEYS の4キーと完全一致する(裸キー・余分な
 *   キーを送らない)。Gateway 自身の `_meta` 解釈(declarationFromMeta /
 *   callContextFromMeta)で誤記として拒否されずに同じ値へ読み戻せる
 * - src のうち gateway/meta.ts 以外は `_meta` のキーを書かない(組み立て・結果側の読み取り
 *   = GATEWAY_RESULT_META_KEYS の集約を固定。H1)
 * - E2E: Orchestrator の MCP クライアント(McpGatewayClient)経由で scheduled /
 *   autonomous を申告すると、実 Gateway(port 0 の HTTP)が execution_class_rejected を
 *   返し、監査(ToolInvocation)に1件残る。コネクタは呼ばれない(ADR-015、TM-C7 / TM-E5)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type Actor } from "@leisen/audit";
import {
  GATEWAY_META_KEYS,
  GATEWAY_RESULT_META_KEYS,
  META_KEY_PREFIX,
  callContextFromMeta,
  declarationFromMeta,
} from "@leisen/gateway";
import { buildGatewayMeta, gatewayUserIdFromResultMeta } from "../src/index.js";
import {
  CorpusConnector,
  EXPENSE_POLICY,
  startGateway,
  type GatewayHarness,
} from "./helpers/harness.js";

const harnesses: GatewayHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

const ALL_KEYS = Object.values(GATEWAY_META_KEYS).sort();
const BATCH_AGENT: Actor = {
  kind: "agent",
  agentId: "batch-1",
  onBehalfOfChain: ["alice"],
};

describe("buildGatewayMeta", () => {
  it("GATEWAY_META_KEYS の4キーちょうどで組み立てる(裸キー・余分なキーを含めない)", () => {
    expect(ALL_KEYS).toHaveLength(4);
    const meta = buildGatewayMeta({ runId: "run-1", iteration: 3 });
    expect(Object.keys(meta).sort()).toEqual(ALL_KEYS);
    expect(meta).toEqual({
      [GATEWAY_META_KEYS.runId]: "run-1",
      [GATEWAY_META_KEYS.iteration]: 3,
      [GATEWAY_META_KEYS.executionClass]: "human_in_the_loop",
      [GATEWAY_META_KEYS.actor]: { kind: "human" },
    });
    // 区分・actor を差し替えてもキー集合は変わらない
    const scheduled = buildGatewayMeta({
      runId: "run-1",
      iteration: 0,
      executionClass: "scheduled",
      actor: BATCH_AGENT,
    });
    expect(Object.keys(scheduled).sort()).toEqual(ALL_KEYS);
  });

  it("Gateway 自身の `_meta` 解釈で誤記として拒否されず、同じ値に読み戻せる", () => {
    const meta = buildGatewayMeta({ runId: "run-1", iteration: 3 });
    expect(declarationFromMeta(meta)).toEqual({
      executionClass: "human_in_the_loop",
      actor: { kind: "human" },
    });
    // 名前空間付きの runId は Gateway コアで署名・本人・actor・期限を検証する(declaredRunId)
    expect(callContextFromMeta(meta)).toEqual({ declaredRunId: "run-1", iteration: 3 });
  });

  it("結果側の `_meta` から Gateway が認証した userId を読む(名前空間のキーだけ。H1)", () => {
    expect(gatewayUserIdFromResultMeta({ [GATEWAY_RESULT_META_KEYS.userId]: "alice" })).toBe(
      "alice",
    );
    expect(gatewayUserIdFromResultMeta({ userId: "alice" })).toBeUndefined();
    expect(gatewayUserIdFromResultMeta(undefined)).toBeUndefined();
    expect(gatewayUserIdFromResultMeta([GATEWAY_RESULT_META_KEYS.userId])).toBeUndefined();
    // 要求側に書くと誤記として拒否されるキー(利用者を申告させる口にならない)
    expect(Object.values(GATEWAY_META_KEYS)).not.toContain(GATEWAY_RESULT_META_KEYS.userId);
  });

  it("src のうち gateway/meta.ts 以外は `_meta` のキー(GATEWAY_META_KEYS / GATEWAY_RESULT_META_KEYS / prefix)を書かない", () => {
    const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
    const files = (readdirSync(srcDir, { recursive: true }) as string[])
      .filter((file) => file.endsWith(".ts"))
      .map((file) => file.split("\\").join("/"));
    // 走査対象が空でないこと(パス解決の誤りで常に成功しないように)
    expect(files).toContain("orchestrator.ts");
    expect(files).toContain("gateway/meta.ts");
    const namespace = META_KEY_PREFIX.replace(/\/$/, "");
    const offenders = files
      .filter((file) => file !== "gateway/meta.ts")
      .filter((file) => {
        const source = readFileSync(join(srcDir, file), "utf8");
        return (
          source.includes("GATEWAY_META_KEYS") ||
          source.includes("GATEWAY_RESULT_META_KEYS") ||
          source.includes("META_KEY_PREFIX") ||
          source.includes(namespace)
        );
      });
    expect(offenders).toEqual([]);
  });
});

describe("E2E: Orchestrator の MCP クライアント経由の実行区分の申告(ADR-015、ADR-019)", () => {
  async function setup(): Promise<{ harness: GatewayHarness; alpha: CorpusConnector }> {
    const alpha = new CorpusConnector("alpha", [EXPENSE_POLICY]);
    const harness = await startGateway({ connectors: [alpha] });
    harnesses.push(harness);
    return { harness, alpha };
  }

  it.each(["scheduled", "autonomous"] as const)(
    "%s を agent actor で申告すると、本人の run の runId でも actor が違うため invalid_run_id で拒否され、単発 run として監査に1件残る(コネクタは呼ばれない)",
    async (executionClass) => {
      const { harness, alpha } = await setup();
      const client = harness.client();
      // 人間の run として開始した runId(actor human に束縛されている)
      const { runId } = await client.startRun({ question: "経費精算の締め日は?" });

      const outcome = await client.callTool(
        "search",
        { source: "alpha", query: "経費精算" },
        buildGatewayMeta({ runId, iteration: 0, executionClass, actor: BATCH_AGENT }),
      );

      expect(outcome).toMatchObject({
        ok: false,
        error: { errorClass: "invalid_run_id" },
      });
      expect(JSON.stringify(outcome)).not.toContain(runId);
      expect(alpha.calls).toHaveLength(0);
      const records = harness.toolInvocations();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        iteration: 0,
        userId: "alice",
        tool: "search",
        sourceId: "alpha",
        errorClass: "invalid_run_id",
      });
      // 申告した runId(本人の run)には混ぜない
      expect(records[0]?.runId).not.toBe(runId);
    },
  );

  it("対照: 既定の申告(human_in_the_loop / human)は Gateway が発行した runId でコネクタまで届き、その runId で監査に1件残る", async () => {
    const { harness, alpha } = await setup();
    const client = harness.client();
    const { runId } = await client.startRun({ question: "経費精算の締め日は?" });

    const outcome = await client.callTool(
      "search",
      { source: "alpha", query: "経費精算" },
      buildGatewayMeta({ runId, iteration: 0 }),
    );

    expect(outcome).toMatchObject({ ok: true });
    expect(alpha.calls).toHaveLength(1);
    const records = harness.toolInvocations();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      runId,
      iteration: 0,
      userId: "alice",
      errorClass: null,
    });
  });
});
