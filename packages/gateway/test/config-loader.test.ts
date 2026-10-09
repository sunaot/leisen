/**
 * ローダー・マイグレーション・秘密情報解決のテスト(T-010)。
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  CURRENT_SCHEMA_VERSION,
  DeploymentConfigError,
  loadDeploymentConfig,
  parseDeploymentConfig,
  resolveIdpAdapterConfig,
  retentionConfigFrom,
  type ConfigMigration,
} from "../src/index.js";

const EXAMPLE_PATH = fileURLToPath(
  new URL("../../../examples/deployment.yaml", import.meta.url),
);
const DEV_EXAMPLE_PATH = fileURLToPath(
  new URL("../../../examples/deployment.dev.yaml", import.meta.url),
);
const KEYCLOAK_EXAMPLE_PATH = fileURLToPath(
  new URL("../../../examples/deployment.keycloak.yaml", import.meta.url),
);

describe("examples/deployment.keycloak.yaml(手元の Keycloak で試す開発用設定。issue #16)", () => {
  it("スキーマ・静的検証を通り、e2e/keycloak の realm と整合する(azp の検証を緩めない)", () => {
    const config = loadDeploymentConfig(KEYCLOAK_EXAMPLE_PATH, {
      capabilities: { "dev-docs": { nativeSearch: "full", ingest: false, privateScopeHandling: "classified" } },
    });
    expect(config.deployment.name).toBe("dev-keycloak");
    expect(config.idp.adapter).toEqual({
      kind: "keycloak",
      baseUrl: "http://localhost:8080",
      realm: "kp",
      clientId: "gateway",
      clientSecretEnv: "KP_KEYCLOAK_CLIENT_SECRET",
      allowedClients: ["e2e-cli"],
      requireAudience: true,
    });
    expect(config.connectors.map((c) => c.id)).toEqual(["dev-docs"]);
    expect(
      resolveIdpAdapterConfig(config.idp.adapter, { KP_KEYCLOAK_CLIENT_SECRET: "dev-only-gateway-secret" }),
    ).toMatchObject({ kind: "keycloak", allowedClients: ["e2e-cli"], requireAudience: true });
  });
});

describe("examples/deployment.dev.yaml(手元で動かす開発用設定)", () => {
  it("スキーマ・静的検証を通り、開発用の部品だけで構成されている", () => {
    const config = loadDeploymentConfig(DEV_EXAMPLE_PATH, {
      capabilities: { "dev-docs": { nativeSearch: "full", ingest: false, privateScopeHandling: "classified" } },
    });
    expect(config.deployment.name).toBe("dev-local");
    expect(config.idp.adapter).toEqual({ kind: "mock" });
    expect(config.gateway.http).toEqual({ host: "127.0.0.1", port: 8787, path: "/mcp" });
    expect(config.connectors).toEqual([
      expect.objectContaining({
        id: "dev-docs",
        kind: "dev-fixture",
        auth: { provider: "mock_env" },
        settings: { corpusFile: "fixtures/dev-corpus.yaml" },
      }),
    ]);
    expect(config.audit.sink).toBe("stdout");
  });
});

describe("examples/deployment.yaml", () => {
  it("同梱サンプルがスキーマ・静的検証を通る", () => {
    const config = loadDeploymentConfig(EXAMPLE_PATH, {
      capabilities: {
        gdrive: { nativeSearch: "full", ingest: false, privateScopeHandling: "classified" },
        slack: { nativeSearch: "degraded", ingest: false, privateScopeHandling: "classified" },
      },
    });
    expect(config.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(config.deployment.name).toBe("example-corp");
    expect(config.connectors.map((c) => c.id)).toEqual(["gdrive", "slack"]);
    // サンプルは安全側の既定を明示している
    expect(config.connectors.every((c) => c.privateScopes === "excluded")).toBe(true);
    expect(config.connectors.every((c) => !c.searchLayer.enabled)).toBe(true);
    expect(config.audit.failureMode).toBe("fail-closed");
    // 本番サンプルは監査をファイルに永続化し、IdP は https(issue #17)
    expect(config.audit.sink).toBe("jsonl");
    expect(config.audit.jsonl?.rawQueryPath).toBeDefined();
    expect(config.idp.adapter.kind === "keycloak" && config.idp.adapter.baseUrl).toMatch(/^https:/);
  });
});

describe("スキーマバージョン移行", () => {
  it("現行より新しいバージョンを拒否する", () => {
    const yaml = `
schemaVersion: ${CURRENT_SCHEMA_VERSION + 1}
deployment:
  name: acme
idp:
  adapter:
    kind: mock
`;
    expect(() => parseDeploymentConfig(yaml)).toThrow(/newer than this build/);
  });

  it("移行関数を順次適用しschemaVersionを増分する", () => {
    const migrations: Record<number, ConfigMigration> = {
      1: (raw) => {
        // 架空の例: v1のtopLevelNameをv2のdeployment.nameへ移動
        const { topLevelName, ...rest } = raw as Record<string, unknown> & {
          topLevelName?: string;
        };
        return { ...rest, deployment: { name: topLevelName } };
      },
    };
    const migrated = applyMigrations(
      { schemaVersion: 1, topLevelName: "acme" },
      { migrations, targetVersion: 2 },
    );
    expect(migrated).toEqual({
      schemaVersion: 2,
      deployment: { name: "acme" },
    });
  });

  it("移行パスがないバージョンを拒否する", () => {
    expect(() =>
      applyMigrations({ schemaVersion: 1 }, { migrations: {}, targetVersion: 2 }),
    ).toThrow(/no migration path/);
  });

  it("トップレベルがマッピングでないYAMLを拒否する", () => {
    expect(() => parseDeploymentConfig("- 1\n- 2\n")).toThrow(
      DeploymentConfigError,
    );
  });
});

describe("resolveIdpAdapterConfig(秘密情報の環境変数解決)", () => {
  const KEYCLOAK_YAML = `
schemaVersion: 1
deployment:
  name: acme
idp:
  adapter:
    kind: keycloak
    baseUrl: http://localhost:8080
    realm: acme
    clientId: kp-gateway
    clientSecretEnv: TEST_KC_SECRET
    allowedClients: [chat-ui]
`;

  it("環境変数から秘密情報を解決する", () => {
    const config = parseDeploymentConfig(KEYCLOAK_YAML);
    const adapter = resolveIdpAdapterConfig(config.idp.adapter, {
      TEST_KC_SECRET: "s3cret",
    });
    expect(adapter).toEqual({
      kind: "keycloak",
      baseUrl: "http://localhost:8080",
      realm: "acme",
      clientId: "kp-gateway",
      clientSecret: "s3cret",
      allowedClients: ["chat-ui"],
      requireAudience: false,
    });
  });

  it("allowedClients は必須で、requireAudience / allowedIssuers はそのまま渡す(issue #16)", () => {
    expect(() =>
      parseDeploymentConfig(KEYCLOAK_YAML.replace("    allowedClients: [chat-ui]\n", "")),
    ).toThrow(/allowedClients/);
    expect(() =>
      parseDeploymentConfig(KEYCLOAK_YAML.replace("[chat-ui]", "[]")),
    ).toThrow(DeploymentConfigError);
    const config = parseDeploymentConfig(
      `${KEYCLOAK_YAML}    requireAudience: true
    allowedIssuers: [https://idp.example.test/realms/acme]
`,
    );
    const adapter = resolveIdpAdapterConfig(config.idp.adapter, { TEST_KC_SECRET: "s3cret" });
    expect(adapter).toMatchObject({
      allowedClients: ["chat-ui"],
      requireAudience: true,
      allowedIssuers: ["https://idp.example.test/realms/acme"],
    });
  });

  it("環境変数未設定はエラーになり、メッセージは変数名のみを含む", () => {
    const config = parseDeploymentConfig(KEYCLOAK_YAML);
    expect(() => resolveIdpAdapterConfig(config.idp.adapter, {})).toThrow(
      /TEST_KC_SECRET/,
    );
  });

  it("clientSecretEnvに環境変数名でない値(秘密の値らしきもの)を拒否し、値をエコーしない", () => {
    const yaml = KEYCLOAK_YAML.replace(
      "clientSecretEnv: TEST_KC_SECRET",
      "clientSecretEnv: hunter2-actual-secret!",
    );
    try {
      parseDeploymentConfig(yaml);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(DeploymentConfigError);
      expect((error as Error).message).not.toContain("hunter2");
      expect((error as Error).message).toContain("environment variable NAME");
    }
  });

  it("DeploymentConfig自体は秘密情報を一切保持しない(不変条件6)", () => {
    const config = parseDeploymentConfig(KEYCLOAK_YAML, {});
    // 設定オブジェクトを丸ごとシリアライズしても秘密の値は現れない
    // (環境変数が設定済みでも、configは変数名しか持たない)
    process.env["TEST_KC_SECRET"] = "s3cret-in-env";
    try {
      expect(JSON.stringify(config)).not.toContain("s3cret-in-env");
    } finally {
      delete process.env["TEST_KC_SECRET"];
    }
  });

  it("mockはそのまま返す", () => {
    const config = parseDeploymentConfig(`
schemaVersion: 1
deployment:
  name: acme
idp:
  adapter:
    kind: mock
`);
    expect(resolveIdpAdapterConfig(config.idp.adapter, {})).toEqual({
      kind: "mock",
    });
  });
});

describe("retentionConfigFrom", () => {
  it("auditセクションをRetentionConfigに写す", () => {
    const config = parseDeploymentConfig(`
schemaVersion: 1
deployment:
  name: acme
idp:
  adapter:
    kind: mock
audit:
  retentionDays: 100
  rawQueryRetentionDays: 7
  telemetryRetentionDays: 3
`);
    expect(retentionConfigFrom(config.audit)).toEqual({
      auditRetentionDays: 100,
      rawQueryRetentionDays: 7,
      telemetryRetentionDays: 3,
    });
  });
});

describe("YAML の構文エラー(issue #38 セキュリティレビュー S1)", () => {
  const textOf = (caught: unknown): string => {
    expect(caught).toBeInstanceOf(DeploymentConfigError);
    const error = caught as DeploymentConfigError & { issues?: unknown };
    return `${error.message} ${JSON.stringify(error.issues ?? null)}`;
  };

  it("エラーコードと位置だけを示し、該当行の内容(誤って書かれた秘密の値など)を含めない", () => {
    const yaml = "schemaVersion: 1\nidp:\n  clientSecret: dev-only-NOT-A-REAL-SECRET: x\n";
    let caught: unknown;
    try {
      parseDeploymentConfig(yaml);
    } catch (error) {
      caught = error;
    }
    const text = textOf(caught);
    expect(text).toMatch(/invalid YAML \(BLOCK_AS_IMPLICIT_KEY at line 3, column \d+\)/);
    expect(text).not.toContain("dev-only-NOT-A-REAL-SECRET");
    expect(text).not.toContain("clientSecret");
  });

  it("アンカー名などファイル由来のトークンも含めない", () => {
    let caught: unknown;
    try {
      parseDeploymentConfig("x: *dev-only-anchor\n");
    } catch (error) {
      caught = error;
    }
    const text = textOf(caught);
    expect(text).toContain("invalid YAML");
    expect(text).not.toContain("dev-only-anchor");
  });
});
