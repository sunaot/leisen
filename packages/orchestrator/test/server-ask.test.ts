/**
 * T-021 受け入れ条件2: 有効な Bearer の ask が実 Gateway 経由で回答する(実 Gateway + 脚本 LLM の e2e)。
 *
 * - AnswerRun.userId は Gateway が認証した userId(alice / bob。呼び出し元の申告ではない)
 * - AnswerRun は --answer-run-jsonl の JSONL に pending → 最終状態の順で追記される
 * - text は Markdown(本文 + 「## 出典」+ runId)。出典の url は http / https だけを描画する
 * - structuredContent は Answer + retentionClass(+ resolved 以外は errorClass)で、ツールの
 *   outputSchema に適合する(SDK の Client の検証と、Ajv での明示の検証)
 * - outcome: error は isError、例外(監査の書き込み失敗など)は固定文言の isError
 * - initialize の instructions に出典の扱いを書いている
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { afterEach, describe, expect, it } from "vitest";
import {
  ERROR_NOTICE,
  LlmError,
  NO_CITATION_NOTICE,
  ScriptedLlmClient,
  scriptedSubmit,
  scriptedToolUse,
  type ScriptStep,
} from "../src/index.js";
import {
  ALICE_TOKEN,
  BOB_TOKEN,
  CorpusConnector,
  EXPENSE_POLICY,
  startGateway,
  type CorpusDocument,
  type GatewayHarness,
} from "./helpers/harness.js";
import {
  searchThenSubmit,
  startOrchestratorServer,
  type OrchestratorServerHarness,
  type OrchestratorServerOptions,
} from "./helpers/orchestrator-server.js";
import { searchHits } from "./helpers/script.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

interface Setup {
  readonly gateway: GatewayHarness;
  readonly server: OrchestratorServerHarness;
  readonly llm: ScriptedLlmClient;
  readonly alpha: CorpusConnector;
}

async function setup(
  options: {
    readonly script?: ScriptStep | readonly ScriptStep[];
    readonly documents?: readonly CorpusDocument[];
    readonly server?: Partial<OrchestratorServerOptions>;
  } = {},
): Promise<Setup> {
  const alpha = new CorpusConnector("alpha", options.documents ?? [EXPENSE_POLICY]);
  const gateway = await startGateway({ connectors: [alpha] });
  cleanups.push(() => gateway.close());
  const llm = new ScriptedLlmClient(options.script ?? searchThenSubmit());
  const server = await startOrchestratorServer({
    gatewayUrl: gateway.url,
    llm,
    ...options.server,
  });
  cleanups.push(() => server.close());
  return { gateway, server, llm, alpha };
}

interface AskResult {
  readonly isError: boolean;
  readonly text: string;
  readonly structured: Record<string, unknown>;
}

/** tools/list で outputSchema の検証器を用意してから ask を呼ぶ(SDK の Client が検証する)。 */
async function ask(client: Client, question: string): Promise<AskResult> {
  await client.listTools();
  const result = await client.callTool({ name: "ask", arguments: { question } });
  const [first] = result.content as { type: string; text: string }[];
  return {
    isError: result.isError === true,
    text: first?.text ?? "",
    structured: result.structuredContent as Record<string, unknown>,
  };
}

/** ask の outputSchema で明示に検証する(SDK の Client と同じ Ajv)。 */
async function expectValidAgainstOutputSchema(
  client: Client,
  structured: Record<string, unknown>,
): Promise<void> {
  const { tools } = await client.listTools();
  const schema = tools.find((tool) => tool.name === "ask")?.outputSchema;
  expect(schema).toBeDefined();
  const validate = new AjvJsonSchemaValidator().getValidator(schema as never);
  expect(validate(structured)).toMatchObject({ valid: true });
}

function sourcesSection(text: string): string[] {
  const start = text.indexOf("## 出典");
  expect(start).toBeGreaterThanOrEqual(0);
  return text
    .slice(start)
    .split("\n")
    .slice(1)
    .filter((line) => line.startsWith("- ["));
}

