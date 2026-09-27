/**
 * リファレンスデプロイ(T-012、deploy/)の設定のテスト。
 *
 * コンテナの起動確認は CI の reference-deploy ジョブが行う(Docker が必要)。ここでは
 * Docker なしで確かめられること — deploy/compose/deployment.yaml が現行スキーマ・静的検証・
 * 起動コードの組み立てを通ること、および compose / .env.example / Dockerfile / Keycloak の
 * realm との食い違い(マウント先・環境変数名・ダミー秘密の一致)がないこと — を固定する。
 * 秘密情報の実値は使わない(.env.example と realm のローカル専用ダミーのみ。不変条件6)。
 */
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import {
  assembleGateway,
  DeploymentConfigError,
  loadDeploymentConfig,
  mockTokenEnvVar,
  parseDeploymentConfig,
  validateGatewayHttpExposure,
  type AssembledGateway,
  type DeploymentConfig,
} from "../src/index.js";

const REPO_DIR = fileURLToPath(new URL("../../../", import.meta.url));
const COMPOSE_DIR = join(REPO_DIR, "deploy", "compose");
const REFERENCE_CONFIG = join(COMPOSE_DIR, "deployment.yaml");
const COMPOSE_FILE = join(COMPOSE_DIR, "docker-compose.yml");
const ENV_EXAMPLE = join(COMPOSE_DIR, ".env.example");
const DOCKERFILE = join(REPO_DIR, "deploy", "Dockerfile");
const REALM_FILE = join(REPO_DIR, "e2e", "keycloak", "realm", "kp-realm.json");
const FIXTURES_DIR = join(REPO_DIR, "examples", "fixtures");

/** イメージの KP_DEPLOYMENT_CONFIG と compose のマウント先 */
const CONTAINER_CONFIG_PATH = "/etc/kp/deployment.yaml";

