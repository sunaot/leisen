import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIdpAdapter,
  KeycloakIdpAdapter,
  MockIdpAdapter,
} from "../src/idp/index.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createIdpAdapter", () => {
  it("kind: mock でMockIdpAdapterを生成する", () => {
    const adapter = createIdpAdapter(
      { kind: "mock", sessions: { t: { userId: "alice" } } },
      { providers: [] },
    );
    expect(adapter).toBeInstanceOf(MockIdpAdapter);
  });

  it("kind: keycloak でKeycloakIdpAdapterを生成する", () => {
    const adapter = createIdpAdapter(
      {
        kind: "keycloak",
        baseUrl: "http://localhost:8080",
        realm: "kp",
        clientId: "gateway",
        clientSecret: "dev-only-secret",
        allowedClients: ["chat-ui"],
      },
      { providers: [] },
    );
    expect(adapter).toBeInstanceOf(KeycloakIdpAdapter);
  });

  it("本番(NODE_ENV=production)ではkind: mockを拒否する", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() =>
      createIdpAdapter(
        { kind: "mock", sessions: { t: { userId: "alice" } } },
        { providers: [] },
      ),
    ).toThrow(/disabled in production/);
  });

  it("未知のkindのエラーメッセージに設定内の秘密情報を含めない(不変条件6)", () => {
    const config = {
      kind: "keycloack", // 誤記を想定
      baseUrl: "http://localhost:8080",
      realm: "kp",
      clientId: "gateway",
      clientSecret: "dev-only-should-not-leak",
    } as never;
    const error = (() => {
      try {
        createIdpAdapter(config, { providers: [] });
        return undefined;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).toContain("keycloack");
    expect(error?.message).not.toContain("dev-only-should-not-leak");
  });

  it("同一sourceIdのプロバイダ重複はmisconfigured", () => {
    const provider = {
      sourceId: "gdrive",
      method: "oauth_individual" as const,
      getCredential: async () => ({
        kind: "oauth_bearer" as const,
        accessToken: "t",
        expiresAt: Date.now() + 1000,
      }),
    };
    expect(() =>
      createIdpAdapter(
        { kind: "mock", sessions: {} },
        { providers: [provider, provider] },
      ),
    ).toThrow(/duplicate credential provider/);
  });
});
