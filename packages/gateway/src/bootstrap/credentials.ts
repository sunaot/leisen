/**
 * 本人資格情報の方式と認可サーバーの組み立て(起動コード。ADR-022)。
 *
 * - connectors[].auth.provider の token_vault / esc / token_exchange を、それぞれのプロバイダに組む
 * - token_vault / esc / 認可サーバーは gateway.publicBaseUrl と gateway.credentials(状態 DB・鍵)を
 *   要する(credentials_config_missing)。esc は認可サーバーの有効化を要する
 *   (esc_requires_authorization_server)
 * - 秘密(client secret・マスター鍵・ESC の鍵・管理の資格情報)は環境変数から読み、未設定・短い値は
 *   secret_env_missing / secret_env_invalid。値をエラー・ログに出さない(不変条件6)
 * - 本人照合を外す identityCheck: none は confirmIdentityCheckDisabled: true を要し、WARNING を残す
 * - Keycloak でブラウザのログインを使う構成は、Gateway 自身の clientId を allowedClients に要する
 *   (IdP から得たトークンを Gateway が検証するため。idp_login_client_not_allowed)
 * - 本番(NODE_ENV=production)では publicBaseUrl に https を要する(public_base_url_not_https)
 */
import { resolve } from "node:path";
import type { ConfigIssue } from "../config/validate.js";
import type { DeploymentConfig, ConnectorConfig } from "../config/schema.js";
import { AwsKmsKeyProvider } from "../credentials/aws-kms.js";
import { discardCredentialEvents, type CredentialEventSink } from "../credentials/events.js";
import { GcpKmsKeyProvider } from "../credentials/gcp-kms.js";
import { decodeKeyBytes, LocalKeyProvider, type KeyProvider } from "../credentials/keys.js";
import { SourceOAuthClient } from "../credentials/oauth.js";
import {
  EscCredentialProvider,
  TokenExchangeCredentialProvider,
  TokenVaultCredentialProvider,
} from "../credentials/providers.js";
import { CredentialRevocation } from "../credentials/revocation.js";
import { SqliteCredentialStore } from "../credentials/store.js";
import type { CredentialStore } from "../credentials/types.js";
import { TokenVault } from "../credentials/vault.js";
import { keycloakLoginEndpoints, MockLogin, OidcLogin, type IdpLogin } from "../idp/login.js";
import type { CredentialProvider, IdpAdapter } from "../idp/types.js";
import { acceptsAnyClient } from "../idp/keycloak.js";
import { GatewayTokenIdpAdapter } from "../auth-server/authenticator.js";
import { Sealer } from "../auth-server/seal.js";
import {
  AuthHttpHandler,
  isAllowedRedirectUri,
  ORCHESTRATOR_CLIENT_ID,
  type ConfiguredSource,
  type RegisteredClient,
} from "../auth-server/server.js";
import { TokenService } from "../auth-server/tokens.js";

type Env = Readonly<Record<string, string | undefined>>;

export interface CredentialRuntime {
  readonly store?: CredentialStore;
  readonly vault?: TokenVault;
  readonly sealer?: Sealer;
  readonly keyDescription?: string;
  /** sourceId → 接続ページ・認可サーバーが使うソースの情報 */
  readonly sources: Map<string, ConfiguredSource>;
  /** 遅延して監査につなぐ事象の記録先(AuditLogger ができてから set する) */
  readonly events: CredentialEventSink;
  /** 外部 HTTP の fetch(テスト用の注入。既定は global fetch) */
  readonly fetchImpl?: typeof fetch;
  setEventSink(sink: CredentialEventSink): void;
  close(): void;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  } catch {
    return false;
  }
}

function secretFromEnv(env: Env, name: string, path: string, issues: ConfigIssue[]): string | undefined {
  const value = env[name];
  if (value === undefined || value === "") {
    issues.push({ code: "secret_env_missing", path, message: `environment variable "${name}" is not set or empty` });
    return undefined;
  }
  return value;
}

function keyFromEnv(env: Env, name: string, path: string, issues: ConfigIssue[]): Buffer | undefined {
  const raw = secretFromEnv(env, name, path, issues);
  if (raw === undefined) return undefined;
  const key = decodeKeyBytes(raw);
  if (key === undefined || key.byteLength !== 32) {
    issues.push({
      code: "secret_env_invalid",
      path,
      message: `environment variable "${name}" must hold exactly 32 random bytes encoded as hex, base64 or base64url (e.g. openssl rand -base64 32)`,
    });
    return undefined;
  }
  return key;
}

