import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { LocalKeyProvider } from "../src/credentials/keys.js";
import { SqliteCredentialStore } from "../src/credentials/store.js";
import { TokenVault } from "../src/credentials/vault.js";
import { emailMatches, extractVerifiedEmails, SourceOAuthClient } from "../src/credentials/oauth.js";
import {
  EscCredentialProvider,
  subSourceKey,
  TokenExchangeCredentialProvider,
  TokenVaultCredentialProvider,
} from "../src/credentials/providers.js";
import { CredentialRevocation } from "../src/credentials/revocation.js";
import type { CredentialEvent } from "../src/credentials/events.js";
import { IdpError, type Identity } from "../src/idp/types.js";
import type { SourceTokenSet } from "../src/credentials/types.js";
import { jsonResponse, mockFetch, type MockHandler } from "./helpers/mock-fetch.js";

const alice: Identity = { userId: "alice", email: "alice@example.com", session: { subjectToken: "idp-token-alice" } };

function github(routes: Record<string, MockHandler> = {}, now = () => 10_000) {
  const fetch = mockFetch(routes);
  const client = new SourceOAuthClient(
    { sourceId: "github", preset: "github", clientId: "Iv1.app", clientSecret: "app-secret", scopes: [], fetchIdentity: true },
    { fetchImpl: fetch.impl, now },
  );
  return { client, fetch };
}

describe("SourceOAuthClient", () => {
  it("認可 URL に PKCE・state・固定のリダイレクト先を載せる", () => {
    const { client } = github();
    const url = new URL(client.authorizationUrl({ state: "s1", codeChallenge: "c1", redirectUri: "https://leisen.example/connections/callback" }));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("s1");
    expect(url.searchParams.get("redirect_uri")).toBe("https://leisen.example/connections/callback");
  });

  it("Slack は user_scope で本人トークンだけを求め、本人照合のスコープを足す", () => {
    const client = new SourceOAuthClient({ sourceId: "slack", preset: "slack", clientId: "c", clientSecret: "s", scopes: ["search:read.public"], fetchIdentity: true });
    const url = new URL(client.authorizationUrl({ state: "s", codeChallenge: "c", redirectUri: "https://x/cb" }));
    expect(url.searchParams.get("scope")).toBeNull();
    expect(url.searchParams.get("user_scope")).toBe("search:read.public,users:read,users:read.email");
  });

  it("コード交換で検証済みメールだけを返す", async () => {
    const { client } = github({
      "POST https://github.com/login/oauth/access_token": () =>
        jsonResponse({ access_token: "ghu_a", refresh_token: "ghr_a", expires_in: 28800, refresh_token_expires_in: 15897600 }),
      "GET https://api.github.com/user/emails": () =>
        jsonResponse([{ email: "Alice@Example.com", verified: true }, { email: "x@personal.example", verified: false }]),
    });
    const result = await client.exchangeCode({ code: "c", codeVerifier: "v", redirectUri: "https://x/cb" });
    expect(result.tokens.accessExpiresAt).toBe(10_000 + 28_800_000);
    expect(result.verifiedEmails).toEqual(["alice@example.com"]);
  });

  it("GitHub の 200 + error はコード付きで拒否し、トークン値をエラーに含めない", async () => {
    const { client } = github({
      "POST https://github.com/login/oauth/access_token": () => jsonResponse({ error: "bad_refresh_token", error_description: "ghr_secret" }),
    });
    const error = await client.refresh({ accessToken: "a", refreshToken: "ghr_secret", obtainedAt: 0 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "invalid_grant" });
    expect(String(error)).not.toContain("ghr_secret");
  });

  it("Slack の users.info の応答から ID を返さない(不変条件7)", () => {
    expect(extractVerifiedEmails("slack", { ok: true, user: { id: "U123", profile: { email: "a@example.com" } } })).toEqual(["a@example.com"]);
  });

  it("本人照合は大文字小文字を区別せず、IdP のメールがなければ不一致", () => {
    expect(emailMatches("Alice@Example.com", ["alice@example.com"])).toBe(true);
    expect(emailMatches(undefined, ["alice@example.com"])).toBe(false);
    expect(emailMatches("alice@example.com", [])).toBe(false);
  });
});

