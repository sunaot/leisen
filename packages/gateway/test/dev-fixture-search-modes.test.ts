/**
 * 開発用コネクタの検索方式(esa / redmine / github)と合成コーパスの生成のテスト。
 * 既定の方式(default)の挙動は dev-fixture-connector.test.ts が固定している。
 */
import { describe, expect, it } from "vitest";
import { ConnectorError, MAX_SNIPPET_CHARS, type AuthContext } from "@leisen/connector-sdk";
import {
  DeploymentConfigError,
  DevFixtureConnector,
  ESA_SNIPPET_CHARS,
  MAX_SYNTHETIC_DOCUMENTS,
  createDevFixtureConnector,
  generateSyntheticCorpus,
  parseEsaQuery,
  redmineTokens,
  type DevFixtureDocument,
} from "../src/index.js";

const AUTH: AuthContext = {
  userId: "alice",
  credential: { kind: "oauth_bearer", accessToken: "dev-only-token", expiresAt: Date.now() + 3_600_000 },
};

const LONG = "前置きの文章。".repeat(80);

const DOCS: DevFixtureDocument[] = [
  {
    id: "old-title",
    title: "経費精算の手引き",
    content: `${LONG}経費精算は翌月10日までに申請する。`,
    url: "https://intranet.example.test/a",
    container: "総務",
    author: "総務部",
    updatedAt: "2025-01-01T00:00:00Z",
  },
  {
    id: "new-body",
    title: "週報",
    content: "経費精算システムの改修の進捗を共有した。交通費 の画面も確認した。",
    url: "https://intranet.example.test/b",
    container: "開発",
    author: "開発部",
    updatedAt: "2026-06-01T00:00:00Z",
    kind: "pull_request",
  },
  {
    id: "mid-vpn",
    title: "VPN の手順",
    content: "社外から VPN に接続する。交通費とは関係ない。",
    url: "https://intranet.example.test/c",
    container: "情報システム",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "code-1",
    title: "src/expense/handler.ts",
    content: "// 経費精算のハンドラ\nexport function handle() {}",
    url: "https://intranet.example.test/d",
    updatedAt: "2026-07-01T00:00:00Z",
    kind: "code",
  },
];

function connector(options: ConstructorParameters<typeof DevFixtureConnector>[2]) {
  return new DevFixtureConnector("dev-docs", DOCS, options);
}

const ids = (result: { hits: readonly { documentId: string }[] }) =>
  result.hits.map((h) => h.documentId);

describe("既定の方式は変えない", () => {
  it("searchMode 省略時と default は同じ結果・同じ summary・全フィルタ対応", async () => {
    const a = connector({});
    const b = connector({ searchMode: "default" });
    expect(await a.search(AUTH, "経費精算")).toEqual(await b.search(AUTH, "経費精算"));
    const described = await a.describe(AUTH);
    expect(described.summary).toBe("開発用の合成文書コーパス(4件)。実在の組織・人物・秘密情報は含まない。");
    expect(described.supportedFilters).toEqual(["updatedAfter", "updatedBefore", "container", "author"]);
  });
});

describe("esa 型", () => {
  const esa = connector({ searchMode: "esa" });

  it("空白は AND、タイトル一致を優遇し、スニペットは本文の先頭(一致箇所ではない)", async () => {
    const result = await esa.search(AUTH, "経費精算");
    expect(ids(result)).toEqual(["old-title", "code-1", "new-body"]);
    const first = result.hits[0];
    expect(first?.snippet.startsWith("前置きの文章。")).toBe(true);
    expect(first?.snippet.length).toBeLessThanOrEqual(ESA_SNIPPET_CHARS);
    expect(first?.snippet.includes("翌月10日")).toBe(false);
    expect(ids(await esa.search(AUTH, "経費精算 交通費"))).toEqual(["new-body"]);
  });

  it("OR は前後の語のどちらかでよく、AND より先に結び付く", async () => {
    // どちらもタイトルに 1 組一致 → 更新の新しい順
    expect(ids(await esa.search(AUTH, "VPN OR 手引き"))).toEqual(["mid-vpn", "old-title"]);
    // (VPN または 手引き) かつ 交通費 → mid-vpn だけ
    expect(ids(await esa.search(AUTH, "VPN OR 手引き 交通費"))).toEqual(["mid-vpn"]);
  });

  it("引用符は語句として一致させ、title: はタイトルだけを見る", async () => {
    expect(ids(await esa.search(AUTH, '"交通費 の画面"'))).toEqual(["new-body"]);
    expect(ids(await esa.search(AUTH, '"交通費 画面"'))).toEqual([]);
    expect(ids(await esa.search(AUTH, "title:経費精算"))).toEqual(["old-title"]);
    expect(ids(await esa.search(AUTH, 'title:"VPN の"'))).toEqual(["mid-vpn"]);
  });

  it("クエリの解析: 先頭・連続の OR は無視する", () => {
    const groups = parseEsaQuery("OR a OR OR b c");
    expect(groups.map((g) => g.length)).toEqual([2, 1]);
  });

  it("語がなければ invalid_request、フィルタは使える、searchSpec に仕様がある", async () => {
    await expect(esa.search(AUTH, '  ""  ')).rejects.toMatchObject({ errorClass: "invalid_request" });
    expect(ids(await esa.search(AUTH, "経費精算", { container: "開発" }))).toEqual(["new-body"]);
    expect(esa.searchSpec).toContain("esa 型");
    expect(esa.searchSpec).toContain("OR");
    expect(esa.searchSpec).toContain("title:");
    expect(esa.searchSpec.length).toBeLessThanOrEqual(1500);
    expect((await esa.describe(AUTH)).summary).not.toContain("検索の仕様");
  });
});

