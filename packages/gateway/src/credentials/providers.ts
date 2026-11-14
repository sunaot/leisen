/**
 * 本人資格情報のプロバイダ(ADR-022 決定 1)。connectors[].auth.provider ごとに 1 つ。
 *
 * - token_vault: Token Vault から取り出し、期限切れならソースで更新して保管し直す(直列化は
 *   vault.ts)。更新トークンが無効なら行を消して source_not_connected(接続ページへ案内)
 * - esc: 要求のトークン(認可サーバーが発行した ESC。identity.session.esc)から取り出す。
 *   拒否リスト(sub_source)より前に取得したものは使わない。キャッシュしない
 * - token_exchange: 本人の IdP トークン(identity.session.subjectToken)を、呼び出しのたびに
 *   ソースのトークンへ交換する(entra_obo / rfc8693)。保管しない
 *
 * いずれも本人の資格情報だけを返し、サービスアカウント等へ代替しない(不変条件1)。
 * エラーメッセージにトークンを含めない(不変条件6)。
 */
import type { Credential } from "@leisen/connector-sdk";
import {
  IdpError,
  type CredentialProvider,
  type CredentialProviderKind,
  type Identity,
} from "../idp/types.js";
import { HttpCallError, HttpClient, isRecord, readJson, type HttpClientOptions } from "./http.js";
import { SourceOAuthError, type SourceOAuthClient } from "./oauth.js";
import type { CredentialEventSink } from "./events.js";
import type { CredentialStore, SourceTokenSet } from "./types.js";
import { VaultError, type TokenVault } from "./vault.js";

/** 期限の何 ms 前から更新するか(コネクタへ渡した直後の失効を避ける)。 */
export const REFRESH_MARGIN_MS = 60_000;

/** 0 は「失効時刻不明」(ADR-016 追補 2026-11-14)。 */
function toCredential(tokens: SourceTokenSet): Credential {
  return { kind: "oauth_bearer", accessToken: tokens.accessToken, expiresAt: tokens.accessExpiresAt ?? 0 };
}

export function needsRefresh(tokens: SourceTokenSet, now: number, marginMs = REFRESH_MARGIN_MS): boolean {
  return tokens.accessExpiresAt !== undefined && tokens.accessExpiresAt - marginMs <= now;
}

/** 未接続の案内(接続先 URL を添える。LLM・利用者に返る文言)。 */
export function notConnected(sourceId: string, connectUrl: string | undefined, how: string): IdpError {
  return new IdpError(
    "source_not_connected",
    connectUrl !== undefined
      ? `source '${sourceId}' is not connected for this user; ${how}: ${connectUrl}`
      : `source '${sourceId}' is not connected for this user; ${how}`,
  );
}

export interface TokenVaultCredentialProviderOptions {
  readonly vault: TokenVault;
  readonly oauth: SourceOAuthClient;
  /** 接続ページの URL(`<publicBaseUrl>/connections?source=<id>`) */
  readonly connectUrl?: string;
  readonly events?: CredentialEventSink;
  readonly now?: () => number;
}

export class TokenVaultCredentialProvider implements CredentialProvider {
  readonly method = "oauth_individual" as const;
  readonly kind: CredentialProviderKind = "token_vault";
  readonly sourceId: string;
  readonly #options: TokenVaultCredentialProviderOptions;
  readonly #now: () => number;