function vaultSetup(routes: Record<string, MockHandler>) {
  let now = 10_000;
  const store = new SqliteCredentialStore(":memory:");
  const vault = new TokenVault(store, new LocalKeyProvider(randomBytes(32)), () => now);
  const { client, fetch } = github(routes, () => now);
  const events: CredentialEvent[] = [];
  const provider = new TokenVaultCredentialProvider({
    vault,
    oauth: client,
    connectUrl: "https://leisen.example/connections?source=github",
    events: async (e) => {
      events.push(e);
    },
    now: () => now,
  });
  return { vault, store, provider, fetch, events, advance: (ms: number) => (now += ms), client };
}

describe("TokenVaultCredentialProvider", () => {
  it("未接続は source_not_connected で接続ページの URL を添える", async () => {
    const { provider } = vaultSetup({});
    const error = await provider.getCredential(alice).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdpError);
    expect(error).toMatchObject({ errorClass: "source_not_connected" });
    expect((error as Error).message).toContain("https://leisen.example/connections?source=github");
  });

  it("他人の保管は使わない(本人の userId で引く)", async () => {
    const { provider, vault } = vaultSetup({});
    await vault.put("bob", "github", { accessToken: "bob-token", obtainedAt: 0 });
    await expect(provider.getCredential(alice)).rejects.toMatchObject({ errorClass: "source_not_connected" });
  });

  it("期限内はソースを呼ばずに返し、期限切れなら更新してローテーション後の更新トークンを保管する", async () => {
    let refreshes = 0;
    const s = vaultSetup({
      "POST https://github.com/login/oauth/access_token": (req) => {
        refreshes += 1;
        expect(req.form().get("refresh_token")).toBe(refreshes === 1 ? "ghr_1" : "ghr_2");
        return jsonResponse({ access_token: `ghu_${refreshes + 1}`, refresh_token: `ghr_${refreshes + 1}`, expires_in: 3600 });
      },
    });
    await s.vault.put("alice", "github", { accessToken: "ghu_1", refreshToken: "ghr_1", accessExpiresAt: 20_000_000, obtainedAt: 0 });
    expect((await s.provider.getCredential(alice)) as { accessToken: string }).toMatchObject({ accessToken: "ghu_1" });
    expect(refreshes).toBe(0);
    s.advance(20_000_000);
    expect(await s.provider.getCredential(alice)).toMatchObject({ accessToken: "ghu_2" });
    expect((await s.vault.get("alice", "github"))?.tokens.refreshToken).toBe("ghr_2");
  });

  it("並行の期限切れでもソースの更新は 1 回(直列化)", async () => {
    let refreshes = 0;
    const s = vaultSetup({
      "POST https://github.com/login/oauth/access_token": async () => {
        refreshes += 1;
        await new Promise((r) => setTimeout(r, 5));
        return jsonResponse({ access_token: "ghu_new", refresh_token: "ghr_new", expires_in: 3600 });
      },
    });
    await s.vault.put("alice", "github", { accessToken: "old", refreshToken: "ghr_1", accessExpiresAt: 1, obtainedAt: 0 });
    await Promise.all([s.provider.getCredential(alice), s.provider.getCredential(alice), s.provider.getCredential(alice)]);
    expect(refreshes).toBe(1);
  });

  it("更新トークンが無効なら行を消して未接続にし、refresh_failed を記録する", async () => {
    const s = vaultSetup({
      "POST https://github.com/login/oauth/access_token": () => jsonResponse({ error: "bad_refresh_token" }),
    });
    await s.vault.put("alice", "github", { accessToken: "old", refreshToken: "ghr_1", accessExpiresAt: 1, obtainedAt: 0 });
    await expect(s.provider.getCredential(alice)).rejects.toMatchObject({ errorClass: "source_not_connected" });
    expect(await s.vault.get("alice", "github")).toBeNull();
    expect(s.events).toEqual([expect.objectContaining({ event: "refresh_failed", reason: "invalid_grant", sourceId: "github" })]);
  });

  it("ソースの 5xx は idp_unavailable(保管は消さない)", async () => {
    const s = vaultSetup({ "POST https://github.com/login/oauth/access_token": () => new Response("", { status: 502 }) });
    await s.vault.put("alice", "github", { accessToken: "old", refreshToken: "r", accessExpiresAt: 1, obtainedAt: 0 });
    await expect(s.provider.getCredential(alice)).rejects.toMatchObject({ errorClass: "idp_unavailable" });
    expect(await s.vault.get("alice", "github")).not.toBeNull();
  });
});

