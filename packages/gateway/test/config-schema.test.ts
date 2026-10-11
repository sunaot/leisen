/**
 * Deployment Profileスキーマの既定値・拒否のテスト(T-010)。
 * 既定値が「安全側」であることはADR-013の受け入れ条件そのもの。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTHZ_CACHE_TTL_SEC,
  DEFAULT_GATEWAY_HTTP_HOST,
  DEFAULT_GATEWAY_HTTP_PATH,
  DEFAULT_GATEWAY_HTTP_PORT,
  DeploymentConfigError,
  parseDeploymentConfig,
} from "../src/index.js";

const MINIMAL_YAML = `
schemaVersion: 1
deployment:
  name: acme
idp:
  adapter:
    kind: mock
connectors:
  - id: gdrive
`;

describe("deployment config schema defaults", () => {
  it("privateScopesの既定はexcluded(ADR-013 §1)", () => {
    const config = parseDeploymentConfig(MINIMAL_YAML);
    expect(config.connectors[0]?.privateScopes).toBe("excluded");
  });

  it("audit.failureModeの既定はfail-closed(ADR-011)", () => {
    const config = parseDeploymentConfig(MINIMAL_YAML);
    expect(config.audit.failureMode).toBe("fail-closed");
  });

  it("audit.privateScopeDocIdsの既定はhashed(ADR-013 §2)", () => {
    const config = parseDeploymentConfig(MINIMAL_YAML);
    expect(config.audit.privateScopeDocIds).toBe("hashed");
  });

  it("保持期間の既定は365/30/14/90日(ADR-013 §3-4)", () => {
    const config = parseDeploymentConfig(MINIMAL_YAML);
    expect(config.audit.retentionDays).toBe(365);
    expect(config.audit.rawQueryRetentionDays).toBe(30);
    expect(config.audit.telemetryRetentionDays).toBe(14);
    expect(config.chatHistory.retentionDays).toBe(90);
  });

  it("searchLayerの既定はOFF・TTLは既定値(ADR-006、TM-C5)", () => {
    const config = parseDeploymentConfig(MINIMAL_YAML);
    expect(config.connectors[0]?.searchLayer.enabled).toBe(false);
    expect(config.connectors[0]?.searchLayer.authzCacheTtlSec).toBe(
      DEFAULT_AUTHZ_CACHE_TTL_SEC,
    );
  });

  it("agentExecutionの既定はhuman-in-the-loopのみ有効(ADR-015)", () => {
    const config = parseDeploymentConfig(MINIMAL_YAML);
    expect(config.agentExecution.humanInTheLoop.enabled).toBe(true);
    expect(config.agentExecution.scheduled.enabled).toBe(false);
    expect(config.agentExecution.autonomous.enabled).toBe(false);
  });

  it("orchestratorの既定はmaxIterations=6", () => {
    const config = parseDeploymentConfig(MINIMAL_YAML);
    expect(config.orchestrator.maxIterations).toBe(6);
  });

  it("gateway.httpの既定はループバック127.0.0.1:8787の/mcp(T-003)", () => {
    const config = parseDeploymentConfig(MINIMAL_YAML);
    expect(config.gateway.http).toEqual({
      host: DEFAULT_GATEWAY_HTTP_HOST,
      port: DEFAULT_GATEWAY_HTTP_PORT,
      path: DEFAULT_GATEWAY_HTTP_PATH,
    });
    expect(config.gateway.http).toEqual({
      host: "127.0.0.1",
      port: 8787,
      path: "/mcp",
    });
  });

  it("gateway.httpの明示値を受け、省略キーは既定で補う", () => {
    const yaml =
      MINIMAL_YAML + `gateway:\n  http:\n    host: 0.0.0.0\n    path: /kp/mcp\n`;
    const config = parseDeploymentConfig(yaml);
    expect(config.gateway.http).toEqual({
      host: "0.0.0.0",
      port: 8787,
      path: "/kp/mcp",
    });
  });
});

describe("deployment config schema rejection", () => {
  it("未知キー(typo)を拒否する(AT-5)", () => {
    const yaml = MINIMAL_YAML + `audit:\n  failuremode: fail-open\n`;
    expect(() => parseDeploymentConfig(yaml)).toThrow(DeploymentConfigError);
  });

  it("schemaVersion欠落を拒否する", () => {
    const yaml = MINIMAL_YAML.replace("schemaVersion: 1\n", "");
    expect(() => parseDeploymentConfig(yaml)).toThrow(/schemaVersion/);
  });

  it("保持日数0以下を拒否する(事実上の無期限化・即時削除の防止)", () => {
    const yaml = MINIMAL_YAML + `audit:\n  retentionDays: 0\n`;
    expect(() => parseDeploymentConfig(yaml)).toThrow(DeploymentConfigError);
  });

  it("orchestrator.maxIterationsの上限超過を拒否する(TM-D3)", () => {
    const yaml = MINIMAL_YAML + `orchestrator:\n  maxIterations: 21\n`;
    expect(() => parseDeploymentConfig(yaml)).toThrow(DeploymentConfigError);
  });

  it.each([
    ["未知キー(typo)", "gateway:\n  http:\n    prot: 8080\n"],
    ["gateway直下の未知キー", "gateway:\n  sse: true\n"],
    ["port 0(待ち受け先が不定になる)", "gateway:\n  http:\n    port: 0\n"],
    ["port 範囲外", "gateway:\n  http:\n    port: 70000\n"],
    ["pathが/で始まらない", "gateway:\n  http:\n    path: mcp\n"],
    ["pathにクエリ文字列", "gateway:\n  http:\n    path: /mcp?x=1\n"],
    ["死活確認の予約パス", "gateway:\n  http:\n    path: /healthz\n"],
    ["run API の予約パス(ADR-019)", "gateway:\n  http:\n    path: /runs\n"],
    ["接頭辞付きの run API の予約パス", "gateway:\n  http:\n    path: /kp/runs\n"],
    ["空のhost", "gateway:\n  http:\n    host: ''\n"],
  ])("gateway.httpの不正設定を拒否する: %s", (_label, section) => {
    expect(() => parseDeploymentConfig(MINIMAL_YAML + section)).toThrow(
      DeploymentConfigError,
    );
  });

  it("不正YAMLを拒否する", () => {
    expect(() => parseDeploymentConfig("{{{")).toThrow(DeploymentConfigError);
  });

  it("未知のidp adapter kindを拒否する", () => {
    const yaml = MINIMAL_YAML.replace("kind: mock", "kind: okta");
    expect(() => parseDeploymentConfig(yaml)).toThrow(DeploymentConfigError);
  });

  it("複数の不備を1回の起動失敗に集約する", () => {
    const yaml = `
schemaVersion: 1
deployment:
  name: acme
idp:
  adapter:
    kind: mock
connectors:
  - id: a
    privateScopes: included
  - id: a
audit:
  failureMode: fail-open
`;
    try {
      parseDeploymentConfig(yaml);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(DeploymentConfigError);
      const codes = (error as DeploymentConfigError).issues.map((i) => i.code);
      expect(codes).toContain("private_scopes_included_requires_confirmation");
      expect(codes).toContain("duplicate_connector_id");
      expect(codes).toContain("fail_open_requires_confirmation");
    }
  });
});

describe("起動コード向けの項目(connectors[].kind / module / settings / auth、audit.jsonl)", () => {
  function connectorYaml(body: string): string {
    return MINIMAL_YAML.replace("  - id: gdrive\n", `  - id: gdrive\n${body}`);
  }

  function schemaError(yaml: string): DeploymentConfigError {
    try {
      parseDeploymentConfig(yaml);
    } catch (error) {
      expect(error).toBeInstanceOf(DeploymentConfigError);
      return error as DeploymentConfigError;
    }
    throw new Error("expected the config to be rejected");
  }

  it("既定値: kind は id と同じ、settings は {}、module / auth / audit.jsonl はなし", () => {
    const config = parseDeploymentConfig(MINIMAL_YAML);
    const connector = config.connectors[0];
    expect(connector?.kind).toBe("gdrive");
    expect(connector?.settings).toEqual({});
    expect(connector?.module).toBeUndefined();
    expect(connector?.auth).toBeUndefined();
    expect(config.audit.jsonl).toBeUndefined();
  });

  it("明示した kind / module / settings / auth を受ける", () => {
    const config = parseDeploymentConfig(
      connectorYaml(
        "    kind: dev-fixture\n    module: ./plugins/dev.js\n    auth:\n      provider: mock_env\n" +
          "    settings:\n      corpusFile: fixtures/corpus.yaml\n      pageChars: 200\n      nested:\n        maxTokens: 10\n",
      ),
    );
    expect(config.connectors[0]).toMatchObject({
      id: "gdrive",
      kind: "dev-fixture",
      module: "./plugins/dev.js",
      auth: { provider: "mock_env" },
      settings: { corpusFile: "fixtures/corpus.yaml", pageChars: 200, nested: { maxTokens: 10 } },
    });
  });

  it.each([
    ["大文字を含む kind", "    kind: GDrive\n", "connectors.0.kind"],
    ["空白を含む kind", "    kind: my connector\n", "connectors.0.kind"],
    ["URLスキームの module(data:)", "    module: 'data:text/javascript,export default 1'\n", "connectors.0.module"],
    ["URLスキームの module(https:)", "    module: https://example.test/plugin.js\n", "connectors.0.module"],
    ["未知の auth.provider", "    auth:\n      provider: oauth_individual\n", "connectors.0.auth.provider"],
    ["auth の未知キー", "    auth:\n      provider: mock_env\n      token: x\n", "connectors.0.auth"],
    ["settings が mapping でない", "    settings: [1, 2]\n", "connectors.0.settings"],
  ])("不正な値を拒否する: %s", (_label, body, path) => {
    const error = schemaError(connectorYaml(body));
    expect(error.issues.map((i) => i.path)).toContain(path);
  });

  it("module はパッケージ名(サブパス可)と ./ ../ / で始まるパスを受ける", () => {
    for (const module of ["@kp/connector-github", "acme-connector/wiki", "../plugins/x.js", "/opt/kp/x.mjs"]) {
      // "@" で始まる値は YAML では引用符が必要
      const config = parseDeploymentConfig(connectorYaml(`    module: ${JSON.stringify(module)}\n`));
      expect(config.connectors[0]?.module).toBe(module);
    }
  });

  it.each([
    ["accessToken", "    settings:\n      accessToken: dev-only-value-123\n", "connectors.0.settings.accessToken"],
    ["clientSecret(ネスト)", "    settings:\n      oauth:\n        clientSecret: dev-only-value-123\n", "connectors.0.settings.oauth.clientSecret"],
    ["apiKey(配列内)", "    settings:\n      sites:\n        - apiKey: dev-only-value-123\n", "connectors.0.settings.sites.0.apiKey"],
    ["password", "    settings:\n      password: dev-only-value-123\n", "connectors.0.settings.password"],
    ["*Env に秘密の値そのもの", "    settings:\n      apiTokenEnv: dev-only-value-123\n", "connectors.0.settings.apiTokenEnv"],
  ])("settings に秘密情報らしき値を置くと拒否し、値をエコーしない: %s", (_label, body, path) => {
    const error = schemaError(connectorYaml(body));
    expect(error.issues.map((i) => i.path)).toContain(path);
    expect(error.message).not.toContain("dev-only-value-123");
  });

  it("settings の秘密は環境変数名(*Env)で参照できる。秘密でない token 系のキーは受ける", () => {
    const config = parseDeploymentConfig(
      connectorYaml(
        "    settings:\n      apiTokenEnv: KP_ACME_API_TOKEN\n      tokenLifetimeMs: 1000\n      maxTokens: 5\n",
      ),
    );
    expect(config.connectors[0]?.settings).toEqual({
      apiTokenEnv: "KP_ACME_API_TOKEN",
      tokenLifetimeMs: 1000,
      maxTokens: 5,
    });
  });

  it("audit.jsonl は path 必須・rawQueryPath 任意・未知キー拒否", () => {
    const ok = parseDeploymentConfig(
      MINIMAL_YAML + "audit:\n  sink: jsonl\n  jsonl:\n    path: var/audit.jsonl\n    rawQueryPath: var/raw.jsonl\n",
    );
    expect(ok.audit.sink).toBe("jsonl");
    expect(ok.audit.jsonl).toEqual({ path: "var/audit.jsonl", rawQueryPath: "var/raw.jsonl" });

    for (const section of [
      "audit:\n  jsonl:\n    rawQueryPath: raw.jsonl\n",
      "audit:\n  jsonl:\n    path: a.jsonl\n    rotate: true\n",
      "audit:\n  jsonl:\n    path: ''\n",
    ]) {
      expect(() => parseDeploymentConfig(MINIMAL_YAML + section)).toThrow(DeploymentConfigError);
    }
  });

  it("audit.sink は自由文字列のまま(未知の値は起動コードが拒否する)", () => {
    const config = parseDeploymentConfig(MINIMAL_YAML + "audit:\n  sink: syslog\n");
    expect(config.audit.sink).toBe("syslog");
  });
});
