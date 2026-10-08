/**
 * 認可分岐のテスト(最優先。CLAUDE.md 開発ルール / T-019 受け入れ条件「全呼び出しが本人トークン」)。
 *
 * (1) 資格情報の前提違反(kind 不一致・トークン欠落・失効)は API を呼ぶ前に拒否する
 * (2) ソースの認可応答(401 / 403 / 404 / 422 / 5xx / 通信失敗)を ConnectorErrorClass に写像する
 * (3) 全リクエストが呼び出しユーザー本人のトークンで送られ、ユーザー間で混ざらない。
 *     サービスアカウント等へのフォールバックがない(不変条件1)
 * (4) エラーメッセージにトークン・レスポンス本文・クエリを含めない(不変条件6、TM-A2)
 */
import { describe, expect, it } from "vitest";
import {
  ConnectorError,
  type AuthContext,
  type Connector,
} from "@kp/connector-sdk";
import {
  ALICE,
  BOB,
  DELEGATED,
  NOW,
  bearerAuth,
  bearerOf,
  codeItem,
  devToken,
  issueItem,
  jsonResponse,
  qOf,
  searchResponse,
  setup,
  type FakeGitHub,
} from "./helpers/fake-github.js";
import type { FetchLike } from "../src/index.js";

interface Operation {
  name: "search" | "fetch" | "list" | "describe";
  run: (connector: Connector, auth: AuthContext) => Promise<unknown>;
}

const OPERATIONS: Operation[] = [
  { name: "search", run: (c, a) => c.search(a, "login bug") },
  { name: "fetch", run: (c, a) => c.fetch(a, "issue:acme/app#12") },
  { name: "list", run: (c, a) => c.list(a) },
  { name: "describe", run: (c, a) => c.describe(a) },
];

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

/** 全エンドポイントに正常応答するルート一式。 */
function routeHappyPath(github: FakeGitHub): void {
  github
    .on(/^\/search\/issues$/, (req) =>
      searchResponse([
        issueItem({
          number: 12,
          pullRequest: qOf(req).includes("is:pull-request"),
        }),
      ]),
    )
    .on(/^\/search\/code$/, () =>
      searchResponse([codeItem({ path: "src/login.ts", fragments: ["login"] })]),
    )
    .onJson(/^\/repos\/[^/]+\/[^/]+\/issues\/\d+$/, issueItem({ number: 12, comments: 1 }))
    .onJson(/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/, [
      { user: { login: "reviewer" }, body: "LGTM", created_at: "2026-09-02T00:00:00Z" },
    ])
    .onJson(/^\/user\/orgs$/, [{ login: "acme" }])
    .onJson(/^\/user\/repos$/, [{ full_name: "acme/app" }]);
}

describe("(1) 資格情報の前提違反は API を呼ぶ前に拒否する", () => {
  it.each(OPERATIONS)(
    "$name: delegated_identity の資格情報 → invalid_request、fetch は呼ばれない",
    async (op) => {
      const { github, connector } = setup();
      routeHappyPath(github);
      const error = await captureError(op.run(connector, DELEGATED));
      expect(error.errorClass).toBe("invalid_request");
      expect(github.requests).toHaveLength(0);
    },
  );

  it.each(OPERATIONS)(
    "$name: accessToken が空 → auth_expired、fetch は呼ばれない",
    async (op) => {
      const { github, connector } = setup();
      routeHappyPath(github);
      const error = await captureError(
        op.run(connector, bearerAuth("alice", { accessToken: "" })),
      );
      expect(error.errorClass).toBe("auth_expired");
      expect(github.requests).toHaveLength(0);
    },
  );

  it.each(OPERATIONS)(
    "$name: 失効済み(expiresAt 経過)→ auth_expired、fetch は呼ばれない",
    async (op) => {
      const { github, connector } = setup();
      routeHappyPath(github);
      const error = await captureError(
        op.run(connector, bearerAuth("alice", { expiresAt: NOW - 1 })),
      );
      expect(error.errorClass).toBe("auth_expired");
      expect(github.requests).toHaveLength(0);
    },
  );

  it.each(OPERATIONS)(
    "$name: userId が空 → invalid_request(ユーザー間で状態を共有するキーを作らない)",
    async (op) => {
      const { github, connector } = setup();
      routeHappyPath(github);
      const error = await captureError(op.run(connector, bearerAuth("")));
      expect(error.errorClass).toBe("invalid_request");
      expect(github.requests).toHaveLength(0);
    },
  );

  it("制御文字・空白を含むトークン → auth_expired(ヘッダ注入を防ぐ)、メッセージにトークンを含めない", async () => {
    const { github, connector } = setup();
    routeHappyPath(github);
    const broken = "dev-only-token-alice\r\nx-injected: 1";
    const error = await captureError(
      connector.search(bearerAuth("alice", { accessToken: broken }), "login"),
    );
    expect(error.errorClass).toBe("auth_expired");
    expect(error.message).not.toContain("dev-only-token-alice");
    expect(github.requests).toHaveLength(0);
  });

  it("expiresAt が 0(失効時刻不明)の資格情報は失効扱いにしない", async () => {
    const { github, connector } = setup();
    routeHappyPath(github);
    await connector.describe(bearerAuth("alice", { expiresAt: 0 }));
    expect(github.requests).toHaveLength(1);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])(
    "expiresAt が有限数でない(%s)→ auth_expired、fetch は呼ばれない(無期限扱いにしない)",
    async (_label, expiresAt) => {
      const { github, connector } = setup();
      routeHappyPath(github);
      for (const op of OPERATIONS) {
        const error = await captureError(op.run(connector, bearerAuth("alice", { expiresAt })));
        expect(error.errorClass).toBe("auth_expired");
      }
      expect(github.requests).toHaveLength(0);
    },
  );

  // 多層防御: 本人の user token でないトークン種別(接頭辞で判別できるもの)を拒否する。
  // ダミー値は実トークン形式にしない(不変条件6)
  it.each([
    ["installation access token", "ghs_dev-only"],
    ["refresh token", "ghr_dev-only"],
  ])(
    "%s の接頭辞を持つトークン → invalid_request、fetch は呼ばれず、メッセージにトークンを含めない",
    async (_label, accessToken) => {
      const { github, connector } = setup();
      routeHappyPath(github);
      for (const op of OPERATIONS) {
        const error = await captureError(op.run(connector, bearerAuth("alice", { accessToken })));
        expect(error.errorClass).toBe("invalid_request");
        expect(error.message).not.toContain(accessToken);
        expect(error.message).not.toContain("dev-only");
      }
      expect(github.requests).toHaveLength(0);
    },
  );
});

