#!/usr/bin/env node
/**
 * kp-ask — Orchestrator の CLI(T-007)。
 *
 *   kp-ask --gateway http://127.0.0.1:8787/mcp [--token <セッショントークン>]
 *          [--model <モデルID>] [--max-iterations N] [--effort low|medium|high|xhigh|max]
 *          [--user-id <userId>] [--json] "質問文"
 *
 * - セッショントークンは --token か環境変数 KP_SESSION_TOKEN で渡す(--token は
 *   プロセス一覧に残るため環境変数を推奨)。トークンは表示・ログに出さない
 * - Claude API の資格情報は SDK が環境から解決する(ANTHROPIC_API_KEY、
 *   ANTHROPIC_AUTH_TOKEN、`ant auth login` のプロファイル等)。無い・無効な場合は
 *   その旨を表示して終了コード 2
 * - AnswerRun の監査レコードは stderr に JSON 1行で出す(開発用。ToolInvocation は
 *   Gateway 側の監査に記録される)
 * - --user-id は AnswerRun に記録する質問者(既定: 環境変数 KP_USER_ID、なければ "cli-user")
 *
 * 終了コード: 0 回答した(resolved / unresolved)、1 実行時エラー、2 引数・資格情報の不備
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { AuditLogger } from "@kp/gateway";
import type { Answer } from "../answer.js";
import { StderrDebugAuditSink } from "../audit.js";
import {
  anthropicLlmSettingsSchema,
  effortSchema,
  orchestratorSettingsSchema,
  type AnthropicLlmSettingsInput,
  type OrchestratorSettings,
} from "../config.js";
import {
  GatewayClientError,
  LlmError,
  OrchestratorError,
  type LlmErrorClass,
} from "../errors.js";
import { McpGatewayClient } from "../gateway/mcp-client.js";
import type { GatewayClient } from "../gateway/types.js";
import { AnthropicLlmClient } from "../llm/anthropic.js";
import type { LlmCallOptions, LlmClient, LlmRequest, LlmTurn } from "../llm/types.js";
import { Orchestrator } from "../orchestrator.js";

export const USAGE = [
  "usage: kp-ask --gateway <MCPエンドポイントURL> [--token <セッショントークン>]",
  "              [--model <モデルID>] [--max-iterations <N>] [--effort low|medium|high|xhigh|max]",
  "              [--user-id <userId>] [--json] <質問文>",
  "  セッショントークンは環境変数 KP_SESSION_TOKEN でも渡せます(推奨)。",
  "  Claude API の資格情報は ANTHROPIC_API_KEY 等の環境から解決します。",
].join("\n");

export const CREDENTIALS_REQUIRED_MESSAGE =
  "Claude API の資格情報が必要です。ANTHROPIC_API_KEY を設定するか、`ant auth login` でプロファイルを作成してから再実行してください。";
export const CREDENTIALS_REJECTED_MESSAGE =
  "Claude API が資格情報を拒否しました(401)。ANTHROPIC_API_KEY などの資格情報を確認してください。";

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface CliDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  createLlmClient(settings: AnthropicLlmSettingsInput): LlmClient;
  createGatewayClient(options: { url: string; sessionToken: string }): GatewayClient;
}

export const defaultCliDependencies: CliDependencies = {
  env: process.env,
  createLlmClient: (settings) => new AnthropicLlmClient(settings),
  createGatewayClient: (options) => new McpGatewayClient(options),
};

class UsageError extends Error {}

interface CliArgs {
  readonly gateway: string;
  readonly token: string;
  readonly question: string;
  readonly userId: string;
  readonly json: boolean;
  readonly settings: OrchestratorSettings;
  readonly llm: AnthropicLlmSettingsInput;
}

function parseCliArgs(
  argv: readonly string[],
  env: CliDependencies["env"],
): CliArgs | "help" {
  let parsed: ReturnType<typeof parseArgsStrict>;
  try {
    parsed = parseArgsStrict(argv);
  } catch {
    // parseArgs のメッセージは引数の文字列を含みうる(トークンを誤入力した場合など)ためエコーしない
    throw new UsageError("引数を解釈できませんでした。");
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    return "help";
  }
  const gateway = values.gateway;
  if (gateway === undefined || gateway === "") {
    throw new UsageError("--gateway を指定してください。");
  }
  const token = values.token ?? env["KP_SESSION_TOKEN"];
  if (token === undefined || token === "") {
    throw new UsageError(
      "セッショントークンを --token または環境変数 KP_SESSION_TOKEN で指定してください。",
    );
  }
  const question = positionals.join(" ").trim();
  if (question === "") {
    throw new UsageError("質問文を指定してください。");
  }

  let maxIterations: number | undefined;
  if (values["max-iterations"] !== undefined) {
    maxIterations = Number(values["max-iterations"]);
  }
  const settings = orchestratorSettingsSchema.safeParse(
    maxIterations !== undefined ? { maxIterations } : {},
  );
  if (!settings.success) {
    throw new UsageError("--max-iterations は 1〜20 の整数で指定してください。");
  }

  const llm: AnthropicLlmSettingsInput = {};
  if (values.effort !== undefined) {
    const effort = effortSchema.safeParse(values.effort);
    if (!effort.success) {
      throw new UsageError("--effort は low / medium / high / xhigh / max のいずれかです。");
    }
    llm.effort = effort.data;
  }
  if (values.model !== undefined) {
    llm.model = values.model;
  }
  if (!anthropicLlmSettingsSchema.safeParse(llm).success) {
    throw new UsageError("--model の指定が不正です。");
  }

  return {
    gateway,
    token,
    question,
    userId: values["user-id"] ?? env["KP_USER_ID"] ?? "cli-user",
    json: values.json === true,
    settings: settings.data,
    llm,
  };
}

function parseArgsStrict(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    options: {
      gateway: { type: "string" },
      token: { type: "string" },
      model: { type: "string" },
      "max-iterations": { type: "string" },
      effort: { type: "string" },
      "user-id": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });
}

/** 最後に失敗した LLM 呼び出しの分類を覚える(資格情報の不備を判別するため)。 */
class ObservingLlmClient implements LlmClient {
  lastErrorClass: LlmErrorClass | undefined;

