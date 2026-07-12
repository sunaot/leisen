/**
 * Gateway組み立て(T-012)のテスト。
 * deployment.yaml 1枚+環境変数からの起動パスと、危険設定・不備設定の
 * 起動時拒否(ADR-005)を検証する。秘密情報の実値は使わない(不変条件6)。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  assembleGateway,
  DeploymentConfigError,
  StdoutDebugAuditSink,
  type AuditSink,
} from "../src/index.js";
import { MockConnector } from "./helpers/proxy.js";

const dir = mkdtempSync(join(tmpdir(), "kp-assemble-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let fileCount = 0;
function configFile(yaml: string): string {
  const path = join(dir, `deployment-${fileCount++}.yaml`);
  writeFileSync(path, yaml, "utf8");
  return path;
}

const MINIMAL_MOCK_YAML = `
schemaVersion: 1
deployment:
  name: assemble-test
idp:
  adapter:
    kind: mock
`;

describe("assembleGateway", () => {
  it("mock IdP・コネクタなしの最小構成で組み立てられる", () => {
    const assembled = assembleGateway({
      configPath: configFile(MINIMAL_MOCK_YAML),
    });
    expect(assembled.config.deployment.name).toBe("assemble-test");
    expect(assembled.gateway.enabledSourceIds()).toEqual([]);
  });

  it("登録済みコネクタが設定と突合され、有効ソースに現れる", () => {
    const yaml = `${MINIMAL_MOCK_YAML}connectors:
  - id: alpha
`;
    const assembled = assembleGateway({
      configPath: configFile(yaml),
      connectors: [new MockConnector("alpha")],
    });
    expect(assembled.gateway.enabledSourceIds()).toEqual(["alpha"]);
  });

  it("実体のないコネクタIDは起動時拒否する(unknown_connector_id)", () => {
    const yaml = `${MINIMAL_MOCK_YAML}connectors:
  - id: ghost
`;
    expect(() =>
      assembleGateway({ configPath: configFile(yaml) }),
    ).toThrowError(DeploymentConfigError);
    try {
      assembleGateway({ configPath: configFile(yaml) });
    } catch (error) {
      expect((error as DeploymentConfigError).issues[0]?.code).toBe(
        "unknown_connector_id",
      );
    }
  });

  it("未登録の監査シンクIDは起動時拒否する(unknown_audit_sink)", () => {
    const yaml = `${MINIMAL_MOCK_YAML}audit:
  sink: fluentd
`;
    try {
      assembleGateway({ configPath: configFile(yaml) });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(DeploymentConfigError);
      const issue = (error as DeploymentConfigError).issues[0];
      expect(issue?.code).toBe("unknown_audit_sink");
      expect(issue?.path).toBe("audit.sink");
    }
  });

  it("auditSinks登録簿で導入固有シンクへ差し替えられる(プラグイン境界)", () => {
    const yaml = `${MINIMAL_MOCK_YAML}audit:
  sink: custom-store
`;
    let created = 0;
    const customSink: AuditSink = new StdoutDebugAuditSink();
    const assembled = assembleGateway({
      configPath: configFile(yaml),
      auditSinks: {
        "custom-store": () => {
          created++;
          return customSink;
        },
      },
    });
    expect(created).toBe(1);
    expect(assembled.config.audit.sink).toBe("custom-store");
  });

  it("keycloak設定でclientSecretの環境変数が未設定なら起動時拒否する", () => {
    const yaml = `
schemaVersion: 1
deployment:
  name: assemble-test
idp:
  adapter:
    kind: keycloak
    baseUrl: http://keycloak:8080
    realm: kp
    clientId: gateway
    clientSecretEnv: KP_TEST_ASSEMBLE_SECRET
`;
    try {
      assembleGateway({ configPath: configFile(yaml), env: {} });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(DeploymentConfigError);
      expect((error as DeploymentConfigError).issues[0]?.code).toBe(
        "secret_env_missing",
      );
      // エラーメッセージに秘密の値を含めない(名前のみ)
      expect((error as DeploymentConfigError).message).toContain(
        "KP_TEST_ASSEMBLE_SECRET",
      );
    }
  });

  it("keycloak設定は環境変数から秘密を解決して組み立てられる", () => {
    const yaml = `
schemaVersion: 1
deployment:
  name: assemble-test
idp:
  adapter:
    kind: keycloak
    baseUrl: http://keycloak:8080
    realm: kp
    clientId: gateway
    clientSecretEnv: KP_TEST_ASSEMBLE_SECRET
`;
    const assembled = assembleGateway({
      configPath: configFile(yaml),
      env: { KP_TEST_ASSEMBLE_SECRET: "dev-only-assemble-secret" },
    });
    expect(assembled.config.idp.adapter.kind).toBe("keycloak");
  });

  it("危険設定(fail-open未確認)は起動時拒否する", () => {
    const yaml = `${MINIMAL_MOCK_YAML}audit:
  failureMode: fail-open
`;
    expect(() =>
      assembleGateway({ configPath: configFile(yaml) }),
    ).toThrowError(DeploymentConfigError);
  });
});
