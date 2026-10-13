/**
 * fetch と documentId のテスト(T-019)。
 * - documentId の往復(符号化 → 復号)と、不正な documentId の拒否(API を呼ばない)
 * - issue / PR 本文+先頭コメント、file の base64 復号
 * - 本文のページング(pageChars、nextPageCursor)
 * - バイナリ・巨大ファイル・ディレクトリの拒否
 */
import { describe, expect, it } from "vitest";
import { ConnectorError } from "@leisen/connector-sdk";
import {
  decodeDocumentId,
  encodeDocumentId,
  type GitHubDocumentRef,
} from "../src/document-id.js";
import {
  ALICE,
  COMMIT_SHA,
  fileContentResponse,
  issueItem,
  jsonResponse,
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

describe("documentId", () => {
  const refs: GitHubDocumentRef[] = [
    { type: "issue", owner: "acme", repo: "app", number: 123 },
    { type: "pr", owner: "acme-inc", repo: "web.site", number: 45 },
    { type: "issue", owner: "octocat_acme", repo: ".github", number: 1 },
    { type: "file", owner: "acme", repo: "app", ref: COMMIT_SHA, path: "src/index.ts" },
    { type: "file", owner: "acme", repo: "app", ref: "feature/login", path: "docs/設計 メモ #1 v2:final@draft.md" },
    { type: "file", owner: "acme", repo: "app", ref: "", path: "README.md" },
  ];

  it.each(refs)("往復: %o", (ref) => {
    const id = encodeDocumentId(ref);
    expect(decodeDocumentId(id)).toEqual(ref);
  });

  it("形式: issue:owner/repo#N、pr:owner/repo#N、file:owner/repo@ref:path", () => {
    expect(encodeDocumentId({ type: "issue", owner: "acme", repo: "app", number: 123 })).toBe(
      "issue:acme/app#123",
    );
    expect(encodeDocumentId({ type: "pr", owner: "acme", repo: "app", number: 45 })).toBe(
      "pr:acme/app#45",
    );
    expect(
      encodeDocumentId({ type: "file", owner: "acme", repo: "app", ref: "main", path: "a/b.md" }),
    ).toBe("file:acme/app@main:a/b.md");
  });

  it.each([
    "",
    "issue:",
    "issue:acme#1",
    "issue:acme/app#0",
    "issue:acme/app#-1",
    "issue:acme/app#1a",
    "issue:acme/app/extra#1",
    "issue:ac me/app#1",
    "issue:acme/..#1",
    "discussion:acme/app#1",
    "file:acme/app:README.md",
    "file:acme/app@main:",
    "file:acme/app@main:../secret",
    "file:acme/app@main:docs/../../user",
    "file:acme/app@main:a//b",
    "file:acme/app@main:/abs",
    "file:acme/app@ma in:README.md",
    "file:acme/app@main..x:README.md",
    "file:acme/..@main:README.md",
    `file:acme/app@main:${"a".repeat(5000)}`,
    "file:acme/app@main:bad\u0000name",
  ])("不正な documentId %j → invalid_request", (id) => {
    expect(() => decodeDocumentId(id)).toThrow(ConnectorError);
    try {
      decodeDocumentId(id);
    } catch (error) {
      expect((error as ConnectorError).errorClass).toBe("invalid_request");
    }
  });

  it("不正な documentId の受領値をエラーメッセージにエコーしない", () => {
    try {
      decodeDocumentId("file:acme/app@main:../ECHO-MARKER-5c1d");
      expect.unreachable();
    } catch (error) {
      expect((error as ConnectorError).message).not.toContain("ECHO-MARKER-5c1d");
    }
  });

  it("fetch に不正な documentId → invalid_request、API は呼ばない", async () => {
    const { github, connector } = setup();
    const error = await captureError(connector.fetch(ALICE, "file:acme/app@main:../../../user"));
    expect(error.errorClass).toBe("invalid_request");
    expect(github.requests).toHaveLength(0);
  });
});

describe("fetch: issue / pull request", () => {
  it("本文と先頭コメントを返す。コメントは最初の1ページ・maxComments 件まで", async () => {
    const { github, connector } = setup({ maxComments: 2 });
    github
      .onJson(
        /^\/repos\/acme\/app\/issues\/7$/,
        issueItem({
          number: 7,
          title: "Login fails on Safari",
          body: "Steps to reproduce...",
          comments: 5,
          labels: ["bug", "p1"],
        }),
      )
      .onJson(/^\/repos\/acme\/app\/issues\/7\/comments$/, [
        { user: { login: "alice" }, body: "Reproduced.", created_at: "2026-09-02T00:00:00Z" },
        { user: { login: "bob" }, body: "Fix in #8.", created_at: "2026-09-03T00:00:00Z" },
        { user: { login: "extra" }, body: "should be cut", created_at: "2026-09-04T00:00:00Z" },
      ]);

    const result = await connector.fetch(ALICE, "issue:acme/app#7");

    const comments = github.requestsTo(/\/comments$/);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.url.searchParams.get("per_page")).toBe("2");
    expect(comments[0]!.url.searchParams.get("page")).toBe("1");

    expect(result.documentId).toBe("issue:acme/app#7");
    expect(result.title).toBe("Login fails on Safari");
    expect(result.url).toBe("https://github.com/acme/app/issues/7");
    expect(result.nextPageCursor).toBeUndefined();
    expect(result.content).toContain("# Login fails on Safari");
    expect(result.content).toContain("Issue acme/app#7 | state: open | author: @octo-dev");
    expect(result.content).toContain("labels: bug, p1");
    expect(result.content).toContain("Steps to reproduce...");
    expect(result.content).toContain("## Comments (first 2 of 5)");
    expect(result.content).toContain("### @alice (2026-09-02T00:00:00Z)\nReproduced.");
    expect(result.content).toContain("### @bob (2026-09-03T00:00:00Z)\nFix in #8.");
    expect(result.content).not.toContain("should be cut");
  });

  it("コメントが0件ならコメント取得の API を呼ばない", async () => {
    const { github, connector } = setup();
    github.onJson(/^\/repos\/acme\/app\/issues\/7$/, issueItem({ number: 7, comments: 0 }));
    const result = await connector.fetch(ALICE, "issue:acme/app#7");
    expect(github.requests).toHaveLength(1);
    expect(result.content).not.toContain("## Comments");
  });

  it("maxComments: 0 ならコメントを取得しない", async () => {
    const { github, connector } = setup({ maxComments: 0 });
    github.onJson(/^\/repos\/acme\/app\/issues\/7$/, issueItem({ number: 7, comments: 3 }));
    await connector.fetch(ALICE, "issue:acme/app#7");
    expect(github.requests).toHaveLength(1);
  });

  it("PR はマージ状態を示す", async () => {
    const { github, connector } = setup();
    github.onJson(
      /^\/repos\/acme\/app\/issues\/45$/,
      issueItem({ number: 45, pullRequest: true, mergedAt: "2026-09-10T00:00:00Z", state: "closed", body: null }),
    );
    const result = await connector.fetch(ALICE, "pr:acme/app#45");
    expect(result.url).toBe("https://github.com/acme/app/pull/45");
    expect(result.content).toContain("Pull request acme/app#45 | state: merged");
    expect(result.content).toContain("(no description)");
  });

  it("404 → not_found(権限外の repo も GitHub は 404 を返し存在を明かさない)", async () => {
    const { connector } = setup();
    const error = await captureError(connector.fetch(ALICE, "issue:acme/secret#1"));
    expect(error.errorClass).toBe("not_found");
  });
});

