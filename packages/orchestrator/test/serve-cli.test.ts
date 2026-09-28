/**
 * kp-ask serve(T-021、ADR-018)の CLI。runCli(["serve", ...])を直接呼び、待ち受けは
 * 127.0.0.1 の port 0。停止の合図は依存注入(waitForShutdown)で与える。
 *
 * 受け入れ条件4: Slack kind のソースが有効な deployment.yaml では起動を拒否し(終了コード 1)、
 * --allow-non-persistable-sources で起動する。
 * あわせて: 引数・設定の不備(終了コード 2)、公開境界(--confirm-exposed-host)、AnswerRun の
 * 書き先の検査、起動ログ(秘密情報を出さない)、CLI 経由の ask の e2e、停止時の待ち合わせ。
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAuditRecord } from "@kp/gateway";
import {
  McpGatewayClient,
  ScriptedLlmClient,
  type LlmClient,
  type ScriptStep,
} from "../src/index.js";
import { runCli, type CliDependencies } from "../src/bin/kp-ask.js";
import {
  EXPOSED_HOST_REFUSAL,
  NON_PERSISTABLE_SOURCES_REFUSAL,
  SERVE_USAGE,
  parseListen,
  type ServeEndpoint,
} from "../src/bin/serve.js";
import {
  ALICE_TOKEN,
  CorpusConnector,
  EXPENSE_POLICY,
  startGateway,
  type GatewayHarness,
} from "./helpers/harness.js";
import { connectMcpClient, rawPost, RAW_BODIES, searchThenSubmit } from "./helpers/orchestrator-server.js";

const HMAC_KEY = "dev-only-serve-hmac-key";
/** 起動時には接続しない Gateway の URL(到達不能) */
const UNREACHABLE_GATEWAY = "http://127.0.0.1:9/mcp";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) },
  };
}

interface DepsOptions {
  readonly llm?: LlmClient;
  readonly env?: Record<string, string>;
  readonly onListening?: (endpoint: ServeEndpoint) => Promise<void>;
  readonly shutdownGraceMs?: number;
}

/** 起動したら onListening を実行して止める依存(LLM は脚本、Gateway は実 MCP クライアント)。 */
function deps(options: DepsOptions = {}): CliDependencies & { readonly endpoints: ServeEndpoint[] } {
  const endpoints: ServeEndpoint[] = [];
  return {
    endpoints,
    env: options.env ?? {},
    createLlmClient: () => options.llm ?? new ScriptedLlmClient(searchThenSubmit()),
    createGatewayClient: (o) => new McpGatewayClient(o),
    waitForShutdown: async (endpoint) => {
      endpoints.push(endpoint);
      await options.onListening?.(endpoint);
      return "test-stop";
    },
    ...(options.shutdownGraceMs !== undefined ? { shutdownGraceMs: options.shutdownGraceMs } : {}),
  };
}

async function writeYaml(lines: readonly string[], dir?: string): Promise<string> {
  const base = dir ?? (await mkdtemp(join(tmpdir(), "t021-serve-")));
  const path = join(base, "deployment.yaml");
  await writeFile(path, [...lines, ""].join("\n"), "utf8");
  return path;
}

function deploymentYaml(extraConnectors: readonly string[] = [], extra: readonly string[] = []): string[] {
  return [
    "schemaVersion: 1",
    "deployment:",
    "  name: t021-serve",
    "idp:",
    "  adapter:",
    "    kind: mock",
    "connectors:",
    "  - id: alpha",
    ...extraConnectors,
    "audit:",
    "  privateScopeDocIds: omitted",
    ...extra,
  ];
}

const SLACK_CONNECTOR = ["  - id: slack-main", "    kind: slack"];

function serveArgs(config: string, ...extra: string[]): string[] {
  return ["serve", "--gateway", UNREACHABLE_GATEWAY, "--config", config, "--listen", "127.0.0.1:0", ...extra];
}

