/** @leisen/connector-redmine — Redmine の読み取り専用コネクター。 */
import { ConnectorError, type SourcePolicy } from "@leisen/connector-sdk";
import { RedmineConnector, type RedmineConnectorOptions } from "./redmine.js";

export { RedmineConnector, type RedmineConnectorOptions } from "./redmine.js";

export interface RedmineConnectorFactoryInit {
  readonly sourceId: string;
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly configDir?: string;
  readonly policy?: SourcePolicy;
}

/** Gateway plugin contract. Settings contain non-secret values only. */
export function createConnector(init: RedmineConnectorFactoryInit): RedmineConnector {
  const settings = init.settings ?? {};
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new ConnectorError("invalid_request", "redmine connector settings must be a mapping");
  }
  const allowed = new Set(["baseUrl", "displayName", "timeoutMs", "defaultSearchLimit"]);
  for (const key of Object.keys(settings)) {
    if (!allowed.has(key)) {
      throw new ConnectorError(
        "invalid_request",
        `redmine connector settings: unknown setting ${key}`,
      );
    }
  }
  const baseUrl = settings.baseUrl;
  const displayName = settings.displayName;
  const timeoutMs = settings.timeoutMs;
  const defaultSearchLimit = settings.defaultSearchLimit;
  if (typeof baseUrl !== "string") {
    throw new ConnectorError("invalid_request", "redmine connector setting baseUrl must be a string");
  }
  if (displayName !== undefined && typeof displayName !== "string") {
    throw new ConnectorError("invalid_request", "redmine connector setting displayName must be a string");
  }
  if (timeoutMs !== undefined && typeof timeoutMs !== "number") {
    throw new ConnectorError("invalid_request", "redmine connector setting timeoutMs must be an integer");
  }
  if (defaultSearchLimit !== undefined && typeof defaultSearchLimit !== "number") {
    throw new ConnectorError("invalid_request", "redmine connector setting defaultSearchLimit must be an integer");
  }
  return new RedmineConnector({
    sourceId: init.sourceId,
    baseUrl,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(defaultSearchLimit !== undefined ? { defaultSearchLimit } : {}),
  });
}
