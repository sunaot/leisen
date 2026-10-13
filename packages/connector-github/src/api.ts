/**
 * GitHub REST API の薄いラッパー(T-019)。
 *
 * 責務は次の3つに限る:
 * 1. 利用者本人の資格情報(AuthContext の oauth_bearer)で1リクエストを送る
 * 2. 応答を ConnectorErrorClass に分類する
 * 3. 残quota(x-ratelimit-* / retry-after)を記録し、制限中は API を呼ばない
 *
 * リトライはしない。再試行の判断と回数の記録は Gateway / Orchestrator 側で行い
 * (監査レコードの retryCount と整合させるため)、ここでは rate_limited の
 * retryAfterMs で待機時間を伝える。タイムアウト・ベースURL・fetch は注入可能
 * (CLAUDE.md 開発ルール: 外部SaaSは薄いラッパー越し・設定注入可能)。
 *
 * 不変条件:
 * - 全リクエストを AuthContext の本人トークンで送る。サービスアカウント・
 *   GitHub App の installation token へのフォールバックは持たない
 *   (不変条件1。auth-matrix §4: installation token は本人性を満たさず採用不可)。
 *   資格情報プロバイダの取り違えに備え、installation token / refresh token の
 *   接頭辞を持つトークンは API を呼ぶ前に拒否する(多層防御)
 * - エラーメッセージにトークン・レスポンス本文・URL(クエリ)を含めない
 *   (不変条件6、TM-A2)。識別には固定のエンドポイントラベルだけを使う
 * - レート制限状態は userId ごとに分離する(不変条件4、quota.ts)
 */
import { ConnectorError, type AuthContext } from "@leisen/connector-sdk";
import { integerOption } from "./options.js";
import {
  QuotaTracker,
  type GitHubRateLimitResource,
  type QuotaTrackerOptions,
  type RateLimitSnapshot,
} from "./quota.js";

/**
 * 注入可能な fetch。既定はグローバル fetch。
 *
 * 前提(注入する実装が満たすこと): `init.redirect === "manual"` を尊重し、3xx を
 * 追従せずにそのまま返すこと。本クライアントはリダイレクトを自前で追い、baseUrl と
 * 同じオリジン・ベースパス内に限って本人トークンを再送する(GitHubApiClient.send)。
 * 前提に反して自動追従する実装では、転送先へトークンが送られうる(送出後は取り消せ
 * ない)。違反の検知として `response.redirected === true` の応答は使わずに
 * source_unavailable で失敗させる(fail-closed)が、これは送出の防止ではない。
 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
/** REST API バージョン(X-GitHub-Api-Version)。 */
export const GITHUB_API_VERSION = "2022-11-28";
export const DEFAULT_GITHUB_TIMEOUT_MS = 30_000;
export const DEFAULT_GITHUB_USER_AGENT = "leisen-connector-github/0.1.0";
export const GITHUB_JSON_MEDIA_TYPE = "application/vnd.github+json";
/** 検索結果に text_matches(一致箇所の断片)を含める GitHub の媒体型。 */
export const GITHUB_TEXT_MATCH_MEDIA_TYPE =
  "application/vnd.github.text-match+json";

const MAX_TIMEOUT_MS = 10 * 60_000;
/** Bearer トークンとして送ってよい文字(可視ASCII)。空白・制御文字はヘッダ注入になる */
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;
const USER_AGENT_PATTERN = /^[\x20-\x7e]+$/;
/** エラー本文の読み取り上限(分類にのみ使い、外へは出さない) */
const MAX_ERROR_BODY_CHARS = 16_384;
/** 自前で追うリダイレクト(同一オリジン・ベースパス内のみ)の最大回数 */
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/**
 * エンコードされた区切り文字(%2F = "/"、%5C = "\")。リダイレクト先のパスに
 * 含まれる場合は追わない: URL としてはベースパス内に見えても、サーバー側の復号で
 * 区切り文字になりベースパスの外(例: /api/v3/x/..%2F..%2Fadmin)へ抜けうる。
 */
