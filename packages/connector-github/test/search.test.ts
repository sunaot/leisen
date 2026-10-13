/**
 * search のテスト(T-019)。
 * - issue(is:issue)/ PR(is:pull-request)/ code の3本を統合する(round-robin)
 * - snippet は MAX_SNIPPET_CHARS 以内。SearchResult に総件数を載せない(ADR-012)
 * - filters の修飾子生成(q はデコードして検証。期待値にトークンを入れない)
 * - limit の配分とカーソルによる継続、一部ストリーム失敗時の縮退
 */
import { describe, expect, it } from "vitest";
import { ConnectorError, MAX_SNIPPET_CHARS } from "@leisen/connector-sdk";
import { decodeSearchCursor, encodeSearchCursor } from "../src/cursor.js";
import {
  ALICE,
  COMMIT_SHA,
  TOTAL_COUNT_CANARY,
  codeItem,
  issueItem,
  jsonResponse,
  qOf,
  searchResponse,
  setup,
  type FakeGitHub,
  type RecordedRequest,
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

function isPrQuery(request: RecordedRequest): boolean {
  return qOf(request).includes("is:pull-request");
}

function perPageOf(request: RecordedRequest): number {
  return Number(request.url.searchParams.get("per_page"));
}

function pageOf(request: RecordedRequest): number {
  return Number(request.url.searchParams.get("page"));
}

/** issue / PR / code を2件ずつ返す既定ルート。 */
function routeSearch(github: FakeGitHub, options: { next?: boolean } = {}): void {
  github
    .on(/^\/search\/issues$/, (req) =>
      isPrQuery(req)
        ? searchResponse(
            [
              issueItem({ number: 21, title: "PR one", pullRequest: true }),
              issueItem({ number: 22, title: "PR two", pullRequest: true }),
            ],
            options,
          )
        : searchResponse(
            [
              issueItem({ number: 11, title: "Issue one" }),
              issueItem({ number: 12, title: "Issue two" }),
            ],
            options,
          ),
    )
    .on(/^\/search\/code$/, () =>
      searchResponse(
        [
          codeItem({ path: "src/auth/login.ts", fragments: ["export function login()"] }),
          codeItem({ path: "docs/設計 メモ.md", fragments: ["login flow"] }),
        ],
        options,
      ),
    );
}

describe("検索の統合", () => {
  it("issue / PR / code を別クエリで検索し、round-robin で統合する", async () => {
    const { github, connector } = setup();
    routeSearch(github);

    const result = await connector.search(ALICE, "login");

    const issueQueries = github.requestsTo(/^\/search\/issues$/).map(qOf);
    expect(issueQueries.sort()).toEqual(["login is:issue", "login is:pull-request"]);
    const code = github.requestsTo(/^\/search\/code$/);
    expect(code.map(qOf)).toEqual(["login"]);
    expect(code[0]!.headers.get("accept")).toBe("application/vnd.github.text-match+json");

    expect(result.hits.map((hit) => hit.documentId)).toEqual([
      "issue:acme/app#11",
      "pr:acme/app#21",
      `file:acme/app@${COMMIT_SHA}:src/auth/login.ts`,
      "issue:acme/app#12",
      "pr:acme/app#22",
      `file:acme/app@${COMMIT_SHA}:docs/設計 メモ.md`,
    ]);
  });

  it("hit の形: issue / PR は本文先頭の snippet と meta、code は section anchor と text_matches の snippet", async () => {
    const { github, connector } = setup();
    routeSearch(github);
    const [issue, pr, code] = (await connector.search(ALICE, "login")).hits;

    expect(issue).toEqual({
      documentId: "issue:acme/app#11",
      title: "Issue one",
      snippet: "Body of 11",
      url: "https://github.com/acme/app/issues/11",
      updatedAt: "2026-09-20T00:00:00Z",
      meta: {
        type: "issue",
        repository: "acme/app",
        number: "11",
        state: "open",
        author: "octo-dev",
      },
      scope: "shared",
    });
    expect(pr?.meta?.type).toBe("pull_request");
    expect(pr?.url).toBe("https://github.com/acme/app/pull/21");
    expect(code).toEqual({
      documentId: `file:acme/app@${COMMIT_SHA}:src/auth/login.ts`,
      title: "src/auth/login.ts",
      snippet: "export function login()",
      url: `https://github.com/acme/app/blob/${COMMIT_SHA}/src/auth/login.ts`,
      anchor: { kind: "section", value: "src/auth/login.ts", label: "src/auth/login.ts" },
      meta: {
        type: "code",
        repository: "acme/app",
        path: "src/auth/login.ts",
        ref: COMMIT_SHA,
      },
      scope: "shared",
    });
  });

  it("SearchResult に総件数を載せない(total_count は読み捨てる、ADR-012)", async () => {
    const { github, connector } = setup();
    routeSearch(github);
    const result = await connector.search(ALICE, "login");
    expect(Object.keys(result).sort()).toEqual(["hits"]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(String(TOTAL_COUNT_CANARY));
    expect(serialized).not.toMatch(/total_?count/i);
  });

  it("0件でも成功と同じ形を返す(特別扱いの経路を作らない、TM-B5)", async () => {
    const { github, connector } = setup();
    github.on(/^\/search\/(issues|code)$/, () => searchResponse([]));
    await expect(connector.search(ALICE, "nothing-matches")).resolves.toEqual({ hits: [] });
  });
});

describe("snippet", () => {
  it("長い issue 本文は MAX_SNIPPET_CHARS 以内に切り詰め、本文全体を入れない", async () => {
    const { github, connector } = setup({ searchCode: false });
    const longBody = `${"段落".repeat(400)}\n\n<!-- template comment -->\n${"x".repeat(3000)}`;
    github.on(/^\/search\/issues$/, (req) =>
      isPrQuery(req) ? searchResponse([]) : searchResponse([issueItem({ number: 1, body: longBody })]),
    );
    const [hit] = (await connector.search(ALICE, "段落")).hits;
    expect(hit!.snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS);
    expect(hit!.snippet.endsWith("…")).toBe(true);
    expect(hit!.snippet).not.toBe(longBody);
  });

  it("空白の正規化と HTML コメントの除去、サロゲートペアを分断しない", async () => {
    const { github, connector } = setup({ searchCode: false, snippetChars: 6 });
    github.on(/^\/search\/issues$/, (req) =>
      isPrQuery(req) ? searchResponse([]) : searchResponse([
        issueItem({ number: 1, body: "<!-- tmpl -->\n\n  a  b\n" }),
        issueItem({ number: 2, body: "abcd😀efgh" }),
        issueItem({ number: 3, body: null }),
      ]),
    );
    const hits = (await connector.search(ALICE, "a")).hits;
    expect(hits.map((hit) => hit.snippet)).toEqual(["a b", "abcd…", ""]);
  });

  it("code hit は text_matches の断片、なければ空文字(degraded)", async () => {
    const { github, connector } = setup();
    github
      .on(/^\/search\/issues$/, () => searchResponse([]))
      .on(/^\/search\/code$/, () =>
        searchResponse([
          codeItem({ path: "a.ts", fragments: ["first match", "second\r\nmatch"] }),
          codeItem({ path: "b.ts" }),
          codeItem({ path: "c.ts", fragments: ["y".repeat(2000)] }),
        ]),
      );
    const hits = (await connector.search(ALICE, "match")).hits;
    expect(hits.map((hit) => hit.snippet.slice(0, 40))).toEqual([
      "first match\n…\nsecond\nmatch",
      "",
      "y".repeat(40),
    ]);
    for (const hit of hits) {
      expect(hit.snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS);
    }
  });
});

describe("filters → 検索修飾子", () => {
  it("container(owner/repo)→ repo:、author → author:、updatedAfter/Before → updated:>= / <=", async () => {
    const { github, connector } = setup();
    routeSearch(github);
    await connector.search(ALICE, "outage report", {
      container: "acme/app",
      author: "octo-dev",
      updatedAfter: "2026-01-01",
      updatedBefore: "2026-06-30T12:34:56+09:00",
    });
    const queries = github.requestsTo(/^\/search\/issues$/).map(qOf).sort();
    expect(queries).toEqual([
      "outage report repo:acme/app author:octo-dev updated:>=2026-01-01T00:00:00Z updated:<=2026-06-30T03:34:56Z is:issue",
      "outage report repo:acme/app author:octo-dev updated:>=2026-01-01T00:00:00Z updated:<=2026-06-30T03:34:56Z is:pull-request",
    ]);
    // コード検索は author / updated に対応しないため行わない(フィルタ外の結果を混ぜない)
    expect(github.requestsTo(/^\/search\/code$/)).toHaveLength(0);
  });

  it("container(org 名)→ org:。コード検索にも同じ範囲を適用する", async () => {
    const { github, connector } = setup();
    routeSearch(github);
    await connector.search(ALICE, "runbook", { container: "acme" });
    const all = github.requests.map(qOf).sort();
    expect(all).toEqual([
      "runbook org:acme",
      "runbook org:acme is:issue",
      "runbook org:acme is:pull-request",
    ]);
  });

  it("検索語が空でもフィルタがあれば issue / PR を検索する(コード検索は検索語が必須のため行わない)", async () => {
    const { github, connector } = setup();
    routeSearch(github);
    await connector.search(ALICE, "  ", { container: "acme/app" });
    expect(github.requests.map(qOf).sort()).toEqual([
      "repo:acme/app is:issue",
      "repo:acme/app is:pull-request",
    ]);
  });

  it.each([
    ["空の検索語でフィルタもない", "   ", {}],
    ["container に修飾子の混入", "q", { container: "acme/app is:private" }],
    ["container のドットセグメント", "q", { container: "../secret" }],
    ["container の空白", "q", { container: "acme corp" }],
    ["author の不正な文字", "q", { author: "octo dev" }],
    ["author に修飾子の混入", "q", { author: "x repo:other/secret" }],
    ["updatedAfter が日時でない", "q", { updatedAfter: "yesterday" }],
    ["updatedBefore が日時でない", "q", { updatedBefore: "2026-13-45" }],
  ] as const)("%s → invalid_request、API は呼ばない", async (_label, query, filters) => {
    const { github, connector } = setup();
    routeSearch(github);
    const error = await captureError(connector.search(ALICE, query, filters));
    expect(error.errorClass).toBe("invalid_request");
    expect(github.requests).toHaveLength(0);
  });

  it("author の @ 前置きと GitHub App の bot 名を受け付ける", async () => {
    const { github, connector } = setup({ searchCode: false });
    routeSearch(github);
    await connector.search(ALICE, "bump", { author: "@octo-dev" });
    await connector.search(ALICE, "bump", { author: "dependabot[bot]" });
    const queries = github.requests.map(qOf).filter((q) => q.includes("is:issue"));
    expect(queries).toEqual([
      "bump author:octo-dev is:issue",
      "bump author:dependabot[bot] is:issue",
    ]);
  });
});

describe("limit・カーソル・searchCode 設定", () => {
  it("limit 既定 20 を issue 7 / PR 7 / code 6 に配分する", async () => {
    const { github, connector } = setup();
    routeSearch(github);
    await connector.search(ALICE, "login");
    const perPage = github.requests.map((req) => [
      req.url.pathname === "/search/code" ? "code" : isPrQuery(req) ? "pr" : "issue",
      perPageOf(req),
      pageOf(req),
    ]);
    expect(perPage.sort()).toEqual([
      ["code", 6, 1],
      ["issue", 7, 1],
      ["pr", 7, 1],
    ]);
  });

  it("limit は 1〜100 に丸め、返却件数は limit を超えない", async () => {
    const { github, connector } = setup();
    github
      .on(/^\/search\/issues$/, (req) =>
        searchResponse(
          Array.from({ length: perPageOf(req) + 5 }, (_, i) =>
            issueItem({ number: i + 1, pullRequest: isPrQuery(req) }),
          ),
        ),
      )
      .on(/^\/search\/code$/, (req) =>
        searchResponse(
          Array.from({ length: perPageOf(req) + 5 }, (_, i) => codeItem({ path: `f${i}.ts` })),
        ),
      );

    const big = await connector.search(ALICE, "x", {}, { limit: 500 });
    expect(big.hits).toHaveLength(100);
    expect(github.requests.map(perPageOf).sort()).toEqual([33, 33, 34]);

    const one = await connector.search(ALICE, "x", {}, { limit: 1 });
    expect(one.hits).toHaveLength(1);
    expect(one.hits[0]!.meta?.type).toBe("issue");
  });

  it("searchCode: false ならコード検索を呼ばず、limit を issue / PR に配分する", async () => {
    const { github, connector } = setup({ searchCode: false });
    routeSearch(github);
    const result = await connector.search(ALICE, "login");
    expect(github.requestsTo(/^\/search\/code$/)).toHaveLength(0);
    expect(github.requests.map(perPageOf)).toEqual([10, 10]);
    expect(result.hits.every((hit) => hit.meta?.type !== "code")).toBe(true);
  });

  it("続きがあれば nextCursor を返し、カーソルで次ページ(初回の配分を維持)を取得する", async () => {
    const { github, connector } = setup();
    routeSearch(github, { next: true });
    const first = await connector.search(ALICE, "login", {}, { limit: 9 });
    expect(first.nextCursor).toBeDefined();
    // カーソルは不透明文字列(検索語を平文で含まない)
    expect(first.nextCursor).not.toContain("login");

    github.requests.length = 0;
    routeSearch(github); // 2ページ目で終わり
    // limit を変えても、カーソル継続中は初回の per_page を維持する
    const second = await connector.search(ALICE, "login", {}, { cursor: first.nextCursor!, limit: 50 });
    expect(github.requests.map((req) => [perPageOf(req), pageOf(req)])).toEqual([
      [3, 2],
      [3, 2],
      [3, 2],
    ]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("続きのないストリームはカーソルから外れ、以降は呼ばない", async () => {
    const { github, connector } = setup();
    github
      .on(/^\/search\/issues$/, (req) =>
        searchResponse([issueItem({ number: 1, pullRequest: isPrQuery(req) })], {
          next: !isPrQuery(req),
        }),
      )
      .on(/^\/search\/code$/, () => searchResponse([codeItem({ path: "a.ts" })]));
    const first = await connector.search(ALICE, "login");
    expect(decodeSearchCursor(first.nextCursor!)).toEqual([{ kind: "issue", page: 2, perPage: 7 }]);

    github.requests.length = 0;
    await connector.search(ALICE, "login", {}, { cursor: first.nextCursor! });
    expect(github.requests).toHaveLength(1);
    expect(qOf(github.requests[0]!)).toBe("login is:issue");
  });

  it("GitHub 検索の上限(1000件)より先のページは要求しない", async () => {
    const { github, connector } = setup({ searchCode: false });
    github.on(/^\/search\/issues$/, (req) =>
      searchResponse([issueItem({ number: 1, pullRequest: isPrQuery(req) })], { next: true }),
    );
    // limit 100 を issue 50 / PR 50 に配分した場合の最終ページ(50 × 20 = 1000)
    const cursor = encodeSearchCursor([
      { kind: "issue", page: 20, perPage: 50 },
      { kind: "pr", page: 20, perPage: 50 },
    ]);
    const result = await connector.search(ALICE, "x", {}, { cursor });
    expect(github.requests.map(pageOf)).toEqual([20, 20]);
    expect(result.nextCursor).toBeUndefined();
  });

  it("per_page 合計が上限(100)ちょうどのカーソルは受け付ける", async () => {
    const { github, connector } = setup();
    routeSearch(github);
    const cursor = encodeSearchCursor([
      { kind: "issue", page: 2, perPage: 34 },
      { kind: "pr", page: 2, perPage: 33 },
      { kind: "code", page: 2, perPage: 33 },
    ]);
    await connector.search(ALICE, "login", {}, { cursor });
    expect(github.requests.map(perPageOf).sort()).toEqual([33, 33, 34]);
  });

  it.each([
    ["base64url でない", "not a cursor!"],
    ["JSON でない", Buffer.from("garbage").toString("base64url")],
    ["種別が違う", Buffer.from(JSON.stringify({ k: "list", v: 1, ph: "orgs", p: 2 })).toString("base64url")],
    ["page が範囲外", Buffer.from(JSON.stringify({ k: "search", v: 1, s: [["issue", 11, 100]] })).toString("base64url")],
    ["per_page が範囲外", Buffer.from(JSON.stringify({ k: "search", v: 1, s: [["issue", 1, 1000]] })).toString("base64url")],
    ["ストリームの重複", Buffer.from(JSON.stringify({ k: "search", v: 1, s: [["issue", 1, 5], ["issue", 2, 5]] })).toString("base64url")],
    // 各ストリームは値域内でも、合計が search の limit 上限(100)を超える偽造(m1)
    [
      "per_page 合計 300(各 100)",
      Buffer.from(JSON.stringify({ k: "search", v: 1, s: [["issue", 1, 100], ["pr", 1, 100], ["code", 1, 100]] })).toString("base64url"),
    ],
    [
      "per_page 合計 101",
      Buffer.from(JSON.stringify({ k: "search", v: 1, s: [["issue", 1, 51], ["pr", 1, 50]] })).toString("base64url"),
    ],
  ])("不正なカーソル(%s)→ invalid_request、API は呼ばない", async (_label, cursor) => {
    const { github, connector } = setup();
    routeSearch(github);
    const error = await captureError(connector.search(ALICE, "login", {}, { cursor }));
    expect(error.errorClass).toBe("invalid_request");
    expect(github.requests).toHaveLength(0);
  });
});

describe("一部ストリームの失敗(degraded)", () => {
  it("コード検索だけが 5xx → issue / PR の結果を返し、コード検索の再試行位置を nextCursor に残す", async () => {
    const { github, connector } = setup();
    routeSearch(github);
    github.onJson(/^\/search\/code$/, { message: "oops" }, { status: 502 });
    const result = await connector.search(ALICE, "login");
    expect(result.hits.map((hit) => hit.meta?.type)).toEqual([
      "issue",
      "pull_request",
      "issue",
      "pull_request",
    ]);
    expect(decodeSearchCursor(result.nextCursor!)).toEqual([{ kind: "code", page: 1, perPage: 6 }]);
  });

  it("コード検索だけが 422(検索構文非対応など)→ 残りを返し、コード検索は再試行しない", async () => {
    const { github, connector } = setup();
    routeSearch(github);
    github.onJson(/^\/search\/code$/, { message: "Validation Failed" }, { status: 422 });
    const result = await connector.search(ALICE, "login");
    expect(result.hits).toHaveLength(4);
    expect(result.nextCursor).toBeUndefined();
  });

  it("全ストリームが失敗 → 最初のストリームのエラーを返す", async () => {
    const { github, connector } = setup();
    github.onJson(/^\/search\/(issues|code)$/, { message: "down" }, { status: 503 });
    const error = await captureError(connector.search(ALICE, "login"));
    expect(error.errorClass).toBe("source_unavailable");
  });

  it("いずれかのストリームが auth_expired → 他が成功しても auth_expired を返す(失効を隠さない)", async () => {
    const { github, connector } = setup();
    routeSearch(github);
    github.onJson(/^\/search\/code$/, { message: "Bad credentials" }, { status: 401 });
    const error = await captureError(connector.search(ALICE, "login"));
    expect(error.errorClass).toBe("auth_expired");
  });

  it("応答の items が配列でない → source_unavailable(そのストリームのみ失敗)", async () => {
    const { github, connector } = setup({ searchCode: false });
    github.on(/^\/search\/issues$/, (req) =>
      isPrQuery(req)
        ? jsonResponse({ total_count: 1, items: "broken" })
        : searchResponse([issueItem({ number: 1 })]),
    );
    const result = await connector.search(ALICE, "x");
    expect(result.hits.map((hit) => hit.documentId)).toEqual(["issue:acme/app#1"]);
  });

  it("形の不正な item は結果から除く(documentId を捏造しない)", async () => {
    const { github, connector } = setup({ searchCode: false });
    github.on(/^\/search\/issues$/, (req) =>
      isPrQuery(req)
        ? searchResponse([])
        : searchResponse([
            { ...issueItem({ number: 1 }), repository_url: "https://api.github.com/repos/acme/.." },
            { ...issueItem({ number: 2 }), number: "2" },
            issueItem({ number: 3 }),
          ]),
    );
    const result = await connector.search(ALICE, "x");
    expect(result.hits.map((hit) => hit.documentId)).toEqual(["issue:acme/app#3"]);
  });
});
