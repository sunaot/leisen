/**
 * `claude -p`(Claude Code の CLI の非対話モード)を子プロセスで呼ぶ LlmClient。
 * 比較実験(dev-search-eval)の条件 3・4 専用の、開発・評価用の実装(T-027)。
 *
 * - これはネイティブのツール呼び出しではない。1 回の complete() ごとに、system prompt
 *   (Orchestrator のもの + 応答の形式の説明)・ツール定義・会話履歴を 1 つのテキストにして
 *   `claude -p` に渡し、`--json-schema` の構造化出力で「ツール呼び出しの配列(名前と引数)」
 *   または「最終のテキスト」を受け取り、LlmTurn(Anthropic.Message の形)に戻す。ツール
 *   呼び出しの模擬なので、Anthropic API のバックエンド(AnthropicLlmClient)とは挙動が
 *   違いうる(strict のツール定義・思考・キャッシュ・max_tokens は効かず、CLI 自身の
 *   内部の指示と構造化出力の仕組みが間に入る)
 * - Claude Code 自身のツール(Bash・Read・Web 検索など)と MCP は使わせない(`--tools ""`、
 *   `--strict-mcp-config` と空の `--mcp-config`)。設定ファイル・スラッシュコマンドも読ませない。
 *   system prompt は `--system-prompt-file` で置き換える。作業ディレクトリはリポジトリの外の
 *   空の一時ディレクトリにし、CLAUDE.md を読み込ませない
 * - 本番の経路に入れない: LLM バックエンドの選択肢(config.ts / llm/factory.ts、ADR-017)には
 *   足さず、dev-search-eval の中だけで選べる。NODE_ENV=production では構築を拒否する
 * - 費用(CLI の `total_cost_usd`)と所要時間(子プロセスの実時間)を呼び出しごとに記録し、
 *   合計を usageTotals() で返す
 */
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { LlmError, type LlmErrorClass } from "../errors.js";
import type {
  LlmAttemptUsage,
  LlmCallOptions,
  LlmCapabilities,
  LlmClient,
  LlmRequest,
  LlmTurn,
} from "../llm/types.js";

/** 子プロセスの起動の指定(差し替え可能な実行器に渡す)。 */
export interface ClaudeCliInvocation {
  readonly command: string;
  readonly args: readonly string[];
  /** 標準入力に書く内容(プロンプト本体) */
  readonly stdin: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface ClaudeCliProcessResult {
  /** 終了コード(シグナルで終わった・起動できなかったときは null) */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  /** 起動できなかった(ENOENT など)。値はエラーコードのみ */
  readonly spawnError?: string;
}

export type ClaudeCliRunner = (invocation: ClaudeCliInvocation) => Promise<ClaudeCliProcessResult>;

/** 実際に子プロセスを起動する実行器。タイムアウト・中断では SIGTERM(5 秒後に SIGKILL)を送る。 */
export const spawnClaudeCli: ClaudeCliRunner = (invocation) =>
  new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(invocation.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: invocation.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let killTimer: NodeJS.Timeout | undefined;
    const kill = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, invocation.timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    invocation.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (result: ClaudeCliProcessResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      invocation.signal?.removeEventListener("abort", onAbort);
      resolvePromise(result);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ exitCode: null, stdout, stderr, timedOut, aborted, spawnError: error.code ?? "spawn_failed" });
    });
    child.on("close", (code) => {
      finish({ exitCode: code, stdout, stderr, timedOut, aborted });
    });
    child.stdin.on("error", () => {
      // 子プロセスが先に終わった(close で扱う)
    });
    child.stdin.end(invocation.stdin, "utf8");
    if (invocation.signal?.aborted === true) {
      onAbort();
    }
  });

/** 1 回の呼び出しの記録(集計用。プロンプト・応答の本文は持たない)。 */
export interface ClaudeCliCallRecord {
  readonly ok: boolean;
  readonly errorClass?: LlmErrorClass;
  /** CLI の total_cost_usd(読めなければ undefined) */
  readonly costUsd: number | undefined;
  /** 子プロセスの実時間(ms) */
  readonly durationMs: number;
  /** 応答の modelUsage に出たモデル */
  readonly model?: string;
}

