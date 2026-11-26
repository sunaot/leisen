/**
 * 開発用コネクタの検索方式ごとの検索プロファイル・通知と、検索の仕様の伝え方(specDelivery)の
 * テスト(T-027、ADR-025)。検索プロファイルの根拠は tested なので、各項目の値が模擬の実装の挙動と
 * 一致することをここで固定する。
 */
import { describe, expect, it } from "vitest";
import {
  sanitizeSearchNotices,
  sanitizeSearchProfile,
  type AuthContext,
  type SearchProfile,
  type SearchResult,
} from "@leisen/connector-sdk";
import {
  DEV_FIXTURE_SEARCH_MODES,
  DEV_FIXTURE_SEARCH_PROFILE,
  DEV_FIXTURE_SPEC_DELIVERIES,
  DeploymentConfigError,
  DevFixtureConnector,
  createDevFixtureConnector,
  searchModeNotices,
  searchModeProfile,
  type DevFixtureDocument,
  type DevFixtureSearchMode,
  type DevFixtureSpecDelivery,
} from "../src/index.js";

function auth(userId: string): AuthContext {
  return {
    userId,
    credential: { kind: "oauth_bearer", accessToken: `dev-only-${userId}`, expiresAt: Date.now() + 3_600_000 },
  };
}
const ALICE = auth("alice");
const BOB = auth("bob");

const LEAD = "冒頭の段落。".repeat(120);

/** 更新日時の新しい順: body-both > title-a > body-a > phrase > code-x */
const DOCS: DevFixtureDocument[] = [
  {
    id: "title-a",
    title: "経費の手引き",
    content: `${LEAD}申請は月末まで。`,
    url: "https://intranet.example.test/1",
    container: "総務",
    updatedAt: "2026-03-01T00:00:00Z",
  },
  {
    id: "body-a",
    title: "週報",
    content: `${LEAD}経費の締めを確認した。`,
    url: "https://intranet.example.test/2",
    container: "開発",
    updatedAt: "2026-02-01T00:00:00Z",
  },
  {
    id: "body-both",
    title: "定例の議事録",
    content: `${LEAD}経費と交通費の扱いを決めた。`,
    url: "https://intranet.example.test/3",
    container: "開発",
    updatedAt: "2026-05-01T00:00:00Z",
  },
  {
    id: "phrase",
    title: "メモ",
    content: "交通費 精算 の流れ。",
    url: "https://intranet.example.test/4",
    updatedAt: "2026-01-15T00:00:00Z",
  },
  {
    id: "code-x",
    title: "src/expense.ts",
    content: `${LEAD}// 経費の計算`,
    url: "https://intranet.example.test/5",
    updatedAt: "2026-01-01T00:00:00Z",
    kind: "code",
  },
];

function connector(
  mode: DevFixtureSearchMode,
  options: { redmineAllWords?: boolean; specDelivery?: DevFixtureSpecDelivery } = {},
) {
  return new DevFixtureConnector("dev-docs", DOCS, { searchMode: mode, ...options });
}

const ids = (result: SearchResult) => result.hits.map((h) => h.documentId).sort();
const ordered = (result: SearchResult) => result.hits.map((h) => h.documentId);
const hit = (result: SearchResult, id: string) => result.hits.find((h) => h.documentId === id);

/** 比較する方式(Redmine は AND / OR を別に扱う)。 */
const CASES: { name: string; mode: DevFixtureSearchMode; redmineAllWords: boolean }[] = [
  { name: "default", mode: "default", redmineAllWords: false },
  { name: "esa", mode: "esa", redmineAllWords: false },
  { name: "redmine-or", mode: "redmine", redmineAllWords: false },
  { name: "redmine-and", mode: "redmine", redmineAllWords: true },
  { name: "github", mode: "github", redmineAllWords: false },
];

function profileOf(c: (typeof CASES)[number]): SearchProfile {
  return searchModeProfile(c.mode, { redmineAllWords: c.redmineAllWords });
}

