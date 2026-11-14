/**
 * ソースの OAuth クライアント(ADR-022 決定 7・8。接続ページ・Token Vault・ESC が使う)。
 *
 * - 機密クライアント: client secret は Gateway が持ち(環境変数)、リダイレクト先は
 *   `<publicBaseUrl>/connections/callback` に固定する。利用者がアプリを流用できないことで
 *   ソース側のアプリ許可リストを成り立たせる(docs/direct-connection.md §2)
 * - PKCE(S256)を常に送る。state の生成・検証は接続ページ(auth-server/)が行う
 * - 本人照合(決定 8)用に、ソース側アカウントの検証済みメールアドレスを取得する。
 *   Slack の user ID は users.info の照会にだけ使い、戻り値・保管に含めない(不変条件7)
 * - プリセット: github / google / slack / esa。それ以外は custom(端点を設定で与える)
 * - resource(RFC 8707): 受け手を指定するソース(リモート MCP サーバー。esa は https://mcp.esa.io)
 *   では認可要求・コード交換・更新の 3 つに同じ値を載せる(ADR-023)
 * - トークン・コード・応答本文をログ・エラーに出さない(不変条件6)。エラーは分類と
 *   OAuth のエラーコード(英小文字・数字・_ に正規化したもの)だけ
 */
import { HttpCallError, HttpClient, isRecord, readJson, type HttpClientOptions } from "./http.js";
import type { SourceTokenSet } from "./types.js";

export type OAuthPreset = "github" | "google" | "slack" | "esa" | "custom";

export interface OAuthEndpoints {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  /** RFC 7009 の失効エンドポイント(github / slack はプリセット固有の方式) */
  readonly revocationEndpoint?: string;
  /** custom の本人照合: { email, email_verified } を返す OIDC の userinfo */
  readonly userinfoEndpoint?: string;
  /** github の API の基点(GitHub Enterprise Server 用)。既定 https://api.github.com */
  readonly apiBaseUrl?: string;
}

export interface SourceOAuthConfig {
  readonly sourceId: string;
  readonly preset: OAuthPreset;
  readonly clientId: string;
  /** ログ出力禁止(不変条件6) */
  readonly clientSecret: string;
  readonly scopes: readonly string[];
  /** プリセットの端点の上書き(custom では必須) */
  readonly endpoints?: Partial<OAuthEndpoints>;
  /** 本人照合でメールアドレスを取得するか(identityCheck: email) */
  readonly fetchIdentity: boolean;
  /**
   * RFC 8707 の resource(トークンの受け手)。省略時はプリセットの既定(esa は
   * https://mcp.esa.io)。既定のないプリセットでは送らない
   */
  readonly resource?: string;
  /**
   * 本人照合のメールアドレスの取得をプリセットの既定(userinfo 等)から差し替える。
   * esa は必須(MCP の esa_get_team_members で引く。credentials/esa-identity.ts、ADR-023)
   */
  readonly identityLookup?: (accessToken: string) => Promise<string[]>;
}

export class SourceOAuthError extends Error {
  constructor(
    /** invalid_grant: 更新トークンが無効(再接続が要る)。unavailable: 到達不能・5xx */
    public readonly kind: "invalid_grant" | "unavailable" | "rejected" | "invalid_response",
    message: string,
  ) {
    super(message);
    this.name = "SourceOAuthError";
  }
}

const PRESET_ENDPOINTS: Record<Exclude<OAuthPreset, "custom">, OAuthEndpoints> = {
  github: {
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    apiBaseUrl: "https://api.github.com",
  },
  google: {
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    revocationEndpoint: "https://oauth2.googleapis.com/revoke",
    userinfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
  },
  slack: {
    authorizationEndpoint: "https://slack.com/oauth/v2/authorize",
    tokenEndpoint: "https://slack.com/api/oauth.v2.access",
    revocationEndpoint: "https://slack.com/api/auth.revoke",
    apiBaseUrl: "https://slack.com/api",
  },
  // esa のリモート MCP サーバー(https://mcp.esa.io)の認可サーバー(RFC 9728 の
  // authorization_servers)。端点は https://api.esa.io/.well-known/oauth-authorization-server
  // で確認した(ADR-023)。本人照合は MCP 経由(identityLookup。mcp スコープのトークンでは
  // REST の GET /v1/user が 403 になるため)
  esa: {
    authorizationEndpoint: "https://api.esa.io/oauth/authorize",
    tokenEndpoint: "https://api.esa.io/oauth/token",
    revocationEndpoint: "https://api.esa.io/oauth/revoke",
  },
};

