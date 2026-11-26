/**
 * 条件 4 の UI 側 LLM への入力の再現(search-eval/librechat-ui.ts、ui-question.ts の uiAskRequest /
 * reproduceUiAsk、runner.ts の --ui-prompt)のテスト。LLM はすべて脚本(ScriptedLlmClient)。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ASK_KEEP_TERMS_HEADING, ASK_USER_MESSAGE_HEADING } from "../src/ask-input.js";
import { Orchestrator, ScriptedLlmClient, scriptedSubmit, scriptedText, scriptedToolUse } from "../src/index.js";
import { SERVER_INSTRUCTIONS, orchestratorToolDefinitions } from "../src/server/tools.js";
import {
  LIBRECHAT_SOURCE,
  MemoryTraceSink,
  UI_PROMPT_STYLES,
  libreChatMcpInstructions,
  libreChatSystemPrompt,
  loadSearchEvalCorpus,
  reproduceUiAsk,
  runSearchEval,
  searchEvalQuestionSetSchema,
  startEvalGateway,
  uiAskRequest,
  uiQuestionRequest,
  type EvalGateway,
  type SearchEvalQuestionSet,
  type UiPromptStyle,
} from "../src/search-eval/index.js";
import { runDevSearchEval } from "../src/bin/dev-search-eval.js";

const QUESTIONS_PATH = fileURLToPath(new URL("../../../examples/eval/search-questions.json", import.meta.url));

/** LibreChat v0.8.7 の formatInstructionsForContext の出力(サーバー leisen、instructions は "true")。 */
const EXPECTED_REFERENCE_SYSTEM = [
  "# MCP Server Instructions",
  "",
  "The following MCP servers are available with their specific instructions:",
  "",
  "## leisen MCP Server Instructions",
  "",
  "true",
  "",
  "Please follow these instructions when using tools from the respective MCP servers.",
].join("\n");

describe("LibreChat の再現: UI 側 LLM への要求の形", () => {
  it("librechat: ツール名に _mcp_leisen を付け、説明・スキーマは MCP のまま、システムプロンプトは定型文(instructions は true)", () => {
    const request = uiAskRequest("経費精算っていつまで?", "librechat");
    const definitions = orchestratorToolDefinitions({ maxQuestionChars: 4_000 });
    expect(request.tools.map((t) => t.name)).toEqual(["ask_mcp_leisen", "feedback_mcp_leisen"]);
    expect(request.tools.map((t) => t.description)).toEqual(definitions.map((d) => d.description));
    expect(request.tools.map((t) => t.input_schema)).toEqual(definitions.map((d) => d.inputSchema));
    expect(request.system).toEqual([{ type: "text", text: EXPECTED_REFERENCE_SYSTEM }]);
    expect(request.system[0]?.text).not.toContain("ask ツールに渡してください");
    expect(request.messages).toEqual([{ role: "user", content: "経費精算っていつまで?" }]);
  });

  it("librechat-instructions: 定型文の instructions の位置に SERVER_INSTRUCTIONS が入る", () => {
    const text = uiAskRequest("発言", "librechat-instructions").system[0]?.text;
    expect(text).toBe(libreChatMcpInstructions("leisen", SERVER_INSTRUCTIONS));
    expect(text?.startsWith("# MCP Server Instructions\n\n")).toBe(true);
    expect(text).toContain(`## leisen MCP Server Instructions\n\n${SERVER_INSTRUCTIONS}\n\nPlease follow`);
  });

  it("基本の instructions(promptPrefix)があれば定型文の前に空行でつなぐ", () => {
    expect(libreChatSystemPrompt("librechat", "カスタム指示")).toBe(`カスタム指示\n\n${EXPECTED_REFERENCE_SYSTEM}`);
  });

  it("simple は従来の要求と同じ", () => {
    expect(uiAskRequest("発言", "simple")).toEqual(uiQuestionRequest("発言"));
    expect(uiAskRequest("発言")).toEqual(uiQuestionRequest("発言"));
  });

  it("調べた版を持つ", () => {
    expect(LIBRECHAT_SOURCE).toMatchObject({ tag: "v0.8.7", commit: "9e74cc0e57b395926122bd4062c1fcedc48ed465" });
    expect([...UI_PROMPT_STYLES]).toEqual(["simple", "librechat", "librechat-instructions"]);
  });
});

