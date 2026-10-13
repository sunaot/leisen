/**
 * leisen-ask serve(Orchestrator の MCP サーバー)の上限(T-021、ADR-018 決定7)。
 *
 * - RunLimiter: 同時に実行する run の数の上限。プロセス内のカウンタで、空きがなければ
 *   待たせずに即座に断る(ask は固定文言の busy を返す)。run は LLM・Gateway への呼び出しを
 *   数十秒〜数分続けるため、待ち行列を作ると接続を抱えたまま詰まる
 * - 質問の長さの上限(maxQuestionChars)。Orchestrator 自身の上限(MAX_QUESTION_CHARS)を
 *   超える値は受けない(超えた分が invalid_input の例外として見えるのを避ける)
 * - feedback の同時実行数の上限(maxConcurrentFeedback、既定 4。セキュリティレビュー m2)。
 *   feedback は本人確認で Gateway に describe を1回呼ぶため、run とは別枠で抑える(超過は
 *   ask と同じ固定文言の busy)
 * - untilAborted: Gateway への往復(preflight・feedback の本人確認)の全体に期限をかける
 * - InFlightRequests: 処理中の HTTP リクエスト数。停止時(SIGTERM / SIGINT)に受付を止めた
 *   あと、進行中のリクエスト(run を含む)の応答が送り終わるまで待つ(上限あり)
 *
 * 利用者単位の流量制御はリバースプロキシで担う(ADR-018 決定7、docs/install.md §6)。
 */
import type { ServerResponse } from "node:http";
import { MAX_QUESTION_CHARS } from "../config.js";
import { GatewayClientError } from "../errors.js";

/** 同時実行の run 数の既定(ADR-018 決定7)。 */
export const DEFAULT_MAX_CONCURRENT_RUNS = 4;
/** 同時実行の run 数として受け付ける上限。 */
export const MAX_CONCURRENT_RUNS_LIMIT = 256;
/** 質問の長さの既定(文字数。ADR-018 決定7)。 */
export const DEFAULT_MAX_QUESTION_CHARS = 4_000;
/** feedback の同時実行数の既定(m2)。 */
export const DEFAULT_MAX_CONCURRENT_FEEDBACK = 4;

export interface ServerLimitsInput {
  /** 同時実行の run 数の上限(1〜MAX_CONCURRENT_RUNS_LIMIT、既定 4) */
  readonly maxConcurrentRuns?: number;
  /** 質問の長さの上限(1〜MAX_QUESTION_CHARS、既定 4000。前後の空白を除いた文字数) */
  readonly maxQuestionChars?: number;
  /** feedback の同時実行数の上限(1〜MAX_CONCURRENT_RUNS_LIMIT、既定 4) */
  readonly maxConcurrentFeedback?: number;
}

function assertIntegerInRange(name: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be an integer between 1 and ${max}`);
  }
}

/** 同時実行数の上限(プロセス内カウンタ、待たせない)。 */
export class ConcurrencyLimiter {
  readonly max: number;
  #active = 0;

  /** name は範囲外のときの例外の文言に使う(設定項目の名前) */
  constructor(max: number, name = "max") {
    assertIntegerInRange(name, max, MAX_CONCURRENT_RUNS_LIMIT);
    this.max = max;
  }

  /** 実行中の数。 */
  get active(): number {
    return this.#active;
  }

  /**
   * 空きがあれば枠を1つ取り、解放する関数を返す(2回目以降の呼び出しは何もしない)。
   * 空きがなければ undefined(待たせない)。
   */
  tryAcquire(): (() => void) | undefined {
    if (this.#active >= this.max) {
      return undefined;
    }
    this.#active += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.#active -= 1;
      }
    };
  }
}

/** 同時実行の run 数の上限(プロセス内カウンタ、待たせない)。 */
export class RunLimiter extends ConcurrencyLimiter {
  constructor(maxConcurrentRuns: number = DEFAULT_MAX_CONCURRENT_RUNS) {
    super(maxConcurrentRuns, "maxConcurrentRuns");
  }

  get maxConcurrentRuns(): number {
    return this.max;
  }
}

/** サーバーの上限一式(プロセスで1つ。リクエストをまたいで共有する)。 */
export class ServerLimits {
  readonly runs: RunLimiter;
  /** feedback の同時実行数(本人確認で Gateway に describe を呼ぶため run と別枠。m2) */
  readonly feedback: ConcurrencyLimiter;
  readonly maxQuestionChars: number;

  constructor(input: ServerLimitsInput = {}) {
    const maxQuestionChars = input.maxQuestionChars ?? DEFAULT_MAX_QUESTION_CHARS;
    assertIntegerInRange("maxQuestionChars", maxQuestionChars, MAX_QUESTION_CHARS);
    this.runs = new RunLimiter(input.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS);
    this.feedback = new ConcurrencyLimiter(
      input.maxConcurrentFeedback ?? DEFAULT_MAX_CONCURRENT_FEEDBACK,
      "maxConcurrentFeedback",
    );
    this.maxQuestionChars = maxQuestionChars;
  }
}

/**
 * promise を signal の中断で打ち切る。中断されたら固定文言の GatewayClientError
 * ("gateway_timeout")で reject する。promise 自体は止めないため、呼び出し側が接続を閉じて
 * 後始末する(Gateway への往復 — preflight・feedback の本人確認 — の全体に期限をかける。
 * signal に従わないクライアントや、SDK が期限を持たない送信でも止まるようにする)。
 */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new GatewayClientError("gateway_timeout", "the gateway did not respond in time"));
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    // 打ち切った後の promise の失敗も、ここで受けて捨てる(未処理の reject にしない)
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * 処理中の HTTP リクエスト数(停止時の待ち合わせ用)。応答の close(送り終わり・切断)で
 * 数から外す。
 */
export class InFlightRequests {
  #count = 0;
  #waiters: (() => void)[] = [];

  get count(): number {
    return this.#count;
  }

  /** リクエストの処理開始時に呼ぶ。 */
  track(res: ServerResponse): void {
    this.#count += 1;
    res.once("close", () => {
      this.#count -= 1;
      if (this.#count === 0) {
        for (const wake of this.#waiters.splice(0)) {
          wake();
        }
      }
    });
  }

  /** 処理中のリクエストがなくなるまで待つ(最大 timeoutMs)。なくなれば true。 */
  whenIdle(timeoutMs: number): Promise<boolean> {
    if (this.#count === 0) {
      return Promise.resolve(true);
    }
    return new Promise((resolveIdle) => {
      let timer: NodeJS.Timeout | undefined;
      const wake = () => {
        clearTimeout(timer);
        resolveIdle(true);
      };
      timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((waiter) => waiter !== wake);
        resolveIdle(false);
      }, timeoutMs);
      timer.unref();
      this.#waiters.push(wake);
    });
  }
}