  constructor(options: TokenVaultCredentialProviderOptions) {
    this.sourceId = options.oauth.sourceId;
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  get oauth(): SourceOAuthClient {
    return this.#options.oauth;
  }

  async getCredential(identity: Identity): Promise<Credential> {
    const { vault, oauth, events } = this.#options;
    let failure: SourceOAuthError | undefined;
    let tokens: SourceTokenSet | null;
    try {
      tokens = await vault.update(identity.userId, this.sourceId, async (current) => {
        if (current === null || !needsRefresh(current, this.#now())) {
          return undefined;
        }
        try {
          return await oauth.refresh(current);
        } catch (error) {
          if (error instanceof SourceOAuthError && error.kind === "invalid_grant") {
            failure = error;
            return null; // 無効な更新トークンは消す(再接続が要る)
          }
          throw error;
        }
      });
    } catch (error) {
      if (error instanceof SourceOAuthError) {
        await events?.({
          userId: identity.userId,
          event: "refresh_failed",
          sourceId: this.sourceId,
          method: "token_vault",
          outcome: "failure",
          reason: error.kind,
        });
        throw new IdpError("idp_unavailable", `source '${this.sourceId}' token refresh failed (${error.kind})`);
      }
      if (error instanceof VaultError) {
        throw new IdpError(error.kind === "corrupt" ? "misconfigured" : "idp_unavailable", `token vault: ${error.message}`);
      }
      throw error;
    }
    if (failure !== undefined) {
      await events?.({
        userId: identity.userId,
        event: "refresh_failed",
        sourceId: this.sourceId,
        method: "token_vault",
        outcome: "failure",
        reason: "invalid_grant",
      });
    }
    if (tokens === null) {
      throw notConnected(this.sourceId, this.#options.connectUrl, "connect it at");
    }
    return toCredential(tokens);
  }
}

export interface EscCredentialProviderOptions {
  readonly sourceId: string;
  readonly store: CredentialStore;
  /** 再認可の案内(クライアントに scope=source:<id> で再ログインさせる。決定 7) */
  readonly reauthorizeHint?: string;
  readonly now?: () => number;
}

/** ESC の (sub, source) 拒否リストのキー。 */
export function subSourceKey(userId: string, sourceId: string): string {
  return JSON.stringify([userId, sourceId]);
}

export class EscCredentialProvider implements CredentialProvider {
  readonly method = "oauth_individual" as const;
  readonly kind: CredentialProviderKind = "esc";
  readonly cacheable = false;
  readonly sourceId: string;
  readonly #options: EscCredentialProviderOptions;
  readonly #now: () => number;

  constructor(options: EscCredentialProviderOptions) {
    this.sourceId = options.sourceId;
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async getCredential(identity: Identity): Promise<Credential> {
    const how =
      this.#options.reauthorizeHint ??
      `sign in to Leisen again and connect the source on the consent screen (scope source:${this.sourceId})`;
    const tokens = identity.session.esc?.sources[this.sourceId];
    if (tokens === undefined) {
      throw notConnected(this.sourceId, undefined, how);
    }
    const revokedBefore = await this.#options.store.denial("sub_source", subSourceKey(identity.userId, this.sourceId));
    if (revokedBefore !== undefined && tokens.obtainedAt < revokedBefore) {
      throw notConnected(this.sourceId, undefined, how);
    }
    if (tokens.accessExpiresAt !== undefined && tokens.accessExpiresAt <= this.#now()) {
      // 認可サーバーはアクセストークンの期限をソースの期限以下にする(決定 5)ため通常は来ない。
      // 来たらクライアントに更新させる
      throw new IdpError("unauthenticated", "the presented token carries an expired source credential; refresh it");
    }
    return toCredential(tokens);
  }
}

export type TokenExchangeKind = "entra_obo" | "rfc8693";

export interface TokenExchangeConfig {
  readonly sourceId: string;
  readonly kind: TokenExchangeKind;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  /** ログ出力禁止(不変条件6) */
  readonly clientSecret: string;
  /** entra_obo では必須(例: https://graph.microsoft.com/.default) */
  readonly scope?: string;
  /** rfc8693 の audience / resource(RFC 8693 §2.1) */
  readonly audience?: string;
  readonly resource?: string;
  /** rfc8693 のクライアント認証。既定 client_secret_basic */
  readonly clientAuth?: "client_secret_basic" | "client_secret_post";
}

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

export class TokenExchangeCredentialProvider implements CredentialProvider {
  readonly method = "token_exchange" as const;
  readonly kind: CredentialProviderKind = "token_exchange";
  readonly sourceId: string;
  readonly #config: TokenExchangeConfig;
  readonly #http: HttpClient;
  readonly #now: () => number;
  readonly #events: CredentialEventSink | undefined;

  constructor(
    config: TokenExchangeConfig,
    options: HttpClientOptions & { now?: () => number; events?: CredentialEventSink } = {},
  ) {
    if (config.kind === "entra_obo" && (config.scope === undefined || config.scope === "")) {
      throw new IdpError("misconfigured", `token_exchange (entra_obo) for '${config.sourceId}' requires scope`);
    }
    this.sourceId = config.sourceId;
    this.#config = config;
    this.#http = new HttpClient(options);
    this.#now = options.now ?? Date.now;
    this.#events = options.events;
  }

  #form(subjectToken: string): { form: Record<string, string>; headers: Record<string, string> } {
    const c = this.#config;
    if (c.kind === "entra_obo") {
      return {
        form: {
          grant_type: JWT_BEARER_GRANT,
          client_id: c.clientId,
          client_secret: c.clientSecret,
          assertion: subjectToken,
          scope: c.scope as string,
          requested_token_use: "on_behalf_of",
        },
        headers: {},
      };
    }
    const form: Record<string, string> = {
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: subjectToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      requested_token_type: ACCESS_TOKEN_TYPE,
      ...(c.audience !== undefined ? { audience: c.audience } : {}),
      ...(c.resource !== undefined ? { resource: c.resource } : {}),
      ...(c.scope !== undefined ? { scope: c.scope } : {}),
    };
    if (c.clientAuth === "client_secret_post") {
      return { form: { ...form, client_id: c.clientId, client_secret: c.clientSecret }, headers: {} };
    }
    const basic = Buffer.from(
      `${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.clientSecret)}`,
    ).toString("base64");
    return { form, headers: { authorization: `Basic ${basic}` } };
  }

  async getCredential(identity: Identity): Promise<Credential> {
    const { form, headers } = this.#form(identity.session.subjectToken);
    let response: Response;
    try {
      response = await this.#http.postForm(this.#config.tokenEndpoint, form, headers);
    } catch (error) {
      throw new IdpError(
        "idp_unavailable",
        `token exchange for '${this.sourceId}' failed: ${error instanceof HttpCallError ? error.message : "request failed"}`,
      );
    }
    const body = await readJson(response);
    if (!response.ok || !isRecord(body) || typeof body["access_token"] !== "string") {
      if (response.status >= 500) {
        throw new IdpError("idp_unavailable", `token exchange for '${this.sourceId}' returned HTTP ${response.status}`);
      }
      const code =
        isRecord(body) && typeof body["error"] === "string"
          ? body["error"].toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 48)
          : "unknown";
      await this.#events?.({
        userId: identity.userId,
        event: "refresh_failed",
        sourceId: this.sourceId,
        method: "token_exchange",
        outcome: "failure",
        reason: code,
      });
      // 同意・条件付きアクセスの不足(interaction_required / consent_required / invalid_grant)は
      // 本人が IdP 側で対応する事象。未接続として案内する
      throw new IdpError(
        "source_not_connected",
        `token exchange for '${this.sourceId}' was rejected (${code}); the identity provider requires consent or sign-in for this source`,
      );
    }
    const expiresIn = typeof body["expires_in"] === "number" ? body["expires_in"] : Number(body["expires_in"]);
    return {
      kind: "oauth_bearer",
      accessToken: body["access_token"],
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? this.#now() + expiresIn * 1000 : 0,
    };
  }
}