describe("fetch: ページング", () => {
  it("pageChars ごとに分割し nextPageCursor で続きを取得する。連結すると全文になる", async () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i} 行😀`).join("\n");
    const { github, connector } = setup({ pageChars: 50 });
    github.onJson(/^\/repos\/acme\/app\/issues\/9$/, issueItem({ number: 9, body }));

    const pages: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const page = await connector.fetch(ALICE, "issue:acme/app#9", cursor);
      expect(page.content.length).toBeLessThanOrEqual(50);
      // サロゲートペアを分断しない
      expect(page.content).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      pages.push(page.content);
      cursor = page.nextPageCursor;
      guard += 1;
    } while (cursor !== undefined && guard < 100);

    expect(pages.length).toBeGreaterThan(5);
    const full = pages.join("");
    expect(full).toContain(body);
    // 各ページの取得はソースから取り直す(本文をキャッシュしない)
    expect(github.requests).toHaveLength(pages.length);
  });

  it.each([
    ["不正な文字列", "%%%"],
    ["別種のカーソル", Buffer.from(JSON.stringify({ k: "search", v: 1, s: [["issue", 2, 5]] })).toString("base64url")],
    ["ページ番号 0", Buffer.from(JSON.stringify({ k: "page", v: 1, p: 0 })).toString("base64url")],
  ])("不正な pageCursor(%s)→ invalid_request、API は呼ばない", async (_label, cursor) => {
    const { github, connector } = setup();
    const error = await captureError(connector.fetch(ALICE, "issue:acme/app#9", cursor));
    expect(error.errorClass).toBe("invalid_request");
    expect(github.requests).toHaveLength(0);
  });

  it("範囲外のページ → invalid_request", async () => {
    const { github, connector } = setup();
    github.onJson(/^\/repos\/acme\/app\/issues\/9$/, issueItem({ number: 9, body: "short" }));
    const cursor = Buffer.from(JSON.stringify({ k: "page", v: 1, p: 5 })).toString("base64url");
    const error = await captureError(connector.fetch(ALICE, "issue:acme/app#9", cursor));
    expect(error.errorClass).toBe("invalid_request");
  });
});

describe("fetch: file", () => {
  it("contents API の base64 を復号し、ref とパスをエンコードして要求する", async () => {
    const text = "# 設計メモ\n\nログインの流れ: 1. 認可 2. トークン\n";
    const path = "docs/設計 メモ #1.md";
    const { github, connector } = setup();
    github.onJson(/^\/repos\/acme\/app\/contents\//, fileContentResponse(path, text));

    const documentId = `file:acme/app@${COMMIT_SHA}:${path}`;
    const result = await connector.fetch(ALICE, documentId);

    const [request] = github.requests;
    expect(request!.url.pathname).toBe(
      `/repos/acme/app/contents/docs/${encodeURIComponent("設計 メモ #1.md")}`,
    );
    expect(request!.url.searchParams.get("ref")).toBe(COMMIT_SHA);
    expect(result).toEqual({
      documentId,
      title: path,
      content: text,
      url: `https://github.com/acme/app/blob/${COMMIT_SHA}/docs/${encodeURIComponent("設計 メモ #1.md")}`,
      scope: "shared",
    });
  });

  it("ref が空ならデフォルトブランチ(ref パラメータなし)。BOM は除く", async () => {
    const { github, connector } = setup();
    github.onJson(/^\/repos\/acme\/app\/contents\/README\.md$/, fileContentResponse("README.md", "﻿hello"));
    const result = await connector.fetch(ALICE, "file:acme/app@:README.md");
    expect(github.requests[0]!.url.searchParams.has("ref")).toBe(false);
    expect(result.content).toBe("hello");
  });

  it("大きなファイルは pageChars ごとにページングする", async () => {
    const text = "x".repeat(45_000);
    const { github, connector } = setup();
    github.onJson(/^\/repos\/acme\/app\/contents\/big\.txt$/, fileContentResponse("big.txt", text));
    const first = await connector.fetch(ALICE, "file:acme/app@main:big.txt");
    expect(first.content).toHaveLength(20_000);
    const second = await connector.fetch(ALICE, "file:acme/app@main:big.txt", first.nextPageCursor);
    expect(second.content).toHaveLength(20_000);
    const third = await connector.fetch(ALICE, "file:acme/app@main:big.txt", second.nextPageCursor);
    expect(third.content).toHaveLength(5_000);
    expect(third.nextPageCursor).toBeUndefined();
  });

  it("バイナリ(NUL を含む)→ invalid_request", async () => {
    const { github, connector } = setup();
    github.onJson(
      /^\/repos\/acme\/app\/contents\/logo\.png$/,
      fileContentResponse("logo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a])),
    );
    const error = await captureError(connector.fetch(ALICE, "file:acme/app@main:logo.png"));
    expect(error.errorClass).toBe("invalid_request");
    expect(error.message).toMatch(/binary/);
  });

  it("不正な UTF-8 → invalid_request", async () => {
    const { github, connector } = setup();
    github.onJson(
      /^\/repos\/acme\/app\/contents\/latin1\.txt$/,
      fileContentResponse("latin1.txt", new Uint8Array([0x63, 0x61, 0x66, 0xe9])),
    );
    const error = await captureError(connector.fetch(ALICE, "file:acme/app@main:latin1.txt"));
    expect(error.errorClass).toBe("invalid_request");
  });

  it("encoding が base64 でない(1MB 超等)→ invalid_request", async () => {
    const { github, connector } = setup();
    github.onJson(
      /^\/repos\/acme\/app\/contents\/huge\.log$/,
      fileContentResponse("huge.log", "", { encoding: "none", content: "" }),
    );
    const error = await captureError(connector.fetch(ALICE, "file:acme/app@main:huge.log"));
    expect(error.errorClass).toBe("invalid_request");
  });

  it("contents API のサイズ上限超過(403 too_large)→ invalid_request(permission_denied にしない)", async () => {
    const { github, connector } = setup();
    github.onJson(
      /^\/repos\/acme\/app\/contents\/huge\.log$/,
      {
        message: "This API returns blobs up to 1 MB in size. The requested blob is too large to fetch via the API.",
        errors: [{ resource: "Blob", field: "data", code: "too_large" }],
      },
      { status: 403 },
    );
    const error = await captureError(connector.fetch(ALICE, "file:acme/app@main:huge.log"));
    expect(error.errorClass).toBe("invalid_request");
  });

  it("ディレクトリ・submodule → invalid_request", async () => {
    const { github, connector } = setup();
    github
      .onJson(/^\/repos\/acme\/app\/contents\/src$/, [{ type: "file", path: "src/a.ts" }])
      .onJson(/^\/repos\/acme\/app\/contents\/vendor\/lib$/, { type: "submodule", path: "vendor/lib" });
    const directory = await captureError(connector.fetch(ALICE, "file:acme/app@main:src"));
    expect(directory.errorClass).toBe("invalid_request");
    const submodule = await captureError(connector.fetch(ALICE, "file:acme/app@main:vendor/lib"));
    expect(submodule.errorClass).toBe("invalid_request");
  });

  it("形の不正な応答 → source_unavailable", async () => {
    const { github, connector } = setup();
    github.on(/^\/repos\/acme\/app\/issues\/1$/, () => jsonResponse("just a string"));
    const error = await captureError(connector.fetch(ALICE, "issue:acme/app#1"));
    expect(error.errorClass).toBe("source_unavailable");
  });
});
