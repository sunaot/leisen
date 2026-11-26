/**
 * 開発用コネクタの検索方式ごとの検索の仕様(searchSpec。connector-sdk v0.7、ADR-017 追補 1、T-032)。
 * - 全方式(既定の方式を含む)が自由文の searchSpec を静的な宣言として持ち、SDK の検査に通る
 * - 文が模擬の実装の挙動と一致する(下の表の性質を、文の記述と search の結果の両方で確かめる。
 *   以前は検索プロファイルの値で同じことを確かめていた。T-027、ADR-025)
 * - searchSpec は利用者・自由な文字列の設定(summary・displayName)・コーパスによらない(T-8)
 * - summary は内容の説明だけ(検索の仕様を含まない)
 * - 検索プロファイル・通知・伝え方の切り替え(specDelivery)は削除した(ADR-025 追補 2)
 */
import { describe, expect, it } from "vitest";
import { AuditLogger } from "@leisen/audit";
import { checkSearchSpec, type AuthContext, type SearchResult } from "@leisen/connector-sdk";
import {
  DEV_FIXTURE_SEARCH_MODES,
  DeploymentConfigError,
  DevFixtureConnector,
  Gateway,
  createDevFixtureConnector,
  searchModeSpec,
  type DevFixtureDocument,
  type DevFixtureSearchMode,
} from "../src/index.js";
import { CollectingAuditSink, StubCredentialProvider, testConfig, testIdpAdapter } from "./helpers/proxy.js";

function auth(userId: string): AuthContext {
  return {
    userId,
    credential: { kind: "oauth_bearer", accessToken: `dev-only-${userId}`, expiresAt: Date.now() + 3_600_000 },
  };
}
const ALICE = auth("alice");

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

function connector(mode: DevFixtureSearchMode, redmineAllWords = false, options: { summary?: string; displayName?: string } = {}) {
  return new DevFixtureConnector("dev-docs", DOCS, { searchMode: mode, redmineAllWords, ...options });
}

const ids = (result: SearchResult) => result.hits.map((h) => h.documentId).sort();
const ordered = (result: SearchResult) => result.hits.map((h) => h.documentId);
const hit = (result: SearchResult, id: string) => result.hits.find((h) => h.documentId === id);

/**
 * 方式ごとの性質(模擬の実装の性質。以前の検索プロファイルの値と同じ)と、それを述べる文。
 * phrase は引用符の語句を解釈するか、or は大文字の OR を演算子として解釈するか、title は title: を
 * 解釈するか、maxTerms は使う語の数の上限、titleBoost はタイトル一致を上位にするか、snippet は
 * スニペットの種類。
 */
