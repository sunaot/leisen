/**
 * レート制限のテスト(T-019 受け入れ条件「レート制限対応(残quota尊重)がテストされている」)。
 *
 * - 403/429 の制限応答を rate_limited に分類し、retryAfterMs を GitHub の指針どおりに計算する
 *   (retry-after 秒 → x-ratelimit-reset − 現在時刻 → 二次制限は最低1分から指数的に延長)
 * - x-ratelimit-remaining: 0 を観測したら reset まで API を呼ばずに rate_limited を返す
 * - 状態はユーザー(userId)ごと・リソース種別(core / search / code_search)ごとに分離する(不変条件4)
 * - 追跡状態は上限件数で打ち切る(無制限に成長しない)
 */
import { describe, expect, it } from "vitest";
import { ConnectorError } from "@leisen/connector-sdk";
import { QuotaTracker } from "../src/quota.js";
import { decodeSearchCursor } from "../src/cursor.js";
import {
  ALICE,
  BOB,
  NOW,
  NOW_EPOCH_SEC,
  bearerOf,
  codeItem,
  devToken,
  issueItem,
  jsonResponse,
  qOf,
  searchResponse,
  setup,
} from "./helpers/fake-github.js";

async function captureError(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConnectorError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a ConnectorError, but the call succeeded");
}

const ISSUE_PATH = /^\/repos\/acme\/app\/issues\/12$/;

