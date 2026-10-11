/**
 * kp-gateway CLI(起動コード)。エントリは bin/kp-gateway.ts。
 *
 *   kp-gateway serve    --config <deployment.yaml> [--port <n>] [--host <addr>]   Gatewayを起動する
 *   kp-gateway validate --config <deployment.yaml> [--port <n>] [--host <addr>]   設定を検証する(listen しない)
 *   kp-gateway auth-check --config <deployment.yaml> --token-env <VAR>           Keycloak の検証項目を1回試す
 *
 * - auth-check は環境変数 <VAR> のセッショントークンを IdP(kind: keycloak のみ)でイントロスペクションし、
 *   検証項目(active / iss / typ / azp / aud)ごとの pass / fail / skipped と userId を標準出力に出す
 *   (issue #16)。トークンは引数に取らず、出力にも出さない。コネクタは組み立てず listen もしない
 * - --config を省略すると環境変数 KP_DEPLOYMENT_CONFIG を使う
 * - --port / --host は deployment.yaml の gateway.http.port / host より優先する(issue #38)。
 *   上書き後の値で公開境界の検査(validateGatewayHttpExposure)を行うため、ループバック以外の
 *   --host には deployment.yaml の gateway.http.confirmExposedHost: true が要る(フラグでは解除できない)
 * - 待ち受けのポートが使用中(EADDRINUSE)なら、変更の方法を日本語で案内して終了コード 1
 * - 起動時の警告(モック IdP のセッション表が空など)は validate / serve の両方で stderr に出す
 * - 終了コード: 0 正常 / 1 設定不備・起動失敗・停止時の監査flush失敗 / 2 使い方の誤り
 *   (auth-check: 0 全項目 pass / 1 いずれかが fail または IdP に届かない / 2 設定不備・使い方の誤り)
 * - 出力: 起動ログとエラーは標準エラー出力(標準出力は audit.sink: stdout の監査
 *   レコードが使う)。validate の結果は標準出力
 * - トークン・clientSecret・環境変数の値・設定オブジェクト全体は出さない
 *   (不変条件6)。DeploymentConfigError の issues はスキーマに秘密情報がない設計の
 *   ためそのまま出す
 */
import type { Server as HttpServer } from "node:http";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  assembleGateway,
  type AssembledGateway,
} from "../bootstrap/assemble.js";
import { DEV_ONLY_CONNECTOR_KINDS } from "../bootstrap/plugins.js";
import { loadDeploymentConfig, resolveIdpAdapterConfig } from "../config/loader.js";
import { AUDIT_SINK_STDOUT, type DeploymentConfig } from "../config/schema.js";
import { DeploymentConfigError } from "../config/validate.js";
import { acceptsAnyClient, KeycloakIdpAdapter, type IntrospectionCheck } from "../idp/keycloak.js";
import { IdpError } from "../idp/types.js";
import { GatewayError } from "../proxy/types.js";

export const CLI_USAGE = `usage: kp-gateway <command> [--config <deployment.yaml>] [--port <n>] [--host <addr>]
       kp-gateway auth-check --config <deployment.yaml> --token-env <VAR>

commands:
  serve       start the gateway (MCP Streamable HTTP) until SIGINT / SIGTERM
  validate    load the config and assemble the gateway without listening;
              list every problem found
  auth-check  introspect the session token held in environment variable <VAR> once
              (idp.adapter.kind: keycloak only) and print pass / fail / skipped for
              each check (active, iss, typ, azp, aud) plus the userId; the token is
              never printed. exit 0 when every check passes, 1 otherwise

options:
  -c, --config <path>  deployment.yaml (default: $KP_DEPLOYMENT_CONFIG)
      --port <n>       listen on this port instead of gateway.http.port (1-65535)
      --host <addr>    listen on this address instead of gateway.http.host; a non-loopback
                       address still requires gateway.http.confirmExposedHost: true
      --token-env <VAR> (auth-check) name of the environment variable holding the token
  -h, --help           show this help

exit codes: 0 ok, 1 configuration or runtime error, 2 usage error`;

