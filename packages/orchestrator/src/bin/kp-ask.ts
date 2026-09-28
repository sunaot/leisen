#!/usr/bin/env node
/**
 * kp-ask — Orchestrator の CLI(T-007)。
 *
 *   kp-ask --gateway http://127.0.0.1:8787/mcp [--token <セッショントークン>]
 *          [--model <モデルID>] [--max-iterations N] [--effort low|medium|high|xhigh|max]
 *          [--user-id <userId>] [--config <deployment.yaml>] [--json] "質問文"
 *
 * - セッショントークンは --token か環境変数 KP_SESSION_TOKEN で渡す(--token は
 *   プロセス一覧に残るため環境変数を推奨)。トークンは表示・ログに出さない
 * - Claude API の資格情報は SDK が環境から解決する(ANTHROPIC_API_KEY、
 *   ANTHROPIC_AUTH_TOKEN、`ant auth login` のプロファイル等)。無い・無効な場合は
 *   その旨を表示して終了コード 2
 * - LLM バックエンドは --llm で選ぶ(既定 anthropic。openai-compatible は LM Studio 等の
 *   OpenAI 互換エンドポイント。指定の解釈は bin/llm-options.ts、ADR-017 決定1)
 * - AnswerRun の監査レコードは stderr に JSON 1行で出す(開発用。ToolInvocation は
 *   Gateway 側の監査に記録される)
 * - AnswerRun の質問者は Gateway が認証した userId。--user-id(または環境変数 KP_USER_ID)は
 *   照合用の申告で、一致しなければ run は error(user_mismatch)。省略時は照合しない
 * - --config は deployment.yaml(citedDocIds の記録方針: connectors[] の kind / privateScopes
 *   と audit.privateScopeDocIds)。hashed なら環境変数 KP_AUDIT_HMAC_KEY にデプロイ固有鍵が
 *   要る。--config を省略すると citedDocIds を記録しない
 *
 * 終了コード: 0 回答した(resolved / unresolved)、1 実行時エラー、2 引数・資格情報の不備
 *
 * サブコマンド `kp-ask serve`(bin/serve.ts): Orchestrator を MCP サーバーとして公開する
 * (T-021、ADR-018)。最初の引数が `serve` のときだけ振り分ける。
 *
 * npm の bin(`npx kp-ask`)からは、リポジトリに含まれる起動シム packages/orchestrator/bin/kp-ask.js
 * 経由で読み込まれ、main() が呼ばれる(このファイルは自分がエントリのときだけ自動実行する)。
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  AuditLogger,
  DeploymentConfigError,
  loadDeploymentConfig,
} from "@kp/gateway";
import type { Answer } from "../answer.js";
import {
  docIdAuditFromDeployment,
  OMIT_ALL_DOC_IDS,
  StderrDebugAuditSink,
  type CitedDocIdAudit,
} from "../audit.js";
import {
  orchestratorSettingsSchema,
  type LlmBackendConfigInput,
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
import { createLlmClient } from "../llm/factory.js";
import type {
  LlmCallOptions,
  LlmCapabilities,
  LlmClient,
  LlmProvider,
  LlmRequest,
  LlmTurn,
} from "../llm/types.js";
import { Orchestrator } from "../orchestrator.js";
import {
  LLM_USAGE_LINES,
  backendHintFor,
  credentialsMessageFor,
  parseLlmCliOptions,
} from "./llm-options.js";
import { runServe, waitForTerminationSignal, type ServeEndpoint } from "./serve.js";
import {
  INSECURE_UPSTREAM_HINT,
  INSECURE_UPSTREAM_USAGE_LINE,
  insecureUpstreamWarning,
  isInsecureGatewayUrl,
  parseInsecureUpstreamOption,
} from "./upstream-options.js";

export const USAGE = [
  "usage: kp-ask --gateway <MCPエンドポイントURL> [--token <セッショントークン>]",
  "              [--model <モデルID>] [--max-iterations <N>] [--effort low|medium|high|xhigh|max]",
  "              [--user-id <userId>] [--config <deployment.yaml>] [--json] <質問文>",
  "  セッショントークンは環境変数 KP_SESSION_TOKEN でも渡せます(推奨)。",
  "  Claude API の資格情報は ANTHROPIC_API_KEY 等の環境から解決します。",
  "  --user-id は照合用(省略時は Gateway が認証した利用者を記録します)。",
  "  --config の audit.privateScopeDocIds が hashed なら KP_AUDIT_HMAC_KEY が必要です。",
  ...LLM_USAGE_LINES,
  INSECURE_UPSTREAM_USAGE_LINE,
  "  MCP サーバーとして起動する: kp-ask serve --gateway <URL> --config <deployment.yaml>(詳細は kp-ask serve --help)",
].join("\n");

export {
  CREDENTIALS_REJECTED_MESSAGE,
  CREDENTIALS_REQUIRED_MESSAGE,
  OPENAI_COMPATIBLE_CREDENTIALS_REJECTED_MESSAGE,
  OPENAI_COMPATIBLE_CREDENTIALS_REQUIRED_MESSAGE,
} from "./llm-options.js";
export { INSECURE_UPSTREAM_IN_PRODUCTION_MESSAGE } from "./upstream-options.js";

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface CliDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** LLM バックエンドの設定(provider 付き)からクライアントを作る */
  createLlmClient(config: LlmBackendConfigInput): LlmClient;
  createGatewayClient(options: {
    readonly url: string;
    readonly sessionToken: string;
    /** MCP 1リクエストのタイムアウト(ms)。省略時はクライアントの既定 */
    readonly requestTimeoutMs?: number;
    /** ループバック以外の http の Gateway を許す(--allow-insecure-upstream) */
    readonly allowInsecureHttp?: boolean;
  }): GatewayClient;
  /**
   * serve: 停止の合図を待つ(既定: 最初の SIGINT / SIGTERM)。引数は待ち受け中の
   * エンドポイント。解決値はログ用の理由
   */
  readonly waitForShutdown?: (endpoint: ServeEndpoint) => Promise<string>;
  /** serve: 停止時に進行中のリクエストを待つ上限(ms、既定 30000) */
  readonly shutdownGraceMs?: number;
}

