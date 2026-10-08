/**
 * kp-gateway CLI のテスト。
 * - 引数解析(parseCliArgs)のユニットテスト
 * - runCli の validate / serve をプロセス内で実行(serve は停止合図を注入)
 * - ビルド成果物(dist)がある場合のみ、子プロセスで validate を実行する
 *   (src は直接実行しない: tsx 等のTS実行環境を前提にしない)
 * 環境変数の値(トークン)を出力しないことも確かめる(不変条件6)。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLI_USAGE,
  parseCliArgs,
  portInUseMessage,
  runCli,
  type CliDeps,
} from "../src/cli/run.js";
import { MOCK_IDP_NO_SESSIONS_REJECTED, MOCK_IDP_NO_SESSIONS_WARNING } from "../src/idp/index.js";

const PACKAGE_DIR = fileURLToPath(new URL("../", import.meta.url));
const EXAMPLES_DIR = fileURLToPath(new URL("../../../examples/", import.meta.url));
const DEV_CONFIG = join(EXAMPLES_DIR, "deployment.dev.yaml");
const DEV_CORPUS = join(EXAMPLES_DIR, "fixtures", "dev-corpus.yaml");
const DIST_BIN = join(PACKAGE_DIR, "dist", "bin", "kp-gateway.js");
const NPM_BIN_SHIM = join(PACKAGE_DIR, "bin", "kp-gateway.js");

const SECRET_ENV = {
  KP_MOCK_SESSIONS: "dev-only-session=alice",
  KP_MOCK_TOKEN_DEV_DOCS: "dev-only-cli-token",
};

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function captureIo(
  extra: Partial<CliDeps> = {},
): CliDeps & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    env: SECRET_ENV,
    ...extra,
  };
}

function expectNoSecrets(text: string): void {
  expect(text).not.toContain("dev-only-cli-token");
  expect(text).not.toContain("dev-only-session");
}

describe("parseCliArgs", () => {
  it.each([
    [["serve", "--config", "a.yaml"], { kind: "serve", configPath: "a.yaml" }],
    [["validate", "-c", "b.yaml"], { kind: "validate", configPath: "b.yaml" }],
    [["serve", "--config=c.yaml"], { kind: "serve", configPath: "c.yaml" }],
    [["--config", "d.yaml", "validate"], { kind: "validate", configPath: "d.yaml" }],
    [["--help"], { kind: "help" }],
    [["-h"], { kind: "help" }],
    [["help"], { kind: "help" }],
    [["serve", "--help"], { kind: "help" }],
    [["serve", "-c", "a.yaml", "--port", "9000"], { kind: "serve", configPath: "a.yaml", port: 9000 }],
    [["serve", "-c", "a.yaml", "--host", "::1"], { kind: "serve", configPath: "a.yaml", host: "::1" }],
    [
      ["validate", "-c", "a.yaml", "--host=localhost", "--port=65535"],
      { kind: "validate", configPath: "a.yaml", host: "localhost", port: 65535 },
    ],
  ])("%j → %j", (argv, expected) => {
    expect(parseCliArgs(argv, {})).toEqual(expected);
  });

  it("--config がなければ KP_DEPLOYMENT_CONFIG を使う(--config が優先)", () => {
    const env = { KP_DEPLOYMENT_CONFIG: "/etc/kp/deployment.yaml" };
    expect(parseCliArgs(["serve"], env)).toEqual({
      kind: "serve",
      configPath: "/etc/kp/deployment.yaml",
    });
    expect(parseCliArgs(["serve", "-c", "local.yaml"], env)).toEqual({
      kind: "serve",
      configPath: "local.yaml",
    });
  });

  it.each([
    [[], "a command is required"],
    [["serve"], "--config <path> is required"],
    [["serve", "--config", ""], "--config <path> is required"],
    [["start", "--config", "a.yaml"], "unknown command: start"],
    [["serve", "extra", "--config", "a.yaml"], "unexpected argument: extra"],
    [["serve", "--config", "a.yaml", "--port", "0"], "--port must be an integer between 1 and 65535"],
    [["serve", "--config", "a.yaml", "--port", "65536"], "--port must be an integer between 1 and 65535"],
    [["serve", "--config", "a.yaml", "--port", "80.5"], "--port must be an integer between 1 and 65535"],
    [["serve", "--config", "a.yaml", "--port", "http"], "--port must be an integer between 1 and 65535"],
    [["serve", "--config", "a.yaml", "--host", ""], "--host must be a host name or an IP address"],
    [["serve", "--config", "a.yaml", "--host", "a b"], "--host must be a host name or an IP address"],
    [["serve", "--config", "a.yaml", "--port"], "--port"],
    [["serve", "--config"], "--config"],
  ])("使い方の誤り: %j", (argv, message) => {
    const result = parseCliArgs(argv, {});
    expect(result.kind).toBe("usage_error");
    expect(result.kind === "usage_error" ? result.message : "").toContain(message);
  });
});

describe("runCli", () => {
  it("help は使い方を標準出力へ出して 0", async () => {
    const io = captureIo();
    expect(await runCli(["help"], io)).toBe(0);
    expect(io.out).toEqual([CLI_USAGE]);
  });

  it("使い方の誤りは理由と使い方を標準エラー出力へ出して 2", async () => {
    const io = captureIo();
    expect(await runCli(["frobnicate", "-c", "x.yaml"], io)).toBe(2);
    expect(io.err[0]).toBe("kp-gateway: unknown command: frobnicate");
    expect(io.err).toContain(CLI_USAGE);
  });

  it("validate: dev設定を検証して要約を出し 0(環境変数の値は出さない)", async () => {
    const io = captureIo();
    expect(await runCli(["validate", "--config", DEV_CONFIG], io)).toBe(0);
    expect(io.out).toEqual([
      `kp-gateway validate: OK (${DEV_CONFIG})`,
      "  deployment: dev-local",
      "  endpoint: http://127.0.0.1:8787/mcp",
      "  enabled sources: dev-docs",
      "  idp adapter: mock",
      "  audit sink: stdout (development only; not at-least-once)",
    ]);
    expect(io.err.join("\n")).toContain("WARNING: development-only components in use");
    expectNoSecrets([...io.out, ...io.err].join("\n"));
  });

  it("validate: 不備を全件列挙して 1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kp-cli-"));
    tempDirs.push(dir);
    const config = join(dir, "broken.yaml");
    await writeFile(
      config,
      `schemaVersion: 1
deployment:
  name: broken
idp:
  adapter:
    kind: mock
connectors:
  - id: a
    kind: dev-fixture
  - id: b
    kind: nonexistent-kind
    auth:
      provider: mock_env
audit:
  sink: syslog
`,
    );
    const io = captureIo();
    expect(await runCli(["validate", "--config", config], io)).toBe(1);
    expect(io.out).toEqual([]);
    expect(io.err[0]).toBe('kp-gateway: deployment "broken" rejected: 3 issue(s)');
    expect(io.err.slice(1).map((line) => /\[(\w+)\]/.exec(line)?.[1])).toEqual([
      "connector_auth_provider_missing",
      "unknown_connector_kind",
      "unknown_audit_sink",
    ]);
  });

  it("validate: スキーマ違反は読み込み時に全件列挙して 1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kp-cli-"));
    tempDirs.push(dir);
    const config = join(dir, "typo.yaml");
    await writeFile(
      config,
      "schemaVersion: 1\ndeployment:\n  name: typo\nidp:\n  adapter:\n    kind: mock\naudit:\n  sink: jsonl\n  failuremode: fail-open\n",
    );
    const io = captureIo();
    expect(await runCli(["validate", "--config", config], io)).toBe(1);
    expect(io.err[0]).toMatch(/^kp-gateway: cannot load .*typo\.yaml: \d issue\(s\)$/);
    expect(io.err.join("\n")).toContain("[schema_violation] audit");
  });

  it("validate: 設定ファイルがなければエラーコードだけを出して 1", async () => {
    const io = captureIo();
    expect(await runCli(["validate", "--config", "/nonexistent/kp.yaml"], io)).toBe(1);
    expect(io.err).toEqual(["kp-gateway: cannot load /nonexistent/kp.yaml: ENOENT"]);
  });

  it("validate: KP_MOCK_SESSIONS が未設定でも 0 だが、モック IdP のセッション表が空だと WARNING を出す(issue #38)", async () => {
    const io = captureIo({ env: { KP_MOCK_TOKEN_DEV_DOCS: "dev-only-cli-token" } });
    expect(await runCli(["validate", "--config", DEV_CONFIG], io)).toBe(0);
    expect(io.out[0]).toBe(`kp-gateway validate: OK (${DEV_CONFIG})`);
    expect(io.err).toContain(`kp-gateway: WARNING: ${MOCK_IDP_NO_SESSIONS_WARNING}`);
    expectNoSecrets([...io.out, ...io.err].join("\n"));

    // セッションを設定すれば出ない
    const configured = captureIo();
    expect(await runCli(["validate", "--config", DEV_CONFIG], configured)).toBe(0);
    expect(configured.err.join("\n")).not.toContain("no sessions configured");
  });

  it("validate: --port / --host は deployment.yaml の gateway.http より優先する", async () => {
    const io = captureIo();
    expect(
      await runCli(["validate", "--config", DEV_CONFIG, "--port", "9911", "--host", "::1"], io),
    ).toBe(0);
    expect(io.out).toContain("  endpoint: http://[::1]:9911/mcp");
  });

  it("validate: ループバック以外の --host は confirmExposedHost なしでは拒否する(フラグで公開境界の検査を迂回しない)", async () => {
    const io = captureIo();
    expect(await runCli(["validate", "--config", DEV_CONFIG, "--host", "0.0.0.0"], io)).toBe(1);
    expect(io.out).toEqual([]);
    expect(io.err.join("\n")).toContain(
      "[http_host_exposed_requires_confirmation] gateway.http.host",
    );
  });

  it("validate: NODE_ENV=production では開発用構成を拒否して 1", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const io = captureIo();
      expect(await runCli(["validate", "--config", DEV_CONFIG], io)).toBe(1);
      expect(io.err.filter((l) => l.includes("[dev_only_in_production]"))).toHaveLength(3);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function postToolsList(origin: string, token: string): Promise<number> {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  await response.arrayBuffer();
  return response.status;
}

async function waitForHealth(origin: string): Promise<Response | undefined> {
  let health: Response | undefined;
  for (let i = 0; i < 50 && health === undefined; i += 1) {
    health = await fetch(`${origin}/healthz`).catch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return undefined;
    });
  }
  return health;
}

async function devConfigOnPort(port: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kp-cli-serve-"));
  tempDirs.push(dir);
  const path = join(dir, "deployment.yaml");
  await writeFile(
    path,
    `schemaVersion: 1
deployment:
  name: cli-serve
idp:
  adapter:
    kind: mock
gateway:
  http:
    port: ${port}
connectors:
  - id: dev-docs
    kind: dev-fixture
    auth:
      provider: mock_env
    settings:
      corpusFile: ${DEV_CORPUS}
audit:
  sink: jsonl
  jsonl:
    path: audit.jsonl
`,
  );
  return path;
}

describe("runCli serve", () => {
  it("listen してリクエストを受け、停止合図で閉じて 0", async () => {
    const port = await freePort();
    const config = await devConfigOnPort(port);
    let stop: (reason: string) => void = () => undefined;
    const io = captureIo({
      waitForShutdown: () => new Promise<string>((resolve) => (stop = resolve)),
    });
    const running = runCli(["serve", "--config", config], io);

    const origin = `http://127.0.0.1:${port}`;
    let health: Response | undefined;
    for (let i = 0; i < 50 && health === undefined; i += 1) {
      health = await fetch(`${origin}/healthz`).catch(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return undefined;
      });
    }
    expect(health?.status).toBe(200);
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer dev-only-session",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search", arguments: { source: "dev-docs", query: "VPN" } },
      }),
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain("vpn-setup");

    stop("SIGTERM");
    expect(await running).toBe(0);
    expect(io.err[0]).toBe(
      `kp-gateway: listening on ${origin}/mcp (health check: ${origin}/healthz)`,
    );
    expect(io.err).toContain("kp-gateway: enabled sources: dev-docs");
    expect(io.err.slice(-2)).toEqual([
      "kp-gateway: SIGTERM received, shutting down",
      "kp-gateway: stopped",
    ]);
    expectNoSecrets(io.err.join("\n"));
    await expect(fetch(`${origin}/healthz`)).rejects.toThrow();
  });

  it("ポートが使用中なら理由(エラーコード)と変更の方法を出して 1", async () => {
    const blocker = createServer();
    blocker.listen(0, "127.0.0.1");
    await new Promise((resolve) => blocker.once("listening", resolve));
    const address = blocker.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const io = captureIo({
        waitForShutdown: () => Promise.reject(new Error("must not wait when listen fails")),
      });
      expect(await runCli(["serve", "--config", await devConfigOnPort(port)], io)).toBe(1);
      expect(io.err).toEqual([
        `kp-gateway: cannot listen on 127.0.0.1:${port}: EADDRINUSE`,
        portInUseMessage(port),
      ]);
      expect(portInUseMessage(port)).toBe(
        `kp-gateway: ポート ${port} は使用中です。--port <番号> か deployment.yaml の gateway.http.port で別のポートを指定してください`,
      );
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it("--port で deployment.yaml のポートを上書きして待ち受ける(使用中のポートを避けられる)", async () => {
    const blocker = createServer();
    blocker.listen(0, "127.0.0.1");
    await new Promise((resolve) => blocker.once("listening", resolve));
    const address = blocker.address();
    const blocked = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const port = await freePort();
      let stop: (reason: string) => void = () => undefined;
      const io = captureIo({
        waitForShutdown: () => new Promise<string>((resolve) => (stop = resolve)),
      });
      const running = runCli(
        ["serve", "--config", await devConfigOnPort(blocked), "--port", String(port)],
        io,
      );
      const origin = `http://127.0.0.1:${port}`;
      expect((await waitForHealth(origin))?.status).toBe(200);
      stop("SIGTERM");
      expect(await running).toBe(0);
      expect(io.err[0]).toBe(
        `kp-gateway: listening on ${origin}/mcp (health check: ${origin}/healthz)`,
      );
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it("KP_MOCK_SESSIONS が未設定なら起動時に WARNING を出し、401 で拒否したときに1回だけサーバーログに残す(issue #38)", async () => {
    const port = await freePort();
    let stop: (reason: string) => void = () => undefined;
    const io = captureIo({
      env: { KP_MOCK_TOKEN_DEV_DOCS: "dev-only-cli-token" },
      waitForShutdown: () => new Promise<string>((resolve) => (stop = resolve)),
    });
    const running = runCli(["serve", "--config", await devConfigOnPort(port)], io);
    const origin = `http://127.0.0.1:${port}`;
    expect((await waitForHealth(origin))?.status).toBe(200);
    expect(io.err).toContain(`kp-gateway: WARNING: ${MOCK_IDP_NO_SESSIONS_WARNING}`);

    expect(await postToolsList(origin, "dev-only-session")).toBe(401);
    expect(await postToolsList(origin, "dev-only-session")).toBe(401);
    stop("SIGTERM");
    expect(await running).toBe(0);
    expect(
      io.err.filter((line) => line === `kp-gateway: WARNING: ${MOCK_IDP_NO_SESSIONS_REJECTED}`),
    ).toHaveLength(1);
    expectNoSecrets(io.err.join("\n"));
  });
});

describe.skipIf(!existsSync(DIST_BIN))("ビルド成果物の実行(子プロセス)", () => {
  const env = { ...process.env, ...SECRET_ENV, NODE_ENV: "development" };

  it("node dist/bin/kp-gateway.js validate --config examples/deployment.dev.yaml が 0 で終わる", () => {
    const result = spawnSync(process.execPath, [DIST_BIN, "validate", "--config", DEV_CONFIG], {
      env,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("kp-gateway validate: OK");
    expect(result.stdout).toContain("enabled sources: dev-docs");
    expectNoSecrets(result.stdout + result.stderr);
  });

  it("npm の bin(起動シム)経由でも動き、使い方の誤りは 2 で終わる", () => {
    const help = spawnSync(process.execPath, [NPM_BIN_SHIM, "help"], { env, encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("usage: kp-gateway");
    const usage = spawnSync(process.execPath, [NPM_BIN_SHIM, "serve"], { env, encoding: "utf8" });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain("--config <path> is required");
  });
});
