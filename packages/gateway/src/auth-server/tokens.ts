/**
 * 認可サーバーが発行するトークン(ADR-022 決定 4・5)。すべて seal.ts の JWE で、Gateway の
 * 状態 DB には拒否リストと使用済みの印(資格情報を含まない)だけを置く。
 *
 * - アクセストークン: 本人(sub)・受け手(aud = Gateway または Orchestrator の resource)・
 *   本人の IdP トークン・esc のソースのトークン。有効期限は「設定値」「IdP のアクセストークンの
 *   期限」「含めるソースのアクセストークンの期限」の最小(決定 5: 呼び出しの途中でソースを
 *   更新しない)。期限が近いソース(MIN_SOURCE_VALIDITY_MS 未満)は含めない
 * - リフレッシュトークン: 使うたびに入れ替える。使用済みの再提示は系列(sid)ごと拒否する
 * - 認可コード: 60 秒・1 回限り
 * 拒否リスト: sub(利用停止の時刻より前の発行)、sid(/revoke・再利用検知)
 */
import type { IdpTokens } from "../idp/login.js";
import type { CredentialStore, SourceTokenSet } from "../credentials/types.js";
import { randomId, SealError, Sealer, type SealPurpose } from "./seal.js";

export const CODE_TTL_MS = 60_000;
/** アクセストークンに含めるソースのトークンの最小の残り時間 */
export const MIN_SOURCE_VALIDITY_MS = 30_000;
/** アクセストークンの最短の有効期間(これ未満になるなら発行時にソースを更新する) */
export const MIN_ACCESS_TOKEN_MS = 30_000;

export interface GrantClaims {
  readonly sub: string;
  readonly email?: string;
  readonly name?: string;
  readonly sid: string;
  /** クライアント ID(動的登録は封じた client_id のまま) */
  readonly cid: string;
  /** 受け手(RFC 8707 の resource) */
  readonly aud: string;
  readonly scope: readonly string[];
  readonly idp: IdpTokens;
  readonly src: Readonly<Record<string, SourceTokenSet>>;
}

interface Stamped {
  readonly v: 1;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export type AccessTokenPayload = GrantClaims & Stamped;
export type RefreshTokenPayload = GrantClaims & Stamped;
export type CodePayload = GrantClaims &
  Stamped & {
    readonly redirectUri: string;
    readonly codeChallenge: string;
  };

export class TokenRejected extends Error {
  constructor(
    /** invalid: 形式・鍵・期限・受け手。revoked: 拒否リスト。reused: 使用済みの再提示 */
    public readonly kind: "invalid" | "revoked" | "reused",
    message: string,
  ) {
    super(message);
    this.name = "TokenRejected";
  }
}

export interface IssuedTokens {
  readonly accessToken: string;
  readonly expiresInSec: number;
  readonly refreshToken?: string;
  readonly scope: readonly string[];
  /** アクセストークンに含めたソース */
  readonly includedSources: readonly string[];
}

export interface TokenServiceOptions {
  readonly sealer: Sealer;
  readonly store: CredentialStore;
  readonly accessTokenTtlMs: number;
  readonly refreshTokenTtlMs: number;
  readonly now?: () => number;
}

function isClaims(value: unknown): value is GrantClaims & Stamped {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    v["v"] === 1 &&
    typeof v["sub"] === "string" &&
    v["sub"] !== "" &&
    typeof v["sid"] === "string" &&
    typeof v["cid"] === "string" &&
    typeof v["aud"] === "string" &&
    Array.isArray(v["scope"]) &&
    typeof v["iat"] === "number" &&
    typeof v["exp"] === "number" &&
    typeof v["jti"] === "string" &&
    typeof v["idp"] === "object" &&
    v["idp"] !== null &&
    typeof (v["idp"] as Record<string, unknown>)["accessToken"] === "string" &&
    typeof v["src"] === "object" &&
    v["src"] !== null
  );
}

export class TokenService {
  readonly #o: TokenServiceOptions;
  readonly #now: () => number;

