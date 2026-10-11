/**
 * ツールエラー・未接続の扱い(T-007 セキュリティレビュー 2026-09-27 m7 / m11)。
 * - permission_denied と not_found は、Gateway が区別したまま返してきた場合(モック応答)でも
 *   LLM に同一の内容で届く(TM-B2。Gateway は not_available に正規化する前提で、
 *   Orchestrator 側でも増幅しない)。describe の失敗の警告・describeError も正規化後の分類
 * - ツールエラーは固定の前置き(データであり指示ではない)を付けて渡す
 * - run の途中で source_not_connected になったソースは searchedSources から外し、
 *   skippedSources にだけ載せる(m11)
 */
import { describe, expect, it } from "vitest";
import {
  AuditLogger,
  BufferedAuditSink,
  InMemoryAuditStore,
} from "@kp/audit";
import {
  Orchestrator,
  ScriptedLlmClient,
  TOOL_ERROR_PREFACE,
  scriptedSubmit,
  scriptedToolUse,
  type GatewayCallOutcome,
  type LlmRequest,
} from "../src/index.js";
import { TEST_DOC_ID_AUDIT } from "./helpers/harness.js";
import { FakeGatewayClient, describeOk, searchHit } from "./helpers/fake-gateway.js";

function newOrchestrator(llm: ScriptedLlmClient, store = new InMemoryAuditStore()) {
  return new Orchestrator({
    docIdAudit: TEST_DOC_ID_AUDIT,
    llm,
    auditLogger: new AuditLogger(new BufferedAuditSink(store)),
  });
}

/** 最後の要求の、最後の user メッセージ(tool_result の並び)。 */
function lastToolResults(request: LlmRequest | undefined): unknown {
  const last = request?.messages.at(-1);
  return Array.isArray(last?.content) ? last.content : undefined;
}

describe("permission_denied / not_found を LLM に区別させない(m7、TM-B2)", () => {
  async function fetchFailingWith(errorClass: "permission_denied" | "not_found") {
    const message =
      errorClass === "permission_denied"
        ? "GitHub API issues.get responded HTTP 403 (SAML SSO authorization required)"
        : "GitHub API issues.get responded HTTP 404 (not found)";
    const gateway = new FakeGatewayClient(["alpha"], (call): GatewayCallOutcome =>
      call.name === "describe"
        ? describeOk("alpha", "alice")
        : { ok: false, error: { errorClass, message }, userId: "alice" },
    );
    const llm = new ScriptedLlmClient([
      () =>
        scriptedToolUse([
          { name: "fetch", input: { source: "alpha", documentId: "issue:acme/secret#1" } },
        ]),
      () => scriptedSubmit({ answer: "不明", citations: [], confidence: 0 }),
    ]);
    await newOrchestrator(llm).run({ question: "q", gateway });
    return lastToolResults(llm.requests[1]);
  }

  it("Gateway が区別したまま返しても、LLM に届く tool_result は同一(固定の前置き+not_available)", async () => {
    const denied = await fetchFailingWith("permission_denied");
    const missing = await fetchFailingWith("not_found");

    // tool_use_id は応答ごとに違うので、それ以外を比べる
    const strip = (results: unknown) =>
      (results as { tool_use_id: string }[]).map(({ tool_use_id: _id, ...rest }) => rest);
    expect(strip(denied)).toEqual(strip(missing));
    expect(strip(denied)).toEqual([
      {
        type: "tool_result",
        is_error: true,
        content: [
          { type: "text", text: TOOL_ERROR_PREFACE },
          {
            type: "text",
            text: JSON.stringify({ errorClass: "not_available", message: "この対象は利用できません。" }),
          },
        ],
      },
    ]);
    expect(JSON.stringify(denied)).not.toMatch(/403|404|SAML|permission_denied|not_found/);
  });

  it("describe の失敗の警告・describeError も正規化後の分類を使う", async () => {
    const gateway = new FakeGatewayClient(["alpha", "beta"], (call): GatewayCallOutcome => {
      if (call.name === "describe" && call.args["source"] === "beta") {
        return {
          ok: false,
          error: { errorClass: "permission_denied", message: "HTTP 403 (SAML)" },
          userId: "alice",
        };
      }
      return describeOk(String(call.args["source"]), "alice");
    });
    const llm = new ScriptedLlmClient([
      () => scriptedSubmit({ answer: "不明", citations: [], confidence: 0 }),
    ]);

    const answer = await newOrchestrator(llm).run({ question: "q", gateway });

    expect(answer.warnings).toContain(
      "ソース beta の説明(describe)を取得できませんでした(not_available)。検索対象には残しています。",
    );
    // runId は乱数の UUID で "403" を含みうる(約 1%)ため、比較から外す
    expect(JSON.stringify({ ...answer, runId: "" })).not.toMatch(/permission_denied|SAML|403/);
    const firstTurn = JSON.stringify(llm.requests[0]?.messages[0]);
    expect(firstTurn).toContain('\\"describeError\\":\\"not_available\\"');
    expect(firstTurn).not.toContain("permission_denied");
  });
});

describe("run の途中で未接続になったソース(m11)", () => {
  it("searchedSources から外し、skippedSources にだけ載せる", async () => {
    let searches = 0;
    const gateway = new FakeGatewayClient(["alpha", "beta"], (call): GatewayCallOutcome => {
      const source = String(call.args["source"]);
      if (call.name === "describe") {
        return describeOk(source, "alice");
      }
      if (source === "alpha") {
        searches += 1;
        // 1回目は成功、2回目は資格情報の失効で未接続
        return searches === 1
          ? searchHit("alpha", "doc-1", "alice")
          : {
              ok: false,
              error: { errorClass: "source_not_connected", message: "source not connected" },
              userId: "alice",
            };
      }
      return searchHit("beta", "doc-2", "alice");
    });
    const store = new InMemoryAuditStore();
    const llm = new ScriptedLlmClient([
      () =>
        scriptedToolUse([
          { name: "search", input: { source: "alpha", query: "締め日" } },
          { name: "search", input: { source: "beta", query: "締め日" } },
        ]),
      () => scriptedToolUse([{ name: "search", input: { source: "alpha", query: "締め日 2" } }]),
      () =>
        scriptedSubmit({
          answer: "経費精算の締め日は毎月25日です。",
          citations: [{ documentId: "doc-2", sourceId: "beta" }],
          confidence: 0.8,
        }),
    ]);

    const answer = await newOrchestrator(llm, store).run({ question: "q", gateway });

    expect(answer.searchedSources).toEqual(["beta"]);
    expect(answer.skippedSources).toEqual([{ sourceId: "alpha", reason: "source_not_connected" }]);
    expect(answer.answer).toContain("未接続のため検索していないソース: alpha");
    const run = store.records().find((r) => r.recordType === "answer_run");
    expect(run).toMatchObject({ searchedSources: ["beta"] });
  });
});