describe("Redmine 型", () => {
  it("既定は OR。関連度なしで更新の新しい順、スニペットは本文の先頭", async () => {
    const redmine = connector({ searchMode: "redmine" });
    const result = await redmine.search(AUTH, "手引き VPN");
    // タイトル一致の old-title より、更新の新しい mid-vpn が先
    expect(ids(result)).toEqual(["mid-vpn", "old-title"]);
    expect(result.hits[1]?.snippet.startsWith("前置きの文章。")).toBe(true);
    expect(result.hits[1]?.snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS);
  });

  it("redmineAllWords: true なら AND", async () => {
    const redmine = connector({ searchMode: "redmine", redmineAllWords: true });
    expect(ids(await redmine.search(AUTH, "手引き VPN"))).toEqual([]);
    expect(ids(await redmine.search(AUTH, "経費精算 交通費"))).toEqual(["new-body"]);
  });

  it("先頭 5 語だけを使い、6 語目以降は捨てる(1 文字の語・重複は数えない)", async () => {
    expect(redmineTokens('a 一 二三 "四 五" 六七 二三 八九 十十 末尾')).toEqual([
      "二三",
      "四 五",
      "六七",
      "八九",
      "十十",
    ]);
    const redmine = connector({ searchMode: "redmine", redmineAllWords: true });
    // 6 語目の「存在しない語」は捨てられるので、AND でも一致する
    expect(ids(await redmine.search(AUTH, "経費精算 交通費 改修 進捗 共有 存在しない語"))).toEqual([
      "new-body",
    ]);
    // 使える語が残らなければ結果なし(エラーにしない)
    expect(ids(await redmine.search(AUTH, "a b"))).toEqual([]);
  });

  it("フィルタは invalid_request、describe の supportedFilters は空で、searchSpec に仕様がある", async () => {
    const redmine = connector({ searchMode: "redmine" });
    const error = await redmine.search(AUTH, "経費精算", { container: "総務" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).errorClass).toBe("invalid_request");
    const described = await redmine.describe(AUTH);
    expect(described.supportedFilters).toEqual([]);
    expect(redmine.searchSpec).toContain("先頭 5 語");
    expect(redmine.searchSpec).toContain("OR");
    expect(connector({ searchMode: "redmine", redmineAllWords: true }).searchSpec).toContain("AND");
  });
});