function previousKeys(env: Env, name: string, path: string, issues: ConfigIssue[]): Buffer[] {
  const raw = env[name];
  if (raw === undefined || raw === "") return [];
  const keys: Buffer[] = [];
  for (const part of raw.split(",")) {
    const key = decodeKeyBytes(part);
    if (key === undefined || key.byteLength !== 32) {
      issues.push({ code: "secret_env_invalid", path, message: `environment variable "${name}" must hold comma-separated 32-byte keys` });
      return [];
    }
    keys.push(key);
  }
  return keys;
}

/** token_vault / esc / 認可サーバーのどれかを使うか。 */
export function needsCredentialInfrastructure(config: DeploymentConfig): boolean {
  return (
    config.gateway.authorizationServer.enabled ||
    config.connectors.some((c) => c.enabled && (c.auth?.provider === "token_vault" || c.auth?.provider === "esc"))
  );
}

/** 状態 DB・鍵・Token Vault・封緘の鍵を用意する(必要な構成のときだけ)。 */
export function resolveCredentialRuntime(
  config: DeploymentConfig,
  env: Env,
  configDir: string,
  issues: ConfigIssue[],
  warnings: string[],
  options: { inMemoryStore?: boolean; fetchImpl?: typeof fetch } = {},
): CredentialRuntime {
  const fetchOpt = options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {};
  let sink: CredentialEventSink = discardCredentialEvents;
  const events: CredentialEventSink = (event) => sink(event);
  const sources = new Map<string, ConfiguredSource>();
  const base = {
    sources,
    events,
    ...fetchOpt,
    setEventSink: (next: CredentialEventSink) => {
      sink = next;
    },
  };
  if (!needsCredentialInfrastructure(config)) {
    return { ...base, close: () => undefined };
  }
  const { publicBaseUrl, credentials } = config.gateway;
  if (publicBaseUrl === undefined) {
    issues.push({
      code: "credentials_config_missing",
      path: "gateway.publicBaseUrl",
      message: "token_vault / esc sources and the authorization server require gateway.publicBaseUrl (the URL browsers use to reach the gateway)",
    });
  } else if (!publicBaseUrl.startsWith("https:") && !isLoopbackUrl(publicBaseUrl)) {
    if (isProduction()) {
      issues.push({ code: "public_base_url_not_https", path: "gateway.publicBaseUrl", message: "gateway.publicBaseUrl must be https in production" });
    } else {
      warnings.push("gateway.publicBaseUrl is plain http on a non-loopback host; cookies are sent without Secure (development only)");
    }
  }
  if (credentials === undefined) {
    issues.push({
      code: "credentials_config_missing",
      path: "gateway.credentials",
      message: "token_vault / esc sources and the authorization server require gateway.credentials (state store and keys)",
    });
    return { ...base, close: () => undefined };
  }
  // ESC の鍵(Gateway が封じるトークン)
  const escKey = keyFromEnv(env, credentials.escKeyEnv, "gateway.credentials.escKeyEnv", issues);
  const escPrevious = previousKeys(env, credentials.escPreviousKeyEnv, "gateway.credentials.escPreviousKeyEnv", issues);
  // Token Vault の鍵(KMS)
  let keys: KeyProvider | undefined;
  const k = credentials.keys;
  const usesVault = config.connectors.some((c) => c.enabled && c.auth?.provider === "token_vault");
  if (usesVault) {
    switch (k.kind) {
      case "local": {
        const current = keyFromEnv(env, k.keyEnv, "gateway.credentials.keys.keyEnv", issues);
        const previous = previousKeys(env, k.previousKeyEnv, "gateway.credentials.keys.previousKeyEnv", issues);
        if (current !== undefined) {
          if (escKey !== undefined && current.equals(escKey)) {
            issues.push({ code: "secret_env_invalid", path: "gateway.credentials.keys.keyEnv", message: "the vault master key must differ from the ESC key" });
          } else {
            keys = new LocalKeyProvider(current, previous);
          }
        }
        break;
      }
      case "aws_kms":
        keys = new AwsKmsKeyProvider(
          { ...fetchOpt, keyId: k.keyId, region: k.region, ...(k.endpoint !== undefined ? { endpoint: k.endpoint } : {}), ...(k.timeoutMs !== undefined ? { timeoutMs: k.timeoutMs } : {}) },
          env,
        );
        break;
      case "gcp_kms":
        keys = new GcpKmsKeyProvider(
          { ...fetchOpt, keyName: k.keyName, ...(k.endpoint !== undefined ? { endpoint: k.endpoint } : {}), ...(k.timeoutMs !== undefined ? { timeoutMs: k.timeoutMs } : {}) },
          env,
        );
        break;
    }
  }
  if (escKey === undefined || (usesVault && keys === undefined) || issues.length > 0) {
    return { ...base, close: () => undefined };
  }
  const store = new SqliteCredentialStore(
    options.inMemoryStore === true ? ":memory:" : resolve(configDir, credentials.store.path),
  );
  const vault = keys !== undefined ? new TokenVault(store, keys) : undefined;
  return {
    ...base,
    store,
    ...(vault !== undefined ? { vault } : {}),
    sealer: new Sealer(escKey, escPrevious),
    ...(keys !== undefined ? { keyDescription: keys.description } : {}),
    close: () => store.close(),
  };
}

