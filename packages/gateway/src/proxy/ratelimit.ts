/**
 * ソース別レート制御(T-003)。上限は deployment.yaml の
 * connectors[].limits.maxRequestsPerMinute から注入する(コードに埋めない)。
 *
 * 固定窓カウンタの最小実装。ソースAPIのクォータ保護が目的であり、
 * 公平性・分散協調は骨格のスコープ外(必要になったら差し替える)。
 * ユーザー別ではなくソース別に数える: 認可はソース側で本人資格情報により
 * 行われるため、ここで守るのはクォータのみ。
 */

const WINDOW_MS = 60_000;

interface Window {
  startedAt: number;
  count: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** 拒否時: 次の窓が開くまでの待機ms */
  retryAfterMs?: number;
}

export class SourceRateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    /** sourceId → リクエスト/分 上限。未登録ソースは制限なし */
    private readonly limits: ReadonlyMap<string, number>,
    private readonly now: () => number = Date.now,
  ) {}

  tryAcquire(sourceId: string): RateLimitDecision {
    const limit = this.limits.get(sourceId);
    if (limit === undefined) {
      return { allowed: true };
    }
    const nowMs = this.now();
    const window = this.windows.get(sourceId);
    if (!window || nowMs - window.startedAt >= WINDOW_MS) {
      this.windows.set(sourceId, { startedAt: nowMs, count: 1 });
      return { allowed: true };
    }
    if (window.count >= limit) {
      return {
        allowed: false,
        retryAfterMs: window.startedAt + WINDOW_MS - nowMs,
      };
    }
    window.count += 1;
    return { allowed: true };
  }
}

/**
 * キー(利用者)ごとの固定窓カウンタ(run API の利用者ごとの頻度上限。ADR-019 決定3)。
 * 上限は deployment.yaml の gateway.runs.limits.maxRequestsPerUserPerMinute から注入する。
 * 期限の過ぎた窓は定期的に捨て、利用者数に比例してメモリが残り続けないようにする。
 */
export class PerKeyRateLimiter {
  private readonly windows = new Map<string, Window>();
  private sinceSweep = 0;

  constructor(
    /** キーごとのリクエスト/分 上限 */
    private readonly limit: number,
    private readonly now: () => number = Date.now,
    /** 何回の判定ごとに期限切れの窓を捨てるか */
    private readonly sweepEvery = 1024,
  ) {}

  tryAcquire(key: string): RateLimitDecision {
    const nowMs = this.now();
    if (++this.sinceSweep >= this.sweepEvery) {
      this.sinceSweep = 0;
      for (const [k, w] of this.windows) {
        if (nowMs - w.startedAt >= WINDOW_MS) {
          this.windows.delete(k);
        }
      }
    }
    const window = this.windows.get(key);
    if (!window || nowMs - window.startedAt >= WINDOW_MS) {
      this.windows.set(key, { startedAt: nowMs, count: 1 });
      return { allowed: true };
    }
    if (window.count >= this.limit) {
      return { allowed: false, retryAfterMs: window.startedAt + WINDOW_MS - nowMs };
    }
    window.count += 1;
    return { allowed: true };
  }
}
