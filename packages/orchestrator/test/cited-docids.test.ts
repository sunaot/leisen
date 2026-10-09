/**
 * citedDocIds の分類と記録方針(T-007 セキュリティレビュー 2026-09-27 H2、ADR-013 §2、
 * ADR-017 確認事項5)。
 * - 分類器(DocIdClassifier)と audit.privateScopeDocIds は Orchestrator の必須オプション
 * - 未知のソース → 記録しない(プライベートスコープ + omitted とみなす。fail-closed)
 * - Slack → 常に記録しない / 非プライベート → そのまま記録 / プライベートスコープ +
 *   hashed → デプロイ固有鍵の HMAC / omitted → 記録しない
 * - hashed なのに鍵がない構成は構築時に拒否する(平文へ倒さない)
 * - deployment.yaml の connectors[](kind / privateScopes)から分類器を組み立てる
 * - 結果ごとの scope(ADR-016 追補2 決定5): プライベートスコープ = 結果の scope が
 *   shared でない、またはソースの方針が excluded でない(論理和)。scope の欠落・未知の
 *   値は private。Gateway と Orchestrator の設定がずれても private の結果は平文にならない
 */
import { createHmac } from "node:crypto";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuditLogger,
  BufferedAuditSink,
  InMemoryAuditStore,
  deploymentConfigSchema,
} from "@kp/gateway";
import {
  OMIT_ALL_DOC_IDS,
  Orchestrator,
  OrchestratorError,
  ScriptedLlmClient,
  citedDocIdsForAudit,
  docIdAuditFromDeployment,
  docIdClassifierFromConnectors,
  scriptedSubmit,
  scriptedToolUse,
  type AuditCitation,
  type CitedDocIdAudit,
  type DocIdClassifier,
} from "../src/index.js";
import {
  CorpusConnector,
  EXPENSE_POLICY,
  startGateway,
  type GatewayHarness,
} from "./helpers/harness.js";
import { firstHit } from "./helpers/script.js";

const HMAC_KEY = "dev-only-hmac-key";

const harnesses: GatewayHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

const classify: DocIdClassifier = (sourceId) =>
  ({
    wiki: { privateScope: false, slack: false },
    drive: { privateScope: true, slack: false },
    slack: { privateScope: false, slack: true },
    "slack-dm": { privateScope: true, slack: true },
  })[sourceId];

function cite(
  sourceId: string,
  documentId = "doc-1",
  scope: AuditCitation["scope"] = "shared",
): AuditCitation {
  return { sourceId, documentId, scope };
}

function hmac(docId: string): string {
  return `hmac:${createHmac("sha256", HMAC_KEY).update(docId, "utf8").digest("hex")}`;
}

describe("citedDocIdsForAudit", () => {
  const hashed: CitedDocIdAudit = { classify, privateScopeDocIds: "hashed", hmacKey: HMAC_KEY };
  const omitted: CitedDocIdAudit = { classify, privateScopeDocIds: "omitted" };

  it("未知のソースは記録しない(hashed でも。fail-closed)", () => {
    expect(citedDocIdsForAudit([cite("unknown")], hashed)).toEqual([]);
    expect(citedDocIdsForAudit([cite("unknown")], omitted)).toEqual([]);
  });

  it("Slack と分類されたソースは設定に関わらず記録しない", () => {
    expect(citedDocIdsForAudit([cite("slack"), cite("slack-dm")], hashed)).toEqual([]);
    expect(citedDocIdsForAudit([cite("slack"), cite("slack-dm")], omitted)).toEqual([]);
  });

  it("非プライベート・非 Slack のソースは <sourceId>:<documentId> のまま記録する", () => {
    expect(citedDocIdsForAudit([cite("wiki", "page-9")], hashed)).toEqual(["wiki:page-9"]);
    expect(citedDocIdsForAudit([cite("wiki", "page-9")], omitted)).toEqual(["wiki:page-9"]);
  });

  it("プライベートスコープ + hashed はデプロイ固有鍵の HMAC で記録する", () => {
    expect(citedDocIdsForAudit([cite("drive", "file-7")], hashed)).toEqual([hmac("drive:file-7")]);
  });

  it("プライベートスコープ + omitted は記録しない", () => {
    expect(citedDocIdsForAudit([cite("drive", "file-7")], omitted)).toEqual([]);
  });

  it("分類器の例外・想定外の戻り値は分類できないものとして記録しない", () => {
    const broken: CitedDocIdAudit = {
      classify: (sourceId) => {
        if (sourceId === "throws") {
          throw new Error("classifier failure");
        }
        return { privateScope: "no", slack: false } as unknown as ReturnType<DocIdClassifier>;
      },
      privateScopeDocIds: "hashed",
      hmacKey: HMAC_KEY,
    };
    expect(citedDocIdsForAudit([cite("throws"), cite("weird")], broken)).toEqual([]);
  });

  it("OMIT_ALL_DOC_IDS(kp-ask の --config なし)はどのソースも記録しない", () => {
    expect(citedDocIdsForAudit([cite("wiki"), cite("drive")], OMIT_ALL_DOC_IDS)).toEqual([]);
  });
});

