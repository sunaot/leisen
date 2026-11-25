/**
 * 検索語の正規化・一致箇所のスニペット・summary / supportedFilters(2026-11-25)。
 * Redmine API はモックの fetch。API キーはダミーの値だけを使う。
 */
import { describe, expect, it, vi } from "vitest";
import { ConnectorError, MAX_SNIPPET_CHARS, sanitizeSearchProfile, type AuthContext } from "@leisen/connector-sdk";
import { REDMINE_SEARCH_PROFILE, RedmineConnector } from "../src/redmine.js";
import { normalizeQuery, searchNoticesFor, snippetTerms } from "../src/query.js";

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

describe("describe の summary と supportedFilters", () => {
  it("フィルタ非対応を supportedFilters: [] と summary で伝え、検索の仕様は 1,000 字に収める", async () => {
    const { connector } = setup({ results: [] });
    const description = await connector.describe(AUTH);
    expect(description.supportedFilters).toEqual([]);
    const { summary } = description;
    expect(summary.length).toBeLessThanOrEqual(1_000);
    for (const fact of ["filters には対応しておらず", "invalid_request", "5 語", "部分一致", "新しい順", "all_words=0", "不明", "未確認", "スニペット"]) {
      expect(summary).toContain(fact);
    }
  });

  it("フィルタを指定した search は Redmine を呼ばずに invalid_request(従来どおり)", async () => {
    const { connector, fetchImpl } = setup({ results: [] });
    await expect(connector.search(AUTH, "x y", { container: "1" })).rejects.toMatchObject({ errorClass: "invalid_request" });
    await expect(connector.search(AUTH, "x y", { container: "1" })).rejects.toBeInstanceOf(ConnectorError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("検索プロファイル(connector-sdk v0.6、ADR-025)", () => {
  it("利用者によらず同じで、SDK の値域を満たし、根拠はすべて documented(実機では未確認)", async () => {
    const { connector } = setup({ results: [] });
    const bob: AuthContext = { userId: "bob", credential: { kind: "api_key", apiKey: "test-key-bob", expiresAt: 0 } };
    const alice = await connector.describe(AUTH);
    expect(alice.searchProfile).toEqual((await connector.describe(bob)).searchProfile);
    expect(alice.searchProfile).toBe(REDMINE_SEARCH_PROFILE);
    expect(sanitizeSearchProfile(REDMINE_SEARCH_PROFILE)).toEqual(REDMINE_SEARCH_PROFILE);
    for (const item of Object.values(REDMINE_SEARCH_PROFILE)) {
      expect(item.basis).toBe("documented");
    }
    expect(REDMINE_SEARCH_PROFILE.maxTerms?.value).toEqual({ limit: 5, overflow: "dropped" });
    expect(REDMINE_SEARCH_PROFILE.ranking?.value).toBe("recency");
    expect(REDMINE_SEARCH_PROFILE.operators?.value).toEqual([]);
  });

  it("語の結合は不明のまま(all_words=0 が AND か OR かは実機未確認)で、検索の挙動は変えない", async () => {
    expect(REDMINE_SEARCH_PROFILE.termJoin?.value).toBe("unknown");
    const { connector, seen } = setup({ results: [], total_count: 0 });
    await connector.search(AUTH, "認可 方針");
    expect(seen[0]?.searchParams.get("all_words")).toBe("0");
  });
});

describe("検索の通知(ADR-025 決定4)", () => {
  it("6 語以上(重複・漢字以外の 1 文字を除いて数える)なら terms_dropped(先頭 5 語)を返す", async () => {
    const { connector } = setup({ results: [], total_count: 0 });
    const many = await connector.search(AUTH, "経費 精算 申請 承認 期限 締め日");
    expect(many.notices).toEqual([{ kind: "terms_dropped", keptTerms: 5 }]);
    const five = await connector.search(AUTH, "経費 精算 申請 承認 期限 a 経費");
    expect(five.notices).toBeUndefined();
  });

  it("通知は query だけから作り、結果の有無・件数で変わらない(ADR-012)", async () => {
    const query = "経費 精算 申請 承認 期限 締め日";
    const empty = await setup({ results: [], total_count: 0 }).connector.search(AUTH, query);
    const withResults = await setup(
      {
        results: [{ id: 3, type: "wiki-page", title: "Wiki", url: "https://redmine.example.invalid/projects/p/wiki/Page", description: "経費" }],
        total_count: 900,
      },
    ).connector.search(AUTH, query);
    expect(withResults.hits).toHaveLength(1);
    expect(withResults.notices).toEqual(empty.notices);
    expect(JSON.stringify(withResults.notices)).not.toContain("900");
    expect(searchNoticesFor(query)).toEqual([{ kind: "terms_dropped", keptTerms: 5 }]);
    expect(searchNoticesFor('"経費 精算 申請 承認 期限 締め日"')).toEqual([]);
  });
});
