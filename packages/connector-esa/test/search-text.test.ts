/**
 * 検索語の正規化・一致箇所のスニペット・filters と OR の括弧・summary の検索の仕様
 * (2026-11-25)。esa の MCP はモックする(fakeCaller)。トークンはダミーの値だけを使う。
 */
import { describe, expect, it } from "vitest";
import { ConnectorError, MAX_SNIPPET_CHARS, type AuthContext } from "@leisen/connector-sdk";
import { createEsaConnector, searchSpecOf } from "../src/connector.js";
import { createConnector } from "../src/index.js";
import type { EsaMcpCaller, EsaReadTool } from "../src/mcp.js";
import { normalizeQuery, shouldParenthesize, snippetTerms } from "../src/query.js";
import { toPlainSnippet } from "../src/parse.js";

const NOW = Date.UTC(2026, 10, 25, 0, 0, 0);
const AUTH: AuthContext = {
  userId: "alice",
  credential: { kind: "oauth_bearer", accessToken: "dummy-esa-token-for-tests", expiresAt: NOW + 3_600_000 },
};

function setup(posts: unknown[], options: { includeWip?: boolean; summary?: string } = {}) {
  const calls: { tool: EsaReadTool; args: Record<string, unknown> }[] = [];
  const caller: EsaMcpCaller = {
    async callTool(_token, tool, args) {
      calls.push({ tool, args });
      if (tool === "esa_search_posts") {
        return posts;
      }
      if (tool === "esa_get_top_categories") {
        return { categories: [] };
      }
      throw new ConnectorError("source_unavailable", "no fake response");
    },
  };
  const c = createEsaConnector({ sourceId: "esa", team: "example-team", caller, now: () => NOW, ...options });
  return { c, calls };
}

function post(number: number, body: string) {
  return {
    url: `https://example-team.esa.io/posts/${number}`,
    wip: "Shipped",
    category_and_title_and_tags: `設計/文書${number}`,
    body_md: body,
    updated_at: "2026-11-01T10:00:00+09:00",
  };
}

describe("検索語の正規化", () => {
  it("引用符の外の全角空白・連続する空白・改行を半角空白 1 つにし、前後を詰める", () => {
    expect(normalizeQuery("　認可　 方針\n\tGateway  ")).toBe("認可 方針 Gateway");
  });

  it("引用符の中・演算子・修飾子は変えない", () => {
    expect(normalizeQuery('"本人の　資格情報"  OR  title:認可 -下書き')).toBe('"本人の　資格情報" OR title:認可 -下書き');
    // 閉じていない引用符のあとは中とみなして変えない
    expect(normalizeQuery('a　"b　c')).toBe('a "b　c');
  });

  it("search は正規化した検索語を esa に渡す", async () => {
    const { c, calls } = setup([]);
    await c.search(AUTH, "認可　方針");
    expect(calls[0]?.args["query"]).toBe("認可 方針");
  });
});

describe("filters を付けるときの OR の括弧", () => {
  it("語と OR だけの検索語は () で包んでから修飾子を付ける", async () => {
    const { c, calls } = setup([]);
    await c.search(AUTH, "デプロイ OR deploy", { container: "設計" });
    expect(calls[0]?.args["query"]).toBe("(デプロイ OR deploy) in:設計");
    await c.search(AUTH, "えさ | 餌 日報", { author: "alice-dev" });
    expect(calls[1]?.args["query"]).toBe("(えさ | 餌 日報) user:alice-dev");
  });

  it("includeWip: false の wip:false でも包む", async () => {
    const { c, calls } = setup([], { includeWip: false });
    await c.search(AUTH, "a OR b");
    expect(calls[0]?.args["query"]).toBe("(a OR b) wip:false");
  });

  it("修飾子を付けないときは包まない", async () => {
    const { c, calls } = setup([]);
    await c.search(AUTH, "a OR b");
    expect(calls[0]?.args["query"]).toBe("a OR b");
  });

  it("引用符・括弧・否定・修飾子・タグを含む検索語や、OR の位置が不自然な検索語は包まない(括弧の中での扱いが未確認)", () => {
    expect(shouldParenthesize("a b")).toBe(false);
    expect(shouldParenthesize('"a b" OR c')).toBe(false);
    expect(shouldParenthesize("(a OR b) c")).toBe(false);
    expect(shouldParenthesize("a OR -b")).toBe(false);
    expect(shouldParenthesize("title:a OR b")).toBe(false);
    expect(shouldParenthesize("#tag OR b")).toBe(false);
    expect(shouldParenthesize("OR a")).toBe(false);
    expect(shouldParenthesize("a OR")).toBe(false);
    expect(shouldParenthesize("a OR OR b")).toBe(false);
    expect(shouldParenthesize("a|b OR c")).toBe(false);
    expect(shouldParenthesize("a OR b")).toBe(true);
  });

  it("包まない形の検索語はそのまま修飾子を付ける(従来どおり)", async () => {
    const { c, calls } = setup([]);
    await c.search(AUTH, "title:a OR b", { container: "設計" });
    expect(calls[0]?.args["query"]).toBe("title:a OR b in:設計");
  });
});

