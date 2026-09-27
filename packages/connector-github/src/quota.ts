/**
 * GitHub API の残quota(レート制限状態)の保持(T-019 受け入れ条件「残quota尊重」)。
 *
 * GitHub の指針(Rate limits for the REST API):
 * - x-ratelimit-remaining が 0 なら x-ratelimit-reset(UTC epoch秒)まで再試行しない
 * - retry-after があればその秒数が経過するまで再試行しない
 * - どちらもない二次制限(secondary rate limit)は最低1分待ち、続く場合は
 *   指数的に待機を延ばす
 * この状態を記録し、制限中は API を呼ばずに rate_limited を返す(呼び出し側の
 * GitHubApiClient が参照する)。
 *
 * 不変条件:
 * - 状態のキーは必ず userId を含む(不変条件4)。GitHub の primary rate limit は
 *   認証ユーザー単位(GitHub App の user access token も本人の枠を消費する)
 *   なので、利用者ごとに分離して保持する。あるユーザーの制限で他のユーザーの
 *   呼び出しを止めない
 * - 上限件数付き(LRU)。無制限に成長させない。溢れた場合は最も長く参照されて
 *   いないエントリを捨てる(捨てられたユーザーは次回 API を呼び、GitHub が再び
 *   制限応答を返せばそこで再記録される。安全側の縮退)
 * - 保持するのはヘッダ由来の数値と時刻のみ。トークン・クエリ・レスポンス本文は
 *   保持しない(不変条件6)
 */

/** GitHub のレート制限リソース種別(x-ratelimit-resource)のうち本コネクタが使うもの。 */
export type GitHubRateLimitResource = "core" | "search" | "code_search";

export interface QuotaTrackerOptions {
  /** 保持するエントリ(ユーザー×リソース種別)数の上限。既定 10000 */
  readonly maxEntries?: number;
  /** 二次制限(待機時間の指示なし)の初回待機ms。既定 60000(GitHub指針: 最低1分) */
  readonly secondaryBackoffBaseMs?: number;
  /** 二次制限の指数バックオフの上限ms。既定 900000(15分) */
  readonly secondaryBackoffMaxMs?: number;
  /** テスト用クロック注入 */
  readonly now?: () => number;
}

/** レスポンスヘッダから読んだ primary rate limit の状態。 */
export interface RateLimitSnapshot {
  readonly remaining: number | undefined;
  readonly resetAtMs: number | undefined;
}

/** 制限応答(403/429)の内訳。 */
export interface RateLimitSignal {
  /** retry-after 由来の待機ms */
  readonly retryAfterMs: number | undefined;
  /** x-ratelimit-remaining: 0(primary rate limit の枯渇) */
  readonly primaryExhausted: boolean;
  readonly resetAtMs: number | undefined;
}

export type QuotaDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterMs: number };

interface QuotaEntry {
  remaining: number | undefined;
  resetAtMs: number | undefined;
  /** retry-after / 二次制限による待機の終了時刻 */
  blockedUntilMs: number | undefined;
  /** 連続した二次制限の回数(指数バックオフの指数) */
  secondaryStrikes: number;
  lastStrikeAtMs: number | undefined;
}

export const DEFAULT_QUOTA_MAX_ENTRIES = 10_000;
export const DEFAULT_SECONDARY_BACKOFF_BASE_MS = 60_000;
export const DEFAULT_SECONDARY_BACKOFF_MAX_MS = 15 * 60_000;
/** 待機時間の下限(時計のずれで reset が過去になった場合等の連打防止) */
const MIN_WAIT_MS = 1_000;

/**
 * キー区切りに情報単位区切り文字(U+001F)を使う。userId と resource の連結で
 * 別ユーザーのキーと衝突しない(Gateway の CredentialCache と同じ方式)。
 */
function quotaKey(userId: string, resource: GitHubRateLimitResource): string {
  if (userId === "") {
    // 空 userId を許すと全ユーザー共有キーに縮退する(不変条件4違反)
    throw new Error("github quota: userId must be non-empty");
  }
  return `${userId}\u001f${resource}`;
}

