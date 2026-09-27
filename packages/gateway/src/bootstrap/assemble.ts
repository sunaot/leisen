/**
 * Gatewayの組み立て(起動コード。kp-gateway CLI と リファレンスデプロイ T-012 が使う)。
 *
 * 検証済みの DeploymentConfig から、コネクタ実体(plugins.ts)→ 本人資格情報の
 * プロバイダ → IdP Adapter → 監査シンク(audit.ts)→ Gateway → HTTPサーバーを
 * 組み立てる。待ち受け(listen)は呼び出し側(kp-gateway serve)が
 * config.gateway.http.host / port で行う。
 *
 * - 起動時の拒否は DeploymentConfigError に集約し、組み立ての各段の不備を
 *   できるだけまとめて返す(kp-gateway validate が全件を列挙できるように)。
 *   capability 連動の検証は Gateway のコンストラクタが行う
 * - 無効化されたコネクタ(enabled: false)は構築しない(経路を作らない)
 * - 有効なコネクタには本人資格情報の取得方式(auth.provider)を必須とする
 *   (connector_auth_provider_missing)。サービスアカウント等への暗黙の代替はない
 *   (不変条件1)
 * - 開発専用の部品(mock IdP / mock_env / dev-fixture)は NODE_ENV=production で
 *   拒否する(dev_only_in_production)。判定は既存の assertNotProduction を経由し、
 *   各部品のコンストラクタの検査は二重の防御として残る
 * - 環境変数は options.env から読む(秘密情報・開発用モックの注入元)。本番判定の
 *   NODE_ENV だけは安全側に倒すためプロセスの環境(process.env)を見る
 * - 秘密情報(トークン・clientSecret・環境変数の値)と設定オブジェクト全体を
 *   ログ・エラーに出さない(不変条件6)
 */
import type { Server as HttpServer } from "node:http";
import { resolve } from "node:path";
import type { Connector } from "@kp/connector-sdk";
import type { RawQueryStore } from "../audit/rawquery.js";
import { AuditLogger } from "../audit/sink.js";
import { resolveIdpAdapterConfig } from "../config/loader.js";
import type {
  ConnectorAuthConfig,
  DeploymentConfig,
} from "../config/schema.js";
import {
  DeploymentConfigError,
  type ConfigIssue,
} from "../config/validate.js";
import { createIdpAdapter } from "../idp/factory.js";
import {
  assertNotProduction,
  MockCredentialProvider,
  parseMockSessions,
} from "../idp/mock.js";
import {
  IdpError,
  type CredentialProvider,
  type IdpAdapter,
} from "../idp/types.js";
import { Gateway } from "../proxy/gateway.js";
import { createGatewayHttpServer } from "../proxy/http.js";
import { GatewayError } from "../proxy/types.js";
import { resolveAuditSink, type ResolvedAuditSink } from "./audit.js";
import {
  buildConnector,
  defaultModuleLoader,
  DEV_ONLY_CONNECTOR_KINDS,
  resolveConnectorFactory,
  type ConnectorFactory,
  type ModuleLoader,
  type ResolvedConnectorFactory,
} from "./plugins.js";

/** 停止時に処理中のリクエストの完了を待つ上限(ms)。超えたら接続を切る。 */
export const SHUTDOWN_GRACE_MS = 10_000;

export interface AssembleGatewayOptions {
  /** 検証済みの設定(loadDeploymentConfig / parseDeploymentConfig の結果) */
  readonly config: DeploymentConfig;
  /**
   * 環境変数(IdP の clientSecretEnv、開発用モックの KP_MOCK_SESSIONS /
   * KP_MOCK_TOKEN_<SOURCEID>)。既定 process.env
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * 設定ファイルの所在ディレクトリ。設定内の相対パス(connectors[].module、
   * settings 内のパス、audit.jsonl.*)の基準。既定はカレントディレクトリ
   */
  readonly configDir?: string;
  /** kind → factory のプログラム登録(組み込み・プラグインより優先する) */
  readonly connectorFactories?: Readonly<Record<string, ConnectorFactory>>;
  /** プラグインの読み込み(既定は動的 import) */
  readonly loadModule?: ModuleLoader;
}

export interface AssembledGateway {
  readonly gateway: Gateway;
  readonly auditLogger: AuditLogger;
  readonly rawQueryStore: RawQueryStore;
  /** 未 listen の http.Server(listen は呼び出し側) */
  readonly httpServer: HttpServer;
  /** 起動ログ用の監査シンクの説明(秘密情報なし) */
  readonly auditSinkDescription: string;
  /** HTTPサーバーを閉じ(処理中のリクエストは完了を待つ)、監査バッファを flush する */
  close(): Promise<void>;
}

/**
 * 開発専用の部品の本番拒否。既存の assertNotProduction の判定をそのまま使い、
 * 拒否を設定の不備として記録する。拒否したら true。
 */
function rejectDevOnlyInProduction(
  issues: ConfigIssue[],
  path: string,
  what: string,
): boolean {
  try {
    assertNotProduction(what);
    return false;
  } catch (error) {
    issues.push({
      code: "dev_only_in_production",
      path,
      message:
        error instanceof IdpError
          ? error.message
          : `${what} is disabled in production builds`,
    });
    return true;
  }
}

/** 本人資格情報のプロバイダ(ADR-010 のソース別 Auth Adapter)。T-004 で方式を追加する。 */
function createCredentialProvider(
  sourceId: string,
  auth: ConnectorAuthConfig,
  env: Readonly<Record<string, string | undefined>>,
): CredentialProvider {
  switch (auth.provider) {
    case "mock_env":
      return new MockCredentialProvider(sourceId, { env });
  }
}