/** 有効なコネクタ 1 件のプロバイダを組む(mock_env 以外)。 */
export function createSourceCredentialProvider(
  connector: ConnectorConfig,
  index: number,
  config: DeploymentConfig,
  env: Env,
  runtime: CredentialRuntime,
  issues: ConfigIssue[],
  warnings: string[],
): CredentialProvider | undefined {
  const auth = connector.auth;
  const path = `connectors[${index}].auth`;
  if (auth === undefined || auth.provider === "mock_env") return undefined;
  if (auth.provider === "token_exchange") {
    const x = auth.exchange;
    const secret = secretFromEnv(env, x.clientSecretEnv, `${path}.exchange.clientSecretEnv`, issues);
    if (x.kind === "entra_obo" && x.scope === undefined) {
      issues.push({ code: "token_exchange_scope_missing", path: `${path}.exchange.scope`, message: "entra_obo requires scope (e.g. https://graph.microsoft.com/.default)" });
      return undefined;
    }
    if (secret === undefined) return undefined;
    runtime.sources.set(connector.id, { sourceId: connector.id, kind: "token_exchange", identityCheck: "none" });
    return new TokenExchangeCredentialProvider(
      {
        sourceId: connector.id,
        kind: x.kind,
        tokenEndpoint: x.tokenEndpoint,
        clientId: x.clientId,
        clientSecret: secret,
        clientAuth: x.clientAuth,
        ...(x.scope !== undefined ? { scope: x.scope } : {}),
        ...(x.audience !== undefined ? { audience: x.audience } : {}),
        ...(x.resource !== undefined ? { resource: x.resource } : {}),
      },
      { events: runtime.events, ...(runtime.fetchImpl !== undefined ? { fetchImpl: runtime.fetchImpl } : {}), ...(x.timeoutMs !== undefined ? { timeoutMs: x.timeoutMs } : {}) },
    );
  }
  // token_vault / esc
  const o = auth.oauth;
  if (o.identityCheck === "none") {
    if (o.confirmIdentityCheckDisabled !== true) {
      issues.push({
        code: "identity_check_disabled_requires_confirmation",
        path: `${path}.oauth.identityCheck`,
        message: "identityCheck: none lets users connect a different (e.g. personal) account; set confirmIdentityCheckDisabled: true to accept this (ADR-022 decision 8)",
      });
      return undefined;
    }
    warnings.push(`connector "${connector.id}": identity check at connection is disabled (identityCheck: none)`);
  }
  if (o.preset === "custom" && (o.endpoints?.authorizationEndpoint === undefined || o.endpoints.tokenEndpoint === undefined)) {
    issues.push({ code: "oauth_endpoints_missing", path: `${path}.oauth.endpoints`, message: "preset custom requires endpoints.authorizationEndpoint and endpoints.tokenEndpoint" });
    return undefined;
  }
  if (o.preset === "custom" && o.identityCheck === "email" && o.endpoints?.userinfoEndpoint === undefined) {
    issues.push({ code: "oauth_endpoints_missing", path: `${path}.oauth.endpoints.userinfoEndpoint`, message: "preset custom with identityCheck: email requires endpoints.userinfoEndpoint" });
    return undefined;
  }
  if (auth.provider === "esc" && !config.gateway.authorizationServer.enabled) {
    issues.push({
      code: "esc_requires_authorization_server",
      path: `${path}.provider`,
      message: "provider esc requires gateway.authorizationServer.enabled: true (the gateway issues the encrypted credentials to clients)",
    });
    return undefined;
  }
  const secret = secretFromEnv(env, o.clientSecretEnv, `${path}.oauth.clientSecretEnv`, issues);
  if (secret === undefined) return undefined;
  const oauth = new SourceOAuthClient({
    sourceId: connector.id,
    preset: o.preset,
    clientId: o.clientId,
    clientSecret: secret,
    scopes: o.scopes,
    ...(o.endpoints !== undefined
      ? { endpoints: Object.fromEntries(Object.entries(o.endpoints).filter(([, v]) => v !== undefined)) as Record<string, string> }
      : {}),
    fetchIdentity: o.identityCheck === "email",
  }, runtime.fetchImpl !== undefined ? { fetchImpl: runtime.fetchImpl } : {});
  runtime.sources.set(connector.id, { sourceId: connector.id, kind: auth.provider, oauth, identityCheck: o.identityCheck });
  const publicBaseUrl = config.gateway.publicBaseUrl;
  if (auth.provider === "token_vault") {
    if (runtime.vault === undefined) return undefined; // 鍵・状態 DB の不備は記録済み
    return new TokenVaultCredentialProvider({
      vault: runtime.vault,
      oauth,
      events: runtime.events,
      ...(publicBaseUrl !== undefined ? { connectUrl: `${publicBaseUrl}/connections?source=${encodeURIComponent(connector.id)}` } : {}),
    });
  }
  if (runtime.store === undefined) return undefined;
  return new EscCredentialProvider({ sourceId: connector.id, store: runtime.store });
}