describe("ask: 実 Gateway + 脚本 LLM の e2e", () => {
  it("回答・出典・runId を Markdown で返し、AnswerRun(userId = alice)を JSONL に pending → resolved で追記する", async () => {
    const { server, gateway, llm } = await setup();
    const client = await server.connect(ALICE_TOKEN);

    const { isError, text, structured } = await ask(client, "経費精算の締め日は?");

    expect(isError).toBe(false);
    const runId = structured["runId"] as string;
    expect(text).toBe(
      [
        "経費精算の締め日は毎月25日です。",
        "## 出典\n- [1] 経費精算規程(`alpha:doc-expense-policy`)— https://alpha.example.test/docs/doc-expense-policy",
        `runId: \`${runId}\``,
      ].join("\n\n"),
    );
    expect(structured).toMatchObject({
      runId,
      answer: "経費精算の締め日は毎月25日です。",
      outcome: "resolved",
      retentionClass: "persistable",
      searchedSources: ["alpha"],
      skippedSources: [],
      citations: [
        {
          sourceId: "alpha",
          documentId: "doc-expense-policy",
          title: "経費精算規程",
          url: "https://alpha.example.test/docs/doc-expense-policy",
        },
      ],
      usage: { llmTurns: 2, toolCalls: 2 },
    });
    expect(structured).not.toHaveProperty("errorClass");
    await expectValidAgainstOutputSchema(client, structured);
    expect(llm.requests).toHaveLength(2);
    // 利用者のトークンは結果(text・structuredContent)に載らない(不変条件6)
    expect(JSON.stringify({ text, structured })).not.toContain(ALICE_TOKEN);

    // AnswerRun: 同じ runId の pending → resolved(Gateway が認証した alice)
    const runs = (await server.answerRunLines()).filter((record) => record.runId === runId);
    expect(runs.map((record) => record.finalOutcome)).toEqual(["pending", "resolved"]);
    expect(runs.every((record) => record.userId === "alice")).toBe(true);
    expect(runs.at(-1)).toMatchObject({
      searchedSources: ["alpha"],
      citedDocIds: ["alpha:doc-expense-policy"],
      userFeedback: null,
    });
    // ToolInvocation は Gateway が同じ runId・同じ利用者で記録している
    const invocations = gateway.toolInvocations(runId);
    expect(invocations.map((record) => record.tool)).toEqual(["describe", "search"]);
    expect(invocations.every((record) => record.userId === "alice")).toBe(true);
    // JSONL にトークン・質問の原文・回答本文を書かない
    const jsonl = await readFile(server.jsonlPath, "utf8");
    expect(jsonl).not.toContain(ALICE_TOKEN);
    expect(jsonl).not.toContain("経費精算の締め日は?");
    expect(jsonl).not.toContain("毎月25日");
  });

  it("AnswerRun の userId は接続した利用者のトークンで決まる(bob のトークンなら bob)", async () => {
    const { server } = await setup();
    const client = await server.connect(BOB_TOKEN);
    const { structured } = await ask(client, "経費精算の締め日は?");
    const runs = (await server.answerRunLines()).filter(
      (record) => record.runId === structured["runId"],
    );
    expect(runs.map((record) => [record.finalOutcome, record.userId])).toEqual([
      ["pending", "bob"],
      ["resolved", "bob"],
    ]);
  });

  it("出典の url は http / https だけを描画し、title の制御文字・リンク・HTML を無害化する", async () => {
    const trap: CorpusDocument = {
      id: "doc-trap",
      title: "経費\u0007規程 [罠](https://evil.example/x) <img src=x onerror=alert(1)> *強調*",
      content: "経費精算の締め日は毎月25日です(別の文書)。",
      keywords: ["締め日"],
      url: "javascript:alert(1)",
    };
    const relative: CorpusDocument = {
      id: "doc-relative",
      title: "相対URLの文書",
      content: "経費精算の締め日は毎月25日です(相対)。",
      keywords: ["締め日"],
      url: "/docs/relative",
    };
    const { server } = await setup({
      documents: [EXPENSE_POLICY, trap, relative],
      script: (context) => {
        const hits = searchHits(context);
        if (hits.length === 0) {
          return scriptedToolUse([{ name: "search", input: { source: "alpha", query: "締め日" } }]);
        }
        return scriptedSubmit({
          answer: "経費精算の締め日は毎月25日です。",
          citations: hits.map((hit) => ({ documentId: hit.documentId, sourceId: hit.source })),
          confidence: 0.8,
        });
      },
    });
    const client = await server.connect(ALICE_TOKEN);

    const { text, structured } = await ask(client, "締め日は?");

    const lines = sourcesSection(text);
    expect(lines).toHaveLength(3);
    // url は http / https だけ(javascript: と相対 URL は url を省く)
    const urls = text.match(/[a-z][a-z0-9+.-]*:\/\/[^\s)]+|javascript:[^\s]*/gi) ?? [];
    expect(urls).toEqual(["https://alpha.example.test/docs/doc-expense-policy"]);
    expect(text).not.toContain("javascript:");
    expect(text).not.toContain("/docs/relative");
    const trapLine = lines.find((line) => line.includes("alpha:doc-trap")) ?? "";
    expect(trapLine).not.toContain("\u0007");
    expect(trapLine).not.toContain("evil.example");
    expect(trapLine).not.toContain("<img");
    expect(trapLine).not.toMatch(/\]\(/);
    expect(trapLine).toContain("\\*強調\\*");
    expect(trapLine.endsWith("(`alpha:doc-trap`)")).toBe(true);
    expect(lines.find((line) => line.includes("alpha:doc-relative"))).toBe(
      "- [3] 相対URLの文書(`alpha:doc-relative`)",
    );
    // structuredContent には Answer をそのまま載せる(url の判断は描画側の責務)
    expect(structured["citations"]).toContainEqual(
      expect.objectContaining({ documentId: "doc-trap", url: "javascript:alert(1)" }),
    );
    await expectValidAgainstOutputSchema(client, structured);
  });

  it("出典のない回答(unresolved)は注意書きを先頭に保ち、「出典: なし」と errorClass を返す", async () => {
    const { server } = await setup({
      script: [
        () =>
          scriptedSubmit({
            answer: "わかりませんでした。",
            citations: [],
            confidence: 0.2,
          }),
      ],
    });
    const client = await server.connect(ALICE_TOKEN);

    const { isError, text, structured } = await ask(client, "経費精算の締め日は?");

    expect(isError).toBe(false);
    expect(text.startsWith(NO_CITATION_NOTICE)).toBe(true);
    // 既知の注意書きがあるので重ねない
    expect(text.split("【注意】")).toHaveLength(2);
    expect(text).toContain("## 出典\n出典: なし");
    expect(structured).toMatchObject({
      outcome: "unresolved",
      errorClass: "no_citations",
      retentionClass: "persistable",
      citations: [],
    });
    await expectValidAgainstOutputSchema(client, structured);
  });

  it("outcome: error(LLM の失敗)は isError で返し、注意書きと errorClass を付ける", async () => {
    const { server } = await setup({
      script: [
        () => {
          throw new LlmError("llm_unavailable", "dev-only upstream detail");
        },
      ],
    });
    const client = await server.connect(ALICE_TOKEN);

    const { isError, text, structured } = await ask(client, "経費精算の締め日は?");

    expect(isError).toBe(true);
    expect(text.startsWith(`${ERROR_NOTICE}\n\n`)).toBe(true);
    expect(text).not.toContain("dev-only upstream detail");
    expect(structured).toMatchObject({ outcome: "error", errorClass: "llm_unavailable" });
    await expectValidAgainstOutputSchema(client, structured);
    const runs = (await server.answerRunLines()).filter(
      (record) => record.runId === structured["runId"],
    );
    expect(runs.at(-1)).toMatchObject({ finalOutcome: "error", failureReason: "llm_unavailable" });
  });

  it("AnswerRun を書けなければ(fail-closed)固定文言の isError で返し、LLM を呼ばない", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t021-missing-"));
    const { server, llm } = await setup({
      server: { answerRunJsonlPath: join(dir, "no-such-dir", "answer-runs.jsonl") },
    });
    const client = await server.connect(ALICE_TOKEN);

    const { isError, text, structured } = await ask(client, "経費精算の締め日は?");

    expect(isError).toBe(true);
    expect(structured).toEqual({ errorClass: "audit_write_failed" });
    expect(text).toContain("監査ログ");
    expect(text).not.toContain("no-such-dir");
    expect(text).not.toContain("ENOENT");
    expect(llm.requests).toHaveLength(0);
  });
});

