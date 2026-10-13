/**
 * leisen-ask serve — Orchestrator を MCP サーバー(Streamable HTTP、ステートレス)として公開する
 * (T-021、ADR-018)。エントリは leisen-ask(bin/leisen-ask.ts の runCli が `serve` で振り分ける)。
 *
 *   leisen-ask serve --gateway <Gateway の MCP URL> --config <deployment.yaml>
 *                [--listen 127.0.0.1:8790] [--path /mcp]
 *                [--max-concurrent-runs 4] [--max-question-chars 4000]
 *                [--confirm-exposed-host] [--allow-non-persistable-sources]
 *                [--allow-insecure-upstream]
 *                [LLM バックエンドの指定: --llm / --model / --effort / --llm-base-url /
 *                 --llm-api-key-env / --reasoning-effort と LEISEN_LLM_*(leisen-ask と同じ)]
 *
 * - ツールは ask / feedback(server/tools.ts)。利用者の認証は Gateway に委譲する
 *   (server/http.ts の preflight。Orchestrator は IdP を持たず、独自の資格情報も持たない)
 * - --config(必須): orchestrator セクション(maxIterations / costLimitPerQuery)と不変条件7 の
 *   判定に使う(citedDocIds の記録方針は Gateway の run API がかける。ADR-019 決定5)
 * - run の記録(AnswerRun)は Gateway の run API に申告する(ADR-019)。環境変数
 *   LEISEN_ORCHESTRATOR_CREDENTIAL(Gateway と共有する Orchestrator の資格情報)を Gateway への接続に
 *   付ける。未設定なら開発用の既定値(WARNING)、NODE_ENV=production では必須(終了コード 2。
 *   bin/credential-options.ts)。Orchestrator は監査ストアに触れない
 * - 不変条件7(ADR-018 決定5): 永続化不可のソース(kind が slack / slack-*)が有効なら起動を
 *   拒否する(終了コード 1)。--allow-non-persistable-sources で解除できる(UI 側の一時チャット・
 *   保持期間の設定と法務確認が前提。docs/ui-librechat.md)。解除時は ask の retentionClass が
 *   non_persistable になる
 * - 公開境界(決定7): ループバック以外で待ち受けるには --confirm-exposed-host が必要
 *   (Gateway の confirmExposedHost と同じ規則。TLS・Host / Origin の検証はリバースプロキシ)
 * - 上流(Gateway・LLM)への接続は既定でループバック以外 https 必須。--allow-insecure-upstream
 *   (LEISEN_ALLOW_INSECURE_UPSTREAM=1)で開発・評価用途に限り非ループバックの http を許す
 *   (NODE_ENV=production では終了コード 2。有効時は平文 http の上流をホスト名で WARNING。
 *   bin/upstream-options.ts)
 * - Gateway が公開するソースと --config の照合(S6): --config で有効なコネクタにないソースを
 *   Gateway が公開していれば、そのリクエストの ask / feedback を config_mismatch で拒否する
 *   (不変条件7 と citedDocIds の分類は --config で判定しているため)。
 *   --allow-non-persistable-sources のときは許し、retentionClass を non_persistable にする
 * - 起動時に LLM・Gateway へは接続しない(設定の検証だけ)。探索プロンプトは読み込んでおく
 * - 起動ログ・エラーは stderr(stdout は使わない。help のみ stdout)。トークン・API キー・
 *   HMAC 鍵・環境変数の値は出さない(不変条件6)。Gateway の URL はホストだけを出す
 * - SIGINT / SIGTERM で受付を止め、進行中のリクエスト(run を含む)を最大 30 秒待って終了する
 *
 * 終了コード: 0 正常終了(停止の合図で止まった)、1 起動の拒否・実行時エラー(待ち受け失敗。
 * ポートが使用中なら --listen での変え方を案内する。停止時に進行中のリクエストが残った等)、
 * 2 引数・設定の不備
 */
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  DeploymentConfigError,
  isLoopbackHost,
  loadDeploymentConfig,
  type DeploymentConfig,
} from "@leisen/gateway";
import { isSlackKind } from "../audit.js";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  MAX_QUESTION_CHARS,
  type LlmBackendConfigInput,
  type OrchestratorSettingsInput,
} from "../config.js";
import { GatewayClientError, OrchestratorError } from "../errors.js";
import { parseGatewayUrl, parseInsecureGatewayUrl } from "../gateway/mcp-client.js";
import type { LlmClient } from "../llm/types.js";
import { Orchestrator } from "../orchestrator.js";
import { loadExplorePrompt } from "../prompt.js";
import {
  createOrchestratorRequestListener,
  DEFAULT_ORCHESTRATOR_HTTP_PATH,
  ORCHESTRATOR_HEALTH_PATH,
} from "../server/http.js";
import {
  DEFAULT_MAX_CONCURRENT_RUNS,
  DEFAULT_MAX_QUESTION_CHARS,
  InFlightRequests,
  MAX_CONCURRENT_RUNS_LIMIT,
  ServerLimits,
} from "../server/limits.js";
import {
  ORCHESTRATOR_CREDENTIAL_DEV_DEFAULT_WARNING,
  ORCHESTRATOR_CREDENTIAL_USAGE_LINE,
  describeOrchestratorCredential,
  resolveOrchestratorCredential,
} from "./credential-options.js";
import type { CliDependencies, CliIo } from "./leisen-ask.js";
import { LLM_USAGE_LINES, parseLlmCliOptions } from "./llm-options.js";
import {
  INSECURE_UPSTREAM_HINT,
  INSECURE_UPSTREAM_USAGE_LINE,
  insecureUpstreamWarning,
  isInsecureGatewayUrl,
  parseInsecureUpstreamOption,
} from "./upstream-options.js";