describe("検索プロファイルの値域と根拠", () => {
  it.each(CASES)("$name: SDK の検証関数を通り、全項目の根拠が tested", (c) => {
    const profile = profileOf(c);
    expect(sanitizeSearchProfile(profile)).toEqual(profile);
    for (const item of Object.values(profile)) {
      expect(item.basis).toBe("tested");
    }
  });

  it("既定の方式のプロファイルはこれまでの DEV_FIXTURE_SEARCH_PROFILE と同じ", () => {
    expect(searchModeProfile("default", { redmineAllWords: false })).toEqual(DEV_FIXTURE_SEARCH_PROFILE);
    expect(DEV_FIXTURE_SEARCH_PROFILE).toEqual({
      termJoin: { value: "and", basis: "tested" },
      matchUnit: { value: "substring", basis: "tested" },
      naturalLanguage: { value: "unsupported", basis: "tested" },
      phraseQuote: { value: "unsupported", basis: "tested" },
      operators: { value: [], basis: "tested" },
      qualifiers: { value: [], basis: "tested" },
      ranking: { value: "recency", basis: "tested" },
      titleBoost: { value: true, basis: "tested" },
      snippet: { value: "match_context", basis: "tested" },
    });
  });

  it("方式ごとの値(表で固定する)", () => {
    const summary = CASES.map((c) => {
      const p = profileOf(c);
      return [
        c.name,
        p.termJoin?.value,
        p.phraseQuote?.value,
        (p.operators?.value ?? []).join("+"),
        (p.qualifiers?.value ?? []).map((q) => q.name).join("+"),
        p.maxTerms?.value.limit ?? "-",
        p.titleBoost?.value,
        p.snippet?.value,
      ];
    });
    expect(summary).toEqual([
      ["default", "and", "unsupported", "", "", "-", true, "match_context"],
      ["esa", "and", "supported", "or", "title", "-", true, "leading_text"],
      ["redmine-or", "or", "supported", "", "", 5, false, "leading_text"],
      ["redmine-and", "and", "supported", "", "", 5, false, "leading_text"],
      ["github", "and", "unsupported", "", "", "-", true, "mixed"],
    ]);
  });
});