describe("結果ごとの scope との論理和(ADR-016 追補2 決定5)", () => {
  const hashed: CitedDocIdAudit = { classify, privateScopeDocIds: "hashed", hmacKey: HMAC_KEY };
  const omitted: CitedDocIdAudit = { classify, privateScopeDocIds: "omitted" };

  it("方針 excluded のソース: shared の結果は平文、private の結果は hashed / omitted", () => {
    expect(
      citedDocIdsForAudit([cite("wiki", "page-1", "shared"), cite("wiki", "dm-2", "private")], hashed),
    ).toEqual(["wiki:page-1", hmac("wiki:dm-2")]);
    expect(
      citedDocIdsForAudit([cite("wiki", "page-1", "shared"), cite("wiki", "dm-2", "private")], omitted),
    ).toEqual(["wiki:page-1"]);
  });

  it("方針 included(excluded 以外)のソース: shared の結果も従来どおり hashed / omitted", () => {
    expect(citedDocIdsForAudit([cite("drive", "file-1", "shared")], hashed)).toEqual([
      hmac("drive:file-1"),
    ]);
    expect(citedDocIdsForAudit([cite("drive", "file-1", "shared")], omitted)).toEqual([]);
  });

  it("scope の欠落・未知の値(型の外から来た値)は private とみなす", () => {
    const missing = { sourceId: "wiki", documentId: "x" } as unknown as AuditCitation;
    const unknown = { sourceId: "wiki", documentId: "y", scope: "Shared" } as unknown as AuditCitation;
    expect(citedDocIdsForAudit([missing, unknown], hashed)).toEqual([hmac("wiki:x"), hmac("wiki:y")]);
    expect(citedDocIdsForAudit([missing, unknown], omitted)).toEqual([]);
  });

  it("Slack・分類できないソースの扱いは scope によらず変わらない(記録しない)", () => {
    expect(citedDocIdsForAudit([cite("slack", "d", "shared"), cite("unknown", "d", "shared")], hashed)).toEqual([]);
  });
});

describe("Orchestrator の構築時の検証", () => {
  const base = {
    llm: new ScriptedLlmClient([]),
    auditLogger: new AuditLogger(new BufferedAuditSink(new InMemoryAuditStore())),
  };

  it.each([
    ["分類器なし", undefined],
    ["classify が関数でない", { classify: "all", privateScopeDocIds: "omitted" }],
    ["未知の privateScopeDocIds", { classify, privateScopeDocIds: "plain" }],
    ["hashed なのに鍵がない", { classify, privateScopeDocIds: "hashed" }],
    ["鍵が空文字", { classify, privateScopeDocIds: "hashed", hmacKey: "" }],
  ])("%s → invalid_configuration", (_label, docIdAudit) => {
    let caught: unknown;
    try {
      new Orchestrator({ ...base, docIdAudit: docIdAudit as unknown as CitedDocIdAudit });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OrchestratorError);
    expect(caught).toMatchObject({ errorClass: "invalid_configuration" });
  });

  it("鍵を Orchestrator のシリアライズ・inspect・エラーに出さない", () => {
    const orchestrator = new Orchestrator({
      ...base,
      docIdAudit: { classify, privateScopeDocIds: "hashed", hmacKey: HMAC_KEY },
    });
    expect(JSON.stringify(orchestrator)).not.toContain(HMAC_KEY);
    expect(inspect(orchestrator, { depth: 10 })).not.toContain(HMAC_KEY);
  });
});

describe("deployment.yaml から分類器を組み立てる(kp-ask の --config)", () => {
  const config = deploymentConfigSchema.parse({
    schemaVersion: 1,
    deployment: { name: "docid-test" },
    idp: { adapter: { kind: "mock" } },
    connectors: [
      { id: "wiki", kind: "dev-fixture" },
      // consent は validate で拒否されるが(ADR-016 追補2 決定6)、届いた場合も安全側
      { id: "drive", kind: "gdrive", privateScopes: "consent" },
      { id: "shared", kind: "gdrive", privateScopes: "included", confirmPrivateScopesIncluded: true },
      { id: "slack" }, // kind は id と同じ slack
      { id: "chat", kind: "slack-rts" },
    ],
    audit: { privateScopeDocIds: "hashed" },
  });

  it("kind が slack(slack- で始まるプラグインを含む)→ slack、privateScopes が excluded 以外 → privateScope", () => {
    const classifier = docIdClassifierFromConnectors(config.connectors);
    expect(classifier("wiki")).toEqual({ privateScope: false, slack: false });
    expect(classifier("drive")).toEqual({ privateScope: true, slack: false });
    expect(classifier("shared")).toEqual({ privateScope: true, slack: false });
    expect(classifier("slack")).toEqual({ privateScope: false, slack: true });
    expect(classifier("chat")).toEqual({ privateScope: false, slack: true });
    expect(classifier("unlisted")).toBeUndefined();
  });

  it("audit.privateScopeDocIds と鍵を渡す(hashed の鍵がなければ構築時に拒否される)", () => {
    const policy = docIdAuditFromDeployment(config, HMAC_KEY);
    expect(policy.privateScopeDocIds).toBe("hashed");
    expect(
      citedDocIdsForAudit(
        [cite("wiki"), cite("drive"), cite("slack"), cite("chat"), cite("unlisted")],
        policy,
      ),
    ).toEqual(["wiki:doc-1", hmac("drive:doc-1")]);
    expect(docIdAuditFromDeployment(config, undefined)).not.toHaveProperty("hmacKey");
    expect(docIdAuditFromDeployment(config, "")).not.toHaveProperty("hmacKey");
  });
});