describe("ask: ツール定義と instructions", () => {
  it("initialize の instructions に出典をそのまま提示する指示がある", async () => {
    const { server } = await setup();
    const client = await server.connect(ALICE_TOKEN);
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("改変");
    expect(instructions).toContain("そのまま利用者に提示");
    expect(instructions).toContain("「出典」節に載っている URL だけ");
    expect(instructions).toContain("注意書きを省かず");
    expect(instructions).toContain("明示したときだけ");
    expect(client.getServerVersion()).toMatchObject({ name: "kp-orchestrator" });
  });

  it("ツールは ask と feedback だけ。ask の質問長の上限は設定値、outputSchema はルートが object", async () => {
    const { server } = await setup({ server: { limits: { maxQuestionChars: 1234 } } });
    const client = await server.connect(ALICE_TOKEN);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["ask", "feedback"]);
    const askTool = tools.find((tool) => tool.name === "ask");
    expect(askTool?.inputSchema).toMatchObject({
      type: "object",
      properties: { question: { type: "string", maxLength: 1234 } },
      required: ["question"],
      additionalProperties: false,
    });
    for (const tool of tools) {
      expect(tool.outputSchema?.type).toBe("object");
      expect(tool.outputSchema).not.toHaveProperty("$schema");
    }
  });
});
