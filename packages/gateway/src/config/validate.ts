/**
 * Deployment Profileの静的検証(T-010)。
 *
 * zodスキーマが表現できない「危険設定」(認可バイパス・監査欠落・プライバシー
 * 既定の突破に相当する組合せ)を起動時に拒否する(ADR-005、threat-model 4-E)。
 * 検証は設定値と ConnectorCapabilities(コード側の静的宣言)のみを見る。
 * ソースAPIへの照会は行わない。
 */
import { BlockList, isIP } from "node:net";
import {
  privateScopeHandlingOf,
  type ConnectorCapabilities,
} from "@kp/connector-sdk";
import { AUDIT_SINK_JSONL, type DeploymentConfig } from "./schema.js";

/**
 * 検証エラーの機械可読コード。テストと運用ドキュメントが参照する。
 * 静的検証(本モジュール)・ローダー(loader.ts)に加え、起動コード
 * (bootstrap/)がコネクタ実体・資格情報・監査シンクの解決時に出すコードを含む。
 */
export type ConfigIssueCode =
  | "schema_violation"
  | "duplicate_connector_id"
  | "unknown_connector_id"
  | "search_layer_requires_ingest"
  | "search_layer_backend_missing"
  | "index_required_source_needs_search_layer"
  | "fail_open_requires_confirmation"
  | "private_scopes_included_requires_confirmation"
  /** privateScopes: consent は同意状態の設計(#42)まで受け付けない(ADR-016 追補2 決定6) */
  | "private_scopes_consent_not_supported"
  /**
   * 有効なコネクタの方針が excluded なのに、能力 privateScopeHandling が unsupported
   * (宣言なしの v0.3 プラグインを含む)。除外を強制できない(ADR-016 追補2 決定3)
   */
  | "private_scopes_unenforceable"
  | "agent_execution_not_allowed_in_phase1"
  | "secret_env_missing"
  /** audit.sink: jsonl に audit.jsonl.path がない(静的検証) */
  | "audit_sink_options_missing"
  // --- 以下は起動コード(bootstrap/)が出す ---
  /** audit.sink が起動コードの解決できない値(stdout / jsonl 以外) */
  | "unknown_audit_sink"
  /** 監査シンクの出力先が使えない(書き込めない、rawQueryPath が監査ログと同じ等) */
  | "audit_sink_options_invalid"
  /** コネクタ kind の実装が見つからない(プログラム登録・組み込み・プラグインのいずれにもない) */
  | "unknown_connector_kind"
  /** プラグインは読み込めたが factory を公開していない、または不正なコネクタを返した */
  | "connector_plugin_invalid"
  /** コネクタ固有設定(settings)を factory が拒否した */
  | "connector_settings_invalid"
  /** コネクタの factory がそれ以外の理由で失敗した */
  | "connector_factory_failed"
  /** 有効なコネクタに auth.provider がない(本人資格情報の取得方式が未指定) */
  | "connector_auth_provider_missing"
  /** IdP Adapter を構築できない(開発用モックのセッション定義の不備等) */
  | "idp_adapter_misconfigured"
  /**
   * 開発専用の部品(mock IdP / mock_env / dev-fixture / audit.sink: stdout /
   * keycloak の allowedClients: ["*"])を NODE_ENV=production で使おうとした
   * (stdout シンクは issue #17、ADR-011 追記。"*" は issue #16)
   */
  | "dev_only_in_production"
  /**
   * idp.adapter.baseUrl が平文 http: でループバック以外を指すのに
   * idp.adapter.confirmPlainHttp: true がない(validateIdpTransport、静的検証。issue #17)
   */
  | "idp_plain_http_requires_confirmation"
  /**
   * gateway.http.host がループバック以外なのに gateway.http.confirmExposedHost: true が
   * ない(validateGatewayHttpExposure。起動コードが待ち受けの前に検査する。T-012)
   */
  | "http_host_exposed_requires_confirmation";

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

    // privateScopes: consent の暫定拒否(ADR-016 追補2 決定6)。included の確認フラグと
    // 同じく無効化済みのコネクタでも宣言時点で拒否する。スキーマの列挙値は残し、
    // 解放は同意状態の持ち方の設計(#42)後にこの検証の緩和として行う
    if (connector.privateScopes === "consent") {
      issues.push({
        code: "private_scopes_consent_not_supported",
        path: `${base}.privateScopes`,
        message:
          `"consent" is not supported yet: per-user consent state is not designed (issue #42), ` +
          `so the policy would not reach the connector and private scopes would not be excluded ` +
          `(ADR-013 §1, ADR-016 addendum 2). Use "excluded" (default), or "included" with ` +
          `confirmPrivateScopesIncluded: true`,
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

    // 実体の登録とcapability連動の検証は有効なコネクタにのみ要求する(無効化
    // されたコネクタは経路が存在しないため危険設定になりえず、起動コードは
    // 実体を構築しない)
    if (!connector.enabled) {
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

    // 方針 excluded は、能力 privateScopeHandling が enforced / classified のコネクタで
    // だけ起動できる(ADR-016 追補2 決定3)。unsupported(宣言なしの v0.3 プラグインを
    // 含む)は結果に scope を付けないため、Gateway は全結果を private とみなして全件を
    // 落とすことになり、ソース側の除外も期待できない。included(確認フラグ付き)は
    // どの能力でも通す
    if (
      connector.privateScopes === "excluded" &&
      privateScopeHandlingOf(capabilities) === "unsupported"
    ) {
      issues.push({
        code: "private_scopes_unenforceable",
        path: `${base}.privateScopes`,
        message:
          `connector "${connector.id}" declares privateScopeHandling "unsupported" (or none, as in ` +
          `connector-sdk v0.3), so "excluded" cannot be enforced. Use a connector that declares ` +
          `"enforced" or "classified" (connector-sdk v0.4, ADR-016 addendum 2)`,
      });
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

  // audit.sink: jsonl は出力先の指定が必須(起動コードが JsonlAuditStore に解決する)
  if (config.audit.sink === AUDIT_SINK_JSONL && config.audit.jsonl === undefined) {
    issues.push({
      code: "audit_sink_options_missing",
      path: "audit.jsonl.path",
      message: `audit.sink "${AUDIT_SINK_JSONL}" requires audit.jsonl.path (the JSONL file to append audit records to)`,
    });
  }

  // IdP への平文 http はループバック以外で確認フラグ必須(issue #17)
  issues.push(...validateIdpTransport(config));

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

/** IPv6 のループバック(::1)と IPv4 射影アドレスの 127.0.0.0/8。 */
const IPV6_LOOPBACK = new BlockList();
IPV6_LOOPBACK.addAddress("::1", "ipv6");
IPV6_LOOPBACK.addSubnet("::ffff:127.0.0.0", 104, "ipv6");

/**
 * 待ち受けアドレスがループバックか(127.0.0.0/8、::1、IPv4 射影の 127.0.0.0/8、
 * localhost)。名前解決はしない: localhost 以外のホスト名・省略形の IPv4(127.1 等)は
 * 非ループバックとして扱う(確認を要求する安全側に倒す)。
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "localhost") {
    return true;
  }
  switch (isIP(normalized)) {
    case 4:
      return normalized.split(".")[0] === "127";
    case 6:
      return IPV6_LOOPBACK.check(normalized, "ipv6");
    default:
      return false;
  }
}

/**
 * IdP への平文 http の確認(issue #17)。イントロスペクション(RFC 7662)の往復には
 * Gateway の clientSecret と利用者のセッショントークンが載る。baseUrl が平文 http: で
 * ループバック以外(内部網のホスト名等)を指す構成は、経路が閉じた網であることを
 * idp.adapter.confirmPlainHttp: true で明示させる(gateway.http.confirmExposedHost と
 * 同じ規約)。https: は無条件に通す。URL として解析できない値はここでは扱わない
 * (IdP Adapter の構築・呼び出しで失敗する)。設定値だけで判定できるため静的検証に置く。
 */
export function validateIdpTransport(config: DeploymentConfig): ConfigIssue[] {
  const adapter = config.idp.adapter;
  if (adapter.kind !== "keycloak") {
    return [];
  }
  let url: URL;
  try {
    url = new URL(adapter.baseUrl);
  } catch {
    return [];
  }
  if (url.protocol !== "http:") {
    return [];
  }
  // URL.hostname は IPv6 を [..] で囲む
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (isLoopbackHost(host) || adapter.confirmPlainHttp === true) {
    return [];
  }
  return [
    {
      code: "idp_plain_http_requires_confirmation",
      path: "idp.adapter.baseUrl",
      message:
        `plain http to "${host}" sends the client secret and session tokens unencrypted. ` +
        `Use https, or set idp.adapter.confirmPlainHttp: true only when the path to the IdP ` +
        `is a closed network (docs/install.md)`,
    },
  ];
}

/**
 * ループバック以外で待ち受ける構成の確認(T-003 レビュー minor-11、T-012)。
 * Gateway は TLS を終端せず、Origin / Host ヘッダの検証(DNS rebinding 対策)も
 * しない。0.0.0.0 等で待ち受けると、Bearer セッショントークンと検索結果が平文で
 * ネットワークに出うるため、TLS 終端のリバースプロキシを前段に置く前提を
 * gateway.http.confirmExposedHost: true で明示させる。
 *
 * 待ち受けの有無に関わる検査のため、静的検証(validateDeploymentConfig)ではなく
 * 起動コード(bootstrap/assemble.ts の assembleGateway。kp-gateway serve / validate)が
 * 適用する(待ち受けないツール用途の設定解析は妨げない)。
 */
export function validateGatewayHttpExposure(config: DeploymentConfig): ConfigIssue[] {
  const { host, confirmExposedHost } = config.gateway.http;
  if (isLoopbackHost(host) || confirmExposedHost === true) {
    return [];
  }
  return [
    {
      code: "http_host_exposed_requires_confirmation",
      path: "gateway.http.host",
      message:
        `"${host}" listens beyond loopback, but the gateway neither terminates TLS nor ` +
        `validates Origin/Host headers. Put a TLS-terminating reverse proxy in front and set ` +
        `gateway.http.confirmExposedHost: true (docs/install.md)`,
    },
  ];
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
