/**
 * outcome: error の回答文(failure-text.ts、issue #38 UX R9)。
 *
 * - 失敗の正規化コードを「設定・接続先の誤り / 資格情報 / 一時的な障害 / 内容 / 不明」に分け、
 *   一時的な障害以外では「時間をおいて再度お試しください」を出さない(待っても直らない失敗で
 *   待たせない)
 * - 文言に URL・ホスト名・トークンを含めない(RS-4)。正規化コードは括弧で添える
 * - run の結果(Gateway の接続先の誤り・403・5xx、LLM の分類)が対応する分類の文言になる
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  AuditLogger,
  BufferedAuditSink,
  InMemoryAuditStore,
} from "@leisen/audit";
import {
  GatewayClientError,
  failureCategoryOf,
  failureTextFor,
  findUrlLikeSpans,
  LlmError,
  McpGatewayClient,
  Orchestrator,
  ScriptedLlmClient,
  type FailureCategory,
  type GatewayClient,
} from "../src/index.js";
import {
  ALICE_TOKEN,
  CorpusConnector,
  EXPENSE_POLICY,
  startGateway,
  type GatewayHarness,
} from "./helpers/harness.js";
import { FakeGatewayClient } from "./helpers/fake-gateway.js";
import { startMockHttpServer, type MockHttpServer } from "./helpers/mock-http.js";

const RETRY_LATER = "時間をおいて再度お試しください";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const CATEGORIES: readonly (readonly [string, FailureCategory])[] = [
  ["gateway_protocol_error", "configuration"],
  ["gateway_rejected", "configuration"],
  ["no_searchable_sources", "configuration"],
  ["user_unverified", "configuration"],
  ["llm_invalid_request", "configuration"],
  ["gateway_unauthenticated", "credentials"],
  ["gateway_forbidden", "credentials"],
  ["user_mismatch", "credentials"],
  ["llm_credentials_missing", "credentials"],
  ["llm_authentication_failed", "credentials"],
  ["llm_permission_denied", "credentials"],
  ["gateway_unavailable", "transient"],
  ["gateway_timeout", "transient"],
  ["run_timeout", "transient"],
  ["llm_rate_limited", "transient"],
  ["llm_overloaded", "transient"],
  ["llm_unavailable", "transient"],
  ["llm_timeout", "transient"],
  ["llm_refusal", "content"],
  ["llm_max_tokens", "content"],
  ["llm_context_window_exceeded", "content"],
  ["llm_client_error", "unknown"],
  ["llm_unexpected_response", "unknown"],
  ["llm_pause_turn", "unknown"],
  ["internal_error", "unknown"],
  ["something_new", "unknown"],
];

describe("failureCategoryOf / failureTextFor", () => {
  it.each(CATEGORIES)("%s は %s", (code, category) => {
    expect(failureCategoryOf(code)).toBe(category);
  });

  it.each(CATEGORIES)("%s の文言は正規化コードを添え、URL・ホスト名を含まない", (code) => {
    const text = failureTextFor(code);
    expect(text).toContain(`(${code}`);
    expect(findUrlLikeSpans(text)).toEqual([]);
    expect(text).not.toMatch(/https?:|localhost|127\.0\.0\.1|Bearer/i);
  });

  it("一時的な障害だけが「時間をおいて再度お試しください」を案内する", () => {
    for (const [code, category] of CATEGORIES) {
      const text = failureTextFor(code);
      if (category === "transient") {
        expect(text, code).toContain(RETRY_LATER);
      } else {
        expect(text, code).not.toContain(RETRY_LATER);
      }
    }
  });

  it("分類ごとに次の行動を示す", () => {
    // 設定・接続先の誤り: 接続先・設定の確認(利用者は管理者へ)
    expect(failureTextFor("gateway_protocol_error")).toContain("MCP エンドポイント");
    expect(failureTextFor("gateway_protocol_error")).toContain("管理者に連絡してください");
    expect(failureTextFor("llm_invalid_request")).toContain("モデル名");
    // 資格情報: 利用者本人のセッションはサインインし直す、LLM の資格情報は設定の確認
    expect(failureTextFor("gateway_unauthenticated")).toContain("サインインし直して");
    expect(failureTextFor("gateway_forbidden")).toContain("サインインし直して");
    expect(failureTextFor("gateway_forbidden")).toContain("403");
    expect(failureTextFor("llm_authentication_failed")).toContain("資格情報");
    // 内容: 質問を変える・絞る
    expect(failureTextFor("llm_refusal")).toContain("質問の表現を変えて");
    expect(failureTextFor("llm_context_window_exceeded")).toContain("質問の範囲を絞って");
    // 不明: runId を添えて管理者へ
    expect(failureTextFor("llm_client_error")).toContain("runId を添えて管理者に連絡");
  });

  it("規約外の分類(外部由来の文字列)は埋め込まず internal_error として扱う", () => {
    const text = failureTextFor("Evil https://attacker.example/x");
    expect(text).toContain("(internal_error)");
    expect(text).not.toContain("attacker");
  });

  it("既存の固定文言(gateway_unauthenticated)は変えず、user_mismatch には次の行動を足す", () => {
    expect(failureTextFor("gateway_unauthenticated")).toBe(
      "Gateway が利用者の認証を拒否したため、回答していません(gateway_unauthenticated)。サインインし直してから再度お試しください。",
    );
    expect(failureTextFor("user_mismatch")).toBe(
      "利用者を確認できなかったため、回答していません(user_mismatch)。サインインしている利用者を確認してから再度お試しください。続く場合は管理者に連絡してください。",
    );
  });
});

/** AnswerRun を書くだけの Orchestrator(LLM は脚本)。 */
function orchestrator(llm: ScriptedLlmClient): { orchestrator: Orchestrator; store: InMemoryAuditStore } {
  const store = new InMemoryAuditStore();
  return {
    store,
    orchestrator: new Orchestrator({
      llm,
    }),
  };
}

