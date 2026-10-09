/**
 * list / describe と構築時設定のテスト(T-019)。
 * - list: 本人の所属 org → 本人がアクセスできる repo、org 指定時はその org の repo。ページング
 * - describe: 表示名・要約(degraded の開示)・本人の org 一覧・対応フィルタ
 * - capabilities: nativeSearch "degraded"、ingest false、privateScopeHandling "classified"
 */
import { describe, expect, it } from "vitest";
import { ConnectorError, type Connector } from "@kp/connector-sdk";
import { DEFAULT_GITHUB_SOURCE_ID, GitHubConnector } from "../src/connector.js";
import * as publicApi from "../src/index.js";
import { createGitHubConnector } from "../src/index.js";
import {
  ALICE,
  jsonResponse,
  linkNext,
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

describe("list", () => {
  it("containerId 未指定: 所属 org(kind other)と本人の repo(kind repository)を列挙し、repo の続きはカーソルで取得する", async () => {
    const { github, connector } = setup();
    github
      .onJson(/^\/user\/orgs$/, [{ login: "acme" }, { login: "acme-labs" }])
      .on(/^\/user\/repos$/, (req) =>
        req.url.searchParams.get("page") === "1"
          ? jsonResponse([{ full_name: "acme/app" }, { full_name: "alice/dotfiles" }], {
              headers: linkNext(),
            })
          : jsonResponse([{ full_name: "acme-labs/prototype" }]),
      );

    const first = await connector.list(ALICE);
    expect(first.entries).toEqual([
      { id: "acme", name: "acme", kind: "other", scope: "shared" },
      { id: "acme-labs", name: "acme-labs", kind: "other", scope: "shared" },
      { id: "acme/app", name: "acme/app", kind: "repository", scope: "shared" },
      { id: "alice/dotfiles", name: "alice/dotfiles", kind: "repository", scope: "shared" },
    ]);
    expect(first.nextCursor).toBeDefined();
    const repoRequest = github.requestsTo(/^\/user\/repos$/)[0]!;
    expect(repoRequest.url.searchParams.get("per_page")).toBe("100");
    expect(repoRequest.url.searchParams.get("sort")).toBe("full_name");

    const second = await connector.list(ALICE, undefined, first.nextCursor);
    expect(second.entries).toEqual([
      { id: "acme-labs/prototype", name: "acme-labs/prototype", kind: "repository", scope: "shared" },
    ]);
    expect(second.nextCursor).toBeUndefined();
    expect(github.requestsTo(/^\/user\/orgs$/)).toHaveLength(1);
  });

  it("org が複数ページある場合は org を先に最後まで列挙する", async () => {
    const { github, connector } = setup({ listPageSize: 2 });
    github
      .on(/^\/user\/orgs$/, (req) =>
        req.url.searchParams.get("page") === "1"
          ? jsonResponse([{ login: "o1" }, { login: "o2" }], { headers: linkNext() })
          : jsonResponse([{ login: "o3" }]),
      )
      .onJson(/^\/user\/repos$/, [{ full_name: "o1/r1" }]);

    const first = await connector.list(ALICE);
    expect(first.entries.map((entry) => entry.id)).toEqual(["o1", "o2"]);
    expect(github.requestsTo(/^\/user\/repos$/)).toHaveLength(0);

    const second = await connector.list(ALICE, undefined, first.nextCursor);
    expect(second.entries.map((entry) => entry.id)).toEqual(["o3", "o1/r1"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("containerId が org 名: その org の repo(本人に見えるもの)を列挙する", async () => {
    const { github, connector } = setup();
    github.on(/^\/orgs\/acme\/repos$/, (req) =>
      req.url.searchParams.get("page") === "1"
        ? jsonResponse([{ full_name: "acme/app" }], { headers: linkNext() })
        : jsonResponse([{ full_name: "acme/infra" }]),
    );
    const first = await connector.list(ALICE, "acme");
    expect(first.entries).toEqual([
      { id: "acme/app", name: "acme/app", kind: "repository", scope: "shared" },
    ]);
    const second = await connector.list(ALICE, "acme", first.nextCursor);
    expect(second.entries).toEqual([
      { id: "acme/infra", name: "acme/infra", kind: "repository", scope: "shared" },
    ]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("org のカーソルを別の containerId で使う → invalid_request、API は呼ばない", async () => {
    const { github, connector } = setup();
    github.onJson(/^\/orgs\/acme\/repos$/, [{ full_name: "acme/app" }], { headers: linkNext() });
    const first = await connector.list(ALICE, "acme");
    github.requests.length = 0;
    const otherOrg = await captureError(connector.list(ALICE, "other-org", first.nextCursor));
    expect(otherOrg.errorClass).toBe("invalid_request");
    const root = await captureError(connector.list(ALICE, undefined, first.nextCursor));
    expect(root.errorClass).toBe("invalid_request");
    expect(github.requests).toHaveLength(0);
  });

  it.each([
    ["repo(子の区画なし)", "acme/app"],
    ["修飾子・空白の混入", "acme org:other"],
    ["ドットセグメント", "../user"],
  ])("containerId が %s → invalid_request、API は呼ばない", async (_label, containerId) => {
    const { github, connector } = setup();
    const error = await captureError(connector.list(ALICE, containerId));
    expect(error.errorClass).toBe("invalid_request");
    expect(github.requests).toHaveLength(0);
  });

  it("存在しない(または見えない)org → not_found", async () => {
    const { connector } = setup();
    const error = await captureError(connector.list(ALICE, "hidden-org"));
    expect(error.errorClass).toBe("not_found");
  });
});

describe("describe", () => {
  it("表示名・要約・本人の org 一覧(上限数)・対応フィルタを返す", async () => {
    const { github, connector } = setup({ maxTopContainers: 2 });
    github.onJson(/^\/user\/orgs$/, [{ login: "acme" }, { login: "acme-labs" }, { login: "extra" }]);

    const description = await connector.describe(ALICE);

    expect(github.requests).toHaveLength(1);
    expect(github.requests[0]!.url.searchParams.get("per_page")).toBe("2");
    expect(description.sourceId).toBe("github");
    expect(description.displayName).toBe("GitHub");
    expect(description.topContainers).toEqual([
      { id: "acme", name: "acme", kind: "other", scope: "shared" },
      { id: "acme-labs", name: "acme-labs", kind: "other", scope: "shared" },
    ]);
    expect(description.supportedFilters).toEqual([
      "updatedAfter",
      "updatedBefore",
      "container",
      "author",
    ]);
    expect(description.summary).toContain("degraded");
    expect(description.summary).toContain("本人");
    expect(description.summary).toContain("毎分約10回");
    // filters.container は範囲のヒントであり安全境界ではないことを開示する(m9)
    expect(description.summary).toContain("安全境界ではない");
  });

  it("searchCode: false の導入ではコード検索が無効であることを要約で開示する", async () => {
    const { github, connector } = setup({ searchCode: false, sourceId: "github-ghes", displayName: "GitHub Enterprise" });
    github.onJson(/^\/user\/orgs$/, []);
    const description = await connector.describe(ALICE);
    expect(description.sourceId).toBe("github-ghes");
    expect(description.displayName).toBe("GitHub Enterprise");
    expect(description.summary).toContain("コード検索はこの導入では無効");
    expect(description.topContainers).toEqual([]);
  });
});

describe("構築と能力", () => {
  it("公開 API は factory のみ(API クライアント・QuotaTracker・documentId の符号化を公開しない)", () => {
    // 型のみの export(GitHubConnector / GitHubConnectorOptions / GitHubConnectorFactoryInit /
    // FetchLike / RateLimitOptions)は実行時の値を持たない。createConnector は Gateway の
    // プラグイン契約の factory(test/plugin.test.ts)
    expect(Object.keys(publicApi).sort()).toEqual(["createConnector", "createGitHubConnector"]);
  });

  it("Connector 契約を満たし、capabilities は degraded / ingest なし / プライベート領域は classified", () => {
    const connector: Connector = createGitHubConnector();
    expect(connector).toBeInstanceOf(GitHubConnector);
    expect(connector.sourceId).toBe(DEFAULT_GITHUB_SOURCE_ID);
    expect(connector.capabilities).toEqual({
      nativeSearch: "degraded",
      ingest: false,
      privateScopeHandling: "classified",
    });
  });

  it("baseUrl を差し替えられる(GitHub Enterprise Server の /api/v3)", async () => {
    const { github, connector } = setup({ baseUrl: "https://ghe.corp.example/api/v3/" });
    github.on(/^\/api\/v3\/search\/issues$/, () => searchResponse([]));
    github.onJson(/^\/api\/v3\/user\/orgs$/, [{ login: "acme" }]);
    await connector.describe(ALICE);
    await connector.search(ALICE, "x", { container: "acme" });
    const origins = new Set(github.requests.map((req) => req.url.origin));
    expect(origins).toEqual(new Set(["https://ghe.corp.example"]));
    expect(github.requests.every((req) => req.url.pathname.startsWith("/api/v3/"))).toBe(true);
  });

  it.each([
    ["平文 http(loopback 以外)", { baseUrl: "http://api.github.example" }],
    ["資格情報入りの baseUrl", { baseUrl: "https://user:pass@ghe.corp.example/api/v3" }],
    ["クエリ付きの baseUrl", { baseUrl: "https://ghe.corp.example/api/v3?x=1" }],
    ["timeoutMs が 0", { timeoutMs: 0 }],
    ["defaultSearchLimit が上限超過", { defaultSearchLimit: 101 }],
    ["snippetChars が MAX_SNIPPET_CHARS 超過", { snippetChars: 501 }],
    ["pageChars が小さすぎる", { pageChars: 1 }],
    ["maxComments が上限超過", { maxComments: 101 }],
    ["userAgent に改行", { userAgent: "agent\r\nx: y" }],
    ["sourceId が空", { sourceId: " " }],
  ])("不正な設定(%s)は構築時に拒否する", (_label, options) => {
    expect(() => createGitHubConnector(options)).toThrow(RangeError);
  });

  it("baseUrl の誤設定メッセージに受領値をエコーしない", () => {
    expect(() =>
      createGitHubConnector({ baseUrl: "https://user:SECRET-MARKER@ghe.corp.example" }),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining("SECRET-MARKER") }));
  });

  it("http は loopback のみ許可する(ローカルのモックサーバー用)", () => {
    expect(() => createGitHubConnector({ baseUrl: "http://localhost:8080/api/v3" })).not.toThrow();
    expect(() => createGitHubConnector({ baseUrl: "http://127.0.0.1:3000" })).not.toThrow();
  });
});