export const defaultCliDependencies: CliDependencies = {
  env: process.env,
  createLlmClient: (config) => createLlmClient(config),
  createGatewayClient: (options) => new McpGatewayClient(options),
  waitForShutdown: () => waitForTerminationSignal(),
};

class UsageError extends Error {}

interface CliArgs {
  readonly gateway: string;
  readonly token: string;
  readonly question: string;
  /** 照合用の申告(省略時は Gateway が認証した userId をそのまま使う) */
  readonly userId: string | undefined;
  readonly config: string | undefined;
  readonly json: boolean;
  readonly settings: OrchestratorSettings;
  readonly llm: LlmBackendConfigInput;
  /** --allow-insecure-upstream(Gateway・LLM のループバック以外の http を許す) */
  readonly allowInsecureUpstream: boolean;
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
  // 本番で平文 http の上流を許すフラグは、他の引数より先に固定文言で拒否する
  const insecure = parseInsecureUpstreamOption(values["allow-insecure-upstream"], env);
  if (!insecure.ok) {
    throw new UsageError(insecure.message);
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

  const llm = parseLlmCliOptions(values, env, { allowInsecureHttp: insecure.enabled });
  if (!llm.ok) {
    throw new UsageError(llm.message);
  }

  return {
    gateway,
    token,
    question,
    userId: values["user-id"] ?? env["KP_USER_ID"],
    config: values.config,
    json: values.json === true,
    settings: settings.data,
    llm: llm.config,
    allowInsecureUpstream: insecure.enabled,
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
      llm: { type: "string" },
      "llm-base-url": { type: "string" },
      "llm-api-key-env": { type: "string" },
      "reasoning-effort": { type: "string" },
      "allow-insecure-upstream": { type: "boolean" },
      "user-id": { type: "string" },
      config: { type: "string" },
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
  readonly #inner: LlmClient;

  constructor(inner: LlmClient) {
    this.#inner = inner;
  }

  get provider(): LlmProvider {
    return this.#inner.provider;
  }

  get capabilities(): LlmCapabilities {
    return this.#inner.capabilities;
  }

  async complete(request: LlmRequest, options?: LlmCallOptions): Promise<LlmTurn> {
    try {
      return await this.#inner.complete(request, options);
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
  if (argv[0] === "serve") {
    return runServe(argv.slice(1), io, deps);
  }
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

  // 平文 http の上流(--allow-insecure-upstream)は WARNING を1行出す(ホスト名だけ)
  const insecureWarning = args.allowInsecureUpstream
    ? insecureUpstreamWarning({ gatewayUrl: args.gateway, llm: args.llm })
    : undefined;
  if (insecureWarning !== undefined) {
    io.stderr(insecureWarning);
  }

  let gateway: GatewayClient;
  let llm: ObservingLlmClient;
  try {
    gateway = deps.createGatewayClient({
      url: args.gateway,
      sessionToken: args.token,
      ...(args.allowInsecureUpstream ? { allowInsecureHttp: true } : {}),
    });
    llm = new ObservingLlmClient(deps.createLlmClient(args.llm));
  } catch (error) {
    // GatewayClientError のメッセージは固定文言(トークン・URL の中身を含まない)
    io.stderr(
      error instanceof GatewayClientError
        ? `Gateway の指定が不正です: ${error.message}${
            !args.allowInsecureUpstream && isInsecureGatewayUrl(args.gateway)
              ? ` ${INSECURE_UPSTREAM_HINT}`
              : ""
          }`
        : "クライアントを初期化できませんでした。",
    );
    return 2;
  }

  let docIdAudit: CitedDocIdAudit = OMIT_ALL_DOC_IDS;
  if (args.config !== undefined) {
    try {
      docIdAudit = docIdAuditFromDeployment(
        loadDeploymentConfig(args.config),
        deps.env["KP_AUDIT_HMAC_KEY"],
      );
    } catch (error) {
      // DeploymentConfigError の文言は秘密情報を含まない(設定スキーマに秘密のフィールドがない)
      io.stderr(
        error instanceof DeploymentConfigError
          ? error.message
          : "--config の deployment.yaml を読めませんでした。",
      );
      await gateway.close();
      return 2;
    }
  }
  let orchestrator: Orchestrator;
  try {
    orchestrator = new Orchestrator({
      llm,
      auditLogger: new AuditLogger(new StderrDebugAuditSink((line) => io.stderr(line))),
      docIdAudit,
      settings: args.settings,
    });
  } catch (error) {
    io.stderr(
      error instanceof OrchestratorError && error.errorClass === "invalid_configuration"
        ? "audit.privateScopeDocIds が hashed のため、環境変数 KP_AUDIT_HMAC_KEY にデプロイ固有鍵を設定してください。"
        : "Orchestrator を初期化できませんでした。",
    );
    await gateway.close();
    return 2;
  }
  try {
    const answer = await orchestrator.run({
      question: args.question,
      gateway,
      ...(args.userId !== undefined ? { userId: args.userId } : {}),
    });
    const credentials =
      answer.outcome === "error"
        ? credentialsMessageFor(args.llm.provider, llm.lastErrorClass)
        : undefined;
    if (credentials !== undefined) {
      io.stderr(credentials);
      return 2;
    }
    const hint =
      answer.outcome === "error" ? backendHintFor(args.llm.provider, llm.lastErrorClass) : undefined;
    if (hint !== undefined) {
      io.stderr(hint);
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

/**
 * プロセスのエントリ。標準入出力につなぎ、終了コードを process.exitCode に設定する。
 * `node dist/bin/kp-ask.js`(下の isMainModule)と npm の bin(起動シム bin/kp-ask.js)の
 * 両方から呼ばれる。
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  process.exitCode = await runCli(argv, {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  }).catch((error: unknown) => {
    // 想定外の失敗。生の例外メッセージ・スタックは出さない(トークン等を含みうる、不変条件6)
    process.stderr.write(
      `kp-ask: unexpected error (${error instanceof Error ? error.name : typeof error})\n`,
    );
    return 1;
  });
}

if (isMainModule()) {
  await main();
}
