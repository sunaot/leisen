/**
 * Gateway のプラグイン契約 createConnector(T-019。packages/gateway/src/bootstrap/plugins.ts の
 * ConnectorFactory: `createConnector({ sourceId, settings, configDir })` → Connector)。
 * - Connector を返し、sourceId は init.sourceId
 * - settings(deployment.yaml の connectors[].settings)の秘密でない設定を反映する
 * - 未知のキー(トークン類を含む)・型違い・範囲外・不正な baseUrl は
 *   ConnectorError("invalid_request")(受領値をエコーしない)。Gateway はこれを
 *   connector_settings_invalid として起動を拒否する
 * - factory の中で GitHub API を呼ばない
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorError, type Connector } from "@kp/connector-sdk";
import { GitHubConnector } from "../src/connector.js";
import { createConnector } from "../src/index.js";
import { FakeGitHub, bearerAuth, searchResponse } from "./helpers/fake-github.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function captureError(action: () => unknown): ConnectorError {
  try {
    action();
  } catch (error) {
    if (error instanceof ConnectorError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a ConnectorError, but the factory succeeded");
}

/** 失効時刻の判定を実時計に依存させない資格情報(expiresAt 0 は「不明」扱い)。 */
const ALICE = bearerAuth("alice", { expiresAt: 0 });

describe("createConnector(Gateway のプラグイン契約)", () => {
  it("Connector を返し、sourceId は init.sourceId になる(settings は省略・空でもよい)", () => {
    const connector: Connector = createConnector({
      sourceId: "github-corp",
      settings: {},
      configDir: "/etc/kp",
    });
    expect(connector).toBeInstanceOf(GitHubConnector);
    expect(connector.sourceId).toBe("github-corp");
    expect(connector.capabilities).toEqual({
      nativeSearch: "degraded",
      ingest: false,
      privateScopeHandling: "classified",
    });
    for (const method of ["search", "fetch", "list", "describe"] as const) {
      expect(typeof connector[method]).toBe("function");
    }
    expect(createConnector({ sourceId: "github" }).sourceId).toBe("github");
  });

  it("構築時に GitHub API を呼ばない(本人の資格情報がない時点のため)", () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    createConnector({
      sourceId: "github",
      settings: { baseUrl: "https://ghe.corp.example/api/v3", searchCode: false },
      configDir: "/etc/kp",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("settings の baseUrl / userAgent / searchCode / displayName / rateLimit を反映する", async () => {
    const github = new FakeGitHub();
    github.on(/^\/api\/v3\/search\/issues$/, () => searchResponse([]));
    vi.stubGlobal("fetch", github.fetchImpl);
    const connector = createConnector({
      sourceId: "github-ghes",
      settings: {
        baseUrl: "https://ghe.corp.example/api/v3",
        userAgent: "corp-leisen/1.0",
        timeoutMs: 5_000,
        searchCode: false,
        displayName: "GitHub Enterprise",
        maxComments: 5,
        rateLimit: { maxEntries: 100, secondaryBackoffBaseMs: 1_000 },
      },
      configDir: "/etc/kp",
    });

    await connector.search(ALICE, "経費精算");

    // コード検索は無効、issue / PR の検索だけが baseUrl に届く
    expect(github.requests.map((r) => `${r.url.host}${r.url.pathname}`)).toEqual([
      "ghe.corp.example/api/v3/search/issues",
      "ghe.corp.example/api/v3/search/issues",
    ]);
    expect(github.requests.every((r) => r.headers.get("user-agent") === "corp-leisen/1.0")).toBe(
      true,
    );
    github.onJson(/^\/api\/v3\/user\/orgs$/, []);
    const description = await connector.describe(ALICE);
    expect(description.sourceId).toBe("github-ghes");
    expect(description.displayName).toBe("GitHub Enterprise");
  });

  it.each([
    ["トークンらしきキー", { token: "dev-only-token" }, "unknown setting token"],
    ["本人トークンのキー", { accessToken: "dev-only-token" }, "unknown setting accessToken"],
    ["sourceId(init.sourceId で渡す)", { sourceId: "other" }, "unknown setting sourceId"],
    ["テスト用の注入", { fetchImpl: "x" }, "unknown setting fetchImpl"],
    ["綴り違い", { maxCommentsPerFetch: 10 }, "unknown setting maxCommentsPerFetch"],
    ["rateLimit の未知のキー", { rateLimit: { maxEntry: 1 } }, "unknown setting rateLimit.maxEntry"],
    ["型違い(文字列の数値)", { timeoutMs: "30s" }, "timeoutMs must be an integer"],
    ["型違い(小数)", { pageChars: 1.5 }, "pageChars must be an integer"],
    ["型違い(真偽値)", { searchCode: "yes" }, "searchCode must be true or false"],
    ["型違い(rateLimit)", { rateLimit: [1] }, "rateLimit must be a mapping"],
    ["範囲外(timeoutMs)", { timeoutMs: 0 }, "timeoutMs must be an integer between"],
    ["範囲外(maxComments)", { maxComments: 1_000 }, "maxComments must be an integer between"],
    ["ループバック以外の http", { baseUrl: "http://ghe.corp.example/api/v3" }, "baseUrl must use https"],
    ["資格情報入りの baseUrl", { baseUrl: "https://user:dev-only-pass@ghe.corp.example/api/v3" }, "must not contain credentials"],
    ["URL でない baseUrl", { baseUrl: "ghe.corp.example" }, "baseUrl must be an absolute URL"],
  ])("不正な settings(%s)は ConnectorError(invalid_request)で拒否する", (_label, settings, message) => {
    const error = captureError(() =>
      createConnector({ sourceId: "github", settings, configDir: "/etc/kp" }),
    );
    expect(error.errorClass).toBe("invalid_request");
    expect(error.message).toContain(message);
    // 受領値はエコーしない
    for (const value of ["dev-only-token", "dev-only-pass", "30s", "yes", "other"]) {
      expect(error.message).not.toContain(value);
    }
  });

  it.each([
    ["配列", ["baseUrl"]],
    ["文字列", "baseUrl: https://api.github.com"],
    ["null", null],
  ])("settings が対応表でない(%s)なら拒否する", (_label, settings) => {
    const error = captureError(() =>
      createConnector({
        sourceId: "github",
        settings: settings as unknown as Record<string, unknown>,
        configDir: "/etc/kp",
      }),
    );
    expect(error.errorClass).toBe("invalid_request");
    expect(error.message).toContain("settings must be a mapping");
  });

  it("sourceId が空なら拒否する", () => {
    const error = captureError(() => createConnector({ sourceId: " ", settings: {}, configDir: "/" }));
    expect(error.errorClass).toBe("invalid_request");
    expect(error.message).toContain("sourceId must be a non-empty string");
  });

  it("名前らしくない未知のキーはエコーしない", () => {
    const error = captureError(() =>
      createConnector({ sourceId: "github", settings: { "dev-only key!": 1 }, configDir: "/" }),
    );
    expect(error.message).toContain("unknown setting (a key)");
    expect(error.message).not.toContain("dev-only key!");
  });
});
