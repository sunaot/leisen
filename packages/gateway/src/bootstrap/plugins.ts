/**
 * コネクタ実装の解決(起動コード。ADR-005 の Connector プラグイン境界)。
 *
 * deployment.yaml の connectors[] を Connector 実体にする契約:
 *
 *   type ConnectorFactory =
 *     (init: { sourceId; settings; configDir; policy }) => Connector | Promise<Connector>
 *
 * 解決順(キーは connectors[].kind。省略時は id):
 * 1. プログラム登録(assembleGateway の connectorFactories[kind])
 * 2. 組み込み(dev-fixture。開発専用で、本番では起動時に拒否する。module との
 *    併用は拒否する)
 * 3. プラグイン: 動的 import(connectors[].module ?? `@kp/connector-<kind>`)の
 *    名前付き export `createConnector`。なければ default export(関数の場合)
 * いずれにも見つからなければ unknown_connector_kind で起動を拒否する。
 *
 * module は設定から任意のコードを読み込む経路である(プラグイン境界そのもの)。
 * deployment.yaml とプラグインの置き場所の書き込み権限は導入先の管理者に限ること。
 *
 * プラグイン(コネクタパッケージ)への要求:
 * - connector-sdk の Connector を返す factory を `createConnector` として export する。
 *   コネクタは connector-sdk にのみ依存し、@kp/gateway には依存しない
 * - 返す Connector の sourceId は init.sourceId と一致させる
 * - settings は秘密でない設定で、factory 自身が検証する。不備は zod の parse が
 *   投げる ZodError、または ConnectorError("invalid_request", 値を含めない文言)で
 *   報告する(→ connector_settings_invalid)。秘密情報は settings に置かず、
 *   `<name>Env` に書かれた環境変数名から factory が読む
 * - settings 内の相対パスは init.configDir(設定ファイルの所在ディレクトリ)基準で解決する
 * - factory の中でソースAPIを呼ばない(利用者本人の資格情報がない時点のため。
 *   サービスアカウントでの代替は不変条件1に反する)
 * - init.policy(connector-sdk の SourcePolicy。deployment.yaml の privateScopes)に
 *   従い、capabilities.privateScopeHandling を宣言する。全結果(SearchHit / FetchResult /
 *   ContainerEntry)に scope を付ける(ADR-016 追補2 決定1〜3)。宣言のないプラグイン
 *   (v0.3)は unsupported とみなされ、excluded の方針では起動を拒否される
 *
 * factory の契約(方針の受け取りと能力の宣言)もコネクタ IF(connector-sdk v0.4)の
 * 一部である(ADR-016 追補2、不変条件5)。ConnectorFactoryInit は connector-sdk に
 * 移さず、ここと各コネクタパッケージに同じ形で定義している(移設は #33 で決める)。
 */
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ConnectorError,
  type Connector,
  type SourcePolicy,
} from "@kp/connector-sdk";
import {
  CONNECTOR_KIND_PATTERN,
  type ConnectorConfig,
} from "../config/schema.js";
import {
  DeploymentConfigError,
  type ConfigIssue,
} from "../config/validate.js";
import {
  DEV_FIXTURE_CONNECTOR_KIND,
  createDevFixtureConnector,
} from "../dev/fixture-connector.js";
import { IdpError } from "../idp/types.js";

export interface ConnectorFactoryInit {
  /** deployment.yaml の connectors[].id。返す Connector の sourceId と一致させる */
  readonly sourceId: string;
  /** connectors[].settings(秘密でない設定。factory が検証する) */
  readonly settings: Readonly<Record<string, unknown>>;
  /** 設定ファイルの所在ディレクトリ(絶対パス)。settings 内の相対パスの基準 */
  readonly configDir: string;
  /**
   * 導入単位のソース方針(connectors[].privateScopes。ADR-016 追補2 決定1)。
   * consent は静的検証で拒否されるため渡らない
   */
  readonly policy: SourcePolicy;
}

/**
 * connectors[] の宣言から factory に渡す方針を作る。consent は静的検証
 * (private_scopes_consent_not_supported)で先に拒否されるが、万一届いた場合も
 * included にはせず excluded に倒す(ADR-016 追補2 決定6)。
 */
export function sourcePolicyOf(
  connector: Pick<ConnectorConfig, "privateScopes">,
): SourcePolicy {
  return {
    privateScopes: connector.privateScopes === "included" ? "included" : "excluded",
  };
}

export type ConnectorFactory = (
  init: ConnectorFactoryInit,
) => Connector | Promise<Connector>;

/** プラグインモジュールの読み込み(既定は動的 import。テストで差し替える)。 */
export type ModuleLoader = (specifier: string) => Promise<unknown>;