describe("kp-ask serve: 不変条件7(永続化不可のソース)", () => {
  it.each([
    ["kind: slack", SLACK_CONNECTOR],
    ["kind: slack-enterprise(プラグイン)", ["  - id: sl", "    kind: slack-enterprise"]],
    ["id: slack(kind の既定は id)", ["  - id: slack"]],
  ])("%s が有効なら起動を拒否する(終了コード 1、待ち受けない)", async (_label, connector) => {
    const config = await writeYaml(deploymentYaml(connector));
    const { err, io } = capture();
    const d = deps();

    const code = await runCli(serveArgs(config), io, d);

    expect(code).toBe(1);
    expect(err.join("\n")).toContain(NON_PERSISTABLE_SOURCES_REFUSAL);
    expect(err.join("\n")).toContain("--allow-non-persistable-sources");
    expect(err.join("\n")).not.toContain("listening on");
    expect(d.endpoints).toEqual([]);
  });

  it("--allow-non-persistable-sources を付ければ起動し(WARNING)、ask の retentionClass は non_persistable", async () => {
    const gateway = await startGateway({ connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])] });
    cleanups.push(() => gateway.close());
    const config = await writeYaml(deploymentYaml(SLACK_CONNECTOR));
    const { err, io } = capture();
    let retentionClass: unknown;
    const d = deps({
      onListening: async (endpoint) => {
        const health = await fetch(endpoint.healthUrl);
        expect(health.status).toBe(200);
        const client = await connectMcpClient(endpoint.url, ALICE_TOKEN);
        try {
          const result = await client.callTool({ name: "ask", arguments: { question: "経費精算の締め日は?" } });
          retentionClass = (result.structuredContent as Record<string, unknown>)["retentionClass"];
        } finally {
          await client.close();
        }
      },
    });

    const code = await runCli(
      ["serve", "--gateway", gateway.url, "--config", config, "--listen", "127.0.0.1:0", "--allow-non-persistable-sources"],
      io,
      d,
    );

    expect(code).toBe(0);
    expect(d.endpoints).toHaveLength(1);
    expect(retentionClass).toBe("non_persistable");
    const log = err.join("\n");
    expect(log).toContain("WARNING: non-persistable sources are enabled (slack-main)");
    expect(log).toContain("stopped");
  });

  it("Slack のコネクタが無効(enabled: false)なら解除のフラグなしで起動する", async () => {
    const config = await writeYaml(deploymentYaml([...SLACK_CONNECTOR, "    enabled: false"]));
    const { io } = capture();
    const d = deps();
    expect(await runCli(serveArgs(config), io, d)).toBe(0);
    expect(d.endpoints).toHaveLength(1);
  });
});