const ENCODED_SEPARATOR_PATTERN = /%(?:2f|5c)/i;
/**
 * 本人の user token として受け付けないトークン種別の接頭辞(多層防御)。
 * - ghs_: GitHub App の installation access token(app 自身として動作し、本人の
 *   権限判定にならない。auth-matrix §4 で採用不可)
 * - ghr_: refresh token(API 認証に使うものではなく、Token Vault の外に出ない)
 * 資格情報プロバイダ(IdP Adapter / Token Vault)の取り違えを API 呼び出し前に止める。
 */
const NON_USER_TOKEN_PREFIXES: readonly string[] = ["ghs_", "ghr_"];

export type RateLimitOptions = Omit<QuotaTrackerOptions, "now">;

export interface GitHubApiClientOptions {
  /**
   * REST API のベースURL。既定 https://api.github.com。
   * GitHub Enterprise Server では https://HOST/api/v3。https 必須
   * (http は loopback のみ許可。トークンを平文で送らない)。
   */
  readonly baseUrl?: string;
  /** 1リクエストのタイムアウト(ms)。既定 30000 */
  readonly timeoutMs?: number;
  /** User-Agent(GitHub API は必須)。既定 leisen-connector-github/0.1.0 */
  readonly userAgent?: string;
  /** テスト・プロキシ用の fetch 注入 */
  readonly fetchImpl?: FetchLike;
  /** テスト用クロック注入(失効判定・レート制限の待機計算) */
  readonly now?: () => number;
  /** 残quota追跡の設定 */
  readonly rateLimit?: RateLimitOptions;
}

export interface GitHubRequest {
  /**
   * エラーメッセージ用の固定ラベル(例: "search.issues")。URL・クエリ・
   * 利用者入力を入れない。
   */
  readonly endpoint: string;
  /** レート制限のリソース種別(quota の保持単位) */
  readonly resource: GitHubRateLimitResource;
  /** baseUrl からの相対パス("/" 始まり)。可変部分は呼び出し側でエンコード済みであること */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  /** Accept の上書き(text-match 等、GitHub の JSON 媒体型のみ) */
  readonly accept?: string;
}

export interface GitHubResponse {
  readonly data: unknown;
  /** Link ヘッダに rel="next" がある(続きのページがある) */
  readonly hasNextPage: boolean;
}