  constructor(private readonly inner: LlmClient) {}

  async complete(request: LlmRequest, options?: LlmCallOptions): Promise<LlmTurn> {
    try {
      return await this.inner.complete(request, options);
    } catch (error) {
      if (error instanceof LlmError) {
        this.lastErrorClass = error.errorClass;
      }
      throw error;
    }
  }
}

/** 人が読む形式の表示。 */
export function renderAnswer(answer: Answer): string {
  const lines = ["回答:", answer.answer, ""];
  lines.push("出典:");
  if (answer.citations.length === 0) {
    lines.push("  (なし)");
  } else {
    answer.citations.forEach((citation, index) => {
      const title = citation.title ?? citation.documentId;
      const url = citation.url !== undefined ? ` ${citation.url}` : "";
      lines.push(
        `  [${index + 1}] ${title} (${citation.sourceId}:${citation.documentId})${url}`,
      );
    });
  }
  lines.push(
    `検索したソース: ${answer.searchedSources.length > 0 ? answer.searchedSources.join(", ") : "(なし)"}`,
  );
  if (answer.skippedSources.length > 0) {
    lines.push(
      `未接続のため検索していないソース: ${answer.skippedSources
        .map((s) => `${s.sourceId}(${s.reason})`)
        .join(", ")}`,
    );
  }
  const cost =
    answer.usage.estimatedCost !== undefined
      ? `、概算費用 ${answer.usage.estimatedCost.toFixed(4)}`
      : "";
  lines.push(
    `結果: ${answer.outcome}  確信度: ${answer.confidence.toFixed(2)}`,
    `使用量: 入力 ${answer.usage.inputTokens} / 出力 ${answer.usage.outputTokens} トークン、LLM ${answer.usage.llmTurns} ターン、ツール呼び出し ${answer.usage.toolCalls} 回${cost}`,
  );
  if (answer.warnings.length > 0) {
    lines.push("警告:", ...answer.warnings.map((warning) => `  - ${warning}`));
  }
  lines.push(`runId: ${answer.runId}`);
  return lines.join("\n");
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
  deps: CliDependencies = defaultCliDependencies,
): Promise<number> {
  let args: CliArgs;
  try {
    const parsed = parseCliArgs(argv, deps.env);
    if (parsed === "help") {
      io.stdout(USAGE);
      return 0;
    }
    args = parsed;
  } catch (error) {
    io.stderr(error instanceof UsageError ? error.message : "引数を解釈できませんでした。");
    io.stderr(USAGE);
    return 2;
  }

  let gateway: GatewayClient;
  let llm: ObservingLlmClient;
  try {
    gateway = deps.createGatewayClient({ url: args.gateway, sessionToken: args.token });
    llm = new ObservingLlmClient(deps.createLlmClient(args.llm));
  } catch (error) {
    // GatewayClientError のメッセージは固定文言(トークン・URL の中身を含まない)
    io.stderr(
      error instanceof GatewayClientError
        ? `Gateway の指定が不正です: ${error.message}`
        : "クライアントを初期化できませんでした。",
    );
    return 2;
  }

  const orchestrator = new Orchestrator({
    llm,
    auditLogger: new AuditLogger(new StderrDebugAuditSink((line) => io.stderr(line))),
    settings: args.settings,
  });
  try {
    const answer = await orchestrator.run({
      question: args.question,
      userId: args.userId,
      gateway,
    });
    if (answer.outcome === "error" && llm.lastErrorClass === "llm_credentials_missing") {
      io.stderr(CREDENTIALS_REQUIRED_MESSAGE);
      return 2;
    }
    if (answer.outcome === "error" && llm.lastErrorClass === "llm_authentication_failed") {
      io.stderr(CREDENTIALS_REJECTED_MESSAGE);
      return 2;
    }
    io.stdout(args.json ? JSON.stringify(answer, null, 2) : renderAnswer(answer));
    return answer.outcome === "error" ? 1 : 0;
  } catch (error) {
    io.stderr(
      error instanceof OrchestratorError
        ? `実行できませんでした(${error.errorClass}): ${error.message}`
        : "実行できませんでした(内部エラー)。",
    );
    return 1;
  } finally {
    await gateway.close();
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== "string") {
    return false;
  }
  try {
    // npm の bin はシンボリックリンク経由で起動されるため実体のパスで比較する
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const code = await runCli(process.argv.slice(2), {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
  process.exitCode = code;
}
