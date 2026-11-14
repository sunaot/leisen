import { describe, expect, it } from "vitest";
import { ConnectorError, type AuthContext } from "@leisen/connector-sdk";
import { EsaConnector, createEsaConnector } from "../src/connector.js";
import { createConnector } from "../src/index.js";
import type { EsaMcpCaller, EsaReadTool } from "../src/mcp.js";
import { splitFullName, toPlainSnippet } from "../src/parse.js";

const NOW = Date.UTC(2026, 10, 14, 0, 0, 0);
const TOKEN = "dummy-esa-token-for-tests";

function auth(overrides: Partial<{ accessToken: string; expiresAt: number }> = {}): AuthContext {
  return {
    userId: "alice",
    credential: { kind: "oauth_bearer", accessToken: overrides.accessToken ?? TOKEN, expiresAt: overrides.expiresAt ?? NOW + 3_600_000 },
  };
}

interface Call {
  token: string;
  tool: EsaReadTool;
  args: Record<string, unknown>;
}

function fakeCaller(responses: Partial<Record<EsaReadTool, (args: Record<string, unknown>) => unknown>>) {
  const calls: Call[] = [];
  const caller: EsaMcpCaller = {
    async callTool(token, tool, args) {
      calls.push({ token, tool, args });
      const handler = responses[tool];
      if (handler === undefined) {
        throw new ConnectorError("source_unavailable", "no fake response");
      }
      return handler(args);
    },
  };
  return { caller, calls };
}

function post(number: number, fullName: string, body = "本文", extra: Record<string, unknown> = {}) {
  return {
    url: `https://example-team.esa.io/posts/${number}`,
    wip: "Shipped",
    category_and_title_and_tags: fullName,
    body_md: body,
    updated_at: "2026-11-01T10:00:00+09:00",
    ...extra,
  };
}

function connector(responses: Parameters<typeof fakeCaller>[0], options: Partial<ConstructorParameters<typeof EsaConnector>[0]> = {}) {
  const fake = fakeCaller(responses);
  const c = createEsaConnector({ sourceId: "esa", team: "example-team", caller: fake.caller, now: () => NOW, ...options });
  return { c, calls: fake.calls };
}

async function errorClassOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof ConnectorError ? error.errorClass : "not-a-connector-error";
  }
  return undefined;
}

describe("認可の分岐(上流を呼ぶ前に止める)", () => {
  it("トークンが空なら auth_expired で、上流を呼ばない", async () => {
    const { c, calls } = connector({ esa_search_posts: () => [] });
    expect(await errorClassOf(c.search(auth({ accessToken: "" }), "設計"))).toBe("auth_expired");
    expect(calls).toHaveLength(0);
  });

  it("期限切れは auth_expired、NaN の期限も失効扱い、0 以下は判定せず上流に委ねる", async () => {
    const { c, calls } = connector({ esa_search_posts: () => [] });
    expect(await errorClassOf(c.search(auth({ expiresAt: NOW - 1 }), "x"))).toBe("auth_expired");
    expect(await errorClassOf(c.search(auth({ expiresAt: Number.NaN }), "x"))).toBe("auth_expired");
    await c.search(auth({ expiresAt: 0 }), "x");
    expect(calls).toHaveLength(1);
  });

  it("oauth_bearer 以外の資格情報は invalid_request", async () => {
    const { c } = connector({ esa_search_posts: () => [] });
    const delegated: AuthContext = { userId: "alice", credential: { kind: "delegated_identity", principal: "alice" } };
    expect(await errorClassOf(c.search(delegated, "x"))).toBe("invalid_request");
  });

  it("本人のトークンをそのまま上流へ渡し、チームは設定のものに固定する", async () => {
    const { c, calls } = connector({ esa_search_posts: () => [] });
    await c.search(auth(), "x");
    expect(calls[0]?.token).toBe(TOKEN);
    expect(calls[0]?.args["teamName"]).toBe("example-team");
  });

  it("上流の権限外・未検出はそのまま分類を返す(存在を推定させない)", async () => {
    const { c } = connector({
      esa_get_post: () => {
        throw new ConnectorError("not_found", "esa returned not_found");
      },
    });
    expect(await errorClassOf(c.fetch(auth(), "post:999"))).toBe("not_found");
  });
});