/** deployment.yaml の gateway.http を上書きする待ち受けの指定(--host / --port)。 */
export interface ListenOverrides {
  readonly host?: string;
  readonly port?: number;
}

export type CliCommand =
  | { readonly kind: "help" }
  | ({ readonly kind: "serve" | "validate"; readonly configPath: string } & ListenOverrides)
  | { readonly kind: "auth-check"; readonly configPath: string; readonly tokenEnv: string }
  | { readonly kind: "usage_error"; readonly message: string };

/** 環境変数名の形式(--token-env。値ではなく名前を受ける)。 */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** --port の値(1〜65535 の整数。gateway.http.port のスキーマと同じ範囲)。 */
function parsePort(value: string): number | undefined {
  if (!/^\d{1,5}$/.test(value)) {
    return undefined;
  }
  const port = Number(value);
  return port >= 1 && port <= 65_535 ? port : undefined;
}

type Env = Readonly<Record<string, string | undefined>>;

/** 引数を解析する(node:util の parseArgs。未知のオプションは使い方の誤り)。 */
export function parseCliArgs(
  argv: readonly string[],
  env: Env = process.env,
): CliCommand {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        config: { type: "string", short: "c" },
        port: { type: "string" },
        host: { type: "string" },
        "token-env": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return {
      kind: "usage_error",
      message: error instanceof Error ? error.message : "invalid arguments",
    };
  }
  const [command, ...extra] = parsed.positionals;
  if (parsed.values.help === true || command === "help") {
    return { kind: "help" };
  }
  if (command === undefined) {
    return { kind: "usage_error", message: "a command is required" };
  }
  if (command !== "serve" && command !== "validate" && command !== "auth-check") {
    return { kind: "usage_error", message: `unknown command: ${command}` };
  }
  if (extra.length > 0) {
    return { kind: "usage_error", message: `unexpected argument: ${extra[0]}` };
  }
  const configPath = parsed.values.config ?? env["KP_DEPLOYMENT_CONFIG"];
  if (!configPath) {
    return {
      kind: "usage_error",
      message: "--config <path> is required (or set KP_DEPLOYMENT_CONFIG)",
    };
  }
  if (command === "auth-check") {
    if (parsed.values.port !== undefined || parsed.values.host !== undefined) {
      return { kind: "usage_error", message: "auth-check does not take --port / --host" };
    }
    const tokenEnv = parsed.values["token-env"];
    if (tokenEnv === undefined || !ENV_VAR_NAME.test(tokenEnv)) {
      return {
        kind: "usage_error",
        message: "--token-env <VAR> is required and must be an environment variable NAME",
      };
    }
    return { kind: "auth-check", configPath, tokenEnv };
  }
  if (parsed.values["token-env"] !== undefined) {
    return { kind: "usage_error", message: "--token-env applies to auth-check only" };
  }
  let port: number | undefined;
  if (parsed.values.port !== undefined) {
    port = parsePort(parsed.values.port);
    if (port === undefined) {
      return { kind: "usage_error", message: "--port must be an integer between 1 and 65535" };
    }
  }
  const host = parsed.values.host;
  if (host !== undefined && !/^\S+$/.test(host)) {
    return { kind: "usage_error", message: "--host must be a host name or an IP address" };
  }
  return {
    kind: command,
    configPath,
    ...(host !== undefined ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
  };
}

/**
 * --host / --port を deployment.yaml の gateway.http に上書きした設定を返す。公開境界の検査
 * (assembleGateway の validateGatewayHttpExposure)は上書き後の host に対して行われる
 * (confirmExposedHost は deployment.yaml の値のまま。フラグで検査を迂回させない)。
 */
export function withListenOverrides(
  config: DeploymentConfig,
  overrides: ListenOverrides,
): DeploymentConfig {
  if (overrides.host === undefined && overrides.port === undefined) {
    return config;
  }
  return {
    ...config,
    gateway: {
      ...config.gateway,
      http: {
        ...config.gateway.http,
        ...(overrides.host !== undefined ? { host: overrides.host } : {}),
        ...(overrides.port !== undefined ? { port: overrides.port } : {}),
      },
    },
  };
}