/** プリセットごとの RFC 8707 resource の既定。 */
const PRESET_RESOURCES: Partial<Record<OAuthPreset, string>> = {
  esa: "https://mcp.esa.io",
};

/** 本人照合に要るスコープ(プリセットごと。設定のスコープに足す)。 */
const IDENTITY_SCOPES: Record<OAuthPreset, readonly string[]> = {
  github: [],
  google: ["openid", "email"],
  slack: ["users:read", "users:read.email"],
  esa: [],
  custom: [],
};

export function resolveEndpoints(preset: OAuthPreset, overrides: Partial<OAuthEndpoints> = {}): OAuthEndpoints {
  const base = preset === "custom" ? undefined : PRESET_ENDPOINTS[preset];
  const authorizationEndpoint = overrides.authorizationEndpoint ?? base?.authorizationEndpoint;
  const tokenEndpoint = overrides.tokenEndpoint ?? base?.tokenEndpoint;
  if (authorizationEndpoint === undefined || tokenEndpoint === undefined) {
    throw new Error("custom OAuth sources require authorizationEndpoint and tokenEndpoint");
  }
  const revocationEndpoint = overrides.revocationEndpoint ?? base?.revocationEndpoint;
  const userinfoEndpoint = overrides.userinfoEndpoint ?? base?.userinfoEndpoint;
  const apiBaseUrl = overrides.apiBaseUrl ?? base?.apiBaseUrl;
  return {
    authorizationEndpoint,
    tokenEndpoint,
    ...(revocationEndpoint !== undefined ? { revocationEndpoint } : {}),
    ...(userinfoEndpoint !== undefined ? { userinfoEndpoint } : {}),
    ...(apiBaseUrl !== undefined ? { apiBaseUrl: apiBaseUrl.replace(/\/+$/, "") } : {}),
  };
}

/** OAuth のエラーコードを理由コードに正規化する(値をそのまま返さない)。 */
function oauthErrorCode(body: unknown): string {
  const raw = isRecord(body) && typeof body["error"] === "string" ? body["error"] : "unknown";
  return raw.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 48) || "unknown";
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

export interface CodeExchangeResult {
  readonly tokens: SourceTokenSet;
  /** ソース側アカウントの検証済みメールアドレス(本人照合用。保管しない) */
  readonly verifiedEmails: readonly string[];
}

export class SourceOAuthClient {
  readonly sourceId: string;
  readonly preset: OAuthPreset;
  readonly endpoints: OAuthEndpoints;
  /** RFC 8707 の resource(送らないソースは undefined) */
  readonly resource: string | undefined;
  readonly #config: SourceOAuthConfig;
  readonly #http: HttpClient;
  readonly #now: () => number;

  constructor(config: SourceOAuthConfig, options: HttpClientOptions & { now?: () => number } = {}) {
    this.sourceId = config.sourceId;
    this.preset = config.preset;
    this.endpoints = resolveEndpoints(config.preset, config.endpoints);
    if (config.preset === "custom" && config.fetchIdentity && this.endpoints.userinfoEndpoint === undefined) {
      throw new Error("custom OAuth sources with identityCheck: email require userinfoEndpoint");
    }
    if (config.preset === "esa" && config.fetchIdentity && config.identityLookup === undefined) {
      throw new Error("esa OAuth sources with identityCheck: email require an identity lookup via the esa MCP server");
    }
    this.resource = config.resource ?? PRESET_RESOURCES[config.preset];
    this.#config = config;
    this.#http = new HttpClient(options);
    this.#now = options.now ?? Date.now;
  }