describe("検索プロファイルが模擬の実装と一致する", () => {
  it.each(CASES)("$name: termJoin(2 語のクエリ)", async (c) => {
    const result = await connector(c.mode, { redmineAllWords: c.redmineAllWords }).search(ALICE, "経費 交通費");
    if (profileOf(c).termJoin?.value === "and") {
      // 両方を含む文書だけ
      expect(ids(result)).toEqual(["body-both"]);
    } else {
      // いずれかを含む文書
      expect(ids(result)).toEqual(["body-a", "body-both", "code-x", "phrase", "title-a"]);
    }
  });

  it.each(CASES)("$name: matchUnit は部分一致(語の一部で一致する)", async (c) => {
    expect(profileOf(c).matchUnit?.value).toBe("substring");
    const result = await connector(c.mode, { redmineAllWords: c.redmineAllWords }).search(ALICE, "手引");
    expect(ids(result)).toEqual(["title-a"]);
  });

  it.each(CASES)("$name: naturalLanguage unsupported(空白のない質問文は一致しない)", async (c) => {
    expect(profileOf(c).naturalLanguage?.value).toBe("unsupported");
    const result = await connector(c.mode, { redmineAllWords: c.redmineAllWords }).search(
      ALICE,
      "経費の締めはいつまでですか",
    );
    expect(result.hits).toEqual([]);
  });

  it.each(CASES)("$name: phraseQuote", async (c) => {
    const result = await connector(c.mode, { redmineAllWords: c.redmineAllWords }).search(ALICE, '"交通費 精算"');
    if (profileOf(c).phraseQuote?.value === "supported") {
      expect(ids(result)).toEqual(["phrase"]);
    } else {
      // 引用符も文字として照合する(引用符を含む文書はない)
      expect(ids(result)).toEqual([]);
    }
  });

  it.each(CASES)("$name: operators(OR)", async (c) => {
    const result = await connector(c.mode, { redmineAllWords: c.redmineAllWords }).search(ALICE, "手引き OR 議事録");
    const operators = profileOf(c).operators?.value ?? [];
    if (operators.includes("or")) {
      expect(ids(result)).toEqual(["body-both", "title-a"]);
    } else if (profileOf(c).termJoin?.value === "and") {
      // OR も語として扱われ、3 語すべてを含む文書はない
      expect(ids(result)).toEqual([]);
    } else {
      // Redmine 型の OR 結合: OR は 1 語として照合され、手引き・議事録のどちらかで一致する
      expect(ids(result)).toEqual(["body-both", "title-a"]);
    }
  });

  it.each(CASES)("$name: operators に minus / not / parentheses はない(-語 は文字として照合する)", async (c) => {
    const operators = profileOf(c).operators?.value ?? [];
    expect(operators.filter((op) => op !== "or")).toEqual([]);
    const result = await connector(c.mode, { redmineAllWords: c.redmineAllWords }).search(ALICE, "-経費");
    expect(result.hits).toEqual([]);
  });

  it.each(CASES)("$name: qualifiers(title:)", async (c) => {
    const result = await connector(c.mode, { redmineAllWords: c.redmineAllWords }).search(ALICE, "title:経費");
    const names = (profileOf(c).qualifiers?.value ?? []).map((q) => q.name);
    if (names.includes("title")) {
      // タイトルに含む文書だけ(本文だけの一致は外れる)
      expect(ids(result)).toEqual(["title-a"]);
    } else {
      // 「title:経費」を文字として照合する
      expect(ids(result)).toEqual([]);
    }
  });

  it("maxTerms: Redmine 型は 6 語目が結果に影響しない(AND でも OR でも)", async () => {
    for (const redmineAllWords of [true, false]) {
      const c = connector("redmine", { redmineAllWords });
      expect(profileOf({ name: "", mode: "redmine", redmineAllWords }).maxTerms?.value).toEqual({
        limit: 5,
        overflow: "dropped",
      });
      const five = await c.search(ALICE, "経費 交通費 冒頭 段落 扱い");
      const six = await c.search(ALICE, "経費 交通費 冒頭 段落 扱い 存在しない語");
      expect(ordered(six)).toEqual(ordered(five));
      // 6 語目を入れ替えても同じ(捨てられている)
      const other = await c.search(ALICE, "経費 交通費 冒頭 段落 扱い 手引き");
      expect(ordered(other)).toEqual(ordered(five));
    }
  });

  it.each(CASES.filter((c) => c.mode !== "redmine"))(
    "$name: maxTerms の項目がない方式は 6 語目も使う",
    async (c) => {
      expect(profileOf(c).maxTerms).toBeUndefined();
      const result = await connector(c.mode).search(ALICE, "経費 交通費 冒頭 段落 扱い 存在しない語");
      expect(result.hits).toEqual([]);
    },
  );

  it.each(CASES)("$name: ranking と titleBoost(並び順)", async (c) => {
    const profile = profileOf(c);
    expect(profile.ranking?.value).toBe("recency");
    // 「経費」を含む文書: title-a はタイトルに一致、ほかは本文だけ
    const result = await connector(c.mode, { redmineAllWords: c.redmineAllWords }).search(ALICE, "経費");
    const order = ordered(result).filter((id) => id !== "code-x");
    if (profile.titleBoost?.value === true) {
      // タイトルに一致した title-a が先、残りは更新の新しい順
      expect(order).toEqual(["title-a", "body-both", "body-a"]);
    } else {
      // 更新の新しい順だけ
      expect(order).toEqual(["body-both", "title-a", "body-a"]);
    }
  });

  it.each(CASES)("$name: snippet の種類", async (c) => {
    const result = await connector(c.mode, { redmineAllWords: c.redmineAllWords }).search(ALICE, "締め");
    const doc = hit(result, "body-a");
    const leading = doc?.snippet.startsWith("冒頭の段落。") === true && !doc.snippet.includes("締め");
    const matchContext = doc?.snippet.includes("締め") === true;
    switch (profileOf(c).snippet?.value) {
      case "leading_text":
        expect(leading).toBe(true);
        break;
      case "match_context":
        expect(matchContext).toBe(true);
        break;
      case "mixed": {
        // issue は本文の先頭、コードは一致箇所の周辺
        expect(leading).toBe(true);
        const code = hit(await connector(c.mode).search(ALICE, "計算"), "code-x");
        expect(code?.snippet.includes("経費の計算")).toBe(true);
        break;
      }
      default:
        throw new Error("unexpected snippet kind");
    }
  });
});

