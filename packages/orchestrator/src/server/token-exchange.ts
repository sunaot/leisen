/**
 * Orchestrator が受けたトークンを Gateway 宛てに交換する(ADR-022 決定 10、RFC 8693)。
 *
 * Gateway の認可サーバーを有効にした構成では、LibreChat・MCP クライアントは Orchestrator を
 * 受け手(resource)とするトークンを持つ。Orchestrator はそれを Gateway に転送せず(MCP の
 * token passthrough の禁止)、Gateway の /token で Orchestrator の資格情報によるクライアント認証の
 * うえ Gateway 宛ての短命トークンに交換し、交換後のトークンで Gateway を呼ぶ。
 *
 * - 交換結果は受けたトークンの SHA-256 をキーに、期限の 30 秒前までプロセス内で再利用する
 *   (受けたトークンそのものはキーに残さない。件数の上限あり)
 * - Gateway の 400 / 401(無効・期限切れ・失効・受け手違い)は invalid、到達不能・5xx は unavailable
 * トークン・資格情報をログ・エラーに出さない(不変条件6)。
 */
import { createHash } from "node:crypto";

export const ORCHESTRATOR_CLIENT_ID = "leisen-orchestrator";
const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const REUSE_MARGIN_MS = 30_000;
const MAX_CACHE_ENTRIES = 10_000;
const DEFAULT_TIMEOUT_MS = 10_000;

export class TokenExchangeError extends Error {
  constructor(
    public readonly kind: "invalid" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "TokenExchangeError";
  }
}

export interface GatewayTokenExchangerOptions {
  /** Gateway のトークンエンドポイント(Orchestrator から到達できる URL) */
  readonly tokenEndpoint: string;
  /** 交換先の受け手(Gateway の MCP エンドポイントの公開 URL = Gateway の resource) */
  readonly gatewayResource: string;
  /** Orchestrator の資格情報(ログ出力禁止) */
  readonly credential: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export interface TokenExchanger {
  exchange(subjectToken: string): Promise<string>;
}

export class GatewayTokenExchanger implements TokenExchanger {
  readonly #o: GatewayTokenExchangerOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #cache = new Map<string, { token: string; expiresAt: number }>();
  readonly #inflight = new Map<string, Promise<string>>();

  constructor(options: GatewayTokenExchangerOptions) {
    this.#o = options;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async exchange(subjectToken: string): Promise<string> {
    const key = createHash("sha256").update(subjectToken, "utf8").digest("base64url");
    const cached = this.#cache.get(key);
    if (cached !== undefined && cached.expiresAt - REUSE_MARGIN_MS > this.#now()) {
      return cached.token;
    }
    this.#cache.delete(key);
    const pending = this.#inflight.get(key);
    if (pending !== undefined) {
      return pending;
    }
    const run = this.#request(subjectToken)
      .then(({ token, expiresAt }) => {
        if (this.#cache.size >= MAX_CACHE_ENTRIES) {
          this.#prune();
        }
        this.#cache.set(key, { token, expiresAt });
        return token;
      })
      .finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, run);
    return run;
  }

  #prune(): void {
    const now = this.#now();
    for (const [key, entry] of this.#cache) {
      if (entry.expiresAt - REUSE_MARGIN_MS <= now) this.#cache.delete(key);
    }
    // それでも多ければ古い順に半分捨てる
    if (this.#cache.size >= MAX_CACHE_ENTRIES) {
      let drop = Math.floor(this.#cache.size / 2);
      for (const key of this.#cache.keys()) {
        if (drop-- <= 0) break;
        this.#cache.delete(key);
      }
    }
  }

  async #request(subjectToken: string): Promise<{ token: string; expiresAt: number }> {
    const basic = Buffer.from(
      `${encodeURIComponent(ORCHESTRATOR_CLIENT_ID)}:${encodeURIComponent(this.#o.credential)}`,
    ).toString("base64");
    let response: Response;
    try {
      response = await this.#fetch(this.#o.tokenEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: TOKEN_EXCHANGE_GRANT,
          subject_token: subjectToken,
          subject_token_type: ACCESS_TOKEN_TYPE,
          requested_token_type: ACCESS_TOKEN_TYPE,
          resource: this.#o.gatewayResource,
        }).toString(),
        redirect: "manual",
        signal: AbortSignal.timeout(this.#o.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch {
      throw new TokenExchangeError("unavailable", "gateway token endpoint is unreachable");
    }
    if (response.status >= 500) {
      throw new TokenExchangeError("unavailable", `gateway token endpoint returned HTTP ${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    if (!response.ok || typeof record["access_token"] !== "string") {
      throw new TokenExchangeError("invalid", `gateway rejected the token exchange (HTTP ${response.status})`);
    }
    const expiresIn = typeof record["expires_in"] === "number" ? record["expires_in"] : 60;
    return { token: record["access_token"], expiresAt: this.#now() + expiresIn * 1000 };
  }
}
