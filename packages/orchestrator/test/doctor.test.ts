/**
 * leisen-ask doctor(Orchestrator から見た経路の診断)。名前解決・TCP・HTTP を差し替えて、
 * 各分岐の判定とヒント、秘密を出さないことを確かめる。
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor, type DoctorDependencies } from "../src/bin/doctor.js";
import { runCli } from "../src/bin/leisen-ask.js";

const CREDENTIAL = "dev-only-orchestrator-credential-for-doctor";
const API_KEY = "dev-only-llm-api-key-for-doctor";

async function config(extra = ""): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "doctor-"));
  const path = join(dir, "deployment.yaml");
  await writeFile(
    path,
    [
      "schemaVersion: 1",
      "deployment: { name: doctor-test }",
      "idp: { adapter: { kind: mock } }",
      "connectors:",
      "  - id: alpha",
      "audit: { privateScopeDocIds: omitted }",
      extra,
    ].join("\n"),
    "utf8",
  );
  return path;
}

type Route = (init: RequestInit) => Response | Promise<Response>;

function fakeFetch(routes: Record<string, Route>): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const route = routes[`${(init.method ?? "GET").toUpperCase()} ${url}`];
    if (route === undefined) {
      const error = new TypeError("fetch failed") as TypeError & { cause?: { code: string } };
      error.cause = { code: "ECONNREFUSED" };
      throw error;
    }
    return route(init);
  }) as typeof fetch;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const HEALTHY: Record<string, Route> = {
  "GET http://127.0.0.1:1234/v1/models": () => json({ data: [{ id: "local-model" }, { id: "other-model" }] }),
  "POST http://127.0.0.1:1234/v1/chat/completions": () => json({ choices: [{ message: { content: "OK" } }] }),
  "GET http://127.0.0.1:8787/healthz": () => json({ status: "ok" }),
  "GET http://127.0.0.1:8787/.well-known/oauth-authorization-server": () => json({ issuer: "http://127.0.0.1:8787" }),
  "POST http://127.0.0.1:8787/token": (init) =>
    new Headers(init.headers).get("authorization") === `Basic ${Buffer.from(`leisen-orchestrator:${CREDENTIAL}`).toString("base64")}`
      ? json({ error: "invalid_request" }, 400)
      : json({ error: "invalid_client" }, 401),
};

function deps(overrides: Partial<DoctorDependencies> & { routes?: Record<string, Route>; env?: Record<string, string> } = {}): DoctorDependencies {
  return {
    env: {
      LEISEN_LLM_BASE_URL: "http://127.0.0.1:1234/v1",
      LEISEN_LLM_MODEL: "local-model",
      LEISEN_ORCHESTRATOR_CREDENTIAL: CREDENTIAL,
      ...overrides.env,
    },
    fetch: fakeFetch({ ...HEALTHY, ...overrides.routes }),
    lookup: overrides.lookup ?? (async (host) => [{ address: host, family: host.includes(":") ? 6 : 4 }]),
    connect: overrides.connect ?? (async () => undefined),
    now: overrides.now ?? (() => 0),
  };
}

async function run(argvExtra: readonly string[], d: DoctorDependencies, extraConfig = "") {
  const out: string[] = [];
  const err: string[] = [];
  const argv = [
    "--gateway", "http://127.0.0.1:8787/mcp",
    "--config", await config(extraConfig),
    "--llm", "openai-compatible",
    "--authorization-server", "http://127.0.0.1:8787",
    "--public-url", "http://127.0.0.1:8790/mcp",
    ...argvExtra,
  ];
  const code = await runDoctor(argv, { stdout: (l) => out.push(l), stderr: (l) => err.push(l) }, d);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("leisen-ask doctor", () => {
  it("すべて届けば ✔ だけで終了コード 0", async () => {
    const { code, out } = await run([], deps());
    expect(code).toBe(0);
    expect(out).toContain("✔ モデル: local-model があります");
    expect(out).toContain("✔ Orchestrator の資格情報: Gateway が受け付けます");
    expect(out).toContain("問題なし");
    expect(out).not.toContain("✘");
  });

  it("LLM が Mac のネットワークのアドレスを指していれば注意し、届かなければ ✘ と原因を出す", async () => {
    const { code, out } = await run(
      ["--skip-chat", "--allow-insecure-upstream"],
      deps({ env: { LEISEN_LLM_BASE_URL: "http://172.20.10.2:1234/v1" }, connect: async (address) => (address === "172.20.10.2" ? "EHOSTUNREACH" : undefined) }),
    );
    expect(code).toBe(1);
    expect(out).toContain("⚠ 名前解決: 172.20.10.2");
    expect(out).toContain("127.0.0.1 を指定してください");
    expect(out).toContain("✘ TCP 172.20.10.2:1234: 接続できません(EHOSTUNREACH)");
    expect(out).toContain("今のネットワークのもの");
    // 届かない先の /models は試さない
    expect(out).not.toContain("GET /models");
  });

  it("localhost が IPv6 だけ届かない場合は、アドレスの選び方を注意する", async () => {
    const { out } = await run(
      ["--skip-chat"],
      deps({
        env: { LEISEN_LLM_BASE_URL: "http://localhost:1234/v1" },
        lookup: async () => [{ address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 }],
        connect: async (address) => (address === "::1" ? "ECONNREFUSED" : undefined),
        routes: { "GET http://localhost:1234/v1/models": () => json({ data: [{ id: "local-model" }] }) },
      }),
    );
    expect(out).toContain("✘ TCP [::1]:1234: 接続できません(ECONNREFUSED)");
    expect(out).toContain("⚠ アドレスの選び方: 2 個のアドレスのうち 1 個にだけ接続できます");
  });

  it("モデルが一覧になければ、利用できる id を示して ✘(会話の要求は送らない)", async () => {
    let chatCalled = false;
    const { code, out } = await run([], deps({ env: { LEISEN_LLM_MODEL: "missing-model" }, routes: { "POST http://127.0.0.1:1234/v1/chat/completions": () => ((chatCalled = true), json({})) } }));
    expect(code).toBe(1);
    expect(out).toContain("✘ モデル: missing-model が一覧にありません");
    expect(out).toContain("local-model, other-model");
    expect(chatCalled).toBe(false);
  });

  it("会話の要求のエラー応答・遅い応答を判定する", async () => {
    const failing = await run([], deps({ routes: { "POST http://127.0.0.1:1234/v1/chat/completions": () => json({ error: { message: "context length exceeded" } }) } }));
    expect(failing.out).toContain("✘ 会話の要求: HTTP 200、エラーの応答");
    let t = 0;
    const slow = await run(
      [],
      deps({ now: () => t, routes: { "POST http://127.0.0.1:1234/v1/chat/completions": () => ((t += 45_000), json({ choices: [] })) } }),
    );
    expect(slow.out).toContain("⚠ 会話の要求: HTTP 200、45.0 秒");
    expect(slow.out).not.toContain("45.0 秒(45.0 秒)");
  });

  it("Orchestrator の資格情報が Gateway と違えば ✘(資格情報の値は出さない)", async () => {
    const { code, out } = await run([], deps({ env: { LEISEN_ORCHESTRATOR_CREDENTIAL: "dev-only-wrong-credential-xxxx" } }));
    expect(code).toBe(1);
    expect(out).toContain("✘ Orchestrator の資格情報: Gateway が拒否しました(401)");
    expect(out).not.toContain("dev-only-wrong-credential-xxxx");
  });

  it("Gateway が止まっていれば /healthz で ✘ とヒント", async () => {
    const { out } = await run(["--skip-chat"], deps({ connect: async (_a, port) => (port === 8787 ? "ECONNREFUSED" : undefined) }));
    expect(out).toContain("✘ TCP 127.0.0.1:8787: 接続できません(ECONNREFUSED)");
    expect(out).not.toContain("GET /healthz");
  });

  it("トークン・runId の有効期間が探索より短ければ注意する", async () => {
    const { out } = await run(
      ["--skip-chat"],
      deps(),
      "gateway: { runs: { ttlSec: 300 }, authorizationServer: { accessTokenTtlSec: 300 } }\norchestrator: { runTimeoutSec: 600 }",
    );
    expect(out).toContain("⚠ runId の有効期間: gateway.runs.ttlSec 300 秒 < run に要る 690 秒");
    expect(out).toContain("⚠ トークンの有効期間: accessTokenTtlSec 300 秒 < run に要る 690 秒");
  });

  it("--json は結果を JSON で出し、API キーを出さない", async () => {
    const { out } = await run(["--json", "--llm-api-key-env", "LLM_KEY"], deps({ env: { LLM_KEY: API_KEY } }));
    const parsed = JSON.parse(out) as { ok: boolean; results: { name: string; status: string }[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.results.some((r) => r.name === "GET /models" && r.status === "ok")).toBe(true);
    expect(out).not.toContain(API_KEY);
    expect(out).not.toContain(CREDENTIAL);
  });

  it("引数の誤りは終了コード 2、leisen-ask のサブコマンドとして呼べる", async () => {
    const err: string[] = [];
    const code = await runCli(["doctor", "--config", "x.yaml"], { stdout: () => undefined, stderr: (l) => err.push(l) }, {
      env: {},
      createLlmClient: () => {
        throw new Error("unused");
      },
      createGatewayClient: () => {
        throw new Error("unused");
      },
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("--gateway");
    expect(err.join("\n")).toContain("usage: leisen-ask doctor");
  });
});
