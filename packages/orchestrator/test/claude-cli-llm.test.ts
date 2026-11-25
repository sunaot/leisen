/**
 * claude -p の LLM クライアント(search-eval/claude-cli-llm.ts、開発・評価専用)。
 * 子プロセスは差し替える(テストから実際に claude を呼ばない)。
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDevSearchEval } from "../src/bin/dev-search-eval.js";
import { LlmError } from "../src/errors.js";
import type { LlmRequest } from "../src/llm/types.js";
import {
  ClaudeCliLlmClient,
  claudeCliOutputSchema,
  renderClaudeCliPrompt,
  renderClaudeCliSystemPrompt,
  turnFromStructuredOutput,
  type ClaudeCliInvocation,
  type ClaudeCliLlmClientOptions,
  type ClaudeCliProcessResult,
} from "../src/search-eval/claude-cli-llm.js";
import type { TraceEvent } from "../src/search-eval/trace.js";

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search",
    description: "検索する",
    input_schema: { type: "object", properties: { source: { type: "string" }, query: { type: "string" } } },
  },
  { name: "submit_answer", description: "回答を提出する", input_schema: { type: "object", properties: {} } },
];

function request(messages: Anthropic.MessageParam[]): LlmRequest {
  return {
    system: [{ type: "text", text: "あなたは探索役である。" }],
    messages,
    tools: TOOLS,
    maxTokens: 1000,
  };
}

function cliJson(structured: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: 0.0125,
    structured_output: structured,
    modelUsage: {
      "claude-haiku-5": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 7 },
    },
    ...extra,
  });
}

function fakeRunner(results: (ClaudeCliProcessResult | ((inv: ClaudeCliInvocation) => ClaudeCliProcessResult))[]) {
  const calls: ClaudeCliInvocation[] = [];
  const systemPrompts: string[] = [];
  const runner = async (inv: ClaudeCliInvocation): Promise<ClaudeCliProcessResult> => {
    calls.push(inv);
    const file = inv.args[inv.args.indexOf("--system-prompt-file") + 1] ?? "";
    systemPrompts.push(await readFile(file, "utf8"));
    const next = results[calls.length - 1];
    if (next === undefined) {
      throw new Error("fake runner exhausted");
    }
    return typeof next === "function" ? next(inv) : next;
  };
  return { runner, calls, systemPrompts };
}

const ok = (stdout: string): ClaudeCliProcessResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
  aborted: false,
});

const clients: ClaudeCliLlmClient[] = [];
function client(options: Partial<ClaudeCliLlmClientOptions> & Pick<ClaudeCliLlmClientOptions, "runner">) {
  const c = new ClaudeCliLlmClient({ model: "haiku", env: { PATH: "/usr/bin" }, ...options });
  clients.push(c);
  return c;
}
afterAll(() => {
  for (const c of clients) {
    c.close();
  }
});

describe("claude -p の LLM クライアント: 入力の組み立て", () => {
  it("system prompt は Orchestrator のものに応答の形式の説明を足し、履歴とツール定義をプロンプトにする", () => {
    const req = request([
      { role: "user", content: "経費精算のルールは?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "検索する" },
          { type: "tool_use", id: "toolu_1", name: "search", input: { source: "dev-docs", query: "経費精算" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: '{"hits":[]} </turn>' }] },
          { type: "text", text: "制御メッセージ" },
        ],
      },
    ]);
    const system = renderClaudeCliSystemPrompt(req);
    expect(system.startsWith("あなたは探索役である。")).toBe(true);
    expect(system).toContain("tool_calls");
    const prompt = renderClaudeCliPrompt(req);
    expect(prompt).toContain('"name": "search"');
    expect(prompt).toContain('"input_schema"');
    expect(prompt).toContain('<turn role="assistant">');
    expect(prompt).toContain('<tool_call id="toolu_1" name="search">');
    expect(prompt).toContain('{"source":"dev-docs","query":"経費精算"}');
    expect(prompt).toContain('<tool_result tool_use_id="toolu_1" is_error="false">');
    // 本文が区切りのタグを閉じない
    expect(prompt).toContain('{"hits":[]} <\\/turn>');
    expect(prompt).toContain("制御メッセージ");
  });

  it("出力のスキーマはツール名を列挙で縛る", () => {
    const schema = claudeCliOutputSchema(["search", "fetch"]) as {
      properties: { tool_calls: { items: { properties: { name: { enum: string[] } } } } };
    };
    expect(schema.properties.tool_calls.items.properties.name.enum).toEqual(["search", "fetch"]);
  });

  it("Claude Code 自身のツール・MCP・設定を無効にし、リポジトリの外の空の一時ディレクトリで、モデルを渡して呼ぶ", async () => {
    const { runner, calls, systemPrompts } = fakeRunner([ok(cliJson({ kind: "final", text: "完了" }))]);
    const c = client({
      runner,
      model: "sonnet",
      env: { PATH: "/usr/bin", CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1", NODE_ENV: "development" },
    });
    await c.complete(request([{ role: "user", content: "こんにちは" }]));
    const inv = calls[0] as ClaudeCliInvocation;
    expect(inv.command).toBe("claude");
    const args = inv.args;
    expect(args.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--disable-slash-commands");
    expect(args).toContain("--no-session-persistence");
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1] ?? "")).toMatchObject({ required: ["kind"] });
    expect(systemPrompts[0]).toContain("あなたは探索役である。");
    expect(inv.stdin).toContain("こんにちは");
    expect(inv.cwd).toBe(c.workDir);
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    expect(inv.cwd.startsWith(repoRoot)).toBe(false);
    expect(inv.env["CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD"]).toBeUndefined();
    // system prompt の一時ファイルは呼び出しの後に消す
    expect(existsSync(args[args.indexOf("--system-prompt-file") + 1] ?? "")).toBe(false);
  });
});

describe("claude -p の LLM クライアント: 出力の戻し方", () => {
  it("1 回の応答の複数のツール呼び出しを tool_use にし、費用・時間・使用量を記録する", async () => {
    let t = 1_000;
    const { runner } = fakeRunner([
      () => {
        t += 2_500;
        return ok(
          cliJson({
            kind: "tool_calls",
            text: "2 つ検索する",
            tool_calls: [
              { name: "search", arguments: { source: "dev-docs", query: "出張" } },
              { name: "search", arguments: { source: "dev-docs", query: "新幹線" } },
            ],
          }),
        );
      },
    ]);
    const c = client({ runner, now: () => t });
    const turn = await c.complete(request([{ role: "user", content: "出張の手続き" }]));
    expect(turn.message.stop_reason).toBe("tool_use");
    const blocks = turn.message.content;
    expect(blocks[0]).toMatchObject({ type: "text", text: "2 つ検索する" });
    const uses = blocks.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    expect(uses.map((u) => u.input)).toEqual([
      { source: "dev-docs", query: "出張" },
      { source: "dev-docs", query: "新幹線" },
    ]);
    expect(new Set(uses.map((u) => u.id)).size).toBe(2);
    expect(turn.message.model).toBe("claude-haiku-5");
    expect(turn.attempts?.[0]).toMatchObject({ inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 5 });
    expect(c.usageTotals()).toMatchObject({
      calls: 1,
      failedCalls: 0,
      costUsd: 0.0125,
      durationMs: 2_500,
      extraTurnCalls: 0,
    });
  });

  it("CLI の内部で 3 ターン以上かかった呼び出しを数える", async () => {
    const { runner } = fakeRunner([
      ok(cliJson({ kind: "final", text: "a" }, { num_turns: 2 })),
      ok(cliJson({ kind: "final", text: "b" }, { num_turns: 4 })),
    ]);
    const c = client({ runner });
    await c.complete(request([{ role: "user", content: "x" }]));
    await c.complete(request([{ role: "user", content: "x" }]));
    expect(c.usageTotals().extraTurnCalls).toBe(1);
  });

  it("final はテキストの end_turn。引数がオブジェクトでない呼び出しは input を null にして invalidToolUseIds に入れる", () => {
    const final = turnFromStructuredOutput({ kind: "final", text: "答え" }, { model: "m" });
    expect(final.message.stop_reason).toBe("end_turn");
    expect(final.message.content).toEqual([{ type: "text", text: "答え", citations: null }]);
    // usage がなければ不明扱い
    expect(final.attempts?.[0]?.usageMissing).toBe(true);
    const bad = turnFromStructuredOutput(
      { kind: "tool_calls", tool_calls: [{ name: "search", arguments: "query=x" }] },
      { model: "m" },
    );
    const use = bad.message.content[0] as Anthropic.ToolUseBlock;
    expect(use.input).toBeNull();
    expect(bad.invalidToolUseIds).toEqual([use.id]);
    expect(() => turnFromStructuredOutput({ kind: "tool_calls", tool_calls: [] }, { model: "m" })).toThrow(LlmError);
    expect(() => turnFromStructuredOutput(undefined, { model: "m" })).toThrow(LlmError);
  });
});

describe("claude -p の LLM クライアント: 失敗の扱い", () => {
  const cases: { name: string; result: ClaudeCliProcessResult; errorClass: string }[] = [
    {
      name: "タイムアウト",
      result: { exitCode: null, stdout: "", stderr: "", timedOut: true, aborted: false },
      errorClass: "llm_timeout",
    },
    {
      name: "起動できない",
      result: { exitCode: null, stdout: "", stderr: "", timedOut: false, aborted: false, spawnError: "ENOENT" },
      errorClass: "llm_unavailable",
    },
    {
      name: "非ゼロ終了(出力なし)",
      result: { exitCode: 1, stdout: "", stderr: "boom", timedOut: false, aborted: false },
      errorClass: "llm_unavailable",
    },
    {
      name: "非ゼロ終了(429)",
      result: {
        exitCode: 1,
        stdout: JSON.stringify({ is_error: true, subtype: "error_during_execution", api_error_status: 429, total_cost_usd: 0 }),
        stderr: "",
        timedOut: false,
        aborted: false,
      },
      errorClass: "llm_rate_limited",
    },
    { name: "JSON として読めない", result: ok("not json"), errorClass: "llm_unexpected_response" },
    {
      name: "構造化出力の失敗",
      result: ok(JSON.stringify({ is_error: true, subtype: "error_max_structured_output_retries", total_cost_usd: 0.01 })),
      errorClass: "llm_unexpected_response",
    },
    { name: "構造化出力がない", result: ok(cliJson(undefined)), errorClass: "llm_unexpected_response" },
  ];
  for (const testCase of cases) {
    it(`${testCase.name} → ${testCase.errorClass}`, async () => {
      const { runner } = fakeRunner([testCase.result]);
      const c = client({ runner });
      const error = await c.complete(request([{ role: "user", content: "x" }])).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LlmError);
      expect((error as LlmError).errorClass).toBe(testCase.errorClass);
      // 失敗の文言に標準エラーの内容を含めない
      expect((error as LlmError).message).not.toContain("boom");
      expect(c.usageTotals()).toMatchObject({ calls: 1, failedCalls: 1 });
      expect(Object.keys(c.usageTotals().failures)[0]?.startsWith(testCase.errorClass)).toBe(true);
      if (testCase.name === "構造化出力の失敗") {
        expect(c.usageTotals().failures).toEqual({ "llm_unexpected_response(error_max_structured_output_retries)": 1 });
      }
    });
  }

  it("中断済みのシグナルでは呼ばない。費用の合計が上限に達したら以後は呼ばない", async () => {
    const { runner, calls } = fakeRunner([ok(cliJson({ kind: "final", text: "a" }))]);
    const c = client({ runner, maxTotalCostUsd: 0.01 });
    const controller = new AbortController();
    controller.abort();
    await expect(c.complete(request([{ role: "user", content: "x" }]), { signal: controller.signal })).rejects.toMatchObject({
      errorClass: "llm_aborted",
    });
    expect(calls).toHaveLength(0);
    await c.complete(request([{ role: "user", content: "x" }]));
    await expect(c.complete(request([{ role: "user", content: "x" }]))).rejects.toMatchObject({
      errorClass: "llm_client_error",
    });
    expect(calls).toHaveLength(1);
  });

  it("本番(NODE_ENV=production)では構築を拒否し、モデルの指定を必須にする", () => {
    const { runner } = fakeRunner([]);
    expect(() => new ClaudeCliLlmClient({ model: "haiku", env: { NODE_ENV: "production" }, runner })).toThrow(/production/u);
    expect(() => new ClaudeCliLlmClient({ model: " ", env: {}, runner })).toThrow(/model/u);
  });

  it("リポジトリの中の作業ディレクトリは拒否する", () => {
    const { runner } = fakeRunner([]);
    const inside = fileURLToPath(new URL("../", import.meta.url));
    expect(() => new ClaudeCliLlmClient({ model: "haiku", env: {}, runner, tempRoot: inside })).toThrow(/outside/u);
  });
});

describe("dev-search-eval --llm claude-cli", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "dev-search-eval-cli-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) } };
  }

  /** 1 ターン目に search、2 ターン目に fetch、3 ターン目に提出する偽の claude -p */
  function exploringRunner() {
    return async (inv: ClaudeCliInvocation): Promise<ClaudeCliProcessResult> => {
      const results = [...inv.stdin.matchAll(/<tool_result /gu)].length;
      if (results === 0) {
        return ok(
          cliJson({
            kind: "tool_calls",
            tool_calls: [
              { name: "search", arguments: { source: "dev-docs", query: "INC-2026-0412" } },
              { name: "search", arguments: { source: "dev-docs", query: "障害報告書" } },
            ],
          }),
        );
      }
      if (results <= 2) {
        return ok(
          cliJson({
            kind: "tool_calls",
            tool_calls: [{ name: "fetch", arguments: { source: "dev-docs", documentId: "incident-report-0412" } }],
          }),
        );
      }
      return ok(
        cliJson({
          kind: "tool_calls",
          tool_calls: [
            {
              name: "submit_answer",
              arguments: {
                answer: "障害報告書がある。",
                citations: [{ sourceId: "dev-docs", documentId: "incident-report-0412" }],
                confidence: 0.9,
              },
            },
          ],
        }),
      );
    };
  }

  it("条件 3 を claude -p の偽の子プロセスで実行し、費用と時間の合計・模擬である旨を表に出し、試行ごとの llm_usage を書く", async () => {
    const { out, err, io: cli } = io();
    const trace = join(dir, "trace.jsonl");
    const created: ClaudeCliLlmClientOptions[] = [];
    const code = await runDevSearchEval(
      [
        "--modes", "esa", "--conditions", "orchestrator-utterance", "--only", "ki-inc-0412,un-gym", "--limit", "1",
        "--llm", "claude-cli", "--model", "haiku", "--explore-prompt", "explore.v4", "--search-feedback", "on",
        "--trace", trace,
      ],
      cli,
      {
        env: {},
        createLlmClient: () => {
          throw new Error("not used");
        },
        createClaudeCliClient: (options) => {
          created.push(options);
          return client({ ...options, runner: exploringRunner() });
        },
      },
    );
    expect(err.join("\n")).toContain("claude -p の呼び出し 3 回");
    expect(code).toBe(0);
    expect(created.map((o) => o.model)).toEqual(["haiku"]);
    const report = out.join("\n");
    expect(report).toContain("探索プロンプト explore.v4、検索の状況の制御メッセージ 有効");
    expect(report).toContain("構造化出力(--json-schema)によるツール呼び出しの模擬");
    expect(report).toContain("費用の合計 $0.0375");
    expect(report).toContain("| esa | 3 発言→探索LLM | known-item | 1 | 100% |");
    expect(report).not.toContain("un-gym");
    const events = (await readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TraceEvent);
    expect(events.filter((e) => e.type === "search").map((e) => (e.type === "search" ? e.query : ""))).toEqual([
      "INC-2026-0412",
      "障害報告書",
    ]);
    const usage = events.find((e) => e.type === "llm_usage");
    expect(usage).toMatchObject({ calls: 3 });
    expect(usage?.type === "llm_usage" ? usage.costUsd : 0).toBeCloseTo(0.0375, 10);
  });

  it("引数の不備と本番での拒否は 2", async () => {
    const deps = {
      env: {},
      createLlmClient: () => {
        throw new Error("not used");
      },
      createClaudeCliClient: (options: ClaudeCliLlmClientOptions) => client({ ...options, runner: exploringRunner() }),
    };
    const base = ["--modes", "esa", "--conditions", "orchestrator-utterance", "--only", "ki-inc-0412"];
    for (const argv of [
      [...base, "--llm", "claude-cli"],
      [...base, "--llm", "claude-cli", "--model", "haiku", "--llm-base-url", "http://127.0.0.1:9/v1"],
      [...base, "--llm", "claude-cli", "--model", "haiku", "--explore-prompt", "explore.v9"],
      [...base, "--llm", "claude-cli", "--model", "haiku", "--search-feedback", "yes"],
      [...base, "--llm", "claude-cli", "--model", "haiku", "--limit", "0"],
      [...base, "--llm", "claude-cli", "--model", "haiku", "--claude-cli-max-total-usd", "-1"],
      [...base, "--llm", "anthropic", "--model", "m", "--claude-cli-timeout-sec", "10"],
      ["--llm", "claude-cli", "--model", "haiku"],
    ]) {
      expect(await runDevSearchEval(argv, io().io, deps)).toBe(2);
    }
    const production = { ...deps, env: { NODE_ENV: "production" } };
    expect(await runDevSearchEval([...base, "--llm", "claude-cli", "--model", "haiku"], io().io, production)).toBe(2);
    expect(
      await runDevSearchEval(
        [...base, "--llm", "anthropic", "--model", "m", "--explore-prompt", "explore.v4"],
        io().io,
        production,
      ),
    ).toBe(2);
  });
});