describe("LibreChat の再現: ask の引数の取り出し", () => {
  it("ask_mcp_leisen の引数をすべて返す", async () => {
    const args = { question: "経費精算の締め日", userMessage: "経費精算っていつまで?", keepTerms: ["経費精算"] };
    const llm = new ScriptedLlmClient([() => scriptedToolUse([{ name: "ask_mcp_leisen", input: args }])]);
    expect(await reproduceUiAsk(llm, "経費精算っていつまで?", { style: "librechat" })).toEqual({
      ok: true,
      toolName: "ask_mcp_leisen",
      arguments: args,
    });
    expect(llm.requests[0]?.tools.map((t) => t.name)).toEqual(["ask_mcp_leisen", "feedback_mcp_leisen"]);
  });

  it("名前の違うツール・テキストだけ・引数がオブジェクトでない・LLM の失敗はそれぞれの分類で返す", async () => {
    const cases: [ScriptedLlmClient, string][] = [
      [new ScriptedLlmClient([() => scriptedToolUse([{ name: "ask", input: { question: "q" } }])]), "ui_did_not_call_ask"],
      [new ScriptedLlmClient([() => scriptedText("こんにちは")]), "ui_did_not_call_ask"],
      [
        new ScriptedLlmClient([() => scriptedToolUse([{ name: "ask_mcp_leisen", input: null as unknown as Record<string, unknown> }])]),
        "ui_invalid_arguments",
      ],
      [new ScriptedLlmClient([]), "ui_llm_error"],
    ];
    for (const [llm, errorClass] of cases) {
      expect(await reproduceUiAsk(llm, "発言", { style: "librechat" })).toEqual({ ok: false, errorClass });
    }
  });
});

describe("LibreChat の再現: 探索 LLM への受け渡し(プロセス内の Gateway)", () => {
  let set: SearchEvalQuestionSet;
  let gateway: EvalGateway;
  beforeAll(async () => {
    set = searchEvalQuestionSetSchema.parse(JSON.parse(await readFile(QUESTIONS_PATH, "utf8")));
    gateway = await startEvalGateway({
      sourceId: set.source,
      documents: await loadSearchEvalCorpus(QUESTIONS_PATH, set),
      mode: "esa",
    });
  });
  afterAll(async () => {
    await gateway.close();
  });

  /** 探索 LLM: 検索せずに未解決で提出する(最初の user ターンを確かめるだけ) */
  function explore() {
    return new ScriptedLlmClient(() =>
      scriptedSubmit({ answer: "見つけられなかった。", citations: [], confidence: 0.1, unresolvedReason: "該当なし" }),
    );
  }

  async function runUi(style: UiPromptStyle, toolName: string, args: Record<string, unknown>) {
    const exploreLlm = explore();
    const sink = new MemoryTraceSink();
    const rows = await runSearchEval({
      mode: "esa",
      source: set.source,
      questions: set.questions.slice(0, 1),
      conditions: ["orchestrator-ui"],
      gateway: gateway.client,
      sink,
      orchestrator: new Orchestrator({ llm: exploreLlm }),
      uiLlm: new ScriptedLlmClient([() => scriptedToolUse([{ name: toolName, input: args }])]),
      uiPrompt: style,
    });
    const firstUserTurn = JSON.stringify(exploreLlm.requests[0]?.messages[0]?.content ?? "");
    return { rows, sink, exploreLlm, firstUserTurn };
  }

  const ARGS = {
    question: "経費精算の締め日はいつ?",
    userMessage: "経費精算っていつまで?",
    keepTerms: ["経費精算"],
    depth: "quick",
  };

  it("librechat: question 以外の引数も探索 LLM に渡り、トレースに UI 側 LLM が書いた引数が残る", async () => {
    const { rows, sink, firstUserTurn } = await runUi("librechat", "ask_mcp_leisen", ARGS);
    expect(firstUserTurn).toContain(ASK_USER_MESSAGE_HEADING);
    expect(firstUserTurn).toContain(ASK_KEEP_TERMS_HEADING);
    expect(firstUserTurn).toContain("経費精算の締め日はいつ?");
    expect(rows[0]?.errorClass).toBeUndefined();
    const ui = sink.events.find((e) => e.type === "ui_question");
    expect(ui).toMatchObject({
      uiPrompt: "librechat",
      toolName: "ask_mcp_leisen",
      question: "経費精算の締め日はいつ?",
      arguments: ARGS,
    });
    expect(sink.events.find((e) => e.type === "case_start")).toMatchObject({ input: "経費精算の締め日はいつ?" });
    expect(sink.events.some((e) => e.type === "answer")).toBe(true);
  });

  it("simple: 同じ引数でも探索 LLM には question だけを渡す(従来の挙動)が、引数はトレースに残す", async () => {
    const { firstUserTurn, sink } = await runUi("simple", "ask", ARGS);
    expect(firstUserTurn).toContain("経費精算の締め日はいつ?");
    expect(firstUserTurn).not.toContain(ASK_USER_MESSAGE_HEADING);
    expect(firstUserTurn).not.toContain(ASK_KEEP_TERMS_HEADING);
    expect(sink.events.find((e) => e.type === "ui_question")).toMatchObject({
      uiPrompt: "simple",
      toolName: "ask",
      arguments: ARGS,
    });
  });

  it("librechat: 引数が不正なら leisen-ask serve と同じ分類で拒否し、探索 LLM を呼ばない", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ question: "q", sources: ["no-such-source"] }, "ui_ask_rejected_unknown_source"],
      [{ question: "q", unknown: 1 }, "ui_ask_rejected_invalid_request"],
      [{ question: "q", period: { updatedAfter: "2026-02-01", updatedBefore: "2026-01-01" } }, "ui_ask_rejected_invalid_request"],
      [{ question: "  " }, "ui_ask_rejected_invalid_request"],
      [{ question: "x".repeat(4_001) }, "ui_ask_rejected_question_too_long"],
      [{ question: "q", keepTerms: Array.from({ length: 11 }, (_, i) => `t${String(i)}`) }, "ui_ask_rejected_arguments_too_long"],
      [{ userMessage: "q" }, "ui_ask_rejected_invalid_request"],
    ];
    for (const [args, errorClass] of cases) {
      const { rows, exploreLlm, sink } = await runUi("librechat", "ask_mcp_leisen", args);
      expect(rows[0]?.errorClass, errorClass).toBe(errorClass);
      expect(exploreLlm.requests).toHaveLength(0);
      const ui = sink.events.find((e) => e.type === "ui_question");
      expect(ui).toMatchObject({ uiPrompt: "librechat", arguments: args });
      expect(ui?.type === "ui_question" ? ui.rejectedErrorClass : undefined).toBe(errorClass.replace("ui_ask_rejected_", ""));
    }
  });

  it("librechat: sources に評価のソースを書けば受け付ける", async () => {
    const { rows, exploreLlm } = await runUi("librechat", "ask_mcp_leisen", { question: "q", sources: [set.source] });
    expect(rows[0]?.errorClass).toBeUndefined();
    expect(exploreLlm.requests).toHaveLength(1);
  });

  it("librechat: 評価の Gateway のクライアントを閉じない(続けて実行できる)", async () => {
    await runUi("librechat", "ask_mcp_leisen", { question: "q" });
    const { rows } = await runUi("librechat", "ask_mcp_leisen", { question: "q2" });
    expect(rows[0]?.errorClass).toBeUndefined();
  });
});