describe("(2) ソースの認可応答を ConnectorErrorClass に写像する", () => {
  const cases: { status: number; expected: ConnectorError["errorClass"] }[] = [
    { status: 401, expected: "auth_expired" },
    { status: 403, expected: "permission_denied" },
    { status: 404, expected: "not_found" },
    { status: 422, expected: "invalid_request" },
    { status: 500, expected: "source_unavailable" },
    { status: 502, expected: "source_unavailable" },
    { status: 503, expected: "source_unavailable" },
  ];

  for (const { status, expected } of cases) {
    it.each(OPERATIONS)(`$name: HTTP ${status} → ${expected}`, async (op) => {
      const { github, connector } = setup();
      github.onJson(/.*/, { message: "error body" }, { status });
      const error = await captureError(op.run(connector, ALICE));
      expect(error.errorClass).toBe(expected);
      expect(github.requests.length).toBeGreaterThan(0);
    });
  }

  it("403 + X-GitHub-SSO(SAML SSO 未認可)→ permission_denied、SSO の案内を含む", async () => {
    const { github, connector } = setup();
    github.onJson(
      /.*/,
      { message: "Resource protected by organization SAML enforcement." },
      {
        status: 403,
        headers: { "x-github-sso": "required; url=https://github.com/orgs/acme/sso?authorization_request=opaque" },
      },
    );
    const error = await captureError(connector.fetch(ALICE, "issue:acme/app#12"));
    expect(error.errorClass).toBe("permission_denied");
    expect(error.message).toMatch(/SAML SSO/);
    // 認可URL(リクエスト固有値を含みうる)はメッセージに載せない
    expect(error.message).not.toContain("authorization_request");
  });

  it("401 の後に別の資格情報で再試行しない(フォールバックなし)", async () => {
    const { github, connector } = setup();
    github.onJson(/.*/, { message: "Bad credentials" }, { status: 401 });
    const error = await captureError(connector.fetch(ALICE, "issue:acme/app#12"));
    expect(error.errorClass).toBe("auth_expired");
    expect(github.requests).toHaveLength(1);
    expect(bearerOf(github.requests[0]!)).toBe(`Bearer ${devToken("alice")}`);
  });

  it("通信失敗(fetch の例外)→ source_unavailable、例外の詳細(URL・クエリ)を載せない", async () => {
    const failing: FetchLike = async () => {
      throw new TypeError(
        "fetch failed: connect ECONNREFUSED https://api.github.com/search/issues?q=QUERY-MARKER-91b2",
      );
    };
    const { connector } = setup({ fetchImpl: failing });
    const error = await captureError(connector.search(ALICE, "QUERY-MARKER-91b2"));
    expect(error.errorClass).toBe("source_unavailable");
    expect(error.message).not.toContain("QUERY-MARKER-91b2");
    expect(error.message).not.toContain("ECONNREFUSED");
  });

  it("タイムアウト(timeoutMs 注入)→ source_unavailable", async () => {
    let signals = 0;
    const hanging: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        if (!signal) {
          reject(new Error("request was sent without an AbortSignal"));
          return;
        }
        signals += 1;
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    const { connector } = setup({ fetchImpl: hanging, timeoutMs: 20 });
    const error = await captureError(connector.describe(ALICE));
    expect(error.errorClass).toBe("source_unavailable");
    expect(error.message).toMatch(/timed out after 20ms/);
    expect(signals).toBe(1);
  });

  it("2xx だが本文が JSON でない → source_unavailable", async () => {
    const { github, connector } = setup();
    github.on(/.*/, () => new Response("<html>maintenance</html>", { status: 200 }));
    const error = await captureError(connector.describe(ALICE));
    expect(error.errorClass).toBe("source_unavailable");
  });
});

