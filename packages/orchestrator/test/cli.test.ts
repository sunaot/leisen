/**
 * leisen-ask CLI。Gateway は実物(port 0)、LLM は依存注入(脚本 / 偽 fetch の実 SDK)で動かす。
 * Claude API には出ない。
 */
import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LlmError,
  McpGatewayClient,
  createLlmClient,
  ScriptedLlmClient,
  answerSchema,
  scriptedSubmit,
  scriptedToolUse,
  type LlmClient,
} from "../src/index.js";
import {
  CREDENTIALS_REJECTED_MESSAGE,
  CREDENTIALS_REQUIRED_MESSAGE,
  USAGE,
  runCli,
  type CliDependencies,
  type CliFailureOutput,
} from "../src/bin/leisen-ask.js";
import {
  ALICE_TOKEN,
  BOB_TOKEN,
  CorpusConnector,
  EXPENSE_POLICY,
  startGateway,
  type GatewayHarness,
} from "./helpers/harness.js";
import { firstHit } from "./helpers/script.js";

const harnesses: GatewayHarness[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

async function setup(): Promise<GatewayHarness> {
  const harness = await startGateway({
    connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])],
  });
  harnesses.push(harness);
  return harness;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) },
  };
}

function deps(llm: (settings: Parameters<CliDependencies["createLlmClient"]>[0]) => LlmClient, env = {}): CliDependencies {
  return {
    env,
    createLlmClient: llm,
    createGatewayClient: (options) => new McpGatewayClient(options),
  };
}

function resolvingScript(): ScriptedLlmClient {
  return new ScriptedLlmClient([
    () => scriptedToolUse([{ name: "search", input: { source: "alpha", query: "締め日" } }]),
    (context) => {
      const hit = firstHit(context);
      return scriptedSubmit({
        answer: "経費精算の締め日は毎月25日です。",
        citations: [{ documentId: hit.documentId, sourceId: hit.source }],
        confidence: 0.9,
      });
    },
  ]);
}

/** Claude API の資格情報が一切ない環境(環境変数を消し、空の設定ディレクトリを指す)。 */
async function stubNoAnthropicCredentials(): Promise<void> {
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_PROFILE",
    "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_ORGANIZATION_ID",
    "ANTHROPIC_SERVICE_ACCOUNT_ID",
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "ANTHROPIC_IDENTITY_TOKEN",
    "ANTHROPIC_WORKSPACE_ID",
  ]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("ANTHROPIC_CONFIG_DIR", await mkdtemp(join(tmpdir(), "leisen-ask-no-creds-")));
}

describe("leisen-ask: 引数", () => {
  it("--help で使い方を表示する", async () => {
    const { out, io } = capture();
    expect(await runCli(["--help"], io, deps(() => resolvingScript()))).toBe(0);
    expect(out.join("\n")).toBe(USAGE);
  });

  it.each([
    [["質問"], "--gateway を指定してください。"],
    [["--gateway", "http://127.0.0.1:1/mcp", "質問"], "セッショントークン"],
    [["--gateway", "http://127.0.0.1:1/mcp", "--token", "dev-only-t"], "質問文を指定してください。"],
    [
      ["--gateway", "http://127.0.0.1:1/mcp", "--token", "dev-only-t", "--max-iterations", "0", "q"],
      "--max-iterations",
    ],
    [
      ["--gateway", "http://127.0.0.1:1/mcp", "--token", "dev-only-t", "--effort", "ultra", "q"],
      "--effort",
    ],
  ])("不備のある引数 %j は終了コード 2", async (argv, message) => {
    const { err, io } = capture();
    expect(await runCli(argv, io, deps(() => resolvingScript()))).toBe(2);
    expect(err.join("\n")).toContain(message);
  });

  it("解釈できない引数の中身(トークン等)をエコーしない", async () => {
    const { out, err, io } = capture();
    const code = await runCli(
      ["--tokne=dev-only-secret-typo", "--gateway", "http://127.0.0.1:1/mcp", "q"],
      io,
      deps(() => resolvingScript()),
    );
    expect(code).toBe(2);
    expect([...out, ...err].join("\n")).not.toContain("dev-only-secret-typo");
  });
});