  /** 要求するスコープ(本人照合に要るものを足す)。 */
  get scopes(): readonly string[] {
    const extra = this.#config.fetchIdentity ? IDENTITY_SCOPES[this.preset] : [];
    return [...new Set([...this.#config.scopes, ...extra])];
  }

  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    const url = new URL(this.endpoints.authorizationEndpoint);
    const params = url.searchParams;
    params.set("client_id", this.#config.clientId);
    params.set("redirect_uri", input.redirectUri);
    params.set("state", input.state);
    params.set("code_challenge", input.codeChallenge);
    params.set("code_challenge_method", "S256");
    const scope = this.scopes.join(this.preset === "slack" ? "," : " ");
    if (this.preset === "slack") {
      // 本人のトークン(user token)だけを求める。bot のスコープは求めない
      params.set("user_scope", scope);
    } else {
      params.set("response_type", "code");
      if (scope !== "") {
        params.set("scope", scope);
      }
    }
    if (this.resource !== undefined) {
      params.set("resource", this.resource);
    }
    if (this.preset === "google") {
      params.set("access_type", "offline");
      params.set("prompt", "consent");
      params.set("include_granted_scopes", "true");
    }
    return url.toString();
  }

  #clientAuth(): { form: Record<string, string>; headers: Record<string, string> } {
    // github / slack / google はいずれも本文の client_secret を受ける
    return {
      form: { client_id: this.#config.clientId, client_secret: this.#config.clientSecret },
      headers: {},
    };
  }

  async #tokenRequest(form: Record<string, string>, previous?: SourceTokenSet): Promise<SourceTokenSet> {
    const auth = this.#clientAuth();
    let response: Response;
    try {
      const resource = this.resource !== undefined ? { resource: this.resource } : {};
      response = await this.#http.postForm(this.endpoints.tokenEndpoint, { ...form, ...resource, ...auth.form }, auth.headers);
    } catch (error) {
      throw new SourceOAuthError(
        "unavailable",
        error instanceof HttpCallError ? error.message : "token endpoint request failed",
      );
    }
    const body = await readJson(response);
    if (response.status >= 500) {
      throw new SourceOAuthError("unavailable", `token endpoint returned HTTP ${response.status}`);
    }
    // Slack は 200 で ok:false、GitHub も 200 で error を返す
    const failed =
      !response.ok ||
      !isRecord(body) ||
      typeof body["error"] === "string" ||
      (this.preset === "slack" && body["ok"] !== true);
    if (failed) {
      const code = oauthErrorCode(body);
      const invalidGrant =
        code === "invalid_grant" ||
        code === "bad_refresh_token" ||
        code === "invalid_refresh_token" ||
        code === "token_revoked" ||
        code === "token_expired";
      throw new SourceOAuthError(
        invalidGrant ? "invalid_grant" : "rejected",
        `token endpoint rejected the request (HTTP ${response.status}, ${code})`,
      );
    }
    const tokenRecord =
      this.preset === "slack" && isRecord(body["authed_user"]) ? body["authed_user"] : body;
    const accessToken = tokenRecord["access_token"];
    if (typeof accessToken !== "string" || accessToken === "") {
      throw new SourceOAuthError("invalid_response", "token endpoint returned no user access token");
    }
    const now = this.#now();
    const expiresIn = numberField(tokenRecord, "expires_in");
    const refreshExpiresIn = numberField(tokenRecord, "refresh_token_expires_in");
    const refreshToken =
      typeof tokenRecord["refresh_token"] === "string" && tokenRecord["refresh_token"] !== ""
        ? tokenRecord["refresh_token"]
        : previous?.refreshToken; // ローテーションしないソースは旧トークンを保つ
    const scopeValue = tokenRecord["scope"];
    const scopes =
      typeof scopeValue === "string" && scopeValue !== ""
        ? scopeValue.split(/[ ,]+/).filter((s) => s !== "")
        : previous?.scopes;
    return {
      accessToken,
      ...(expiresIn !== undefined ? { accessExpiresAt: now + expiresIn * 1000 } : {}),
      ...(refreshToken !== undefined ? { refreshToken } : {}),
      ...(refreshExpiresIn !== undefined
        ? { refreshExpiresAt: now + refreshExpiresIn * 1000 }
        : previous?.refreshExpiresAt !== undefined && refreshToken === previous.refreshToken
          ? { refreshExpiresAt: previous.refreshExpiresAt }
          : {}),
      ...(scopes !== undefined ? { scopes } : {}),
      obtainedAt: now,
    };
  }

  /** 認可コードをトークンに交換し、本人照合用のメールアドレスを取得する。 */
  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<CodeExchangeResult> {
    const form: Record<string, string> = {
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    };
    if (this.preset !== "slack") {
      form["grant_type"] = "authorization_code";
    }
    const raw = await this.#rawCodeExchange(form);
    let verifiedEmails: string[] = [];
    if (this.#config.fetchIdentity) {
      try {
        verifiedEmails =
          this.#config.identityLookup !== undefined
            ? await this.#config.identityLookup(raw.tokens.accessToken)
            : await this.#fetchVerifiedEmails(raw.tokens, raw.slackUserId);
      } catch (error) {
        // 本人照合ができなかったトークンは使わない。ソースへ失効を依頼して捨てる
        await this.revoke(raw.tokens);
        throw error;
      }
    }
    return { tokens: raw.tokens, verifiedEmails };
  }

  async #rawCodeExchange(form: Record<string, string>): Promise<{ tokens: SourceTokenSet; slackUserId?: string }> {
    if (this.preset !== "slack") {
      return { tokens: await this.#tokenRequest(form) };
    }
    // Slack は authed_user.id を本人照合の照会にだけ使う。tokens には入れない(不変条件7)
    const auth = this.#clientAuth();
    let response: Response;
    try {
      response = await this.#http.postForm(this.endpoints.tokenEndpoint, { ...form, ...auth.form });
    } catch (error) {
      throw new SourceOAuthError("unavailable", error instanceof HttpCallError ? error.message : "token endpoint request failed");
    }
    const body = await readJson(response);
    if (!response.ok || !isRecord(body) || body["ok"] !== true || !isRecord(body["authed_user"])) {
      if (response.status >= 500) {
        throw new SourceOAuthError("unavailable", `token endpoint returned HTTP ${response.status}`);
      }
      throw new SourceOAuthError("rejected", `token endpoint rejected the request (HTTP ${response.status}, ${oauthErrorCode(body)})`);
    }
    const authedUser = body["authed_user"];
    const userId = typeof authedUser["id"] === "string" ? authedUser["id"] : undefined;
    const tokens = await this.#tokensFromRecord(authedUser);
    return userId !== undefined ? { tokens, slackUserId: userId } : { tokens };
  }

  async #tokensFromRecord(record: Record<string, unknown>): Promise<SourceTokenSet> {
    const accessToken = record["access_token"];
    if (typeof accessToken !== "string" || accessToken === "") {
      throw new SourceOAuthError("invalid_response", "token endpoint returned no user access token");
    }
    const now = this.#now();
    const expiresIn = numberField(record, "expires_in");
    const scope = record["scope"];
    return {
      accessToken,
      ...(expiresIn !== undefined ? { accessExpiresAt: now + expiresIn * 1000 } : {}),
      ...(typeof record["refresh_token"] === "string" && record["refresh_token"] !== ""
        ? { refreshToken: record["refresh_token"] }
        : {}),
      ...(typeof scope === "string" && scope !== "" ? { scopes: scope.split(/[ ,]+/) } : {}),
      obtainedAt: now,
    };
  }

  /** 更新トークンでアクセストークンを更新する(更新トークンがなければ invalid_grant)。 */
  async refresh(tokens: SourceTokenSet): Promise<SourceTokenSet> {
    if (tokens.refreshToken === undefined) {
      throw new SourceOAuthError("invalid_grant", "access token expired and no refresh token is held");
    }
    return this.#tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refreshToken }, tokens);
  }

  /**
   * ソースへ失効を依頼する(本人の解除・利用停止。ベストエフォート)。依頼を受け付けられた
   * (または既に無効だった)なら true
   */
  async revoke(tokens: SourceTokenSet): Promise<boolean> {
    try {
      switch (this.preset) {
        case "github": {
          // GitHub: DELETE /applications/{client_id}/token(Basic 認証 = アプリの資格情報)
          const basic = Buffer.from(`${this.#config.clientId}:${this.#config.clientSecret}`).toString("base64");
          const response = await this.#http.request(
            `${this.endpoints.apiBaseUrl ?? "https://api.github.com"}/applications/${encodeURIComponent(this.#config.clientId)}/token`,
            {
              method: "DELETE",
              headers: {
                authorization: `Basic ${basic}`,
                accept: "application/vnd.github+json",
                "content-type": "application/json",
              },
              body: JSON.stringify({ access_token: tokens.accessToken }),
            },
          );
          return response.status === 204 || response.status === 404 || response.status === 422;
        }
        case "slack": {
          const response = await this.#http.request(this.endpoints.revocationEndpoint ?? "https://slack.com/api/auth.revoke", {
            method: "POST",
            headers: { authorization: `Bearer ${tokens.accessToken}` },
          });
          const body = await readJson(response);
          return isRecord(body) && (body["ok"] === true || body["error"] === "invalid_auth" || body["error"] === "token_revoked");
        }
        default: {
          if (this.endpoints.revocationEndpoint === undefined) {
            return false;
          }
          // RFC 7009: 更新トークンを失効させれば、対応するアクセストークンも失効する(Google)
          const response = await this.#http.postForm(this.endpoints.revocationEndpoint, {
            token: tokens.refreshToken ?? tokens.accessToken,
            ...this.#clientAuth().form,
          });
          return response.ok || response.status === 400;
        }
      }
    } catch {
      return false;
    }
  }

  async #fetchVerifiedEmails(tokens: SourceTokenSet, slackUserId?: string): Promise<string[]> {
    const bearer = { authorization: `Bearer ${tokens.accessToken}`, accept: "application/json" };
    let response: Response;
    try {
      switch (this.preset) {
        case "github":
          response = await this.#http.request(`${this.endpoints.apiBaseUrl ?? "https://api.github.com"}/user/emails`, {
            headers: { ...bearer, accept: "application/vnd.github+json" },
          });
          break;
        case "slack":
          if (slackUserId === undefined) {
            return [];
          }
          response = await this.#http.request(
            `${this.endpoints.apiBaseUrl ?? "https://slack.com/api"}/users.info?user=${encodeURIComponent(slackUserId)}`,
            { headers: bearer },
          );
          break;
        default:
          response = await this.#http.request(this.endpoints.userinfoEndpoint as string, { headers: bearer });
      }
    } catch (error) {
      throw new SourceOAuthError("unavailable", error instanceof HttpCallError ? error.message : "identity lookup failed");
    }
    const body = await readJson(response);
    if (!response.ok) {
      throw new SourceOAuthError(response.status >= 500 ? "unavailable" : "rejected", `identity lookup returned HTTP ${response.status}`);
    }
    return extractVerifiedEmails(this.preset, body);
  }
}