  constructor(options: TokenServiceOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  get refreshTokenTtlMs(): number {
    return this.#o.refreshTokenTtlMs;
  }

  /** アクセストークン(+ 求められればリフレッシュトークン)を発行する。 */
  issue(claims: GrantClaims, options: { withRefresh: boolean; maxExp?: number }): IssuedTokens {
    const now = this.#now();
    let exp = now + this.#o.accessTokenTtlMs;
    if (options.maxExp !== undefined) {
      exp = Math.min(exp, options.maxExp);
    }
    if (claims.idp.accessExpiresAt !== undefined) {
      exp = Math.min(exp, claims.idp.accessExpiresAt);
    }
    const included: Record<string, SourceTokenSet> = {};
    for (const [sourceId, tokens] of Object.entries(claims.src)) {
      if (tokens.accessExpiresAt !== undefined && tokens.accessExpiresAt - MIN_SOURCE_VALIDITY_MS <= now) {
        continue; // 期限が近いものは含めない(次の refresh_token グラントで更新する)
      }
      included[sourceId] = tokens;
      if (tokens.accessExpiresAt !== undefined) {
        exp = Math.min(exp, tokens.accessExpiresAt);
      }
    }
    if (exp <= now) {
      throw new TokenRejected("invalid", "no valid token material to issue an access token");
    }
    const access: AccessTokenPayload = { ...claims, src: included, v: 1, iat: now, exp, jti: randomId() };
    const result: IssuedTokens = {
      accessToken: this.#o.sealer.seal("access_token", access),
      expiresInSec: Math.max(1, Math.floor((exp - now) / 1000)),
      scope: claims.scope,
      includedSources: Object.keys(included),
    };
    if (!options.withRefresh) {
      return result;
    }
    const refresh: RefreshTokenPayload = {
      ...claims,
      v: 1,
      iat: now,
      exp: now + this.#o.refreshTokenTtlMs,
      jti: randomId(),
    };
    return { ...result, refreshToken: this.#o.sealer.seal("refresh_token", refresh) };
  }

  issueCode(claims: GrantClaims, redirectUri: string, codeChallenge: string): string {
    const now = this.#now();
    const payload: CodePayload = {
      ...claims,
      redirectUri,
      codeChallenge,
      v: 1,
      iat: now,
      exp: now + CODE_TTL_MS,
      jti: randomId(),
    };
    return this.#o.sealer.seal("authorization_code", payload);
  }

  #open(purpose: SealPurpose, token: string): GrantClaims & Stamped & Record<string, unknown> {
    let payload: unknown;
    try {
      payload = this.#o.sealer.open(purpose, token);
    } catch (error) {
      throw new TokenRejected("invalid", error instanceof SealError ? error.message : "token could not be opened");
    }
    if (!isClaims(payload)) {
      throw new TokenRejected("invalid", "token payload is malformed");
    }
    if (payload.exp <= this.#now()) {
      throw new TokenRejected("invalid", "token has expired");
    }
    return payload as GrantClaims & Stamped & Record<string, unknown>;
  }

  async #checkDenials(payload: GrantClaims & Stamped): Promise<void> {
    const { store } = this.#o;
    const subBefore = await store.denial("sub", payload.sub);
    if (subBefore !== undefined && payload.iat < subBefore) {
      throw new TokenRejected("revoked", "token was revoked (user)");
    }
    if ((await store.denial("sid", payload.sid)) !== undefined) {
      throw new TokenRejected("revoked", "token was revoked (session)");
    }
  }

  /** アクセストークンを検証して中身を返す(受け手の一致・期限・拒否リスト)。 */
  async openAccessToken(token: string, expectedAudience: string): Promise<AccessTokenPayload> {
    const payload = this.#open("access_token", token);
    if (payload.aud !== expectedAudience) {
      throw new TokenRejected("invalid", "token audience does not match");
    }
    await this.#checkDenials(payload);
    return payload;
  }

  /** リフレッシュトークンを検証し、使用済みにする。再提示なら系列を拒否リストに入れる。 */
  async consumeRefreshToken(token: string): Promise<RefreshTokenPayload> {
    const payload = this.#open("refresh_token", token);
    await this.#checkDenials(payload);
    if (!(await this.#o.store.markUsed(`rt:${payload.jti}`, payload.exp))) {
      await this.revokeSession(payload.sid);
      throw new TokenRejected("reused", "refresh token was already used; the session has been revoked");
    }
    return payload;
  }

  /** 認可コードを検証し、使用済みにする(再提示なら系列を拒否する。RFC 6749 §4.1.2)。 */
  async consumeCode(code: string): Promise<CodePayload> {
    const payload = this.#open("authorization_code", code);
    if (typeof payload["redirectUri"] !== "string" || typeof payload["codeChallenge"] !== "string") {
      throw new TokenRejected("invalid", "authorization code is malformed");
    }
    await this.#checkDenials(payload);
    if (!(await this.#o.store.markUsed(`code:${payload.jti}`, payload.exp))) {
      await this.revokeSession(payload.sid);
      throw new TokenRejected("reused", "authorization code was already used");
    }
    return payload as unknown as CodePayload;
  }

  /** 失効(RFC 7009)用: アクセス・リフレッシュのどちらでも、開けたら中身を返す(期限切れは undefined)。 */
  peek(token: string): (GrantClaims & Stamped) | undefined {
    for (const purpose of ["refresh_token", "access_token"] as const) {
      try {
        return this.#open(purpose, token);
      } catch {
        // 次の用途を試す
      }
    }
    return undefined;
  }

  async revokeSession(sid: string): Promise<void> {
    const now = this.#now();
    await this.#o.store.addDenial("sid", sid, Number.MAX_SAFE_INTEGER, now + this.#o.refreshTokenTtlMs);
  }
}
