/**
 * citedDocIds の記録方針(ADR-013 §2、ADR-019 決定5)。分類と不可逆化は Gateway の run API
 * (finish)が構成全体の規則でかける。Orchestrator は申告するだけで、鍵も分類器も持たない。
 * - プライベートスコープを持つソースが有効な構成 → 全件 hashed(デプロイ固有鍵の HMAC)
 * - 永続化不可のソース(Slack)が有効な構成 → citedDocIds を記録しない(searchedSources は残る)
 * - どちらもない構成 → <sourceId>:<documentId> のまま
 * 規則そのものの単体テストは Gateway 側(packages/gateway/test/run-records.test.ts)。
 */
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Orchestrator, ScriptedLlmClient, scriptedSubmit, scriptedToolUse } from "../src/index.js";
import {
  CorpusConnector,
  EXPENSE_POLICY,
  TEST_DOC_ID_HMAC_KEY,
  startGateway,
  type GatewayHarness,
  type GatewayHarnessOptions,
} from "./helpers/harness.js";
import { firstHit } from "./helpers/script.js";

const harnesses: GatewayHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

function hmac(docId: string): string {
  return `hmac:${createHmac("sha256", TEST_DOC_ID_HMAC_KEY).update(docId, "utf8").digest("hex")}`;
}

async function runWith(options: Partial<GatewayHarnessOptions>) {
  const harness = await startGateway({
    connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY]), new CorpusConnector("beta", [])],
    ...options,
  });
  harnesses.push(harness);
  const llm = new ScriptedLlmClient([
    () => scriptedToolUse([{ name: "search", input: { source: "alpha", query: "締め日" } }]),
    (context) => {
      const hit = firstHit(context);
      return scriptedSubmit({
        answer: "経費精算の締め日は毎月25日です。",
        citations: [{ documentId: hit.documentId, sourceId: hit.source }],
        confidence: 0.9,
      });
    },
  ]);
  const answer = await new Orchestrator({ llm }).run({ question: "締め日は?", gateway: harness.client() });
  expect(answer.citations).toHaveLength(1);
  const run = harness.answerRuns()[0];
  expect(run).toBeDefined();
  return { answer, run: run!, records: harness.records() };
}

describe("run の AnswerRun.citedDocIds(Gateway の run API が記録する)", () => {
  it("プライベートスコープを持つソース(included)が有効なら、shared の結果の引用も hashed になる", async () => {
    const { run, records } = await runWith({ includedSources: ["beta"] });
    expect(run.citedDocIds).toEqual([hmac("alpha:doc-expense-policy")]);
    expect(JSON.stringify(records)).not.toContain("doc-expense-policy");
    expect(JSON.stringify(records)).not.toContain(TEST_DOC_ID_HMAC_KEY);
  });

  it("Slack(永続化不可)のソースが有効なら、引用は記録せず searchedSources だけが残る", async () => {
    const { run, records } = await runWith({ slackSources: ["beta"] });
    expect(run.citedDocIds).toEqual([]);
    expect(run.searchedSources).toEqual(["alpha"]);
    // 質問原文も生クエリ表に書かれない(決定7)が、監査レコードには digest が残る
    expect(JSON.stringify(records)).not.toContain("締め日は?");
    expect(run.finalQueryDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("どちらもない構成では <sourceId>:<documentId> のまま記録する", async () => {
    const { run } = await runWith({});
    expect(run.citedDocIds).toEqual(["alpha:doc-expense-policy"]);
  });
});