/** --listen の既定(ループバック)。 */
export const DEFAULT_SERVE_LISTEN = "127.0.0.1:8790";
/** 停止時に進行中のリクエストを待つ上限(ms)。 */
export const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;

const PREFIX = "leisen-ask serve";

export const SERVE_USAGE = [
  "usage: leisen-ask serve --gateway <Gateway の MCP エンドポイント URL> --config <deployment.yaml>",
  "                    [--listen <ホスト:ポート>] [--path <パス>]",
  "                    [--max-concurrent-runs <N>] [--max-question-chars <N>]",
  "                    [--confirm-exposed-host] [--allow-non-persistable-sources]",
  "                    [--allow-insecure-upstream] [LLM バックエンドの指定(下記)]",
  "  Orchestrator を MCP サーバー(Streamable HTTP)として公開します(ツール: ask / feedback)。",
  "  利用者の認証は Gateway に委譲します(Authorization: Bearer <IdP が利用者に発行したアクセストークン>)。",
  `  --listen の既定は ${DEFAULT_SERVE_LISTEN}(環境変数 LEISEN_LISTEN)。ループバック以外は --confirm-exposed-host が必要です。`,
  `  --path の既定は ${DEFAULT_ORCHESTRATOR_HTTP_PATH}(死活確認は GET ${ORCHESTRATOR_HEALTH_PATH})。`,
  `  --max-concurrent-runs の既定は ${DEFAULT_MAX_CONCURRENT_RUNS}(1〜${MAX_CONCURRENT_RUNS_LIMIT})、--max-question-chars の既定は ${DEFAULT_MAX_QUESTION_CHARS}(1〜${MAX_QUESTION_CHARS})。`,
  "  永続化不可のソース(Slack)が有効な --config では起動しません(--allow-non-persistable-sources で解除)。",
  ORCHESTRATOR_CREDENTIAL_USAGE_LINE,
  ...LLM_USAGE_LINES,
  INSECURE_UPSTREAM_USAGE_LINE,
  "  終了コード: 0 正常終了(SIGINT / SIGTERM)、1 起動の拒否・実行時エラー、2 引数・設定の不備",
].join("\n");

/** 不変条件7 による起動拒否の文言(ADR-018 決定5)。 */
export const NON_PERSISTABLE_SOURCES_REFUSAL =
  "永続化不可のソース(Slack)が有効な構成では、履歴を保存する汎用 UI から使えません。" +
  "解除するには --allow-non-persistable-sources を付け、docs/ui-librechat.md の保持設定と法務確認(ADR-014)を行ってください。";

/** 待ち受けのポートが使用中(EADDRINUSE)のときの案内。 */
export function servePortInUseMessage(port: number): string {
  return `ポート ${port} は使用中です。--listen <ホスト:ポート>(または環境変数 LEISEN_LISTEN)で別のポートを指定してください。`;
}

/** ループバック以外での待ち受けの拒否の文言(ADR-018 決定7)。 */
export const EXPOSED_HOST_REFUSAL =
  "--listen がループバック以外です。Orchestrator は TLS を終端せず Origin / Host も検証しないため、" +
  "TLS を終端するリバースプロキシを前段に置いたうえで --confirm-exposed-host を付けてください(docs/install.md)。";