describe("(3) 全リクエストが呼び出しユーザー本人のトークンで送られる", () => {
  it("search / fetch / list / describe の全リクエストに本人の Bearer と GitHub 標準ヘッダが付く", async () => {
    const { github, connector } = setup({ userAgent: "leisen-test-agent" });
    routeHappyPath(github);

    await connector.search(ALICE, "login bug");
    await connector.fetch(ALICE, "issue:acme/app#12");
    await connector.list(ALICE);
    await connector.describe(ALICE);

    // search: issue / PR / code の3本、fetch: issue + comments、list: orgs + repos、describe: orgs
    expect(github.requests).toHaveLength(8);
    for (const request of github.requests) {
      expect(bearerOf(request)).toBe(`Bearer ${devToken("alice")}`);
      expect(request.headers.get("x-github-api-version")).toBe("2022-11-28");
      expect(request.headers.get("user-agent")).toBe("leisen-test-agent");
      expect(request.headers.get("accept")).toMatch(
        /^application\/vnd\.github(\.text-match)?\+json$/,
      );
      expect(request.method).toBe("GET");
      // トークンを URL(クエリ)に載せない
      expect(request.url.href).not.toContain(devToken("alice"));
    }
  });

  it("2ユーザーの呼び出しを並行に行ってもトークンが混ざらない", async () => {
    const { github, connector } = setup();
    github
      .on(/^\/search\/(issues|code)$/, () => searchResponse([]))
      .on(/^\/repos\/([^/]+)\/app\/issues\/1$/, (req) =>
        jsonResponse(
          issueItem({ owner: req.url.pathname.split("/")[2]!, number: 1 }),
        ),
      )
      .on(/^\/orgs\/[^/]+\/repos$/, () => jsonResponse([]));

    await Promise.all([
      connector.search(ALICE, "roadmap", { container: "alice-org" }),
      connector.search(BOB, "roadmap", { container: "bob-org" }),
      connector.fetch(ALICE, "issue:alice-org/app#1"),
      connector.fetch(BOB, "issue:bob-org/app#1"),
      connector.list(ALICE, "alice-org"),
      connector.list(BOB, "bob-org"),
      connector.search(ALICE, "incident", { container: "alice-org/app" }),
      connector.fetch(BOB, "issue:bob-org/app#1"),
    ]);

    expect(github.requests.length).toBeGreaterThanOrEqual(12);
    for (const request of github.requests) {
      const target = `${request.url.pathname} ${qOf(request)}`;
      const owner = target.includes("alice-org")
        ? "alice"
        : target.includes("bob-org")
          ? "bob"
          : undefined;
      expect(owner).toBeDefined();
      expect(bearerOf(request)).toBe(`Bearer ${devToken(owner!)}`);
    }
  });
});

describe("(4) エラーメッセージに秘密情報・本文・クエリを含めない", () => {
  const statuses = [401, 403, 404, 422, 429, 500];

  it.each(statuses)("HTTP %i のエラーメッセージ", async (status) => {
    const { github, connector } = setup();
    github.onJson(
      /.*/,
      { message: "BODY-MARKER-7f3a", documentation_url: "https://docs.github.com/rest" },
      { status, headers: status === 429 ? { "retry-after": "5" } : {} },
    );
    const error = await captureError(
      connector.search(ALICE, "QUERY-MARKER-91b2", { container: "acme/app" }),
    );
    expect(error.message).not.toContain(devToken("alice"));
    expect(error.message).not.toContain("BODY-MARKER-7f3a");
    expect(error.message).not.toContain("QUERY-MARKER-91b2");
    expect(error.message).not.toContain("https://");
  });
});