export interface CliIo {
  /** 1行を標準出力へ */
  stdout(line: string): void;
  /** 1行を標準エラー出力へ */
  stderr(line: string): void;
}

export interface CliDeps extends CliIo {
  /** 環境変数(既定 process.env) */
  readonly env?: Env;
  /** serve の停止合図(既定 SIGINT / SIGTERM)。解決値はログ用の理由 */
  readonly waitForShutdown?: () => Promise<string>;
  /** auth-check のイントロスペクション呼び出しに使う fetch(テスト用注入。既定 globalThis.fetch) */
  readonly fetchImpl?: typeof fetch;
}

/** 最初の SIGINT / SIGTERM を待つ(2回目は既定動作=即時終了に任せる)。 */
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

/**
 * 例外をログ用の1行に写す。各層の規約で秘密情報を含まない正規化エラー
 * (GatewayError / IdpError)はメッセージを出し、Node のシステムエラーは
 * エラーコードだけ、それ以外は種別名だけを出す。
 */
function describeError(error: unknown): string {
  if (error instanceof GatewayError || error instanceof IdpError) {
    return `${error.errorClass}: ${error.message}`;
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string") {
    return code;
  }
  return `unexpected error (${error instanceof Error ? error.name : typeof error})`;
}

function reportError(io: CliIo, context: string, error: unknown): void {
  if (error instanceof DeploymentConfigError) {
    io.stderr(`kp-gateway: ${context}: ${error.issues.length} issue(s)`);
    for (const issue of error.issues) {
      io.stderr(`  - [${issue.code}] ${issue.path}: ${issue.message}`);
    }
    return;
  }
  io.stderr(`kp-gateway: ${context}: ${describeError(error)}`);
}

function endpointUrl(config: DeploymentConfig, path: string): string {
  const { host, port } = config.gateway.http;
  const hostPart = host.includes(":") ? `[${host}]` : host;
  return `http://${hostPart}:${port}${path}`;
}

/** 開発専用の部品(本番では起動時に拒否される)の一覧。 */
function devOnlyComponents(config: DeploymentConfig): string[] {
  const enabled = config.connectors.filter((c) => c.enabled);
  return [
    ...(config.idp.adapter.kind === "mock" ? ["idp adapter 'mock'"] : []),
    ...(enabled.some((c) => c.auth?.provider === "mock_env")
      ? ["credential provider 'mock_env'"]
      : []),
    ...[...new Set(enabled.map((c) => c.kind))]
      .filter((kind) => DEV_ONLY_CONNECTOR_KINDS.has(kind))
      .map((kind) => `connector kind '${kind}'`),
    ...(config.audit.sink === AUDIT_SINK_STDOUT ? ["audit sink 'stdout'"] : []),
    ...(config.idp.adapter.kind === "keycloak" && acceptsAnyClient(config.idp.adapter.allowedClients)
      ? ["idp.adapter.allowedClients '*' (azp check disabled)"]
      : []),
  ];
}

/** 起動・検証結果の要約(設定値のうち秘密でない識別子のみ)。 */
function summaryLines(
  config: DeploymentConfig,
  assembled: AssembledGateway,
  { withEndpoint }: { readonly withEndpoint: boolean },
): string[] {
  const sources = assembled.gateway.enabledSourceIds();
  return [
    `deployment: ${config.deployment.name}`,
    ...(withEndpoint
      ? [`endpoint: ${endpointUrl(config, config.gateway.http.path)}`]
      : []),
    `enabled sources: ${sources.length > 0 ? sources.join(", ") : "(none)"}`,
    `idp adapter: ${config.idp.adapter.kind}`,
    `audit sink: ${assembled.auditSinkDescription}`,
    `run api: ${assembled.runApiDescription}`,
  ];
}

function warnDevOnly(io: CliIo, config: DeploymentConfig): void {
  const components = devOnlyComponents(config);
  if (components.length > 0) {
    io.stderr(
      `kp-gateway: WARNING: development-only components in use (${components.join(", ")}); ` +
        "they are rejected when NODE_ENV=production",
    );
  }
}

