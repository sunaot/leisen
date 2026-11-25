/**
 * 検索語の正規化・issue / PR の一致箇所のスニペット・summary の検索の仕様(2026-11-25)。
 * GitHub API はフェイク(FakeGitHub)。トークンはダミーの値だけを使う。
 */
import { describe, expect, it } from "vitest";
import { MAX_SNIPPET_CHARS } from "@leisen/connector-sdk";
import { normalizeQuery, snippetTerms } from "../src/query.js";
import { ALICE, issueItem, qOf, searchResponse, setup } from "./helpers/fake-github.js";

const FILLER = "Background paragraph without the keyword. ".repeat(30);

describe("検索語の正規化", () => {
  it("引用符の外の全角空白・連続する空白・改行を半角空白 1 つにする(引用符の中・演算子・修飾子は変えない)", () => {
    expect(normalizeQuery("　認可　方針\n  repo:acme/app ")).toBe("認可 方針 repo:acme/app");
    expect(normalizeQuery('"login　 flow"  OR  NOT  bug')).toBe('"login　 flow" OR NOT bug');
  });

  it("search は正規化した検索語に修飾子を付けて GitHub に送る", async () => {
    const { github, connector } = setup({ searchCode: false });
    github.on(/^\/search\/issues$/, () => searchResponse([]));
    await connector.search(ALICE, "認可　方針", { container: "acme/app" });
    const queries = github.requestsTo(/^\/search\/issues$/).map(qOf).sort();
    expect(queries).toEqual(["認可 方針 repo:acme/app is:issue", "認可 方針 repo:acme/app is:pull-request"]);
  });
});

describe("スニペットの語", () => {
  it("演算子・NOT の次の語・否定・引用符・修飾子を除く", () => {
    expect(snippetTerms('(login OR signin) NOT legacy -wip "session token" repo:acme/app label:bug is:open a 認')).toEqual([
      "login",
      "signin",
      "session token",
      "認",
    ]);
    expect(snippetTerms("Error:timeout")).toEqual(["Error:timeout"]);
  });
});

describe("issue / PR の一致箇所を含むスニペット", () => {
  it("本文の後ろにある一致箇所の周辺を切り出す(前後に省略記号、MAX_SNIPPET_CHARS 以内)", async () => {
    const { github, connector } = setup({ searchCode: false });
    const body = `${FILLER}The session token is rotated every hour. ${FILLER}`;
    github.on(/^\/search\/issues$/, (req) =>
      qOf(req).includes("is:pull-request") ? searchResponse([]) : searchResponse([issueItem({ number: 1, body })]),
    );
    const [hit] = (await connector.search(ALICE, '"session token" repo:acme/app')).hits;
    expect(hit!.snippet).toContain("The session token is rotated every hour.");
    expect(hit!.snippet.startsWith("…")).toBe(true);
    expect(hit!.snippet.endsWith("…")).toBe(true);
    expect(hit!.snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS);
    expect(hit!.snippet).not.toBe(body);
  });

  it("本文に語がないとき(タイトル・コメントだけの一致)は従来どおり本文の先頭", async () => {
    const { github, connector } = setup({ searchCode: false });
    github.on(/^\/search\/issues$/, (req) =>
      qOf(req).includes("is:pull-request") ? searchResponse([]) : searchResponse([issueItem({ number: 1, body: FILLER })]),
    );
    const [hit] = (await connector.search(ALICE, "rotation")).hits;
    expect(hit!.snippet.startsWith("Background paragraph")).toBe(true);
    expect(hit!.snippet.endsWith("…")).toBe(true);
  });

  it("snippetChars を小さくしても長さを守る", async () => {
    const { github, connector } = setup({ searchCode: false, snippetChars: 40 });
    const body = `${FILLER}needle here. ${FILLER}`;
    github.on(/^\/search\/issues$/, (req) =>
      qOf(req).includes("is:pull-request") ? searchResponse([]) : searchResponse([issueItem({ number: 1, body })]),
    );
    const [hit] = (await connector.search(ALICE, "needle")).hits;
    expect(hit!.snippet).toContain("needle");
    expect(hit!.snippet.length).toBeLessThanOrEqual(40);
  });
});

describe("describe の summary(検索の仕様)", () => {
  it("検索の仕様を書き、1,000 字に収まる(コード検索の有無の両方)", async () => {
    for (const searchCode of [true, false]) {
      const { github, connector } = setup({ searchCode });
      github.onJson(/^\/user\/orgs$/, []);
      const { summary } = await connector.describe(ALICE);
      expect(summary.length).toBeLessThanOrEqual(1_000);
      for (const fact of ["AND", "OR", "NOT", "256 文字", "best match", "スニペット", "不明", "filters.container", "is:issue"]) {
        expect(summary).toContain(fact);
      }
    }
  });
});
