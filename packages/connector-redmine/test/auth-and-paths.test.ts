/**
 * 認可分岐・失効時刻・応答の分類・パスの検査(ADR-024)。
 * キーはダミー値だけを使う(不変条件6)。
 */
import { describe, expect, it, vi } from "vitest";
import { ConnectorError, type AuthContext, type Credential } from "@leisen/connector-sdk";
import { RedmineConnector } from "../src/redmine.js";

const baseUrl = "https://redmine.example.invalid/redmine/";
const KEY = "test-key-alice";

function auth(credential: Credential): AuthContext {
  return { userId: "alice", credential };
}

function apiKey(expiresAt = 0): AuthContext {
  return auth({ kind: "api_key", apiKey: KEY, expiresAt });
}

function connectorReturning(response: () => Response) {
  const fetchImpl = vi.fn<typeof fetch>(async () => response());
  return { connector: new RedmineConnector({ sourceId: "redmine", baseUrl, fetchImpl }), fetchImpl };
}

const emptySearch = () => Response.json({ results: [], total_count: 0 });

describe("資格情報の検査", () => {
  it("api_key 以外の kind は通信の前に拒否する", async () => {
    const { connector, fetchImpl } = connectorReturning(emptySearch);
    await expect(
      connector.search(auth({ kind: "oauth_bearer", accessToken: "test-bearer-alice", expiresAt: 0 }), "q"),
    ).rejects.toMatchObject({ errorClass: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "有限でない失効時刻(%s)は auth_expired",
    async (expiresAt) => {
      const { connector, fetchImpl } = connectorReturning(emptySearch);
      await expect(connector.search(apiKey(expiresAt), "q")).rejects.toMatchObject({ errorClass: "auth_expired" });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["未来の失効時刻", Date.now() + 60_000],
    ["失効時刻不明(0)", 0],
    ["失効時刻不明(負)", -1],
  ])("%s は通す", async (_label, expiresAt) => {
    const { connector, fetchImpl } = connectorReturning(emptySearch);
    await expect(connector.search(apiKey(expiresAt), "q")).resolves.toEqual({ hits: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("Redmine の応答の分類", () => {
  it.each([
    [302, "source_unavailable"],
    [401, "auth_expired"],
    [403, "permission_denied"],
    [404, "not_found"],
    [429, "rate_limited"],
    [500, "source_unavailable"],
  ])("HTTP %i は %s(キーをエラーに含めない)", async (status, errorClass) => {
    const { connector } = connectorReturning(
      () => new Response(null, { status, headers: status === 302 ? { location: "https://evil.example/" } : {} }),
    );
    const error = await connector.fetch(apiKey(), "issue:42").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error).toMatchObject({ errorClass });
    expect(String((error as Error).message)).not.toContain(KEY);
    expect(JSON.stringify(error)).not.toContain(KEY);
  });

  it("リダイレクトを追従しない設定で呼ぶ", async () => {
    const { connector, fetchImpl } = connectorReturning(emptySearch);
    await connector.search(apiKey(), "q");
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });
});

describe("documentId とパスの検査", () => {
  it.each([
    "wiki:../T",
    "wiki:%2E%2E/T",
    "wiki:./T",
    "wiki:proj/..",
    "wiki:proj/a/../b",
    "issue:abc",
    "issue-note:0:1",
    "other:1",
  ])("不正な documentId(%s)は通信の前に invalid_request", async (documentId) => {
    const { connector, fetchImpl } = connectorReturning(emptySearch);
    await expect(connector.fetch(apiKey(), documentId)).rejects.toMatchObject({ errorClass: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("Wiki の検索ヒットで project が .. のものは返さない", async () => {
    const { connector } = connectorReturning(() =>
      Response.json({
        results: [
          { id: 1, type: "wiki-page", title: "x", url: `${baseUrl}projects/../wiki/T`.replace("/../", "/%2E%2E/") },
          { id: 2, type: "wiki-page", title: "ok", url: `${baseUrl}projects/proj/wiki/Page`, description: "d" },
        ],
        total_count: 2,
      }),
    );
    const result = await connector.search(apiKey(), "q");
    expect(result.hits.map((h) => h.documentId)).toEqual(["wiki:proj/Page"]);
    expect(result.hits[0]?.scope).toBe("shared");
  });

  it.each([
    "http://redmine.example.invalid/",
    "https://user:pass@redmine.example.invalid/",
    "https://redmine.example.invalid/?x=1",
    "https://redmine.example.invalid/#f",
    "ftp://redmine.example.invalid/",
  ])("baseUrl(%s)を拒否する", (value) => {
    expect(() => new RedmineConnector({ sourceId: "redmine", baseUrl: value })).toThrow(ConnectorError);
  });

  it("ループバックの http は開発用に受ける", () => {
    expect(() => new RedmineConnector({ sourceId: "redmine", baseUrl: "http://127.0.0.1:3000/" })).not.toThrow();
  });
});