export interface AssembledAuth {
  /** Gateway が使う IdpAdapter(認可サーバーが有効なら Gateway のトークンを受けるアダプタ) */
  readonly idpAdapter: IdpAdapter;
  readonly handler?: AuthHttpHandler;
  readonly description?: string;
}

/** 接続ページ・認可サーバーを組む(IdpAdapter ができた後)。 */
export function assembleAuth(input: {
  config: DeploymentConfig;
  env: Env;
  runtime: CredentialRuntime;
  idpAdapter: IdpAdapter;
  /** IdP の clientSecret(Keycloak のとき。ログイン用の OIDC クライアントに使う) */
  idpClientSecret?: string;
  orchestratorCredential?: string;
  issues: ConfigIssue[];
  warnings: string[];
  warn?: (message: string) => void;
}): AssembledAuth {
  const { config, env, runtime, issues, warnings } = input;
  const { publicBaseUrl, authorizationServer: as } = config.gateway;
  if (runtime.store === undefined || runtime.sealer === undefined || publicBaseUrl === undefined) {
    return { idpAdapter: input.idpAdapter };
  }
  const adapter = config.idp.adapter;
  let login: IdpLogin;
  if (adapter.kind === "mock") {
    login = new MockLogin();
  } else {
    if (!acceptsAnyClient(adapter.allowedClients) && !adapter.allowedClients.includes(adapter.clientId)) {
      issues.push({
        code: "idp_login_client_not_allowed",
        path: "idp.adapter.allowedClients",
        message: `browser sign-in uses the gateway's own client "${adapter.clientId}"; add it to idp.adapter.allowedClients`,
      });
    }
    login = new OidcLogin({
      ...keycloakLoginEndpoints(adapter),
      clientId: adapter.clientId,
      clientSecret: input.idpClientSecret ?? "",
      ...(runtime.fetchImpl !== undefined ? { fetchImpl: runtime.fetchImpl } : {}),
      ...(adapter.timeoutMs !== undefined ? { timeoutMs: adapter.timeoutMs } : {}),
    });
  }
  const adminRaw = env[config.gateway.admin.credentialEnv];
  let adminCredential: string | undefined;
  if (adminRaw === undefined || adminRaw === "") {
    warnings.push(`admin API (POST /admin/deprovision) is disabled: ${config.gateway.admin.credentialEnv} is not set`);
  } else if (adminRaw.length < 32) {
    issues.push({ code: "secret_env_invalid", path: "gateway.admin.credentialEnv", message: `environment variable "${config.gateway.admin.credentialEnv}" must be at least 32 characters` });
  } else {
    adminCredential = adminRaw;
  }

  const refreshTtlMs = as.refreshTokenTtlSec * 1000;
  const revocation = new CredentialRevocation({
    ...(runtime.vault !== undefined ? { vault: runtime.vault } : {}),
    store: runtime.store,
    sources: {
      vault: new Map([...runtime.sources.values()].filter((s) => s.kind === "token_vault" && s.oauth).map((s) => [s.sourceId, s.oauth as SourceOAuthClient])),
      esc: new Map([...runtime.sources.values()].filter((s) => s.kind === "esc" && s.oauth).map((s) => [s.sourceId, s.oauth as SourceOAuthClient])),
    },
    events: runtime.events,
    invalidateUser: (userId) => input.idpAdapter.invalidateUser(userId),
    denialRetentionMs: Math.max(refreshTtlMs, config.gateway.credentials?.browserSessionTtlSec ?? 0) + 86_400_000,
  });

  let idpAdapter: IdpAdapter = input.idpAdapter;
  let settings;
  if (as.enabled) {
    const clients = new Map<string, RegisteredClient>();
    as.clients.forEach((client, i) => {
      const path = `gateway.authorizationServer.clients[${i}]`;
      if (client.clientId === ORCHESTRATOR_CLIENT_ID) {
        issues.push({ code: "reserved_client_id", path: `${path}.clientId`, message: `clientId "${ORCHESTRATOR_CLIENT_ID}" is reserved for the orchestrator` });
        return;
      }
      if (clients.has(client.clientId)) {
        issues.push({ code: "duplicate_client_id", path: `${path}.clientId`, message: `duplicate clientId "${client.clientId}"` });
        return;
      }
      const bad = client.redirectUris.find((u) => !isAllowedRedirectUri(u));
      if (bad !== undefined) {
        issues.push({ code: "redirect_uri_not_allowed", path: `${path}.redirectUris`, message: "redirect URIs must be https, or http on a loopback host, without a fragment" });
        return;
      }
      const secret = client.clientSecretEnv !== undefined ? secretFromEnv(env, client.clientSecretEnv, `${path}.clientSecretEnv`, issues) : undefined;
      if (client.clientSecretEnv !== undefined && secret === undefined) return;
      clients.set(client.clientId, {
        clientId: client.clientId,
        redirectUris: client.redirectUris,
        ...(client.name !== undefined ? { name: client.name } : {}),
        ...(secret !== undefined ? { secret } : {}),
      });
    });
    if (clients.size === 0 && !as.allowDynamicRegistration) {
      warnings.push("authorization server is enabled but no clients are registered (gateway.authorizationServer.clients) and dynamic registration is off");
    }
    if (as.acceptIdpTokens) {
      if (isProduction()) {
        issues.push({ code: "dev_only_in_production", path: "gateway.authorizationServer.acceptIdpTokens", message: "acceptIdpTokens is a migration / development option and is disabled in production" });
      } else {
        warnings.push("authorization server accepts IdP tokens directly (acceptIdpTokens: true; esc sources are unavailable on such requests)");
      }
    }
    const tokens = new TokenService({
      sealer: runtime.sealer,
      store: runtime.store,
      accessTokenTtlMs: as.accessTokenTtlSec * 1000,
      refreshTokenTtlMs: refreshTtlMs,
    });
    settings = {
      clients,
      allowDynamicRegistration: as.allowDynamicRegistration,
      tokens,
      accessTokenTtlMs: as.accessTokenTtlSec * 1000,
      ...(as.orchestratorResource !== undefined ? { orchestratorResource: as.orchestratorResource } : {}),
      ...(as.orchestratorResource !== undefined && input.orchestratorCredential !== undefined
        ? { orchestratorCredential: input.orchestratorCredential }
        : {}),
    };
    idpAdapter = new GatewayTokenIdpAdapter({
      inner: input.idpAdapter,
      tokens,
      resource: `${publicBaseUrl}${config.gateway.http.path}`,
      acceptIdpTokens: as.acceptIdpTokens,
      ...(input.warn !== undefined ? { diagnose: input.warn } : {}),
    });
  }
  const handler = new AuthHttpHandler({
    publicBaseUrl,
    mcpPath: config.gateway.http.path,
    idp: input.idpAdapter,
    login,
    sealer: runtime.sealer,
    store: runtime.store,
    ...(runtime.vault !== undefined ? { vault: runtime.vault } : {}),
    sources: runtime.sources,
    revocation,
    events: runtime.events,
    ...(settings !== undefined ? { authorizationServer: settings } : {}),
    ...(adminCredential !== undefined ? { adminCredential } : {}),
    browserSessionTtlMs: (config.gateway.credentials?.browserSessionTtlSec ?? 3600) * 1000,
    ...(input.warn !== undefined ? { warn: input.warn } : {}),
  });
  const methods = [...runtime.sources.values()].map((s) => `${s.sourceId}=${s.kind}`).join(", ");
  return {
    idpAdapter,
    handler,
    description:
      `credentials: ${methods || "(none)"}; connections page ${publicBaseUrl}/connections; ` +
      `authorization server ${as.enabled ? `on (issuer ${publicBaseUrl}, ${settings?.clients.size ?? 0} clients${as.allowDynamicRegistration ? ", dynamic registration" : ""})` : "off"}` +
      (runtime.keyDescription !== undefined ? `; vault keys ${runtime.keyDescription}` : ""),
  };
}