describe("kp-ask serve: 起動と停止", () => {
  it("起動ログ: 待ち受け・Gateway のホストだけ・AnswerRun の書き先・上限・LLM(秘密情報を出さない)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t021-serve-"));
    const config = await writeYaml(deploymentYaml([], ["orchestrator:", "  maxIterations: 3"]), dir);
    const jsonl = join(dir, "answer-runs.jsonl");
    const { out, err, io } = capture();
    const d = deps({
      env: {
        KP_AUDIT_HMAC_KEY: HMAC_KEY,
        ANTHROPIC_API_KEY: "dev-only-anthropic-key",
      },
      onListening: async (endpoint) => {
        // Bearer なしは 401(JSON-RPC のディスパッチ前)
        const response = await rawPost(endpoint.url, RAW_BODIES["tools/list"]);
        expect(response.status).toBe(401);
      },
    });

    const code = await runCli(
      [
        "serve",
        "--gateway", "http://127.0.0.1:9/some/path",
        "--config", config,
        "--listen", "127.0.0.1:0",
        "--answer-run-jsonl", jsonl,
        "--max-concurrent-runs", "2",
        "--max-question-chars", "500",
      ],
      io,
      d,
    );

    expect(code).toBe(0);
    expect(out).toEqual([]);
    const [endpoint] = d.endpoints;
    expect(endpoint?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(endpoint?.healthUrl).toBe(endpoint?.url.replace(/\/mcp$/, "/healthz"));
    expect(err).toEqual([
      `kp-ask serve: listening on ${endpoint?.url} (health check: ${endpoint?.healthUrl})`,
      "kp-ask serve: deployment: t021-serve",
      "kp-ask serve: gateway: http://127.0.0.1:9",
      `kp-ask serve: answer-run sink: jsonl ${jsonl}`,
      "kp-ask serve: limits: max-concurrent-runs=2, max-question-chars=500, max-iterations=3",
      "kp-ask serve: llm: anthropic (model: claude-opus-5, effort: high)",
      "kp-ask serve: test-stop received, shutting down",
      "kp-ask serve: stopped",
    ]);
    const log = err.join("\n");
    expect(log).not.toContain("/some/path");
    expect(log).not.toContain(HMAC_KEY);
    expect(log).not.toContain("dev-only-anthropic-key");
  });

  it("--answer-run-jsonl がなければ AnswerRun は stderr(WARNING)。KP_LISTEN / KP_ANSWER_RUN_JSONL も使える", async () => {
    const config = await writeYaml(deploymentYaml());
    const warn = capture();
    expect(await runCli(serveArgs(config), warn.io, deps())).toBe(0);
    expect(warn.err.join("\n")).toContain(
      "WARNING: answer-run sink: stderr (development only; AnswerRun records are not persisted)",
    );

    const dir = await mkdtemp(join(tmpdir(), "t021-serve-"));
    const jsonl = join(dir, "from-env.jsonl");
    const viaEnv = capture();
    const d = deps({ env: { KP_LISTEN: "127.0.0.1:0", KP_ANSWER_RUN_JSONL: jsonl } });
    expect(
      await runCli(["serve", "--gateway", UNREACHABLE_GATEWAY, "--config", config], viaEnv.io, d),
    ).toBe(0);
    expect(d.endpoints[0]?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(viaEnv.err).toContain(`kp-ask serve: answer-run sink: jsonl ${jsonl}`);
  });

  it("CLI 経由の e2e: 実 Gateway に対して ask が回答し、AnswerRun(alice)を JSONL に書く", async () => {
    const gateway = await startGateway({ connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])] });
    cleanups.push(() => gateway.close());
    const dir = await mkdtemp(join(tmpdir(), "t021-serve-"));
    const config = await writeYaml(deploymentYaml(), dir);
    const jsonl = join(dir, "answer-runs.jsonl");
    const { io } = capture();
    let text = "";
    const d = deps({
      onListening: async (endpoint) => {
        const client = await connectMcpClient(endpoint.url, ALICE_TOKEN);
        try {
          await client.listTools();
          const result = await client.callTool({ name: "ask", arguments: { question: "経費精算の締め日は?" } });
          text = (result.content as { text: string }[])[0]?.text ?? "";
        } finally {
          await client.close();
        }
      },
    });

    const code = await runCli(
      ["serve", "--gateway", gateway.url, "--config", config, "--listen", "127.0.0.1:0", "--answer-run-jsonl", jsonl],
      io,
      d,
    );

    expect(code).toBe(0);
    expect(text).toContain("経費精算の締め日は毎月25日です。");
    expect(text).toContain("## 出典");
    const records = (await readFile(jsonl, "utf8"))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => parseAuditRecord(JSON.parse(line)));
    expect(records.map((r) => r.recordType === "answer_run" && [r.finalOutcome, r.userId])).toEqual([
      ["pending", "alice"],
      ["resolved", "alice"],
    ]);
  });

  it("停止の合図のあと、進行中の ask の応答を返し終えてから止まる(終了コード 0)", async () => {
    const gateway = await startGateway({ connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])] });
    cleanups.push(() => gateway.close());
    const config = await writeYaml(deploymentYaml());
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const answer = searchThenSubmit();
    const step: ScriptStep = async (context) => {
      if (context.turnIndex === 0) {
        markStarted();
        await gate;
      }
      return answer(context);
    };
    let inFlight: Promise<unknown> | undefined;
    const { err, io } = capture();
    const d = deps({
      llm: new ScriptedLlmClient(step),
      onListening: async (endpoint) => {
        const client = await connectMcpClient(endpoint.url, ALICE_TOKEN);
        cleanups.push(() => client.close());
        inFlight = client.callTool({ name: "ask", arguments: { question: "経費精算の締め日は?" } });
        await started;
        // 停止を始めてから run を進める
        setTimeout(openGate, 50);
      },
    });

    const code = await runCli(
      ["serve", "--gateway", gateway.url, "--config", config, "--listen", "127.0.0.1:0"],
      io,
      d,
    );

    expect(code).toBe(0);
    const result = (await inFlight) as { structuredContent: { outcome: string } };
    expect(result.structuredContent.outcome).toBe("resolved");
    expect(err.join("\n")).not.toContain("still in progress");
  });

  it("上限時間内に終わらないリクエストがあれば接続を切って終了コード 1", async () => {
    const gateway = await startGateway({ connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])] });
    cleanups.push(() => gateway.close());
    const config = await writeYaml(deploymentYaml());
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    cleanups.push(async () => openGate());
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const answer = searchThenSubmit();
    let inFlight: Promise<unknown> | undefined;
    const { err, io } = capture();
    const d = deps({
      llm: new ScriptedLlmClient(async (context) => {
        markStarted();
        await gate;
        return answer(context);
      }),
      shutdownGraceMs: 50,
      onListening: async (endpoint) => {
        const client = await connectMcpClient(endpoint.url, ALICE_TOKEN);
        cleanups.push(() => client.close());
        inFlight = client
          .callTool({ name: "ask", arguments: { question: "経費精算の締め日は?" } })
          .catch((error: unknown) => error);
        await started;
      },
    });

    const code = await runCli(
      ["serve", "--gateway", gateway.url, "--config", config, "--listen", "127.0.0.1:0"],
      io,
      d,
    );

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("WARNING: 1 request(s) still in progress after 50 ms");
    expect(await inFlight).toBeInstanceOf(Error);
  });
});

