import { describe, expect, it } from "vitest";
import {
  IdpError,
  KeycloakIdpAdapter,
  type KeycloakIdpAdapterConfig,
} from "../src/idp/index.js";

const BASE_CONFIG: Omit<KeycloakIdpAdapterConfig, "fetchImpl"> = {
  baseUrl: "http://keycloak.test:8080",
  realm: "kp",
  clientId: "gateway",
  clientSecret: "dev-only-secret",
};

function adapterWith(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
): KeycloakIdpAdapter {
  const fetchImpl = (async (url: unknown, init: unknown) =>
    handler(String(url), (init ?? {}) as RequestInit)) as typeof fetch;
  return new KeycloakIdpAdapter({ ...BASE_CONFIG, fetchImpl }, []);
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
        active: true,
        sub: "user-uuid-1",
        preferred_username: "alice",
        exp: 1_700_000_000,
      });
    });

    const identity = await adapter.authenticate("the-access-token");
    expect(requestedUrl).toBe(
      "http://keycloak.test:8080/realms/kp/protocol/openid-connect/token/introspect",
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
    const adapter = adapterWith(() => jsonResponse({ active: true }));
    const error = await adapter.authenticate("odd-token").catch((e) => e);
    expect((error as IdpError).errorClass).toBe("unauthenticated");
  });
});