describe("通知(notices)", () => {
  it("Redmine 型: 使える語が 6 語以上のとき terms_dropped(keptTerms 5)。5 語以下・1 文字の語・重複は数えない", () => {
    expect(searchModeNotices("redmine", "a b c d e f")).toEqual([]);
    expect(searchModeNotices("redmine", "経費 交通費 冒頭 段落 扱い")).toEqual([]);
    expect(searchModeNotices("redmine", "経費 交通費 冒頭 段落 扱い 経費 a")).toEqual([]);
    expect(searchModeNotices("redmine", '経費 "交通費 冒頭" 段落 扱い 手引き 議事録')).toEqual([
      { kind: "terms_dropped", keptTerms: 5 },
    ]);
  });

  it("esa 型: title: 以外の修飾子・-語・( ) を含むとき operator_ignored", () => {
    expect(searchModeNotices("esa", "経費 in:総務")).toEqual([{ kind: "operator_ignored" }]);
    expect(searchModeNotices("esa", "経費 -交通費")).toEqual([{ kind: "operator_ignored" }]);
    expect(searchModeNotices("esa", "(経費 OR 交通費) 申請")).toEqual([{ kind: "operator_ignored" }]);
    expect(searchModeNotices("esa", 'title:経費 "a -b" 経費 OR 交通費 10:00 ISO-8601')).toEqual([]);
  });

  it("既定・GitHub 型は通知を返さない", () => {
    for (const mode of ["default", "github"] as const) {
      expect(searchModeNotices(mode, "経費 交通費 冒頭 段落 扱い 手引き in:総務 -a (b)")).toEqual([]);
    }
  });

  it("通知は SDK の検証関数を通る", () => {
    for (const mode of DEV_FIXTURE_SEARCH_MODES) {
      const notices = searchModeNotices(mode, "経費 交通費 冒頭 段落 扱い 手引き in:総務");
      if (notices.length > 0) {
        expect(sanitizeSearchNotices(notices)).toEqual(notices);
      }
    }
  });

  it("結果が 0 件・使える語がないときも、通知は query の形だけで決まる", async () => {
    const c = connector("redmine", { redmineAllWords: true, specDelivery: "profile" });
    const none = await c.search(ALICE, "存在しない1 存在しない2 存在しない3 存在しない4 存在しない5 存在しない6");
    expect(none).toEqual({ hits: [], notices: [{ kind: "terms_dropped", keptTerms: 5 }] });
    const some = await c.search(ALICE, "経費 交通費 冒頭 段落 扱い 存在しない6");
    expect(some.hits.length).toBeGreaterThan(0);
    expect(some.notices).toEqual([{ kind: "terms_dropped", keptTerms: 5 }]);
  });
});