describe("(5) リダイレクトで本人トークンを baseUrl の外へ送らない", () => {
  it("同一オリジンのリダイレクト(リネームされた repo 等)は本人トークンのまま追う。fetch 実装の自動追従には任せない", async () => {
    const { github, connector } = setup();
    github
      .on(/^\/repos\/acme\/old-name\/issues\/12$/, () =>
        new Response(null, {
          status: 301,
          headers: { location: "https://api.github.com/repositories/42/issues/12" },
        }),
      )
      .onJson(/^\/repositories\/42\/issues\/12$/, issueItem({ number: 12 }));

    const result = await connector.fetch(ALICE, "issue:acme/old-name#12");

    expect(result.title).toBe("Issue title 12");
    expect(github.requests.map((req) => req.url.pathname)).toEqual([
      "/repos/acme/old-name/issues/12",
      "/repositories/42/issues/12",
    ]);
    for (const request of github.requests) {
      expect(request.redirect).toBe("manual");
      expect(bearerOf(request)).toBe(`Bearer ${devToken("alice")}`);
    }
  });

  it("別オリジンへのリダイレクトは追わない → source_unavailable、転送先へは何も送らない", async () => {
    const { github, connector } = setup();
    github.on(/^\/repos\/acme\/app\/issues\/12$/, () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://collector.example/steal?from=github" },
      }),
    );
    const error = await captureError(connector.fetch(ALICE, "issue:acme/app#12"));
    expect(error.errorClass).toBe("source_unavailable");
    expect(error.message).not.toContain("collector.example");
    expect(github.requests).toHaveLength(1);
    expect(github.requests.every((req) => req.url.hostname === "api.github.com")).toBe(true);
  });

  it("GitHub Enterprise Server のベースパス(/api/v3)の外へのリダイレクトは追わない", async () => {
    const { github, connector } = setup({ baseUrl: "https://ghe.corp.example/api/v3" });
    github.on(/^\/api\/v3\/repos\/acme\/app\/issues\/12$/, () =>
      new Response(null, { status: 307, headers: { location: "/login?return_to=x" } }),
    );
    const error = await captureError(connector.fetch(ALICE, "issue:acme/app#12"));
    expect(error.errorClass).toBe("source_unavailable");
    expect(github.requests).toHaveLength(1);
  });

  it.each(["%2F", "%2f", "%5C", "%5c"])(
    "Location のパスにエンコードされた区切り文字(%s)を含むリダイレクトは同一オリジンでも追わない",
    async (separator) => {
      const { github, connector } = setup({ baseUrl: "https://ghe.corp.example/api/v3" });
      // 追従してしまった場合に応答するルート(後から登録したルートが優先)
      github
        .onJson(/.*/, issueItem({ number: 12 }))
        .on(/^\/api\/v3\/repos\/acme\/app\/issues\/12$/, () =>
          new Response(null, {
            status: 301,
            headers: {
              // URL としてはベースパス(/api/v3/)内だが、サーバー側の復号で外へ抜けうる
              location: `/api/v3/repos/acme/app/..${separator}..${separator}..${separator}..${separator}admin`,
            },
          }),
        );
      const error = await captureError(connector.fetch(ALICE, "issue:acme/app#12"));
      expect(error.errorClass).toBe("source_unavailable");
      expect(github.requests).toHaveLength(1);
    },
  );

  it("注入 fetch が redirect: \"manual\" を尊重せず追従した応答(response.redirected)は使わない → source_unavailable", async () => {
    const followed: FetchLike = async () => {
      const response = jsonResponse(issueItem({ number: 12, title: "served by the redirect target" }));
      // 追従後の応答を模す(Response.redirected は読み取り専用のため上書きする)
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    };
    const { connector } = setup({ fetchImpl: followed });
    const error = await captureError(connector.fetch(ALICE, "issue:acme/app#12"));
    expect(error.errorClass).toBe("source_unavailable");
    expect(error.message).toMatch(/redirect/);
    expect(error.message).not.toContain("served by the redirect target");
  });

  it("リダイレクトの連鎖は上限回数で打ち切る", async () => {
    const { github, connector } = setup();
    github.on(/^\/loop\/\d+$/, (req) =>
      new Response(null, {
        status: 301,
        headers: { location: `/loop/${Number(req.url.pathname.split("/")[2]) + 1}` },
      }),
    );
    github.on(/^\/repos\/acme\/app\/issues\/12$/, () =>
      new Response(null, { status: 301, headers: { location: "/loop/1" } }),
    );
    const error = await captureError(connector.fetch(ALICE, "issue:acme/app#12"));
    expect(error.errorClass).toBe("source_unavailable");
    // 初回 + 追従 3 回で打ち切り
    expect(github.requests).toHaveLength(4);
  });
});
