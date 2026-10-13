/**
 * プライベート領域の分類(ADR-016 追補2 決定7、README「プライベート領域」)。
 * - privateScopeHandling は "classified": ソース側では除外せず、全結果に scope を付ける
 * - 組織のリポジトリ(private / internal を含む)は shared
 * - 所有者が個人アカウント(owner.type: User)で公開と確認できないもの(コード検索の
 *   ヒット、list の repo)は private
 * - issue / PR の検索結果と fetch の応答は所有者の種別を含まないため shared
 *   (GitHub App を組織にだけインストールする前提)
 * - factory は方針(policy)を受け取るが、動作を変えない(除外は Gateway が行う)
 */
import { describe, expect, it } from "vitest";
import { scopeOfRepository } from "../src/connector.js";
import { createConnector } from "../src/index.js";
import {
  ALICE,
  COMMIT_SHA,
  codeItem,
  fileContentResponse,
  issueItem,
  jsonResponse,
  searchResponse,
  setup,
} from "./helpers/fake-github.js";

describe("scopeOfRepository(所有者の種別による分類)", () => {
  it.each([
    ["組織の非公開リポジトリ", { owner: { login: "acme", type: "Organization" }, private: true }, "shared"],
    ["組織の internal リポジトリ", { owner: { login: "acme", type: "Organization" }, visibility: "internal" }, "shared"],
    ["個人の公開リポジトリ(private: false)", { owner: { login: "alice", type: "User" }, private: false }, "shared"],
    ["個人の公開リポジトリ(visibility: public)", { owner: { login: "alice", type: "User" }, visibility: "public" }, "shared"],
    ["個人の非公開リポジトリ", { owner: { login: "alice", type: "User" }, private: true }, "private"],
    ["個人で公開か不明(迷うものは private)", { owner: { login: "alice", type: "User" } }, "private"],
    ["所有者の種別なし(組織にだけインストールする前提)", { owner: { login: "acme" }, private: true }, "shared"],
    ["repository なし", undefined, "shared"],
  ] as const)("%s → %s", (_label, repository, expected) => {
    expect(scopeOfRepository(repository)).toBe(expected);
  });
});

describe("結果ごとの scope(classified)", () => {
  it("コード検索: 個人アカウントの非公開リポジトリのヒットは private、組織・個人の公開は shared", async () => {
    const { github, connector } = setup();
    github
      .on(/^\/search\/issues$/, () => searchResponse([]))
      .on(/^\/search\/code$/, () =>
        searchResponse([
          codeItem({ owner: "acme", path: "a.ts", ownerType: "Organization" }),
          codeItem({ owner: "alice", repo: "dotfiles", path: "b.ts", ownerType: "User" }),
          codeItem({ owner: "alice", repo: "public-tool", path: "c.ts", ownerType: "User", isPrivate: false }),
        ]),
      );
    const { hits } = await connector.search(ALICE, "login");
    expect(hits.map((hit) => [hit.title, hit.scope])).toEqual([
      ["a.ts", "shared"],
      ["b.ts", "private"],
      ["c.ts", "shared"],
    ]);
  });

  it("issue / PR の検索結果は所有者の種別を含まないため shared(前提: app は組織にだけインストール)", async () => {
    const { github, connector } = setup({ searchCode: false });
    github.on(/^\/search\/issues$/, () =>
      searchResponse([issueItem({ owner: "alice", repo: "notes", number: 3 })]),
    );
    const { hits } = await connector.search(ALICE, "memo");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.scope === "shared")).toBe(true);
  });

  it("issue の検索結果が repository(所有者の種別)を含む場合は判定する", async () => {
    const { github, connector } = setup({ searchCode: false });
    github.on(/^\/search\/issues$/, (req) =>
      req.url.searchParams.get("q")?.includes("is:issue") === true
        ? searchResponse([
            {
              ...issueItem({ owner: "alice", repo: "notes", number: 3 }),
              repository: { owner: { login: "alice", type: "User" }, private: true },
            },
          ])
        : searchResponse([]),
    );
    const { hits } = await connector.search(ALICE, "memo");
    expect(hits.map((hit) => hit.scope)).toEqual(["private"]);
  });

  it("fetch(issue / file)は shared", async () => {
    const { github, connector } = setup({ maxComments: 0 });
    github
      .onJson(/^\/repos\/acme\/app\/issues\/7$/, issueItem({ number: 7 }))
      .onJson(/^\/repos\/acme\/app\/contents\//, fileContentResponse("README.md", "hello"));
    expect((await connector.fetch(ALICE, "issue:acme/app#7")).scope).toBe("shared");
    expect(
      (await connector.fetch(ALICE, `file:acme/app@${COMMIT_SHA}:README.md`)).scope,
    ).toBe("shared");
  });

  it("list: 組織は shared、個人アカウントの非公開リポジトリは private", async () => {
    const { github, connector } = setup();
    github
      .onJson(/^\/user\/orgs$/, [{ login: "acme" }])
      .on(/^\/user\/repos$/, () =>
        jsonResponse([
          { full_name: "acme/app", owner: { login: "acme", type: "Organization" }, private: true },
          { full_name: "alice/dotfiles", owner: { login: "alice", type: "User" }, private: true },
          { full_name: "alice/blog", owner: { login: "alice", type: "User" }, private: false },
        ]),
      );
    const { entries } = await connector.list(ALICE);
    expect(entries.map((entry) => [entry.id, entry.scope])).toEqual([
      ["acme", "shared"],
      ["acme/app", "shared"],
      ["alice/dotfiles", "private"],
      ["alice/blog", "shared"],
    ]);
  });
});

describe("factory と方針", () => {
  it.each(["excluded", "included"] as const)(
    "policy.privateScopes: %s を受け取り、classified を宣言する(ソース側で除外しない)",
    (privateScopes) => {
      const connector = createConnector({
        sourceId: "github",
        settings: {},
        configDir: "/etc/leisen",
        policy: { privateScopes },
      });
      expect(connector.capabilities.privateScopeHandling).toBe("classified");
    },
  );
});
