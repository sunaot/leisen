#!/usr/bin/env node
/**
 * kp-ask — Orchestrator の CLI(T-007)。
 *
 *   kp-ask --gateway http://127.0.0.1:8787/mcp [--token <セッショントークン>]
 *          [--model <モデルID>] [--max-iterations N] [--effort low|medium|high|xhigh|max]
 *          [--user-id <userId>] [--config <deployment.yaml>] [--answer-run-jsonl <path>]
 *          [--json] "質問文"
 *
 * - セッショントークンは --token か環境変数 KP_SESSION_TOKEN で渡す(--token は
 *   プロセス一覧に残るため環境変数を推奨)。トークンは表示・ログに出さない
 * - Claude API の資格情報は SDK が環境から解決する(ANTHROPIC_API_KEY、
 *   ANTHROPIC_AUTH_TOKEN、`ant auth login` のプロファイル等)。無い・無効な場合は
 *   その旨を表示して終了コード 2
 * - LLM バックエンドは --llm で選ぶ(既定 anthropic。openai-compatible は LM Studio 等の
 *   OpenAI 互換エンドポイント。指定の解釈は bin/llm-options.ts、ADR-017 決定1)
 * - AnswerRun の監査レコードは既定で stderr に JSON 1行で出す(開発用。記録を黙って捨てない
 *   ため)。--answer-run-jsonl <path> を付けるとそのファイルに追記し(kp-ask serve と同じ形式・
 *   同じ規則: 追記のみ、新規作成は 0600、ディレクトリは作らない、Gateway の監査ログと同じファイルは
 *   拒否)、stderr には出さない。この照合のため --answer-run-jsonl には --config が必須(serve と
 *   同じ強さ。--config なしでは Gateway の監査ログかどうかを判定できない)。
 *   環境変数 KP_ANSWER_RUN_JSONL は読まない(serve と同じファイルに2プロセスで書かないため)。
 *   ToolInvocation は Gateway 側の監査に記録される
 * - --json の出力契約(README「kp-ask の出力契約」): 回答できたとき・run が error で終わったときは
 *   Answer、回答を返せなかったとき(引数・設定・資格情報の不備、実行時の例外)は失敗の表現
 *   { outcome: "error", errorClass, message[, runId] } を stdout に JSON で1つ出す。終了コードは
 *   --json の有無で変わらない
 * - AnswerRun の質問者は Gateway が認証した userId。--user-id(または環境変数 KP_USER_ID)は
 *   照合用の申告で、一致しなければ run は error(user_mismatch)。省略時は照合しない
 * - --config は deployment.yaml(citedDocIds の記録方針: connectors[] の kind / privateScopes
 *   と audit.privateScopeDocIds)。hashed なら環境変数 KP_AUDIT_HMAC_KEY にデプロイ固有鍵が
 *   要る(生成例: openssl rand -hex 32。導入ごとに1回だけ作って同じ値を使う)。--config を
 *   省略すると citedDocIds を記録しない
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
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  AuditLogger,
  type AuditSink,
} from "@kp/audit";
import {
  DeploymentConfigError,
  loadDeploymentConfig,
  type DeploymentConfig,
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
import { prepareAnswerRunJsonlSink } from "../server/answer-run-jsonl.js";
import {
  LLM_USAGE_LINES,
  backendHintFor,
  credentialsMessageFor,
  parseLlmCliOptions,
} from "./llm-options.js";
import {
  AUDIT_HMAC_KEY_REQUIRED_MESSAGE,
  runServe,
  waitForTerminationSignal,
  type ServeEndpoint,
} from "./serve.js";
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
  "              [--user-id <userId>] [--config <deployment.yaml>] [--answer-run-jsonl <path>]",
  "              [--json] <質問文>",
  "  セッショントークンは環境変数 KP_SESSION_TOKEN でも渡せます(推奨)。",
  "  Claude API の資格情報は ANTHROPIC_API_KEY 等の環境から解決します。",
  "  --user-id は照合用(省略時は Gateway が認証した利用者を記録します)。",
  "  --config の audit.privateScopeDocIds が hashed なら KP_AUDIT_HMAC_KEY が必要です(生成例: openssl rand -hex 32)。",
  "  AnswerRun(監査レコード)は既定で stderr に出します。--answer-run-jsonl を付けるとそのファイルに追記します(0600)。",
  "  --answer-run-jsonl には --config が必要です(Gateway の監査ログと同じファイルでないことを照合するため)。",
  "  --json は回答を返せない失敗でも stdout に JSON を1つ出します({ outcome: \"error\", errorClass, message })。",
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

/**
 * --json の失敗の表現(回答を返せなかったとき。README「kp-ask の出力契約」)。Answer の
 * outcome: error に揃えて outcome を持ち、回答本文の代わりに message(利用者向けの説明。
 * stderr に出す文言と同じ)、正規化コード errorClass(lower snake_case。kp-ask serve の
 * structuredContent.errorClass と同じ規約)を持つ。run を始めた後の失敗(LLM の資格情報の
 * 不備)では runId も持つ(AnswerRun と突き合わせられる)。トークン・API キーは含めない。
 */
export interface CliFailureOutput {
  readonly outcome: "error";
  readonly errorClass: string;
  readonly message: string;
  readonly runId?: string;
}

/**
 * 引数に --json があるか(引数の解釈に失敗したときも失敗の JSON を出すため、厳密な解釈の
 * 前に見る)。`--` より後ろは位置引数なので見ない。
 */
function wantsJson(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === "--") {
      return false;
    }
    if (arg === "--json") {
      return true;
    }
  }
  return false;
}

