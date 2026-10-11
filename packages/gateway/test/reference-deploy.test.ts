/**
 * リファレンスデプロイ(T-012、deploy/)の設定のテスト。
 *
 * コンテナの起動確認は CI の reference-deploy ジョブが行う(Docker が必要)。ここでは
 * Docker なしで確かめられること — deploy/compose/deployment.yaml が現行スキーマ・静的検証・
 * 起動コードの組み立てを通ること、および compose / .env.example / Dockerfile / Keycloak の
 * realm との食い違い(マウント先・環境変数名・ダミー秘密の一致)がないこと — を固定する。
 * LibreChat overlay(T-021、docker-compose.librechat.yml と deploy/compose/librechat/)も
 * 同じ観点で、orchestrator・LibreChat・Keycloak(realm のクライアント librechat、TLS 終端)の
 * 設定が互いに食い違わないことを確かめる。
 * 秘密情報の実値は使わない(.env.example と realm のローカル専用ダミーのみ。不変条件6)。
 */
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import {
  assembleGateway,
  DeploymentConfigError,
  DEV_ORCHESTRATOR_CREDENTIAL,
  DEV_RUN_ID_KEY_EXAMPLE,
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
const DOCKERIGNORE = join(REPO_DIR, ".dockerignore");
const GITIGNORE = join(REPO_DIR, ".gitignore");
const REALM_FILE = join(REPO_DIR, "e2e", "keycloak", "realm", "kp-realm.json");
const FIXTURES_DIR = join(REPO_DIR, "examples", "fixtures");
/** LibreChat overlay(T-021) */
const LIBRECHAT_COMPOSE_FILE = join(COMPOSE_DIR, "docker-compose.librechat.yml");
const LIBRECHAT_DIR = join(COMPOSE_DIR, "librechat");
const LIBRECHAT_YAML = join(LIBRECHAT_DIR, "librechat.yaml");
const LIBRECHAT_ENV_EXAMPLE = join(LIBRECHAT_DIR, "librechat.env.example");
const CADDYFILE = join(LIBRECHAT_DIR, "Caddyfile");
const ORCHESTRATOR_TSCONFIG = join(REPO_DIR, "packages", "orchestrator", "tsconfig.json");
const ORCHESTRATOR_PROMPTS_DIR = join(REPO_DIR, "packages", "orchestrator", "prompts");
const LIBRECHAT_SMOKE = join(REPO_DIR, "scripts", "smoke", "librechat-smoke.sh");

/**
 * .env.example のうち秘密ではない設定値(LLM の接続先・モデル名)。それ以外の値はすべて
 * ローカル専用のダミーの秘密(dev-only-)であること。
 */
const NON_SECRET_ENV: ReadonlySet<string> = new Set(["KP_LLM_BASE_URL", "KP_LLM_MODEL"]);

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
    capabilities: { "dev-docs": { nativeSearch: "full", ingest: false, privateScopeHandling: "classified" } },
  });
}

/**
 * env ファイルの KEY=VALUE(コメント・空行を除く)。値を囲む二重引用符は外す
 * (docker compose の env_file と同じ解釈)。
 */
async function envFile(path: string): Promise<Record<string, string>> {
  const entries = (await readFile(path, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const eq = line.indexOf("=");
      const value = line.slice(eq + 1);
      const unquoted =
        value.length >= 2 && value.startsWith('"') && value.endsWith('"')
          ? value.slice(1, -1)
          : value;
      return [line.slice(0, eq), unquoted] as const;
    });
  return Object.fromEntries(entries);
}

/** .env.example の KEY=VALUE(コメント・空行を除く)。 */
async function envExample(): Promise<Record<string, string>> {
  return envFile(ENV_EXAMPLE);
}

interface ComposeService {
  image?: string;
  build?: unknown;
  pull_policy?: string;
  entrypoint?: string[];
  command?: string[];
  environment?: Record<string, string>;
  env_file?: string[];
  ports?: string[];
  volumes?: string[];
  /** compose の配列形式(名前だけ)とマップ形式(エイリアス等)のどちらも */
  networks?: string[] | Record<string, { aliases?: string[] } | null>;
  healthcheck?: { test?: string[] };
  cap_drop?: string[];
  security_opt?: string[];
  ulimits?: Record<string, number>;
}

interface ComposeDocument {
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
  networks?: Record<string, { internal?: boolean } | null>;
}

async function composeDocument(file: string = COMPOSE_FILE): Promise<ComposeDocument> {
  return YAML.parse(await readFile(file, "utf8")) as ComposeDocument;
}

async function composeServices(
  file: string = COMPOSE_FILE,
): Promise<Record<string, ComposeService>> {
  return (await composeDocument(file)).services;
}

/** サービスが属するネットワーク(networks を書かなければ compose の default だけ)。 */
function networkNames(service: ComposeService): string[] {
  const networks = service.networks;
  if (networks === undefined) return ["default"];
  return Array.isArray(networks) ? [...networks] : Object.keys(networks);
}