describe("run の AnswerRun.citedDocIds(実 Gateway)", () => {
  async function runWith(docIdAudit: CitedDocIdAudit) {
    const harness = await startGateway({
      connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])],
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
    const orchestrator = new Orchestrator({ llm, auditLogger: harness.auditLogger, docIdAudit });
    const answer = await orchestrator.run({ question: "締め日は?", gateway: harness.client() });
    expect(answer.citations).toHaveLength(1);
    return harness.answerRuns()[0]?.citedDocIds;
  }

  it("プライベートスコープ + hashed は HMAC で、分類できないソースは記録しない", async () => {
    expect(
      await runWith({
        classify: () => ({ privateScope: true, slack: false }),
        privateScopeDocIds: "hashed",
        hmacKey: HMAC_KEY,
      }),
    ).toEqual([hmac("alpha:doc-expense-policy")]);
    expect(
      await runWith({ classify: () => undefined, privateScopeDocIds: "hashed", hmacKey: HMAC_KEY }),
    ).toEqual([]);
    expect(
      await runWith({ classify: () => ({ privateScope: false, slack: true }), privateScopeDocIds: "omitted" }),
    ).toEqual([]);
  });
  it("Gateway が included でも Orchestrator の分類器が excluded とみなしていれば、private の結果は台帳の scope で hashed になる(設定のずれで平文にしない)", async () => {
    const harness = await startGateway({
      connectors: [
        new CorpusConnector("alpha", [
          { ...EXPENSE_POLICY, id: "dm-expense", scope: "private" },
          EXPENSE_POLICY,
        ]),
      ],
      includedSources: ["alpha"],
    });
    harnesses.push(harness);
    const llm = new ScriptedLlmClient([
      () => scriptedToolUse([{ name: "search", input: { source: "alpha", query: "締め日" } }]),
      () =>
        scriptedSubmit({
          answer: "経費精算の締め日は毎月25日です。",
          citations: [
            { documentId: "dm-expense", sourceId: "alpha" },
            { documentId: EXPENSE_POLICY.id, sourceId: "alpha" },
          ],
          confidence: 0.9,
        }),
    ]);
    const orchestrator = new Orchestrator({
      llm,
      auditLogger: harness.auditLogger,
      // 分類器は「方針 excluded」(privateScope: false)のつもり
      docIdAudit: {
        classify: () => ({ privateScope: false, slack: false }),
        privateScopeDocIds: "hashed",
        hmacKey: HMAC_KEY,
      },
    });
    const answer = await orchestrator.run({ question: "締め日は?", gateway: harness.client() });
    // scope は Answer の citations に載せない
    expect(answer.citations.map((c) => Object.keys(c).sort())).toEqual([
      ["documentId", "sourceId", "title", "url"],
      ["documentId", "sourceId", "title", "url"],
    ]);
    expect(harness.answerRuns()[0]?.citedDocIds).toEqual([
      hmac("alpha:dm-expense"),
      `alpha:${EXPENSE_POLICY.id}`,
    ]);
  });

  it("Gateway が excluded(既定)なら private の文書は台帳に届かず、出典にできない", async () => {
    const harness = await startGateway({
      connectors: [
        new CorpusConnector("alpha", [{ ...EXPENSE_POLICY, id: "dm-expense", scope: "private" }]),
      ],
    });
    harnesses.push(harness);
    const llm = new ScriptedLlmClient([
      () => scriptedToolUse([{ name: "search", input: { source: "alpha", query: "締め日" } }]),
      () =>
        scriptedSubmit({
          answer: "経費精算の締め日は毎月25日です。",
          citations: [{ documentId: "dm-expense", sourceId: "alpha" }],
          confidence: 0.9,
        }),
    ]);
    const orchestrator = new Orchestrator({
      llm,
      auditLogger: harness.auditLogger,
      docIdAudit: { classify: () => ({ privateScope: false, slack: false }), privateScopeDocIds: "omitted" },
    });
    const answer = await orchestrator.run({ question: "締め日は?", gateway: harness.client() });
    expect(answer.citations).toEqual([]);
    expect(harness.answerRuns()[0]?.citedDocIds).toEqual([]);
  });
});