export interface ClaudeCliUsageTotals {
  readonly calls: number;
  readonly failedCalls: number;
  /** total_cost_usd の合計(読めた呼び出しの分) */
  readonly costUsd: number;
  /** total_cost_usd を読めなかった呼び出しの数 */
  readonly costUnknownCalls: number;
  /** 子プロセスの実時間の合計(ms) */
  readonly durationMs: number;
  /** 失敗の分類 → 回数 */
  readonly failures: Readonly<Record<string, number>>;
}

export interface ClaudeCliLlmClientOptions {
  /** `--model` に渡す値(必須。既定値は置かない) */
  readonly model: string;
  /** CLI のコマンド(既定 `claude`) */
  readonly command?: string;
  /** 1 回の呼び出しのタイムアウト(ms、既定 300 秒) */
  readonly timeoutMs?: number;
  /** 費用の合計の上限(USD)。合計がこれ以上になったら以後の呼び出しを行わずに失敗させる */
  readonly maxTotalCostUsd?: number;
  /** 子プロセスに渡す環境変数の元(既定 process.env)。NODE_ENV の判定にも使う */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 子プロセスの実行器(テストで差し替える) */
  readonly runner?: ClaudeCliRunner;
  /** 作業ディレクトリを作る親(既定 os.tmpdir())。リポジトリの中は拒否する */
  readonly tempRoot?: string;
  readonly now?: () => number;
}

/** 構造化出力によるツール呼び出しの模擬の能力。 */
export const CLAUDE_CLI_CAPABILITIES: LlmCapabilities = Object.freeze({
  strictTools: false,
  thinking: "none",
  effort: false,
  parallelToolCalls: true,
  promptCaching: false,
});

const DEFAULT_TIMEOUT_MS = 300_000;

/** リポジトリのルート(このファイルから 4 階層上。src / dist のどちらからでも同じ) */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * 子プロセスに渡さない環境変数(親の Claude Code のセッションが追加のディレクトリの CLAUDE.md を
 * 読ませる指定)。
 */
const STRIPPED_ENV = ["CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD", "CLAUDE_ADDITIONAL_DIRECTORIES"];

/** 応答の形式の説明(Orchestrator の system prompt の後ろに足す)。 */
export const CLAUDE_CLI_RESPONSE_PROTOCOL = [
  "# 応答の形式(この実行環境の決まり)",
  "",
  "この実行環境では、ツールを直接呼び出す仕組みがない。ツールの定義は入力の <tools> に、ここまでの会話は <conversation> にある。",
  "会話の続きとして、次の assistant の応答を 1 つだけ決め、指定の JSON の形で返す。",
  '- ツールを呼ぶとき: {"kind":"tool_calls","tool_calls":[{"name":"<ツール名>","arguments":{...}}, ...]}。同じ応答で複数のツールを呼んでよい(配列に並べる)。arguments はそのツールの input_schema に従うオブジェクト。必要なら "text" に短い説明を書いてよい',
  '- ツールを呼ばずに終えるとき: {"kind":"final","text":"<本文>"}',
  "- ツールの結果は、次の入力の <conversation> の中に tool_result として届く。結果を推測して書かない",
].join("\n");

/** 構造化出力の JSON スキーマ(ツール名は列挙で縛り、引数はオブジェクトとだけ指定する)。 */
export function claudeCliOutputSchema(toolNames: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["tool_calls", "final"] },
      text: { type: "string" },
      tool_calls: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: toolNames.length > 0 ? { type: "string", enum: [...toolNames] } : { type: "string" },
            arguments: { type: "object" },
          },
          required: ["name", "arguments"],
        },
      },
    },
    required: ["kind"],
  };
}

/** 区切りのタグを本文が閉じてしまわないようにする(本文の他の部分は変えない)。 */
function neutralize(text: string): string {
  return text.replace(/<\/(turn|text|tool_result|tool_call|conversation|tools)>/giu, "<\\/$1>");
}