/** 起動時の警告(assembleGateway の warnings。秘密情報なし)を stderr に出す。 */
function warnAssembly(io: CliIo, assembled: AssembledGateway): void {
  for (const warning of assembled.warnings) {
    io.stderr(`kp-gateway: WARNING: ${warning}`);
  }
}

async function loadAndAssemble(
  configPath: string,
  overrides: ListenOverrides,
  deps: CliDeps,
): Promise<
  | { readonly config: DeploymentConfig; readonly assembled: AssembledGateway }
  | undefined
> {
  const absolute = resolve(configPath);
  let config: DeploymentConfig;
  try {
    config = withListenOverrides(loadDeploymentConfig(absolute), overrides);
  } catch (error) {
    reportError(deps, `cannot load ${absolute}`, error);
    return undefined;
  }
  try {
    const assembled = await assembleGateway({
      config,
      env: deps.env ?? process.env,
      configDir: dirname(absolute),
      // 稼働中の警告(モック IdP のセッション表が空のままの拒否など)はサーバーログへ
      warn: (message) => deps.stderr(`kp-gateway: WARNING: ${message}`),
    });
    return { config, assembled };
  } catch (error) {
    reportError(deps, `deployment "${config.deployment.name}" rejected`, error);
    return undefined;
  }
}