function positiveInteger(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

export class QuotaTracker {
  private readonly entries = new Map<string, QuotaEntry>();
  private readonly maxEntries: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly now: () => number;

  constructor(options: QuotaTrackerOptions = {}) {
    this.maxEntries = positiveInteger(
      "rateLimit.maxEntries",
      options.maxEntries,
      DEFAULT_QUOTA_MAX_ENTRIES,
    );
    this.backoffBaseMs = positiveInteger(
      "rateLimit.secondaryBackoffBaseMs",
      options.secondaryBackoffBaseMs,
      DEFAULT_SECONDARY_BACKOFF_BASE_MS,
    );
    this.backoffMaxMs = positiveInteger(
      "rateLimit.secondaryBackoffMaxMs",
      options.secondaryBackoffMaxMs,
      DEFAULT_SECONDARY_BACKOFF_MAX_MS,
    );
    if (this.backoffMaxMs < this.backoffBaseMs) {
      throw new RangeError(
        "rateLimit.secondaryBackoffMaxMs must be >= rateLimit.secondaryBackoffBaseMs",
      );
    }
    this.now = options.now ?? Date.now;
  }

  /** 追跡中のエントリ数(観測・テスト用。ユーザーIDや値は出さない)。 */
  get size(): number {
    return this.entries.size;
  }

  /**
   * API を呼んでよいか。制限中(remaining 0 かつ reset 未到来、または
   * retry-after / 二次制限の待機中)なら待機msを返す。
   */
  check(userId: string, resource: GitHubRateLimitResource): QuotaDecision {
    const key = quotaKey(userId, resource);
    const entry = this.entries.get(key);
    if (!entry) {
      return { allowed: true };
    }
    const now = this.now();
    const waitUntil = this.blockedUntil(entry, now);
    if (waitUntil !== undefined) {
      this.store(key, entry);
      return { allowed: false, retryAfterMs: waitUntil - now };
    }
    this.pruneOrStore(key, entry, now);
    return { allowed: true };
  }

  /** 任意のレスポンス(成功・失敗とも)の x-ratelimit-* を記録する。 */
  observe(
    userId: string,
    resource: GitHubRateLimitResource,
    snapshot: RateLimitSnapshot,
  ): void {
    if (snapshot.remaining === undefined) {
      return;
    }
    const key = quotaKey(userId, resource);
    const existing = this.entries.get(key);
    if (snapshot.remaining > 0 && !existing) {
      // 余裕がある状態は保持しない(制限判定に影響しないため)
      return;
    }
    const entry = existing ?? newEntry();
    entry.remaining = snapshot.remaining;
    entry.resetAtMs = snapshot.resetAtMs;
    this.pruneOrStore(key, entry, this.now());
  }

  /** 成功応答: 二次制限の連続回数をリセットする。 */
  recordSuccess(userId: string, resource: GitHubRateLimitResource): void {
    const key = quotaKey(userId, resource);
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    entry.secondaryStrikes = 0;
    entry.lastStrikeAtMs = undefined;
    this.pruneOrStore(key, entry, this.now());
  }

  /**
   * 制限応答(403/429)を記録し、再試行までの待機msを返す。
   * 優先順: retry-after → x-ratelimit-reset(remaining 0 の場合)→ 二次制限の指数バックオフ。
   * 返す値は記録後の実効の待機時間(既存の待機がより長ければそちら)。
   */
  recordRateLimited(
    userId: string,
    resource: GitHubRateLimitResource,
    signal: RateLimitSignal,
  ): number {
    const key = quotaKey(userId, resource);
    const now = this.now();
    const entry = this.entries.get(key) ?? newEntry();
    // 同じ待機期間内に並行リクエストの制限応答が重なった場合(issue と PR の
    // 検索は同じ search 枠を使う)は、連続回数を重ねて数えない
    const blockedUntil = entry.blockedUntilMs ?? 0;
    const alreadyBlocked = blockedUntil > now;
    let waitMs: number;
    if (signal.retryAfterMs !== undefined) {
      waitMs = Math.max(signal.retryAfterMs, MIN_WAIT_MS);
      if (!alreadyBlocked) {
        this.strike(entry, now);
      }
    } else if (signal.primaryExhausted && signal.resetAtMs !== undefined) {
      waitMs = Math.max(signal.resetAtMs - now, MIN_WAIT_MS);
    } else if (alreadyBlocked) {
      waitMs = blockedUntil - now;
    } else {
      const strikes = this.strike(entry, now);
      waitMs = Math.min(
        this.backoffBaseMs * 2 ** Math.min(strikes - 1, 30),
        this.backoffMaxMs,
      );
    }
    const until = Math.max(blockedUntil, now + waitMs);
    entry.blockedUntilMs = until;
    this.store(key, entry);
    return until - now;
  }

  private strike(entry: QuotaEntry, now: number): number {
    // 長く間が空いた後の制限は「連続」とみなさない
    if (
      entry.lastStrikeAtMs !== undefined &&
      now - entry.lastStrikeAtMs > 2 * this.backoffMaxMs
    ) {
      entry.secondaryStrikes = 0;
    }
    entry.secondaryStrikes += 1;
    entry.lastStrikeAtMs = now;
    return entry.secondaryStrikes;
  }

  private blockedUntil(entry: QuotaEntry, now: number): number | undefined {
    let until: number | undefined;
    if (entry.blockedUntilMs !== undefined && entry.blockedUntilMs > now) {
      until = entry.blockedUntilMs;
    }
    if (
      entry.remaining === 0 &&
      entry.resetAtMs !== undefined &&
      entry.resetAtMs > now
    ) {
      until = Math.max(until ?? 0, entry.resetAtMs);
    }
    return until;
  }

  /** 制限判定に影響しない状態になったエントリは捨て、それ以外は保持する。 */
  private pruneOrStore(key: string, entry: QuotaEntry, now: number): void {
    const benign =
      this.blockedUntil(entry, now) === undefined && entry.secondaryStrikes === 0;
    if (benign) {
      this.entries.delete(key);
      return;
    }
    this.store(key, entry);
  }

  /** LRU: 参照したエントリを末尾へ移し、上限を超えたら先頭(最古)から捨てる。 */
  private store(key: string, entry: QuotaEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }
}

function newEntry(): QuotaEntry {
  return {
    remaining: undefined,
    resetAtMs: undefined,
    blockedUntilMs: undefined,
    secondaryStrikes: 0,
    lastStrikeAtMs: undefined,
  };
}
