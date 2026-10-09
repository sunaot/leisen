/**
 * 開発用コネクタ(kind: dev-fixture)のテスト。
 * - 認可分岐: 本人のベアラー資格情報がない・失効・種類違いは拒否
 * - search: 全語AND・大文字小文字無視・filters・limit/cursor・snippet長・totalCountなし
 * - fetch のページング、list / describe
 * - settings(corpusFile の相対パスは設定ファイルの所在ディレクトリ基準)と本番拒否
 * 秘密情報の実値は使わない(不変条件6)。
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectorError,
  MAX_SNIPPET_CHARS,
  type AuthContext,
  type Connector,
} from "@kp/connector-sdk";
import {
  DEV_FIXTURE_SAMPLE_DOCUMENTS,
  DeploymentConfigError,
  DevFixtureConnector,
  IdpError,
  createDevFixtureConnector,
  type DevFixtureDocument,
} from "../src/index.js";

const EXAMPLES_DIR = fileURLToPath(new URL("../../../examples/", import.meta.url));

function bearer(overrides: { accessToken?: string; expiresAt?: number } = {}): AuthContext {
  return {
    userId: "alice",
    credential: {
      kind: "oauth_bearer",
      accessToken: overrides.accessToken ?? "dev-only-token",
      expiresAt: overrides.expiresAt ?? Date.now() + 60 * 60 * 1000,
    },
  };
}
const AUTH = bearer();
const EXCLUDED = { privateScopes: "excluded" } as const;

const DOCS: DevFixtureDocument[] = [
  {
    id: "vpn",
    title: "VPN接続手順",
    content: "社外から社内システムを使うときは VPN に接続する。接続できない場合はヘルプデスクへ。",
    url: "https://intranet.example.test/vpn",
    container: "it",
    author: "it-team",
    updatedAt: "2026-05-01T00:00:00Z",
  },
  {
    id: "expense",
    title: "Expense Rules",
    content: "Submit expense reports by the 10th of the following month.",
    url: "https://intranet.example.test/expense",
    container: "admin",
    author: "admin-team",
    updatedAt: "2026-03-01T00:00:00Z",
  },
  {
    id: "onboarding",
    title: "Onboarding",
    content: "Welcome aboard. Set up your vpn client and accounts on day one.",
    url: "https://intranet.example.test/onboarding",
    container: "hr",
    author: "hr-team",
    updatedAt: "2026-04-01T00:00:00Z",
  },
  {
    id: "undated",
    title: "Undated note",
    content: "A VPN note without an update timestamp.",
    url: "https://intranet.example.test/undated",
    container: "it",
  },
];

function connector(
  documents: readonly DevFixtureDocument[] = DOCS,
  options: ConstructorParameters<typeof DevFixtureConnector>[2] = {},
): DevFixtureConnector {
  return new DevFixtureConnector("dev-docs", documents, options);
}

async function connectorError(promise: Promise<unknown>): Promise<ConnectorError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ConnectorError);
  return error as ConnectorError;
}

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kp-dev-fixture-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("認可分岐: 本人のベアラー資格情報を要求する", () => {
  const calls: [string, (c: Connector, auth: AuthContext) => Promise<unknown>][] = [
    ["search", (c, auth) => c.search(auth, "VPN")],
    ["fetch", (c, auth) => c.fetch(auth, "vpn")],
    ["list", (c, auth) => c.list(auth)],
    ["describe", (c, auth) => c.describe(auth)],
  ];

  it.each(calls)("%s: 失効した資格情報は auth_expired", async (_name, call) => {
    const error = await connectorError(call(connector(), bearer({ expiresAt: Date.now() - 1 })));
    expect(error.errorClass).toBe("auth_expired");
  });

  it.each(calls)("%s: 空のトークンは auth_expired", async (_name, call) => {
    const error = await connectorError(call(connector(), bearer({ accessToken: "" })));
    expect(error.errorClass).toBe("auth_expired");
  });

  it.each(calls)("%s: ベアラー以外の資格情報は permission_denied", async (_name, call) => {
    const delegated: AuthContext = {
      userId: "alice",
      credential: { kind: "delegated_identity", principal: "alice@example.test" },
    };
    const error = await connectorError(call(connector(), delegated));
    expect(error.errorClass).toBe("permission_denied");
  });

  it("エラーメッセージにトークンの値を含めない(不変条件6)", async () => {
    const error = await connectorError(
      connector().search(bearer({ accessToken: "dev-only-secret-token", expiresAt: 0 }), "VPN"),
    );
    expect(error.message).not.toContain("dev-only-secret-token");
  });
});

describe("search", () => {
  it("空白区切りの全語AND(title / content の部分一致)", async () => {
    const result = await connector().search(AUTH, "VPN 接続");
    expect(result.hits.map((h) => h.documentId)).toEqual(["vpn"]);
  });

  it("大文字小文字を区別しない", async () => {
    const result = await connector().search(AUTH, "vpn");
    expect(result.hits.map((h) => h.documentId).sort()).toEqual(
      ["onboarding", "undated", "vpn"].sort(),
    );
    const upper = await connector().search(AUTH, "EXPENSE rules");
    expect(upper.hits.map((h) => h.documentId)).toEqual(["expense"]);
  });

  it("全角空白でも語を区切る", async () => {
    const result = await connector().search(AUTH, "VPN　接続");
    expect(result.hits.map((h) => h.documentId)).toEqual(["vpn"]);
  });

  it("タイトルに一致する文書を先に、次に更新の新しい順に並べる", async () => {
    const result = await connector().search(AUTH, "vpn");
    // title に一致: vpn / 本文のみ: onboarding(2026-04) → undated(日付なし)
    expect(result.hits.map((h) => h.documentId)).toEqual(["vpn", "onboarding", "undated"]);
  });

  it("正規表現の特殊文字をそのまま文字として扱う", async () => {
    await expect(connector().search(AUTH, "(")).resolves.toEqual({ hits: [] });
    await expect(connector().search(AUTH, ".*")).resolves.toEqual({ hits: [] });
  });

  it("空白だけのクエリは invalid_request", async () => {
    const error = await connectorError(connector().search(AUTH, " 　 "));
    expect(error.errorClass).toBe("invalid_request");
  });

  it("filters.container / author を尊重する", async () => {
    const byContainer = await connector().search(AUTH, "vpn", { container: "it" });
    expect(byContainer.hits.map((h) => h.documentId).sort()).toEqual(["undated", "vpn"]);
    const byAuthor = await connector().search(AUTH, "vpn", { author: "hr-team" });
    expect(byAuthor.hits.map((h) => h.documentId)).toEqual(["onboarding"]);
  });

  it("filters.updatedAfter / updatedBefore は両端を含み、更新日時のない文書を除く", async () => {
    const after = await connector().search(AUTH, "vpn", {
      updatedAfter: "2026-04-01T00:00:00Z",
    });
    expect(after.hits.map((h) => h.documentId)).toEqual(["vpn", "onboarding"]);
    const before = await connector().search(AUTH, "vpn", {
      updatedBefore: "2026-04-01T00:00:00Z",
    });
    expect(before.hits.map((h) => h.documentId)).toEqual(["onboarding"]);
    const between = await connector().search(AUTH, "e", {
      updatedAfter: "2026-02-01T00:00:00Z",
      updatedBefore: "2026-03-31T00:00:00Z",
    });
    expect(between.hits.map((h) => h.documentId)).toEqual(["expense"]);
  });

  it("不正な日時の filter は invalid_request", async () => {
    const error = await connectorError(
      connector().search(AUTH, "vpn", { updatedAfter: "yesterday" }),
    );
    expect(error.errorClass).toBe("invalid_request");
  });

  it("limit / cursor でページングし、続きがなければ nextCursor を返さない", async () => {
    const c = connector();
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await c.search(AUTH, "vpn", undefined, {
        limit: 2,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      expect(page.hits.length).toBeLessThanOrEqual(2);
      seen.push(...page.hits.map((h) => h.documentId));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined);
    expect(pages).toBe(2);
    expect(seen).toEqual(["vpn", "onboarding", "undated"]);
  });

  it("不正なカーソル・他の操作のカーソルは invalid_request", async () => {
    const c = connector([{ id: "long", title: "long", content: "x".repeat(30), url: "u" }], {
      pageChars: 10,
    });
    const fetchCursor = (await c.fetch(AUTH, "long")).nextPageCursor;
    expect(fetchCursor).toBeDefined();
    for (const cursor of ["not-a-cursor", fetchCursor as string]) {
      const error = await connectorError(c.search(AUTH, "x", undefined, { cursor }));
      expect(error.errorClass).toBe("invalid_request");
    }
  });

  it("snippet は一致箇所の周辺を MAX_SNIPPET_CHARS 以内で切り出す", async () => {
    const long: DevFixtureDocument = {
      id: "long",
      title: "Long document",
      content: `${"前置き。".repeat(300)}ここに目印のキーワードがある。${"後書き。".repeat(300)}`,
      url: "https://intranet.example.test/long",
    };
    const [hit] = (await connector([long]).search(AUTH, "目印")).hits;
    expect(hit).toBeDefined();
    expect(hit?.snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS);
    expect(hit?.snippet).toContain("目印");
    expect(hit?.snippet.startsWith("…")).toBe(true);
    expect(hit?.snippet.endsWith("…")).toBe(true);
    // 本文全体は返さない(ADR-016)
    expect(hit?.snippet.length).toBeLessThan(long.content.length);
  });

  it("タイトルのみの一致では本文の先頭を snippet にする", async () => {
    const [hit] = (await connector().search(AUTH, "Onboarding")).hits;
    expect(hit?.snippet.startsWith("Welcome aboard.")).toBe(true);
  });

  it("SearchResult に総件数(totalCount 等)を含めない(ADR-012/016)", async () => {
    const result = await connector().search(AUTH, "vpn", undefined, { limit: 1 });
    expect(Object.keys(result).sort()).toEqual(["hits", "nextCursor"]);
    const last = await connector().search(AUTH, "expense");
    expect(Object.keys(last)).toEqual(["hits"]);
  });

  it("ヒットに区画・作成者・更新日時のメタ情報を付ける", async () => {
    const [hit] = (await connector().search(AUTH, "expense")).hits;
    expect(hit).toEqual({
      documentId: "expense",
      title: "Expense Rules",
      snippet: "Submit expense reports by the 10th of the following month.",
      url: "https://intranet.example.test/expense",
      updatedAt: "2026-03-01T00:00:00Z",
      meta: { container: "admin", author: "admin-team" },
      scope: "shared",
    });
  });
});

describe("fetch", () => {
  it("本文を pageChars ごとにページングし、連結すると本文全体になる", async () => {
    const content = "0123456789".repeat(3) + "end";
    const c = connector([{ id: "doc", title: "Doc", content, url: "u" }], { pageChars: 10 });
    const pages: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.fetch(AUTH, "doc", cursor);
      expect(page.documentId).toBe("doc");
      expect(page.content.length).toBeLessThanOrEqual(10);
      pages.push(page.content);
      cursor = page.nextPageCursor;
    } while (cursor !== undefined);
    expect(pages).toHaveLength(4);
    expect(pages.join("")).toBe(content);
  });

  it("サロゲートペア(絵文字)をページ境界で分断しない", async () => {
    const content = "a😀b😀c😀d";
    const c = connector([{ id: "emoji", title: "Emoji", content, url: "u" }], { pageChars: 2 });
    const pages: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.fetch(AUTH, "emoji", cursor);
      expect(page.content.isWellFormed()).toBe(true);
      pages.push(page.content);
      cursor = page.nextPageCursor;
    } while (cursor !== undefined);
    expect(pages.join("")).toBe(content);
  });

  it("短い本文・空の本文は1ページで nextPageCursor を返さない", async () => {
    const c = connector([
      { id: "short", title: "Short", content: "short", url: "u1" },
      { id: "empty", title: "Empty", content: "", url: "u2" },
    ]);
    expect(await c.fetch(AUTH, "short")).toEqual({
      documentId: "short",
      title: "Short",
      content: "short",
      url: "u1",
      scope: "shared",
    });
    expect((await c.fetch(AUTH, "empty")).content).toBe("");
  });

  it("存在しない文書は not_found(documentId をエコーしない)", async () => {
    const error = await connectorError(connector().fetch(AUTH, "no-such-doc"));
    expect(error.errorClass).toBe("not_found");
    expect(error.message).not.toContain("no-such-doc");
  });
});

describe("list / describe", () => {
  it("list は区画の一覧と文書数を返す", async () => {
    const result = await connector().list(AUTH);
    expect(result).toEqual({
      entries: [
        { id: "it", name: "it", kind: "folder", childCount: 2, scope: "shared" },
        { id: "admin", name: "admin", kind: "folder", childCount: 1, scope: "shared" },
        { id: "hr", name: "hr", kind: "folder", childCount: 1, scope: "shared" },
      ],
    });
  });

  it("list(containerId) は入れ子がないため空。未知の区画は not_found", async () => {
    expect(await connector().list(AUTH, "it")).toEqual({ entries: [] });
    const error = await connectorError(connector().list(AUTH, "no-such-container"));
    expect(error.errorClass).toBe("not_found");
  });

  it("list は区画が多い場合にページングする", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `doc-${i}`,
      title: `Doc ${i}`,
      content: "c",
      url: `u${i}`,
      container: `box-${String(i).padStart(2, "0")}`,
    }));
    const c = connector(many);
    const first = await c.list(AUTH);
    expect(first.entries).toHaveLength(50);
    expect(first.nextCursor).toBeDefined();
    const second = await c.list(AUTH, undefined, first.nextCursor);
    expect(second.entries).toHaveLength(10);
    expect(second.nextCursor).toBeUndefined();
  });

  it("describe は概要・主要区画・対応フィルタを返す", async () => {
    const description = await connector(DOCS, { summary: "テスト用コーパス" }).describe(AUTH);
    expect(description).toEqual({
      sourceId: "dev-docs",
      displayName: "開発用フィクスチャ(dev-docs)",
      summary: "テスト用コーパス",
      topContainers: [
        { id: "it", name: "it", kind: "folder", childCount: 2, scope: "shared" },
        { id: "admin", name: "admin", kind: "folder", childCount: 1, scope: "shared" },
        { id: "hr", name: "hr", kind: "folder", childCount: 1, scope: "shared" },
      ],
      supportedFilters: ["updatedAfter", "updatedBefore", "container", "author"],
    });
  });

  it("静的能力はネイティブ検索あり・ingestなし・プライベート領域は enforced", () => {
    expect(connector().capabilities).toEqual({
      nativeSearch: "full",
      ingest: false,
      privateScopeHandling: "enforced",
    });
  });
});

describe("createDevFixtureConnector(settings)", () => {
  async function settingsIssues(
    settings: Record<string, unknown>,
    configDir = EXAMPLES_DIR,
  ): Promise<DeploymentConfigError> {
    const error = await createDevFixtureConnector({
      sourceId: "dev-docs",
      settings,
      configDir,
      policy: EXCLUDED,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DeploymentConfigError);
    return error as DeploymentConfigError;
  }

  it("corpusFile の相対パスは設定ファイルの所在ディレクトリ(configDir)基準で解決する", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "fixtures"));
    await writeFile(
      join(dir, "fixtures", "corpus.yaml"),
      "documents:\n  - id: only\n    title: Only doc\n    content: relative path works\n    url: https://intranet.example.test/only\n",
    );
    // カレントディレクトリ(テスト実行時は packages/gateway)には依存しない
    expect(process.cwd()).not.toBe(dir);
    const c = await createDevFixtureConnector({
      sourceId: "dev-docs",
      settings: { corpusFile: "fixtures/corpus.yaml" },
      configDir: dir,
      policy: EXCLUDED,
    });
    const result = await c.search(AUTH, "relative");
    expect(result.hits.map((h) => h.documentId)).toEqual(["only"]);
  });

  it("絶対パス・JSON形式のコーパスも読める", async () => {
    const dir = await tempDir();
    const file = join(dir, "corpus.json");
    await writeFile(
      file,
      JSON.stringify({
        documents: [{ id: "j", title: "JSON doc", content: "from json", url: "u" }],
      }),
    );
    const c = await createDevFixtureConnector({
      sourceId: "dev-docs",
      settings: { corpusFile: file },
      configDir: "/nonexistent-config-dir",
      policy: EXCLUDED,
    });
    expect((await c.search(AUTH, "json")).hits).toHaveLength(1);
  });

  it("同梱の examples/fixtures/dev-corpus.yaml を読める", async () => {
    const c = await createDevFixtureConnector({
      sourceId: "dev-docs",
      settings: { corpusFile: "fixtures/dev-corpus.yaml" },
      configDir: EXAMPLES_DIR,
      policy: EXCLUDED,
    });
    const result = await c.search(AUTH, "経費 精算");
    expect(result.hits[0]?.documentId).toBe("expense-rules");
    expect((await c.list(AUTH)).entries.length).toBeGreaterThanOrEqual(3);
  });

  it("settings.documents を直接書ける。pageChars / displayName / summary を反映する", async () => {
    const c = await createDevFixtureConnector({
      sourceId: "inline",
      settings: {
        documents: [{ id: "i", title: "Inline", content: "abcdef", url: "u" }],
        pageChars: 4,
        displayName: "インライン",
        summary: "直接書いたコーパス",
      },
      configDir: EXAMPLES_DIR,
      policy: EXCLUDED,
    });
    expect((await c.fetch(AUTH, "i")).content).toBe("abcd");
    expect(await c.describe(AUTH)).toMatchObject({
      sourceId: "inline",
      displayName: "インライン",
      summary: "直接書いたコーパス",
    });
  });

  it("corpusFile も documents もなければ組み込みサンプルを使う", async () => {
    const c = await createDevFixtureConnector({
      sourceId: "dev-docs",
      settings: {},
      configDir: EXAMPLES_DIR,
      policy: EXCLUDED,
    });
    const description = await c.describe(AUTH);
    expect(description.summary).toContain(`${DEV_FIXTURE_SAMPLE_DOCUMENTS.length}件`);
    expect(DEV_FIXTURE_SAMPLE_DOCUMENTS.length).toBeGreaterThanOrEqual(3);
    expect((await c.search(AUTH, "VPN")).hits.length).toBeGreaterThan(0);
  });

  it("存在しない corpusFile は connector_settings_invalid(settings.corpusFile)", async () => {
    const error = await settingsIssues({ corpusFile: "no-such-corpus.yaml" });
    expect(error.issues).toEqual([
      expect.objectContaining({
        code: "connector_settings_invalid",
        path: "settings.corpusFile",
        message: expect.stringContaining("ENOENT"),
      }),
    ]);
  });

  it("コーパス内の不正な文書は位置付きで拒否する", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "bad.yaml"), "documents:\n  - id: x\n    title: X\n    content: c\n");
    const error = await settingsIssues({ corpusFile: "bad.yaml" }, dir);
    expect(error.issues[0]).toMatchObject({
      code: "connector_settings_invalid",
      path: "settings.corpusFile.documents.0.url",
    });
  });

  it("不正なYAMLのコーパスを拒否する", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "broken.yaml"), "documents: [unclosed\n");
    const error = await settingsIssues({ corpusFile: "broken.yaml" }, dir);
    expect(error.issues[0]?.message).toContain("not valid YAML/JSON");
  });

  it.each([
    ["未知のキー", { corpus: "x.yaml" }, "settings"],
    ["corpusFile と documents の併用", {
      corpusFile: "x.yaml",
      documents: [{ id: "a", title: "A", content: "", url: "u" }],
    }, "settings.documents"],
    ["pageChars が0", { pageChars: 0 }, "settings.pageChars"],
    ["文書IDの重複", {
      documents: [
        { id: "dup", title: "A", content: "", url: "u1" },
        { id: "dup", title: "B", content: "", url: "u2" },
      ],
    }, "settings.documents.1.id"],
    ["updatedAt が日時でない", {
      documents: [{ id: "a", title: "A", content: "", url: "u", updatedAt: "last week" }],
    }, "settings.documents.0.updatedAt"],
  ])("不正な settings を拒否する: %s", async (_label, settings, path) => {
    const error = await settingsIssues(settings);
    expect(error.issues.map((i) => i.code)).toContain("connector_settings_invalid");
    expect(error.issues.map((i) => i.path)).toContain(path);
  });
});

describe("本番(NODE_ENV=production)では構築を拒否する", () => {
  it("factory も コンストラクタも拒否する", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(
      createDevFixtureConnector({ sourceId: "dev-docs", settings: {}, configDir: EXAMPLES_DIR, policy: EXCLUDED }),
    ).rejects.toThrow(IdpError);
    expect(() => new DevFixtureConnector("dev-docs", DOCS)).toThrow(/disabled in production/);
  });
});

describe("プライベート領域(enforced、ADR-016 追補2 決定7)", () => {
  // 合成データのみ(private は DM・個人スコープに相当する文書の代役)
  const MIXED: readonly DevFixtureDocument[] = [
    { id: "shared-memo", title: "Team memo", content: "release plan", url: "u1", container: "team" },
    { id: "dm-memo", title: "Direct memo", content: "release plan draft", url: "u2", container: "dm", scope: "private" },
    { id: "personal-note", title: "Personal note", content: "release notes", url: "u3", container: "team", scope: "private" },
  ];

  it("excluded(既定): private の文書は search に現れず、全ヒットは scope: shared", async () => {
    for (const c of [connector(MIXED), connector(MIXED, { policy: EXCLUDED })]) {
      const { hits } = await c.search(AUTH, "release");
      expect(hits.map((h) => [h.documentId, h.scope])).toEqual([["shared-memo", "shared"]]);
    }
  });

  it("excluded: private の文書の fetch は private_scope_excluded(not_found と区別する)", async () => {
    const error = await connectorError(connector(MIXED).fetch(AUTH, "dm-memo"));
    expect(error.errorClass).toBe("private_scope_excluded");
    expect(error.message).not.toContain("dm-memo");
    const missing = await connectorError(connector(MIXED).fetch(AUTH, "no-such-doc"));
    expect(missing.errorClass).toBe("not_found");
  });

  it("excluded: list / describe は private の文書だけの区画を出さず、文書数も private を数えない", async () => {
    const c = connector(MIXED);
    expect((await c.list(AUTH)).entries).toEqual([
      { id: "team", name: "team", kind: "folder", childCount: 1, scope: "shared" },
    ]);
    expect((await c.describe(AUTH)).topContainers).toEqual([
      { id: "team", name: "team", kind: "folder", childCount: 1, scope: "shared" },
    ]);
    const error = await connectorError(c.list(AUTH, "dm"));
    expect(error.errorClass).toBe("not_found");
    // 既定の要約の件数も対象の文書だけを数える
    expect((await c.describe(AUTH)).summary).toContain("1件");
  });

  it("included: private の文書も返し、scope で分類する(区画は中身がすべて private なら private)", async () => {
    const c = connector(MIXED, { policy: { privateScopes: "included" } });
    const { hits } = await c.search(AUTH, "release");
    expect(Object.fromEntries(hits.map((h) => [h.documentId, h.scope]))).toEqual({
      "shared-memo": "shared",
      "dm-memo": "private",
      "personal-note": "private",
    });
    expect((await c.fetch(AUTH, "dm-memo")).scope).toBe("private");
    expect((await c.list(AUTH)).entries.map((e) => [e.id, e.scope])).toEqual([
      ["team", "shared"],
      ["dm", "private"],
    ]);
  });

  it("factory は init.policy を渡す(included で private の文書が見える)", async () => {
    const c = await createDevFixtureConnector({
      sourceId: "dev-docs",
      settings: { documents: MIXED },
      configDir: EXAMPLES_DIR,
      policy: { privateScopes: "included" },
    });
    expect((await c.search(AUTH, "draft")).hits.map((h) => h.documentId)).toEqual(["dm-memo"]);
    const excluded = await createDevFixtureConnector({
      sourceId: "dev-docs",
      settings: { documents: MIXED },
      configDir: EXAMPLES_DIR,
      policy: EXCLUDED,
    });
    expect((await excluded.search(AUTH, "draft")).hits).toEqual([]);
  });

  it("コーパスの scope は private / shared 以外を拒否する", async () => {
    const error = await createDevFixtureConnector({
      sourceId: "dev-docs",
      settings: { documents: [{ id: "x", title: "X", content: "c", url: "u", scope: "secret" }] },
      configDir: EXAMPLES_DIR,
      policy: EXCLUDED,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DeploymentConfigError);
  });
});