describe("GitHub 型", () => {
  const github = connector({ searchMode: "github" });

  it("種別ごとに交互に並べ、meta.type を付ける。コードは一致箇所、issue/PR は本文の先頭", async () => {
    const result = await github.search(AUTH, "経費精算");
    expect(ids(result)).toEqual(["old-title", "new-body", "code-1"]);
    expect(result.hits.map((h) => h.meta?.["type"])).toEqual(["issue", "pull_request", "code"]);
    expect(result.hits[0]?.snippet.startsWith("前置きの文章。")).toBe(true);
    expect(result.hits[2]?.snippet).toContain("経費精算");
  });

  it("件数の枠を種別で等分し(余りは先の種別)、続きはカーソルで取る", async () => {
    const docs: DevFixtureDocument[] = Array.from({ length: 6 }, (_, i) => ({
      id: `issue-${i}`,
      title: `問い合わせ ${i}`,
      content: "共通の語",
      url: `https://intranet.example.test/i${i}`,
      updatedAt: `2026-01-0${i + 1}T00:00:00Z`,
    }));
    docs.push({
      id: "pr-0",
      title: "PR",
      content: "共通の語",
      url: "https://intranet.example.test/p",
      kind: "pull_request",
    });
    const c = new DevFixtureConnector("dev-docs", docs, { searchMode: "github" });
    // limit 4 → issue 2 / PR 1 / code 1。PR とコードが少なくても issue の枠は増えない
    const page1 = await c.search(AUTH, "共通の語", undefined, { limit: 4 });
    expect(ids(page1)).toEqual(["issue-5", "pr-0", "issue-4"]);
    expect(page1.nextCursor).toBeDefined();
    const page2 = await c.search(AUTH, "共通の語", undefined, { limit: 4, cursor: page1.nextCursor });
    expect(ids(page2)).toEqual(["issue-3", "issue-2"]);
  });

  it("author / updated のフィルタがあるとコードを検索しない", async () => {
    const result = await github.search(AUTH, "経費精算", { updatedAfter: "2020-01-01T00:00:00Z" });
    expect(result.hits.some((h) => h.meta?.["type"] === "code")).toBe(false);
  });

  it("既定の件数は 20、searchSpec に仕様がある", async () => {
    expect(github.searchSpec).toContain("GitHub 型");
    expect(github.searchSpec).toContain("meta.type");
    expect(github.searchSpec.length).toBeLessThanOrEqual(1500);
  });
});

describe("設定(kind: dev-fixture の settings)", () => {
  it("searchMode / redmineAllWords / synthetic を受け、生成した文書を足す", async () => {
    const c = await createDevFixtureConnector({
      sourceId: "dev-docs",
      settings: {
        documents: DOCS,
        searchMode: "redmine",
        redmineAllWords: true,
        synthetic: { seed: 1, count: 30 },
      },
      configDir: "/",
      policy: { privateScopes: "excluded" },
    } as Parameters<typeof createDevFixtureConnector>[0]);
    const described = await c.describe(AUTH);
    expect(described.summary).toContain("34件");
    expect(c.searchSpec).toContain("AND");
  });

  it("未知の方式・範囲外の生成数は設定の不備", async () => {
    for (const settings of [
      { searchMode: "solr" },
      { synthetic: { seed: 1, count: MAX_SYNTHETIC_DOCUMENTS + 1 } },
    ]) {
      await expect(
        createDevFixtureConnector({
          sourceId: "dev-docs",
          settings,
          configDir: "/",
          policy: { privateScopes: "excluded" },
        } as Parameters<typeof createDevFixtureConnector>[0]),
      ).rejects.toBeInstanceOf(DeploymentConfigError);
    }
  });
});

describe("合成コーパスの生成", () => {
  it("同じ種と数からは同じ文書列、種が違えば違う文書列", () => {
    const a = generateSyntheticCorpus({ seed: 20261125, count: 400 });
    const b = generateSyntheticCorpus({ seed: 20261125, count: 400 });
    const c = generateSyntheticCorpus({ seed: 7, count: 400 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).toHaveLength(400);
    // 先頭の部分列は数によらない
    expect(generateSyntheticCorpus({ seed: 20261125, count: 10 })).toEqual(a.slice(0, 10));
  });

  it("ID は一意で noise- 接頭辞、URL は example.test、種別が混ざる、開発用コネクタに読める", () => {
    const docs = generateSyntheticCorpus({ seed: 20261125, count: 400 });
    expect(new Set(docs.map((d) => d.id)).size).toBe(400);
    expect(docs.every((d) => d.id.startsWith("noise-"))).toBe(true);
    expect(docs.every((d) => d.url.startsWith("https://intranet.example.test/"))).toBe(true);
    expect(new Set(docs.map((d) => d.kind))).toEqual(new Set(["issue", "pull_request", "code"]));
    expect(() => new DevFixtureConnector("dev-docs", docs)).not.toThrow();
  });

  it("範囲外の数・種は RangeError", () => {
    expect(() => generateSyntheticCorpus({ seed: 1, count: 0 })).toThrow(RangeError);
    expect(() => generateSyntheticCorpus({ seed: -1, count: 1 })).toThrow(RangeError);
  });
});