describe("制限応答の分類と retryAfterMs", () => {
  it("429 + retry-after → rate_limited、retryAfterMs = retry-after 秒 × 1000", async () => {
    const { github, connector } = setup();
    github.onJson(ISSUE_PATH, { message: "slow down" }, { status: 429, headers: { "retry-after": "30" } });
    const error = await captureError(connector.fetch(ALICE, "issue:acme/app#12"));
    expect(error.errorClass).toBe("rate_limited");
    expect(error.retryAfterMs).toBe(30_000);
  });

  it("403 + retry-after → rate_limited(permission_denied にしない)", async () => {
    const { github, connector } = setup();
    github.onJson(
      ISSUE_PATH,
      { message: "You have exceeded a secondary rate limit." },
      { status: 403, headers: { "retry-after": "45" } },
    );
    const error = await captureError(connector.fetch(ALICE, "issue:acme/app#12"));
    expect(error.errorClass).toBe("rate_limited");
    expect(error.retryAfterMs).toBe(45_000);
  });

  it("403 + x-ratelimit-remaining: 0 → rate_limited、retryAfterMs = x-ratelimit-reset − 現在時刻", async () => {
    const { github, connector } = setup();
    github.onJson(
      ISSUE_PATH,
      { message: "API rate limit exceeded" },
      {
        status: 403,
        headers: {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(NOW_EPOCH_SEC + 600),
          "x-ratelimit-resource": "core",
        },
      },
    );
    const error = await captureError(connector.fetch(ALICE, "issue:acme/app#12"));
    expect(error.errorClass).toBe("rate_limited");
    expect(error.retryAfterMs).toBe(600_000);
  });

  it("retry-after の HTTP-date 形式も解釈する", async () => {
    const { github, connector } = setup();
    github.onJson(
      ISSUE_PATH,
      {},
      { status: 429, headers: { "retry-after": new Date(NOW + 90_000).toUTCString() } },
    );
    const error = await captureError(connector.fetch(ALICE, "issue:acme/app#12"));
    expect(error.errorClass).toBe("rate_limited");
    expect(error.retryAfterMs).toBe(90_000);
  });

  it("本文が二次制限を示す 403(ヘッダなし)→ rate_limited、最低1分待機", async () => {
    const { github, connector } = setup();
    github.onJson(
      ISSUE_PATH,
      { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." },
      { status: 403 },
    );
    const error = await captureError(connector.fetch(ALICE, "issue:acme/app#12"));
    expect(error.errorClass).toBe("rate_limited");
    expect(error.retryAfterMs).toBe(60_000);
  });

  it("待機指示のない二次制限は連続するたびに指数的に延長し、成功でリセットする", async () => {
    const { github, clock, connector } = setup();
    let limited = true;
    github.on(ISSUE_PATH, () =>
      limited
        ? jsonResponse({ message: "too many requests" }, { status: 429 })
        : jsonResponse(issueItem({ number: 12 })),
    );

    const first = await captureError(connector.fetch(ALICE, "issue:acme/app#12"));
    expect(first.retryAfterMs).toBe(60_000);
    clock.advance(60_000);
    const second = await captureError(connector.fetch(ALICE, "issue:acme/app#12"));
    expect(second.retryAfterMs).toBe(120_000);
    clock.advance(120_000);
    const third = await captureError(connector.fetch(ALICE, "issue:acme/app#12"));
    expect(third.retryAfterMs).toBe(240_000);

    clock.advance(240_000);
    limited = false;
    await connector.fetch(ALICE, "issue:acme/app#12");

    limited = true;
    const afterSuccess = await captureError(connector.fetch(ALICE, "issue:acme/app#12"));
    expect(afterSuccess.retryAfterMs).toBe(60_000);
  });

  it("同じ待機期間内に並行リクエストの制限応答が重なっても、連続回数を二重に数えない", async () => {
    const { github, clock, connector } = setup({ searchCode: false });
    github.onJson(/^\/search\/issues$/, { message: "too many" }, { status: 429 });

    // issue と PR の2本が同じ search 枠で同時に制限される
    const first = await captureError(connector.search(ALICE, "deploy"));
    expect(first.retryAfterMs).toBe(60_000);
    expect(github.requests).toHaveLength(2);

    clock.advance(60_000);
    const second = await captureError(connector.search(ALICE, "deploy"));
    // 2回目の制限は 2^1 倍(並行分を数えていれば 2^2 倍以上になる)
    expect(second.retryAfterMs).toBe(120_000);
  });

  it("二次制限の待機は上限(secondaryBackoffMaxMs)で頭打ちになる", async () => {
    const { github, clock, connector } = setup({
      rateLimit: { secondaryBackoffBaseMs: 1_000, secondaryBackoffMaxMs: 3_000 },
    });
    github.onJson(ISSUE_PATH, {}, { status: 429 });
    const waits: (number | undefined)[] = [];
    for (let i = 0; i < 4; i += 1) {
      const error = await captureError(connector.fetch(ALICE, "issue:acme/app#12"));
      waits.push(error.retryAfterMs);
      clock.advance(error.retryAfterMs ?? 0);
    }
    expect(waits).toEqual([1_000, 2_000, 3_000, 3_000]);
  });
});

describe("残quotaの尊重(制限中は API を呼ばない)", () => {
  it("remaining: 0 の成功応答の後は reset まで API を呼ばずに rate_limited、reset 経過後は再開する", async () => {
    const { github, clock, connector } = setup();
    github.onJson(ISSUE_PATH, issueItem({ number: 12 }), {
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(NOW_EPOCH_SEC + 120),
        "x-ratelimit-resource": "core",
      },
    });

    // 最後の1回は成功する
    await connector.fetch(ALICE, "issue:acme/app#12");
    expect(github.requests).toHaveLength(1);

    // 次の呼び出しは API を呼ばずに rate_limited
    clock.advance(20_000);
    const blocked = await captureError(connector.fetch(ALICE, "issue:acme/app#12"));
    expect(blocked.errorClass).toBe("rate_limited");
    expect(blocked.retryAfterMs).toBe(100_000);
    expect(github.requests).toHaveLength(1);

    // reset 経過後は再開する
    clock.advance(100_000);
    github.onJson(ISSUE_PATH, issueItem({ number: 12 }), {
      headers: { "x-ratelimit-remaining": "4999", "x-ratelimit-reset": String(NOW_EPOCH_SEC + 3720) },
    });
    await connector.fetch(ALICE, "issue:acme/app#12");
    expect(github.requests).toHaveLength(2);
  });

  it("retry-after で制限された後も、待機期間中は API を呼ばない", async () => {
    const { github, clock, connector } = setup();
    github.onJson(ISSUE_PATH, {}, { status: 429, headers: { "retry-after": "10" } });
    await captureError(connector.fetch(ALICE, "issue:acme/app#12"));
    expect(github.requests).toHaveLength(1);

    clock.advance(4_000);
    const blocked = await captureError(connector.fetch(ALICE, "issue:acme/app#12"));
    expect(blocked.errorClass).toBe("rate_limited");
    expect(blocked.retryAfterMs).toBe(6_000);
    expect(github.requests).toHaveLength(1);

    clock.advance(6_000);
    github.onJson(ISSUE_PATH, issueItem({ number: 12 }));
    await connector.fetch(ALICE, "issue:acme/app#12");
    expect(github.requests).toHaveLength(2);
  });

  it("状態はユーザーごとに分離される(alice の枯渇で bob を止めない)", async () => {
    const { github, connector } = setup();
    github.on(ISSUE_PATH, (req) =>
      bearerOf(req) === `Bearer ${devToken("alice")}`
        ? jsonResponse(issueItem({ number: 12 }), {
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW_EPOCH_SEC + 300) },
          })
        : jsonResponse(issueItem({ number: 12 }), {
            headers: { "x-ratelimit-remaining": "4000", "x-ratelimit-reset": String(NOW_EPOCH_SEC + 300) },
          }),
    );

    await connector.fetch(ALICE, "issue:acme/app#12");
    const aliceBlocked = await captureError(connector.fetch(ALICE, "issue:acme/app#12"));
    expect(aliceBlocked.errorClass).toBe("rate_limited");

    await connector.fetch(BOB, "issue:acme/app#12");
    await connector.fetch(BOB, "issue:acme/app#12");
    const bobRequests = github.requests.filter(
      (req) => bearerOf(req) === `Bearer ${devToken("bob")}`,
    );
    expect(bobRequests).toHaveLength(2);
    expect(github.requests).toHaveLength(3);
  });

  it("状態はリソース種別ごとに分離される(code_search の枯渇は fetch と issue/PR 検索を止めない)", async () => {
    const { github, connector } = setup();
    github
      .on(/^\/search\/code$/, () =>
        searchResponse([codeItem({ path: "src/a.ts", fragments: ["token refresh"] })], {
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(NOW_EPOCH_SEC + 60),
            "x-ratelimit-resource": "code_search",
          },
        }),
      )
      .on(/^\/search\/issues$/, (req) =>
        searchResponse([
          issueItem({ number: qOf(req).includes("is:pull-request") ? 2 : 1, pullRequest: qOf(req).includes("is:pull-request") }),
        ]),
      )
      .onJson(ISSUE_PATH, issueItem({ number: 12 }));

    const first = await connector.search(ALICE, "token refresh");
    expect(first.hits.map((hit) => hit.meta?.type)).toEqual(["issue", "pull_request", "code"]);
    expect(github.requestsTo(/^\/search\/code$/)).toHaveLength(1);

    // code_search は枯渇中: 2回目の検索は /search/code を呼ばず、issue/PR の結果を返す
    const second = await connector.search(ALICE, "token refresh");
    expect(github.requestsTo(/^\/search\/code$/)).toHaveLength(1);
    expect(github.requestsTo(/^\/search\/issues$/)).toHaveLength(4);
    expect(second.hits.map((hit) => hit.meta?.type)).toEqual(["issue", "pull_request"]);
    // コード検索は同じページで再試行できるよう nextCursor に残る
    expect(second.nextCursor).toBeDefined();
    expect(decodeSearchCursor(second.nextCursor!)).toEqual([{ kind: "code", page: 1, perPage: 6 }]);

    // core(fetch)も止まらない
    await connector.fetch(ALICE, "issue:acme/app#12");
    expect(github.requestsTo(ISSUE_PATH)).toHaveLength(1);
  });

  it("検索の全ストリームが制限中なら API を呼ばずに rate_limited を返す", async () => {
    const { github, connector } = setup();
    github.on(/^\/search\/(issues|code)$/, () =>
      jsonResponse({ message: "rate limited" }, { status: 429, headers: { "retry-after": "20" } }),
    );
    const first = await captureError(connector.search(ALICE, "deploy"));
    expect(first.errorClass).toBe("rate_limited");
    const sent = github.requests.length;
    expect(sent).toBe(3);

    const second = await captureError(connector.search(ALICE, "deploy"));
    expect(second.errorClass).toBe("rate_limited");
    expect(second.retryAfterMs).toBe(20_000);
    expect(github.requests).toHaveLength(sent);
  });
});