describe("kp-ask serve: 引数と設定の不備", () => {
  it("--help / help は使い方を stdout に出して終了コード 0", async () => {
    for (const argv of [["serve", "--help"], ["serve", "-h"], ["serve", "help"]]) {
      const { out, io } = capture();
      expect(await runCli(argv, io, deps())).toBe(0);
      expect(out.join("\n")).toBe(SERVE_USAGE);
    }
  });

  it.each([
    [["serve", "--config", "x.yaml"], "--gateway"],
    [["serve", "--gateway", UNREACHABLE_GATEWAY], "--config"],
    [["serve", "--gateway", UNREACHABLE_GATEWAY, "--config", "x.yaml", "extra"], "位置引数"],
    [["serve", "--gateway", UNREACHABLE_GATEWAY, "--config", "x.yaml", "--listen", "localhost"], "--listen"],
    [["serve", "--gateway", UNREACHABLE_GATEWAY, "--config", "x.yaml", "--listen", "127.0.0.1:70000"], "--listen"],
    [["serve", "--gateway", UNREACHABLE_GATEWAY, "--config", "x.yaml", "--path", "/healthz"], "--path"],
    [["serve", "--gateway", UNREACHABLE_GATEWAY, "--config", "x.yaml", "--path", "mcp"], "--path"],
    [["serve", "--gateway", UNREACHABLE_GATEWAY, "--config", "x.yaml", "--max-concurrent-runs", "0"], "--max-concurrent-runs"],
    [["serve", "--gateway", UNREACHABLE_GATEWAY, "--config", "x.yaml", "--max-concurrent-runs", "1e3"], "--max-concurrent-runs"],
    [["serve", "--gateway", UNREACHABLE_GATEWAY, "--config", "x.yaml", "--max-question-chars", "10001"], "--max-question-chars"],
    [["serve", "--gateway", UNREACHABLE_GATEWAY, "--config", "x.yaml", "--llm", "gemini"], "--llm"],
    [["serve", "--gateway", UNREACHABLE_GATEWAY, "--config", "x.yaml", "--effort", "ultra"], "--effort"],
  ])("%j は終了コード 2(%s)", async (argv, message) => {
    const { err, io } = capture();
    expect(await runCli(argv, io, deps())).toBe(2);
    expect(err[0]).toContain(message);
    expect(err.join("\n")).toContain("usage: kp-ask serve");
  });

  it("解釈できない引数の中身(トークン等)をエコーしない", async () => {
    const { out, err, io } = capture();
    const code = await runCli(["serve", "--token=dev-only-secret-typo"], io, deps());
    expect(code).toBe(2);
    expect([...out, ...err].join("\n")).not.toContain("dev-only-secret-typo");
  });

  it("--gateway の URL が不正なら終了コード 2(URL の中身をエコーしない)", async () => {
    const config = await writeYaml(deploymentYaml());
    for (const gateway of ["http://gateway.example.test/mcp", "https://u:dev-only-pw@gw.example.test/mcp", "not a url"]) {
      const { err, io } = capture();
      expect(await runCli(["serve", "--gateway", gateway, "--config", config], io, deps())).toBe(2);
      expect(err.join("\n")).toContain("--gateway の指定が不正です");
      expect(err.join("\n")).not.toContain("dev-only-pw");
    }
  });

  it("--config が読めない・不正なら終了コード 2", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t021-serve-"));
    const missing = capture();
    expect(await runCli(serveArgs(join(dir, "missing.yaml")), missing.io, deps())).toBe(2);
    expect(missing.err.join("\n")).toContain("ENOENT");

    const invalid = capture();
    const config = await writeYaml(["schemaVersion: 1", "connectors: 3"]);
    expect(await runCli(serveArgs(config), invalid.io, deps())).toBe(2);
    expect(invalid.err.join("\n")).toContain("deployment config rejected");
  });

  it("audit.privateScopeDocIds が hashed で KP_AUDIT_HMAC_KEY がなければ終了コード 2", async () => {
    const config = await writeYaml([
      "schemaVersion: 1",
      "deployment:",
      "  name: t021-serve",
      "idp:",
      "  adapter:",
      "    kind: mock",
      "connectors:",
      "  - id: alpha",
    ]);
    const { err, io } = capture();
    expect(await runCli(serveArgs(config), io, deps())).toBe(2);
    expect(err.join("\n")).toContain("KP_AUDIT_HMAC_KEY");

    const withKey = capture();
    expect(await runCli(serveArgs(config), withKey.io, deps({ env: { KP_AUDIT_HMAC_KEY: HMAC_KEY } }))).toBe(0);
    expect(withKey.err.join("\n")).not.toContain(HMAC_KEY);
  });

  it("ループバック以外の --listen は --confirm-exposed-host がなければ終了コード 1", async () => {
    const config = await writeYaml(deploymentYaml());
    const refused = capture();
    expect(
      await runCli(["serve", "--gateway", UNREACHABLE_GATEWAY, "--config", config, "--listen", "0.0.0.0:8790"], refused.io, deps()),
    ).toBe(1);
    expect(refused.err.join("\n")).toContain(EXPOSED_HOST_REFUSAL);

    // 確認フラグがあれば公開境界の検査は通る(割り当てられないアドレスなので待ち受けで失敗する)
    const confirmed = capture();
    expect(
      await runCli(
        ["serve", "--gateway", UNREACHABLE_GATEWAY, "--config", config, "--listen", "192.0.2.1:0", "--confirm-exposed-host"],
        confirmed.io,
        deps(),
      ),
    ).toBe(1);
    expect(confirmed.err.join("\n")).not.toContain(EXPOSED_HOST_REFUSAL);
    expect(confirmed.err.join("\n")).toContain("cannot listen on 192.0.2.1:0");
  });

  it("--answer-run-jsonl が Gateway の監査ログと同じファイル・書けない場所なら終了コード 1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t021-serve-"));
    await mkdir(join(dir, "audit"));
    const config = await writeYaml(
      deploymentYaml([], ["  sink: jsonl", "  jsonl:", "    path: audit/gateway.jsonl"]),
      dir,
    );
    const same = capture();
    expect(
      await runCli(serveArgs(config, "--answer-run-jsonl", join(dir, "audit", "gateway.jsonl")), same.io, deps()),
    ).toBe(1);
    expect(same.err.join("\n")).toContain("Gateway の監査ログ");

    const missing = capture();
    expect(
      await runCli(serveArgs(config, "--answer-run-jsonl", join(dir, "no-such-dir", "a.jsonl")), missing.io, deps()),
    ).toBe(1);
    expect(missing.err.join("\n")).toContain("does not exist or is not writable");
  });
});

describe("parseListen", () => {
  it.each([
    ["127.0.0.1:8790", { host: "127.0.0.1", port: 8790 }],
    ["localhost:0", { host: "localhost", port: 0 }],
    ["[::1]:8790", { host: "::1", port: 8790 }],
    ["0.0.0.0:80", { host: "0.0.0.0", port: 80 }],
  ])("%s", (value, expected) => {
    expect(parseListen(value)).toEqual(expected);
  });

  it.each(["8790", ":8790", "127.0.0.1", "127.0.0.1:", "::1:8790", "127.0.0.1:65536", "a b:1"])(
    "%s は不正",
    (value) => {
      expect(parseListen(value)).toBeUndefined();
    },
  );
});