function attr(value: string): string {
  return value.replace(/[&"<>]/gu, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
}

function toolResultBody(block: Anthropic.ToolResultBlockParam): string {
  const content = block.content;
  if (content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => (part.type === "text" ? part.text : `[${part.type} は省略]`))
    .join("\n");
}

/** system prompt(Orchestrator のもの + 応答の形式の説明)。 */
export function renderClaudeCliSystemPrompt(request: LlmRequest): string {
  return [...request.system.map((block) => block.text), CLAUDE_CLI_RESPONSE_PROTOCOL].join("\n\n");
}

/** 標準入力に渡すプロンプト(ツール定義と会話履歴)。 */
export function renderClaudeCliPrompt(request: LlmRequest): string {
  const lines: string[] = [];
  const tools = request.tools.map((tool) => ({
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    input_schema: tool.input_schema,
  }));
  lines.push("<tools>");
  lines.push(neutralize(JSON.stringify(tools, null, 2)));
  lines.push("</tools>");
  lines.push("");
  lines.push("<conversation>");
  for (const message of request.messages) {
    lines.push(`<turn role="${message.role}">`);
    const blocks: readonly Anthropic.ContentBlockParam[] =
      typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    for (const block of blocks) {
      switch (block.type) {
        case "text":
          lines.push("<text>", neutralize(block.text), "</text>");
          break;
        case "tool_use":
          lines.push(
            `<tool_call id="${attr(block.id)}" name="${attr(block.name)}">`,
            neutralize(JSON.stringify(block.input ?? {})),
            "</tool_call>",
          );
          break;
        case "tool_result":
          lines.push(
            `<tool_result tool_use_id="${attr(block.tool_use_id)}" is_error="${block.is_error === true ? "true" : "false"}">`,
            neutralize(toolResultBody(block)),
            "</tool_result>",
          );
          break;
        default:
          // 思考・画像などはこの模擬では送らない
          lines.push(`<text>[${block.type} は省略]</text>`);
          break;
      }
    }
    lines.push("</turn>");
  }
  lines.push("</conversation>");
  lines.push("");
  lines.push("次の assistant の応答を、指定の JSON の形で 1 つだけ返してください。");
  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** CLI の結果の JSON(`--output-format json`)から使う部分。 */
interface CliResultJson {
  readonly isError: boolean;
  readonly subtype: string | undefined;
  readonly apiErrorStatus: number | undefined;
  readonly costUsd: number | undefined;
  readonly structuredOutput: unknown;
  readonly attempts: LlmAttemptUsage[] | undefined;
  readonly model: string | undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseCliResult(stdout: string): CliResultJson | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const modelUsage = isRecord(parsed["modelUsage"]) ? parsed["modelUsage"] : undefined;
  let attempts: LlmAttemptUsage[] | undefined;
  if (modelUsage !== undefined && Object.keys(modelUsage).length > 0) {
    attempts = Object.entries(modelUsage).flatMap(([model, usage]) =>
      isRecord(usage)
        ? [
            {
              model,
              inputTokens: num(usage["inputTokens"]),
              outputTokens: num(usage["outputTokens"]),
              cacheCreationInputTokens: num(usage["cacheCreationInputTokens"]),
              cacheReadInputTokens: num(usage["cacheReadInputTokens"]),
            },
          ]
        : [],
    );
  }
  const status = parsed["api_error_status"];
  const cost = parsed["total_cost_usd"];
  return {
    isError: parsed["is_error"] === true,
    subtype: typeof parsed["subtype"] === "string" ? parsed["subtype"] : undefined,
    apiErrorStatus: typeof status === "number" ? status : undefined,
    costUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : undefined,
    structuredOutput: parsed["structured_output"],
    attempts,
    model: attempts?.[0]?.model,
  };
}

function classOfStatus(status: number | undefined): LlmErrorClass {
  if (status === 401) return "llm_authentication_failed";
  if (status === 403) return "llm_permission_denied";
  if (status === 429) return "llm_rate_limited";
  if (status === 529) return "llm_overloaded";
  if (status === 400 || status === 404 || status === 422) return "llm_invalid_request";
  return "llm_unavailable";
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_cli_${Date.now().toString(36)}_${String(idCounter).padStart(4, "0")}`;
}

/**
 * 構造化出力を LlmTurn に戻す。形が想定外なら LlmError("llm_unexpected_response")。
 * 引数がオブジェクトでないツール呼び出しは input を null にし、invalidToolUseIds に入れる
 * (Orchestrator が不正な入力として扱う)。
 */
export function turnFromStructuredOutput(
  output: unknown,
  meta: { readonly model: string; readonly attempts?: readonly LlmAttemptUsage[] },
): LlmTurn {
  if (!isRecord(output)) {
    throw new LlmError("llm_unexpected_response", "claude -p returned no structured output");
  }
  const text = typeof output["text"] === "string" ? output["text"].trim() : "";
  const rawCalls = Array.isArray(output["tool_calls"]) ? output["tool_calls"] : [];
  const content: Anthropic.ContentBlock[] = [];
  const invalid: string[] = [];
  let stopReason: Anthropic.StopReason;
  if (output["kind"] === "tool_calls" && rawCalls.length > 0) {
    if (text !== "") {
      content.push({ type: "text", text, citations: null });
    }
    for (const call of rawCalls) {
      if (!isRecord(call) || typeof call["name"] !== "string" || call["name"] === "") {
        throw new LlmError("llm_unexpected_response", "claude -p returned a tool call without a name");
      }
      const id = nextId("toolu");
      const args = call["arguments"];
      if (!isRecord(args)) {
        invalid.push(id);
      }
      content.push({
        type: "tool_use",
        id,
        name: call["name"],
        input: isRecord(args) ? args : null,
        caller: { type: "direct" },
      });
    }
    stopReason = "tool_use";
  } else if ((output["kind"] === "final" || output["kind"] === "tool_calls") && text !== "") {
    content.push({ type: "text", text, citations: null });
    stopReason = "end_turn";
  } else {
    throw new LlmError("llm_unexpected_response", "claude -p returned neither tool calls nor text");
  }
  const first = meta.attempts?.[0];
  const sum = (pick: (a: LlmAttemptUsage) => number) =>
    (meta.attempts ?? []).reduce((total, a) => total + pick(a), 0);
  return {
    message: {
      id: nextId("msg"),
      type: "message",
      role: "assistant",
      model: first?.model ?? meta.model,
      content,
      container: null,
      stop_reason: stopReason,
      stop_sequence: null,
      stop_details: null,
      usage: {
        input_tokens: sum((a) => a.inputTokens),
        output_tokens: sum((a) => a.outputTokens),
        cache_creation_input_tokens: sum((a) => a.cacheCreationInputTokens),
        cache_read_input_tokens: sum((a) => a.cacheReadInputTokens),
        cache_creation: null,
        inference_geo: null,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: null,
      },
    },
    attempts:
      meta.attempts !== undefined && meta.attempts.length > 0
        ? meta.attempts
        : [
            {
              model: meta.model,
              inputTokens: 0,
              outputTokens: 0,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
              usageMissing: true,
            },
          ],
    ...(invalid.length > 0 ? { invalidToolUseIds: invalid } : {}),
  };
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export class ClaudeCliLlmClient implements LlmClient {
  /** 価格表は CLI の total_cost_usd で数えるので参照用(Anthropic のモデルを呼ぶ) */
  readonly provider = "anthropic" as const;
  readonly capabilities = CLAUDE_CLI_CAPABILITIES;
  readonly model: string;
  /** 呼び出しごとの記録 */
  readonly records: ClaudeCliCallRecord[] = [];
  readonly workDir: string;
  readonly #command: string;
  readonly #timeoutMs: number;
  readonly #maxTotalCostUsd: number | undefined;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #runner: ClaudeCliRunner;
  readonly #now: () => number;
  #fileCounter = 0;

  constructor(options: ClaudeCliLlmClientOptions) {
    const env = options.env ?? process.env;
    if (env["NODE_ENV"] === "production") {
      throw new Error("ClaudeCliLlmClient is for development and evaluation only (NODE_ENV=production)");
    }
    if (options.model.trim() === "") {
      throw new Error("ClaudeCliLlmClient needs a model");
    }
    if (options.timeoutMs !== undefined && !(options.timeoutMs > 0)) {
      throw new Error("ClaudeCliLlmClient timeoutMs must be positive");
    }
    this.model = options.model;
    this.#command = options.command ?? "claude";
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxTotalCostUsd = options.maxTotalCostUsd;
    this.#runner = options.runner ?? spawnClaudeCli;
    this.#now = options.now ?? Date.now;
    const childEnv: Record<string, string | undefined> = { ...env };
    for (const key of STRIPPED_ENV) {
      delete childEnv[key];
    }
    this.#env = childEnv;
    const root = realpathSync(options.tempRoot ?? tmpdir());
    this.workDir = mkdtempSync(join(root, "leisen-claude-cli-"));
    if (isInside(this.workDir, realpathSync(REPO_ROOT))) {
      rmSync(this.workDir, { recursive: true, force: true });
      throw new Error("ClaudeCliLlmClient work directory must be outside the repository");
    }
  }

  /** 作業ディレクトリを消す。 */
  close(): void {
    rmSync(this.workDir, { recursive: true, force: true });
  }

  usageTotals(): ClaudeCliUsageTotals {
    const failures: Record<string, number> = {};
    for (const record of this.records) {
      if (!record.ok) {
        const key = record.errorClass ?? "unknown";
        failures[key] = (failures[key] ?? 0) + 1;
      }
    }
    return {
      calls: this.records.length,
      failedCalls: this.records.filter((r) => !r.ok).length,
      costUsd: this.records.reduce((total, r) => total + (r.costUsd ?? 0), 0),
      costUnknownCalls: this.records.filter((r) => r.costUsd === undefined).length,
      durationMs: this.records.reduce((total, r) => total + r.durationMs, 0),
      failures,
    };
  }

  /** `claude -p` の引数(テストで確かめる)。 */
  buildArgs(systemPromptFile: string, toolNames: readonly string[]): string[] {
    return [
      "-p",
      "--output-format",
      "json",
      "--model",
      this.model,
      "--system-prompt-file",
      systemPromptFile,
      "--json-schema",
      JSON.stringify(claudeCliOutputSchema(toolNames)),
      // Claude Code 自身のツールを無効にする
      "--tools",
      "",
      // MCP サーバーを読ませない(空の設定だけを使う)
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      // 設定ファイル(user / project / local)・スラッシュコマンドを読ませない
      "--setting-sources",
      "",
      "--disable-slash-commands",
      "--no-session-persistence",
    ];
  }

  async complete(request: LlmRequest, options: LlmCallOptions = {}): Promise<LlmTurn> {
    if (options.signal?.aborted === true) {
      throw new LlmError("llm_aborted", "claude -p call aborted");
    }
    if (this.#maxTotalCostUsd !== undefined && this.usageTotals().costUsd >= this.#maxTotalCostUsd) {
      throw new LlmError("llm_client_error", "claude -p total cost limit reached");
    }
    this.#fileCounter += 1;
    const systemFile = join(this.workDir, `system-${String(this.#fileCounter)}.md`);
    writeFileSync(systemFile, renderClaudeCliSystemPrompt(request), "utf8");
    const started = this.#now();
    let result: ClaudeCliProcessResult;
    try {
      result = await this.#runner({
        command: this.#command,
        args: this.buildArgs(systemFile, request.tools.map((tool) => tool.name)),
        stdin: renderClaudeCliPrompt(request),
        cwd: this.workDir,
        env: this.#env,
        timeoutMs: this.#timeoutMs,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } finally {
      rmSync(systemFile, { force: true });
    }
    const durationMs = this.#now() - started;
    const parsed = parseCliResult(result.stdout);
    const fail = (errorClass: LlmErrorClass, message: string): never => {
      this.records.push({ ok: false, errorClass, costUsd: parsed?.costUsd, durationMs });
      throw new LlmError(errorClass, message);
    };
    if (result.spawnError !== undefined) {
      fail("llm_unavailable", `claude CLI could not be started (${result.spawnError})`);
    }
    if (result.aborted) {
      fail("llm_aborted", "claude -p call aborted");
    }
    if (result.timedOut) {
      fail("llm_timeout", "claude -p call timed out");
    }
    if (result.exitCode !== 0) {
      fail(
        parsed?.isError === true ? classOfStatus(parsed.apiErrorStatus) : "llm_unavailable",
        `claude -p exited with code ${String(result.exitCode)}`,
      );
    }
    if (parsed === undefined) {
      return fail("llm_unexpected_response", "claude -p output is not JSON");
    }
    if (parsed.isError || parsed.subtype !== "success") {
      fail(
        parsed.apiErrorStatus !== undefined ? classOfStatus(parsed.apiErrorStatus) : "llm_unexpected_response",
        `claude -p reported an error (${parsed.subtype ?? "unknown"})`,
      );
    }
    let turn: LlmTurn;
    try {
      turn = turnFromStructuredOutput(parsed.structuredOutput, {
        model: parsed.model ?? this.model,
        ...(parsed.attempts !== undefined ? { attempts: parsed.attempts } : {}),
      });
    } catch (error) {
      return fail(
        error instanceof LlmError ? error.errorClass : "llm_unexpected_response",
        "claude -p structured output could not be read",
      );
    }
    this.records.push({
      ok: true,
      costUsd: parsed.costUsd,
      durationMs,
      ...(parsed.model !== undefined ? { model: parsed.model } : {}),
    });
    return turn;
  }
}
