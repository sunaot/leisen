/**
 * `--allow-insecure-upstream`(環境変数 LEISEN_ALLOW_INSECURE_UPSTREAM=1)— Gateway の URL と LLM の
 * ベース URL の両方について、ループバック以外の平文 http を開発・評価用途に限って許す(T-021。
 * compose の overlay はネットワーク内の http://gateway:8787/mcp とホストの LM Studio
 * http://host.docker.internal:1234/v1 に向く)。
 *
 * - フラグなし → 従来どおり拒否(parseGatewayUrl / httpBaseUrlSchema は変えていない)
 * - フラグあり + development → 通る。Gateway への接続(preflight・ask)と LLM の設定に許可が渡り、
 *   平文 http の上流をホスト名だけで列挙した WARNING を1行出す
 * - フラグあり + NODE_ENV=production → 固定文言で拒否して終了コード 2(leisen-ask / leisen-ask serve)。
 *   ライブラリとして直接組んだ場合も McpGatewayClient / OpenAiCompatibleLlmClient の構築で拒否する
 * - 資格情報・クエリ・フラグメント付き・http(s) 以外の URL はフラグがあっても拒否
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GatewayClientError,
  McpGatewayClient,
  OpenAiCompatibleLlmClient,
  OrchestratorError,
  ScriptedLlmClient,
  createLlmClient,
  httpBaseUrlSchema,
  insecureHttpBaseUrlSchema,
  openAiCompatibleLlmSettingsSchema,
  parseGatewayUrl,
  parseInsecureGatewayUrl,
  type LlmBackendConfigInput,
} from "../src/index.js";
import { runCli, USAGE, type CliDependencies } from "../src/bin/leisen-ask.js";
import { parseLlmCliOptions } from "../src/bin/llm-options.js";
import type { ServeEndpoint } from "../src/bin/serve.js";
import {
  INSECURE_UPSTREAM_HINT,
  INSECURE_UPSTREAM_IN_PRODUCTION_MESSAGE,
  insecureUpstreamWarning,
  parseInsecureUpstreamOption,
} from "../src/bin/upstream-options.js";
import {
  ALICE_TOKEN,
  CorpusConnector,
  EXPENSE_POLICY,
  startGateway,
  type GatewayHarness,
} from "./helpers/harness.js";
import { connectMcpClient, searchThenSubmit } from "./helpers/orchestrator-server.js";

/** compose のネットワーク内の Gateway */
const COMPOSE_GATEWAY = "http://gateway:8787/mcp";
/** コンテナからホストの LM Studio */
const HOST_LM_STUDIO = "http://host.docker.internal:1234/v1";
const DEV = { NODE_ENV: "development" };
const PROD = { NODE_ENV: "production" };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe("parseInsecureUpstreamOption", () => {
  it("フラグ・環境変数(1 / true)で有効、未指定・0 / false / 空で無効", () => {
    expect(parseInsecureUpstreamOption(true, DEV)).toEqual({ ok: true, enabled: true });
    for (const value of ["1", "true", "TRUE", " 1 "]) {
      expect(parseInsecureUpstreamOption(undefined, { ...DEV, LEISEN_ALLOW_INSECURE_UPSTREAM: value })).toEqual({
        ok: true,
        enabled: true,
      });
    }
    for (const value of ["0", "false", ""]) {
      expect(parseInsecureUpstreamOption(undefined, { ...DEV, LEISEN_ALLOW_INSECURE_UPSTREAM: value })).toEqual({
        ok: true,
        enabled: false,
      });
    }
    expect(parseInsecureUpstreamOption(undefined, DEV)).toEqual({ ok: true, enabled: false });
  });

  it("環境変数の誤記は拒否する(値をエコーしない)", () => {
    const result = parseInsecureUpstreamOption(undefined, { ...DEV, LEISEN_ALLOW_INSECURE_UPSTREAM: "dev-only-yes" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("LEISEN_ALLOW_INSECURE_UPSTREAM");
    expect(result.ok === false && result.message).not.toContain("dev-only-yes");
  });

  it("NODE_ENV=production では有効にできない(フラグでも環境変数でも固定文言)", () => {
    const refused = { ok: false, message: INSECURE_UPSTREAM_IN_PRODUCTION_MESSAGE };
    expect(parseInsecureUpstreamOption(true, PROD)).toEqual(refused);
    expect(parseInsecureUpstreamOption(undefined, { ...PROD, LEISEN_ALLOW_INSECURE_UPSTREAM: "1" })).toEqual(refused);
    // 無効なら本番でも問題ない
    expect(parseInsecureUpstreamOption(undefined, PROD)).toEqual({ ok: true, enabled: false });
  });
});

describe("Gateway の URL: 入口での分岐(parseGatewayUrl は変えない)", () => {
  it("フラグなしの規則(parseGatewayUrl)はループバック以外の http を拒否する", () => {
    expect(() => parseGatewayUrl(COMPOSE_GATEWAY)).toThrow(GatewayClientError);
    expect(() => new McpGatewayClient({ url: COMPOSE_GATEWAY, sessionToken: "dev-only-t" })).toThrow(
      GatewayClientError,
    );
  });

  it("allowInsecureHttp のときだけ通す(McpGatewayClient も同じ)", () => {
    expect(parseInsecureGatewayUrl(COMPOSE_GATEWAY).href).toBe(COMPOSE_GATEWAY);
    const client = new McpGatewayClient({
      url: COMPOSE_GATEWAY,
      sessionToken: "dev-only-t",
      allowInsecureHttp: true,
    });
    expect(client.endpoint).toBe(COMPOSE_GATEWAY);
    // https・ループバックは従来どおり
    expect(parseInsecureGatewayUrl("https://gw.example.test/mcp").protocol).toBe("https:");
    expect(parseInsecureGatewayUrl("http://127.0.0.1:8787/mcp").hostname).toBe("127.0.0.1");
  });

  it.each([
    "ftp://gateway/mcp",
    "http://user:dev-only-password@gateway:8787/mcp",
    "http://gateway:8787/mcp?token=dev-only-query",
    "http://gateway:8787/mcp#dev-only-fragment",
    "http://gateway:8787/mcp?",
    "not a url",
  ])("フラグがあっても %s は拒否(URL をエコーしない)", (url) => {
    let thrown: unknown;
    try {
      parseInsecureGatewayUrl(url);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GatewayClientError);
    expect(String(thrown)).not.toContain("dev-only");
  });

  it("NODE_ENV=production では allowInsecureHttp の McpGatewayClient を構築しない", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(
      () => new McpGatewayClient({ url: COMPOSE_GATEWAY, sessionToken: "dev-only-t", allowInsecureHttp: true }),
    ).toThrow(/NODE_ENV=production/);
    // 許可を求めない既定の構築(https)には影響しない
    expect(new McpGatewayClient({ url: "https://gw.example.test/mcp", sessionToken: "dev-only-t" }).endpoint).toBe(
      "https://gw.example.test/mcp",
    );
  });
});

describe("LLM のベース URL: 入口での分岐(httpBaseUrlSchema は変えない)", () => {
  const openAi = { llm: "openai-compatible", model: "local-model" } as const;

  it("許可なし: ループバック以外の http は従来どおり拒否(フラグの案内を添える)", () => {
    const result = parseLlmCliOptions({ ...openAi, "llm-base-url": HOST_LM_STUDIO }, DEV);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("--allow-insecure-upstream");
    expect(result.ok === false && result.message).not.toContain("host.docker.internal");
    expect(httpBaseUrlSchema.safeParse(HOST_LM_STUDIO).success).toBe(false);
  });

  it("許可あり: 通り、設定に allowInsecureHttp: true が載る", () => {
    expect(
      parseLlmCliOptions({ ...openAi, "llm-base-url": HOST_LM_STUDIO }, DEV, { allowInsecureHttp: true }),
    ).toEqual({
      ok: true,
      config: {
        provider: "openai_compatible",
        baseUrl: HOST_LM_STUDIO,
        model: "local-model",
        allowInsecureHttp: true,
      },
    });
    expect(insecureHttpBaseUrlSchema.safeParse(HOST_LM_STUDIO).success).toBe(true);
  });

  it("許可があっても http(s) 以外・資格情報付き・フラグメント付きは拒否(入力値をエコーしない)", () => {
    for (const baseUrl of [
      "ftp://dev-only-host/v1",
      "http://user:dev-only-password@host.docker.internal:1234/v1",
      "http://host.docker.internal:1234/v1#dev-only-fragment",
    ]) {
      const result = parseLlmCliOptions({ ...openAi, "llm-base-url": baseUrl }, DEV, { allowInsecureHttp: true });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.message).not.toContain("dev-only");
    }
  });

  it("設定スキーマ・createLlmClient は allowInsecureHttp のときだけ受ける", () => {
    const base = { baseUrl: HOST_LM_STUDIO, model: "m" };
    expect(openAiCompatibleLlmSettingsSchema.safeParse(base).success).toBe(false);
    expect(openAiCompatibleLlmSettingsSchema.safeParse({ ...base, allowInsecureHttp: false }).success).toBe(false);
    expect(openAiCompatibleLlmSettingsSchema.safeParse({ ...base, allowInsecureHttp: true }).success).toBe(true);
    const config = { provider: "openai_compatible" as const, ...base };
    expect(() => createLlmClient(config)).toThrow();
    const client = createLlmClient({ ...config, allowInsecureHttp: true }, { env: DEV });
    expect(client).toBeInstanceOf(OpenAiCompatibleLlmClient);
  });

  it("NODE_ENV=production では allowInsecureHttp の OpenAiCompatibleLlmClient を構築しない(URL をエコーしない)", () => {
    let thrown: unknown;
    try {
      new OpenAiCompatibleLlmClient({
        baseUrl: "http://dev-only-gpu-box.example.test:1234/v1",
        model: "m",
        allowInsecureHttp: true,
        env: PROD,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OrchestratorError);
    expect((thrown as OrchestratorError).errorClass).toBe("invalid_configuration");
    expect(String(thrown)).not.toContain("dev-only");
  });
});

describe("insecureUpstreamWarning", () => {
  const openAiLlm = (baseUrl: string): LlmBackendConfigInput => ({
    provider: "openai_compatible",
    baseUrl,
    model: "m",
    allowInsecureHttp: true,
  });

  it("平文 http の上流をホスト名だけで列挙する(ポート・パス・クエリ・キーを出さない)", () => {
    const warning = insecureUpstreamWarning({
      gatewayUrl: COMPOSE_GATEWAY,
      llm: { ...openAiLlm("http://host.docker.internal:1234/v1?key=dev-only-query"), apiKeyEnv: "DEV_ONLY_KEY_ENV" },
    });
    expect(warning).toBe(
      "WARNING: 上流への接続が平文 http です(Gateway: gateway、LLM: host.docker.internal)。利用者のトークンと会話(利用者の権限で取得した文書の本文)が経路上で読めます。開発・評価用途に限ってください(--allow-insecure-upstream。本番では使えません)",
    );
    expect(warning).not.toMatch(/dev-only|DEV_ONLY|8787|1234|\/v1|\/mcp/);
  });

  it("片方だけなら片方だけ、どちらも平文で外へ出ないなら出さない", () => {
    expect(insecureUpstreamWarning({ gatewayUrl: COMPOSE_GATEWAY, llm: { provider: "anthropic" } })).toContain(
      "(Gateway: gateway)",
    );
    expect(
      insecureUpstreamWarning({ gatewayUrl: "http://127.0.0.1:8787/mcp", llm: openAiLlm(HOST_LM_STUDIO) }),
    ).toContain("(LLM: host.docker.internal)");
    expect(
      insecureUpstreamWarning({
        gatewayUrl: "https://gw.example.test/mcp",
        llm: openAiLlm("http://localhost:1234/v1"),
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CLI(leisen-ask serve / leisen-ask)
// ---------------------------------------------------------------------------

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) },
  };
}

type GatewayOptions = Parameters<CliDependencies["createGatewayClient"]>[0];

interface DepsOptions {
  readonly env: Record<string, string>;
  /**
   * Gateway への接続を実際に向ける先(未指定なら到達不能なループバック)。"as-is" なら向け替えず、
   * 渡された URL のまま McpGatewayClient を作る(URL の検証を確かめるとき)
   */
  readonly connectTo?: string;
  readonly onListening?: (endpoint: ServeEndpoint) => Promise<void>;
}

/** Gateway の接続オプションと LLM の設定を記録する依存。 */
function deps(options: DepsOptions): CliDependencies & {
  readonly gatewayOptions: GatewayOptions[];
  readonly llmConfigs: LlmBackendConfigInput[];
} {
  const gatewayOptions: GatewayOptions[] = [];
  const llmConfigs: LlmBackendConfigInput[] = [];
  return {
    gatewayOptions,
    llmConfigs,
    env: options.env,
    createLlmClient: (config) => {
      llmConfigs.push(config);
      return new ScriptedLlmClient(searchThenSubmit());
    },
    createGatewayClient: (o) => {
      gatewayOptions.push(o);
      if (options.connectTo === "as-is") {
        return new McpGatewayClient(o);
      }
      // 渡された許可のまま、実際の接続先だけテスト用の Gateway(ループバック)に向け替える
      return new McpGatewayClient({ ...o, url: options.connectTo ?? "http://127.0.0.1:9/mcp" });
    },
    waitForShutdown: async (endpoint) => {
      await options.onListening?.(endpoint);
      return "test-stop";
    },
  };
}

async function deploymentYaml(): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "t021-upstream-")), "deployment.yaml");
  await writeFile(
    path,
    [
      "schemaVersion: 1",
      "deployment:",
      "  name: t021-upstream",
      "idp:",
      "  adapter:",
      "    kind: mock",
      "connectors:",
      "  - id: alpha",
      "audit:",
      "  privateScopeDocIds: omitted",
      "",
    ].join("\n"),
    "utf8",
  );
  return path;
}

async function serveArgs(gateway: string, ...extra: string[]): Promise<string[]> {
  return ["serve", "--gateway", gateway, "--config", await deploymentYaml(), "--listen", "127.0.0.1:0", ...extra];
}

const LLM_ARGS = ["--llm", "openai-compatible", "--model", "local-model", "--llm-base-url", HOST_LM_STUDIO];

describe("leisen-ask serve: --allow-insecure-upstream", () => {
  it("フラグなし: ループバック以外の http の Gateway は終了コード 2(案内を添える)", async () => {
    const { err, io } = capture();
    expect(await runCli(await serveArgs(COMPOSE_GATEWAY), io, deps({ env: DEV }))).toBe(2);
    expect(err[0]).toContain("--gateway の指定が不正です");
    expect(err[0]).toContain(INSECURE_UPSTREAM_HINT);
    expect(err.join("\n")).not.toContain("listening on");
  });

  it("フラグなし: ループバック以外の http の LLM は終了コード 2(案内を添える)", async () => {
    const { err, io } = capture();
    expect(await runCli(await serveArgs("http://127.0.0.1:9/mcp", ...LLM_ARGS), io, deps({ env: DEV }))).toBe(2);
    expect(err[0]).toContain("--allow-insecure-upstream");
  });

  it("フラグあり + development: 起動し、両方の上流をホスト名で WARNING。Gateway への接続にも許可が渡る", async () => {
    const gateway: GatewayHarness = await startGateway({
      connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])],
    });
    cleanups.push(() => gateway.close());
    let outcome: unknown;
    const d = deps({
      env: DEV,
      connectTo: gateway.url,
      onListening: async (endpoint) => {
        // preflight と ask の Gateway 接続が、許可付きのクライアントで実際に通る
        const client = await connectMcpClient(endpoint.url, ALICE_TOKEN);
        try {
          const result = await client.callTool({ name: "ask", arguments: { question: "経費精算の締め日は?" } });
          outcome = (result.structuredContent as Record<string, unknown>)["outcome"];
        } finally {
          await client.close();
        }
      },
    });
    const { err, io } = capture();

    const code = await runCli(
      await serveArgs(COMPOSE_GATEWAY, ...LLM_ARGS, "--allow-insecure-upstream"),
      io,
      d,
    );

    expect(code).toBe(0);
    expect(outcome).toBe("resolved");
    expect(d.gatewayOptions.length).toBeGreaterThanOrEqual(2);
    expect(
      d.gatewayOptions.every((o) => o.url === COMPOSE_GATEWAY && o.allowInsecureHttp === true),
    ).toBe(true);
    expect(d.llmConfigs).toEqual([expect.objectContaining({ allowInsecureHttp: true })]);
    const warnings = err.filter((line) => line.includes("平文 http"));
    expect(warnings).toEqual([
      "leisen-ask serve: WARNING: 上流への接続が平文 http です(Gateway: gateway、LLM: host.docker.internal)。利用者のトークンと会話(利用者の権限で取得した文書の本文)が経路上で読めます。開発・評価用途に限ってください(--allow-insecure-upstream。本番では使えません)",
    ]);
    expect(err).toContain("leisen-ask serve: gateway: http://gateway:8787");
    expect(err.join("\n")).not.toContain(ALICE_TOKEN);
  });

  it("環境変数 LEISEN_ALLOW_INSECURE_UPSTREAM=1 + development でも起動する(compose の overlay の形)", async () => {
    const { err, io } = capture();
    const code = await runCli(
      await serveArgs(COMPOSE_GATEWAY, "--llm", "openai-compatible"),
      io,
      deps({
        env: { ...DEV, LEISEN_ALLOW_INSECURE_UPSTREAM: "1", LEISEN_LLM_BASE_URL: HOST_LM_STUDIO, LEISEN_LLM_MODEL: "m" },
      }),
    );
    expect(code).toBe(0);
    expect(err.some((line) => line.includes("(Gateway: gateway、LLM: host.docker.internal)"))).toBe(true);
  });

  it("フラグあり + NODE_ENV=production: 固定文言で拒否して終了コード 2(待ち受けない)", async () => {
    for (const [extra, env] of [
      [["--allow-insecure-upstream"], PROD],
      [[], { ...PROD, LEISEN_ALLOW_INSECURE_UPSTREAM: "1" }],
    ] as const) {
      const { err, io } = capture();
      const d = deps({ env });
      const code = await runCli(await serveArgs(COMPOSE_GATEWAY, ...LLM_ARGS, ...extra), io, d);
      expect(code).toBe(2);
      expect(err[0]).toBe(`leisen-ask serve: ${INSECURE_UPSTREAM_IN_PRODUCTION_MESSAGE}`);
      expect(err.join("\n")).not.toContain("listening on");
      expect(d.llmConfigs).toEqual([]);
    }
  });
});