const opened: AssembledGateway[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const assembled of opened.splice(0)) {
    assembled.httpServer.closeAllConnections();
    await assembled.close().catch(() => undefined);
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function referenceConfig(): DeploymentConfig {
  return loadDeploymentConfig(REFERENCE_CONFIG, {
    capabilities: { "dev-docs": { nativeSearch: "full", ingest: false } },
  });
}

/** .env.example の KEY=VALUE(コメント・空行を除く)。 */
async function envExample(): Promise<Record<string, string>> {
  const entries = (await readFile(ENV_EXAMPLE, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const eq = line.indexOf("=");
      return [line.slice(0, eq), line.slice(eq + 1)] as const;
    });
  return Object.fromEntries(entries);
}

interface ComposeService {
  environment?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
}

async function composeServices(): Promise<Record<string, ComposeService>> {
  const compose = YAML.parse(await readFile(COMPOSE_FILE, "utf8")) as {
    services: Record<string, ComposeService>;
  };
  return compose.services;
}

/** "src:target[:ro]" の target → { source, readOnly } */
function mounts(service: ComposeService): Map<string, { source: string; readOnly: boolean }> {
  return new Map(
    (service.volumes ?? []).map((spec) => {
      const [source = "", target = "", mode] = spec.split(":");
      return [target, { source, readOnly: mode === "ro" }];
    }),
  );
}

describe("deploy/compose/deployment.yaml(リファレンス設定)", () => {
  it("現行スキーマと静的検証を通り、評価用構成(Keycloak + 開発用コネクタ + JSONL 監査)になっている", () => {
    const config = referenceConfig();
    expect(config.idp.adapter).toEqual({
      kind: "keycloak",
      baseUrl: "http://keycloak:8080",
      realm: "kp",
      clientId: "gateway",
      clientSecretEnv: "KP_KEYCLOAK_CLIENT_SECRET",
    });
    expect(config.gateway.http).toEqual({
      host: "0.0.0.0",
      confirmExposedHost: true,
      port: 8787,
      path: "/mcp",
    });
    expect(validateGatewayHttpExposure(config)).toEqual([]);
    expect(config.connectors).toEqual([
      expect.objectContaining({
        id: "dev-docs",
        kind: "dev-fixture",
        auth: { provider: "mock_env" },
        settings: { corpusFile: "/etc/kp/fixtures/dev-corpus.yaml" },
        privateScopes: "excluded",
        searchLayer: expect.objectContaining({ enabled: false }),
      }),
    ]);
    expect(config.audit).toMatchObject({
      sink: "jsonl",
      jsonl: {
        path: "/var/lib/kp/audit/audit.jsonl",
        rawQueryPath: "/var/lib/kp/rawquery/raw-queries.jsonl",
      },
      failureMode: "fail-closed",
      privateScopeDocIds: "hashed",
    });
  });

  it("コンテナ内パスを置き換えれば組み立てられ、/healthz に応答する(Keycloak には未接続)", async () => {
    const root = await mkdtemp(join(tmpdir(), "kp-reference-"));
    tempDirs.push(root);
    const yaml = (await readFile(REFERENCE_CONFIG, "utf8"))
      .replace("/etc/kp/fixtures/", `${FIXTURES_DIR}/`)
      .replaceAll("/var/lib/kp/", `${root}/`);
    await mkdir(join(root, "audit"));
    await mkdir(join(root, "rawquery"));
    const env = await envExample();

    const assembled = await assembleGateway({
      config: parseDeploymentConfig(yaml),
      env,
      configDir: COMPOSE_DIR,
    });
    opened.push(assembled);
    expect(assembled.gateway.enabledSourceIds()).toEqual(["dev-docs"]);
    expect(assembled.auditSinkDescription).toContain(join(root, "audit", "audit.jsonl"));
    expect(assembled.auditSinkDescription).toContain(join(root, "rawquery", "raw-queries.jsonl"));

    assembled.httpServer.listen(0, "127.0.0.1");
    await once(assembled.httpServer, "listening");
    const { port } = assembled.httpServer.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("NODE_ENV=production では開発用の部品(mock_env / dev-fixture)を拒否する(compose が development を指定する理由)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const error = await assembleGateway({
      config: referenceConfig(),
      env: await envExample(),
      configDir: COMPOSE_DIR,
    }).then(
      (assembled) => {
        opened.push(assembled);
        return undefined;
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DeploymentConfigError);
    const issues = (error as DeploymentConfigError).issues;
    expect(issues.filter((i) => i.code === "dev_only_in_production").map((i) => i.path)).toEqual([
      "connectors[0].auth.provider",
      "connectors[0].kind",
    ]);
  });
});

describe("deploy/ の各ファイルの整合", () => {
  it("compose の gateway: 設定・コーパス・監査ボリュームのマウント先が deployment.yaml と一致する", async () => {
    const config = referenceConfig();
    const gateway = (await composeServices())["gateway"];
    expect(gateway).toBeDefined();
    const byTarget = mounts(gateway as ComposeService);

    expect(byTarget.get(CONTAINER_CONFIG_PATH)).toEqual({
      source: "./deployment.yaml",
      readOnly: true,
    });
    const corpusFile = config.connectors[0]?.settings["corpusFile"];
    expect(typeof corpusFile).toBe("string");
    expect(byTarget.get(posix.dirname(corpusFile as string))).toEqual({
      source: "../../examples/fixtures",
      readOnly: true,
    });
    // 監査ログ本体と生クエリ原文は別ボリューム(ADR-011 §3)
    const auditDir = posix.dirname(config.audit.jsonl?.path ?? "");
    const rawQueryDir = posix.dirname(config.audit.jsonl?.rawQueryPath ?? "");
    expect(auditDir).not.toBe(rawQueryDir);
    expect(byTarget.get(auditDir)?.readOnly).toBe(false);
    expect(byTarget.get(rawQueryDir)?.readOnly).toBe(false);
    expect(byTarget.get(auditDir)?.source).not.toBe(byTarget.get(rawQueryDir)?.source);
  });

  it("compose の gateway は設定が参照する環境変数だけを渡し、NODE_ENV=development で起動する", async () => {
    const config = referenceConfig();
    const gateway = (await composeServices())["gateway"] as ComposeService;
    const clientSecretEnv =
      config.idp.adapter.kind === "keycloak" ? config.idp.adapter.clientSecretEnv : "";
    expect(Object.keys(gateway.environment ?? {}).sort()).toEqual(
      ["NODE_ENV", clientSecretEnv, mockTokenEnvVar("dev-docs")].sort(),
    );
    expect(gateway.environment?.["NODE_ENV"]).toBe("development");
    // 秘密は .env からの変数展開のみ(値を compose に書かない)
    expect(gateway.environment?.[clientSecretEnv]).toMatch(/^\$\{KP_KEYCLOAK_CLIENT_SECRET:\?/);
  });

  it("ホストへの公開はループバック(127.0.0.1)だけ", async () => {
    const services = await composeServices();
    const ports = Object.values(services).flatMap((s) => s.ports ?? []);
    expect(ports.length).toBeGreaterThan(0);
    for (const port of ports) {
      expect(port.startsWith("127.0.0.1:")).toBe(true);
    }
  });

  it(".env.example は compose が必須とする変数をすべて持ち、値はローカル専用のダミーだけ", async () => {
    const env = await envExample();
    const compose = await readFile(COMPOSE_FILE, "utf8");
    const required = [...compose.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((m) => m[1]);
    expect(required.length).toBeGreaterThan(0);
    for (const name of required) {
      expect(env[name as string]).toMatch(/^dev-only-/);
    }
    for (const value of Object.values(env)) {
      expect(value).toMatch(/^dev-only-/);
    }
  });

  it(".env.example の Gateway クライアント secret が Keycloak realm(e2e)の値と一致する", async () => {
    const realm = JSON.parse(await readFile(REALM_FILE, "utf8")) as {
      realm: string;
      clients: { clientId: string; secret?: string }[];
    };
    const config = referenceConfig();
    expect(config.idp.adapter.kind).toBe("keycloak");
    if (config.idp.adapter.kind !== "keycloak") return;
    expect(realm.realm).toBe(config.idp.adapter.realm);
    const client = realm.clients.find((c) => c.clientId === config.idp.adapter.clientId);
    expect(client?.secret).toBe((await envExample())[config.idp.adapter.clientSecretEnv]);
  });

  it("Dockerfile の既定の設定パス・監査ボリューム・待ち受けポートが deployment.yaml と一致する", async () => {
    const dockerfile = await readFile(DOCKERFILE, "utf8");
    const config = referenceConfig();
    expect(dockerfile).toContain(`KP_DEPLOYMENT_CONFIG=${CONTAINER_CONFIG_PATH}`);
    expect(dockerfile).toContain(
      `KP_HEALTHCHECK_URL=http://127.0.0.1:${config.gateway.http.port}/healthz`,
    );
    const volume = /^VOLUME \[(.+)\]$/m.exec(dockerfile)?.[1] ?? "";
    const volumes = volume.split(",").map((v) => JSON.parse(v.trim()) as string);
    expect(volumes.sort()).toEqual(
      [
        posix.dirname(config.audit.jsonl?.path ?? ""),
        posix.dirname(config.audit.jsonl?.rawQueryPath ?? ""),
      ].sort(),
    );
    expect(dockerfile).toMatch(/^USER 1000:1000$/m);
  });
});
