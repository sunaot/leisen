/**
 * @leisen/connector-github — GitHub コネクタ(T-019)。
 *
 * connector-sdk v0.4 の Connector を GitHub REST API で実装する。全呼び出しを
 * 利用者本人の user access token で行う(不変条件1、ADR-010、auth-matrix §4)。
 * 使い方・前提・既知の限界は README.md を参照。
 *
 * 公開 API は factory(createGitHubConnector と、Gateway のプラグイン契約の
 * createConnector)と型のみに絞る。API クライアント(GitHubApiClient)・残quota追跡
 * (QuotaTracker)・documentId の符号化は内部実装であり公開しない: コネクタ(= Gateway に
 * 登録して呼ぶ経路)を経由せずに GitHub API を呼ぶ部品を配らない(不変条件2)。
 * documentId はコネクタスコープの不透明な文字列(ADR-007)。テストは相対 import で
 * 内部モジュールを参照する。
 */
import { ConnectorError, type SourcePolicy } from "@leisen/connector-sdk";
import {
  GitHubConnector,
  type GitHubConnectorOptions,
} from "./connector.js";

export {
  createGitHubConnector,
  type GitHubConnector,
  type GitHubConnectorOptions,
} from "./connector.js";
export type { FetchLike, RateLimitOptions } from "./api.js";

/**
 * Gateway のプラグイン契約(packages/gateway/src/bootstrap/plugins.ts の ConnectorFactory)
 * の引数。コネクタは @leisen/gateway に依存しないため、同じ形をここで定義する。
 */
export interface GitHubConnectorFactoryInit {
  /** deployment.yaml の connectors[].id(返す Connector の sourceId になる) */
  readonly sourceId: string;
  /** connectors[].settings(秘密でない設定。GITHUB_CONNECTOR_SETTINGS のキーだけ) */
  readonly settings?: Readonly<Record<string, unknown>>;
  /** 設定ファイルの所在ディレクトリ(本コネクタの設定に相対パスはないため使わない) */
  readonly configDir?: string;
  /**
   * 導入単位のソース方針(ADR-016 追補2 決定1)。本コネクタは "classified"(ソース側で
   * 除外せず、結果に scope を付けて Gateway に除外を任せる)のため、方針で動作を変えない
   */
  readonly policy?: SourcePolicy;
}

/** settings に書ける値の種類。 */
type SettingKind = "string" | "boolean" | "integer";

/**
 * deployment.yaml の connectors[].settings に書ける設定(GitHubConnectorOptions のうち
 * 秘密でなく、YAML で表せるもの)。トークンは受け取らない: 本人トークンは Gateway が
 * 呼び出しごとに AuthContext で渡す(不変条件1・6)。fetchImpl / now はテスト用の注入で
 * 設定からは渡さない。値域は構築時に GitHubConnector が検証する。
 */
const GITHUB_CONNECTOR_SETTINGS: Readonly<Record<string, SettingKind>> = {
  displayName: "string",
  baseUrl: "string",
  timeoutMs: "integer",
  userAgent: "string",
  searchCode: "boolean",
  defaultSearchLimit: "integer",
  snippetChars: "integer",
  pageChars: "integer",
  maxComments: "integer",
  listPageSize: "integer",
  maxTopContainers: "integer",
};

/** settings.rateLimit に書ける設定(残quota追跡。RateLimitOptions)。 */
const RATE_LIMIT_SETTINGS: Readonly<Record<string, SettingKind>> = {
  maxEntries: "integer",
  secondaryBackoffBaseMs: "integer",
  secondaryBackoffMaxMs: "integer",
};

type FactorySettings = Omit<GitHubConnectorOptions, "sourceId" | "fetchImpl" | "now">;

/** 設定の不備(受領値はエコーしない。Gateway は connector_settings_invalid で起動を拒否する)。 */
function invalidSettings(message: string): ConnectorError {
  return new ConnectorError("invalid_request", `github connector settings: ${message}`);
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function matchesKind(kind: SettingKind, value: unknown): boolean {
  switch (kind) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
  }
}

const KIND_LABELS: Readonly<Record<SettingKind, string>> = {
  string: "a string",
  boolean: "true or false",
  integer: "an integer",
};

/** 設定名の表示(未知のキーの誤記を示すため。名前らしくない文字列はエコーしない)。 */
function settingName(path: string, key: string): string {
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) ? `${path}${key}` : `${path}(a key)`;
}

/** 既知のキーだけ・型の合う値だけを受ける(未知のキーは黙って捨てずに拒否する)。 */
function pickSettings(
  raw: Readonly<Record<string, unknown>>,
  allowed: Readonly<Record<string, SettingKind>>,
  path: string,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const kind = Object.hasOwn(allowed, key) ? allowed[key] : undefined;
    if (kind === undefined) {
      throw invalidSettings(
        `unknown setting ${settingName(path, key)} (allowed: ${Object.keys(allowed).join(", ")})`,
      );
    }
    if (!matchesKind(kind, value)) {
      throw invalidSettings(`${path}${key} must be ${KIND_LABELS[kind]}`);
    }
    picked[key] = value;
  }
  return picked;
}

/** connectors[].settings を検証して GitHubConnectorOptions の一部にする。 */
function parseGitHubConnectorSettings(settings: unknown): FactorySettings {
  if (settings === undefined) {
    return {};
  }
  if (!isPlainObject(settings)) {
    throw invalidSettings("settings must be a mapping");
  }
  const { rateLimit, ...rest } = settings;
  const picked = pickSettings(rest, GITHUB_CONNECTOR_SETTINGS, "");
  if (rateLimit !== undefined) {
    if (!isPlainObject(rateLimit)) {
      throw invalidSettings("rateLimit must be a mapping");
    }
    picked["rateLimit"] = pickSettings(rateLimit, RATE_LIMIT_SETTINGS, "rateLimit.");
  }
  // 各キーの型は pickSettings で GITHUB_CONNECTOR_SETTINGS / RATE_LIMIT_SETTINGS の
  // 種類に合わせて検証済み(値域は GitHubConnector の構築時に検証する)
  return picked as FactorySettings;
}

/**
 * Gateway のプラグイン契約の factory(deployment.yaml の `kind: github` →
 * モジュール `@leisen/connector-github` の名前付き export)。
 * - settings は parseGitHubConnectorSettings で検証する。未知のキー(トークン類を含む)・
 *   型違い・範囲外は ConnectorError("invalid_request")(受領値をエコーしない)
 * - 返す Connector の sourceId は init.sourceId
 * - factory の中で GitHub API を呼ばない(利用者本人の資格情報がない時点のため)
 */
export function createConnector(init: GitHubConnectorFactoryInit): GitHubConnector {
  if (typeof init !== "object" || init === null) {
    throw invalidSettings("the factory requires { sourceId, settings }");
  }
  const settings = parseGitHubConnectorSettings(init.settings);
  try {
    return new GitHubConnector({ ...settings, sourceId: init.sourceId });
  } catch (error) {
    // 構築時の値域検査(RangeError 等)の文言は設定名と許容範囲のみ(受領値を含まない)
    throw invalidSettings(error instanceof Error ? error.message : "invalid settings");
  }
}