describe("EscCredentialProvider", () => {
  const tokens: SourceTokenSet = { accessToken: "esc-access", obtainedAt: 500, accessExpiresAt: 99_999 };
  const withEsc = (sources: Record<string, SourceTokenSet>): Identity => ({
    ...alice,
    session: { subjectToken: "idp", esc: { sid: "sid1", issuedAt: 1000, clientId: "c", sources } },
  });

  it("要求のトークンに含まれる分を返し、キャッシュしない", async () => {
    const provider = new EscCredentialProvider({ sourceId: "github", store: new SqliteCredentialStore(":memory:"), now: () => 1000 });
    expect(provider.cacheable).toBe(false);
    expect(await provider.getCredential(withEsc({ github: tokens }))).toMatchObject({ accessToken: "esc-access" });
  });

  it("含まれない・IdP トークン直接(esc なし)なら未接続", async () => {
    const provider = new EscCredentialProvider({ sourceId: "github", store: new SqliteCredentialStore(":memory:") });
    await expect(provider.getCredential(withEsc({}))).rejects.toMatchObject({ errorClass: "source_not_connected" });
    await expect(provider.getCredential(alice)).rejects.toMatchObject({ errorClass: "source_not_connected" });
  });

  it("解除(sub_source の拒否)より前に取得したものは使わない", async () => {
    const store = new SqliteCredentialStore(":memory:");
    await store.addDenial("sub_source", subSourceKey("alice", "github"), 600, 10_000);
    const provider = new EscCredentialProvider({ sourceId: "github", store, now: () => 1000 });
    await expect(provider.getCredential(withEsc({ github: tokens }))).rejects.toMatchObject({ errorClass: "source_not_connected" });
    expect(await provider.getCredential(withEsc({ github: { ...tokens, obtainedAt: 700 } }))).toMatchObject({ accessToken: "esc-access" });
  });
});