describe("一致箇所を含むスニペット", () => {
  const filler = "前置きの段落です。".repeat(60);

  it("スニペットの語から演算子・否定・引用符・カテゴリ等の修飾子を除き、title: / body: は値を使う", () => {
    expect(snippetTerms('(認可 OR authz) -下書き "本人の 資格情報" in:設計 #adr @alice user:bob updated:>2026-01-01 title:方針 body:Gateway a')).toEqual([
      "認可",
      "authz",
      "本人の 資格情報",
      "方針",
      "Gateway",
    ]);
    // 未知の key: は語のまま
    expect(snippetTerms("Error:timeout")).toEqual(["Error:timeout"]);
  });

  it("本文の後ろにある一致箇所の周辺を切り出し、前後に省略記号を付ける", async () => {
    const body = `${filler}\n\n## 方針\n\nトークンは本人の資格情報で取得する。${filler}`;
    const { c } = setup([post(1, body)]);
    const [hit] = (await c.search(AUTH, "資格情報")).hits;
    expect(hit?.snippet.startsWith("…")).toBe(true);
    expect(hit?.snippet.endsWith("…")).toBe(true);
    expect(hit?.snippet).toContain("本人の資格情報で取得する");
    expect(hit?.snippet.length).toBeLessThanOrEqual(300);
  });

  it("複数の語が近くに現れる箇所を優先する", () => {
    const body = `${filler}Gateway の話。${filler}Gateway は認可を本人の資格情報で委譲する。${filler}`;
    const snippet = toPlainSnippet(body, 200, ["Gateway", "認可"]);
    expect(snippet).toContain("Gateway は認可を");
  });

  it("大文字・小文字を区別しない", () => {
    const snippet = toPlainSnippet(`${filler}Token Vault の設定。${filler}`, 200, ["token vault"]);
    expect(snippet).toContain("Token Vault の設定");
  });

  it("語が先頭の範囲にある・本文にない・語がないときは従来どおり本文の先頭", () => {
    const body = `資格情報の扱い。${filler}`;
    expect(toPlainSnippet(body, 100, ["資格情報"])).toBe([...toPlainSnippet(body, 100)].join(""));
    expect(toPlainSnippet(body, 100, ["存在しない語"])).toBe(toPlainSnippet(body, 100));
    expect(toPlainSnippet(`${filler}末尾`, 100, [])).toBe(toPlainSnippet(`${filler}末尾`, 100));
    expect(toPlainSnippet(body, 100, ["存在しない語"]).startsWith("資格情報の扱い")).toBe(true);
  });

  it("長さの上限(snippetChars、MAX_SNIPPET_CHARS)を守り、本文全体を入れない", async () => {
    const long = `${"あ".repeat(5000)}一致${"い".repeat(5000)}`;
    const { c } = createWithChars(MAX_SNIPPET_CHARS, [post(1, long)]);
    const [hit] = (await c.search(AUTH, "一致")).hits;
    expect(hit?.snippet).toContain("一致");
    expect(hit?.snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS);
    expect(hit?.snippet).not.toBe(long);
  });

  it("サロゲートペアを分断しない", () => {
    const body = `${"😀".repeat(300)}一致${"😀".repeat(300)}`;
    const snippet = toPlainSnippet(body, 100, ["一致"]);
    expect(snippet).toContain("一致");
    expect(snippet.length).toBeLessThanOrEqual(100);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(snippet)).toBe(false);
  });
});

function createWithChars(snippetChars: number, posts: unknown[]) {
  const caller: EsaMcpCaller = { callTool: async () => posts };
  return { c: createEsaConnector({ sourceId: "esa", team: "example-team", caller, now: () => NOW, snippetChars }) };
}

describe("describe の summary(検索の仕様)", () => {
  it("内容の説明に検索の仕様を続け、1,000 字に収まる", async () => {
    const { c } = setup([]);
    const { summary } = await c.describe(AUTH);
    expect(summary.length).toBeLessThanOrEqual(1_000);
    expect(summary).toContain("esa チーム example-team");
    for (const fact of ["AND", "OR", "title:", "in:", "updated:", "best_match", "スニペット", "filters", "不明", "未確認"]) {
      expect(summary).toContain(fact);
    }
  });

  it("settings.summary は内容の説明を置き換え、検索の仕様は残る", async () => {
    // deployment.yaml の settings.summary は factory を通って EsaConnectorOptions.summary になる
    expect(() => createConnector({ sourceId: "esa", settings: { team: "example-team", summary: "開発部の設計書と議事録" } })).not.toThrow();
    const { c: injected } = setup([], { summary: "開発部の設計書と議事録" });
    const { summary } = await injected.describe(AUTH);
    expect(summary.startsWith("開発部の設計書と議事録\n検索の仕様:")).toBe(true);
    expect(summary).toContain(searchSpecOf(true));
  });

  it("includeWip: false のときは wip:false が付くことを書く", () => {
    expect(searchSpecOf(false)).toContain("wip:false も付く");
    expect(searchSpecOf(true)).not.toContain("wip:false も付く");
  });
});