function collect(issues: ConfigIssue[], error: unknown): void {
  if (error instanceof DeploymentConfigError) {
    issues.push(...error.issues);
    return;
  }
  throw error;
}

async function stopHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolveClose, reject) => {
    const timer = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
    timer.unref();
    server.close((error) => {
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolveClose();
      }
    });
    server.closeIdleConnections();
  });
}

/**
 * 設定から Gateway 一式を組み立てる(listen しない)。不備は DeploymentConfigError
 * (issues に全件)。
 */
export async function assembleGateway(
  options: AssembleGatewayOptions,
): Promise<AssembledGateway> {
  const { config } = options;
  const env = options.env ?? process.env;
  const configDir = resolve(options.configDir ?? process.cwd());
  const registered = options.connectorFactories ?? {};
  const loadModule = options.loadModule ?? defaultModuleLoader;
  const issues: ConfigIssue[] = [];

  const idpRejected =
    config.idp.adapter.kind === "mock" &&
    rejectDevOnlyInProduction(issues, "idp.adapter.kind", "idp adapter kind 'mock'");

  // --- コネクタ実体と本人資格情報のプロバイダ(有効なコネクタのみ) ---
  const connectors: Connector[] = [];
  const providers: CredentialProvider[] = [];
  for (const [index, connector] of config.connectors.entries()) {
    if (!connector.enabled) {
      continue;
    }
    const base = `connectors[${index}]`;

    let providerRejected = false;
    if (connector.auth === undefined) {
      issues.push({
        code: "connector_auth_provider_missing",
        path: `${base}.auth.provider`,
        message:
          `enabled connector "${connector.id}" must declare auth.provider ` +
          `(how the caller's own credential for this source is obtained, ADR-010)`,
      });
      providerRejected = true;
    } else if (connector.auth.provider === "mock_env") {
      providerRejected = rejectDevOnlyInProduction(
        issues,
        `${base}.auth.provider`,
        "credential provider 'mock_env'",
      );
    }

    let resolvedFactory: ResolvedConnectorFactory;
    try {
      resolvedFactory = await resolveConnectorFactory(connector, index, {
        registered,
        configDir,
        loadModule,
      });
    } catch (error) {
      collect(issues, error);
      continue;
    }
    const connectorRejected =
      resolvedFactory.origin === "builtin" &&
      DEV_ONLY_CONNECTOR_KINDS.has(connector.kind) &&
      rejectDevOnlyInProduction(issues, `${base}.kind`, `connector kind '${connector.kind}'`);

    if (!connectorRejected) {
      const built = await buildConnector(
        connector,
        index,
        resolvedFactory.factory,
        configDir,
      );
      if (built.ok) {
        connectors.push(built.connector);
      } else {
        issues.push(...built.issues);
      }
    }
    if (!providerRejected && connector.auth !== undefined) {
      try {
        providers.push(createCredentialProvider(connector.id, connector.auth, env));
      } catch (error) {
        issues.push({
          code: "idp_adapter_misconfigured",
          path: `${base}.auth.provider`,
          message:
            error instanceof IdpError
              ? error.message
              : `credential provider "${connector.auth.provider}" could not be created`,
        });
      }
    }
  }

  // --- IdP Adapter ---
  let idpAdapter: IdpAdapter | undefined;
  if (!idpRejected) {
    try {
      const resolved = resolveIdpAdapterConfig(config.idp.adapter, env);
      idpAdapter = createIdpAdapter(
        resolved.kind === "mock"
          ? { ...resolved, sessions: parseMockSessions(env["KP_MOCK_SESSIONS"]) }
          : resolved,
        { providers },
      );
    } catch (error) {
      if (error instanceof IdpError) {
        issues.push({
          code: "idp_adapter_misconfigured",
          path: "idp.adapter",
          message: error.message,
        });
      } else {
        collect(issues, error);
      }
    }
  }

  // --- 監査シンク ---
  let audit: ResolvedAuditSink | undefined;
  try {
    audit = await resolveAuditSink(config.audit, configDir);
  } catch (error) {
    collect(issues, error);
  }

  if (issues.length > 0 || idpAdapter === undefined || audit === undefined) {
    throw new DeploymentConfigError(issues);
  }

  // --- Gateway(capability 連動の設定検証はコンストラクタが行う)と HTTP ---
  const auditLogger = new AuditLogger(audit.sink);
  const gateway = new Gateway({
    config,
    idpAdapter,
    connectors,
    auditLogger,
    rawQueryStore: audit.rawQueryStore,
  });
  const httpServer = createGatewayHttpServer(gateway, {
    path: config.gateway.http.path,
  });

  let closing: Promise<void> | undefined;
  return {
    gateway,
    auditLogger,
    rawQueryStore: audit.rawQueryStore,
    httpServer,
    auditSinkDescription: audit.description,
    close: () =>
      (closing ??= (async () => {
        await stopHttpServer(httpServer);
        // BufferedAuditSink の未永続レコードを書き切る。書けなければ例外
        // (停止時の監査欠落に気づけるようにする、TM-F2)。書き込み先の生の
        // 例外文言は載せず、エラーコードだけを残す
        try {
          await auditLogger.flush();
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | undefined)?.code;
          throw new GatewayError(
            "audit_write_failed",
            `audit records could not be flushed at shutdown${typeof code === "string" ? ` (${code})` : ""}`,
          );
        }
      })()),
  };
}