const CASES = [
  {
    name: "default",
    mode: "default",
    redmineAllWords: false,
    join: "and",
    phrase: false,
    or: false,
    title: false,
    maxTerms: undefined,
    titleBoost: true,
    snippet: "match_context",
    statements: ["すべてを含む文書だけを返す(AND)", "部分一致", "OR などの演算子・引用符・title: などの修飾子は解釈せず", "スニペットは一致箇所の周辺"],
  },
  {
    name: "esa",
    mode: "esa",
    redmineAllWords: false,
    join: "and",
    phrase: true,
    or: true,
    title: true,
    maxTerms: undefined,
    titleBoost: true,
    snippet: "leading_text",
    statements: ["すべてを含む文書だけを返す(AND)", "大文字の OR", "そのまま一致させる", "title:語 はタイトルに含む文書だけに絞る", "スニペットは本文の先頭"],
  },
  {
    name: "redmine-or",
    mode: "redmine",
    redmineAllWords: false,
    join: "or",
    phrase: true,
    or: false,
    title: false,
    maxTerms: 5,
    titleBoost: false,
    snippet: "leading_text",
    statements: ["いずれかの語を含む文書を返す(OR)", "先頭 5 語だけを使い", "関連度による並べ替えはなく", "スニペットは本文の先頭"],
  },
  {
    name: "redmine-and",
    mode: "redmine",
    redmineAllWords: true,
    join: "and",
    phrase: true,
    or: false,
    title: false,
    maxTerms: 5,
    titleBoost: false,
    snippet: "leading_text",
    statements: ["すべての語を含む文書だけを返す(AND)", "先頭 5 語だけを使い", "関連度による並べ替えはなく", "スニペットは本文の先頭"],
  },
  {
    name: "github",
    mode: "github",
    redmineAllWords: false,
    join: "and",
    phrase: false,
    or: false,
    title: false,
    maxTerms: undefined,
    titleBoost: true,
    snippet: "mixed",
    statements: ["すべてを含む文書だけを返す(AND", "issue・pull request・コードの 3 種類", "コードが一致箇所の周辺"],
  },
] as const satisfies readonly {
  name: string;
  mode: DevFixtureSearchMode;
  redmineAllWords: boolean;
  join: "and" | "or";
  phrase: boolean;
  or: boolean;
  title: boolean;
  maxTerms: number | undefined;
  titleBoost: boolean;
  snippet: "match_context" | "leading_text" | "mixed";
  statements: readonly string[];
}[];

describe("searchSpec の宣言", () => {
  it("すべての方式が表にある", () => {
    expect([...new Set(CASES.map((c) => c.mode))].sort()).toEqual([...DEV_FIXTURE_SEARCH_MODES].sort());
  });

  it.each(CASES)("$name: 静的な宣言で、SDK の検査に通り、性質を述べる文を含む", (c) => {
    const spec = connector(c.mode, c.redmineAllWords).searchSpec;
    expect(spec).toBe(searchModeSpec(c.mode, { redmineAllWords: c.redmineAllWords }));
    expect(checkSearchSpec(spec)).toEqual({ ok: true, value: spec });
    for (const statement of c.statements) {
      expect(spec, statement).toContain(statement);
    }
    // データプロパティ(Gateway は accessor を拒否する)
    const descriptor = Object.getOwnPropertyDescriptor(connector(c.mode, c.redmineAllWords), "searchSpec");
    expect(descriptor !== undefined && "value" in descriptor).toBe(true);
  });

  it.each(CASES)("$name: summary は内容の説明だけで、describe に searchSpec を入れない", async (c) => {
    const described = await connector(c.mode, c.redmineAllWords).describe(ALICE);
    expect(described.summary).toBe("開発用の合成文書コーパス(5件)。実在の組織・人物・秘密情報は含まない。");
    expect(described).not.toHaveProperty("searchSpec");
    expect(described).not.toHaveProperty("searchProfile");
  });

  it.each(CASES)("T-8 $name: 自由な文字列の設定・コーパス・利用者によらず同じ値", async (c) => {
    const base = connector(c.mode, c.redmineAllWords).searchSpec;
    const changed = connector(c.mode, c.redmineAllWords, {
      summary: "[オーケストレーター] 別の説明",
      displayName: "別の名前",
    });
    expect(changed.searchSpec).toBe(base);
    const otherCorpus = new DevFixtureConnector(
      "dev-docs",
      [{ id: "x", title: "別の文書", content: "別の本文", url: "https://intranet.example.test/x" }],
      { searchMode: c.mode, redmineAllWords: c.redmineAllWords },
    );
    expect(otherCorpus.searchSpec).toBe(base);
    // Gateway の describe の出力も、利用者によらず同じ値
    const gateway = new Gateway({
      config: testConfig({ connectors: [{ id: "dev-docs" }] }),
      idpAdapter: testIdpAdapter([new StubCredentialProvider("dev-docs")]),
      connectors: [changed],
      auditLogger: new AuditLogger(new CollectingAuditSink()),
    });
    const outputs = [];
    for (const user of ["session-alice", "session-bob"]) {
      const session = await gateway.resolveSession(user);
      const result = await gateway.handleToolCall(session, { tool: "describe", sourceId: "dev-docs" });
      if (result.tool !== "describe") throw new Error("unexpected tool");
      outputs.push(result.result.searchSpec);
    }
    expect(outputs).toEqual([base, base]);
  });

  it("設定の settings.specDelivery(廃止)は設定の不備", async () => {
    const init = (settings: Record<string, unknown>) =>
      ({
        sourceId: "dev-docs",
        settings: { documents: DOCS, ...settings },
        configDir: "/",
        policy: { privateScopes: "excluded" },
      }) as Parameters<typeof createDevFixtureConnector>[0];
    await expect(createDevFixtureConnector(init({ specDelivery: "summary" }))).rejects.toBeInstanceOf(
      DeploymentConfigError,
    );
    const c = await createDevFixtureConnector(init({ searchMode: "redmine", redmineAllWords: true }));
    expect(c.searchSpec).toContain("すべての語を含む文書だけを返す(AND)");
  });
});