/** 待ち受け中のエンドポイント(停止の合図を待つ関数に渡す)。 */
export interface ServeEndpoint {
  /** MCP エンドポイント(例: http://127.0.0.1:8790/mcp) */
  readonly url: string;
  /** 死活確認(例: http://127.0.0.1:8790/healthz) */
  readonly healthUrl: string;
}

class ServeUsageError extends Error {}

interface ServeArgs {
  readonly gateway: string;
  readonly config: string;
  readonly listen: { readonly host: string; readonly port: number };
  readonly path: string;
  /** Gateway と共有する Orchestrator の資格情報(秘密。ログに出さない) */
  readonly orchestratorCredential: string;
  readonly credentialSource: "env" | "dev-default";
  readonly maxConcurrentRuns: number;
  readonly maxQuestionChars: number;
  readonly confirmExposedHost: boolean;
  readonly allowNonPersistableSources: boolean;
  /** --allow-insecure-upstream(Gateway・LLM のループバック以外の http を許す) */
  readonly allowInsecureUpstream: boolean;
  readonly llm: LlmBackendConfigInput;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

/** `<ホスト>:<ポート>`(IPv6 は角括弧)。ポートは 0〜65535(0 は空きポート)。 */
export function parseListen(value: string): { host: string; port: number } | undefined {
  const match = /^(?:\[([0-9A-Fa-f:.]+)\]|([^\s:[\]]+)):(\d{1,5})$/.exec(value.trim());
  const host = match?.[1] ?? match?.[2];
  const port = Number(match?.[3]);
  if (host === undefined || !Number.isInteger(port) || port < 0 || port > 65_535) {
    return undefined;
  }
  return { host, port };
}

function parseIntegerFlag(
  value: string | undefined,
  fallback: number,
  max: number,
  message: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = /^\d{1,6}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new ServeUsageError(message);
  }
  return parsed;
}

function parseServeArgsStrict(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    options: {
      gateway: { type: "string" },
      config: { type: "string" },
      listen: { type: "string" },
      path: { type: "string" },
      "max-concurrent-runs": { type: "string" },
      "max-question-chars": { type: "string" },
      "confirm-exposed-host": { type: "boolean" },
      "allow-non-persistable-sources": { type: "boolean" },
      llm: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      "llm-base-url": { type: "string" },
      "llm-api-key-env": { type: "string" },
      "reasoning-effort": { type: "string" },
      "allow-insecure-upstream": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });
}