async function harness(): Promise<GatewayHarness> {
  const started = await startGateway({ connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])] });
  cleanups.push(() => started.close());
  return started;
}

async function statusServer(status: number): Promise<MockHttpServer> {
  const server = await startMockHttpServer(() => ({
    status,
    body: { jsonrpc: "2.0", id: null, error: { code: -32000, message: "dev-only upstream detail" } },
  }));
  cleanups.push(() => server.close());
  return server;
}

function client(url: string): GatewayClient {
  const gateway = new McpGatewayClient({ url, sessionToken: ALICE_TOKEN });
  cleanups.push(() => gateway.close());
  return gateway;
}

describe("run の失敗が分類ごとの文言になる", () => {
  /** run の開始(POST /runs)の失敗を分類で受ける(回答は返らない。ADR-019 決定3・6)。 */
  async function startFailure(gateway: GatewayClient): Promise<GatewayClientError> {
    const { orchestrator: o } = orchestrator(new ScriptedLlmClient([]));
    const error = await o.run({ question: "経費精算の締め日は?", gateway }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GatewayClientError);
    return error as GatewayClientError;
  }

  it("接続先が MCP エンドポイントでない(404)は設定・接続先の誤り(gateway_protocol_error)。run を始められないので回答は返らず、文言は分類で決まる", async () => {
    const started = await harness();
    // /runs は同じオリジンの固定パスなので、MCP のパスだけ誤っていると run API は通る。
    // 別オリジン(応答が MCP でないサーバー)で 404 を返す
    const notMcp = await statusServer(404);
    const error = await startFailure(client(`${notMcp.url}/mcp`));
    expect(error.errorClass).toBe("gateway_protocol_error");
    expect(failureTextFor(error.errorClass)).not.toContain(RETRY_LATER);
    expect(failureTextFor(error.errorClass)).not.toContain("127.0.0.1");
    expect(String(error)).not.toContain("127.0.0.1");
    expect(started.answerRuns()).toEqual([]);
  });

  it("403 は資格情報・設定(gateway_rejected)、503 は一時的な障害(gateway_unavailable)。上流の本文を載せない", async () => {
    const forbidden = await startFailure(client(`${(await statusServer(403)).url}/mcp`));
    // 本文に errorClass がない 403 は「Gateway が run の要求を拒否した」として受ける
    expect(forbidden.errorClass).toBe("gateway_rejected");
    expect(failureCategoryOf("gateway_forbidden")).toBe("credentials");
    expect(failureCategoryOf("gateway_rejected")).toBe("configuration");
    expect(forbidden.message).not.toContain("dev-only upstream detail");

    const unavailable = await startFailure(client(`${(await statusServer(503)).url}/mcp`));
    expect(unavailable.errorClass).toBe("gateway_unavailable");
    expect(failureCategoryOf("gateway_unavailable")).toBe("transient");
    expect(failureTextFor("gateway_unavailable")).toContain(RETRY_LATER);
    expect(unavailable.message).not.toContain("dev-only upstream detail");
  });

  it("Gateway に検索できるソースがなければ設定の誤り(no_searchable_sources)", async () => {
    const { orchestrator: o } = orchestrator(new ScriptedLlmClient([]));
    const answer = await o.run({
      question: "経費精算の締め日は?",
      gateway: new FakeGatewayClient([], () => {
        throw new Error("must not be called");
      }),
    });
    expect(answer.outcome).toBe("error");
    expect(answer.answer).toBe(failureTextFor("no_searchable_sources"));
  });

  it.each([
    ["llm_invalid_request", "configuration"],
    ["llm_permission_denied", "credentials"],
    ["llm_rate_limited", "transient"],
    ["llm_client_error", "unknown"],
  ] as const)("LLM の %s は %s の文言(AnswerRun の failureReason は分類コード)", async (code, category) => {
    const started = await harness();
    const llm = new ScriptedLlmClient([
      () => {
        throw new LlmError(code, "dev-only upstream detail");
      },
    ]);
    const o = new Orchestrator({
      llm,
    });

    const answer = await o.run({ question: "経費精算の締め日は?", gateway: started.client(ALICE_TOKEN) });

    expect(answer.outcome).toBe("error");
    expect(failureCategoryOf(code)).toBe(category);
    expect(answer.answer).toBe(failureTextFor(code));
    expect(answer.answer).not.toContain("dev-only upstream detail");
    expect(started.answerRuns().at(-1)).toMatchObject({ finalOutcome: "error", failureReason: code });
  });
});