describe("dev-search-eval --ui-prompt", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "dev-search-eval-ui-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) } };
  }

  it("librechat を選ぶと UI 側 LLM に ask_mcp_leisen を渡し、表の注記とトレースに種類が出る", async () => {
    const created: ScriptedLlmClient[] = [];
    const deps = {
      env: {},
      createLlmClient: (config: { model?: string }) => {
        const llm =
          config.model === "ui"
            ? new ScriptedLlmClient(() => scriptedToolUse([{ name: "ask_mcp_leisen", input: { question: "締め日" } }]))
            : new ScriptedLlmClient(() =>
                scriptedSubmit({ answer: "なし", citations: [], confidence: 0.1, unresolvedReason: "該当なし" }),
              );
        created.push(llm);
        return llm;
      },
    };
    const trace = join(dir, "trace.jsonl");
    const ok = io();
    const code = await runDevSearchEval(
      [
        "--modes", "esa", "--conditions", "orchestrator-ui", "--only", "ki-expense-rules", "--ui-prompt", "librechat",
        "--ui-model", "ui", "--trace", trace,
        "--llm", "openai-compatible", "--llm-base-url", "http://127.0.0.1:9/v1", "--model", "m1",
      ],
      ok.io,
      deps,
    );
    expect(code).toBe(0);
    expect(ok.out.join("\n")).toContain("条件 4 の UI 側 LLM への入力: librechat");
    const ui = created[1];
    expect(ui?.requests[0]?.tools.map((t) => t.name)).toEqual(["ask_mcp_leisen", "feedback_mcp_leisen"]);
    const events = (await readFile(trace, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { type: string });
    expect(events.find((e) => e.type === "ui_question")).toMatchObject({ uiPrompt: "librechat", toolName: "ask_mcp_leisen" });
  });

  it("不正な値・条件 4 を含まない指定は 2", async () => {
    expect(await runDevSearchEval(["--conditions", "orchestrator-ui", "--ui-prompt", "chatgpt"], io().io)).toBe(2);
    expect(await runDevSearchEval(["--ui-prompt", "librechat"], io().io)).toBe(2);
  });
});
