/**
 * 接続ページと MCP 認可サーバーの HTTP ハンドラ(ADR-022 決定 4〜8)。
 *
 * 面:
 * - ブラウザのログイン: GET /login → IdP(OIDC、PKCE)→ GET /login/callback。開発用のモック IdP では
 *   POST /login/mock のフォーム。ログインの state は Gateway の鍵で封じ、ブラウザの nonce Cookie に
 *   結び付ける(ログイン CSRF の防止)。セッションは封じた Cookie(HttpOnly、SameSite=Lax)
 * - 接続ページ(token_vault): GET /connections、POST /connections/start → ソースの OAuth →
 *   GET /connections/callback、POST /connections/disconnect。フォームは CSRF トークン必須
 * - 認可サーバー(gateway.authorizationServer.enabled): RFC 9728 / 8414 のメタデータ、GET /authorize
 *   (PKCE S256 必須、RFC 8707 の resource)→ IdP ログイン → 同意画面(esc のソースを接続)→
 *   POST /authorize/decision、POST /token(authorization_code / refresh_token / token-exchange)、
 *   POST /revoke(RFC 7009)、POST /register(RFC 7591。allowDynamicRegistration のときだけ)
 * - 管理: POST /admin/deprovision(運用者の資格情報。利用停止の通知)
 *
 * 状態: /authorize の途中(IdP ログインからコード発行まで、最長 10 分)の取引だけをプロセス内の
 * メモリに置く(IdP・ソースのトークンを含むため Cookie に収まらない。永続化しない)。複数レプリカでは
 * スティッキーセッションが要る(docs/install.md)。それ以外は封じたトークンと状態 DB の拒否リスト。
 *
 * エラー応答にトークン・コード・IdP / ソース由来の文言を含めない(不変条件6)。監査は資格情報の
 * 事象として記録する(決定 9)。
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CredentialEventSink } from "../credentials/events.js";
import { emailMatches, SourceOAuthError, type SourceOAuthClient } from "../credentials/oauth.js";
import { needsRefresh, subSourceKey } from "../credentials/providers.js";
import type { CredentialRevocation } from "../credentials/revocation.js";
import type { CredentialStore, SourceTokenSet } from "../credentials/types.js";
import type { TokenVault } from "../credentials/vault.js";
import type { IdpLogin, IdpTokens } from "../idp/login.js";
import { IdpError, type CredentialProviderKind, type Identity, type IdpAdapter } from "../idp/types.js";
import {
  connectionsPage,
  consentPage,
  messagePage,
  mockLoginPage,
  type ConnectionRow,
  type ConsentSourceRow,
} from "./pages.js";
import { isValidCodeVerifier, pkceChallenge, randomId, safeEqual, SealError, type Sealer } from "./seal.js";
import { TokenRejected, type GrantClaims, type TokenService } from "./tokens.js";

/** 認可サーバーの scope。mcp は既定、source:<id> は esc のソースの接続を求める(step-up)。 */
export const MCP_SCOPE = "mcp";
export const SOURCE_SCOPE_PREFIX = "source:";
export const ORCHESTRATOR_CLIENT_ID = "leisen-orchestrator";
const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const TX_TTL_MS = 10 * 60_000;
const MAX_TX = 10_000;
/** ログイン済みの利用者 1 人あたりの進行中の取引の上限 */
const MAX_TX_PER_USER = 20;
const MAX_FORM_BYTES = 64 * 1024;

export interface ConfiguredSource {
  readonly sourceId: string;
  readonly kind: CredentialProviderKind;
  readonly oauth?: SourceOAuthClient;
  readonly identityCheck: "email" | "none";
}

export interface RegisteredClient {
  readonly clientId: string;
  readonly name?: string;
  readonly redirectUris: readonly string[];
  /** 機密クライアントの secret(ログ出力禁止)。undefined なら公開クライアント */
  readonly secret?: string;
  /** resource のない認可要求の受け手 */
  readonly defaultResource?: string;
}

export interface AuthorizationServerSettings {
  readonly clients: ReadonlyMap<string, RegisteredClient>;
  readonly allowDynamicRegistration: boolean;
  readonly tokens: TokenService;
  /** Orchestrator の resource(token-exchange の subject の受け手) */
  readonly orchestratorResource?: string;
  /** Orchestrator の資格情報(token-exchange のクライアント認証。ログ出力禁止) */
  readonly orchestratorCredential?: string;
  /** esc のソースのトークンを更新する余裕(アクセストークンの有効期間) */
  readonly accessTokenTtlMs: number;
}

export interface AuthHttpOptions {
  readonly publicBaseUrl: string;
  readonly mcpPath: string;
  /** IdP のトークンを検証する(ブラウザのログイン・リフレッシュ時の再確認) */
  readonly idp: IdpAdapter;
  readonly login: IdpLogin;
  readonly sealer: Sealer;
  readonly store: CredentialStore;
  readonly vault?: TokenVault;
  readonly sources: ReadonlyMap<string, ConfiguredSource>;
  readonly revocation: CredentialRevocation;
  readonly events: CredentialEventSink;
  readonly authorizationServer?: AuthorizationServerSettings;
  /** 管理 API の資格情報(ログ出力禁止)。undefined なら /admin は 404 */
  readonly adminCredential?: string;
  readonly browserSessionTtlMs: number;
  readonly now?: () => number;
  readonly warn?: (message: string) => void;
}

interface BrowserSession {
  readonly iat: number;
  readonly sub: string;
  readonly email?: string;
  readonly name?: string;
  readonly csrf: string;
  readonly exp: number;
}

/** /authorize の要求(IdP ログインまではサーバーに置かず、封じた state に入れて運ぶ)。 */
interface AuthorizeRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state?: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly requestedScope: readonly string[];
}

interface AuthorizeTx {
  readonly id: string;
  readonly createdAt: number;
  readonly csrf: string;
  readonly client: RegisteredClient;
  readonly redirectUri: string;
  readonly state?: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly requestedScope: readonly string[];
  readonly expiresAt: number;
  identity?: Identity;
  idp?: IdpTokens;
  readonly src: Record<string, SourceTokenSet>;
}

type StatePayload =
  | { readonly k: "login"; readonly ret: string; readonly ver: string; readonly bnd: string; readonly az?: AuthorizeRequest; readonly exp: number }
  | {
      readonly k: "connect";
      readonly src: string;
      readonly ver: string;
      readonly sub: string;
      readonly bnd: string;
      readonly tx?: string;
      readonly exp: number;
    };

const STATE_TTL_MS = 10 * 60_000;

function hashBinding(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url").slice(0, 32);
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
  }
  return cookies;
}

/** ループバック以外は https を要求する(OAuth 2.1 §2.3.1 / RFC 8252 §7.3)。 */
export function isAllowedRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash !== "") {
    return false;
  }
  if (url.protocol === "https:") {
    return true;
  }
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
}

