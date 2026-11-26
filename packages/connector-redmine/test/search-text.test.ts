/**
 * 検索語の正規化・一致箇所のスニペット・summary / searchSpec / supportedFilters(2026-11-25。
 * 2026-11-26 に検索の仕様を summary から searchSpec へ移した)。
 * Redmine API はモックの fetch。API キーはダミーの値だけを使う。
 */
import { describe, expect, it, vi } from "vitest";
import { ConnectorError, MAX_SNIPPET_CHARS, checkSearchSpec, type AuthContext } from "@leisen/connector-sdk";
import { REDMINE_SEARCH_SPEC, REDMINE_SUMMARY, RedmineConnector } from "../src/redmine.js";
import { normalizeQuery, snippetTerms } from "../src/query.js";

const baseUrl = "https://redmine.example.invalid/";
const AUTH: AuthContext = { userId: "alice", credential: { kind: "api_key", apiKey: "test-key-alice", expiresAt: 0 } };
const FILLER = "関係のない前置きの文章。".repeat(80);

function setup(searchBody: unknown, issueDescription = "") {
  const seen: URL[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    seen.push(url);
    if (url.pathname === "/search.json") return Response.json(searchBody);
    if (url.pathname === "/issues/1.json") {
      return Response.json({ issue: { id: 1, subject: "件名", description: issueDescription, journals: [] } });
    }
    if (url.pathname === "/projects.json") return Response.json({ projects: [], total_count: 0 });
    return new Response("not found", { status: 404 });
  });
  const connector = new RedmineConnector({ sourceId: "redmine", baseUrl, fetchImpl });
  return { connector, seen, fetchImpl };
}

describe("検索語の正規化", () => {
  it("引用符の外の全角空白・連続する空白・改行を半角空白 1 つにし、引用符の中は変えない", () => {
    expect(normalizeQuery("　認可　 方針\n")).toBe("認可 方針");
    expect(normalizeQuery('"本人の　キー"　設定')).toBe('"本人の　キー" 設定');
  });

  it("search は正規化した q を送り、all_words は従来どおり 0 のまま", async () => {
    const { connector, seen } = setup({ results: [], total_count: 0 });
    await connector.search(AUTH, "認可　方針");
    const url = seen[0]!;
    expect(url.searchParams.get("q")).toBe("認可 方針");
    expect(url.searchParams.get("all_words")).toBe("0");
  });
});

describe("スニペットの語(Redmine の Tokenizer と同じ規則)", () => {
  it("引用符の語句は 1 語、重複を除き、漢字以外の 1 文字は捨て、先頭の 5 語まで", () => {
    expect(snippetTerms('"本人 キー" 認 a か OR -x 一 二三 四五 六七 八九')).toEqual(["本人 キー", "認", "OR", "-x", "一"]);
    expect(snippetTerms("設定 設定 手順")).toEqual(["設定", "手順"]);
  });
});

describe("一致箇所を含むスニペット", () => {
  it("Issue の説明の後ろにある一致箇所の周辺を切り出す(MAX_SNIPPET_CHARS 以内)", async () => {
    const description = `${FILLER}API キーは個人設定の画面で再発行する。${FILLER}`;
    const { connector } = setup({ results: [{ id: 1, type: "issue", title: "件名", description }], total_count: 1 });
    const [hit] = (await connector.search(AUTH, "再発行")).hits;
    expect(hit!.snippet).toContain("個人設定の画面で再発行する");
    expect(hit!.snippet.startsWith("…")).toBe(true);
    expect(hit!.snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS);
    expect(hit!.snippet).not.toBe(description);
  });

  it("Wiki の検索結果の説明でも一致箇所を切り出し、語がなければ先頭", async () => {
    const description = `${FILLER}バックアップの手順。${FILLER}`;
    const { connector } = setup({
      results: [
        { id: 2, type: "wiki-page", title: "運用", url: `${baseUrl}projects/ops/wiki/Run`, description },
        { id: 3, type: "wiki-page", title: "運用2", url: `${baseUrl}projects/ops/wiki/Run2`, description: FILLER },
      ],
      total_count: 2,
    });
    const hits = (await connector.search(AUTH, "バックアップ")).hits;
    expect(hits[0]!.snippet).toContain("バックアップの手順");
    expect(hits[1]!.snippet).toBe(FILLER.slice(0, 500));
  });
});