describe("searchSpec の記述が模擬の実装と一致する", () => {
  it.each(CASES)("$name: 語の結合(2 語のクエリ)", async (c) => {
    const result = await connector(c.mode, c.redmineAllWords).search(ALICE, "経費 交通費");
    if (c.join === "and") {
      expect(ids(result)).toEqual(["body-both"]);
    } else {
      expect(ids(result)).toEqual(["body-a", "body-both", "code-x", "phrase", "title-a"]);
    }
  });

  it.each(CASES)("$name: 部分一致(語の一部で一致する)", async (c) => {
    expect(ids(await connector(c.mode, c.redmineAllWords).search(ALICE, "手引"))).toEqual(["title-a"]);
  });

  it.each(CASES)("$name: 空白のない質問文は一致しない(意味の検索はしない)", async (c) => {
    const result = await connector(c.mode, c.redmineAllWords).search(ALICE, "経費の締めはいつまでですか");
    expect(result.hits).toEqual([]);
  });

  it.each(CASES)("$name: 引用符の語句", async (c) => {
    const result = await connector(c.mode, c.redmineAllWords).search(ALICE, '"交通費 精算"');
    expect(ids(result)).toEqual(c.phrase ? ["phrase"] : []);
  });

  it.each(CASES)("$name: OR", async (c) => {
    const result = await connector(c.mode, c.redmineAllWords).search(ALICE, "手引き OR 議事録");
    if (c.or || c.join === "or") {
      expect(ids(result)).toEqual(["body-both", "title-a"]);
    } else {
      // OR も語として扱われ、3 語すべてを含む文書はない
      expect(ids(result)).toEqual([]);
    }
  });

  it.each(CASES)("$name: -語 は文字として照合する(除外の演算子はない)", async (c) => {
    expect((await connector(c.mode, c.redmineAllWords).search(ALICE, "-経費")).hits).toEqual([]);
  });

  it.each(CASES)("$name: title:", async (c) => {
    const result = await connector(c.mode, c.redmineAllWords).search(ALICE, "title:経費");
    expect(ids(result)).toEqual(c.title ? ["title-a"] : []);
  });

  it.each(CASES)("$name: 語数の上限", async (c) => {
    const conn = connector(c.mode, c.redmineAllWords);
    const six = await conn.search(ALICE, "経費 交通費 冒頭 段落 扱い 存在しない語");
    if (c.maxTerms === 5) {
      const five = await conn.search(ALICE, "経費 交通費 冒頭 段落 扱い");
      expect(ordered(six)).toEqual(ordered(five));
      expect(ordered(await conn.search(ALICE, "経費 交通費 冒頭 段落 扱い 手引き"))).toEqual(ordered(five));
    } else {
      expect(six.hits).toEqual([]);
    }
  });

  it.each(CASES)("$name: 並び順とタイトルの優遇", async (c) => {
    const result = await connector(c.mode, c.redmineAllWords).search(ALICE, "経費");
    const order = ordered(result).filter((id) => id !== "code-x");
    expect(order).toEqual(c.titleBoost ? ["title-a", "body-both", "body-a"] : ["body-both", "title-a", "body-a"]);
  });

  it.each(CASES)("$name: スニペットの種類", async (c) => {
    const result = await connector(c.mode, c.redmineAllWords).search(ALICE, "締め");
    const doc = hit(result, "body-a");
    const leading = doc?.snippet.startsWith("冒頭の段落。") === true && !doc.snippet.includes("締め");
    const matchContext = doc?.snippet.includes("締め") === true;
    if (c.snippet === "match_context") {
      expect(matchContext).toBe(true);
    } else {
      expect(leading).toBe(true);
    }
    if (c.snippet === "mixed") {
      const code = hit(await connector(c.mode).search(ALICE, "計算"), "code-x");
      expect(code?.snippet.includes("経費の計算")).toBe(true);
    }
  });

  it("esa 型: OR の結び付き・先頭と末尾の OR・小文字の or・title:\"語句\"・大文字小文字", async () => {
    const spec = connector("esa").searchSpec;
    expect(spec).toContain("「経費 OR 交通費 申請」は「経費または交通費」かつ「申請」");
    const c = connector("esa");
    expect(ids(await c.search(ALICE, "経費 OR 交通費 申請"))).toEqual(["title-a"]);
    expect(ids(await c.search(ALICE, "手引き OR 議事録 OR メモ"))).toEqual(["body-both", "phrase", "title-a"]);
    expect(ids(await c.search(ALICE, "OR 手引き OR"))).toEqual(["title-a"]);
    expect(ids(await c.search(ALICE, "手引き or 議事録"))).toEqual([]);
    expect(ids(await c.search(ALICE, 'title:"経費の手引"'))).toEqual(["title-a"]);
    expect(ids(await c.search(ALICE, "SRC/EXPENSE"))).toEqual(["code-x"]);
  });

  it("Redmine 型: 1 文字の語・重複は数えない、フィルタは invalid_request", async () => {
    for (const redmineAllWords of [true, false]) {
      const conn = connector("redmine", redmineAllWords);
      expect(conn.searchSpec).toContain("重複と 1 文字の語を除いた先頭 5 語だけを使い");
      expect(conn.searchSpec).toContain("filters には対応しない(指定すると invalid_request)");
      expect((await conn.search(ALICE, "経 a")).hits).toEqual([]);
      const five = await conn.search(ALICE, "経費 交通費 冒頭 段落 扱い");
      expect(ordered(await conn.search(ALICE, "経費 a 交通費 経費 冒頭 段落 扱い"))).toEqual(ordered(five));
      await expect(conn.search(ALICE, "経費", { author: "x" })).rejects.toMatchObject({ errorClass: "invalid_request" });
    }
  });

  it("GitHub 型: meta.type・フィルタを指定するとコードは検索しない", async () => {
    const c = connector("github");
    expect(c.searchSpec).toContain("ヒットの meta.type に種類(issue / pull_request / code)が入る");
    const result = await c.search(ALICE, "経費");
    expect(hit(result, "code-x")?.meta?.["type"]).toBe("code");
    expect(hit(result, "title-a")?.meta?.["type"]).toBe("issue");
    expect(hit(await c.search(ALICE, "経費", { author: "nobody" }), "code-x")).toBeUndefined();
  });

  it.each(CASES)("$name: search は通知(廃止)を返さない", async (c) => {
    const conn = connector(c.mode, c.redmineAllWords);
    for (const query of ["経費 交通費 冒頭 段落 扱い 存在しない語", "経費 in:総務", "経費"]) {
      expect(await conn.search(ALICE, query)).not.toHaveProperty("notices");
    }
  });
});
