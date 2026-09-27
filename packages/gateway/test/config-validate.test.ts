/**
 * 危険設定の起動時拒否テスト(T-010、threat-model 4-E)。
 * 危険パターンごとに「拒否される」テストと、正当な組合せが「通る」テストを対にする。
 */
import type { ConnectorCapabilities } from "@kp/connector-sdk";
import { describe, expect, it } from "vitest";
import {
  DeploymentConfigError,
  isLoopbackHost,
  MAX_AUTHZ_CACHE_TTL_SEC,
  parseDeploymentConfig,
  validateGatewayHttpExposure,
  type ConfigIssueCode,
} from "../src/index.js";

const CAPABILITIES: Record<string, ConnectorCapabilities> = {
  gdrive: { nativeSearch: "full", ingest: true },
  slack: { nativeSearch: "full", ingest: false },
  fileshare: { nativeSearch: "none", ingest: true },
};

function baseYaml(connectorsYaml: string, extra = ""): string {
  return `
schemaVersion: 1
deployment:
  name: acme
idp:
  adapter:
    kind: mock
connectors:
${connectorsYaml}
${extra}`;
}

function issueCodes(yaml: string): ConfigIssueCode[] {
  try {
    parseDeploymentConfig(yaml, { capabilities: CAPABILITIES });
    return [];
  } catch (error) {
    if (error instanceof DeploymentConfigError) {
      return error.issues.map((i) => i.code);
    }
    throw error;
  }
}

describe("危険設定: 検索層とConnectorCapabilitiesの連動(ADR-007)", () => {
  it("ingest未実装コネクタのsearchLayer有効化を拒否する", () => {
    const yaml = baseYaml(`
  - id: slack
    searchLayer:
      enabled: true
      backend: example-backend
`);
    expect(issueCodes(yaml)).toContain("search_layer_requires_ingest");
  });

  it("ingest実装コネクタのsearchLayer有効化は通る", () => {
    const yaml = baseYaml(`
  - id: gdrive
    searchLayer:
      enabled: true
      backend: example-backend
`);
    expect(issueCodes(yaml)).toEqual([]);
  });

  it("nativeSearch:noneのコネクタはsearchLayer無効だと拒否する(index-required)", () => {
    const yaml = baseYaml(`
  - id: fileshare
`);
    expect(issueCodes(yaml)).toContain("index_required_source_needs_search_layer");
  });

  it("nativeSearch:noneのコネクタもsearchLayer有効とセットなら通る", () => {
    const yaml = baseYaml(`
  - id: fileshare
    searchLayer:
      enabled: true
      backend: example-backend
`);
    expect(issueCodes(yaml)).toEqual([]);
  });

  it("無効化済みコネクタにはcapability連動検証を適用しない", () => {
    const yaml = baseYaml(`
  - id: fileshare
    enabled: false
`);
    expect(issueCodes(yaml)).toEqual([]);
  });

  it("searchLayer有効でbackend未指定を拒否する", () => {
    const yaml = baseYaml(`
  - id: gdrive
    searchLayer:
      enabled: true
`);
    expect(issueCodes(yaml)).toContain("search_layer_backend_missing");
  });

  it("未登録コネクタidを拒否する", () => {
    const yaml = baseYaml(`
  - id: notion
`);
    expect(issueCodes(yaml)).toContain("unknown_connector_id");
  });

  it("capabilities未提供時はcapability連動検証をスキップする", () => {
    const yaml = baseYaml(`
  - id: notion
`);
    expect(() => parseDeploymentConfig(yaml)).not.toThrow();
  });

  it("無効化済みコネクタは実体の登録を要求しない(起動コードは構築しない)", () => {
    const yaml = baseYaml(`
  - id: gdrive
  - id: notion
    enabled: false
`);
    expect(issueCodes(yaml)).toEqual([]);
  });
});

describe("audit.sink: jsonl の出力先(起動コードの監査シンク)", () => {
  it("audit.jsonl.path がなければ拒否する", () => {
    const yaml = baseYaml(
      `
  - id: gdrive
`,
      `audit:
  sink: jsonl
`,
    );
    expect(issueCodes(yaml)).toEqual(["audit_sink_options_missing"]);
  });

  it("audit.jsonl.path があれば通る", () => {
    const yaml = baseYaml(
      `
  - id: gdrive
`,
      `audit:
  sink: jsonl
  jsonl:
    path: var/audit.jsonl
`,
    );
    expect(issueCodes(yaml)).toEqual([]);
  });

  it("stdout 以外の未知の sink は静的検証では拒否しない(起動コードが unknown_audit_sink で拒否する)", () => {
    const yaml = baseYaml(
      `
  - id: gdrive
`,
      `audit:
  sink: syslog
`,
    );
    expect(issueCodes(yaml)).toEqual([]);
  });
});

describe("危険設定: authzCacheTtlSec上限(TM-C5/E3)", () => {
  it("上限超過を拒否する", () => {
    const yaml = baseYaml(`
  - id: gdrive
    searchLayer:
      enabled: true
      backend: example-backend
      authzCacheTtlSec: ${MAX_AUTHZ_CACHE_TTL_SEC + 1}
`);
    expect(issueCodes(yaml)).toContain("schema_violation");
  });

  it("上限ちょうどは通る", () => {
    const yaml = baseYaml(`
  - id: gdrive
    searchLayer:
      enabled: true
      backend: example-backend
      authzCacheTtlSec: ${MAX_AUTHZ_CACHE_TTL_SEC}
`);
    expect(issueCodes(yaml)).toEqual([]);
  });
});