describe("leisen-ask: 実行", () => {
  it("回答・出典・searchedSources・usage を表示し、AnswerRun は Gateway の監査に残る(stderr には出さない)", async () => {
    const harness = await setup();
    const { out, err, io } = capture();

    const code = await runCli(
      ["--gateway", harness.url, "--user-id", "alice", "経費精算の締め日は?"],
      io,
      deps(() => resolvingScript(), { LEISEN_SESSION_TOKEN: ALICE_TOKEN }),
    );

    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("経費精算の締め日は毎月25日です。");
    expect(text).toContain("[1] 経費精算規程 (alpha:doc-expense-policy) https://alpha.example.test/docs/doc-expense-policy");
    expect(text).toContain("検索したソース: alpha");
    expect(text).toContain("結果: resolved");
    expect(text).toContain("LLM 2 ターン、ツール呼び出し 2 回");
    // AnswerRun は Gateway の run API が書く(ADR-019)。leisen-ask は監査レコードを出力しない
    expect(err.filter((line) => line.startsWith("{"))).toEqual([]);
    expect(harness.answerRuns()).toEqual([
      expect.objectContaining({ userId: "alice", finalOutcome: "resolved", citedDocIds: ["alpha:doc-expense-policy"] }),
    ]);
    expect([...out, ...err].join("\n")).not.toContain(ALICE_TOKEN);
  });

  it("--json で Answer スキーマの JSON を出す", async () => {
    const harness = await setup();
    const { out, io } = capture();

    const code = await runCli(
      ["--gateway", harness.url, "--token", ALICE_TOKEN, "--json", "締め日は?"],
      io,
      deps(() => resolvingScript()),
    );

    expect(code).toBe(0);
    const answer = answerSchema.parse(JSON.parse(out.join("\n")));
    expect(answer.outcome).toBe("resolved");
  });

  it("--model / --effort / --max-iterations を LLM クライアントと探索の設定に渡す", async () => {
    const harness = await setup();
    const { io } = capture();
    const received: unknown[] = [];

    await runCli(
      [
        "--gateway", harness.url, "--token", ALICE_TOKEN,
        "--model", "claude-opus-5-5", "--effort", "low", "--max-iterations", "3",
        "締め日は?",
      ],
      io,
      deps((settings) => {
        received.push(settings);
        return resolvingScript();
      }),
    );

    expect(received).toEqual([{ provider: "anthropic", model: "claude-opus-5-5", effort: "low" }]);
  });

  it("Claude API の資格情報が無ければ「資格情報が必要」と表示して終了コード 2(実 SDK、外部に出ない)", async () => {
    await stubNoAnthropicCredentials();
    const harness = await setup();
    const { out, err, io } = capture();
    const fetch = vi.fn(async () => {
      throw new Error("the test must not reach the network");
    });

    const code = await runCli(
      ["--gateway", harness.url, "--token", ALICE_TOKEN, "経費精算の締め日は?"],
      io,
      deps((settings) =>
        createLlmClient(settings, { anthropicClient: new Anthropic({ fetch, maxRetries: 0 }) }),
      ),
    );

    expect(code).toBe(2);
    expect(err).toContain(CREDENTIALS_REQUIRED_MESSAGE);
    expect(out).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    // run は Gateway に error で記録される(AnswerRun の書き手は Gateway。ADR-019)
    expect(harness.answerRuns().at(-1)).toMatchObject({ finalOutcome: "error", failureReason: "llm_credentials_missing" });
    expect([...out, ...err].join("\n")).not.toContain(ALICE_TOKEN);
  });

  it("Claude API が資格情報を拒否(401)したら終了コード 2", async () => {
    const harness = await setup();
    const { err, io } = capture();
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    );

    const code = await runCli(
      ["--gateway", harness.url, "--token", ALICE_TOKEN, "締め日は?"],
      io,
      deps((settings) =>
        createLlmClient(settings, {
          anthropicClient: new Anthropic({ apiKey: "dev-only-not-a-real-key", fetch, maxRetries: 0 }),
        }),
      ),
    );

    expect(code).toBe(2);
    expect(err).toContain(CREDENTIALS_REJECTED_MESSAGE);
    expect(err.join("\n")).not.toContain("dev-only-not-a-real-key");
  });

  it("Gateway がセッションを拒否したら終了コード 1(トークンを表示しない)", async () => {
    const harness = await setup();
    const { out, err, io } = capture();

    const code = await runCli(
      ["--gateway", harness.url, "--token", "dev-only-revoked-token", "締め日は?"],
      io,
      deps(() => resolvingScript()),
    );

    expect(code).toBe(1);
    // run を始められないので回答はなく、失敗の説明は stderr(--json なら失敗の表現を stdout に)
    expect(err.join("\n")).toContain("gateway_unauthenticated");
    expect(out).toEqual([]);
    expect([...out, ...err].join("\n")).not.toContain("dev-only-revoked-token");
  });
});