interface CliArgs {
  readonly gateway: string;
  readonly token: string;
  readonly question: string;
  /** 照合用の申告(省略時は Gateway が認証した userId をそのまま使う) */
  readonly userId: string | undefined;
  readonly config: string | undefined;
  /** AnswerRun の追記先(省略時は stderr) */
  readonly answerRunJsonl: string | undefined;
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

  const answerRunJsonl =
    values["answer-run-jsonl"] !== undefined && values["answer-run-jsonl"].trim() !== ""
      ? values["answer-run-jsonl"].trim()
      : undefined;
  if (answerRunJsonl !== undefined && values.config === undefined) {
    // Gateway の監査ログ(audit.jsonl.path / rawQueryPath)と同じファイルでないことは --config が
    // ないと照合できない(kp-ask serve は --config が必須なので常に照合される)
    throw new UsageError(
      "--answer-run-jsonl には --config が必要です(Gateway の監査ログと同じファイルでないことを照合するため)。",
    );
  }

  return {
    gateway,
    token,
    question,
    userId: values["user-id"] ?? env["KP_USER_ID"],
    config: values.config,
    answerRunJsonl,
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
      "answer-run-jsonl": { type: "string" },
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
  // 回答を返せない失敗: 説明を stderr に出し、--json なら失敗の表現を stdout に1つ出す
  // (出力契約。終了コードは --json の有無で変えない)
  const json = wantsJson(argv);
  const emitFailure = (errorClass: string, message: string, runId?: string): void => {
    if (json) {
      const output: CliFailureOutput = {
        outcome: "error",
        errorClass,
        message,
        ...(runId !== undefined ? { runId } : {}),
      };
      io.stdout(JSON.stringify(output, null, 2));
    }
  };
  const fail = (
    exitCode: number,
    errorClass: string,
    message: string,
    runId?: string,
  ): number => {
    io.stderr(message);
    emitFailure(errorClass, message, runId);
    return exitCode;
  };

  let args: CliArgs;
  try {
    const parsed = parseCliArgs(argv, deps.env);
    if (parsed === "help") {
      io.stdout(USAGE);
      return 0;
    }
    args = parsed;
  } catch (error) {
    const message = error instanceof UsageError ? error.message : "引数を解釈できませんでした。";
    io.stderr(message);
    io.stderr(USAGE);
    emitFailure("invalid_arguments", message);
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
    return error instanceof GatewayClientError
      ? fail(
          2,
          "invalid_arguments",
          `Gateway の指定が不正です: ${error.message}${
            !args.allowInsecureUpstream && isInsecureGatewayUrl(args.gateway)
              ? ` ${INSECURE_UPSTREAM_HINT}`
              : ""
          }`,
        )
      : fail(2, "invalid_configuration", "クライアントを初期化できませんでした。");
  }

  let deployment: { readonly config: DeploymentConfig; readonly configPath: string } | undefined;
  let docIdAudit: CitedDocIdAudit = OMIT_ALL_DOC_IDS;
  if (args.config !== undefined) {
    try {
      const config = loadDeploymentConfig(args.config);
      docIdAudit = docIdAuditFromDeployment(config, deps.env["KP_AUDIT_HMAC_KEY"]);
      deployment = { config, configPath: resolve(args.config) };
    } catch (error) {
      await gateway.close();
      // DeploymentConfigError の文言は秘密情報を含まない(設定スキーマに秘密のフィールドがない)
      return fail(
        2,
        "invalid_configuration",
        error instanceof DeploymentConfigError
          ? error.message
          : "--config の deployment.yaml を読めませんでした。",
      );
    }
  }

  // AnswerRun の書き先: 既定は stderr(開発用。黙って捨てない)。--answer-run-jsonl ならファイル
  // (kp-ask serve と同じ検査とシンク。--config があれば Gateway の監査ログと同じファイルを拒否する)
  let sink: AuditSink = new StderrDebugAuditSink((line) => io.stderr(line));
  if (args.answerRunJsonl !== undefined) {
    const prepared = await prepareAnswerRunJsonlSink(args.answerRunJsonl, deployment);
    if (!prepared.ok) {
      await gateway.close();
      return fail(2, "invalid_configuration", prepared.message);
    }
    sink = prepared.sink;
  }

  let orchestrator: Orchestrator;
  try {
    orchestrator = new Orchestrator({
      llm,
      auditLogger: new AuditLogger(sink),
      docIdAudit,
      settings: args.settings,
    });
  } catch (error) {
    await gateway.close();
    return fail(
      2,
      "invalid_configuration",
      error instanceof OrchestratorError && error.errorClass === "invalid_configuration"
        ? AUDIT_HMAC_KEY_REQUIRED_MESSAGE
        : "Orchestrator を初期化できませんでした。",
    );
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
      // LLM の資格情報の不備(終了コード 2)。回答の代わりに失敗の表現を出す(runId 付き)
      return fail(2, llm.lastErrorClass ?? "llm_credentials_missing", credentials, answer.runId);
    }
    const hint =
      answer.outcome === "error" ? backendHintFor(args.llm.provider, llm.lastErrorClass) : undefined;
    if (hint !== undefined) {
      io.stderr(hint);
    }
    io.stdout(args.json ? JSON.stringify(answer, null, 2) : renderAnswer(answer));
    return answer.outcome === "error" ? 1 : 0;
  } catch (error) {
    return error instanceof OrchestratorError
      ? fail(1, error.errorClass, `実行できませんでした(${error.errorClass}): ${error.message}`)
      : fail(1, "internal_error", "実行できませんでした(内部エラー)。");
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