/** 同じオリジン内の相対パスだけを戻り先に許す(オープンリダイレクトの防止)。 */
function safeReturnPath(value: string | null | undefined, fallback: string): string {
  // 戻り先は接続ページ配下だけ(制御文字・タブを含むものはブラウザが除いて別オリジンに解釈しうる)
  if (value === null || value === undefined || !/^\/connections(?:[/?][\x21-\x7e]*)?$/.test(value)) {
    return fallback;
  }
  return value;
}

async function readBody(req: IncomingMessage, maxBytes = MAX_FORM_BYTES): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > maxBytes) {
      return undefined;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class AuthHttpHandler {
  readonly #o: AuthHttpOptions;
  readonly #now: () => number;
  readonly #tx = new Map<string, AuthorizeTx>();
  readonly #secure: boolean;
  readonly #sessionCookie: string;
  readonly #nonceCookie: string;
  readonly #txCookie: string;

  constructor(options: AuthHttpOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#secure = options.publicBaseUrl.startsWith("https:");
    // https では __Host- 接頭辞(Secure・Path=/・Domain なしを強制)
    const prefix = this.#secure ? "__Host-" : "";
    this.#sessionCookie = `${prefix}leisen_session`;
    this.#nonceCookie = `${prefix}leisen_login`;
    this.#txCookie = `${prefix}leisen_tx`;
  }

  /** Gateway の MCP エンドポイントの URL(保護リソースの resource)。 */
  get resource(): string {
    return `${this.#o.publicBaseUrl}${this.#o.mcpPath}`;
  }

  /** 401 の WWW-Authenticate に添える保護リソースメタデータの URL(RFC 9728 §5.1)。 */
  get resourceMetadataUrl(): string {
    return `${this.#o.publicBaseUrl}/.well-known/oauth-protected-resource${this.#o.mcpPath}`;
  }

  get authorizationServerEnabled(): boolean {
    return this.#o.authorizationServer !== undefined;
  }

  /** esc のソース ID(step-up の判定に使う)。 */
  isEscSource(sourceId: string): boolean {
    return this.#o.sources.get(sourceId)?.kind === "esc";
  }

  /** このハンドラが受け持つパスか。 */
  handles(path: string): boolean {
    if (path === "/login" || path === "/login/callback" || path === "/login/mock" || path === "/logout") return true;
    if (path === "/connections" || path.startsWith("/connections/")) return true;
    if (path === "/admin/deprovision") return true;
    if (path.startsWith("/.well-known/oauth-")) return this.authorizationServerEnabled;
    if (path === "/authorize" || path.startsWith("/authorize/") || path === "/token" || path === "/revoke" || path === "/register") {
      return this.authorizationServerEnabled;
    }
    return false;
  }

  async handle(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> {
    const method = req.method ?? "GET";
    try {
      switch (`${method} ${path}`) {
        case "GET /login":
          return this.#startLogin(req, res, safeReturnPath(query.get("return"), "/connections"));
        case "POST /login/mock":
          return await this.#mockLogin(req, res);
        case "GET /login/callback":
          return await this.#loginCallback(req, res, query);
        case "POST /logout":
          return await this.#logout(req, res);
        case "GET /connections":
          return await this.#connections(req, res, query);
        case "POST /connections/start":
          return await this.#connectStart(req, res);
        case "GET /connections/callback":
          return await this.#connectCallback(req, res, query);
        case "POST /connections/disconnect":
          return await this.#disconnect(req, res);
        case "POST /admin/deprovision":
          return await this.#deprovision(req, res);
        case "GET /authorize":
          return this.#authorize(req, res, query);
        case "GET /authorize/consent":
          return this.#consent(req, res, query.get("tx") ?? "");
        case "POST /authorize/connect":
          return await this.#authorizeConnect(req, res);
        case "POST /authorize/decision":
          return await this.#decision(req, res);
        case "POST /token":
          return await this.#token(req, res);
        case "POST /revoke":
          return await this.#revoke(req, res);
        case "POST /register":
          return await this.#register(req, res);
        default:
          break;
      }
      if (method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
        return this.#json(res, 200, this.protectedResourceMetadata());
      }
      if (method === "GET" && path === "/.well-known/oauth-authorization-server") {
        return this.#json(res, 200, this.authorizationServerMetadata());
      }
      this.#html(res, 404, messagePage("見つかりません", "このページはありません。"));
    } catch (error) {
      this.#o.warn?.(`auth endpoint ${method} ${path} failed (${error instanceof Error ? error.name : "unknown"})`);
      if (!res.headersSent) {
        this.#html(res, 500, messagePage("エラー", "処理中にエラーが発生しました。時間をおいてやり直してください。"));
      }
    }
  }

  // ---- メタデータ ----

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.resource,
      authorization_servers: [this.#o.publicBaseUrl],
      scopes_supported: this.#scopesSupported(),
      bearer_methods_supported: ["header"],
      resource_name: "Leisen Gateway",
    };
  }

  authorizationServerMetadata(): Record<string, unknown> {
    const base = this.#o.publicBaseUrl;
    return {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      revocation_endpoint: `${base}/revoke`,
      ...(this.#o.authorizationServer?.allowDynamicRegistration ? { registration_endpoint: `${base}/register` } : {}),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token", TOKEN_EXCHANGE_GRANT],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      scopes_supported: this.#scopesSupported(),
      authorization_response_iss_parameter_supported: true,
    };
  }

  #scopesSupported(): string[] {
    return [
      MCP_SCOPE,
      ...[...this.#o.sources.values()].filter((s) => s.kind === "esc").map((s) => `${SOURCE_SCOPE_PREFIX}${s.sourceId}`),
    ];
  }

  // ---- 応答 ----

  #json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      pragma: "no-cache",
      "content-length": Buffer.byteLength(payload),
      ...headers,
    });
    res.end(payload);
  }

  #oauthError(res: ServerResponse, status: number, error: string, description: string, headers: Record<string, string> = {}): void {
    this.#json(res, status, { error, error_description: description }, headers);
  }

  #html(res: ServerResponse, status: number, html: string, cookies: string[] = []): void {
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://127.0.0.1:* http://localhost:*; frame-ancestors 'none'; base-uri 'none'",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...(cookies.length > 0 ? { "set-cookie": cookies } : {}),
    });
    res.end(html);
  }

  #redirect(res: ServerResponse, location: string, cookies: string[] = []): void {
    res.writeHead(302, {
      location,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      ...(cookies.length > 0 ? { "set-cookie": cookies } : {}),
    });
    res.end();
  }

  #cookie(name: string, value: string, maxAgeSec: number): string {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${this.#secure ? "; Secure" : ""}`;
  }

  // ---- ブラウザのセッション ----

  /** ブラウザのセッション。利用停止(拒否リストの sub)より前に始まったものは無効。 */
  async #session(req: IncomingMessage): Promise<BrowserSession | undefined> {
    const raw = parseCookies(req.headers.cookie).get(this.#sessionCookie);
    if (raw === undefined) {
      return undefined;
    }
    let value: BrowserSession;
    try {
      value = this.#o.sealer.open("browser_session", raw) as BrowserSession;
    } catch {
      return undefined;
    }
    if (
      typeof value.sub !== "string" ||
      typeof value.csrf !== "string" ||
      typeof value.exp !== "number" ||
      typeof value.iat !== "number" ||
      value.exp <= this.#now()
    ) {
      return undefined;
    }
    const revokedBefore = await this.#o.store.denial("sub", value.sub);
    if (revokedBefore !== undefined && value.iat < revokedBefore) {
      return undefined;
    }
    return value;
  }

  #sessionCookieFor(identity: Identity): { cookie: string; session: BrowserSession } {
    const session: BrowserSession = {
      iat: this.#now(),
      sub: identity.userId,
      ...(identity.email !== undefined ? { email: identity.email } : {}),
      ...(identity.displayName !== undefined ? { name: identity.displayName } : {}),
      csrf: randomId(),
      exp: this.#now() + this.#o.browserSessionTtlMs,
    };
    return {
      session,
      cookie: this.#cookie(this.#sessionCookie, this.#o.sealer.seal("browser_session", session), Math.floor(this.#o.browserSessionTtlMs / 1000)),
    };
  }

  async #form(req: IncomingMessage): Promise<URLSearchParams | undefined> {
    const type = req.headers["content-type"] ?? "";
    if (!/^application\/x-www-form-urlencoded\b/i.test(type)) {
      return undefined;
    }
    const body = await readBody(req);
    return body === undefined ? undefined : new URLSearchParams(body);
  }

  // ---- ログイン ----

  #startLogin(req: IncomingMessage, res: ServerResponse, ret: string, tx?: string): void {
    const nonce = randomId();
    const ver = randomId(32);
    const state: StatePayload = {
      k: "login",
      ret,
      ver,
      bnd: hashBinding(nonce),
      ...(tx !== undefined ? { tx } : {}),
      exp: this.#now() + STATE_TTL_MS,
    };
    const sealedState = this.#o.sealer.seal("state", state);
    const cookie = this.#cookie(this.#nonceCookie, nonce, STATE_TTL_MS / 1000);
    const url = this.#o.login.authorizationUrl({
      state: sealedState,
      codeChallenge: pkceChallenge(ver),
      redirectUri: `${this.#o.publicBaseUrl}/login/callback`,
    });
    if (url === undefined) {
      this.#html(res, 200, mockLoginPage("/login/mock", sealedState), [cookie]);
      return;
    }
    void req;
    this.#redirect(res, url, [cookie]);
  }

  #openState(raw: string | null | undefined): StatePayload | undefined {
    if (raw === null || raw === undefined || raw === "") {
      return undefined;
    }
    try {
      const value = this.#o.sealer.open("state", raw) as StatePayload;
      if (typeof value.exp !== "number" || value.exp <= this.#now()) {
        return undefined;
      }
      return value;
    } catch (error) {
      if (error instanceof SealError) {
        return undefined;
      }
      throw error;
    }
  }

  async #mockLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.#o.login.kind !== "mock") {
      this.#html(res, 404, messagePage("見つかりません", "このページはありません。"));
      return;
    }
    const form = await this.#form(req);
    const token = form?.get("token") ?? "";
    await this.#completeLogin(req, res, form?.get("state"), { code: token, verifier: undefined });
  }

  async #loginCallback(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): Promise<void> {
    if (query.get("error") !== null) {
      this.#html(res, 400, messagePage("ログインできませんでした", "IdP でのログインが完了しませんでした。もう一度お試しください。"));
      return;
    }
    await this.#completeLogin(req, res, query.get("state"), { code: query.get("code") ?? "", verifier: "" });
  }

  async #completeLogin(
    req: IncomingMessage,
    res: ServerResponse,
    rawState: string | null | undefined,
    input: { code: string; verifier: string | undefined },
  ): Promise<void> {
    const state = this.#openState(rawState);
    const nonce = parseCookies(req.headers.cookie).get(this.#nonceCookie);
    if (state === undefined || state.k !== "login" || nonce === undefined || !safeEqual(hashBinding(nonce), state.bnd) || input.code === "") {
      this.#html(res, 400, messagePage("ログインできませんでした", "ログインの要求が無効か期限切れです。最初からやり直してください。", "err", { href: "/connections", label: "接続ページへ" }));
      return;
    }
    let tokens: IdpTokens;
    let identity: Identity;
    try {
      tokens = await this.#o.login.exchangeCode({
        code: input.code,
        codeVerifier: input.verifier === undefined ? "" : state.ver,
        redirectUri: `${this.#o.publicBaseUrl}/login/callback`,
      });
      identity = await this.#o.idp.authenticate(tokens.accessToken);
    } catch (error) {
      const unavailable = error instanceof IdpError && error.errorClass === "idp_unavailable";
      this.#html(res, unavailable ? 503 : 401, messagePage("ログインできませんでした", unavailable ? "IdP に接続できません。時間をおいてやり直してください。" : "IdP がログインを受け付けませんでした。", "err"));
      return;
    }
    const clearNonce = this.#cookie(this.#nonceCookie, "", 0);
    const { cookie } = this.#sessionCookieFor(identity);
    if (state.az !== undefined) {
      // 取引はログイン済みの利用者についてだけ作る(未認証の要求でメモリを埋めさせない)
      const client = this.#authorizationServerEnabled() ? this.#resolveClient(state.az.clientId) : undefined;
      this.#pruneTx();
      const mine = [...this.#tx.values()].filter((t) => t.identity?.userId === identity.userId).length;
      if (client === undefined || mine >= MAX_TX_PER_USER || this.#tx.size >= MAX_TX) {
        this.#html(res, 429, messagePage("認可できませんでした", "進行中の認可が多すぎます。時間をおいてクライアントからやり直してください。"));
        return;
      }
      const tx: AuthorizeTx = {
        id: randomId(),
        createdAt: this.#now(),
        csrf: randomId(),
        client,
        redirectUri: state.az.redirectUri,
        ...(state.az.state !== undefined ? { state: state.az.state } : {}),
        codeChallenge: state.az.codeChallenge,
        resource: state.az.resource,
        requestedScope: state.az.requestedScope,
        expiresAt: this.#now() + TX_TTL_MS,
        identity,
        idp: tokens,
        src: {},
      };
      this.#tx.set(tx.id, tx);
      this.#redirect(res, `/authorize/consent?tx=${encodeURIComponent(tx.id)}`, [
        clearNonce,
        cookie,
        this.#cookie(this.#txCookie, tx.id, TX_TTL_MS / 1000),
      ]);
      return;
    }
    this.#redirect(res, safeReturnPath(state.ret, "/connections"), [clearNonce, cookie]);
  }

  async #logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const session = await this.#session(req);
    const form = await this.#form(req);
    if (session !== undefined && !safeEqual(form?.get("csrf") ?? "", session.csrf)) {
      this.#html(res, 403, messagePage("操作できませんでした", "ページを開き直してから操作してください。"));
      return;
    }
    this.#html(res, 200, messagePage("ログアウトしました", "Leisen の接続ページからログアウトしました。", "ok", { href: "/connections", label: "接続ページへ" }), [
      this.#cookie(this.#sessionCookie, "", 0),
    ]);
  }

  // ---- 接続ページ(token_vault) ----

  async #connections(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): Promise<void> {
    const session = await this.#session(req);
    const highlight = query.get("source") ?? undefined;
    if (session === undefined) {
      const ret = `/connections${highlight !== undefined ? `?source=${encodeURIComponent(highlight)}` : ""}`;
      this.#startLogin(req, res, ret);
      return;
    }
    await this.#renderConnections(res, session, highlight, noticeFor(query.get("result")));
  }

  async #renderConnections(
    res: ServerResponse,
    session: BrowserSession,
    highlight?: string,
    notice?: { tone: "ok" | "err" | "warn"; text: string },
  ): Promise<void> {
    const connected = new Map<string, number>();
    if (this.#o.vault !== undefined) {
      for (const sourceId of await this.#o.vault.sourcesForUser(session.sub)) {
        connected.set(sourceId, 0);
      }
    }
    const rows: ConnectionRow[] = [...this.#o.sources.values()].map((source) => {
      switch (source.kind) {
        case "token_vault":
          return { sourceId: source.sourceId, method: "token_vault", status: connected.has(source.sourceId) ? "connected" : "not_connected" };
        case "esc":
          return { sourceId: source.sourceId, method: "esc", status: "in_client" };
        case "token_exchange":
          return { sourceId: source.sourceId, method: "token_exchange", status: "automatic" };
        default:
          return { sourceId: source.sourceId, method: "mock_env", status: "automatic" };
      }
    });
    this.#html(
      res,
      200,
      connectionsPage({
        displayName: session.name ?? session.sub,
        rows,
        csrf: session.csrf,
        ...(highlight !== undefined ? { highlight } : {}),
        ...(notice !== undefined ? { notice } : {}),
      }),
    );
  }

  /** フォームの CSRF とブラウザのセッションを確かめる。 */
  async #sessionForm(req: IncomingMessage, res: ServerResponse): Promise<{ session: BrowserSession; form: URLSearchParams } | undefined> {
    const session = await this.#session(req);
    const form = await this.#form(req);
    if (session === undefined) {
      this.#redirect(res, "/connections");
      return undefined;
    }
    if (form === undefined || !safeEqual(form.get("csrf") ?? "", session.csrf)) {
      this.#html(res, 403, messagePage("操作できませんでした", "ページを開き直してから操作してください。", "err", { href: "/connections", label: "接続ページへ" }));
      return undefined;
    }
    return { session, form };
  }

  #sourceAuthorizationUrl(source: ConfiguredSource, state: StatePayload & { k: "connect" }): string {
    return (source.oauth as SourceOAuthClient).authorizationUrl({
      state: this.#o.sealer.seal("state", state),
      codeChallenge: pkceChallenge(state.ver),
      redirectUri: `${this.#o.publicBaseUrl}/connections/callback`,
    });
  }

  async #connectStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ctx = await this.#sessionForm(req, res);
    if (ctx === undefined) return;
    const source = this.#o.sources.get(ctx.form.get("source") ?? "");
    if (source === undefined || source.kind !== "token_vault" || source.oauth === undefined) {
      this.#html(res, 400, messagePage("接続できませんでした", "このソースは接続ページから接続できません。"));
      return;
    }
    await this.#o.events({ userId: ctx.session.sub, event: "connect_started", sourceId: source.sourceId, method: "token_vault", outcome: "success" });
    this.#redirect(
      res,
      this.#sourceAuthorizationUrl(source, {
        k: "connect",
        src: source.sourceId,
        ver: randomId(32),
        sub: ctx.session.sub,
        bnd: hashBinding(ctx.session.csrf),
        exp: this.#now() + STATE_TTL_MS,
      }),
    );
  }

  async #connectCallback(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): Promise<void> {
    const state = this.#openState(query.get("state"));
    if (state === undefined || state.k !== "connect") {
      this.#html(res, 400, messagePage("接続できませんでした", "接続の要求が無効か期限切れです。最初からやり直してください。", "err", { href: "/connections", label: "接続ページへ" }));
      return;
    }
    const source = this.#o.sources.get(state.src);
    const tx = state.tx !== undefined ? this.#getTx(state.tx) : undefined;
    // 接続を始めたブラウザ・本人であること(state をほかのブラウザで使わせない)
    const bound =
      state.tx !== undefined
        ? tx !== undefined &&
          tx.identity?.userId === state.sub &&
          safeEqual(parseCookies(req.headers.cookie).get(this.#txCookie) ?? "", tx.id) &&
          safeEqual(hashBinding(tx.csrf), state.bnd)
        : await (async () => {
            const session = await this.#session(req);
            return session !== undefined && session.sub === state.sub && safeEqual(hashBinding(session.csrf), state.bnd);
          })();
    const method = source?.kind === "esc" ? "esc" : "token_vault";
    const back = tx !== undefined ? `/authorize/consent?tx=${encodeURIComponent(tx.id)}` : "/connections";
    if (!bound || source === undefined || source.oauth === undefined) {
      await this.#o.events({ userId: state.sub, event: "connect_failed", sourceId: state.src, method, outcome: "failure", reason: "state_binding_mismatch" });
      this.#html(res, 400, messagePage("接続できませんでした", "接続を始めたブラウザでやり直してください。", "err", { href: back, label: "戻る" }));
      return;
    }
    if (query.get("error") !== null || (query.get("code") ?? "") === "") {
      await this.#o.events({ userId: state.sub, event: "connect_failed", sourceId: source.sourceId, method, outcome: "failure", reason: "consent_denied" });
      this.#redirect(res, tx !== undefined ? back : `/connections?result=denied&source=${encodeURIComponent(source.sourceId)}`);
      return;
    }
    let result;
    try {
      result = await source.oauth.exchangeCode({
        code: query.get("code") as string,
        codeVerifier: state.ver,
        redirectUri: `${this.#o.publicBaseUrl}/connections/callback`,
      });
    } catch (error) {
      const reason = error instanceof SourceOAuthError ? `oauth_${error.kind}` : "oauth_failed";
      await this.#o.events({ userId: state.sub, event: "connect_failed", sourceId: source.sourceId, method, outcome: "failure", reason });
      // 切り分け用にどの段階で失敗したかをサーバーログへ(SourceOAuthError の文言は段階・HTTP 状態・
      // 正規化した OAuth のエラーコードだけで、トークン・応答本文・利用者を含まない。不変条件6)
      this.#o.warn?.(
        `connecting source "${source.sourceId}" failed: ${error instanceof SourceOAuthError ? error.message : "unexpected error"}`,
      );
      this.#html(res, 502, messagePage("接続できませんでした", `${source.sourceId} とのやり取りに失敗しました。時間をおいてやり直してください。`, "err", { href: back, label: "戻る" }));
      return;
    }
    const idpEmail = tx?.identity?.email ?? (await this.#session(req))?.email;
    if (source.identityCheck === "email" && !emailMatches(idpEmail, result.verifiedEmails)) {
      // 誤接続(私用アカウント等)。取得したトークンはソースへ失効を依頼して捨てる
      await source.oauth.revoke(result.tokens);
      await this.#o.events({ userId: state.sub, event: "connect_failed", sourceId: source.sourceId, method, outcome: "failure", reason: "identity_mismatch" });
      this.#html(
        res,
        403,
        messagePage(
          "接続できませんでした",
          `${source.sourceId} のアカウントのメールアドレスが、Leisen にログインしたアカウント(${idpEmail ?? "メールアドレス不明"})と一致しません。会社のアカウントで接続してください。`,
          "err",
          { href: back, label: "戻る" },
        ),
      );
      return;
    }
    if (tx !== undefined) {
      // 監査に残せない接続は成立させない(不変条件2): 記録してから取引に入れる
      try {
        await this.#o.events({ userId: state.sub, event: "connected", sourceId: source.sourceId, method: "esc", outcome: "success", clientId: this.#clientLabel(tx.client) });
      } catch (error) {
        await source.oauth.revoke(result.tokens);
        throw error;
      }
      tx.src[source.sourceId] = result.tokens;
      this.#redirect(res, back);
      return;
    }
    if (this.#o.vault === undefined) {
      throw new Error("token vault is not configured");
    }
    await this.#o.vault.put(state.sub, source.sourceId, result.tokens);
    try {
      await this.#o.events({ userId: state.sub, event: "connected", sourceId: source.sourceId, method: "token_vault", outcome: "success" });
    } catch (error) {
      // 監査に残せない接続は成立させない(不変条件2)
      await this.#o.vault.delete(state.sub, source.sourceId);
      throw error;
    }
    this.#o.idp.invalidateUser(state.sub);
    this.#redirect(res, `/connections?result=connected&source=${encodeURIComponent(source.sourceId)}`);
  }

  async #disconnect(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ctx = await this.#sessionForm(req, res);
    if (ctx === undefined) return;
    const sourceId = ctx.form.get("source") ?? "";
    const identity: Identity = { userId: ctx.session.sub, session: { subjectToken: "" } };
    const done = await this.#o.revocation.disconnect(identity, sourceId);
    this.#redirect(res, `/connections?result=${done ? "disconnected" : "unknown"}&source=${encodeURIComponent(sourceId)}`);
  }

  // ---- 管理: 利用停止 ----

  async #deprovision(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const expected = this.#o.adminCredential;
    const presented = /^Bearer +(\S+) *$/i.exec(req.headers.authorization ?? "")?.[1];
    if (expected === undefined) {
      this.#json(res, 404, { error: "not_found" });
      return;
    }
    if (presented === undefined || !safeEqual(presented, expected)) {
      await this.#o.events({ userId: "anonymous", event: "deprovisioned", outcome: "failure", reason: "admin_unauthorized" });
      this.#json(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      return;
    }
    const body = await readBody(req);
    let userId: unknown;
    try {
      userId = (JSON.parse(body ?? "") as { userId?: unknown }).userId;
    } catch {
      userId = undefined;
    }
    if (typeof userId !== "string" || userId === "" || userId.length > 512) {
      this.#json(res, 400, { error: "invalid_request", error_description: "body must be {\"userId\": \"...\"}" });
      return;
    }
    const result = await this.#o.revocation.deprovision(userId);
    this.#json(res, 200, result);
  }

  // ---- 認可サーバー ----

  #authorizationServerEnabled(): boolean {
    return this.#o.authorizationServer !== undefined;
  }

  #as(): AuthorizationServerSettings {
    const as = this.#o.authorizationServer;
    if (as === undefined) {
      throw new Error("authorization server is disabled");
    }
    return as;
  }

  #resources(): string[] {
    const as = this.#as();
    return [this.resource, ...(as.orchestratorResource !== undefined ? [as.orchestratorResource] : [])];
  }

  /** client_id を解決する(事前登録、または動的登録の封じた client_id)。 */
  #resolveClient(clientId: string): RegisteredClient | undefined {
    const as = this.#as();
    const registered = as.clients.get(clientId);
    if (registered !== undefined) {
      return registered;
    }
    if (!as.allowDynamicRegistration || clientId === ORCHESTRATOR_CLIENT_ID) {
      return undefined;
    }
    try {
      const value = this.#o.sealer.open("client_id", clientId) as { redirectUris?: unknown; name?: unknown };
      if (!Array.isArray(value.redirectUris) || !value.redirectUris.every((u) => typeof u === "string" && isAllowedRedirectUri(u))) {
        return undefined;
      }
      return {
        clientId,
        redirectUris: value.redirectUris as string[],
        ...(typeof value.name === "string" ? { name: value.name } : {}),
      };
    } catch {
      return undefined;
    }
  }

  #clientLabel(client: RegisteredClient): string {
    return this.#as().clients.has(client.clientId) ? client.clientId : "dynamic";
  }

  #getTx(id: string): AuthorizeTx | undefined {
    const tx = this.#tx.get(id);
    if (tx === undefined) return undefined;
    if (tx.expiresAt <= this.#now()) {
      this.#tx.delete(id);
      return undefined;
    }
    return tx;
  }

  #pruneTx(): void {
    const now = this.#now();
    for (const [id, tx] of this.#tx) {
      if (tx.expiresAt <= now) this.#tx.delete(id);
    }
  }

  #authorize(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): void {
    const client = this.#resolveClient(query.get("client_id") ?? "");
    const redirectUri = query.get("redirect_uri") ?? "";
    // client_id・redirect_uri が不正なら、リダイレクトせずに画面で止める(RFC 6749 §4.1.2.1)
    if (client === undefined || !client.redirectUris.includes(redirectUri)) {
      this.#html(res, 400, messagePage("認可できませんでした", "クライアントまたはリダイレクト先が登録されていません。"));
      return;
    }
    const state = query.get("state") ?? undefined;
    const fail = (error: string, description: string) => {
      const url = new URL(redirectUri);
      url.searchParams.set("error", error);
      url.searchParams.set("error_description", description);
      if (state !== undefined) url.searchParams.set("state", state);
      url.searchParams.set("iss", this.#o.publicBaseUrl);
      this.#redirect(res, url.toString());
    };
    if (query.get("response_type") !== "code") {
      return fail("unsupported_response_type", "response_type must be code");
    }
    const challenge = query.get("code_challenge") ?? "";
    if (query.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return fail("invalid_request", "PKCE with code_challenge_method S256 is required");
    }
    const resource = query.get("resource") ?? client.defaultResource ?? this.resource;
    if (!this.#resources().includes(resource)) {
      return fail("invalid_target", "unknown resource");
    }
    const requestedScope = (query.get("scope") ?? MCP_SCOPE).split(" ").filter((s) => s !== "");
    const supported = new Set(this.#scopesSupported());
    if (requestedScope.some((s) => !supported.has(s))) {
      return fail("invalid_scope", "unknown scope");
    }
    const az: AuthorizeRequest = {
      clientId: client.clientId,
      redirectUri,
      ...(state !== undefined ? { state } : {}),
      codeChallenge: challenge,
      resource,
      requestedScope,
    };
    // IdP でのログインは毎回行う(IdP のトークンを得るため。IdP 側の SSO で通常は画面が出ない)。
    // ログインまでの要求は封じた state で運び、サーバーに置かない
    const nonce = randomId();
    const ver = randomId(32);
    const sealedState = this.#o.sealer.seal("state", {
      k: "login",
      ret: "/connections",
      ver,
      bnd: hashBinding(nonce),
      az,
      exp: this.#now() + STATE_TTL_MS,
    } satisfies StatePayload);
    const cookies = [this.#cookie(this.#nonceCookie, nonce, STATE_TTL_MS / 1000)];
    const url = this.#o.login.authorizationUrl({
      state: sealedState,
      codeChallenge: pkceChallenge(ver),
      redirectUri: `${this.#o.publicBaseUrl}/login/callback`,
    });
    if (url === undefined) {
      this.#html(res, 200, mockLoginPage("/login/mock", sealedState), cookies);
      return;
    }
    void req;
    this.#redirect(res, url, cookies);
  }

  #txFromRequest(req: IncomingMessage, id: string): AuthorizeTx | undefined {
    const tx = this.#getTx(id);
    if (tx === undefined || tx.identity === undefined) return undefined;
    if (!safeEqual(parseCookies(req.headers.cookie).get(this.#txCookie) ?? "", tx.id)) return undefined;
    return tx;
  }

  #consent(req: IncomingMessage, res: ServerResponse, id: string, notice?: { tone: "ok" | "err" | "warn"; text: string }): void {
    const tx = this.#txFromRequest(req, id);
    if (tx === undefined) {
      this.#html(res, 400, messagePage("認可できませんでした", "認可の要求が無効か期限切れです。クライアントからやり直してください。"));
      return;
    }
    const sources: ConsentSourceRow[] = [...this.#o.sources.values()]
      .filter((s) => s.kind === "esc")
      .map((s) => ({
        sourceId: s.sourceId,
        connected: tx.src[s.sourceId] !== undefined,
        requested: tx.requestedScope.includes(`${SOURCE_SCOPE_PREFIX}${s.sourceId}`),
      }));
    this.#html(
      res,
      200,
      consentPage({
        clientName: this.#as().clients.has(tx.client.clientId)
          ? (tx.client.name ?? tx.client.clientId)
          : `未確認のクライアント(自己申告の名前: ${tx.client.name ?? "なし"}、戻り先: ${new URL(tx.redirectUri).origin})`,
        resourceLabel: tx.resource === this.resource ? "Leisen Gateway" : "Leisen(質問への回答)",
        displayName: tx.identity?.displayName ?? tx.identity?.userId ?? "",
        tx: tx.id,
        csrf: tx.csrf,
        sources,
        ...(notice !== undefined ? { notice } : {}),
      }),
    );
  }

  async #txForm(req: IncomingMessage, res: ServerResponse): Promise<{ tx: AuthorizeTx; form: URLSearchParams } | undefined> {
    const form = await this.#form(req);
    const tx = this.#txFromRequest(req, form?.get("tx") ?? "");
    if (form === undefined || tx === undefined || !safeEqual(form.get("csrf") ?? "", tx.csrf)) {
      this.#html(res, 400, messagePage("認可できませんでした", "認可の要求が無効か期限切れです。クライアントからやり直してください。"));
      return undefined;
    }
    return { tx, form };
  }

  async #authorizeConnect(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ctx = await this.#txForm(req, res);
    if (ctx === undefined) return;
    const source = this.#o.sources.get(ctx.form.get("source") ?? "");
    if (source === undefined || source.kind !== "esc" || source.oauth === undefined) {
      this.#consent(req, res, ctx.tx.id, { tone: "err", text: "このソースはここでは接続できません。" });
      return;
    }
    const userId = ctx.tx.identity?.userId as string;
    await this.#o.events({ userId, event: "connect_started", sourceId: source.sourceId, method: "esc", outcome: "success", clientId: this.#clientLabel(ctx.tx.client) });
    this.#redirect(
      res,
      this.#sourceAuthorizationUrl(source, {
        k: "connect",
        src: source.sourceId,
        ver: randomId(32),
        sub: userId,
        bnd: hashBinding(ctx.tx.csrf),
        tx: ctx.tx.id,
        exp: this.#now() + STATE_TTL_MS,
      }),
    );
  }

  async #decision(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ctx = await this.#txForm(req, res);
    if (ctx === undefined) return;
    const { tx, form } = ctx;
    this.#tx.delete(tx.id);
    const url = new URL(tx.redirectUri);
    if (tx.state !== undefined) url.searchParams.set("state", tx.state);
    url.searchParams.set("iss", this.#o.publicBaseUrl);
    const clearTx = this.#cookie(this.#txCookie, "", 0);
    const identity = tx.identity as Identity;
    const revokedBefore = await this.#o.store.denial("sub", identity.userId);
    if (revokedBefore !== undefined && tx.createdAt < revokedBefore) {
      url.searchParams.set("error", "access_denied");
      this.#redirect(res, url.toString(), [clearTx]);
      return;
    }
    if (form.get("decision") !== "allow" || tx.idp === undefined) {
      url.searchParams.set("error", "access_denied");
      await this.#o.events({ userId: identity.userId, event: "token_issued", method: "gateway_token", outcome: "failure", reason: "access_denied", clientId: this.#clientLabel(tx.client) });
      this.#redirect(res, url.toString(), [clearTx]);
      return;
    }
    const claims: GrantClaims = {
      sub: identity.userId,
      ...(identity.email !== undefined ? { email: identity.email } : {}),
      ...(identity.displayName !== undefined ? { name: identity.displayName } : {}),
      sid: randomId(),
      cid: tx.client.clientId,
      aud: tx.resource,
      scope: [MCP_SCOPE, ...Object.keys(tx.src).map((id) => `${SOURCE_SCOPE_PREFIX}${id}`)],
      idp: tx.idp,
      src: tx.src,
    };
    url.searchParams.set("code", this.#as().tokens.issueCode(claims, tx.redirectUri, tx.codeChallenge));
    this.#redirect(res, url.toString(), [clearTx]);
  }

  /** トークンエンドポイントのクライアント認証(Basic / 本文 / 公開クライアント)。 */
  #authenticateClient(req: IncomingMessage, form: URLSearchParams): { client: RegisteredClient } | { orchestrator: true } | { error: string } {
    let clientId = form.get("client_id") ?? undefined;
    let secret = form.get("client_secret") ?? undefined;
    const basic = /^Basic +([A-Za-z0-9+/=]+) *$/i.exec(req.headers.authorization ?? "")?.[1];
    if (basic !== undefined) {
      const decoded = Buffer.from(basic, "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon < 0) return { error: "invalid_client" };
      try {
        clientId = decodeURIComponent(decoded.slice(0, colon));
        secret = decodeURIComponent(decoded.slice(colon + 1));
      } catch {
        return { error: "invalid_client" };
      }
    }
    if (clientId === undefined) return { error: "invalid_client" };
    const as = this.#as();
    if (clientId === ORCHESTRATOR_CLIENT_ID) {
      return as.orchestratorCredential !== undefined && secret !== undefined && safeEqual(secret, as.orchestratorCredential)
        ? { orchestrator: true }
        : { error: "invalid_client" };
    }
    const client = this.#resolveClient(clientId);
    if (client === undefined) return { error: "invalid_client" };
    if (client.secret !== undefined) {
      return secret !== undefined && safeEqual(secret, client.secret) ? { client } : { error: "invalid_client" };
    }
    return secret === undefined ? { client } : { error: "invalid_client" };
  }

  async #token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await this.#form(req);
    if (form === undefined) {
      return this.#oauthError(res, 400, "invalid_request", "application/x-www-form-urlencoded body is required");
    }
    const auth = this.#authenticateClient(req, form);
    if ("error" in auth) {
      return this.#oauthError(res, 401, "invalid_client", "client authentication failed", { "www-authenticate": 'Basic realm="leisen"' });
    }
    const grant = form.get("grant_type");
    try {
      if (grant === TOKEN_EXCHANGE_GRANT) {
        if (!("orchestrator" in auth)) {
          return this.#oauthError(res, 400, "unauthorized_client", "token exchange is limited to the orchestrator");
        }
        return await this.#tokenExchange(res, form);
      }
      if (!("client" in auth)) {
        return this.#oauthError(res, 400, "unsupported_grant_type", "the orchestrator client may only use token exchange");
      }
      if (grant === "authorization_code") {
        return await this.#codeGrant(res, form, auth.client);
      }
      if (grant === "refresh_token") {
        return await this.#refreshGrant(res, form, auth.client);
      }
      return this.#oauthError(res, 400, "unsupported_grant_type", "unsupported grant_type");
    } catch (error) {
      if (error instanceof TokenRejected) {
        return this.#oauthError(res, 400, "invalid_grant", error.kind === "reused" ? "grant was already used" : "grant is invalid, expired or revoked");
      }
      if (error instanceof IdpError && error.errorClass === "idp_unavailable") {
        return this.#oauthError(res, 503, "temporarily_unavailable", "identity provider is unavailable");
      }
      throw error;
    }
  }

  #tokenResponse(res: ServerResponse, issued: { accessToken: string; expiresInSec: number; refreshToken?: string; scope: readonly string[] }, extra: Record<string, string> = {}): void {
    this.#json(res, 200, {
      access_token: issued.accessToken,
      token_type: "Bearer",
      expires_in: issued.expiresInSec,
      ...(issued.refreshToken !== undefined ? { refresh_token: issued.refreshToken } : {}),
      scope: issued.scope.join(" "),
      ...extra,
    });
  }

  async #codeGrant(res: ServerResponse, form: URLSearchParams, client: RegisteredClient): Promise<void> {
    const as = this.#as();
    const code = await as.tokens.consumeCode(form.get("code") ?? "");
    const verifier = form.get("code_verifier") ?? "";
    const resource = form.get("resource");
    if (
      code.cid !== client.clientId ||
      code.redirectUri !== (form.get("redirect_uri") ?? "") ||
      !isValidCodeVerifier(verifier) ||
      !safeEqual(pkceChallenge(verifier), code.codeChallenge) ||
      (resource !== null && resource !== code.aud)
    ) {
      await as.tokens.revokeSession(code.sid);
      await this.#o.events({ userId: code.sub, event: "token_issued", method: "gateway_token", outcome: "failure", reason: "code_request_mismatch", clientId: this.#clientLabel(client) });
      return this.#oauthError(res, 400, "invalid_grant", "authorization code does not match the request");
    }
    const { redirectUri: _r, codeChallenge: _c, v: _v, iat: _i, exp: _e, jti: _j, ...claims } = code;
    const issued = as.tokens.issue(claims, { withRefresh: true });
    await this.#o.events({ userId: code.sub, event: "token_issued", method: "gateway_token", outcome: "success", clientId: this.#clientLabel(client) });
    this.#tokenResponse(res, issued);
  }

  async #refreshGrant(res: ServerResponse, form: URLSearchParams, client: RegisteredClient): Promise<void> {
    const as = this.#as();
    let payload;
    try {
      payload = await as.tokens.consumeRefreshToken(form.get("refresh_token") ?? "");
    } catch (error) {
      if (error instanceof TokenRejected && error.kind === "reused") {
        const peeked = as.tokens.peek(form.get("refresh_token") ?? "");
        if (peeked !== undefined) {
          await this.#o.events({ userId: peeked.sub, event: "token_reuse_detected", method: "gateway_token", outcome: "failure", reason: "refresh_token_reused", clientId: this.#clientLabel(client) });
        }
      }
      throw error;
    }
    if (payload.cid !== client.clientId) {
      await as.tokens.revokeSession(payload.sid);
      await this.#o.events({ userId: payload.sub, event: "token_refreshed", method: "gateway_token", outcome: "failure", reason: "client_mismatch", clientId: this.#clientLabel(client) });
      return this.#oauthError(res, 400, "invalid_grant", "refresh token was issued to another client");
    }
    // IdP のトークンを更新し、本人がまだ有効か IdP に確かめる(利用停止の反映)
    let idp: IdpTokens;
    try {
      idp = await this.#o.login.refresh(payload.idp);
      const identity = await this.#o.idp.authenticate(idp.accessToken);
      if (identity.userId !== payload.sub) {
        throw new IdpError("unauthenticated", "subject changed");
      }
    } catch (error) {
      if (error instanceof IdpError && error.errorClass === "idp_unavailable") {
        throw error;
      }
      await as.tokens.revokeSession(payload.sid);
      await this.#o.events({ userId: payload.sub, event: "token_refreshed", method: "gateway_token", outcome: "failure", reason: "idp_session_ended", clientId: this.#clientLabel(client) });
      return this.#oauthError(res, 400, "invalid_grant", "the identity provider session has ended; sign in again");
    }
    // esc のソースを更新する(決定 5: ローテーションはここだけで行う)
    const src: Record<string, SourceTokenSet> = {};
    const horizon = this.#now() + as.accessTokenTtlMs;
    for (const [sourceId, tokens] of Object.entries(payload.src)) {
      const source = this.#o.sources.get(sourceId);
      if (source?.kind !== "esc" || source.oauth === undefined) {
        continue; // 設定から外れたソースは持ち越さない
      }
      const revokedBefore = await this.#o.store.denial("sub_source", subSourceKey(payload.sub, sourceId));
      if (revokedBefore !== undefined && tokens.obtainedAt < revokedBefore) {
        continue;
      }
      if (!needsRefresh(tokens, horizon, 0)) {
        src[sourceId] = tokens;
        continue;
      }
      try {
        src[sourceId] = await source.oauth.refresh(tokens);
      } catch (error) {
        const kind = error instanceof SourceOAuthError ? error.kind : "failed";
        await this.#o.events({ userId: payload.sub, event: "refresh_failed", sourceId, method: "esc", outcome: "failure", reason: kind });
        this.#o.warn?.(
          `refreshing source "${sourceId}" failed: ${error instanceof SourceOAuthError ? error.message : "unexpected error"}`,
        );
        if (kind !== "invalid_grant") {
          src[sourceId] = tokens; // 一時的な失敗は持ち越す(アクセストークンからは外れる)
        }
      }
    }
    const { v: _v, iat: _i, exp: _e, jti: _j, ...rest } = payload;
    const claims: GrantClaims = {
      ...rest,
      idp,
      src,
      scope: [MCP_SCOPE, ...Object.keys(src).map((id) => `${SOURCE_SCOPE_PREFIX}${id}`)],
    };
    const issued = as.tokens.issue(claims, { withRefresh: true });
    await this.#o.events({ userId: payload.sub, event: "token_refreshed", method: "gateway_token", outcome: "success", clientId: this.#clientLabel(client) });
    this.#tokenResponse(res, issued);
  }

  async #tokenExchange(res: ServerResponse, form: URLSearchParams): Promise<void> {
    const as = this.#as();
    if (as.orchestratorResource === undefined) {
      return this.#oauthError(res, 400, "unauthorized_client", "token exchange is not configured");
    }
    if (form.get("subject_token_type") !== ACCESS_TOKEN_TYPE) {
      return this.#oauthError(res, 400, "invalid_request", "subject_token_type must be access_token");
    }
    const target = form.get("resource") ?? form.get("audience") ?? this.resource;
    if (target !== this.resource) {
      return this.#oauthError(res, 400, "invalid_target", "token exchange can only target this gateway");
    }
    let subject;
    try {
      subject = await as.tokens.openAccessToken(form.get("subject_token") ?? "", as.orchestratorResource);
    } catch (error) {
      if (error instanceof TokenRejected) {
        await this.#o.events({ userId: "anonymous", event: "token_exchanged", method: "gateway_token", outcome: "failure", reason: `subject_${error.kind}`, clientId: ORCHESTRATOR_CLIENT_ID });
      }
      throw error;
    }
    const { v: _v, iat: _i, exp, jti: _j, ...claims } = subject;
    const issued = as.tokens.issue({ ...claims, aud: this.resource }, { withRefresh: false, maxExp: exp });
    await this.#o.events({ userId: subject.sub, event: "token_exchanged", method: "gateway_token", outcome: "success", clientId: ORCHESTRATOR_CLIENT_ID });
    this.#tokenResponse(res, issued, { issued_token_type: ACCESS_TOKEN_TYPE });
  }

  async #revoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await this.#form(req);
    if (form === undefined) {
      return this.#oauthError(res, 400, "invalid_request", "application/x-www-form-urlencoded body is required");
    }
    const auth = this.#authenticateClient(req, form);
    if (!("client" in auth)) {
      return this.#oauthError(res, 401, "invalid_client", "client authentication failed");
    }
    const as = this.#as();
    const payload = as.tokens.peek(form.get("token") ?? "");
    // RFC 7009 §2.2: 無効なトークンでも 200。他のクライアントのトークンは失効させない
    if (payload !== undefined && payload.cid === auth.client.clientId) {
      await as.tokens.revokeSession(payload.sid);
      // この系列だけが持つ esc のソースのトークンは、ソースへも失効を依頼する(ベストエフォート)
      for (const [sourceId, tokens] of Object.entries(payload.src)) {
        await this.#o.sources.get(sourceId)?.oauth?.revoke(tokens);
      }
      await this.#o.events({ userId: payload.sub, event: "token_revoked", method: "gateway_token", outcome: "success", clientId: this.#clientLabel(auth.client) });
    }
    this.#json(res, 200, {});
  }

  async #register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const as = this.#as();
    if (!as.allowDynamicRegistration) {
      this.#json(res, 404, { error: "not_found" });
      return;
    }
    const body = await readBody(req, 16 * 1024);
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(body ?? "") as Record<string, unknown>;
    } catch {
      return this.#oauthError(res, 400, "invalid_client_metadata", "body must be JSON");
    }
    const uris = input["redirect_uris"];
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string" && isAllowedRedirectUri(u))) {
      return this.#oauthError(res, 400, "invalid_redirect_uri", "redirect_uris must be https or loopback http URLs");
    }
    const method = input["token_endpoint_auth_method"] ?? "none";
    if (method !== "none") {
      return this.#oauthError(res, 400, "invalid_client_metadata", "only public clients (token_endpoint_auth_method none) can register");
    }
    const name = typeof input["client_name"] === "string" ? input["client_name"].slice(0, 100) : undefined;
    const clientId = this.#o.sealer.seal("client_id", { redirectUris: uris, ...(name !== undefined ? { name } : {}), iat: this.#now() });
    this.#json(res, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(this.#now() / 1000),
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(name !== undefined ? { client_name: name } : {}),
    });
  }
}

function noticeFor(result: string | null): { tone: "ok" | "err" | "warn"; text: string } | undefined {
  switch (result) {
    case "connected":
      return { tone: "ok", text: "接続しました。元の画面に戻って、同じ質問をもう一度送ってください。" };
    case "disconnected":
      return { tone: "ok", text: "解除しました。" };
    case "denied":
      return { tone: "warn", text: "ソース側で接続が許可されませんでした。" };
    case "unknown":
      return { tone: "err", text: "このソースは接続ページで扱えません。" };
    default:
      return undefined;
  }
}
