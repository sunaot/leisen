/**
 * Gateway組み立て(T-012)。
 *
 * deployment.yaml 1枚と環境変数(秘密情報)からGateway実体を構築する、
 * リファレンスデプロイの起動パス。個社差分はこの組み立てへの注入物
 * (Connector / CredentialProvider / AuditSink)としてのみ現れ、コアの
 * 分岐にはならない(ADR-005、不変条件8)。
 *
 * 監査シンクの解決: deployment.yaml の audit.sink(自由文字列)を実体へ
 * 解決するのはこの層の責務(config/schema.ts参照)。未登録のシンクIDは
 * 起動時拒否する — 「監査が書けない構成」を黙って起動させない(ADR-011)。
 */
import type { Connector, ConnectorCapabilities } from "@kp/connector-sdk";
import { AuditLogger, StdoutDebugAuditSink, type AuditSink } from "../audit/sink.js";
import { loadDeploymentConfig, resolveIdpAdapterConfig } from "../config/loader.js";
import type { DeploymentConfig } from "../config/schema.js";
import { DeploymentConfigError } from "../config/validate.js";
import { createIdpAdapter } from "../idp/factory.js";
import type { CredentialProvider } from "../idp/types.js";
import { Gateway } from "../proxy/gateway.js";

export type AuditSinkFactory = () => AuditSink;

/**
 * ビルトインの監査シンク。"stdout" は開発・検証用(at-least-once非保証、
 * sink.ts参照)。本番導入は BufferedAuditSink + 導入先ストアの
 * AuditStoreWriter をここに登録して差し替える(docs/install.md)。
 */
export const BUILTIN_AUDIT_SINKS: Readonly<Record<string, AuditSinkFactory>> = {
  stdout: () => new StdoutDebugAuditSink(),
};

export interface AssembleGatewayOptions {
  /** deployment.yaml のパス */
  configPath: string;
  /** このデプロイに組み込むコネクタ実体(config.connectors[].id と突合) */
  connectors?: readonly Connector[];
  /** ソース別の資格情報プロバイダ(IdP Adapterへ渡す) */
  providers?: readonly CredentialProvider[];
  /** 監査シンクの登録簿。省略時はビルトインのみ */
  auditSinks?: Readonly<Record<string, AuditSinkFactory>>;
  /** 秘密情報の解決元(テスト用注入)。省略時は process.env */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface AssembledGateway {
  gateway: Gateway;
  config: DeploymentConfig;
  auditLogger: AuditLogger;
  /** shutdown時に監査バッファを永続化しきる(TM-F2)。失敗は例外 */
  shutdown(): Promise<void>;
}

export function assembleGateway(
  options: AssembleGatewayOptions,
): AssembledGateway {
  const connectors = options.connectors ?? [];
  const capabilities: Record<string, ConnectorCapabilities> = {};
  for (const connector of connectors) {
    capabilities[connector.sourceId] = connector.capabilities;
  }

  // 危険設定は起動時拒否(ADR-005)。capabilitiesを渡して連動検証を効かせる
  const config = loadDeploymentConfig(options.configPath, { capabilities });

  const sinks = options.auditSinks ?? BUILTIN_AUDIT_SINKS;
  const sinkFactory = sinks[config.audit.sink];
  if (sinkFactory === undefined) {
    throw new DeploymentConfigError([
      {
        code: "unknown_audit_sink",
        path: "audit.sink",
        message:
          `audit sink "${config.audit.sink}" is not registered in this build ` +
          `(available: ${Object.keys(sinks).join(", ")})`,
      },
    ]);
  }
  const auditLogger = new AuditLogger(sinkFactory());

  const idpAdapter = createIdpAdapter(
    // 秘密情報(clientSecret)はここで初めて環境変数から解決される。
    // 戻り値をログ・エラーに載せない(不変条件6)
    resolveIdpAdapterConfig(config.idp.adapter, options.env),
    { providers: options.providers ?? [] },
  );

  const gateway = new Gateway({ config, idpAdapter, connectors, auditLogger });
  return {
    gateway,
    config,
    auditLogger,
    shutdown: () => auditLogger.flush(),
  };
}