/** プリセットごとの応答から検証済みのメールアドレスを取り出す(小文字化)。 */
export function extractVerifiedEmails(preset: OAuthPreset, body: unknown): string[] {
  const out: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.includes("@")) {
      out.push(value.trim().toLowerCase());
    }
  };
  if (preset === "github") {
    if (Array.isArray(body)) {
      for (const entry of body) {
        if (isRecord(entry) && entry["verified"] === true) {
          push(entry["email"]);
        }
      }
    }
    return out;
  }
  if (preset === "slack") {
    // Slack はワークスペースが確認したメールアドレスだけを返す
    if (isRecord(body) && body["ok"] === true && isRecord(body["user"]) && isRecord(body["user"]["profile"])) {
      push(body["user"]["profile"]["email"]);
    }
    return out;
  }
  if (isRecord(body) && (body["email_verified"] === true || body["email_verified"] === "true")) {
    if (preset === "google") {
      // 個人の Google アカウント(会社のメールアドレスで作ったものを含む)を除く: Workspace の
      // アカウントだけが持つ hd(ホストドメイン)がメールアドレスのドメインと一致すること
      const email = typeof body["email"] === "string" ? body["email"].toLowerCase() : "";
      const hd = typeof body["hd"] === "string" ? body["hd"].toLowerCase() : undefined;
      if (hd === undefined || !email.endsWith(`@${hd}`)) {
        return out;
      }
    }
    push(body["email"]);
  }
  return out;
}

/** 本人照合(ADR-022 決定 8): IdP のメールアドレスがソース側の検証済みの一覧にあるか。 */
export function emailMatches(idpEmail: string | undefined, verifiedEmails: readonly string[]): boolean {
  if (idpEmail === undefined || idpEmail === "") {
    return false;
  }
  return verifiedEmails.includes(idpEmail.trim().toLowerCase());
}