/** Gateway の監査に残った AnswerRun(統合済み)の最後のもの。 */
function lastAnswerRun(harness: GatewayHarness): Record<string, unknown> | undefined {
  return harness.answerRuns().at(-1) as Record<string, unknown> | undefined;
}

async function writeDeployment(yaml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "leisen-ask-config-"));
  const path = join(dir, "deployment.yaml");
  await writeFile(path, yaml, "utf8");
  return path;
}

const DEPLOYMENT_YAML = [
  "schemaVersion: 1",
  "deployment:",
  "  name: leisen-ask-test",
  "idp:",
  "  adapter:",
  "    kind: mock",
  "connectors:",
  "  - id: alpha",
  // excluded 以外(included)のソースは全 docId をプライベートスコープとして扱う。
  // consent は validate で拒否される(ADR-016 追補2 決定6。下のテスト)
  "    privateScopes: included",
  "    confirmPrivateScopesIncluded: true",
  "audit:",
  "  privateScopeDocIds: hashed",
  "",
].join("\n");

describe("leisen-ask: 利用者の束縛(H1)と --config", () => {
  it("--user-id を省略すると Gateway が認証した userId を記録する(既定値 cli-user は使わない)", async () => {
    const harness = await setup();
    const { err, io } = capture();

    const code = await runCli(
      ["--gateway", harness.url, "--token", BOB_TOKEN, "締め日は?"],
      io,
      deps(() => resolvingScript()),
    );

    expect(code).toBe(0);
    expect(lastAnswerRun(harness)).toMatchObject({ userId: "bob", finalOutcome: "resolved" });
    expect(err.join("\n")).not.toContain("cli-user");
  });

  it("--user-id が Gateway の認証と食い違えば user_mismatch で終了コード 1", async () => {
    const harness = await setup();
    const { out, err, io } = capture();

    const code = await runCli(
      ["--gateway", harness.url, "--token", BOB_TOKEN, "--user-id", "alice", "締め日は?"],
      io,
      deps(() => resolvingScript()),
    );

    expect(code).toBe(1);
    expect(out.join("\n")).toContain("user_mismatch");
    expect(lastAnswerRun(harness)).toMatchObject({
      userId: "bob",
      finalOutcome: "error",
      failureReason: "user_mismatch",
    });
  });

  it("citedDocIds は Gateway が構成の規則で記録する(--config は不要)", async () => {
    const harness = await setup();
    const { io } = capture();

    await runCli(
      ["--gateway", harness.url, "--token", ALICE_TOKEN, "締め日は?"],
      io,
      deps(() => resolvingScript()),
    );

    expect(lastAnswerRun(harness)).toMatchObject({ finalOutcome: "resolved", citedDocIds: ["alpha:doc-expense-policy"] });
  });

  it("--config の deployment.yaml が不正なら終了コード 2", async () => {
    const harness = await setup();
    const config = await writeDeployment("schemaVersion: 1\nconnectors: 3\n");
    const { err, io } = capture();

    const code = await runCli(
      ["--gateway", harness.url, "--token", ALICE_TOKEN, "--config", config, "締め日は?"],
      io,
      deps(() => resolvingScript()),
    );

    expect(code).toBe(2);
    expect(err.join("\n")).toContain("deployment config rejected");
    expect(harness.toolInvocations()).toEqual([]);
  });

  it("--config の privateScopes: consent は拒否して終了コード 2(#42 まで。ADR-016 追補2 決定6)", async () => {
    const harness = await setup();
    const config = await writeDeployment(
      DEPLOYMENT_YAML.replace(
        "    privateScopes: included\n    confirmPrivateScopesIncluded: true",
        "    privateScopes: consent",
      ),
    );
    const { err, io } = capture();

    const code = await runCli(
      ["--gateway", harness.url, "--token", ALICE_TOKEN, "--config", config, "締め日は?"],
      io,
      deps(() => resolvingScript()),
    );

    expect(code).toBe(2);
    expect(err.join("\n")).toContain("private_scopes_consent_not_supported");
    expect(harness.toolInvocations()).toEqual([]);
  });
});