describe("TokenExchangeCredentialProvider", () => {
  it("entra_obo: jwt-bearer + on_behalf_of で本人の IdP トークンを交換する", async () => {
    const fetch = mockFetch({
      "POST https://login.microsoftonline.com/t/oauth2/v2.0/token": () => jsonResponse({ access_token: "graph-token", expires_in: 3600 }),
    });
    const provider = new TokenExchangeCredentialProvider(
      { sourceId: "sharepoint", kind: "entra_obo", tokenEndpoint: "https://login.microsoftonline.com/t/oauth2/v2.0/token", clientId: "app", clientSecret: "sec", scope: "https://graph.microsoft.com/.default" },
      { fetchImpl: fetch.impl, now: () => 0 },
    );
    expect(await provider.getCredential(alice)).toEqual({ kind: "oauth_bearer", accessToken: "graph-token", expiresAt: 3_600_000 });
    const form = fetch.requests[0]?.form();
    expect(form?.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(form?.get("requested_token_use")).toBe("on_behalf_of");
    expect(form?.get("assertion")).toBe("idp-token-alice");
  });

  it("entra_obo は scope 必須", () => {
    expect(() => new TokenExchangeCredentialProvider({ sourceId: "s", kind: "entra_obo", tokenEndpoint: "https://x", clientId: "a", clientSecret: "b" })).toThrow(IdpError);
  });

  it("rfc8693: token-exchange グラントと Basic 認証、audience", async () => {
    const fetch = mockFetch({ "POST https://kc/token": () => jsonResponse({ access_token: "src", expires_in: 60 }) });
    const provider = new TokenExchangeCredentialProvider(
      { sourceId: "wiki", kind: "rfc8693", tokenEndpoint: "https://kc/token", clientId: "gw", clientSecret: "sec", audience: "wiki-api" },
      { fetchImpl: fetch.impl },
    );
    await provider.getCredential(alice);
    const req = fetch.requests[0];
    expect(req?.form().get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(req?.form().get("subject_token")).toBe("idp-token-alice");
    expect(req?.form().get("audience")).toBe("wiki-api");
    expect(req?.headers["authorization"]).toMatch(/^Basic /);
  });

  it("同意不足(interaction_required)は source_not_connected、5xx は idp_unavailable", async () => {
    let status = 400;
    const fetch = mockFetch({ "POST https://kc/token": () => jsonResponse({ error: "interaction_required" }, status) });
    const provider = new TokenExchangeCredentialProvider(
      { sourceId: "wiki", kind: "rfc8693", tokenEndpoint: "https://kc/token", clientId: "gw", clientSecret: "sec" },
      { fetchImpl: fetch.impl },
    );
    await expect(provider.getCredential(alice)).rejects.toMatchObject({ errorClass: "source_not_connected" });
    status = 503;
    await expect(provider.getCredential(alice)).rejects.toMatchObject({ errorClass: "idp_unavailable" });
  });
});

describe("CredentialRevocation", () => {
  it("利用停止: Vault の全ソースをソースへ失効依頼して消し、sub の拒否を入れてキャッシュを捨てる", async () => {
    const s = vaultSetup({ "DELETE https://api.github.com/applications/Iv1.app/token": () => new Response(null, { status: 204 }) });
    await s.vault.put("alice", "github", { accessToken: "ghu", obtainedAt: 0 });
    const invalidated: string[] = [];
    const events: CredentialEvent[] = [];
    const revocation = new CredentialRevocation({
      vault: s.vault,
      store: s.store,
      sources: { vault: new Map([["github", s.client]]), esc: new Map() },
      events: async (e) => {
        events.push(e);
      },
      invalidateUser: (u) => invalidated.push(u),
      denialRetentionMs: 1000,
      now: () => 100,
    });
    const result = await revocation.deprovision("alice");
    expect(result).toEqual({ revokedAtSource: 1, deleted: 1, sourceRevocationFailed: [] });
    expect(await s.vault.get("alice", "github")).toBeNull();
    expect(await s.store.denial("sub", "alice")).toBe(101);
    expect(invalidated).toEqual(["alice"]);
    expect(events.map((e) => e.event)).toEqual(["revoked", "deprovisioned"]);
    const revokeCall = s.fetch.requests.find((r) => r.method === "DELETE");
    expect(revokeCall?.headers["authorization"]).toMatch(/^Basic /);
  });

  it("ソースへの失効依頼が失敗しても保管は消す", async () => {
    const s = vaultSetup({ "DELETE https://api.github.com/applications/Iv1.app/token": () => new Response("", { status: 500 }) });
    await s.vault.put("alice", "github", { accessToken: "ghu", obtainedAt: 0 });
    const revocation = new CredentialRevocation({
      vault: s.vault,
      sources: { vault: new Map([["github", s.client]]), esc: new Map() },
      events: async () => undefined,
      invalidateUser: () => undefined,
      denialRetentionMs: 1000,
    });
    const result = await revocation.deprovision("alice");
    expect(result.sourceRevocationFailed).toEqual(["github"]);
    expect(await s.vault.get("alice", "github")).toBeNull();
  });

  it("ESC の解除は (sub, source) の拒否を入れる", async () => {
    const store = new SqliteCredentialStore(":memory:");
    const { client } = github();
    const revocation = new CredentialRevocation({
      store,
      sources: { vault: new Map(), esc: new Map([["github", client]]) },
      events: async () => undefined,
      invalidateUser: () => undefined,
      denialRetentionMs: 1000,
      now: () => 50,
    });
    expect(await revocation.disconnect(alice, "github")).toBe(true);
    expect(await store.denial("sub_source", subSourceKey("alice", "github"))).toBe(51);
    expect(await revocation.disconnect(alice, "other")).toBe(false);
  });
});

describe("SourceOAuthClient(esa プリセット、ADR-023)", () => {
  function esa(routes: Record<string, MockHandler> = {}) {
    const fetch = mockFetch(routes);
    const client = new SourceOAuthClient(
      { sourceId: "esa", preset: "esa", clientId: "esa-app", clientSecret: "esa-secret", scopes: ["mcp"], fetchIdentity: true },
      { fetchImpl: fetch.impl, now: () => 10_000 },
    );
    return { client, fetch };
  }

  it("認可 URL は api.esa.io で、RFC 8707 の resource に mcp.esa.io を載せる", () => {
    const { client } = esa();
    const url = new URL(client.authorizationUrl({ state: "s", codeChallenge: "c", redirectUri: "https://leisen.example/connections/callback" }));
    expect(url.origin + url.pathname).toBe("https://api.esa.io/oauth/authorize");
    expect(url.searchParams.get("resource")).toBe("https://mcp.esa.io");
    expect(url.searchParams.get("scope")).toBe("mcp");
    expect(client.resource).toBe("https://mcp.esa.io");
  });

  it("更新(refresh_token)にも resource を載せ、ローテーションしなければ旧更新トークンを保つ", async () => {
    const { client, fetch } = esa({
      "POST https://api.esa.io/oauth/token": () => jsonResponse({ access_token: "esa-access-2", expires_in: 7200 }),
    });
    const refreshed = await client.refresh({ accessToken: "esa-access-1", refreshToken: "esa-refresh-1", obtainedAt: 0 });
    const form = fetch.requests[0]?.form();
    expect(form?.get("grant_type")).toBe("refresh_token");
    expect(form?.get("resource")).toBe("https://mcp.esa.io");
    expect(refreshed.refreshToken).toBe("esa-refresh-1");
    expect(refreshed.accessExpiresAt).toBe(10_000 + 7_200_000);
  });

  it("本人照合は GET /v1/user の email、失効は RFC 7009 で更新トークンを送る", async () => {
    expect(extractVerifiedEmails("esa", { screen_name: "alice", email: "Alice@Example.com" })).toEqual(["alice@example.com"]);
    expect(extractVerifiedEmails("esa", { screen_name: "alice" })).toEqual([]);
    const { client, fetch } = esa({ "POST https://api.esa.io/oauth/revoke": () => new Response(null, { status: 200 }) });
    expect(await client.revoke({ accessToken: "esa-access-1", refreshToken: "esa-refresh-1", obtainedAt: 0 })).toBe(true);
    expect(fetch.requests[0]?.form().get("token")).toBe("esa-refresh-1");
  });

  it("resource を設定で上書きでき、既定のないプリセットには送らない", () => {
    const custom = new SourceOAuthClient({
      sourceId: "x",
      preset: "custom",
      clientId: "c",
      clientSecret: "s",
      scopes: [],
      fetchIdentity: false,
      endpoints: { authorizationEndpoint: "https://as.example/authorize", tokenEndpoint: "https://as.example/token" },
      resource: "https://mcp.example",
    });
    expect(new URL(custom.authorizationUrl({ state: "s", codeChallenge: "c", redirectUri: "https://x/cb" })).searchParams.get("resource")).toBe("https://mcp.example");
    const { client } = github();
    expect(new URL(client.authorizationUrl({ state: "s", codeChallenge: "c", redirectUri: "https://x/cb" })).searchParams.get("resource")).toBeNull();
  });
});
