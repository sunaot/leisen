/**
 * Keycloak E2E(T-002)。実行には e2e/keycloak の Keycloak が必要。
 * KEYCLOAK_E2E=1 のときのみ実行される(通常のnpm testではskip)。
 *
 * 検証範囲の限界: このE2Eは「Keycloak発行トークンを受けるモックコネクタ」で
 * あり、Google Drive / Slack等の実SaaS認可経路は検証しない(ADR-010帰結、
 * 詳細は e2e/keycloak/README.md)。
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  ConnectorError,
  type AuthContext,
  type Connector,
  type SearchResult,
} from "@kp/connector-sdk";
import {
  createIdpAdapter,
  IdpError,
  MockCredentialProvider,
  mockTokenEnvVar,
  type IdpAdapter,
} from "../../src/idp/index.js";

const BASE_URL = process.env.KEYCLOAK_BASE_URL ?? "http://localhost:8080";
const REALM = "kp";
const SOURCE_ID = "mock-source";

/** e2e/keycloak/realm/kp-realm.json と対応する開発専用の固定値。 */
const GATEWAY_CLIENT = { id: "gateway", secret: "dev-only-gateway-secret" };
const PASSWORD_GRANT_CLIENT = "e2e-cli";
const USERS = {
  alice: "dev-only-alice-password",
  bob: "dev-only-bob-password",
} as const;

async function passwordGrant(username: keyof typeof USERS): Promise<string> {
  const response = await fetch(
    `${BASE_URL}/realms/${REALM}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: PASSWORD_GRANT_CLIENT,
        username,
        password: USERS[username],
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`password grant failed: ${response.status}`);
  }
  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}

/**
 * E2E用モックコネクタ: AuthContextの受け渡しを検証し、呼び出しユーザーを
 * hitのmetaへ反映する。実SaaSの認可判定は模さない(上記の限界)。
 */
class MockConnector implements Connector {
  readonly sourceId = SOURCE_ID;
  readonly capabilities = { nativeSearch: "full", ingest: false, privateScopeHandling: "classified" } as const;

  async search(auth: AuthContext, query: string): Promise<SearchResult> {
    if (auth.credential.kind !== "oauth_bearer") {
      throw new ConnectorError("invalid_request", "expected oauth_bearer");
    }
    if (!auth.credential.accessToken) {
      throw new ConnectorError("auth_expired", "empty access token");
    }
    return {
      hits: [
        {
          documentId: "doc-1",
          title: `result for ${query}`,
          snippet: "mock snippet",
          url: "https://example.test/doc-1",
          meta: { servedForUser: auth.userId },
          scope: "shared",
        },
      ],
    };
  }

  async fetch(auth: AuthContext, documentId: string) {
    return {
      documentId,
      title: "doc",
      content: `content for ${auth.userId}`,
      url: "https://example.test/doc-1",
      scope: "shared" as const,
    };
  }

  async list() {
    return { entries: [] };
  }

  async describe(auth: AuthContext) {
    return {
      sourceId: this.sourceId,
      displayName: "Mock Source",
      summary: `mock source visible to ${auth.userId}`,
      topContainers: [],
      supportedFilters: [],
    };
  }
}

describe.skipIf(!process.env.KEYCLOAK_E2E)("Keycloak E2E (T-002)", () => {
  let adapter: IdpAdapter;
  const connector = new MockConnector();

  beforeAll(() => {
    process.env[mockTokenEnvVar(SOURCE_ID)] = "dev-only-mock-source-token";
    adapter = createIdpAdapter(
      {
        kind: "keycloak",
        baseUrl: BASE_URL,
        realm: REALM,
        clientId: GATEWAY_CLIENT.id,
        clientSecret: GATEWAY_CLIENT.secret,
      },
      { providers: [new MockCredentialProvider(SOURCE_ID)] },
    );
  });

  it("Keycloak発行トークン→authenticate→getCredential→モックコネクタ呼び出しが通る", async () => {
    const token = await passwordGrant("alice");

    const identity = await adapter.authenticate(token);
    expect(identity.userId).not.toBe("");
    expect(identity.displayName).toContain("Alice");

    const auth = await adapter.getCredential(identity, SOURCE_ID);
    expect(auth.userId).toBe(identity.userId);
    expect(auth.credential.kind).toBe("oauth_bearer");

    const result = await connector.search(auth, "hello");
    expect(result.hits[0]?.meta?.servedForUser).toBe(identity.userId);
  });

  it("不正なトークンはunauthenticated(トークン欠落・改竄の認可分岐)", async () => {
    const error = await adapter
      .authenticate("not-a-real-token")
      .catch((e) => e);
    expect(error).toBeInstanceOf(IdpError);
    expect((error as IdpError).errorClass).toBe("unauthenticated");
  });

  it("別ユーザーは別のuserIdとして分離される(不変条件4の前提)", async () => {
    const aliceIdentity = await adapter.authenticate(
      await passwordGrant("alice"),
    );
    const bobIdentity = await adapter.authenticate(await passwordGrant("bob"));
    expect(aliceIdentity.userId).not.toBe(bobIdentity.userId);

    const aliceAuth = await adapter.getCredential(aliceIdentity, SOURCE_ID);
    const bobAuth = await adapter.getCredential(bobIdentity, SOURCE_ID);
    const aliceResult = await connector.search(aliceAuth, "q");
    const bobResult = await connector.search(bobAuth, "q");
    expect(aliceResult.hits[0]?.meta?.servedForUser).toBe(
      aliceIdentity.userId,
    );
    expect(bobResult.hits[0]?.meta?.servedForUser).toBe(bobIdentity.userId);
  });
});