describe("search", () => {
  it("フィルタを esa の検索修飾子にし、件数(total_count)を返さない", async () => {
    const { c, calls } = connector({
      esa_search_posts: () => [post(12, "設計/Gateway/認可の方針 #adr #auth", "---\nname: x\n---\n# 見出し\n本人の**資格情報**で呼ぶ。")],
    });
    const result = await c.search(auth(), "認可", {
      updatedAfter: "2026-10-01T00:00:00Z",
      updatedBefore: "2026-11-01",
      container: "設計 資料",
      author: "alice-dev",
    });
    expect(calls[0]?.args["query"]).toBe('認可 updated:>2026-10-01 updated:<2026-11-01 in:"設計 資料" user:alice-dev');
    expect(result).not.toHaveProperty("totalCount");
    expect(result.hits[0]).toEqual({
      documentId: "post:12",
      title: "認可の方針",
      snippet: "見出し 本人の資格情報で呼ぶ。",
      url: "https://example-team.esa.io/posts/12",
      updatedAt: "2026-11-01T10:00:00+09:00",
      meta: { category: "設計/Gateway", tags: "adr auth" },
      scope: "shared",
    });
  });

  it("修飾子に紛れ込む値(引用符・不正な screen_name・不正な日付)は invalid_request", async () => {
    const { c, calls } = connector({ esa_search_posts: () => [] });
    expect(await errorClassOf(c.search(auth(), "x", { container: 'a" OR "b' }))).toBe("invalid_request");
    expect(await errorClassOf(c.search(auth(), "x", { author: "a b" }))).toBe("invalid_request");
    expect(await errorClassOf(c.search(auth(), "x", { updatedAfter: "yesterday" }))).toBe("invalid_request");
    expect(calls).toHaveLength(0);
  });

  it("件数が上限に達したら次のカーソルを返し、カーソルの中身に識別子を入れない", async () => {
    const { c, calls } = connector({ esa_search_posts: () => [post(1, "a/b"), post(2, "a/c")] });
    const first = await c.search(auth(), "x", undefined, { limit: 2 });
    expect(first.nextCursor).toBeDefined();
    expect(Buffer.from(first.nextCursor as string, "base64url").toString()).toBe("esa1:s:2");
    await c.search(auth(), "x", undefined, { limit: 2, cursor: first.nextCursor as string });
    expect(calls[1]?.args["page"]).toBe(2);
    const last = await c.search(auth(), "x", undefined, { limit: 3 });
    expect(last.nextCursor).toBeUndefined();
  });

  it("別用途のカーソル・壊れたカーソルは invalid_request", async () => {
    const { c } = connector({ esa_search_posts: () => [] });
    const listCursor = Buffer.from("esa1:l:2").toString("base64url");
    expect(await errorClassOf(c.search(auth(), "x", undefined, { cursor: listCursor }))).toBe("invalid_request");
    expect(await errorClassOf(c.search(auth(), "x", undefined, { cursor: "!!" }))).toBe("invalid_request");
  });

  it("includeWip: false なら wip:false を足し、WIP の投稿には meta.wip を付ける", async () => {
    const { c, calls } = connector({ esa_search_posts: () => [post(3, "a/下書き", "x", { wip: "WIP" })] }, { includeWip: false });
    const result = await c.search(auth(), "x");
    expect(calls[0]?.args["query"]).toBe("x wip:false");
    expect(result.hits[0]?.meta?.["wip"]).toBe("true");
  });

  it("privateCategories のカテゴリは private に分類する(前方一致は区切り単位)", async () => {
    const { c } = connector(
      { esa_search_posts: () => [post(1, "Users/alice/メモ"), post(2, "UsersGuide/手順"), post(3, "Users")] },
      { privateCategories: ["Users"] },
    );
    const scopes = (await c.search(auth(), "x")).hits.map((h) => h.scope);
    expect(scopes).toEqual(["private", "shared", "shared"]);
  });

  it("想定外の応答の形は source_unavailable(黙って空にしない)", async () => {
    const { c } = connector({ esa_search_posts: () => ({ unexpected: true }) });
    expect(await errorClassOf(c.search(auth(), "x"))).toBe("source_unavailable");
  });
});