async function validateCommand(
  configPath: string,
  overrides: ListenOverrides,
  deps: CliDeps,
): Promise<number> {
  const loaded = await loadAndAssemble(configPath, overrides, deps);
  if (loaded === undefined) {
    return 1;
  }
  const { config, assembled } = loaded;
  try {
    await assembled.close();
  } catch (error) {
    reportError(deps, "cleanup failed", error);
    return 1;
  }
  deps.stdout(`kp-gateway validate: OK (${resolve(configPath)})`);
  for (const line of summaryLines(config, assembled, { withEndpoint: true })) {
    deps.stdout(`  ${line}`);
  }
  warnDevOnly(deps, config);
  warnAssembly(deps, assembled);
  return 0;
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

/** EADDRINUSE のときの案内(待ち受けのポートの変え方)。 */
export function portInUseMessage(port: number): string {
  return (
    `kp-gateway: ポート ${port} は使用中です。--port <番号> か deployment.yaml の ` +
    "gateway.http.port で別のポートを指定してください"
  );
}

async function serveCommand(
  configPath: string,
  overrides: ListenOverrides,
  deps: CliDeps,
): Promise<number> {
  const loaded = await loadAndAssemble(configPath, overrides, deps);
  if (loaded === undefined) {
    return 1;
  }
  const { config, assembled } = loaded;
  const { host, port } = config.gateway.http;
  try {
    await listen(assembled.httpServer, port, host);
  } catch (error) {
    deps.stderr(`kp-gateway: cannot listen on ${host}:${port}: ${describeError(error)}`);
    if ((error as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE") {
      deps.stderr(portInUseMessage(port));
    }
    await assembled.close().catch(() => undefined);
    return 1;
  }
  assembled.httpServer.on("error", (error) => {
    deps.stderr(`kp-gateway: http server error: ${describeError(error)}`);
  });

  deps.stderr(
    `kp-gateway: listening on ${endpointUrl(config, config.gateway.http.path)} ` +
      `(health check: ${endpointUrl(config, "/healthz")})`,
  );
  for (const line of summaryLines(config, assembled, { withEndpoint: false })) {
    deps.stderr(`kp-gateway: ${line}`);
  }
  warnDevOnly(deps, config);
  warnAssembly(deps, assembled);

  const reason = await (deps.waitForShutdown ?? waitForTerminationSignal)();
  deps.stderr(`kp-gateway: ${reason} received, shutting down`);
  try {
    await assembled.close();
  } catch (error) {
    reportError(deps, "shutdown incomplete", error);
    return 1;
  }
  deps.stderr("kp-gateway: stopped");
  return 0;
}

/** auth-check の1行(列幅は固定。detail にトークン・sub は含まれない)。 */
function formatCheck(check: IntrospectionCheck): string {
  return `  ${check.name.padEnd(7)} ${check.status.padEnd(8)} ${check.detail}`;
}

/**
 * auth-check: 設定を読み、IdP(keycloak)のイントロスペクションを1回呼んで検証項目ごとの結果を出す。
 * コネクタの組み立て・listen はしない。トークンは環境変数から読み、出力に出さない。
 */
async function authCheckCommand(
  configPath: string,
  tokenEnv: string,
  deps: CliDeps,
): Promise<number> {
  const env = deps.env ?? process.env;
  const absolute = resolve(configPath);
  let config: DeploymentConfig;
  try {
    config = loadDeploymentConfig(absolute);
  } catch (error) {
    reportError(deps, `cannot load ${absolute}`, error);
    return 2;
  }
  if (config.idp.adapter.kind !== "keycloak") {
    deps.stderr(
      `kp-gateway: auth-check applies to idp.adapter.kind: keycloak only ` +
        `(this deployment uses '${config.idp.adapter.kind}')`,
    );
    return 2;
  }
  const token = env[tokenEnv];
  if (token === undefined || token === "") {
    deps.stderr(`kp-gateway: environment variable "${tokenEnv}" is not set or empty`);
    return 2;
  }
  let adapter: KeycloakIdpAdapter;
  try {
    const resolved = resolveIdpAdapterConfig(config.idp.adapter, env);
    if (resolved.kind !== "keycloak") {
      deps.stderr("kp-gateway: auth-check applies to idp.adapter.kind: keycloak only");
      return 2;
    }
    const { kind: _kind, ...keycloakConfig } = resolved;
    adapter = new KeycloakIdpAdapter(
      { ...keycloakConfig, ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}) },
      [],
    );
  } catch (error) {
    reportError(deps, `deployment "${config.deployment.name}" rejected`, error);
    return 2;
  }
  warnDevOnly(deps, config);

  let checks: readonly IntrospectionCheck[];
  let userId: string | undefined;
  try {
    const body = await adapter.introspect(token);
    checks = adapter.checkIntrospection(body);
    // sub は active の検証を通ったときだけ表示する(通らない応答の値は信用しない)
    if (checks.some((check) => check.name === "active" && check.status === "pass")) {
      userId = body.sub;
    }
  } catch (error) {
    deps.stderr(`kp-gateway: auth-check: ${describeError(error)}`);
    return 1;
  }
  const failed = checks.filter((check) => check.status === "fail").length;
  deps.stdout(`kp-gateway auth-check: ${absolute}`);
  deps.stdout(`  idp: keycloak realm "${config.idp.adapter.realm}" at ${config.idp.adapter.baseUrl}`);
  deps.stdout(`  ${"check".padEnd(7)} ${"result".padEnd(8)} detail`);
  for (const check of checks) {
    deps.stdout(formatCheck(check));
  }
  if (userId !== undefined) {
    deps.stdout(`  userId: ${userId}`);
  }
  deps.stdout(
    failed === 0
      ? "result: PASS (the token would be accepted by the gateway)"
      : `result: FAIL (${failed} check(s) failed; the gateway would answer 401)`,
  );
  return failed === 0 ? 0 : 1;
}

/** CLI本体。終了コードを返す(プロセスの終了は呼び出し側)。 */
export async function runCli(
  argv: readonly string[],
  deps: CliDeps,
): Promise<number> {
  const command = parseCliArgs(argv, deps.env ?? process.env);
  switch (command.kind) {
    case "help":
      deps.stdout(CLI_USAGE);
      return 0;
    case "usage_error":
      deps.stderr(`kp-gateway: ${command.message}`);
      deps.stderr(CLI_USAGE);
      return 2;
    case "validate":
      return validateCommand(command.configPath, command, deps);
    case "serve":
      return serveCommand(command.configPath, command, deps);
    case "auth-check":
      return authCheckCommand(command.configPath, command.tokenEnv, deps);
  }
}