describe("QuotaTracker", () => {
  it("上限件数を超えると最も古いエントリから捨てる(無制限に成長しない)", () => {
    let now = NOW;
    const tracker = new QuotaTracker({ maxEntries: 2, now: () => now });
    for (const user of ["u1", "u2", "u3"]) {
      tracker.recordRateLimited(user, "core", {
        retryAfterMs: 30_000,
        primaryExhausted: false,
        resetAtMs: undefined,
      });
    }
    expect(tracker.size).toBe(2);
    // u1 は追い出された(次回は API を呼び、GitHub が再び制限すれば再記録される)
    expect(tracker.check("u1", "core")).toEqual({ allowed: true });
    expect(tracker.check("u3", "core")).toEqual({ allowed: false, retryAfterMs: 30_000 });
    now += 30_000;
    expect(tracker.check("u3", "core")).toEqual({ allowed: true });
  });

  it("制限に影響しない状態(remaining > 0)は保持しない", () => {
    const tracker = new QuotaTracker({ now: () => NOW });
    tracker.observe("u1", "core", { remaining: 4999, resetAtMs: NOW + 3_600_000 });
    tracker.observe("u2", "search", { remaining: 29, resetAtMs: NOW + 60_000 });
    expect(tracker.size).toBe(0);
    tracker.observe("u1", "core", { remaining: 0, resetAtMs: NOW + 60_000 });
    expect(tracker.size).toBe(1);
    // reset を迎えて余裕が戻れば捨てる
    tracker.observe("u1", "core", { remaining: 5000, resetAtMs: NOW + 3_660_000 });
    expect(tracker.size).toBe(0);
  });

  it("空の userId はキーにしない(全ユーザー共有キーへの縮退を防ぐ)", () => {
    const tracker = new QuotaTracker();
    expect(() => tracker.check("", "core")).toThrow(/userId/);
  });

  it("connector の rateLimit.maxEntries が追跡状態の上限に効く", async () => {
    const { github, connector } = setup({ rateLimit: { maxEntries: 1 } });
    github.onJson(ISSUE_PATH, {}, { status: 429, headers: { "retry-after": "60" } });
    await captureError(connector.fetch(ALICE, "issue:acme/app#12"));
    await captureError(connector.fetch(BOB, "issue:acme/app#12"));
    expect(github.requests).toHaveLength(2);
    // 最新の bob は保持されており、制限中は API を呼ばない
    const bobBlocked = await captureError(connector.fetch(BOB, "issue:acme/app#12"));
    expect(bobBlocked.errorClass).toBe("rate_limited");
    expect(github.requests).toHaveLength(2);
    // alice の状態は上限で追い出されたため API を呼ぶ(安全側の縮退: GitHub が再び制限応答を返し、再記録される)
    const aliceAgain = await captureError(connector.fetch(ALICE, "issue:acme/app#12"));
    expect(aliceAgain.errorClass).toBe("rate_limited");
    expect(github.requests).toHaveLength(3);
  });

  it("不正な設定値は構築時に拒否する", () => {
    expect(() => new QuotaTracker({ maxEntries: 0 })).toThrow(RangeError);
    expect(
      () => new QuotaTracker({ secondaryBackoffBaseMs: 10_000, secondaryBackoffMaxMs: 5_000 }),
    ).toThrow(RangeError);
  });
});