/** マップ形式で書いたネットワークのエイリアス。 */
function networkAliases(service: ComposeService, network: string): string[] {
  const networks = service.networks;
  if (networks === undefined || Array.isArray(networks)) return [];
  return networks[network]?.aliases ?? [];
}

/** LibreChat overlay の1サービス(なければテストを失敗させる)。 */
async function overlayService(name: string): Promise<ComposeService> {
  const service = (await composeServices(LIBRECHAT_COMPOSE_FILE))[name];
  expect(service, `service ${name} in docker-compose.librechat.yml`).toBeDefined();
  return service as ComposeService;
}

/** コマンドライン(配列)の `--name value` の value。 */
function flagValue(command: readonly string[], name: string): string | undefined {
  const index = command.indexOf(name);
  return index >= 0 ? command[index + 1] : undefined;
}

/** healthcheck の test に書いた URL。 */
function healthcheckUrl(service: ComposeService): string | undefined {
  return /https?:\/\/[^'"\s,)]+/.exec((service.healthcheck?.test ?? []).join(" "))?.[0];
}

interface RealmClient {
  clientId: string;
  secret?: string;
  publicClient?: boolean;
  standardFlowEnabled?: boolean;
  implicitFlowEnabled?: boolean;
  directAccessGrantsEnabled?: boolean;
  redirectUris?: string[];
  attributes?: Record<string, string>;
  protocolMappers?: { protocolMapper: string; config?: Record<string, string> }[];
}

async function realmFile(): Promise<{ realm: string; clients: RealmClient[] }> {
  return JSON.parse(await readFile(REALM_FILE, "utf8")) as {
    realm: string;
    clients: RealmClient[];
  };
}

/**
 * LibreChat v0.8.7 のエージェントの機能の名前(packages/data-provider/src/config.ts の
 * AgentCapabilities)。librechat.yaml にこれ以外を書くと、LibreChat は起動時の設定検証で終了する。
 */
const LIBRECHAT_V087_AGENT_CAPABILITIES: ReadonlySet<string> = new Set([
  "hide_sequential_outputs",
  "programmatic_tools",
  "end_after_tools",
  "deferred_tools",
  "execute_code",
  "file_search",
  "web_search",
  "artifacts",
  "subagents",
  "actions",
  "context",
  "skills",
  "tools",
  "chain",
  "ocr",
]);

interface LibreChatConfig {
  version?: string;
  interface?: Record<string, unknown>;
  mcpSettings?: { allowedAddresses?: string[]; allowedDomains?: string[] };
  mcpServers?: Record<
    string,
    {
      type?: string;
      url?: string;
      title?: string;
      headers?: Record<string, string>;
      requiresOAuth?: boolean;
      startup?: boolean;
      serverInstructions?: boolean | string;
    }
  >;
  endpoints?: {
    agents?: { capabilities?: string[] };
    custom?: { name?: string; apiKey?: string; baseURL?: string }[];
  };
}

async function libreChatConfig(): Promise<LibreChatConfig> {
  return YAML.parse(await readFile(LIBRECHAT_YAML, "utf8")) as LibreChatConfig;
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
      // Gateway → Keycloak の区間が compose のサービス間ネットワークだけを通る平文 http の明示確認(issue #17)
      confirmPlainHttp: true,
      realm: "kp",
      clientId: "gateway",
      clientSecretEnv: "KP_KEYCLOAK_CLIENT_SECRET",
      // 発行先クライアントの許可リストと aud の要求(issue #16)。スモーク(e2e-cli)と LibreChat overlay
      allowedClients: ["e2e-cli", "librechat"],
      requireAudience: true,
      // iss は Keycloak の KC_HOSTNAME(基本 / overlay)で固定される公開 URL(baseUrl とは異なる)
      allowedIssuers: [
        "http://localhost:8080/realms/kp",
        "https://keycloak.localhost:8443/realms/kp",
      ],
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
    // 開発用の部品に加えて、.env.example の run API の秘密(公開済みの開発用の値)も拒否される
    expect(
      issues.filter((i) => i.code === "dev_only_in_production").map((i) => i.path).sort(),
    ).toEqual(
      [
        "connectors[0].auth.provider",
        "connectors[0].kind",
        "gateway.runs.signingKeyEnv",
        "gateway.runs.orchestratorCredentialEnv",
      ].sort(),
    );
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
    // run API(ADR-019)の署名鍵・Orchestrator の資格情報・docId の HMAC 鍵は deployment.yaml が
    // 参照する環境変数名(既定)で渡す
    expect(Object.keys(gateway.environment ?? {}).sort()).toEqual(
      [
        "NODE_ENV",
        clientSecretEnv,
        mockTokenEnvVar("dev-docs"),
        config.gateway.runs.signingKeyEnv,
        config.gateway.runs.orchestratorCredentialEnv,
        config.audit.docIdHmacKeyEnv,
      ].sort(),
    );
    expect(gateway.environment?.["NODE_ENV"]).toBe("development");
    // 秘密は .env からの変数展開のみ(値を compose に書かない。未設定なら起動前に止まる)
    expect(gateway.environment?.[clientSecretEnv]).toMatch(/^\$\{KP_KEYCLOAK_CLIENT_SECRET:\?/);
    for (const name of [
      config.gateway.runs.signingKeyEnv,
      config.gateway.runs.orchestratorCredentialEnv,
      config.audit.docIdHmacKeyEnv,
    ]) {
      expect(gateway.environment?.[name], name).toBe(
        `\${${name}:?set it in deploy/compose/.env (cp .env.example .env)}`,
      );
    }
  });

  it(".env.example の run API の秘密は公開済みの開発用の値で、NODE_ENV=production では起動を拒否される値そのもの", async () => {
    const config = referenceConfig();
    const env = await envExample();
    // 雛形の値をそのまま本番に持ち込めないよう、起動コードが知っている開発用の値と一致させる
    // (一致しない任意の値だと production で拒否できない)
    expect(env[config.gateway.runs.signingKeyEnv]).toBe(DEV_RUN_ID_KEY_EXAMPLE);
    expect(env[config.gateway.runs.orchestratorCredentialEnv]).toBe(DEV_ORCHESTRATOR_CREDENTIAL);
    // 署名鍵の例は base64url として復号でき、下限(32 バイト)を満たす
    expect(Buffer.from(DEV_RUN_ID_KEY_EXAMPLE, "base64url").byteLength).toBeGreaterThanOrEqual(32);
  });

  it("ホストへの公開はループバック(127.0.0.1)だけ(LibreChat overlay を含む)", async () => {
    for (const file of [COMPOSE_FILE, LIBRECHAT_COMPOSE_FILE]) {
      const services = await composeServices(file);
      const ports = Object.values(services).flatMap((s) => s.ports ?? []);
      expect(ports.length).toBeGreaterThan(0);
      for (const port of ports) {
        expect(port.startsWith("127.0.0.1:"), `${file}: ${port}`).toBe(true);
      }
    }
  });

  it(".env.example は compose(基本・LibreChat overlay)が参照する変数をすべて持ち、秘密の値はローカル専用のダミーだけ", async () => {
    const env = await envExample();
    for (const file of [COMPOSE_FILE, LIBRECHAT_COMPOSE_FILE]) {
      const compose = await readFile(file, "utf8");
      const required = [...compose.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((m) => m[1] as string);
      expect(required.length).toBeGreaterThan(0);
      // 既定値付き(${VAR:-…})の変数も雛形に書いておく(変更点が分かるように)
      const referenced = [...compose.matchAll(/\$\{([A-Z0-9_]+)[:}]/g)].map((m) => m[1] as string);
      for (const name of referenced) {
        expect(env[name], `${name} (${file})`).toBeDefined();
      }
      for (const name of required) {
        expect(env[name], `${name} (${file})`).not.toBe("");
      }
    }
    for (const [name, value] of Object.entries(env)) {
      if (NON_SECRET_ENV.has(name)) continue;
      expect(value, name).toMatch(/^dev-only-/);
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
    const adapter = config.idp.adapter;
    expect(realm.realm).toBe(adapter.realm);
    const client = realm.clients.find((c) => c.clientId === adapter.clientId);
    expect(client?.secret).toBe((await envExample())[adapter.clientSecretEnv]);
  });

  it("allowedClients の各クライアントは realm にあり、requireAudience のための audience マッパーを持つ。allowedIssuers は基本・overlay の KC_HOSTNAME と一致する(issue #16)", async () => {
    const realm = await realmFile();
    const config = referenceConfig();
    if (config.idp.adapter.kind !== "keycloak") throw new Error("unexpected idp adapter");
    const adapter = config.idp.adapter;
    expect(adapter.allowedClients).not.toContain("*");
    for (const clientId of adapter.allowedClients) {
      const client = realm.clients.find((c) => c.clientId === clientId);
      expect(client, `realm client ${clientId}`).toBeDefined();
      const audience = client?.protocolMappers?.find(
        (m) => m.protocolMapper === "oidc-audience-mapper",
      );
      expect(audience?.config?.["included.client.audience"], clientId).toBe(adapter.clientId);
      expect(audience?.config?.["access.token.claim"], clientId).toBe("true");
      expect(audience?.config?.["introspection.token.claim"], clientId).toBe("true");
    }
    expect(adapter.requireAudience).toBe(true);
    const base = (await composeServices())["keycloak"]?.environment?.["KC_HOSTNAME"];
    const overlay = (await overlayService("keycloak")).environment?.["KC_HOSTNAME"];
    expect(adapter.allowedIssuers).toEqual([
      `${base}/realms/${realm.realm}`,
      `${overlay}/realms/${realm.realm}`,
    ]);
  });

  it("Dockerfile の既定の設定パス・監査ボリューム・待ち受けポートが deployment.yaml に一致する(AnswerRun のボリュームは持たない)", async () => {
    const dockerfile = await readFile(DOCKERFILE, "utf8");
    const config = referenceConfig();
    expect(dockerfile).toContain(`KP_DEPLOYMENT_CONFIG=${CONTAINER_CONFIG_PATH}`);
    expect(dockerfile).toContain(
      `KP_HEALTHCHECK_URL=http://127.0.0.1:${config.gateway.http.port}/healthz`,
    );
    // 監査ログ本体・生クエリ原文は別ボリューム(ADR-011 §3)。監査ストアに書くのは Gateway だけ
    // (ADR-019)なので、Orchestrator 用の AnswerRun のボリュームはイメージにない
    const volume = /^VOLUME \[(.+)\]$/m.exec(dockerfile)?.[1] ?? "";
    const volumes = volume.split(",").map((v) => JSON.parse(v.trim()) as string);
    expect(volumes.sort()).toEqual(
      [
        posix.dirname(config.audit.jsonl?.path ?? ""),
        posix.dirname(config.audit.jsonl?.rawQueryPath ?? ""),
      ].sort(),
    );
    expect(dockerfile).not.toContain("answer-runs");
    // 各ディレクトリは実行ユーザー所有・0700 でイメージが用意する(Gateway はディレクトリを
    // 作らない。空の名前付きボリュームは初回マウント時に所有者・権限を引き継ぐ)
    const prepare =
      /^RUN mkdir -p (.+?) \\\n\s+&& chown 1000:1000 (.+?) \\\n\s+&& chmod 0700 (.+?)$/m.exec(
        dockerfile,
      );
    expect(prepare).not.toBeNull();
    const [, created = "", owned = "", restricted = ""] = prepare ?? [];
    for (const dir of volumes) {
      expect(created.split(" "), `mkdir ${dir}`).toContain(dir);
      expect(owned.split(" "), `chown ${dir}`).toContain(dir);
      expect(restricted.split(" "), `chmod ${dir}`).toContain(dir);
    }
    expect(dockerfile).toMatch(/^USER 1000:1000$/m);
  });
});

describe("deploy/compose の LibreChat overlay(T-021、ADR-018)", () => {
  it("イメージは orchestrator の本番依存・dist・prompts を含み、.dockerignore は prompts をビルドコンテキストに戻す", async () => {
    const dockerfile = await readFile(DOCKERFILE, "utf8");
    const runtimeStart = dockerfile.indexOf(" AS runtime");
    expect(runtimeStart).toBeGreaterThan(0);
    const runtime = dockerfile.slice(runtimeStart);
    // runtime に置く workspace は、manifest(本番依存の npm ci 用)と dist を必ず対でコピーする
    const manifests = [...runtime.matchAll(/^COPY packages\/([a-z-]+)\/package\.json /gm)].map(
      (m) => m[1] as string,
    );
    expect(manifests).toContain("orchestrator");
    for (const name of manifests) {
      expect(runtime).toContain(
        `COPY --from=build /app/packages/${name}/dist packages/${name}/dist`,
      );
    }
    // system prompt の固定部は実行時に dist/ から ../prompts/ として読まれる
    expect(runtime).toContain(
      "COPY --from=build /app/packages/orchestrator/prompts packages/orchestrator/prompts",
    );
    const prompts = (await readdir(ORCHESTRATOR_PROMPTS_DIR)).filter((f) => f.endsWith(".md"));
    expect(prompts.length).toBeGreaterThan(0);

    // .dockerignore は後の行が優先。**/*.md の除外より後で prompts を戻す
    const ignoreLines = (await readFile(DOCKERIGNORE, "utf8"))
      .split("\n")
      .map((line) => line.trim());
    const excludeMarkdown = ignoreLines.indexOf("**/*.md");
    const includePrompts = ignoreLines.indexOf("!packages/orchestrator/prompts/*.md");
    expect(excludeMarkdown).toBeGreaterThanOrEqual(0);
    expect(includePrompts).toBeGreaterThan(excludeMarkdown);

    // overlay のエントリポイントは kp-ask のビルド成果物(src/bin/kp-ask.ts → dist/bin/kp-ask.js)。
    // npm の bin シム(bin/kp-ask.js)はイメージに入れないため、dist を直接起動する
    // (Dockerfile の ENTRYPOINT が packages/gateway/dist/bin/kp-gateway.js を起動するのと同じ)
    const orchestrator = await overlayService("orchestrator");
    const tsconfig = JSON.parse(await readFile(ORCHESTRATOR_TSCONFIG, "utf8")) as {
      compilerOptions?: { outDir?: string; rootDir?: string };
    };
    const outDir = posix.join("packages/orchestrator", tsconfig.compilerOptions?.outDir ?? "dist");
    const entry = orchestrator.entrypoint?.[1] ?? "";
    expect(orchestrator.entrypoint?.[0]).toBe("node");
    expect(entry.startsWith(`${outDir}/`)).toBe(true);
    const source = join(
      REPO_DIR,
      "packages",
      "orchestrator",
      tsconfig.compilerOptions?.rootDir ?? "src",
      posix.relative(outDir, entry).replace(/\.js$/, ".ts"),
    );
    await expect(readFile(source, "utf8")).resolves.toContain("serve");
  });

  it("orchestrator は gateway と同じイメージを kp-ask serve で動かし、設定は Gateway と同じ・監査ストアには書かない(run は Gateway の run API に申告する)", async () => {
    const config = referenceConfig();
    const gateway = (await composeServices())["gateway"] as ComposeService;
    const orchestrator = await overlayService("orchestrator");
    const command = orchestrator.command ?? [];

    // 同じイメージ(ビルドは gateway 側だけ。pull はしない)
    expect(orchestrator.image).toBe(gateway.image);
    expect(orchestrator.build).toBeUndefined();
    expect(orchestrator.pull_policy).toBe("never");
    expect(command[0]).toBe("serve");

    // Gateway はネットワーク内のサービス名 + deployment.yaml の port / path
    expect(flagValue(command, "--gateway")).toBe(
      `http://gateway:${config.gateway.http.port}${config.gateway.http.path}`,
    );
    // 設定は Gateway と同じファイルを同じパスに読み取り専用で
    expect(flagValue(command, "--config")).toBe(CONTAINER_CONFIG_PATH);
    expect(mounts(orchestrator).get(CONTAINER_CONFIG_PATH)).toEqual({
      source: "./deployment.yaml",
      readOnly: true,
    });

    // 監査ストアに書くのは Gateway だけ(ADR-019)。orchestrator がマウントするのは設定(読み取り
    // 専用)だけで、Gateway の監査ログ・生クエリ原文のボリュームも、AnswerRun 用のボリュームも
    // マウントしない(Orchestrator は TB2 で信頼しない側。侵害・誤動作しても Gateway の監査ログを
    // 読めない・書き換えられない。threat-model TM-I4)
    expect(command).not.toContain("--answer-run-jsonl");
    const orchestratorMounts = mounts(orchestrator);
    expect([...orchestratorMounts.keys()]).toEqual([CONTAINER_CONFIG_PATH]);
    const gatewayAuditDirs = [
      posix.dirname(config.audit.jsonl?.path ?? ""),
      posix.dirname(config.audit.jsonl?.rawQueryPath ?? ""),
    ];
    for (const dir of gatewayAuditDirs) {
      const gatewayVolume = mounts(gateway).get(dir)?.source;
      expect(gatewayVolume).toBeDefined();
      expect([...orchestratorMounts.values()].map((m) => m.source)).not.toContain(gatewayVolume);
    }
    // overlay は AnswerRun のボリュームを定義しない
    const overlay = await composeDocument(LIBRECHAT_COMPOSE_FILE);
    expect(Object.keys(overlay.volumes ?? {})).not.toContain("kp-answer-runs");
    expect(await readFile(LIBRECHAT_COMPOSE_FILE, "utf8")).not.toContain("answer-runs");

    // 待ち受けはコンテナ内の全インターフェース → 確認フラグが要る。公開・healthcheck と同じポート
    const [listenHost, listenPort] = (flagValue(command, "--listen") ?? "").split(":");
    expect(listenHost).toBe("0.0.0.0");
    expect(command).toContain("--confirm-exposed-host");
    expect(orchestrator.ports).toEqual([`127.0.0.1:${listenPort}:${listenPort}`]);
    expect(healthcheckUrl(orchestrator)).toBe(`http://127.0.0.1:${listenPort}/healthz`);
    expect(flagValue(command, "--path")).toBe("/mcp");
    expect(flagValue(command, "--max-concurrent-runs")).toBe("4");
    expect(flagValue(command, "--max-question-chars")).toBe("4000");
    expect(flagValue(command, "--llm")).toBe("openai-compatible");
    // 上流(Gateway と既定の LLM = ホストの LM Studio)は非ループバックの平文 http。評価用に明示で
    // 許可する(このフラグは NODE_ENV=production では拒否される。下の NODE_ENV=development と対)
    const llmBaseUrl = /:-([^}]+)\}$/.exec(
      orchestrator.environment?.["KP_LLM_BASE_URL"] ?? "",
    )?.[1];
    expect(new URL(llmBaseUrl ?? "").protocol).toBe("http:");
    expect(new URL(flagValue(command, "--gateway") ?? "").protocol).toBe("http:");
    expect(command).toContain("--allow-insecure-upstream");

    // 秘密は .env からの変数展開のみ。開発用の部品を含む評価用構成なので development
    expect(orchestrator.environment?.["NODE_ENV"]).toBe("development");
    expect(orchestrator.environment?.["KP_LLM_MODEL"]).toMatch(/^\$\{KP_LLM_MODEL:\?/);
    // Orchestrator の資格情報は gateway と同じ変数(同じ値)を両方に渡す。runId の署名鍵と docId の
    // HMAC 鍵は Gateway だけが持ち、orchestrator には渡さない(ADR-019)
    const credentialEnv = config.gateway.runs.orchestratorCredentialEnv;
    expect(orchestrator.environment?.[credentialEnv]).toMatch(/^\$\{KP_ORCHESTRATOR_CREDENTIAL:\?/);
    expect(orchestrator.environment?.[credentialEnv]).toBe(gateway.environment?.[credentialEnv]);
    expect(orchestrator.environment).not.toHaveProperty(config.gateway.runs.signingKeyEnv);
    expect(orchestrator.environment).not.toHaveProperty(config.gateway.runs.previousSigningKeyEnv);
    expect(orchestrator.environment).not.toHaveProperty(config.audit.docIdHmacKeyEnv);
    // LibreChat(UI)は Orchestrator の資格情報を持たない(持つのは kp-ask serve だけ)
    const librechat = await overlayService("librechat");
    expect(librechat.environment).not.toHaveProperty(credentialEnv);
    expect(await envFile(LIBRECHAT_ENV_EXAMPLE)).not.toHaveProperty(credentialEnv);
    // Gateway と同じ実行時の制限(コアダンプにトークンを残さない等)
    expect(orchestrator.ulimits?.["core"]).toBe(0);
    expect(orchestrator.cap_drop).toEqual(["ALL"]);
    expect(orchestrator.security_opt).toContain("no-new-privileges:true");
  });

  it("librechat.yaml の MCP サーバーは orchestrator を指し、利用者本人の OpenID アクセストークンを転送する", async () => {
    const lc = await libreChatConfig();
    const orchestrator = await overlayService("orchestrator");
    const command = orchestrator.command ?? [];
    const listenPort = (flagValue(command, "--listen") ?? "").split(":")[1];

    const server = lc.mcpServers?.["leisen"];
    expect(server).toBeDefined();
    expect(server?.type).toBe("streamable-http");
    expect(server?.url).toBe(`http://orchestrator:${listenPort}${flagValue(command, "--path")}`);
    // 本人トークンの直接転送(ADR-018 決定8)。OAuth の検出・起動時の接続はしない
    expect(server?.headers).toEqual({ Authorization: "Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}" });
    expect(server?.requiresOAuth).toBe(false);
    expect(server?.startup).toBe(false);
    expect(server?.serverInstructions).toBe(true);
    // LibreChat の設定検証は title に英数字と空白しか許さない(違反すると起動しない)
    expect(server?.title).toMatch(/^[a-zA-Z0-9 ]+$/);
    // MCP の接続先は Orchestrator の origin だけ。LibreChat v0.8.7 の allowedDomains は接続先の
    // 許可リスト(スキーム・ホスト・ポートを照合)で、未設定だと公開ホストへはすべて接続できる。
    // allowedAddresses は私設 IP 宛ての SSRF 防御の例外にすぎず、allowedDomains を設定すると MCP の
    // 判定では参照されない(packages/api/src/auth/domain.ts)ので書かない
    expect(lc.mcpSettings?.allowedDomains).toEqual([new URL(server?.url ?? "").origin]);
    expect(lc.mcpSettings).not.toHaveProperty("allowedAddresses");

    // UI 側の LLM の API キーは環境変数から(librechat.yaml に秘密を書かない)
    const endpoint = lc.endpoints?.custom?.[0];
    expect(endpoint?.apiKey).toMatch(/^\$\{[A-Z0-9_]+\}$/);
    const libreChatEnv = await envFile(LIBRECHAT_ENV_EXAMPLE);
    const apiKeyEnv = /^\$\{([A-Z0-9_]+)\}$/.exec(endpoint?.apiKey ?? "")?.[1] ?? "";
    expect(libreChatEnv[apiKeyEnv]).toMatch(/^dev-only-/);
    const baseUrlEnv = /^\$\{([A-Z0-9_]+)\}$/.exec(endpoint?.baseURL ?? "")?.[1] ?? "";
    const librechat = await overlayService("librechat");
    expect(librechat.environment?.[baseUrlEnv]).toBe(orchestrator.environment?.[baseUrlEnv]);
  });

  it("UI 側の LLM が呼べる外部のツールは Orchestrator だけ(MCP サーバーの追加なし、Actions・Web 検索・コード実行なし)", async () => {
    const lc = await libreChatConfig();
    // 利用者は定義済みの MCP サーバー(leisen)を使えるが、追加・共有できない。v0.8.7 はここに書いた
    // 値を起動のたびに USER / ADMIN の両ロールへ適用する(packages/api/src/app/permissions.ts)
    expect(lc.interface?.["mcpServers"]).toEqual({
      use: true,
      create: false,
      share: false,
      public: false,
    });
    // 本人トークンを転送する MCP サーバーは Orchestrator の定義だけ(接続先は上の allowedDomains)
    expect(Object.keys(lc.mcpServers ?? {})).toEqual(["leisen"]);

    // エージェント(MCP サーバーを選んだ通常の会話も含む)の機能。一覧にない機能はサーバー側で
    // 実行されない(api/server/services/ToolService.js)。MCP のツールには tools が要る
    const capabilities = lc.endpoints?.agents?.capabilities ?? [];
    expect(capabilities).toContain("tools");
    // 会話の内容を外部のサービスへ送る機能は外す(利用者定義の外部 API、Web 検索、コード実行)
    for (const external of ["actions", "web_search", "execute_code"]) {
      expect(capabilities, external).not.toContain(external);
    }
    // v0.8.7 の設定検証が受け付ける名前だけ(誤記すると LibreChat が起動しない)
    for (const capability of capabilities) {
      expect(LIBRECHAT_V087_AGENT_CAPABILITIES.has(capability), capability).toBe(true);
    }
  });

  it("librechat.yaml の履歴の保持期間は deployment.yaml の chatHistory.retentionDays と同じ(v0.8.7 の意味で)", async () => {
    const lc = await libreChatConfig();
    const config = referenceConfig();
    const librechat = await overlayService("librechat");
    // 安定版のリリースタグに固定する(rc・latest にしない)。版を上げたら下の保持期間の
    // 項目(v0.8.8 以降は generalChatRetention で通常の会話の期限を分けられる)を見直す
    expect(librechat.image).toBe("ghcr.io/librechat-ai/librechat:v0.8.7");
    expect(lc.version).toBe("1.3.13");
    // v0.8.7 の retentionMode: all は、すべての会話に temporaryChatRetention(時間)の期限を付ける
    expect(lc.interface?.["retentionMode"]).toBe("all");
    expect(lc.interface?.["temporaryChatRetention"]).toBe(config.chatHistory.retentionDays * 24);
    // v0.8.7 の設定スキーマにない項目は黙って無視される(保持期間が意図とずれる)ため書かない
    expect(lc.interface).not.toHaveProperty("generalChatRetention");
    expect(lc.interface).not.toHaveProperty("feedback");
  });

  it("librechat.env.example の OpenID 設定は realm のクライアント librechat と overlay の Keycloak にそろい、値はダミーだけ", async () => {
    const env = await envFile(LIBRECHAT_ENV_EXAMPLE);
    const realm = await realmFile();
    const config = referenceConfig();
    const keycloak = await overlayService("keycloak");
    const librechat = await overlayService("librechat");

    // 発行者 = overlay の Keycloak の KC_HOSTNAME + realm(LibreChat は https を要求する)
    const hostname = keycloak.environment?.["KC_HOSTNAME"] ?? "";
    expect(hostname).toMatch(/^https:\/\//);
    expect(env["OPENID_ISSUER"]).toBe(`${hostname}/realms/${realm.realm}`);

    const client = realm.clients.find((c) => c.clientId === env["OPENID_CLIENT_ID"]);
    expect(client).toBeDefined();
    expect(client?.publicClient).toBe(false);
    expect(client?.secret).toBe(env["OPENID_CLIENT_SECRET"]);
    expect(client?.standardFlowEnabled).toBe(true);
    // ブラウザのログイン(認可コード)だけ。パスワードグラントは開発用の e2e-cli に限る
    expect(client?.directAccessGrantsEnabled).toBe(false);
    expect(client?.implicitFlowEnabled).toBe(false);
    // リダイレクト先はコールバックの完全一致だけ(ワイルドカードを使わない)。LibreChat v0.8.7 は
    // DOMAIN_SERVER + OPENID_CALLBACK_URL を redirect_uri に使う(api/strategies/openidStrategy.js)
    const callback = `${env["DOMAIN_SERVER"]}${env["OPENID_CALLBACK_URL"]}`;
    expect(client?.redirectUris).toEqual([callback]);
    // ログアウト後の戻り先も完全一致の1つだけ。v0.8.7 は OPENID_POST_LOGOUT_REDIRECT_URI、未設定なら
    // DOMAIN_CLIENT + /login を送る(api/server/controllers/auth/LogoutController.js)
    const postLogout = env["OPENID_POST_LOGOUT_REDIRECT_URI"] ?? `${env["DOMAIN_CLIENT"]}/login`;
    expect(client?.attributes?.["post.logout.redirect.uris"]).toBe(postLogout);
    expect([callback, postLogout].join(" ")).not.toContain("*");
    // 認可コードフローは PKCE(S256)必須。LibreChat 側も明示する(v0.8.7 の openid-client 6.5.0 は
    // この値によらず常に S256 のコードチャレンジを送る)
    expect(client?.attributes?.["pkce.code.challenge.method"]).toBe("S256");
    expect(env["OPENID_USE_PKCE"]).toBe("true");
    // Gateway が aud を検証するようになったときのため、Gateway を audience に加える(決定8)
    if (config.idp.adapter.kind !== "keycloak") throw new Error("unexpected idp adapter");
    const gatewayClientId = config.idp.adapter.clientId;
    const audience = client?.protocolMappers?.find(
      (m) => m.protocolMapper === "oidc-audience-mapper",
    );
    expect(audience?.config?.["included.client.audience"]).toBe(gatewayClientId);
    expect(audience?.config?.["access.token.claim"]).toBe("true");
    expect(realm.clients.some((c) => c.clientId === gatewayClientId)).toBe(true);

    // 本人トークンの再利用が MCP の Authorization ヘッダ転送の前提
    expect(env["OPENID_REUSE_TOKENS"]).toBe("true");
    // DOMAIN_SERVER はホストへ公開したポート
    const publishedPort = (librechat.ports?.[0] ?? "").split(":")[1];
    expect(env["DOMAIN_SERVER"]).toBe(`http://localhost:${publishedPort}`);
    // 回答の共有リンクは作らせない(threat-model TM-G4)
    expect(env["ALLOW_SHARED_LINKS"]).toBe("false");

    // 秘密はダミーだけ(不変条件6)。CREDS_* は形式(16 進 64 桁 / 32 桁)を満たす作り物の列
    for (const name of [
      "OPENID_CLIENT_SECRET",
      "OPENID_SESSION_SECRET",
      "JWT_SECRET",
      "JWT_REFRESH_SECRET",
      "LIBRECHAT_LLM_API_KEY",
    ]) {
      expect(env[name], name).toMatch(/^dev-only-/);
    }
    expect(env["CREDS_KEY"]).toBe("0123456789abcdef".repeat(4));
    expect(env["CREDS_IV"]).toBe("0123456789abcdef".repeat(2));

    // 雛形から作る librechat.env は git 管理外
    const gitignore = (await readFile(GITIGNORE, "utf8")).split("\n").map((line) => line.trim());
    expect(gitignore).toContain("deploy/compose/librechat/librechat.env");
    expect(librechat.env_file).toEqual(["./librechat/librechat.env"]);
  });

  it("発行者の URL・TLS 終端(keycloak-tls)のエイリアスと公開ポート・LibreChat が信頼する CA がそろう", async () => {
    const base = await composeServices();
    const keycloak = await overlayService("keycloak");
    const tls = await overlayService("keycloak-tls");
    const librechat = await overlayService("librechat");
    const hostname = new URL(keycloak.environment?.["KC_HOSTNAME"] ?? "");

    // ブラウザとコンテナが同じ名前で TLS 終端に届く(エイリアス + ループバックの同じポート)
    expect(networkAliases(tls, "default")).toContain(hostname.hostname);
    expect(tls.ports).toEqual([`127.0.0.1:${hostname.port}:${hostname.port}`]);
    // ディスカバリの URL は常に発行者(TLS 終端)側。転送元ヘッダは信頼しない
    expect(keycloak.environment?.["KC_HOSTNAME_BACKCHANNEL_DYNAMIC"]).toBe("false");
    expect(keycloak.environment).not.toHaveProperty("KC_PROXY_HEADERS");

    // Caddyfile: 発行者のホスト:ポートで待ち受け、Keycloak のコンテナのポートへ転送する
    const caddyfile = await readFile(CADDYFILE, "utf8");
    expect(caddyfile).toMatch(new RegExp(`^${hostname.hostname}:${hostname.port} \\{$`, "m"));
    const keycloakPort = (base["keycloak"]?.ports?.[0] ?? "").split(":").at(-1);
    expect(caddyfile).toMatch(new RegExp(`^\\s*reverse_proxy keycloak:${keycloakPort}$`, "m"));

    // LibreChat は keycloak-tls が書き出したローカル CA のルート証明書だけを追加で信頼する
    const caFile = librechat.environment?.["NODE_EXTRA_CA_CERTS"] ?? "";
    const caMount = mounts(librechat).get(posix.dirname(caFile));
    expect(caMount?.readOnly).toBe(true);
    expect(mounts(tls).get("/ca")?.source).toBe(caMount?.source);
    expect(tls.healthcheck?.test?.join(" ")).toContain(`/ca/${posix.basename(caFile)}`);

    // スモーク(scripts/smoke/librechat-smoke.sh)の既定の認可エンドポイントも同じ発行者
    const smoke = await readFile(LIBRECHAT_SMOKE, "utf8");
    const env = await envFile(LIBRECHAT_ENV_EXAMPLE);
    expect(/KP_SMOKE_OIDC_AUTH_URL:-([^}]+)\}/.exec(smoke)?.[1]).toBe(
      `${env["OPENID_ISSUER"]}/protocol/openid-connect/auth`,
    );
  });

  it("MongoDB は librechat と共有する内部ネットワークだけに置き、他のコンテナから届かない", async () => {
    const overlay = await composeDocument(LIBRECHAT_COMPOSE_FILE);
    const mongodb = await overlayService("mongodb");
    const librechat = await overlayService("librechat");
    const internal = "librechat-internal";

    // 外部への経路を持たない内部ネットワーク
    expect(overlay.networks?.[internal]?.internal).toBe(true);
    // mongodb はそのネットワークだけ(default に属さない)。ホストへも公開しない
    expect(networkNames(mongodb)).toEqual([internal]);
    expect(mongodb.ports).toBeUndefined();
    // librechat は default(orchestrator・keycloak-tls・LLM への経路)と内部ネットワークの両方
    expect(networkNames(librechat).sort()).toEqual(["default", internal].sort());
    expect(new URL(librechat.environment?.["MONGO_URI"] ?? "").hostname).toBe("mongodb");
    // それ以外のサービス(基本の compose を含む)は内部ネットワークに属さない
    for (const file of [COMPOSE_FILE, LIBRECHAT_COMPOSE_FILE]) {
      for (const [name, service] of Object.entries(await composeServices(file))) {
        if (name === "mongodb" || name === "librechat") continue;
        expect(networkNames(service), `${file}: ${name}`).not.toContain(internal);
      }
    }
  });
});
