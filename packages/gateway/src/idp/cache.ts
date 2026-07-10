/**
 * 資格情報キャッシュ(T-002)。
 *
 * - キャッシュキーは必ず userId × sourceId(不変条件4)。ユーザー間で
 *   資格情報を共有する経路を作らない。
 * - single-flight: 同一キーへの並行取得は1回のロードに合流する
 *   (トークンリフレッシュ/交換の重複実行防止)。
 * - TTL: 設定TTLと資格情報自体の失効(oauth_bearer.expiresAt)の早い方。
 *   TTLは権限剥奪の反映遅延の上限になる(threat-model TM-C系)ため、
 *   deployment.yaml から注入可能にする。
 */
import type { Credential } from "@kp/connector-sdk";

export interface CredentialCacheOptions {
  /** キャッシュTTL(ms)。既定 5分。 */
  ttlMs?: number;
  /**
   * oauth_bearer の expiresAt をどれだけ手前で失効扱いするか(ms)。
   * 期限直前のトークンをコネクタへ渡して即 auth_expired になるのを避ける。
   */
  expirySafetyMarginMs?: number;
  /** テスト用クロック注入。 */
  now?: () => number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SAFETY_MARGIN_MS = 30 * 1000;

interface CacheEntry {
  credential: Credential;
  expiresAt: number;
}

/**
 * キー区切りに情報単位区切り文字(U+001F)を使い、userId/sourceId の連結で
 * 別ユーザーのキーと衝突しないようにする。
 */
function cacheKey(userId: string, sourceId: string): string {
  if (userId === "") {
    // 空userIdを許すと全ユーザー共有キーに縮退する(不変条件4違反)
    throw new Error("credential cache: userId must be non-empty");
  }
  return `${userId}${sourceId}`;
}

export class CredentialCache {
  private readonly ttlMs: number;
  private readonly safetyMarginMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry>();
  /** single-flight用: 進行中のロード。 */
  private readonly inflight = new Map<string, Promise<Credential>>();

  constructor(options: CredentialCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.safetyMarginMs =
      options.expirySafetyMarginMs ?? DEFAULT_SAFETY_MARGIN_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * キャッシュがあれば返し、なければ loader で取得して格納する。
   * 同一キーの並行呼び出しは同じ loader 実行に合流する(single-flight)。
   * loader の失敗はキャッシュしない(次回呼び出しで再試行)。
   */
  async getOrLoad(
    userId: string,
    sourceId: string,
    loader: () => Promise<Credential>,
  ): Promise<Credential> {
    const key = cacheKey(userId, sourceId);
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.now()) {
      return cached.credential;
    }
    this.entries.delete(key);

    const pending = this.inflight.get(key);
    if (pending) {
      return pending;
    }
    const load = (async () => {
      const credential = await loader();
      this.entries.set(key, {
        credential,
        expiresAt: this.entryExpiry(credential),
      });
      return credential;
    })().finally(() => {
      // 失敗してもinflightから必ず外す(失敗の永続化はしない)
      this.inflight.delete(key);
    });
    this.inflight.set(key, load);
    return load;
  }

  /** 単一ソースの失効(revoke・auth_expired検知時)。 */
  invalidate(userId: string, sourceId: string): void {
    this.entries.delete(cacheKey(userId, sourceId));
  }

  /** ユーザーの全エントリ破棄(deprovisioning連動、TM-C4)。 */
  invalidateUser(userId: string): void {
    const prefix = `${userId}`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  /** テスト・監視用: 有効エントリ数。 */
  size(): number {
    return this.entries.size;
  }

  private entryExpiry(credential: Credential): number {
    const byTtl = this.now() + this.ttlMs;
    if (credential.kind === "oauth_bearer") {
      return Math.min(byTtl, credential.expiresAt - this.safetyMarginMs);
    }
    return byTtl;
  }
}
