/**
 * Keycloak参照実装(T-002、旧T-011)。
 *
 * セッション検証はトークンイントロスペクション(RFC 7662)で行う。
 * 署名検証をローカルで行うJWKS方式より1往復増えるが、
 * - 検証ロジックをIdPへ委譲でき(自前JWT検証の実装リスクを避ける)、
 * - IdP側でのセッション失効・ユーザー無効化が即時反映される(TM-C系)
 * ため参照実装として採用する。スループットが必要になった場合のJWKS
 * ローカル検証+失効ラグの扱いはT-004で判断する。
 *
 * 検証範囲の限界: このアダプタと同梱のE2E(e2e/keycloak)は「Keycloak発行
 * トークンを受けるモックコネクタ」までを検証する。Google Drive / Slack等の
 * 実SaaS認可経路は検証しない(実接続はT-004)。
 *
 * HTTP呼び出しはfetch注入・タイムアウト設定可(開発ルール: 外部APIは
 * 薄いラッパー越し・タイムアウト注入可能に)。
 */
import { CredentialResolvingIdpAdapter } from "./adapter.js";
import type { CredentialCacheOptions } from "./cache.js";
import {
  IdpError,
  type CredentialProvider,
  type Identity,
} from "./types.js";

export interface KeycloakIdpAdapterConfig {
  /** 例: http://localhost:8080 (末尾スラッシュなし) */
  readonly baseUrl: string;
  readonly realm: string;
  /** イントロスペクションを呼ぶconfidentialクライアント */
  readonly clientId: string;
  /** ログ出力禁止(不変条件6) */
  readonly clientSecret: string;
  /** HTTPタイムアウト(ms)。既定5000 */
  readonly timeoutMs?: number;
  /** テスト用fetch注入 */
  readonly fetchImpl?: typeof fetch;
}

interface IntrospectionResponse {
  active: boolean;
  sub?: string;
  preferred_username?: string;
  name?: string;
  exp?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

export class KeycloakIdpAdapter extends CredentialResolvingIdpAdapter {
  private readonly introspectUrl: string;
  private readonly authorizationHeader: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: KeycloakIdpAdapterConfig,
    providers: readonly CredentialProvider[],
    cacheOptions: CredentialCacheOptions = {},
  ) {
    super(providers, cacheOptions);
    this.introspectUrl = `${config.baseUrl}/realms/${encodeURIComponent(
      config.realm,
    )}/protocol/openid-connect/token/introspect`;
    this.authorizationHeader = `Basic ${Buffer.from(
      `${config.clientId}:${config.clientSecret}`,
    ).toString("base64")}`;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async authenticate(sessionToken: string): Promise<Identity> {
    if (!sessionToken) {
      throw new IdpError("unauthenticated", "missing session token");
    }
    let response: Response;
    try {
      response = await this.fetchImpl(this.introspectUrl, {
        method: "POST",
        headers: {
          authorization: this.authorizationHeader,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token: sessionToken }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // 原因(cause)にURLやリクエスト詳細が含まれうるため付け直さない
      throw new IdpError(
        "idp_unavailable",
        `keycloak introspection unreachable (realm: ${this.config.realm})`,
      );
    }
    if (!response.ok) {
      // 401/403はGateway側クライアント資格情報の問題、5xxはIdP障害。
      // いずれも利用者セッションの有効性は判定できていないので
      // unauthenticated にはしない(fail-closedだが原因を区別する)。
      throw new IdpError(
        "idp_unavailable",
        `keycloak introspection failed with status ${response.status}`,
      );
    }
    let body: IntrospectionResponse;
    try {
      body = (await response.json()) as IntrospectionResponse;
    } catch {
      // 200でも本文が空/非JSONならIdP側の異常として分類する(fail-closed)
      throw new IdpError(
        "idp_unavailable",
        "keycloak introspection returned a non-JSON response",
      );
    }
    if (!body.active || !body.sub) {
      throw new IdpError(
        "unauthenticated",
        "session token is not active per keycloak introspection",
      );
    }
    const displayName = body.name ?? body.preferred_username;
    return {
      userId: body.sub,
      ...(displayName !== undefined ? { displayName } : {}),
      session: {
        subjectToken: sessionToken,
        ...(body.exp !== undefined ? { expiresAt: body.exp * 1000 } : {}),
      },
    };
  }
}
