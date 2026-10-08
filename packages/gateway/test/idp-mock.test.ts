import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIdpAdapter,
  IdpError,
  MOCK_IDP_NO_SESSIONS_REJECTED,
  MockCredentialProvider,
  MockIdpAdapter,
  mockTokenEnvVar,
  parseMockSessions,
  redactIdentity,
  type CredentialProvider,
  type Identity,
} from "../src/idp/index.js";

const SESSIONS = {
  "dev-session-alice": { userId: "alice", displayName: "Alice" },
  "dev-session-bob": { userId: "bob" },
};

function staticProvider(sourceId: string): CredentialProvider {
  return {
    sourceId,
    method: "oauth_individual",
    async getCredential(identity: Identity) {
      return {
        kind: "oauth_bearer",
        accessToken: `static-for-${identity.userId}`,
        expiresAt: Date.now() + 60_000,
      };
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("MockIdpAdapter", () => {
  it("既知のセッショントークンでIdentityを返す", async () => {
    const adapter = new MockIdpAdapter([], { sessions: SESSIONS });
    const identity = await adapter.authenticate("dev-session-alice");
    expect(identity.userId).toBe("alice");
    expect(identity.displayName).toBe("Alice");
  });

  it("未知のトークンはunauthenticated(トークン欠落の認可分岐)", async () => {
    const adapter = new MockIdpAdapter([], { sessions: SESSIONS });
    const error = await adapter.authenticate("no-such-token").catch((e) => e);
    expect(error).toBeInstanceOf(IdpError);
    expect((error as IdpError).errorClass).toBe("unauthenticated");
    // トークン値をエラーメッセージへ漏らさない(不変条件6)
    expect((error as IdpError).message).not.toContain("no-such-token");
  });

  it("KP_MOCK_SESSIONS 環境変数からセッションを注入できる", async () => {
    vi.stubEnv("KP_MOCK_SESSIONS", "tok-1=carol, tok-2=dave");
    const adapter = new MockIdpAdapter([]);
    expect((await adapter.authenticate("tok-1")).userId).toBe("carol");
    expect((await adapter.authenticate("tok-2")).userId).toBe("dave");
  });

  it("getCredentialは登録済みプロバイダへ委譲しAuthContextを返す", async () => {
    const adapter = new MockIdpAdapter([staticProvider("gdrive")], {
      sessions: SESSIONS,
    });
    const identity = await adapter.authenticate("dev-session-alice");
    const auth = await adapter.getCredential(identity, "gdrive");
    expect(auth.userId).toBe("alice");
    expect(auth.credential).toEqual(
      expect.objectContaining({ kind: "oauth_bearer" }),
    );
  });

  it("未登録ソースはmisconfigured", async () => {
    const adapter = new MockIdpAdapter([], { sessions: SESSIONS });
    const identity = await adapter.authenticate("dev-session-alice");
    const error = await adapter
      .getCredential(identity, "unknown-source")
      .catch((e) => e);
    expect((error as IdpError).errorClass).toBe("misconfigured");
  });

  it("資格情報はユーザーごとにキャッシュ・分離される(不変条件4)", async () => {
    const provider = staticProvider("gdrive");
    const spy = vi.spyOn(provider, "getCredential");
    const adapter = new MockIdpAdapter([provider], { sessions: SESSIONS });

    const alice = await adapter.authenticate("dev-session-alice");
    const bob = await adapter.authenticate("dev-session-bob");
    const aliceAuth1 = await adapter.getCredential(alice, "gdrive");
    const aliceAuth2 = await adapter.getCredential(alice, "gdrive");
    const bobAuth = await adapter.getCredential(bob, "gdrive");

    expect(spy).toHaveBeenCalledTimes(2); // alice 1回 + bob 1回
    expect(aliceAuth2.credential).toBe(aliceAuth1.credential);
    expect(bobAuth.credential).not.toEqual(aliceAuth1.credential);
  });

  it("invalidateUserで該当ユーザーのみ再取得になる", async () => {
    const provider = staticProvider("gdrive");
    const spy = vi.spyOn(provider, "getCredential");
    const adapter = new MockIdpAdapter([provider], { sessions: SESSIONS });
    const alice = await adapter.authenticate("dev-session-alice");
    const bob = await adapter.authenticate("dev-session-bob");
    await adapter.getCredential(alice, "gdrive");
    await adapter.getCredential(bob, "gdrive");

    adapter.invalidateUser("alice");
    await adapter.getCredential(alice, "gdrive");
    await adapter.getCredential(bob, "gdrive");
    expect(spy).toHaveBeenCalledTimes(3); // aliceのみ再取得
  });

  it("セッション表が空なら、最初の拒否で1回だけ warn を呼ぶ(トークンを含めない。issue #38)", async () => {
    const warn = vi.fn();
    const adapter = new MockIdpAdapter([], { sessions: {}, warn });
    expect(adapter.sessionCount).toBe(0);

    for (const token of ["dev-only-unknown-1", "dev-only-unknown-2", "dev-only-unknown-3"]) {
      const error = await adapter.authenticate(token).catch((e: unknown) => e);
      expect((error as IdpError).errorClass).toBe("unauthenticated");
    }

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(MOCK_IDP_NO_SESSIONS_REJECTED);
    expect(MOCK_IDP_NO_SESSIONS_REJECTED).toContain("mock IdP: no sessions configured");
    expect(MOCK_IDP_NO_SESSIONS_REJECTED).toContain("KP_MOCK_SESSIONS");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("dev-only-unknown");
  });

  it("セッション表があれば、未知のトークンを拒否しても warn を呼ばない", async () => {
    const warn = vi.fn();
    const adapter = new MockIdpAdapter([], { sessions: SESSIONS, warn });
    await expect(adapter.authenticate("dev-only-unknown")).rejects.toBeInstanceOf(IdpError);
    expect(warn).not.toHaveBeenCalled();
  });

  it("factory(createIdpAdapter)経由でも warn が渡る", async () => {
    const warn = vi.fn();
    const adapter = createIdpAdapter({ kind: "mock", sessions: {} }, { providers: [], warn });
    await expect(adapter.authenticate("dev-only-unknown")).rejects.toBeInstanceOf(IdpError);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "プロトタイプのプロパティ名のトークン(%s)は unauthenticated(対応表の自身のキーだけを引く)",
    async (token) => {
      for (const sessions of [SESSIONS, parseMockSessions("t1=carol")]) {
        const adapter = new MockIdpAdapter([], { sessions });
        const error = await adapter.authenticate(token).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(IdpError);
        expect((error as IdpError).errorClass).toBe("unauthenticated");
      }
    },
  );

  it("NODE_ENV=productionでは構築を拒否する(本番無効化)", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => new MockIdpAdapter([], { sessions: SESSIONS })).toThrow(
      /disabled in production/,
    );
    expect(() => new MockCredentialProvider("gdrive")).toThrow(
      /disabled in production/,
    );
  });
});

describe("MockCredentialProvider", () => {
  const identity: Identity = {
    userId: "alice",
    session: { subjectToken: "dev-session-alice" },
  };

  it("環境変数からトークンを注入する", async () => {
    vi.stubEnv(mockTokenEnvVar("gdrive"), "dev-gdrive-token");
    const provider = new MockCredentialProvider("gdrive", {
      tokenLifetimeMs: 1000,
      now: () => 0,
    });
    await expect(provider.getCredential(identity)).resolves.toEqual({
      kind: "oauth_bearer",
      accessToken: "dev-gdrive-token",
      expiresAt: 1000,
    });
  });

  it("ユーザー別の上書き変数が優先される", async () => {
    vi.stubEnv(mockTokenEnvVar("gdrive"), "shared-token");
    vi.stubEnv(`${mockTokenEnvVar("gdrive")}__ALICE`, "alice-token");
    const provider = new MockCredentialProvider("gdrive");
    const credential = await provider.getCredential(identity);
    expect(credential).toEqual(
      expect.objectContaining({ accessToken: "alice-token" }),
    );
  });

  it("未注入のソースはsource_not_connected(未接続の認可分岐)", async () => {
    const provider = new MockCredentialProvider("gdrive");
    const error = await provider.getCredential(identity).catch((e) => e);
    expect(error).toBeInstanceOf(IdpError);
    expect((error as IdpError).errorClass).toBe("source_not_connected");
  });

  it("env を渡すとプロセスの環境変数ではなくそれを読む(起動コードの env 注入)", async () => {
    vi.stubEnv(mockTokenEnvVar("gdrive"), "process-token");
    const provider = new MockCredentialProvider("gdrive", {
      env: { [mockTokenEnvVar("gdrive")]: "injected-token" },
    });
    await expect(provider.getCredential(identity)).resolves.toEqual(
      expect.objectContaining({ accessToken: "injected-token" }),
    );
    const empty = new MockCredentialProvider("gdrive", { env: {} });
    const error = await empty.getCredential(identity).catch((e) => e);
    expect((error as IdpError).errorClass).toBe("source_not_connected");
  });
});

describe("parseMockSessions", () => {
  it("token=userId の並びを解析する(未設定・空は空の対応表)", () => {
    expect(parseMockSessions("t1=carol, t2=dave")).toEqual({
      t1: { userId: "carol" },
      t2: { userId: "dave" },
    });
    expect(parseMockSessions(undefined)).toEqual({});
    expect(parseMockSessions("")).toEqual({});
  });

  it("プロトタイプのプロパティ名もトークンとして登録できる(自身のキーとして持つ)", async () => {
    const sessions = parseMockSessions("constructor=carol");
    expect(Object.keys(sessions)).toEqual(["constructor"]);
    const adapter = new MockIdpAdapter([], { sessions });
    expect((await adapter.authenticate("constructor")).userId).toBe("carol");
    await expect(adapter.authenticate("toString")).rejects.toBeInstanceOf(IdpError);
  });

  it("形式不正は misconfigured で、値(トークン)をエコーしない", () => {
    const error = (() => {
      try {
        parseMockSessions("dev-only-token-without-user");
        return undefined;
      } catch (e) {
        return e as IdpError;
      }
    })();
    expect(error).toBeInstanceOf(IdpError);
    expect(error?.errorClass).toBe("misconfigured");
    expect(error?.message).not.toContain("dev-only-token-without-user");
  });
});

describe("redactIdentity", () => {
  it("セッショントークンを含まない構造を返す", () => {
    const identity: Identity = {
      userId: "alice",
      displayName: "Alice",
      session: { subjectToken: "secret-session-token", expiresAt: 123 },
    };
    const redacted = redactIdentity(identity);
    expect(JSON.stringify(redacted)).not.toContain("secret-session-token");
    expect(redacted).toEqual({
      userId: "alice",
      displayName: "Alice",
      session: { redacted: true },
    });
  });
});