export class GitHubApiClient {
  readonly baseUrl: string;
  /** 残quotaの追跡状態(ユーザー×リソース種別) */
  readonly quota: QuotaTracker;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(options: GitHubApiClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? DEFAULT_GITHUB_API_BASE_URL,
    );
    this.timeoutMs = integerOption(
      "timeoutMs",
      options.timeoutMs,
      DEFAULT_GITHUB_TIMEOUT_MS,
      1,
      MAX_TIMEOUT_MS,
    );
    this.userAgent = normalizeUserAgent(options.userAgent);
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.quota = new QuotaTracker({ ...options.rateLimit, now: this.now });
  }

  /**
   * 資格情報の前提検査(API を呼ぶ前)。コネクタの各操作の入口で呼び、
   * 入力検証より先に認可の前提違反を返す。
   * - userId 空 → invalid_request(ユーザー単位の状態キーが縮退するため)
   * - oauth_bearer 以外(delegated_identity)→ invalid_request
   * - トークン空・不正文字 → auth_expired(再接続が必要)
   * - installation token(ghs_)/ refresh token(ghr_)の接頭辞 → invalid_request
   *   (本人の user token ではない。プロバイダの取り違え。メッセージにトークンを含めない)
   * - expiresAt が有限数でない(NaN / ±Infinity)→ auth_expired
   * - expiresAt 経過 → auth_expired(0 以下は「失効時刻不明」とみなして判定せず、
   *   GitHub の 401 に委ねる。SDK 未定義の暫定扱い。bearerTokenOf の TODO 参照)
   */
  assertUsableCredential(auth: AuthContext): void {
    this.bearerTokenOf(auth);
  }

  /** GET リクエスト(本コネクタは読み取り専用)。 */
  async get(auth: AuthContext, request: GitHubRequest): Promise<GitHubResponse> {
    const token = this.bearerTokenOf(auth);
    const gate = this.quota.check(auth.userId, request.resource);
    if (!gate.allowed) {
      throw new ConnectorError(
        "rate_limited",
        `GitHub ${request.resource} rate limit is exhausted for this user; ` +
          `${request.endpoint} was not called (retry after ${seconds(gate.retryAfterMs)}s)`,
        gate.retryAfterMs,
      );
    }

    const signal = AbortSignal.timeout(this.timeoutMs);
    const response = await this.send(request, token, signal);

    const snapshot = readRateLimitSnapshot(response.headers);
    this.quota.observe(auth.userId, request.resource, snapshot);

    if (response.ok) {
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        if (signal.aborted) {
          throw this.transportError(request, signal);
        }
        throw new ConnectorError(
          "source_unavailable",
          `GitHub API ${request.endpoint} returned a malformed JSON body`,
        );
      }
      this.quota.recordSuccess(auth.userId, request.resource);
      return { data, hasNextPage: hasNextLink(response.headers.get("link")) };
    }
    throw await this.classifyFailure(auth.userId, request, response, snapshot);
  }

  /**
   * リクエストを送る。リダイレクトは自前で追い(redirect: "manual")、
   * 設定した baseUrl と同じオリジン・ベースパス内の場合に限って本人トークン付きで
   * 再送する(リネームされた repo・移管された issue の 301 等)。それ以外への
   * リダイレクトは追わない。fetch 実装が redirect: "manual" を尊重する(FetchLike の
   * 前提)限り、トークンを baseUrl 以外へ送らない(不変条件6)。前提違反
   * (response.redirected)は検知して応答を使わない。
   */
  private async send(
    request: GitHubRequest,
    token: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const init: RequestInit = {
      method: "GET",
      headers: {
        accept: request.accept ?? GITHUB_JSON_MEDIA_TYPE,
        authorization: `Bearer ${token}`,
        "user-agent": this.userAgent,
        "x-github-api-version": GITHUB_API_VERSION,
      },
      signal,
      redirect: "manual",
    };
    let url = this.buildUrl(request);
    for (let hops = 0; ; hops += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, init);
      } catch {
        // 原因(cause)にURL・クエリ・接続先詳細が含まれうるため付け直さない
        throw this.transportError(request, signal);
      }
      if (response.redirected === true) {
        // 注入 fetch が redirect: "manual" を尊重せず追従した(FetchLike の前提違反)。
        // 転送先の応答を GitHub の応答として扱わない(fail-closed)
        await discardBody(response);
        throw new ConnectorError(
          "source_unavailable",
          `GitHub API ${request.endpoint} response came from a redirect followed by the fetch ` +
            'implementation (redirect: "manual" was not honoured); the response was discarded',
        );
      }
      if (!REDIRECT_STATUSES.has(response.status)) {
        return response;
      }
      const location = response.headers.get("location");
      await discardBody(response);
      const next =
        location === null ? undefined : this.resolveRedirect(location, url);
      if (next === undefined || hops >= MAX_REDIRECTS) {
        throw new ConnectorError(
          "source_unavailable",
          `GitHub API ${request.endpoint} redirected outside the configured API base URL ` +
            "(or to an encoded path separator, or too many times); " +
            "the redirect was not followed with the user's token",
        );
      }
      url = next;
    }
  }

  /**
   * リダイレクト先が baseUrl と同じオリジン・ベースパス内なら絶対URL、そうでなければ
   * undefined。パスにエンコードされた区切り文字(%2F / %5C)を含むものも追わない。
   */
  private resolveRedirect(location: string, current: string): string | undefined {
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return undefined;
    }
    const base = new URL(this.baseUrl);
    const basePath = base.pathname.replace(/\/+$/, "");
    if (
      next.origin !== base.origin ||
      next.username !== "" ||
      next.password !== "" ||
      ENCODED_SEPARATOR_PATTERN.test(next.pathname) ||
      (basePath !== "" && !next.pathname.startsWith(`${basePath}/`))
    ) {
      return undefined;
    }
    return next.toString();
  }

  private bearerTokenOf(auth: AuthContext): string {
    if (auth.userId === "") {
      throw new ConnectorError(
        "invalid_request",
        "AuthContext.userId is required for GitHub calls",
      );
    }
    const credential = auth.credential;
    if (credential.kind !== "oauth_bearer") {
      throw new ConnectorError(
        "invalid_request",
        `GitHub connector requires an oauth_bearer credential (got ${credential.kind})`,
      );
    }
    if (credential.accessToken === "") {
      throw new ConnectorError(
        "auth_expired",
        "GitHub access token is missing; the user must (re)connect GitHub",
      );
    }
    if (!TOKEN_PATTERN.test(credential.accessToken)) {
      throw new ConnectorError(
        "auth_expired",
        "GitHub access token is malformed; the user must reconnect GitHub",
      );
    }
    const token = credential.accessToken;
    if (NON_USER_TOKEN_PREFIXES.some((prefix) => token.startsWith(prefix))) {
      throw new ConnectorError(
        "invalid_request",
        "GitHub connector requires the user's own access token; " +
          "a GitHub App installation token or refresh token was supplied",
      );
    }
    // 失効時刻は有限の epoch ms であること。NaN / ±Infinity は解釈できないため
    // 失効扱いにする(Infinity を「無期限」として通さない)
    if (!Number.isFinite(credential.expiresAt)) {
      throw new ConnectorError(
        "auth_expired",
        "GitHub access token has no valid expiry time; the user must reconnect GitHub",
      );
    }
    // TODO(T-004 / ADR-016 追補): expiresAt <= 0 の意味は connector-sdk で未定義
    // (型コメントは「トークン失効時刻(epoch ms)」のみ)。現状は「失効時刻不明」
    // (失効しないトークン等)とみなして判定せず、GitHub の 401 に委ねる暫定扱い。
    // Token Vault(T-004)で失効時刻不明の表現を確定し、SDK の型コメントに追補する
    if (credential.expiresAt > 0 && credential.expiresAt <= this.now()) {
      throw new ConnectorError(
        "auth_expired",
        "GitHub access token has expired; the user must reconnect GitHub",
      );
    }
    return token;
  }

  private buildUrl(request: GitHubRequest): string {
    assertSafePath(request.path);
    const url = new URL(`${this.baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private transportError(
    request: GitHubRequest,
    signal: AbortSignal,
  ): ConnectorError {
    if (signal.aborted) {
      return new ConnectorError(
        "source_unavailable",
        `GitHub API ${request.endpoint} timed out after ${this.timeoutMs}ms`,
      );
    }
    return new ConnectorError(
      "source_unavailable",
      `GitHub API ${request.endpoint} request failed (network error)`,
    );
  }

  private async classifyFailure(
    userId: string,
    request: GitHubRequest,
    response: Response,
    snapshot: RateLimitSnapshot,
  ): Promise<ConnectorError> {
    const status = response.status;
    const label = `GitHub API ${request.endpoint} responded HTTP ${status}`;

    if (status === 403 || status === 429) {
      const body = await readErrorSummary(response);
      const retryAfterMs = parseRetryAfterMs(
        response.headers.get("retry-after"),
        this.now(),
      );
      const primaryExhausted = snapshot.remaining === 0;
      if (
        retryAfterMs !== undefined ||
        primaryExhausted ||
        status === 429 ||
        body.rateLimited
      ) {
        const waitMs = this.quota.recordRateLimited(userId, request.resource, {
          retryAfterMs,
          primaryExhausted,
          resetAtMs: snapshot.resetAtMs,
        });
        return new ConnectorError(
          "rate_limited",
          `${label} (rate limited; retry after ${seconds(waitMs)}s)`,
          waitMs,
        );
      }
      if (body.tooLarge) {
        return new ConnectorError(
          "invalid_request",
          `${label} (the file is larger than the contents API limit of 1MB)`,
        );
      }
      if (response.headers.has("x-github-sso")) {
        return new ConnectorError(
          "permission_denied",
          `${label} (the organization requires SAML SSO authorization for this user's GitHub token)`,
        );
      }
      return new ConnectorError(
        "permission_denied",
        `${label} (access denied for this user)`,
      );
    }

    await discardBody(response);
    if (status === 401) {
      return new ConnectorError(
        "auth_expired",
        `${label} (token rejected; the user must reconnect GitHub)`,
      );
    }
    if (status === 404 || status === 409 || status === 410) {
      return new ConnectorError("not_found", `${label} (not found)`);
    }
    if (status === 451) {
      return new ConnectorError(
        "permission_denied",
        `${label} (unavailable for legal reasons)`,
      );
    }
    if (status >= 500) {
      return new ConnectorError("source_unavailable", label);
    }
    if (status >= 400) {
      // 400 / 422(検索クエリの検証失敗。権限外の repo:/org: 指定も GitHub は
      // 存在有無を区別せず 422 を返す)ほか
      return new ConnectorError("invalid_request", `${label} (request rejected)`);
    }
    return new ConnectorError(
      "source_unavailable",
      `${label} (unexpected response)`,
    );
  }
}