describe("leisen-ask(1問): --allow-insecure-upstream", () => {
  const ask = ["--gateway", COMPOSE_GATEWAY, "--token", "dev-only-token", ...LLM_ARGS];

  it("フラグなし: ループバック以外の http の Gateway は終了コード 2(案内を添える)", async () => {
    const { err, io } = capture();
    const d = deps({ env: DEV, connectTo: "as-is" });
    // LLM は許可なしでは通らないので、Gateway だけを確かめるときは LLM をループバックにする
    const argv = ["--gateway", COMPOSE_GATEWAY, "--token", "dev-only-token", "--llm", "openai-compatible",
      "--model", "m", "--llm-base-url", "http://localhost:1234/v1", "質問"];
    expect(await runCli(argv, io, d)).toBe(2);
    expect(err[0]).toContain("Gateway の指定が不正です");
    expect(err[0]).toContain(INSECURE_UPSTREAM_HINT);
    expect(d.gatewayOptions).toEqual([expect.not.objectContaining({ allowInsecureHttp: true })]);
  });

  it("フラグなし: ループバック以外の http の LLM は終了コード 2", async () => {
    const { err, io } = capture();
    expect(await runCli([...ask, "質問"], io, deps({ env: DEV }))).toBe(2);
    expect(err[0]).toContain("--allow-insecure-upstream");
  });

  it("フラグあり + development: WARNING を1行出し、Gateway・LLM の両方に許可を渡して実行する", async () => {
    const { err, io } = capture();
    const d = deps({ env: DEV });
    // 接続先は到達不能なループバックに向け替えているので、run は Gateway 不達で終わる(終了コード 1)
    const code = await runCli([...ask, "--allow-insecure-upstream", "質問"], io, d);
    expect(code).toBe(1);
    expect(err[0]).toContain("WARNING: 上流への接続が平文 http です(Gateway: gateway、LLM: host.docker.internal)");
    expect(d.gatewayOptions).toEqual([
      expect.objectContaining({ url: COMPOSE_GATEWAY, allowInsecureHttp: true }),
    ]);
    expect(d.llmConfigs).toEqual([expect.objectContaining({ allowInsecureHttp: true })]);
    expect(err.join("\n")).not.toContain("dev-only-token");
  });

  it("フラグあり + NODE_ENV=production: 固定文言で終了コード 2(何も作らない)", async () => {
    for (const [extra, env] of [
      [["--allow-insecure-upstream"], PROD],
      [[], { ...PROD, LEISEN_ALLOW_INSECURE_UPSTREAM: "1" }],
    ] as const) {
      const { err, io } = capture();
      const d = deps({ env });
      expect(await runCli([...ask, ...extra, "質問"], io, d)).toBe(2);
      expect(err[0]).toBe(INSECURE_UPSTREAM_IN_PRODUCTION_MESSAGE);
      expect(err[1]).toBe(USAGE);
      expect(d.gatewayOptions).toEqual([]);
      expect(d.llmConfigs).toEqual([]);
    }
  });
});