describe("fetch", () => {
  it("documentId の形を検査し、上流を呼ばずに拒否する", async () => {
    const { c, calls } = connector({ esa_get_post: () => post(1, "a/b") });
    for (const id of ["1", "post:", "post:1/../2", "post:abc", "slack:1"]) {
      expect(await errorClassOf(c.fetch(auth(), id))).toBe("invalid_request");
    }
    expect(calls).toHaveLength(0);
  });

  it("全文(truncate: false)を取り、長文はページに分け、private の分類を付ける", async () => {
    const body = "あ".repeat(2_500);
    const { c, calls } = connector({ esa_get_post: () => post(7, "Users/bob/日記 #memo", body) }, { pageChars: 1_000, privateCategories: ["Users"] });
    const first = await c.fetch(auth(), "post:7");
    expect(calls[0]?.args).toEqual({ teamName: "example-team", postNumber: 7, truncate: false });
    expect(first.scope).toBe("private");
    expect(first.content.startsWith("# 日記\ncategory: Users/bob\ntags: #memo")).toBe(true);
    expect([...first.content]).toHaveLength(1_000);
    const second = await c.fetch(auth(), "post:7", first.nextPageCursor);
    const third = await c.fetch(auth(), "post:7", second.nextPageCursor);
    expect(third.nextPageCursor).toBeUndefined();
    expect(await errorClassOf(c.fetch(auth(), "post:7", Buffer.from("esa1:f:9").toString("base64url")))).toBe("invalid_request");
  });

  it("別の投稿が返ったら source_unavailable", async () => {
    const { c } = connector({ esa_get_post: () => post(8, "a/b") });
    expect(await errorClassOf(c.fetch(auth(), "post:7"))).toBe("source_unavailable");
  });

  it("esa が本文を切り詰めた印を本文から外して注記する", async () => {
    const { c } = connector({ esa_get_post: () => post(9, "a/b", "前半\n\n... (truncated)") });
    const result = await c.fetch(auth(), "post:9");
    expect(result.content).toContain("(note: esa returned a truncated body)");
    expect(result.content.endsWith("前半")).toBe(true);
  });
});

describe("list / describe", () => {
  const top = {
    categories: [
      { full_name: "設計", count: 120, has_child: true },
      { full_name: "Users", count: 40, has_child: true },
      { full_name: "単発の投稿", count: 1, has_child: false },
    ],
  };

  it("最上位のカテゴリを返し、投稿数(count)を childCount に使わない", async () => {
    const { c } = connector({ esa_get_top_categories: () => top }, { privateCategories: ["Users"] });
    const result = await c.list(auth());
    expect(result.entries).toEqual([
      { id: "設計", name: "設計", kind: "folder", scope: "shared" },
      { id: "Users", name: "Users", kind: "folder", scope: "private" },
      { id: "単発の投稿", name: "単発の投稿", kind: "folder", scope: "shared" },
    ]);
  });

  it("子カテゴリはパス全体の id にする(full_name が末尾だけでもパス全体でも)", async () => {
    const { c, calls } = connector({
      esa_get_categories: () => ({ categories: [{ full_name: "設計/Gateway", has_child: false }, { full_name: "Orchestrator", has_child: true }] }),
    });
    const result = await c.list(auth(), "設計");
    expect(calls[0]?.args).toEqual({ teamName: "example-team", select: "設計", page: 1, perPage: 100 });
    expect(result.entries.map((e) => [e.id, e.name])).toEqual([
      ["設計/Gateway", "Gateway"],
      ["設計/Orchestrator", "Orchestrator"],
    ]);
  });

  it("describe は子を持つ最上位カテゴリを区画とし、対応フィルタを示す", async () => {
    const { c } = connector({ esa_get_top_categories: () => top }, { displayName: "社内 esa" });
    const description = await c.describe(auth());
    expect(description.displayName).toBe("社内 esa");
    expect(description.topContainers.map((e) => e.id)).toEqual(["設計", "Users"]);
    expect(description.supportedFilters).toEqual(["updatedAfter", "updatedBefore", "container", "author"]);
    expect(JSON.stringify(description)).not.toContain("120");
  });
});