describe("危険設定: audit.failureMode=fail-open(TM-E2、ADR-011)", () => {
  it("確認フラグなしのfail-openを拒否する", () => {
    const yaml = baseYaml(
      `
  - id: gdrive
`,
      `audit:
  failureMode: fail-open
`,
    );
    expect(issueCodes(yaml)).toContain("fail_open_requires_confirmation");
  });

  it("確認フラグ付きのfail-openは通る", () => {
    const yaml = baseYaml(
      `
  - id: gdrive
`,
      `audit:
  failureMode: fail-open
  confirmFailOpen: true
`,
    );
    expect(issueCodes(yaml)).toEqual([]);
  });
});

describe("危険設定: privateScopes=included(TM-E4、ADR-013 §1)", () => {
  it("確認フラグなしのincludedを拒否する", () => {
    const yaml = baseYaml(`
  - id: gdrive
    privateScopes: included
`);
    expect(issueCodes(yaml)).toContain(
      "private_scopes_included_requires_confirmation",
    );
  });

  it("無効化済みコネクタでも確認フラグなしのincludedは拒否する", () => {
    const yaml = baseYaml(`
  - id: gdrive
    enabled: false
    privateScopes: included
`);
    expect(issueCodes(yaml)).toContain(
      "private_scopes_included_requires_confirmation",
    );
  });

  it("確認フラグ付きのincludedは通る", () => {
    const yaml = baseYaml(`
  - id: gdrive
    privateScopes: included
    confirmPrivateScopesIncluded: true
`);
    expect(issueCodes(yaml)).toEqual([]);
  });

  it("consent(本人オプトイン)は確認フラグ不要で通る", () => {
    const yaml = baseYaml(`
  - id: gdrive
    privateScopes: consent
`);
    expect(issueCodes(yaml)).toEqual([]);
  });
});

describe("危険設定: agentExecutionのPhase 1既定拒否(ADR-015)", () => {
  it("scheduledの有効化を拒否する", () => {
    const yaml = baseYaml(
      `
  - id: gdrive
`,
      `agentExecution:
  scheduled:
    enabled: true
`,
    );
    expect(issueCodes(yaml)).toContain("agent_execution_not_allowed_in_phase1");
  });

  it("autonomousの有効化を拒否する", () => {
    const yaml = baseYaml(
      `
  - id: gdrive
`,
      `agentExecution:
  autonomous:
    enabled: true
`,
    );
    expect(issueCodes(yaml)).toContain("agent_execution_not_allowed_in_phase1");
  });

  it("予約フィールドはenabled=falseなら受理する(スキーマ予約の確認)", () => {
    const yaml = baseYaml(
      `
  - id: gdrive
`,
      `agentExecution:
  scheduled:
    enabled: false
    allowedSources: [gdrive]
    credentialTtlSec: 3600
`,
    );
    expect(issueCodes(yaml)).toEqual([]);
  });
});

describe("危険設定: コネクタid重複", () => {
  it("同一idの二重宣言を拒否する", () => {
    const yaml = baseYaml(`
  - id: gdrive
  - id: gdrive
`);
    expect(issueCodes(yaml)).toContain("duplicate_connector_id");
  });
});

describe("危険設定: gateway.http.host の非ループバック待ち受け(T-012、T-003 レビュー minor-11)", () => {
  function httpConfig(http: string) {
    return parseDeploymentConfig(
      baseYaml("  - id: gdrive\n", `gateway:\n  http:\n${http}`),
    );
  }

  it.each([
    "127.0.0.1",
    "127.10.20.30",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "localhost",
    "LocalHost",
  ])("ループバック %s は確認フラグなしで通る", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
    expect(validateGatewayHttpExposure(httpConfig(`    host: "${host}"\n`))).toEqual([]);
  });

  it.each([
    "0.0.0.0",
    "::",
    "192.168.1.10",
    "::ffff:10.0.0.1",
    "gateway.example.test",
    // 省略形の IPv4 やホスト名は名前解決しない(非ループバック扱い=確認を要求する側に倒す)
    "127.1",
  ])("非ループバック %s は確認フラグなしを拒否する", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
    const issues = validateGatewayHttpExposure(httpConfig(`    host: "${host}"\n`));
    expect(issues.map((i) => i.code)).toEqual(["http_host_exposed_requires_confirmation"]);
    expect(issues[0]?.path).toBe("gateway.http.host");
    expect(issues[0]?.message).toContain("TLS");
  });

  it("confirmExposedHost: true なら非ループバックでも通る", () => {
    const config = httpConfig("    host: 0.0.0.0\n    confirmExposedHost: true\n");
    expect(config.gateway.http.confirmExposedHost).toBe(true);
    expect(validateGatewayHttpExposure(config)).toEqual([]);
  });

  it("confirmExposedHost: false は省略と同じ(拒否する)", () => {
    const config = httpConfig("    host: 0.0.0.0\n    confirmExposedHost: false\n");
    expect(validateGatewayHttpExposure(config).map((i) => i.code)).toEqual([
      "http_host_exposed_requires_confirmation",
    ]);
  });

  it("既定(host 省略 = 127.0.0.1)は確認不要で、解析結果に確認フラグを補わない", () => {
    const config = parseDeploymentConfig(baseYaml("  - id: gdrive\n"));
    expect(config.gateway.http.confirmExposedHost).toBeUndefined();
    expect(validateGatewayHttpExposure(config)).toEqual([]);
  });

  it("静的検証(設定の解析)では拒否しない: 待ち受ける起動コードが拒否する", () => {
    expect(
      issueCodes(baseYaml("  - id: gdrive\n", "gateway:\n  http:\n    host: 0.0.0.0\n")),
    ).toEqual([]);
  });

  it("confirmExposedHost の型不正はスキーマで拒否する", () => {
    expect(() => httpConfig('    host: 0.0.0.0\n    confirmExposedHost: "yes"\n')).toThrow(
      DeploymentConfigError,
    );
  });
});