/** --json の stdout(JSON 1つ)を読む。 */
function jsonOutput(out: readonly string[]): Record<string, unknown> {
  expect(out).toHaveLength(1);
  return JSON.parse(out[0] ?? "") as Record<string, unknown>;
}

describe("leisen-ask --json: 回答を返せない失敗でも stdout に JSON を1つ出す(issue #38)", () => {
  it.each([
    [["--json", "質問"], "--gateway を指定してください。"],
    [["--gateway", "http://127.0.0.1:1/mcp", "--json", "質問"], "セッショントークン"],
    [["--json", "--tokne=dev-only-secret-typo", "q"], "引数を解釈できませんでした。"],
  ])("引数の不備 %j は invalid_arguments(終了コード 2、stderr の案内は従来どおり)", async (argv, message) => {
    const { out, err, io } = capture();
    expect(await runCli(argv, io, deps(() => resolvingScript()))).toBe(2);
    const output = jsonOutput(out) as unknown as CliFailureOutput;
    expect(output).toEqual({
      outcome: "error",
      errorClass: "invalid_arguments",
      message: expect.stringContaining(message) as unknown,
    });
    expect(err.join("\n")).toContain(USAGE);
    expect([...out, ...err].join("\n")).not.toContain("dev-only-secret-typo");
  });

  it("--json がなければ stdout には何も出さない(従来どおり)", async () => {
    const { out, io } = capture();
    expect(await runCli(["質問"], io, deps(() => resolvingScript()))).toBe(2);
    expect(out).toEqual([]);
  });

  it("Gateway の URL の誤り(ループバック以外の http)は invalid_arguments", async () => {
    const { out, io } = capture();
    const code = await runCli(
      ["--gateway", "http://gateway.example.test/mcp", "--token", "dev-only-t", "--json", "q"],
      io,
      deps(() => resolvingScript()),
    );
    expect(code).toBe(2);
    expect(jsonOutput(out)).toMatchObject({ outcome: "error", errorClass: "invalid_arguments" });
    expect(JSON.stringify(jsonOutput(out))).not.toContain("dev-only-t");
    // 固定文言(URL・ホスト名をエコーしない)
    expect(JSON.stringify(jsonOutput(out))).not.toContain("gateway.example.test");
  });

  it("--config が不正なら invalid_configuration(Gateway にアクセスしない)", async () => {
    const harness = await setup();
    const broken = await writeDeployment("schemaVersion: 1\nconnectors: 3\n");
    const invalid = capture();
    expect(
      await runCli(
        ["--gateway", harness.url, "--token", ALICE_TOKEN, "--config", broken, "--json", "q"],
        invalid.io,
        deps(() => resolvingScript()),
      ),
    ).toBe(2);
    expect(jsonOutput(invalid.out)).toMatchObject({
      outcome: "error",
      errorClass: "invalid_configuration",
      message: expect.stringContaining("deployment config rejected") as unknown,
    });
    expect(harness.toolInvocations()).toEqual([]);
    expect(harness.answerRuns()).toEqual([]);
  });

  it("Claude API の資格情報が無ければ llm_credentials_missing と runId(終了コード 2 のまま)", async () => {
    await stubNoAnthropicCredentials();
    const harness = await setup();
    const { out, err, io } = capture();
    const fetch = vi.fn(async () => {
      throw new Error("the test must not reach the network");
    });

    const code = await runCli(
      ["--gateway", harness.url, "--token", ALICE_TOKEN, "--json", "経費精算の締め日は?"],
      io,
      deps((settings) =>
        createLlmClient(settings, { anthropicClient: new Anthropic({ fetch, maxRetries: 0 }) }),
      ),
    );

    expect(code).toBe(2);
    const output = jsonOutput(out);
    expect(output).toEqual({
      outcome: "error",
      errorClass: "llm_credentials_missing",
      message: CREDENTIALS_REQUIRED_MESSAGE,
      runId: expect.any(String) as unknown,
    });
    expect(err).toContain(CREDENTIALS_REQUIRED_MESSAGE);
    // runId は AnswerRun(stderr)と突き合わせられる
    expect(lastAnswerRun(harness)).toMatchObject({
      runId: output["runId"],
      finalOutcome: "error",
      failureReason: "llm_credentials_missing",
    });
    expect([...out, ...err].join("\n")).not.toContain(ALICE_TOKEN);
  });

  it("run が error で終わったときは従来どおり Answer(outcome: error)を出す(終了コード 1)", async () => {
    const harness = await setup();
    const { out, io } = capture();
    // LLM の正規化エラーで run が error で終わる(run は Gateway に error で残る)
    const llm = new ScriptedLlmClient([
      () => {
        throw new LlmError("llm_unavailable", "dev-only upstream detail");
      },
    ]);

    const code = await runCli(
      ["--gateway", harness.url, "--token", ALICE_TOKEN, "--json", "締め日は?"],
      io,
      deps(() => llm),
    );

    expect(code).toBe(1);
    const answer = answerSchema.parse(jsonOutput(out));
    expect(answer.outcome).toBe("error");
    expect(answer.answer).toContain("llm_unavailable");
    expect(answer.answer).not.toContain("dev-only upstream detail");
    expect(lastAnswerRun(harness)).toMatchObject({ finalOutcome: "error", failureReason: "llm_unavailable" });
  });

  it("Gateway がセッションを拒否したら run を始められず、失敗の表現(gateway_unauthenticated)を出す(終了コード 1、トークンをエコーしない)", async () => {
    const harness = await setup();
    const { out, err, io } = capture();

    const code = await runCli(
      ["--gateway", harness.url, "--token", "dev-only-revoked-token", "--json", "締め日は?"],
      io,
      deps(() => resolvingScript()),
    );

    expect(code).toBe(1);
    expect(jsonOutput(out)).toMatchObject({ outcome: "error", errorClass: "gateway_unauthenticated" });
    expect([...out, ...err].join("\n")).not.toContain("dev-only-revoked-token");
    expect(harness.answerRuns()).toEqual([]);
  });

  it("run が例外で終わった(Gateway が終了を記録できない等)ときは OrchestratorError の分類(終了コード 1)", async () => {
    // 開始の後(最初の LLM 呼び出しの時点)に Gateway の監査ストアを壊し、finish を書けなくする
    let failWrites = false;
    const harness = await startGateway({
      connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])],
      wrapSink: (inner) => ({
        async write(record) {
          if (failWrites) {
            throw new Error("injected audit failure");
          }
          await inner.write(record);
        },
      }),
    });
    harnesses.push(harness);
    const llm = new ScriptedLlmClient([
      () => {
        failWrites = true;
        return scriptedSubmit({ answer: "わかりません。", citations: [], confidence: 0 });
      },
    ]);
    const { out, err, io } = capture();

    const code = await runCli(
      ["--gateway", harness.url, "--token", ALICE_TOKEN, "--json", "締め日は?"],
      io,
      deps(() => llm),
    );

    expect(code).toBe(1);
    expect(jsonOutput(out)).toEqual({
      outcome: "error",
      errorClass: "audit_write_failed",
      message: expect.stringContaining("実行できませんでした(audit_write_failed)") as unknown,
    });
    expect(err.join("\n")).toContain("実行できませんでした(audit_write_failed)");
    expect(err.join("\n")).not.toContain("injected");
  });
});
