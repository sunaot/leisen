/**
 * @leisen/connector-esa — esa コネクタ(T-026、ADR-023)。
 *
 * connector-sdk v0.4 の Connector を esa 公式のリモート MCP サーバー(https://mcp.esa.io)の
 * 読み取り系ツールで実装する。全呼び出しを利用者本人の OAuth アクセストークンで行う
 * (不変条件1)。トークンは Gateway の Token Vault または ESC が用意する(ADR-022)。
 *
 * 公開 API は factory と型だけに絞る。MCP の呼び出し部品(EsaMcpClient)は公開しない:
 * コネクタを経由せずに esa を呼ぶ部品を配らない(不変条件2)。
 */
import { ConnectorError, type SourcePolicy } from "@leisen/connector-sdk";
import { EsaConnector, type EsaConnectorOptions } from "./connector.js";

export { createEsaConnector, EsaConnector, DEFAULT_MCP_URL, type EsaConnectorOptions } from "./connector.js";
export type { FetchLike } from "./mcp.js";
export { ESA_MCP_ORIGIN } from "./connector.js";

/** Gateway のプラグイン契約(packages/gateway/src/bootstrap/plugins.ts の ConnectorFactory)の引数。 */
export interface EsaConnectorFactoryInit {
  readonly sourceId: string;
  /** connectors[].settings(秘密でない設定。ESA_CONNECTOR_SETTINGS のキーだけ) */
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly configDir?: string;
  /** 本コネクタは classified(結果に scope を付けて除外を Gateway に任せる)のため使わない */
  readonly policy?: SourcePolicy;
}

type SettingKind = "string" | "boolean" | "integer" | "stringArray";

/** connectors[].settings に書ける設定。トークンは受け取らない(不変条件1・6)。 */
const ESA_CONNECTOR_SETTINGS: Readonly<Record<string, SettingKind>> = {
  team: "string",
  displayName: "string",
  summary: "string",
  mcpUrl: "string",
  timeoutMs: "integer",
  defaultSearchLimit: "integer",
  snippetChars: "integer",
  pageChars: "integer",
  maxTopContainers: "integer",
  includeWip: "boolean",
  privateCategories: "stringArray",
};

const KIND_LABELS: Readonly<Record<SettingKind, string>> = {
  string: "a string",
  boolean: "true or false",
  integer: "an integer",
  stringArray: "a list of strings",
};

function invalidSettings(message: string): ConnectorError {
  return new ConnectorError("invalid_request", `esa connector settings: ${message}`);
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
    case "stringArray":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
  }
}

function settingName(key: string): string {
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) ? key : "(a key)";
}

/** connectors[].settings を検証する(未知のキー・型違いは拒否し、受領値をエコーしない)。 */
type FactorySettings = Omit<EsaConnectorOptions, "sourceId" | "fetchImpl" | "caller" | "now" | "production">;

export function parseEsaConnectorSettings(settings: unknown): FactorySettings {
  if (!isPlainObject(settings)) {
    throw invalidSettings("settings must be a mapping with at least team");
  }
  const picked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    const kind = Object.hasOwn(ESA_CONNECTOR_SETTINGS, key) ? ESA_CONNECTOR_SETTINGS[key] : undefined;
    if (kind === undefined) {
      throw invalidSettings(
        `unknown setting ${settingName(key)} (allowed: ${Object.keys(ESA_CONNECTOR_SETTINGS).join(", ")})`,
      );
    }
    if (!matchesKind(kind, value)) {
      throw invalidSettings(`${key} must be ${KIND_LABELS[kind]}`);
    }
    picked[key] = value;
  }
  if (typeof picked["team"] !== "string") {
    throw invalidSettings("team is required");
  }
  // 各キーの型は ESA_CONNECTOR_SETTINGS に合わせて検証済み(値域は EsaConnector の構築時に検証する)
  return picked as unknown as FactorySettings;
}

/**
 * Gateway のプラグイン契約の factory(deployment.yaml の `kind: esa` → `@leisen/connector-esa`)。
 * factory の中で esa を呼ばない(利用者本人の資格情報がない時点のため)
 */
export function createConnector(init: EsaConnectorFactoryInit): EsaConnector {
  if (typeof init !== "object" || init === null) {
    throw invalidSettings("the factory requires { sourceId, settings }");
  }
  const settings = parseEsaConnectorSettings(init.settings);
  try {
    return new EsaConnector({ ...settings, sourceId: init.sourceId });
  } catch (error) {
    throw invalidSettings(error instanceof Error ? error.message : "invalid settings");
  }
}