describe("伝え方の切り替え(specDelivery)", () => {
  const SIX = "経費 交通費 冒頭 段落 扱い 手引き";

  it.each(CASES.filter((c) => c.mode !== "default"))("$name: summary / both / profile", async (c) => {
    const base = { redmineAllWords: c.redmineAllWords };
    const query = c.mode === "esa" ? "経費 in:総務" : SIX;
    const expectsNotice = c.mode === "redmine" || c.mode === "esa";
    for (const delivery of DEV_FIXTURE_SPEC_DELIVERIES) {
      const conn = connector(c.mode, { ...base, specDelivery: delivery });
      const described = await conn.describe(ALICE);
      const result = await conn.search(ALICE, query);
      const hasSpec = described.summary.includes("検索の仕様");
      expect(described.summary.startsWith("開発用の合成文書コーパス(5件)。")).toBe(true);
      switch (delivery) {
        case "summary":
          expect(hasSpec).toBe(true);
          expect(described.searchProfile).toBeUndefined();
          expect(result.notices).toBeUndefined();
          break;
        case "both":
          expect(hasSpec).toBe(true);
          expect(described.searchProfile).toEqual(profileOf(c));
          expect(result.notices !== undefined).toBe(expectsNotice);
          break;
        case "profile":
          expect(hasSpec).toBe(false);
          expect(described.summary).toBe("開発用の合成文書コーパス(5件)。実在の組織・人物・秘密情報は含まない。");
          expect(described.searchProfile).toEqual(profileOf(c));
          expect(result.notices !== undefined).toBe(expectsNotice);
          break;
      }
    }
  });

  it("省略時: 模擬の方式は summary(プロファイルも通知も返さない)、既定の方式はプロファイルを返す", async () => {
    for (const c of CASES) {
      const conn = connector(c.mode, { redmineAllWords: c.redmineAllWords });
      const described = await conn.describe(ALICE);
      const result = await conn.search(ALICE, c.mode === "esa" ? "経費 in:総務" : SIX);
      expect(result.notices).toBeUndefined();
      if (c.mode === "default") {
        expect(described.searchProfile).toEqual(DEV_FIXTURE_SEARCH_PROFILE);
        expect(described.summary).toBe("開発用の合成文書コーパス(5件)。実在の組織・人物・秘密情報は含まない。");
      } else {
        expect(described.searchProfile).toBeUndefined();
        expect(described.summary).toContain("検索の仕様");
      }
    }
  });

  it("既定の方式: summary ならプロファイルを返さない、both / profile なら返す(summary は変わらない)", async () => {
    const summaries = new Set<string>();
    for (const delivery of DEV_FIXTURE_SPEC_DELIVERIES) {
      const described = await connector("default", { specDelivery: delivery }).describe(ALICE);
      summaries.add(described.summary);
      expect(described.searchProfile).toEqual(delivery === "summary" ? undefined : DEV_FIXTURE_SEARCH_PROFILE);
    }
    expect(summaries.size).toBe(1);
  });

  it("伝え方によって検索の結果(ヒット)は変わらない", async () => {
    for (const c of CASES) {
      const results = await Promise.all(
        DEV_FIXTURE_SPEC_DELIVERIES.map((specDelivery) =>
          connector(c.mode, { redmineAllWords: c.redmineAllWords, specDelivery }).search(ALICE, SIX),
        ),
      );
      const hits = results.map((r) => JSON.stringify(r.hits));
      expect(new Set(hits).size).toBe(1);
    }
  });

  it("Redmine 型のフィルタは伝え方によらず invalid_request のまま", async () => {
    for (const specDelivery of DEV_FIXTURE_SPEC_DELIVERIES) {
      await expect(
        connector("redmine", { specDelivery }).search(ALICE, "経費", { container: "総務" }),
      ).rejects.toMatchObject({ errorClass: "invalid_request" });
    }
  });

  it("利用者によって検索プロファイルと通知は変わらない", async () => {
    for (const c of CASES) {
      const conn = connector(c.mode, { redmineAllWords: c.redmineAllWords, specDelivery: "both" });
      expect((await conn.describe(BOB)).searchProfile).toEqual((await conn.describe(ALICE)).searchProfile);
      const query = c.mode === "esa" ? "経費 in:総務" : SIX;
      expect((await conn.search(BOB, query)).notices).toEqual((await conn.search(ALICE, query)).notices);
    }
  });

  it("設定: settings.specDelivery を受け、未知の値は設定の不備", async () => {
    const init = (settings: Record<string, unknown>) =>
      ({
        sourceId: "dev-docs",
        settings: { documents: DOCS, ...settings },
        configDir: "/",
        policy: { privateScopes: "excluded" },
      }) as Parameters<typeof createDevFixtureConnector>[0];
    const c = await createDevFixtureConnector(
      init({ searchMode: "redmine", redmineAllWords: true, specDelivery: "profile" }),
    );
    const described = await c.describe(ALICE);
    expect(described.searchProfile?.termJoin?.value).toBe("and");
    expect(described.summary).not.toContain("検索の仕様");
    expect((await c.search(ALICE, SIX)).notices).toEqual([{ kind: "terms_dropped", keptTerms: 5 }]);
    await expect(createDevFixtureConnector(init({ specDelivery: "free_text" }))).rejects.toBeInstanceOf(
      DeploymentConfigError,
    );
  });
});