describe("parse の補助", () => {
  it("カテゴリ・名前・タグを分ける", () => {
    expect(splitFullName("a/b/タイトル #t1 #t2")).toEqual({ category: "a/b", name: "タイトル", tags: ["t1", "t2"] });
    expect(splitFullName("README")).toEqual({ category: "", name: "README", tags: [] });
    expect(splitFullName("a/C# 入門")).toEqual({ category: "a", name: "C# 入門", tags: [] });
  });

  it("スニペットは長さの上限を守る", () => {
    expect([...toPlainSnippet("い".repeat(900), 300)]).toHaveLength(300);
  });
});

describe("factory(プラグイン契約)", () => {
  it("team は必須で、未知のキー・型違いは受領値をエコーせずに拒否する", () => {
    expect(() => createConnector({ sourceId: "esa", settings: {} })).toThrow(/team is required/);
    expect(() => createConnector({ sourceId: "esa", settings: { team: "t", accessToken: "leaked-value" } })).toThrow(/unknown setting accessToken/);
    try {
      createConnector({ sourceId: "esa", settings: { team: "t", accessToken: "leaked-value" } });
    } catch (error) {
      expect(String(error)).not.toContain("leaked-value");
    }
    expect(() => createConnector({ sourceId: "esa", settings: { team: "Bad Team" } })).toThrow(ConnectorError);
    expect(() => createConnector({ sourceId: "esa", settings: { team: "t", mcpUrl: "http://mcp.esa.io/" } })).toThrow(ConnectorError);
  });

  it("本番では mcpUrl を mcp.esa.io 以外にできない(トークンの送り先の固定)", () => {
    const caller = fakeCaller({}).caller;
    expect(() => new EsaConnector({ sourceId: "esa", team: "t", mcpUrl: "https://evil.example/", production: true, caller })).toThrow(/mcp\.esa\.io in production/);
    expect(() => new EsaConnector({ sourceId: "esa", team: "t", mcpUrl: "http://127.0.0.1:9/", production: true, caller })).toThrow(RangeError);
    expect(new EsaConnector({ sourceId: "esa", team: "t", mcpUrl: "https://mcp.esa.io/v2", production: true, caller }).sourceId).toBe("esa");
    expect(new EsaConnector({ sourceId: "esa", team: "t", production: true, caller }).sourceId).toBe("esa");
    expect(new EsaConnector({ sourceId: "esa", team: "t", mcpUrl: "http://127.0.0.1:9/", production: false, caller }).sourceId).toBe("esa");
  });

  it("有効な設定で sourceId を引き継ぎ、classified を宣言する", () => {
    const c = createConnector({ sourceId: "wiki", settings: { team: "example-team", privateCategories: ["Users"], includeWip: false } });
    expect(c.sourceId).toBe("wiki");
    expect(c.capabilities).toEqual({ nativeSearch: "full", ingest: false, privateScopeHandling: "classified" });
  });
});
