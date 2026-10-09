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
  type IdpAdapterConfig,
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

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
}

async function passwordGrantTokens(username: keyof typeof USERS): Promise<TokenResponse> {
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
  return (await response.json()) as TokenResponse;
}

async function passwordGrant(username: keyof typeof USERS): Promise<string> {
  return (await passwordGrantTokens(username)).access_token;
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

/**
 * 受け手・種別・発行者の検証(issue #16)を実環境の値で行う構成。iss は e2e/keycloak の
 * Keycloak(KC_HOSTNAME なし)が BASE_URL から導くため既定(`${baseUrl}/realms/${realm}`)で一致する。
 */
const ADAPTER_CONFIG: IdpAdapterConfig = {
  kind: "keycloak",
  baseUrl: BASE_URL,
  realm: REALM,
  clientId: GATEWAY_CLIENT.id,
  clientSecret: GATEWAY_CLIENT.secret,
  allowedClients: [PASSWORD_GRANT_CLIENT],
  // realm の e2e-cli には Gateway を audience に加えるマッパーがある
  requireAudience: true,
};

describe.skipIf(!process.env.KEYCLOAK_E2E)("Keycloak E2E (T-002)", () => {
  let adapter: IdpAdapter;
  const connector = new MockConnector();

  beforeAll(() => {
    process.env[mockTokenEnvVar(SOURCE_ID)] = "dev-only-mock-source-token";
    adapter = createIdpAdapter(ADAPTER_CONFIG, {
      providers: [new MockCredentialProvider(SOURCE_ID)],
    });
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

  it("リフレッシュトークンは active でも typ が Refresh のため拒否される(issue #16)", async () => {
    const tokens = await passwordGrantTokens("alice");
    expect(tokens.refresh_token).toBeTruthy();
    const diagnosed: string[] = [];
    const strict = createIdpAdapter(ADAPTER_CONFIG, {
      providers: [],
      warn: (message) => diagnosed.push(message),
    });
    const error = await strict.authenticate(tokens.refresh_token ?? "").catch((e) => e);
    expect(error).toBeInstanceOf(IdpError);
    expect((error as IdpError).errorClass).toBe("unauthenticated");
    expect(diagnosed.join("\n")).toContain('typ "Refresh" is not Bearer');
    expect(diagnosed.join("\n")).not.toContain(tokens.refresh_token ?? "");
  });

  it("allowedClients にないクライアント(e2e-cli)が得たトークンは拒否される(issue #16)", async () => {
    // realm のもう1つのクライアント librechat だけを許可し、e2e-cli のトークンを渡す
    const diagnosed: string[] = [];
    const strict = createIdpAdapter(
      { ...ADAPTER_CONFIG, allowedClients: ["librechat"] },
      { providers: [], warn: (message) => diagnosed.push(message) },
    );
    const token = await passwordGrant("alice");
    const error = await strict.authenticate(token).catch((e) => e);
    expect(error).toBeInstanceOf(IdpError);
    expect((error as IdpError).errorClass).toBe("unauthenticated");
    expect(diagnosed.join("\n")).toContain(
      `azp ${JSON.stringify(PASSWORD_GRANT_CLIENT)} is not in allowedClients`,
    );
    expect(diagnosed.join("\n")).not.toContain(token);
    // 同じトークンを許可リストに入れた構成は受け付ける
    await expect(adapter.authenticate(token)).resolves.toMatchObject({ userId: expect.any(String) });
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