function seconds(ms: number): number {
  return Math.ceil(ms / 1000);
}

function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // 受領値をメッセージに含めない(資格情報入りURLを誤設定した場合のエコー防止)
    throw new RangeError("baseUrl must be an absolute URL");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new RangeError(
      "baseUrl must use https (http is allowed only for loopback hosts)",
    );
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new RangeError(
      "baseUrl must not contain credentials, a query string or a fragment",
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function normalizeUserAgent(value: string | undefined): string {
  if (value === undefined) {
    return DEFAULT_GITHUB_USER_AGENT;
  }
  const trimmed = value.trim();
  if (trimmed === "" || !USER_AGENT_PATTERN.test(trimmed)) {
    throw new RangeError("userAgent must be a non-empty printable ASCII string");
  }
  return trimmed;
}

/**
 * パスの安全性検査(多層防御)。可変部分の検証とエンコードは呼び出し側
 * (document-id.ts)が行うが、ドットセグメントによるエンドポイントのすり替え
 * (URL 正規化で "/repos/o/r/contents/../../x" が別APIになる)をここでも拒否する。
 */
function assertSafePath(path: string): void {
  const invalid = new ConnectorError("invalid_request", "unsafe GitHub API path");
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
    throw invalid;
  }
  for (const segment of path.slice(1).split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw invalid;
    }
    if (segment === "" || decoded === "." || decoded === "..") {
      throw invalid;
    }
  }
}

