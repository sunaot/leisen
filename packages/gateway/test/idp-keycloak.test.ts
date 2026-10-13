import { describe, expect, it, vi } from "vitest";
import {
  IdpError,
  KeycloakIdpAdapter,
  type KeycloakIdpAdapterConfig,
} from "../src/idp/index.js";

const BASE_CONFIG: Omit<KeycloakIdpAdapterConfig, "fetchImpl"> = {
  baseUrl: "http://keycloak.test:8080",
  realm: "leisen",
  clientId: "gateway",
  clientSecret: "dev-only-secret",
  allowedClients: ["chat-ui"],
};

/** 検証をすべて通る応答(個々のテストで1クレームずつ崩す)。 */
const VALID_BODY = {
  active: true,
  sub: "user-uuid-1",
  iss: "http://keycloak.test:8080/realms/leisen",
  typ: "Bearer",
  azp: "chat-ui",
  aud: ["gateway", "account"],
} as const;

function adapterWith(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
  overrides: Partial<KeycloakIdpAdapterConfig> = {},
): KeycloakIdpAdapter {
  const fetchImpl = (async (url: unknown, init: unknown) =>
    handler(String(url), (init ?? {}) as RequestInit)) as typeof fetch;
  return new KeycloakIdpAdapter({ ...BASE_CONFIG, ...overrides, fetchImpl }, []);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("KeycloakIdpAdapter.authenticate", () => {
  it("activeなトークンからIdentityを組み立てる", async () => {
    let requestedUrl = "";
    let sentBody = "";
    let authHeader = "";
    const adapter = adapterWith(async (url, init) => {
      requestedUrl = url;
      sentBody = String(init.body);
      authHeader = new Headers(init.headers).get("authorization") ?? "";
      return jsonResponse({
        ...VALID_BODY,
        preferred_username: "alice",
        exp: 1_700_000_000,
      });
    });

    const identity = await adapter.authenticate("the-access-token");
    expect(requestedUrl).toBe(
      "http://keycloak.test:8080/realms/leisen/protocol/openid-connect/token/introspect",
    );
    expect(sentBody).toContain("token=the-access-token");
    expect(authHeader).toBe(
      `Basic ${Buffer.from("gateway:dev-only-secret").toString("base64")}`,
    );
    expect(identity.userId).toBe("user-uuid-1");
    expect(identity.displayName).toBe("alice");
    expect(identity.session.subjectToken).toBe("the-access-token");
    expect(identity.session.expiresAt).toBe(1_700_000_000_000);
  });

  it("active=falseはunauthenticated(失効・改竄トークンの認可分岐)", async () => {
    const adapter = adapterWith(() => jsonResponse({ active: false }));
    const error = await adapter.authenticate("expired-token").catch((e) => e);
    expect(error).toBeInstanceOf(IdpError);
    expect((error as IdpError).errorClass).toBe("unauthenticated");
    expect((error as IdpError).message).not.toContain("expired-token");
  });

  it("空トークンはIdPに問い合わせずunauthenticated", async () => {
    let called = false;
    const adapter = adapterWith(() => {
      called = true;
      return jsonResponse({ active: true, sub: "x" });
    });
    const error = await adapter.authenticate("").catch((e) => e);
    expect((error as IdpError).errorClass).toBe("unauthenticated");
    expect(called).toBe(false);
  });

  it("HTTPエラーはidp_unavailable(unauthenticatedと区別する)", async () => {
    const adapter = adapterWith(() => jsonResponse({}, 503));
    const error = await adapter.authenticate("some-token").catch((e) => e);
    expect((error as IdpError).errorClass).toBe("idp_unavailable");
    expect((error as IdpError).message).toContain("503");
  });

  it("ネットワーク到達不能はidp_unavailableで、トークンを漏らさない", async () => {
    const adapter = adapterWith(() => {
      throw new Error("connect ECONNREFUSED");
    });
    const error = await adapter.authenticate("some-token").catch((e) => e);
    expect((error as IdpError).errorClass).toBe("idp_unavailable");
    expect((error as IdpError).message).not.toContain("some-token");
  });

  it("200でも非JSON応答はidp_unavailable", async () => {
    const adapter = adapterWith(
      () => new Response("<html>proxy error</html>", { status: 200 }),
    );
    const error = await adapter.authenticate("some-token").catch((e) => e);
    expect(error).toBeInstanceOf(IdpError);
    expect((error as IdpError).errorClass).toBe("idp_unavailable");
  });

  it("active=trueでもsub欠落はunauthenticated", async () => {
    const adapter = adapterWith(() => jsonResponse({ ...VALID_BODY, sub: undefined }));
    const error = await adapter.authenticate("odd-token").catch((e) => e);
    expect((error as IdpError).errorClass).toBe("unauthenticated");
  });
});

/**
 * 受け手・種別・発行者の検証(issue #16)。検証は環境によらず常に行い、失敗はすべて
 * unauthenticated(固定文言)。理由は diagnose にクレーム名だけで渡る。
 */
describe("KeycloakIdpAdapter: iss / typ / azp / aud の検証(issue #16)", () => {
  const TOKEN = "dev-only-session-token-value";

  async function rejectedWith(
    body: Record<string, unknown>,
    overrides: Partial<KeycloakIdpAdapterConfig> = {},
  ): Promise<{ error: IdpError; diagnosed: string[] }> {
    const diagnosed: string[] = [];
    const adapter = adapterWith(() => jsonResponse(body), {
      diagnose: (message) => diagnosed.push(message),
      ...overrides,
    });
    const error = await adapter.authenticate(TOKEN).catch((e) => e);
    expect(error).toBeInstanceOf(IdpError);
    expect((error as IdpError).errorClass).toBe("unauthenticated");
    // 利用者向けの文言は固定(クレームの値を含まない)
    expect((error as IdpError).message).toBe(
      "session token was rejected by keycloak introspection checks",
    );
    return { error: error as IdpError, diagnosed };
  }

  function expectDiagnosisIsClaimOnly(diagnosed: string[]): void {
    expect(diagnosed).toHaveLength(1);
    expect(diagnosed[0]).not.toContain(TOKEN);
    expect(diagnosed[0]).not.toContain(VALID_BODY.sub);
    expect(diagnosed[0]).not.toContain("dev-only-secret");
  }

  it("成功経路: iss・typ・azp が一致し aud を含む応答から Identity を組み立て、diagnose は呼ばれない", async () => {
    const diagnosed: string[] = [];
    const adapter = adapterWith(() => jsonResponse(VALID_BODY), {
      requireAudience: true,
      diagnose: (message) => diagnosed.push(message),
    });
    const identity = await adapter.authenticate(TOKEN);
    expect(identity.userId).toBe("user-uuid-1");
    expect(diagnosed).toEqual([]);
  });

  it("iss が <baseUrl>/realms/<realm> と異なれば拒否(診断は 'iss mismatch' だけ)", async () => {
    const { diagnosed } = await rejectedWith({
      ...VALID_BODY,
      iss: "http://other-idp.test/realms/leisen",
    });
    expectDiagnosisIsClaimOnly(diagnosed);
    expect(diagnosed[0]).toContain("iss mismatch");
    expect(diagnosed[0]).not.toContain("other-idp");
  });

  it("iss の欠落も拒否(fail-closed)", async () => {
    const { diagnosed } = await rejectedWith({ ...VALID_BODY, iss: undefined });
    expect(diagnosed[0]).toContain("iss is missing");
  });

  it("baseUrl の末尾スラッシュ・iss の末尾スラッシュは同一視し、realm は URL エンコードして比較する", async () => {
    const adapter = adapterWith(
      () => jsonResponse({ ...VALID_BODY, iss: "http://keycloak.test:8080/realms/my%20realm/" }),
      { baseUrl: "http://keycloak.test:8080/", realm: "my realm" },
    );
    await expect(adapter.authenticate(TOKEN)).resolves.toMatchObject({ userId: "user-uuid-1" });
  });

  it("allowedIssuers を明示すれば baseUrl 由来の既定の iss は受け付けない", async () => {
    const issuers = { allowedIssuers: ["https://idp.example.test/realms/leisen"] };
    await rejectedWith(VALID_BODY, issuers);
    const adapter = adapterWith(
      () => jsonResponse({ ...VALID_BODY, iss: "https://idp.example.test/realms/leisen" }),
      issuers,
    );
    await expect(adapter.authenticate(TOKEN)).resolves.toMatchObject({ userId: "user-uuid-1" });
  });

  it("typ が Refresh(リフレッシュトークン)なら拒否", async () => {
    const { diagnosed } = await rejectedWith({ ...VALID_BODY, typ: "Refresh" });
    expectDiagnosisIsClaimOnly(diagnosed);
    expect(diagnosed[0]).toContain('typ "Refresh" is not Bearer');
  });

  it("typ が ID(ID トークン)なら拒否", async () => {
    const { diagnosed } = await rejectedWith({ ...VALID_BODY, typ: "ID" });
    expect(diagnosed[0]).toContain('typ "ID" is not Bearer');
  });

  it("typ の欠落は拒否(fail-closed)", async () => {
    const { diagnosed } = await rejectedWith({ ...VALID_BODY, typ: undefined });
    expect(diagnosed[0]).toContain("typ is missing");
  });

  it("azp が allowedClients にないクライアントなら拒否(診断はクライアント ID だけ)", async () => {
    const { diagnosed } = await rejectedWith({ ...VALID_BODY, azp: "rogue-client" });
    expectDiagnosisIsClaimOnly(diagnosed);
    expect(diagnosed[0]).toContain('azp "rogue-client" is not in allowedClients');
  });

  it("azp の欠落は拒否(\"*\" でない限り)", async () => {
    const { diagnosed } = await rejectedWith({ ...VALID_BODY, azp: undefined });
    expect(diagnosed[0]).toContain("azp is missing");
    const adapter = adapterWith(() => jsonResponse({ ...VALID_BODY, azp: undefined }), {
      allowedClients: ["*"],
    });
    await expect(adapter.authenticate(TOKEN)).resolves.toMatchObject({ userId: "user-uuid-1" });
  });

  it("azp が allowedClients のいずれかなら通る(複数登録)", async () => {
    const adapter = adapterWith(() => jsonResponse({ ...VALID_BODY, azp: "librechat" }), {
      allowedClients: ["chat-ui", "librechat"],
    });
    await expect(adapter.authenticate(TOKEN)).resolves.toMatchObject({ userId: "user-uuid-1" });
  });

  it('allowedClients に "*" があれば azp の検証だけを省く(他の項目と混在しても同じ。iss / typ は検証する)', async () => {
    const any = { allowedClients: ["chat-ui", "*"] };
    const adapter = adapterWith(() => jsonResponse({ ...VALID_BODY, azp: "anything" }), any);
    await expect(adapter.authenticate(TOKEN)).resolves.toMatchObject({ userId: "user-uuid-1" });
    const { diagnosed } = await rejectedWith({ ...VALID_BODY, azp: "anything", typ: "Refresh" }, any);
    expect(diagnosed[0]).toContain("typ");
  });

  it.each([
    "http://keycloak.test:8080/realms/leisen-evil",
    "http://keycloak.test:8080/realms/kpx",
    "HTTP://KEYCLOAK.TEST:8080/realms/leisen",
    "http://keycloak.test:8080/realms/leisen/",
  ])("iss の似せ値 %s は受け付けない(前方一致・大文字小文字の緩和をしない。末尾スラッシュだけ同一視)", async (iss) => {
    if (iss.endsWith("/")) {
      const adapter = adapterWith(() => jsonResponse({ ...VALID_BODY, iss }));
      await expect(adapter.authenticate(TOKEN)).resolves.toMatchObject({ userId: "user-uuid-1" });
      return;
    }
    const { diagnosed } = await rejectedWith({ ...VALID_BODY, iss });
    expect(diagnosed[0]).toContain("iss mismatch");
  });

  it('allowedIssuers の "*" はワイルドカードではなく、どの iss にも一致しない', async () => {
    const { diagnosed } = await rejectedWith(VALID_BODY, { allowedIssuers: ["*"] });
    expect(diagnosed[0]).toContain("iss mismatch");
  });

  it('allowedClients に "*" があっても requireAudience の aud 検証は行う', async () => {
    const { aud: _aud, ...noAud } = VALID_BODY;
    const { diagnosed } = await rejectedWith(noAud, {
      allowedClients: ["*"],
      requireAudience: true,
    });
    expect(diagnosed[0]).toContain("aud is missing");
  });

  it.each([" * ", "**", "＊"])('"*" の変種 %s はワイルドカードにならず、通常のクライアント ID として扱う', async (entry) => {
    const { diagnosed } = await rejectedWith({ ...VALID_BODY, azp: "anything" }, { allowedClients: [entry] });
    expect(diagnosed[0]).toContain("azp");
  });

  it('allowedClients "*" は NODE_ENV=production では構築時に拒否する(二重の防御)', () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() =>
        adapterWith(() => jsonResponse(VALID_BODY), { allowedClients: ["*"] }),
      ).toThrow(/disabled in production/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("active が boolean の true 以外(文字列 'false' 等)は不活性として扱う(fail-closed)", async () => {
    const { diagnosed } = await rejectedWith({ ...VALID_BODY, active: "false" });
    expect(diagnosed[0]).toContain("token is not active");
  });

  it("応答が JSON の null や配列なら idp_unavailable(内部エラーにしない)", async () => {
    for (const body of [null, []]) {
      const adapter = adapterWith(() => jsonResponse(body));
      const error = await adapter.authenticate(TOKEN).catch((e) => e);
      expect(error).toBeInstanceOf(IdpError);
      expect((error as IdpError).errorClass).toBe("idp_unavailable");
    }
  });

  it("diagnose は検証項目ごとに最初の 1 件は即時、以降は間隔内で抑制し、次の出力に抑制件数を添える", async () => {
    let now = 1_000_000;
    const diagnosed: string[] = [];
    const adapter = adapterWith(() => jsonResponse({ ...VALID_BODY, typ: "Refresh" }), {
      diagnose: (message) => diagnosed.push(message),
      diagnoseIntervalMs: 1000,
      clock: () => now,
    });
    for (let i = 0; i < 4; i += 1) {
      await adapter.authenticate(TOKEN).catch(() => undefined);
    }
    expect(diagnosed).toHaveLength(1);
    // 別の検証項目(azp)は独立に数える
    const otherAdapterBody = { ...VALID_BODY, azp: "nope" };
    const adapter2 = adapterWith(() => jsonResponse(otherAdapterBody), {
      diagnose: (message) => diagnosed.push(message),
      diagnoseIntervalMs: 1000,
      clock: () => now,
    });
    await adapter2.authenticate(TOKEN).catch(() => undefined);
    expect(diagnosed).toHaveLength(2);
    now += 1000;
    await adapter.authenticate(TOKEN).catch(() => undefined);
    expect(diagnosed).toHaveLength(3);
    expect(diagnosed[2]).toContain('3 more rejection(s) on "typ" suppressed');
  });

  it("allowedClients が空なら構築時に misconfigured", () => {
    expect(() => adapterWith(() => jsonResponse(VALID_BODY), { allowedClients: [] })).toThrow(
      IdpError,
    );
  });

  it("requireAudience: aud(配列)に自分の clientId がなければ拒否", async () => {
    const { diagnosed } = await rejectedWith(
      { ...VALID_BODY, aud: ["account", "other-api"] },
      { requireAudience: true },
    );
    expectDiagnosisIsClaimOnly(diagnosed);
    expect(diagnosed[0]).toContain('aud does not include "gateway"');
  });

  it("requireAudience: aud が文字列でも判定する(一致 / 不一致)", async () => {
    const ok = adapterWith(() => jsonResponse({ ...VALID_BODY, aud: "gateway" }), {
      requireAudience: true,
    });
    await expect(ok.authenticate(TOKEN)).resolves.toMatchObject({ userId: "user-uuid-1" });
    const { diagnosed } = await rejectedWith(
      { ...VALID_BODY, aud: "other-api" },
      { requireAudience: true },
    );
    expect(diagnosed[0]).toContain('aud does not include "gateway"');
  });

  it("requireAudience: aud の欠落は拒否", async () => {
    const { diagnosed } = await rejectedWith(
      { ...VALID_BODY, aud: undefined },
      { requireAudience: true },
    );
    expect(diagnosed[0]).toContain("aud is missing");
  });

  it("requireAudience が false(既定)なら aud は見ない", async () => {
    const adapter = adapterWith(() => jsonResponse({ ...VALID_BODY, aud: "other-api" }));
    await expect(adapter.authenticate(TOKEN)).resolves.toMatchObject({ userId: "user-uuid-1" });
    const missing = adapterWith(() => jsonResponse({ ...VALID_BODY, aud: undefined }));
    await expect(missing.authenticate(TOKEN)).resolves.toMatchObject({ userId: "user-uuid-1" });
  });

  it("検証の順序: active → iss → typ → azp → aud(最初の失敗だけを診断する)", async () => {
    const { diagnosed } = await rejectedWith(
      { ...VALID_BODY, iss: "http://x.test/realms/leisen", typ: "Refresh", azp: "rogue" },
      { requireAudience: true },
    );
    expect(diagnosed).toHaveLength(1);
    expect(diagnosed[0]).toContain("iss mismatch");
  });

  it("checkIntrospection は項目ごとの結果を返す(auth-check 用。active でなければ残りは skipped)", () => {
    const adapter = adapterWith(() => jsonResponse(VALID_BODY), { requireAudience: true });
    expect(adapter.checkIntrospection({ ...VALID_BODY, aud: [...VALID_BODY.aud] }).map((c) => [c.name, c.status])).toEqual([
      ["active", "pass"],
      ["iss", "pass"],
      ["typ", "pass"],
      ["azp", "pass"],
      ["aud", "pass"],
    ]);
    expect(adapter.checkIntrospection({ active: false }).map((c) => c.status)).toEqual([
      "fail",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
    ]);
    const lenient = adapterWith(() => jsonResponse(VALID_BODY), { allowedClients: ["*"] });
    expect(
      lenient.checkIntrospection({ ...VALID_BODY, aud: [...VALID_BODY.aud] }).map((c) => [c.name, c.status]),
    ).toEqual([
      ["active", "pass"],
      ["iss", "pass"],
      ["typ", "pass"],
      ["azp", "skipped"],
      ["aud", "skipped"],
    ]);
    for (const check of adapter.checkIntrospection({ ...VALID_BODY, aud: [...VALID_BODY.aud] })) {
      expect(check.detail).not.toContain(VALID_BODY.sub);
    }
  });
});
