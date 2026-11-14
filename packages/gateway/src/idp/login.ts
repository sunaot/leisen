/**
 * 利用者のブラウザのログイン(ADR-022 決定 4・7)。接続ページと認可サーバーの /authorize が使う。
 * Gateway は IdP の OIDC クライアント(認可コード + PKCE、機密クライアント)になり、得た
 * アクセストークンを IdpAdapter.authenticate で検証して本人を確定する。
 *
 * - keycloak: 認可エンドポイントは利用者のブラウザから見える発行者(allowedIssuers の先頭、
 *   なければ `<baseUrl>/realms/<realm>`)、トークンエンドポイントは baseUrl(Gateway から到達
 *   できる URL)で組み立てる。クライアントは idp.adapter の clientId / clientSecret
 * - mock: 開発用。IdP の画面の代わりに、モックのセッショントークンを入力するフォームを出す
 *   (NODE_ENV=production では使えない)
 * トークン・コードをログ・エラーに出さない(不変条件6)。
 */
import { HttpCallError, HttpClient, isRecord, readJson } from "../credentials/http.js";
import { IdpError } from "./types.js";

export interface IdpTokens {
  /** ログ出力禁止 */
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** epoch ms。不明なら undefined */
  readonly accessExpiresAt?: number;
}

export interface IdpLogin {
  readonly kind: "oidc" | "mock";
  /** IdP の認可画面の URL(mock では undefined: Gateway がフォームを出す) */
  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string | undefined;
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<IdpTokens>;
  /** IdP のトークンを更新する。更新できなければ IdpError("unauthenticated") */
  refresh(tokens: IdpTokens): Promise<IdpTokens>;
}

export interface OidcLoginConfig {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  /** ログ出力禁止 */
  readonly clientSecret: string;
  readonly scopes?: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export class OidcLogin implements IdpLogin {
  readonly kind = "oidc" as const;
  readonly #config: OidcLoginConfig;
  readonly #http: HttpClient;
  readonly #now: () => number;

  constructor(config: OidcLoginConfig) {
    this.#config = config;
    this.#http = new HttpClient({
      ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}),
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    });
    this.#now = config.now ?? Date.now;
  }

  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    const url = new URL(this.#config.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.#config.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("scope", (this.#config.scopes ?? ["openid", "email", "profile"]).join(" "));
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async #token(form: Record<string, string>): Promise<IdpTokens> {
    const basic = Buffer.from(
      `${encodeURIComponent(this.#config.clientId)}:${encodeURIComponent(this.#config.clientSecret)}`,
    ).toString("base64");
    let response: Response;
    try {
      response = await this.#http.postForm(this.#config.tokenEndpoint, form, { authorization: `Basic ${basic}` });
    } catch (error) {
      throw new IdpError("idp_unavailable", error instanceof HttpCallError ? error.message : "IdP token request failed");
    }
    const body = await readJson(response);
    if (response.status >= 500) {
      throw new IdpError("idp_unavailable", `IdP token endpoint returned HTTP ${response.status}`);
    }
    if (!response.ok || !isRecord(body) || typeof body["access_token"] !== "string") {
      throw new IdpError("unauthenticated", "IdP rejected the token request");
    }
    const expiresIn = typeof body["expires_in"] === "number" ? body["expires_in"] : undefined;
    return {
      accessToken: body["access_token"],
      ...(typeof body["refresh_token"] === "string" ? { refreshToken: body["refresh_token"] } : {}),
      ...(expiresIn !== undefined ? { accessExpiresAt: this.#now() + expiresIn * 1000 } : {}),
    };
  }

  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<IdpTokens> {
    return this.#token({
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    });
  }

  async refresh(tokens: IdpTokens): Promise<IdpTokens> {
    if (tokens.refreshToken === undefined) {
      throw new IdpError("unauthenticated", "no IdP refresh token is held; sign in again");
    }
    const next = await this.#token({ grant_type: "refresh_token", refresh_token: tokens.refreshToken });
    // 更新トークンをローテーションしない IdP は旧トークンを使い続ける
    return next.refreshToken !== undefined || tokens.refreshToken === undefined
      ? next
      : { ...next, refreshToken: tokens.refreshToken };
  }
}

/**
 * 開発用: モック IdP のセッショントークンをそのまま IdP のトークンとして扱う。
 * フォームで入力されたトークンを exchangeCode の code として受ける。
 */
export class MockLogin implements IdpLogin {
  readonly kind = "mock" as const;

  authorizationUrl(): undefined {
    return undefined;
  }

  async exchangeCode(input: { code: string }): Promise<IdpTokens> {
    return { accessToken: input.code };
  }

  async refresh(tokens: IdpTokens): Promise<IdpTokens> {
    return tokens;
  }
}

/** keycloak の設定から OIDC の端点を組み立てる。 */
export function keycloakLoginEndpoints(config: {
  baseUrl: string;
  realm: string;
  allowedIssuers?: readonly string[] | undefined;
}): { authorizationEndpoint: string; tokenEndpoint: string } {
  const trim = (u: string) => u.replace(/\/+$/, "");
  const realmUrl = `${trim(config.baseUrl)}/realms/${encodeURIComponent(config.realm)}`;
  const publicIssuer = trim(config.allowedIssuers?.[0] ?? realmUrl);
  return {
    authorizationEndpoint: `${publicIssuer}/protocol/openid-connect/auth`,
    tokenEndpoint: `${realmUrl}/protocol/openid-connect/token`,
  };
}