function parseServeArgs(
  argv: readonly string[],
  env: CliDependencies["env"],
): ServeArgs | "help" {
  let parsed: ReturnType<typeof parseServeArgsStrict>;
  try {
    parsed = parseServeArgsStrict(argv);
  } catch {
    // parseArgs のメッセージは引数の文字列を含みうる(トークン等の誤入力)ためエコーしない
    throw new ServeUsageError("引数を解釈できませんでした。");
  }
  const { values, positionals } = parsed;
  if (values.help === true || (positionals.length === 1 && positionals[0] === "help")) {
    return "help";
  }
  if (positionals.length > 0) {
    throw new ServeUsageError("serve は位置引数を取りません(質問はチャット UI などの MCP クライアントから ask ツールで渡します)。");
  }
  // 本番で平文 http の上流を許すフラグは、他の引数より先に固定文言で拒否する
  const insecure = parseInsecureUpstreamOption(values["allow-insecure-upstream"], env);
  if (!insecure.ok) {
    throw new ServeUsageError(insecure.message);
  }
  const gateway = nonEmpty(values.gateway);
  if (gateway === undefined) {
    throw new ServeUsageError("--gateway に Gateway の MCP エンドポイント URL を指定してください。");
  }
  const config = nonEmpty(values.config);
  if (config === undefined) {
    throw new ServeUsageError(
      "--config に deployment.yaml を指定してください(永続化不可のソースの判定と、Gateway が公開するソースとの照合に使います)。",
    );
  }
  const listen = parseListen(values.listen ?? nonEmpty(env["LEISEN_LISTEN"]) ?? DEFAULT_SERVE_LISTEN);
  if (listen === undefined) {
    throw new ServeUsageError(
      "--listen(または環境変数 LEISEN_LISTEN)は <ホスト>:<ポート> の形で指定してください(例: 127.0.0.1:8790、[::1]:8790)。",
    );
  }
  const path = values.path ?? DEFAULT_ORCHESTRATOR_HTTP_PATH;
  if (!/^\/[A-Za-z0-9._~/-]*$/.test(path) || path === ORCHESTRATOR_HEALTH_PATH) {
    throw new ServeUsageError(
      `--path は / で始まるパスで指定してください(英数字と . _ ~ / -。${ORCHESTRATOR_HEALTH_PATH} は使えません)。`,
    );
  }
  const maxConcurrentRuns = parseIntegerFlag(
    values["max-concurrent-runs"],
    DEFAULT_MAX_CONCURRENT_RUNS,
    MAX_CONCURRENT_RUNS_LIMIT,
    `--max-concurrent-runs は 1〜${MAX_CONCURRENT_RUNS_LIMIT} の整数で指定してください。`,
  );
  const maxQuestionChars = parseIntegerFlag(
    values["max-question-chars"],
    DEFAULT_MAX_QUESTION_CHARS,
    MAX_QUESTION_CHARS,
    `--max-question-chars は 1〜${MAX_QUESTION_CHARS} の整数で指定してください。`,
  );
  const llm = parseLlmCliOptions(values, env, { allowInsecureHttp: insecure.enabled });
  if (!llm.ok) {
    throw new ServeUsageError(llm.message);
  }
  // Gateway の run API に付ける Orchestrator の資格情報(本番では必須。値は表示しない)
  const credential = resolveOrchestratorCredential(env);
  if (!credential.ok) {
    throw new ServeUsageError(credential.message);
  }
  return {
    gateway,
    config,
    listen,
    path,
    orchestratorCredential: credential.credential,
    credentialSource: credential.source,
    maxConcurrentRuns,
    maxQuestionChars,
    confirmExposedHost: values["confirm-exposed-host"] === true,
    allowNonPersistableSources: values["allow-non-persistable-sources"] === true,
    allowInsecureUpstream: insecure.enabled,
    llm: llm.config,
  };
}

/** Node のシステムエラーはコードだけ、それ以外は種別名だけ(メッセージは出さない)。 */
function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string") {
    return code;
  }
  return error instanceof Error ? error.name : typeof error;
}

/** 永続化不可のソース(kind が slack / slack-*)のうち有効なもの(不変条件7、ADR-014)。 */
export function nonPersistableSourceIds(config: Pick<DeploymentConfig, "connectors">): string[] {
  return config.connectors
    .filter((connector) => connector.enabled && isSlackKind(connector.kind))
    .map((connector) => connector.id);
}

/**
 * --config で有効なコネクタの sourceId(Gateway が公開するソースとの照合に使う。S6)。
 * Gateway の tools/list は有効なコネクタだけを公開するため、無効なものは含めない
 * (--config で無効な Slack ソースを Gateway が公開していたら、不変条件7 の判定を
 * 通っていないので不一致として扱う)。
 */
export function enabledSourceIds(config: Pick<DeploymentConfig, "connectors">): string[] {
  return config.connectors
    .filter((connector) => connector.enabled)
    .map((connector) => connector.id);
}

/** deployment.yaml の orchestrator セクション(maxIterations / costLimitPerQuery)を探索の設定にする。 */
function settingsFromDeployment(config: DeploymentConfig): OrchestratorSettingsInput {
  const { maxIterations, costLimitPerQuery } = config.orchestrator;
  return {
    maxIterations,
    ...(costLimitPerQuery !== undefined ? { costLimitPerQuery } : {}),
  };
}

/** 起動ログ用の LLM バックエンドの説明(キー・ベース URL のパスとクエリは出さない)。 */
function describeLlm(config: LlmBackendConfigInput): string {
  if (config.provider === "anthropic") {
    return `anthropic (model: ${config.model ?? DEFAULT_MODEL}, effort: ${config.effort ?? DEFAULT_EFFORT})`;
  }
  let host = "(invalid)";
  try {
    host = new URL(config.baseUrl).host;
  } catch {
    // parseLlmCliOptions で検証済み(到達しない)
  }
  return `openai-compatible (model: ${config.model}, base URL host: ${host})`;
}