export const defaultModuleLoader: ModuleLoader = (specifier) =>
  import(specifier);

/** 組み込みのコネクタ実装。 */
export const BUILTIN_CONNECTOR_FACTORIES: Readonly<
  Record<string, ConnectorFactory>
> = {
  [DEV_FIXTURE_CONNECTOR_KIND]: createDevFixtureConnector,
};

/** 開発専用の組み込み kind(本番では起動時に拒否する)。 */
export const DEV_ONLY_CONNECTOR_KINDS: ReadonlySet<string> = new Set([
  DEV_FIXTURE_CONNECTOR_KIND,
]);

export interface ResolvedConnectorFactory {
  readonly factory: ConnectorFactory;
  /** どこで見つかったか(registered: プログラム登録 / builtin / plugin) */
  readonly origin: "registered" | "builtin" | "plugin";
}

export interface ResolveConnectorFactoryOptions {
  readonly registered: Readonly<Record<string, ConnectorFactory>>;
  readonly configDir: string;
  readonly loadModule: ModuleLoader;
}

/**
 * プラグインの import 指定子。`./` `../` で始まる相対パスは設定ファイルの
 * 所在ディレクトリ基準、絶対パスはそのまま、いずれもファイルURLにする。
 * それ以外はパッケージ名として解決させる。
 */
export function pluginModuleSpecifier(
  connector: Pick<ConnectorConfig, "kind" | "module">,
  configDir: string,
): string {
  const module = connector.module ?? `@kp/connector-${connector.kind}`;
  if (module.startsWith("./") || module.startsWith("../") || isAbsolute(module)) {
    return pathToFileURL(resolve(configDir, module)).href;
  }
  return module;
}

function issue(
  code: ConfigIssue["code"],
  path: string,
  message: string,
): DeploymentConfigError {
  return new DeploymentConfigError([{ code, path, message }]);
}

/** 自身のプロパティとして関数を持つ場合だけ返す(継承プロパティを factory と誤認しない)。 */
function ownFunction(record: object, key: string): unknown {
  return Object.hasOwn(record, key)
    ? (record as Record<string, unknown>)[key]
    : undefined;
}

/**
 * connectors[index] の factory を解決する。見つからない・読み込めない場合は
 * DeploymentConfigError を投げる(失敗理由はモジュール指定子だけを載せる:
 * import の例外文言はファイルシステムやモジュール内部の情報を含みうるため)。
 */
export async function resolveConnectorFactory(
  connector: ConnectorConfig,
  index: number,
  options: ResolveConnectorFactoryOptions,
): Promise<ResolvedConnectorFactory> {
  const { kind } = connector;
  const path = `connectors[${index}].kind`;

  const registered = ownFunction(options.registered, kind);
  if (typeof registered === "function") {
    return { factory: registered as ConnectorFactory, origin: "registered" };
  }
  const builtin = ownFunction(BUILTIN_CONNECTOR_FACTORIES, kind);
  if (typeof builtin === "function") {
    if (connector.module !== undefined) {
      // 組み込みが優先されて module が黙って無視される構成を作らない
      throw issue(
        "connector_plugin_invalid",
        `connectors[${index}].module`,
        `kind "${kind}" is a built-in connector and cannot be combined with "module"; ` +
          "choose another kind for a plugin",
      );
    }
    return { factory: builtin as ConnectorFactory, origin: "builtin" };
  }

  if (connector.module === undefined && !CONNECTOR_KIND_PATTERN.test(kind)) {
    // kind を省略し id から導出した場合(id はパッケージ名として安全とは限らない)
    throw issue(
      "unknown_connector_kind",
      path,
      `connector "${connector.id}" has no valid kind; set connectors[${index}].kind ` +
        `(lowercase letters, digits and '-') or connectors[${index}].module`,
    );
  }
  const specifier = pluginModuleSpecifier(connector, options.configDir);
  let loaded: unknown;
  try {
    loaded = await options.loadModule(specifier);
  } catch {
    throw issue(
      "unknown_connector_kind",
      path,
      `connector kind "${kind}": plugin module "${specifier}" could not be loaded ` +
        `(not installed, or failed to initialize)`,
    );
  }
  if (typeof loaded !== "object" || loaded === null) {
    throw issue(
      "connector_plugin_invalid",
      path,
      `plugin module "${specifier}" does not export a connector factory`,
    );
  }
  const named = ownFunction(loaded, "createConnector");
  if (named !== undefined) {
    if (typeof named !== "function") {
      throw issue(
        "connector_plugin_invalid",
        path,
        `plugin module "${specifier}": export "createConnector" is not a function`,
      );
    }
    return { factory: named as ConnectorFactory, origin: "plugin" };
  }
  const fallback = ownFunction(loaded, "default");
  if (typeof fallback === "function") {
    return { factory: fallback as ConnectorFactory, origin: "plugin" };
  }
  throw issue(
    "connector_plugin_invalid",
    path,
    `plugin module "${specifier}" exports neither "createConnector" nor a default factory function`,
  );
}