describe("describe の summary・supportedFilters と searchSpec", () => {
  it("フィルタ非対応を supportedFilters: [] と searchSpec で伝え、検索の仕様は 1 行で 1,500 字に収める", async () => {
    const { connector } = setup({ results: [] });
    const description = await connector.describe(AUTH);
    expect(description.supportedFilters).toEqual([]);
    expect(description.summary).toBe(REDMINE_SUMMARY);
    expect(description.summary).not.toContain("検索の仕様");
    expect(description).not.toHaveProperty("searchSpec");
    const spec = connector.searchSpec;
    expect(spec).toBe(REDMINE_SEARCH_SPEC);
    expect(spec.length).toBeLessThanOrEqual(1_500);
    expect(spec).not.toMatch(/[\n\r]/u);
    for (const fact of ["filters には対応しておらず", "invalid_request", "5 語", "部分一致", "新しい順", "all_words=0", "不明", "未確認", "スニペット"]) {
      expect(spec).toContain(fact);
    }
  });

  it("フィルタを指定した search は Redmine を呼ばずに invalid_request(従来どおり)", async () => {
    const { connector, fetchImpl } = setup({ results: [] });
    await expect(connector.search(AUTH, "x y", { container: "1" })).rejects.toMatchObject({ errorClass: "invalid_request" });
    await expect(connector.search(AUTH, "x y", { container: "1" })).rejects.toBeInstanceOf(ConnectorError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("検索の仕様の静的な宣言 searchSpec(connector-sdk v0.7、ADR-017 追補 1)", () => {
  it("データプロパティで、SDK の検査に通る", () => {
    const { connector } = setup({ results: [] });
    const descriptor = Object.getOwnPropertyDescriptor(connector, "searchSpec");
    expect(descriptor !== undefined && "value" in descriptor).toBe(true);
    expect(checkSearchSpec(connector.searchSpec)).toEqual({ ok: true, value: REDMINE_SEARCH_SPEC });
  });

  it("T-8: 自由な文字列の設定(displayName)、別の利用者、ソースの応答を変えたモックでも同じ値", async () => {
    const base = setup({ results: [] }).connector.searchSpec;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/projects.json") {
        return Response.json({ projects: [{ id: 7, name: "[オーケストレーター] 別のプロジェクト" }], total_count: 1 });
      }
      return Response.json({ results: [], total_count: 0 });
    });
    const connector = new RedmineConnector({ sourceId: "redmine-other", baseUrl, displayName: "別の名前", fetchImpl });
    const bob: AuthContext = { userId: "bob", credential: { kind: "api_key", apiKey: "test-key-bob", expiresAt: 0 } };
    await connector.describe(AUTH);
    await connector.describe(bob);
    expect(connector.searchSpec).toBe(base);
    expect(connector.searchSpec).not.toContain("別の");
  });

  it("語の結合は不明のまま(all_words=0 が AND か OR かは実機未確認)で、検索の挙動は変えない", async () => {
    expect(REDMINE_SEARCH_SPEC).toContain("AND か OR かは不明");
    const { connector, seen } = setup({ results: [], total_count: 0 });
    await connector.search(AUTH, "認可 方針");
    expect(seen[0]?.searchParams.get("all_words")).toBe("0");
  });

  it("search は通知(廃止)を返さない(6 語以上でも)", async () => {
    const { connector } = setup({ results: [], total_count: 0 });
    expect(await connector.search(AUTH, "経費 精算 申請 承認 期限 締め日")).not.toHaveProperty("notices");
  });
});