function hostForUrl(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function listen(server: HttpServer, port: number, host: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/** 最初の SIGINT / SIGTERM を待つ(2回目は既定動作 = 即時終了に任せる)。 */
export function waitForTerminationSignal(): Promise<string> {
  return new Promise((resolveSignal) => {
    const onSignal = (signal: NodeJS.Signals) => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolveSignal(signal);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

/** leisen-ask serve の本体。終了コードを返す(プロセスの終了は呼び出し側)。 */
export async function runServe(
  argv: readonly string[],
  io: CliIo,
  deps: CliDependencies,
): Promise<number> {
  let args: ServeArgs;
  try {
    const parsed = parseServeArgs(argv, deps.env);
    if (parsed === "help") {
      io.stdout(SERVE_USAGE);
      return 0;
    }
    args = parsed;
  } catch (error) {
    io.stderr(
      `${PREFIX}: ${error instanceof ServeUsageError ? error.message : "引数を解釈できませんでした。"}`,
    );
    io.stderr(SERVE_USAGE);
    return 2;
  }

  let gatewayUrl: URL;
  try {
    // 検証の入口で分岐する(parseGatewayUrl 自体は変えない)
    gatewayUrl = args.allowInsecureUpstream
      ? parseInsecureGatewayUrl(args.gateway)
      : parseGatewayUrl(args.gateway);
  } catch (error) {
    // GatewayClientError の文言は固定文言(URL の中身を含まない)
    io.stderr(
      `${PREFIX}: --gateway の指定が不正です: ${
        error instanceof GatewayClientError ? error.message : "the gateway URL is invalid"
      }${!args.allowInsecureUpstream && isInsecureGatewayUrl(args.gateway) ? ` ${INSECURE_UPSTREAM_HINT}` : ""}`,
    );
    return 2;
  }

  const configPath = resolve(args.config);
  let config: DeploymentConfig;
  try {
    config = loadDeploymentConfig(configPath);
  } catch (error) {
    if (error instanceof DeploymentConfigError) {
      // 設定スキーマに秘密情報のフィールドはない(issues をそのまま出してよい)
      io.stderr(`${PREFIX}: deployment config rejected: ${configPath}: ${error.issues.length} issue(s)`);
      for (const issue of error.issues) {
        io.stderr(`  - [${issue.code}] ${issue.path}: ${issue.message}`);
      }
    } else {
      io.stderr(`${PREFIX}: --config の deployment.yaml を読めませんでした(${configPath}: ${errorCode(error)})。`);
    }
    return 2;
  }

  // 不変条件7(ADR-018 決定5): 永続化不可のソースが有効なら、明示の解除なしには起動しない
  const nonPersistable = nonPersistableSourceIds(config);
  if (nonPersistable.length > 0 && !args.allowNonPersistableSources) {
    io.stderr(`${PREFIX}: ${NON_PERSISTABLE_SOURCES_REFUSAL}(該当するソース: ${nonPersistable.join(", ")})`);
    return 1;
  }
  // 公開境界(決定7)
  if (!isLoopbackHost(args.listen.host) && !args.confirmExposedHost) {
    io.stderr(`${PREFIX}: ${EXPOSED_HOST_REFUSAL}`);
    return 1;
  }

  // 探索プロンプト(prompts/)がなければ、どの run も失敗するため起動しない
  try {
    await loadExplorePrompt();
  } catch (error) {
    io.stderr(`${PREFIX}: 探索プロンプト(prompts/)を読めませんでした(${errorCode(error)})。`);
    return 1;
  }

  // LLM クライアントは起動時に1回作る(接続はしない)
  let llm: LlmClient;
  try {
    llm = deps.createLlmClient(args.llm);
  } catch {
    io.stderr(`${PREFIX}: LLM バックエンドを初期化できませんでした。`);
    return 2;
  }

  let orchestrator: Orchestrator;
  try {
    orchestrator = new Orchestrator({ llm, settings: settingsFromDeployment(config) });
  } catch (error) {
    io.stderr(
      error instanceof OrchestratorError
        ? `${PREFIX}: Orchestrator を初期化できませんでした(${error.errorClass})。`
        : `${PREFIX}: Orchestrator を初期化できませんでした。`,
    );
    return 2;
  }

  const limits = new ServerLimits({
    maxConcurrentRuns: args.maxConcurrentRuns,
    maxQuestionChars: args.maxQuestionChars,
  });
  const inFlight = new InFlightRequests();
  const listener = createOrchestratorRequestListener(
    {
      orchestrator,
      gatewayUrl: gatewayUrl.href,
      // run API と runId を申告する tools/call に付ける(ADR-019 決定3)
      orchestratorCredential: args.orchestratorCredential,
      limits,
      retentionClass: nonPersistable.length > 0 ? "non_persistable" : "persistable",
      // Gateway が --config にないソースを公開していれば ask / feedback を断る(S6)。
      // 解除のフラグがあれば許し、そのリクエストの retentionClass を non_persistable にする
      sourcePolicy: {
        knownSourceIds: enabledSourceIds(config),
        onUnknownSource: args.allowNonPersistableSources ? "non_persistable" : "reject",
      },
      // --allow-insecure-upstream のときだけ、Gateway への接続(preflight・ask・feedback)に
      // 非ループバックの http を許す
      createGatewayClient: (options) =>
        deps.createGatewayClient({
          ...options,
          ...(args.allowInsecureUpstream ? { allowInsecureHttp: true } : {}),
        }),
    },
    { path: args.path },
  );
  const server = createServer((req, res) => {
    inFlight.track(res);
    listener(req, res);
  });
  const { host } = args.listen;
  try {
    await listen(server, args.listen.port, host);
  } catch (error) {
    io.stderr(`${PREFIX}: cannot listen on ${hostForUrl(host)}:${args.listen.port}: ${errorCode(error)}`);
    if (errorCode(error) === "EADDRINUSE") {
      io.stderr(`${PREFIX}: ${servePortInUseMessage(args.listen.port)}`);
    }
    return 1;
  }
  server.on("error", (error) => {
    io.stderr(`${PREFIX}: http server error: ${errorCode(error)}`);
  });

  const { port } = server.address() as AddressInfo;
  const origin = `http://${hostForUrl(host)}:${port}`;
  const endpoint: ServeEndpoint = {
    url: `${origin}${args.path}`,
    healthUrl: `${origin}${ORCHESTRATOR_HEALTH_PATH}`,
  };
  const { maxIterations } = orchestrator.settings;
  io.stderr(`${PREFIX}: listening on ${endpoint.url} (health check: ${endpoint.healthUrl})`);
  io.stderr(`${PREFIX}: deployment: ${config.deployment.name}`);
  // Gateway の URL はホストだけ(パス・クエリは出さない)
  io.stderr(`${PREFIX}: gateway: ${gatewayUrl.protocol}//${gatewayUrl.host}`);
  // run の記録は Gateway の run API(ADR-019)。資格情報の値は出さない
  io.stderr(
    `${PREFIX}: run api: gateway (orchestrator credential: ${describeOrchestratorCredential(args.credentialSource)})`,
  );
  if (args.credentialSource === "dev-default") {
    io.stderr(`${PREFIX}: ${ORCHESTRATOR_CREDENTIAL_DEV_DEFAULT_WARNING}`);
  }
  io.stderr(
    `${PREFIX}: limits: max-concurrent-runs=${limits.runs.maxConcurrentRuns}, ` +
      `max-question-chars=${limits.maxQuestionChars}, max-iterations=${maxIterations}`,
  );
  io.stderr(`${PREFIX}: llm: ${describeLlm(args.llm)}`);
  // 平文 http の上流(--allow-insecure-upstream)は WARNING を1行出す(ホスト名だけ)
  const insecureWarning = args.allowInsecureUpstream
    ? insecureUpstreamWarning({ gatewayUrl: args.gateway, llm: args.llm })
    : undefined;
  if (insecureWarning !== undefined) {
    io.stderr(`${PREFIX}: ${insecureWarning}`);
  }
  if (nonPersistable.length > 0) {
    io.stderr(
      `${PREFIX}: WARNING: non-persistable sources are enabled (${nonPersistable.join(", ")}) ` +
        "with --allow-non-persistable-sources; answers are marked retentionClass=non_persistable. " +
        "The UI must not keep them in its history (docs/ui-librechat.md, ADR-014)",
    );
  }

  const reason = await (deps.waitForShutdown ?? waitForTerminationSignal)(endpoint);
  io.stderr(`${PREFIX}: ${reason} received, shutting down`);
  const closed = new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
  });
  const graceMs = deps.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const drained = await inFlight.whenIdle(graceMs);
  if (!drained) {
    io.stderr(
      `${PREFIX}: WARNING: ${inFlight.count} request(s) still in progress after ${graceMs} ms; closing their connections`,
    );
  }
  server.closeAllConnections();
  await closed;
  io.stderr(`${PREFIX}: stopped`);
  return drained ? 0 : 1;
}
