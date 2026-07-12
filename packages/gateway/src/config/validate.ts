/**
 * Deployment Profileの静的検証(T-010)。
 *
 * zodスキーマが表現できない「危険設定」(認可バイパス・監査欠落・プライバシー
 * 既定の突破に相当する組合せ)を起動時に拒否する(ADR-005、threat-model 4-E)。
 * 検証は設定値と ConnectorCapabilities(コード側の静的宣言)のみを見る。
 * ソースAPIへの照会は行わない。
 */
import type { ConnectorCapabilities } from "@kp/connector-sdk";
import type { DeploymentConfig } from "./schema.js";

/** 検証エラーの機械可読コード。テストと運用ドキュメントが参照する。 */
export type ConfigIssueCode =
  | "schema_violation"
  | "duplicate_connector_id"
  | "unknown_connector_id"
  | "search_layer_requires_ingest"
  | "search_layer_backend_missing"
  | "index_required_source_needs_search_layer"
  | "fail_open_requires_confirmation"
  | "private_scopes_included_requires_confirmation"
  | "agent_execution_not_allowed_in_phase1"
  | "secret_env_missing";

export interface ConfigIssue {
  code: ConfigIssueCode;
  /** 設定ファイル内の位置(例: "connectors[0].searchLayer.enabled") */
  path: string;
  message: string;
}

/**
 * 設定不備で起動を拒否するときの例外。issuesに全件を集約する(1件目で
 * 打ち切らない: 導入支援エンジニアが1回の起動失敗で全不備を把握できるように)。
 * スキーマ(schema.ts)は秘密情報のフィールドを持たないため、message に
 * 設定値が含まれてもログ出力可能。
 */
export class DeploymentConfigError extends Error {
  constructor(public readonly issues: readonly ConfigIssue[]) {
    super(
      `deployment config rejected (${issues.length} issue(s)):\n` +
        issues.map((i) => `- [${i.code}] ${i.path}: ${i.message}`).join("\n"),
    );
    this.name = "DeploymentConfigError";
  }
}

export interface ValidateOptions {
  /**
   * sourceId → コネクタの静的能力。Gateway組み立て時に登録済みコネクタから
   * 渡す。省略時はcapability連動の検証(ingest / nativeSearch)をスキップする
   * (スキーマ策定時など、コネクタ実体がない文脈での検証用)。
   */
  capabilities?: Readonly<Record<string, ConnectorCapabilities>>;
}

/**
 * 危険設定の検出。空配列=妥当。起動パスでは assertValidDeploymentConfig を使う。
 */
export function validateDeploymentConfig(
  config: DeploymentConfig,
  options: ValidateOptions = {},
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const seenIds = new Set<string>();

  config.connectors.forEach((connector, index) => {
    const base = `connectors[${index}]`;

    if (seenIds.has(connector.id)) {
      issues.push({
        code: "duplicate_connector_id",
        path: `${base}.id`,
        message: `connector id "${connector.id}" is declared more than once`,
      });
    }
    seenIds.add(connector.id);

    // privateScopes: included は確認フラグ必須(ADR-013 §1、TM-E4)。
    // 無効化済みコネクタでも拒否する(後で enabled: true に変えた瞬間に
    // 危険設定が発現しないように、宣言時点で確認を要求する)
    if (
      connector.privateScopes === "included" &&
      !connector.confirmPrivateScopesIncluded
    ) {
      issues.push({
        code: "private_scopes_included_requires_confirmation",
        path: `${base}.privateScopes`,
        message:
          `"included" exposes private scopes (DMs, private channels) to search. ` +
          `Set confirmPrivateScopesIncluded: true only after completing the usage-policy ` +
          `checklist (ADR-013 §1)`,
      });
    }

    // backend欠落もprivateScopes同様「宣言時拒否」とする(enabled: falseでも
    // 拒否)。無効化中に仕込まれた不完全な宣言が、有効化した瞬間に危険設定と
    // して発現することを防ぐ
    if (connector.searchLayer.enabled && connector.searchLayer.backend === undefined) {
      issues.push({
        code: "search_layer_backend_missing",
        path: `${base}.searchLayer.backend`,
        message: "searchLayer.enabled requires a backend plugin identifier",
      });
    }

    if (!options.capabilities) {
      return;
    }

    const capabilities = options.capabilities[connector.id];
    if (capabilities === undefined) {
      issues.push({
        code: "unknown_connector_id",
        path: `${base}.id`,
        message: `connector "${connector.id}" is not registered in this deployment`,
      });
      return;
    }

    // capability連動の検証は有効なコネクタにのみ適用する(無効化された
    // コネクタは経路が存在しないため危険設定になりえない)
    if (!connector.enabled) {
      return;
    }

    // 検索層はingest実装コネクタのみ有効化できる(ADR-007)。ingestなしでの
    // 有効化はインデックスが構築できず、検証しない場合は空振り/未定義動作になる
    if (connector.searchLayer.enabled && !capabilities.ingest) {
      issues.push({
        code: "search_layer_requires_ingest",
        path: `${base}.searchLayer.enabled`,
        message: `connector "${connector.id}" does not implement the ingest capability`,
      });
    }

    // TM-E7(Slack由来データの永続化)への注記: 現時点ではSlack系コネクタは
    // ingest: false を宣言する前提のため、searchLayer有効化(=中央インデックス化
    // =永続化)は上の search_layer_requires_ingest で間接的に拒否される。
    // Slackコネクタ実装(T-006)で contentPersistence 系のcapabilityが確定したら
    // (ADR-014/016)、capability宣言に依存しない名指しの構造的拒否をここに追加する

    // index-requiredクラス(nativeSearch: "none")は検索層とセットでのみ導入可
    // (ADR-007: ネイティブ検索のベースラインが存在せず、検索層OFFでは機能しない)
    if (capabilities.nativeSearch === "none" && !connector.searchLayer.enabled) {
      issues.push({
        code: "index_required_source_needs_search_layer",
        path: `${base}.searchLayer.enabled`,
        message:
          `connector "${connector.id}" has no native search (index-required); ` +
          `it can only be deployed with searchLayer.enabled: true (ADR-007)`,
      });
    }
  });

  // fail-open は監査欠落を許容する運用判断であり、確認フラグと
  // セキュリティポリシー明文化を要求する(ADR-011 §4、TM-E2)
  if (config.audit.failureMode === "fail-open" && !config.audit.confirmFailOpen) {
    issues.push({
      code: "fail_open_requires_confirmation",
      path: "audit.failureMode",
      message:
        `"fail-open" allows tool calls to proceed without an audit record. ` +
        `Set confirmFailOpen: true only after documenting this in the security policy (ADR-011)`,
    });
  }

  // Phase 1では human-in-the-loop のみ許可(ADR-015)。解放は区分設定の
  // semanticsと本人同意の実装後に、このガードの緩和として行う
  for (const cls of ["scheduled", "autonomous"] as const) {
    if (config.agentExecution[cls].enabled) {
      issues.push({
        code: "agent_execution_not_allowed_in_phase1",
        path: `agentExecution.${cls}.enabled`,
        message: `execution class "${cls}" is rejected by default in Phase 1 (ADR-015)`,
      });
    }
  }

  return issues;
}

/** 起動パス用: 不備が1件でもあれば DeploymentConfigError を投げる。 */
export function assertValidDeploymentConfig(
  config: DeploymentConfig,
  options: ValidateOptions = {},
): void {
  const issues = validateDeploymentConfig(config, options);
  if (issues.length > 0) {
    throw new DeploymentConfigError(issues);
  }
}