const CONNECTOR_METHODS = ["search", "fetch", "list", "describe"] as const;

/** factory の戻り値が Connector IF(connector-sdk)の形をしているか。 */
function isConnector(value: unknown): value is Connector {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const capabilities = candidate["capabilities"] as
    | Record<string, unknown>
    | null
    | undefined;
  return (
    typeof candidate["sourceId"] === "string" &&
    typeof capabilities === "object" &&
    capabilities !== null &&
    ["full", "degraded", "none"].includes(capabilities["nativeSearch"] as string) &&
    typeof capabilities["ingest"] === "boolean" &&
    // privateScopeHandling(v0.4)は省略可(v0.3 のプラグイン)。省略・未知の値は
    // 設定検証で unsupported とみなす(privateScopeHandlingOf。ADR-016 追補2 決定3)
    CONNECTOR_METHODS.every((method) => typeof candidate[method] === "function")
  );
}

/** zod の ZodError(版をまたいでも判定できるよう形で見る)。 */
function zodIssuesOf(
  error: unknown,
): readonly { path: readonly PropertyKey[]; message: string }[] | undefined {
  if (!(error instanceof Error) || error.name !== "ZodError") {
    return undefined;
  }
  const { issues } = error as Error & { issues?: unknown };
  if (!Array.isArray(issues)) {
    return undefined;
  }
  return issues.map((raw: unknown) => {
    const { path, message } = (raw ?? {}) as { path?: unknown; message?: unknown };
    return {
      path: Array.isArray(path) ? (path as PropertyKey[]) : [],
      message: typeof message === "string" ? message : "invalid value",
    };
  });
}

/**
 * factory の失敗を設定の不備に写す。DeploymentConfigError / ZodError /
 * ConnectorError / IdpError のメッセージは各層の規約で秘密情報を含まないため
 * 透過し、それ以外の例外は種別名だけを載せる(TM-A2 と同じ方針)。
 */
function factoryFailureIssues(
  error: unknown,
  base: string,
  kind: string,
): ConfigIssue[] {
  if (error instanceof DeploymentConfigError) {
    // 組み込み factory はコネクタ宣言からの相対パス("settings.*")で報告する
    return error.issues.map((i) => ({ ...i, path: `${base}.${i.path}` }));
  }
  const zodIssues = zodIssuesOf(error);
  if (zodIssues !== undefined) {
    return zodIssues.map((i) => ({
      code: "connector_settings_invalid",
      path: [`${base}.settings`, ...i.path.map(String)].join("."),
      message: i.message,
    }));
  }
  if (error instanceof ConnectorError && error.errorClass === "invalid_request") {
    return [
      {
        code: "connector_settings_invalid",
        path: `${base}.settings`,
        message: error.message,
      },
    ];
  }
  const detail =
    error instanceof ConnectorError || error instanceof IdpError
      ? `: ${error.message}`
      : ` (${error instanceof Error ? error.name : typeof error})`;
  return [
    {
      code: "connector_factory_failed",
      path: `${base}.kind`,
      message: `connector kind "${kind}" failed to initialize${detail}`,
    },
  ];
}

export type ConnectorBuildResult =
  | { readonly ok: true; readonly connector: Connector }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

/** 解決済みの factory で connectors[index] の実体を作る。 */
export async function buildConnector(
  connector: ConnectorConfig,
  index: number,
  factory: ConnectorFactory,
  configDir: string,
): Promise<ConnectorBuildResult> {
  const base = `connectors[${index}]`;
  let instance: unknown;
  try {
    instance = await factory({
      sourceId: connector.id,
      settings: connector.settings,
      configDir,
      policy: sourcePolicyOf(connector),
    });
  } catch (error) {
    return { ok: false, issues: factoryFailureIssues(error, base, connector.kind) };
  }
  if (!isConnector(instance)) {
    return {
      ok: false,
      issues: [
        {
          code: "connector_plugin_invalid",
          path: `${base}.kind`,
          message: `connector kind "${connector.kind}": factory did not return a Connector (connector-sdk)`,
        },
      ],
    };
  }
  if (instance.sourceId !== connector.id) {
    return {
      ok: false,
      issues: [
        {
          code: "connector_plugin_invalid",
          path: `${base}.id`,
          message:
            `connector kind "${connector.kind}": factory returned a connector for source ` +
            `"${instance.sourceId}", expected "${connector.id}"`,
        },
      ],
    };
  }
  return { ok: true, connector: instance };
}