function parseNonNegativeInt(value: string | null): number | undefined {
  if (value === null || !/^\d{1,15}$/.test(value.trim())) {
    return undefined;
  }
  return Number(value.trim());
}

function readRateLimitSnapshot(headers: Headers): RateLimitSnapshot {
  const reset = parseNonNegativeInt(headers.get("x-ratelimit-reset"));
  return {
    remaining: parseNonNegativeInt(headers.get("x-ratelimit-remaining")),
    resetAtMs: reset === undefined ? undefined : reset * 1000,
  };
}

/** retry-after(秒 または HTTP-date)を待機msにする。解釈できなければ undefined。 */
export function parseRetryAfterMs(
  value: string | null,
  now: number,
): number | undefined {
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d{1,10}$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.max(0, date - now);
}

/** Link ヘッダに rel="next" があるか(RFC 8288 の最小解釈)。 */
export function hasNextLink(link: string | null): boolean {
  if (link === null) {
    return false;
  }
  const pattern = /<[^>]*>((?:\s*;\s*[^;,]*)*)/g;
  for (const match of link.matchAll(pattern)) {
    const params = match[1] ?? "";
    const rel = /;\s*rel\s*=\s*"?([^";,]*)"?/i.exec(params);
    if (rel?.[1]?.split(/\s+/).some((value) => value.toLowerCase() === "next")) {
      return true;
    }
  }
  return false;
}

interface ErrorSummary {
  /** 本文が(二次)レート制限を示す */
  readonly rateLimited: boolean;
  /** contents API のサイズ上限超過(errors[].code: too_large) */
  readonly tooLarge: boolean;
}

/**
 * 403/429 の本文を分類のためだけに読む。本文の内容はメッセージ・ログに出さない。
 * GitHub は二次制限をヘッダなしの 403 と「secondary rate limit」を含む本文で
 * 返すことがある(Rate limits for the REST API)。
 */
async function readErrorSummary(response: Response): Promise<ErrorSummary> {
  let parsed: unknown;
  try {
    const text = await response.text();
    parsed = JSON.parse(text.slice(0, MAX_ERROR_BODY_CHARS));
  } catch {
    return { rateLimited: false, tooLarge: false };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { rateLimited: false, tooLarge: false };
  }
  const record = parsed as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message : "";
  const errors = Array.isArray(record.errors) ? record.errors : [];
  const tooLargeCode = errors.some(
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      (error as Record<string, unknown>).code === "too_large",
  );
  return {
    rateLimited: /rate limit|abuse detection/i.test(message),
    tooLarge: tooLargeCode || /too large/i.test(message),
  };
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 破棄の失敗は分類に影響しない
  }
}
