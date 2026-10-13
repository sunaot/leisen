/**
 * run API(ADR-019 決定3〜8、T-023)の統合テスト。http.Server を port 0 で listen し、生の fetch と
 * SDK の MCP クライアントで検証する。受け入れ条件の認可分岐を先に固定する:
 * - トークンなし・無効なトークン・Orchestrator の資格情報なし / 誤りの /runs 呼び出しが拒否される
 * - 他人の runId・actor の違う runId での tools/call・finish・feedback が拒否される
 * - 署名を改竄した runId・正規でない符号化・未知の kid・期限切れの runId が拒否される
 * - 名前空間付きの runId を申告した tools/call が Orchestrator の資格情報なしで拒否される
 * - 拒否の応答に申告値をエコーしない。拒否した tools/call は新しい単発 run の runId と
 *   invalid_run_id で記録される
 * - fail-closed: 監査ストアに書けないとき POST /runs は runId を返さず、finish / feedback は失敗する
 * - /runs の 3 経路すべてに本文・頻度の上限がかかる。AnswerRun の userId は認証値
 * - Slack が有効な構成では質問原文も citedDocIds も記録されない。プライベートスコープを持つ
 *   ソースが有効なら全件が hashed。有効でない sourceId の引用・searchedSources は記録されない
 * - 署名鍵・資格情報・トークンが応答・監査・ログに出ない
 */
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AuditLogger,
  InMemoryRawQueryStore,
  digestQuery,
  type Actor,
  type AuditRecord,
  type AuditSink,
} from "@leisen/audit";
import {
  GATEWAY_META_KEYS,
  Gateway,
  ORCHESTRATOR_CREDENTIAL_HEADER,
  createGatewayHttpServer,
  createRunIdKeyRing,
  decodeRunIdPayload,
  issueRunId,
  type DeploymentConfig,
  type RunRuntime,
} from "../src/index.js";
import {
  CollectingAuditSink,
  FailingAuditSink,
  MockConnector,
  testConfig,
  testIdpAdapter,
} from "./helpers/proxy.js";

const KEY_A = Buffer.alloc(32, 1);
const KEY_B = Buffer.alloc(32, 2);
const CREDENTIAL = "test-orchestrator-credential-0001";
const NOW_MS = Date.UTC(2026, 9, 11, 12, 0, 0);
const TTL = 600;
const FEEDBACK_WINDOW = 7 * 24 * 3600;
const HUMAN: Actor = { kind: "human" };
const AGENT: Actor = { kind: "agent", agentId: "bot-1", onBehalfOfChain: ["alice"] };

function runtime(overrides: Partial<RunRuntime> = {}): RunRuntime {
  return {
    keys: createRunIdKeyRing({ current: { kid: "k2", key: KEY_B }, previous: { kid: "k1", key: KEY_A } }),
    orchestratorCredential: Buffer.from(CREDENTIAL, "utf8"),
    ttlSeconds: TTL,
    feedbackWindowSeconds: FEEDBACK_WINDOW,
    limits: { maxQuestionChars: 200, maxCitations: 5, maxSearchedSources: 5, maxIdChars: 64 },
    maxBodyBytes: 2048,
    maxRequestsPerUserPerMinute: 100,
    ...overrides,
  };
}

interface HarnessOptions {
  config?: DeploymentConfig;
  runtime?: RunRuntime | undefined;
  sink?: AuditSink & { records?: AuditRecord[] };
  rawQueryStore?: InMemoryRawQueryStore | undefined;
  docIdHmacKey?: string;
  /** MCP エンドポイントのパス(既定 /mcp。run API は同じディレクトリの runs) */
  path?: string;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function startHarness(options: HarnessOptions = {}) {
  const alpha = new MockConnector("alpha");
  const beta = new MockConnector("beta");
  const sink = options.sink ?? new CollectingAuditSink();
  const rawQueryStore = "rawQueryStore" in options ? options.rawQueryStore : new InMemoryRawQueryStore();
  const clock = { nowMs: NOW_MS };
  const gateway = new Gateway({
    config: options.config ?? testConfig(),
    idpAdapter: testIdpAdapter(),
    connectors: [alpha, beta],
    auditLogger: new AuditLogger(sink),
    ...(rawQueryStore !== undefined ? { rawQueryStore } : {}),
    ...("runtime" in options ? (options.runtime !== undefined ? { runs: options.runtime } : {}) : { runs: runtime() }),
    ...(options.docIdHmacKey !== undefined ? { docIdHmacKey: options.docIdHmacKey } : {}),
    now: () => clock.nowMs,
  });
  const mcpPath = options.path ?? "/mcp";
  const server = createGatewayHttpServer(gateway, options.path !== undefined ? { path: options.path } : {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const clients: Client[] = [];
  cleanups.push(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function post(path: string, body: unknown, headers: Record<string, string> = {}, raw?: string) {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: raw ?? JSON.stringify(body),
    });
    const text = await response.text();
    return { response, text, json: text ? (JSON.parse(text) as Record<string, unknown>) : undefined };
  }
  /** credential に null を渡すと資格情報のヘッダを付けない */
  const asOrchestrator = (token = "session-alice", credential: string | null = CREDENTIAL) => ({
    authorization: `Bearer ${token}`,
    ...(credential !== null ? { [ORCHESTRATOR_CREDENTIAL_HEADER]: credential } : {}),
  });
  async function startRun(token = "session-alice", body: Record<string, unknown> = { question: "休暇の申請はどこで出す?" }) {
    const { response, json } = await post("/runs", body, asOrchestrator(token));
    expect(response.status).toBe(201);
    return json as { runId: string; expiresAt: string; feedbackUntil: string };
  }
  async function connect(sessionToken: string, credential?: string): Promise<Client> {
    const client = new Client({ name: "test-orchestrator", version: "0.0.1" });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}${mcpPath}`), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          ...(credential !== undefined ? { [ORCHESTRATOR_CREDENTIAL_HEADER]: credential } : {}),
        },
      },
    });
    await client.connect(transport as Transport);
    return client;
  }
  return { alpha, beta, sink, rawQueryStore, clock, gateway, origin, post, asOrchestrator, startRun, connect };
}

function toolRecords(records: readonly AuditRecord[]) {
  return records.flatMap((r) => (r.recordType === "tool_invocation" ? [r] : []));
}
function ofType<T extends AuditRecord["recordType"]>(records: readonly AuditRecord[], type: T) {
  return records.filter((r): r is Extract<AuditRecord, { recordType: T }> => r.recordType === type);
}
function firstText(result: CallToolResult): unknown {
  const content = result.content[0];
  if (!content || content.type !== "text") throw new Error("expected text content");
  return JSON.parse(content.text);
}
function meta(runId: string, iteration = 0, actor?: Actor) {
  return {
    [GATEWAY_META_KEYS.runId]: runId,
    [GATEWAY_META_KEYS.iteration]: iteration,
    ...(actor !== undefined ? { [GATEWAY_META_KEYS.actor]: actor } : {}),
  };
}
function records(sink: AuditSink & { records?: AuditRecord[] }): AuditRecord[] {
  return sink.records ?? [];
}

describe("POST /runs の認証(本人の Bearer + Orchestrator の資格情報)", () => {
  it.each([
    ["トークンなし", {}, 401, "unauthenticated"],
    ["無効なトークン", { authorization: "Bearer dev-only-unknown" }, 401, "unauthenticated"],
    ["Orchestrator の資格情報なし", { authorization: "Bearer session-alice" }, 403, "orchestrator_credential_invalid"],
    ["Orchestrator の資格情報の誤り", { authorization: "Bearer session-alice", [ORCHESTRATOR_CREDENTIAL_HEADER]: "wrong-credential-0000000" }, 403, "orchestrator_credential_invalid"],
    ["資格情報が空", { authorization: "Bearer session-alice", [ORCHESTRATOR_CREDENTIAL_HEADER]: "" }, 403, "orchestrator_credential_invalid"],
  ] as const)("%s は拒否され、監査にも生クエリ表にも何も残らない", async (_label, headers, status, errorClass) => {
    const { sink, rawQueryStore, post } = await startHarness();
    const { response, text, json } = await post("/runs", { question: "q" }, headers);
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    if (status === 403) {
      expect(json).toEqual({ error: { errorClass, message: expect.any(String) } });
    } else {
      expect((json?.["error"] as { data: { errorClass: string } }).data.errorClass).toBe(errorClass);
    }
    expect(text).not.toContain("session-alice");
    expect(text).not.toContain(CREDENTIAL);
    expect(records(sink)).toHaveLength(0);
    expect(await rawQueryStore?.findByDigest(digestQuery("q"))).toEqual([]);
  });

  it("run API のない構成では /runs は 404、名前空間付きの runId は tools/call で拒否される", async () => {
    const { post, connect, alpha } = await startHarness({ runtime: undefined });
    const { response } = await post("/runs", { question: "q" }, { authorization: "Bearer session-alice", [ORCHESTRATOR_CREDENTIAL_HEADER]: CREDENTIAL });
    expect(response.status).toBe(404);
    const client = await connect("session-alice", CREDENTIAL);
    const result = (await client.callTool({ name: "search", arguments: { source: "alpha", query: "q" }, _meta: meta("r1.k2.x.y") })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatchObject({ errorClass: "invalid_run_id" });
    expect(alpha.calls).toHaveLength(0);
  });

  it("GET は 405、/runs 配下の未知のパス・不正な形の runId は 404、JSON でない本文は 415 / 400", async () => {
    const { origin, post, asOrchestrator } = await startHarness();
    const get = await fetch(`${origin}/runs`, { headers: asOrchestrator() });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    await get.arrayBuffer();
    expect((await post("/runs/r1.k2.x.y/unknown", {}, asOrchestrator())).response.status).toBe(404);
    expect((await post("/runs/not%20valid/finish", {}, asOrchestrator())).response.status).toBe(404);
    expect((await post("/runs/a/b/finish", {}, asOrchestrator())).response.status).toBe(404);
    const notJson = await fetch(`${origin}/runs`, { method: "POST", headers: { ...asOrchestrator(), "content-type": "text/plain" }, body: "question=q" });
    expect(notJson.status).toBe(415);
    await notJson.arrayBuffer();
    const broken = await post("/runs", undefined, asOrchestrator(), "{not json");
    expect(broken.response.status).toBe(400);
  });
});

describe("POST /runs: 署名付き runId の発行と pending の AnswerRun", () => {
  it("runId・期限を返し、生クエリ表 → pending の順に書く。userId は認証値で actor は申告(既定 human)", async () => {
    const { sink, rawQueryStore, post, asOrchestrator } = await startHarness();
    const { response, json } = await post("/runs", { question: "休暇の申請はどこで出す?" }, asOrchestrator());
    expect(response.status).toBe(201);
    const { runId, expiresAt, feedbackUntil } = json as { runId: string; expiresAt: string; feedbackUntil: string };
    expect(runId).toMatch(/^r1\.k2\.[A-Za-z0-9_-]{38}\.[A-Za-z0-9_-]{43}$/);
    expect(runId).not.toContain("alice");
    expect(Date.parse(expiresAt)).toBe(NOW_MS + TTL * 1000);
    expect(Date.parse(feedbackUntil)).toBe(NOW_MS + FEEDBACK_WINDOW * 1000);
    expect(decodeRunIdPayload(runId)).toEqual({ issuedAt: NOW_MS / 1000, ttlSeconds: TTL });

    const pending = ofType(records(sink), "answer_run");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      runId,
      userId: "alice",
      actor: HUMAN,
      startedAt: new Date(NOW_MS).toISOString(),
      finalOutcome: "pending",
      finalQueryDigest: digestQuery("休暇の申請はどこで出す?"),
    });
    expect(JSON.stringify(pending[0])).not.toContain("休暇");
    const raw = await rawQueryStore!.findByDigest(digestQuery("休暇の申請はどこで出す?"));
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ userId: "alice", rawQuery: "休暇の申請はどこで出す?" });
  });

  it("userId・runId は本文で指定できない(未知のキーは拒否)。質問の長さの上限を超えると拒否", async () => {
    const { sink, post, asOrchestrator } = await startHarness();
    for (const body of [
      { question: "q", userId: "bob" },
      { question: "q", runId: "r1.k2.x.y" },
      { question: "x".repeat(201) },
      { question: "" },
      {},
    ]) {
      const { response, json, text } = await post("/runs", body, asOrchestrator());
      expect(response.status).toBe(400);
      expect(json).toMatchObject({ error: { errorClass: "invalid_request" } });
      expect(text).not.toContain("xxxxx");
    }
    expect(records(sink)).toHaveLength(0);
  });

  it("実行区分・actor の申告を ADR-015 の規則で検証する(scheduled は拒否、不正な actor は 400)", async () => {
    const { sink, post, asOrchestrator } = await startHarness();
    const scheduled = await post("/runs", { question: "q", executionClass: "scheduled", actor: AGENT }, asOrchestrator());
    expect(scheduled.response.status).toBe(403);
    expect(scheduled.json).toMatchObject({ error: { errorClass: "execution_class_rejected" } });
    const unknownClass = await post("/runs", { question: "q", executionClass: "cron" }, asOrchestrator());
    expect(unknownClass.response.status).toBe(400);
    const badActor = await post("/runs", { question: "q", actor: { kind: "agent", agentId: "bot" } }, asOrchestrator());
    expect(badActor.response.status).toBe(400);
    expect(records(sink)).toHaveLength(0);
    // agent actor + human_in_the_loop は受け、actor が pending に残る
    const agentRun = await post("/runs", { question: "q", actor: AGENT }, asOrchestrator());
    expect(agentRun.response.status).toBe(201);
    expect(ofType(records(sink), "answer_run")[0]).toMatchObject({ actor: AGENT });
  });
});

describe("tools/call での runId の申告(名前空間付きのキー)", () => {
  it("本人・actor・期限内・Orchestrator の資格情報ありなら、申告した runId と iteration で記録する", async () => {
    const { sink, alpha, startRun, connect } = await startHarness();
    const { runId } = await startRun();
    const client = await connect("session-alice", CREDENTIAL);
    const result = (await client.callTool({ name: "search", arguments: { source: "alpha", query: "q" }, _meta: meta(runId, 3) })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(alpha.calls).toHaveLength(1);
    expect(toolRecords(records(sink))).toEqual([expect.objectContaining({ runId, iteration: 3, userId: "alice", errorClass: null })]);
  });

  it.each([
    ["Orchestrator の資格情報なし", "session-alice", undefined, undefined],
    ["Orchestrator の資格情報の誤り", "session-alice", "wrong-credential-0000000", undefined],
    ["他人のトークン", "session-bob", CREDENTIAL, undefined],
    ["actor の違い", "session-alice", CREDENTIAL, AGENT],
  ] as const)("%s は invalid_run_id で拒否し、新しい単発 run の runId で記録する(申告値をエコー・記録しない)", async (_label, token, credential, actor) => {
    const { sink, alpha, startRun, connect } = await startHarness();
    const { runId } = await startRun("session-alice");
    const client = await connect(token, credential);
    const result = (await client.callTool({ name: "search", arguments: { source: "alpha", query: "q" }, _meta: meta(runId, 1, actor) })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatchObject({ errorClass: "invalid_run_id" });
    expect(JSON.stringify(result)).not.toContain(runId);
    expect(alpha.calls).toHaveLength(0);
    const tools = toolRecords(records(sink));
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ errorClass: "invalid_run_id", iteration: 0, userId: token === "session-bob" ? "bob" : "alice" });
    expect(tools[0]?.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(tools)).not.toContain(runId);
  });

  it("署名の改竄・正規でない符号化・未知の kid・期限切れを拒否し、1 つ前の kid は受ける", async () => {
    const { sink, alpha, clock, startRun, connect } = await startHarness();
    const { runId } = await startRun();
    const client = await connect("session-alice", CREDENTIAL);
    const [v, kid, payload, sig] = runId.split(".") as [string, string, string, string];
    const flippedSig = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const alt = (s: string) => s.slice(0, -1) + alphabet[alphabet.indexOf(s[s.length - 1] as string) ^ 1];
    const candidates = [
      `${v}.${kid}.${payload}.${flippedSig}`,
      `${v}.${kid}.${alt(payload)}.${sig}`,
      `${v}.${kid}.${payload}.${alt(sig)}`,
      `${v}.k9.${payload}.${sig}`,
      issueRunId(createRunIdKeyRing({ current: { kid: "k2", key: Buffer.alloc(32, 3) } }), { subject: { userId: "alice", actor: HUMAN }, ttlSeconds: TTL, nowMs: NOW_MS }).runId,
    ];
    for (const candidate of candidates) {
      const result = (await client.callTool({ name: "search", arguments: { source: "alpha", query: "q" }, _meta: meta(candidate) })) as CallToolResult;
      expect(result.isError, candidate).toBe(true);
      expect(firstText(result)).toMatchObject({ errorClass: "invalid_run_id" });
    }
    expect(alpha.calls).toHaveLength(0);
    expect(toolRecords(records(sink)).every((r) => r.errorClass === "invalid_run_id")).toBe(true);

    // 1 つ前の鍵(k1)で発行された runId は受ける
    const previous = issueRunId(createRunIdKeyRing({ current: { kid: "k1", key: KEY_A } }), { subject: { userId: "alice", actor: HUMAN }, ttlSeconds: TTL, nowMs: NOW_MS });
    const ok = (await client.callTool({ name: "search", arguments: { source: "alpha", query: "q" }, _meta: meta(previous.runId, 2) })) as CallToolResult;
    expect(ok.isError).toBeFalsy();
    expect(toolRecords(records(sink)).at(-1)).toMatchObject({ runId: previous.runId, iteration: 2 });

    // 期限切れ
    clock.nowMs = NOW_MS + TTL * 1000;
    const expired = (await client.callTool({ name: "search", arguments: { source: "alpha", query: "q" }, _meta: meta(runId) })) as CallToolResult;
    expect(expired.isError).toBe(true);
    expect(firstText(expired)).toMatchObject({ errorClass: "invalid_run_id" });
  });

  it("旧キー(裸の runId)に署名付きの形の値を入れても検証と資格情報の要求を受ける(自分の run を Gateway 直接呼び出しで歪められない。TM-I5 (f))", async () => {
    const { sink, alpha, connect, startRun } = await startHarness();
    const { runId } = await startRun("session-alice");
    // Orchestrator の資格情報なしで、UI に出た自分の runId を裸キーに入れて直接呼ぶ
    const direct = await connect("session-alice");
    const rejected = (await direct.callTool({
      name: "search",
      arguments: { source: "alpha", query: "q" },
      _meta: { runId, iteration: 7 },
    })) as CallToolResult;
    expect(rejected.isError).toBe(true);
    expect(firstText(rejected)).toMatchObject({ errorClass: "invalid_run_id" });
    expect(alpha.calls).toHaveLength(0);
    const [record] = toolRecords(records(sink));
    expect(record).toMatchObject({ errorClass: "invalid_run_id", iteration: 0 });
    expect(record?.runId).not.toBe(runId);
    // 資格情報があり本人なら、裸キーでも申告として受理される(名前空間付きのキーと同じ扱い)
    const orchestrator = await connect("session-alice", CREDENTIAL);
    const accepted = (await orchestrator.callTool({
      name: "search",
      arguments: { source: "alpha", query: "q" },
      _meta: { runId, iteration: 7 },
    })) as CallToolResult;
    expect(accepted.isError).not.toBe(true);
    expect(toolRecords(records(sink))[1]).toMatchObject({ runId, iteration: 7, errorClass: null });
  });

  it("run API は MCP のパスと同じディレクトリの runs にある(接頭辞付きの公開でもオリジン直下には出ない)", async () => {
    const { origin, post, asOrchestrator, connect, startRun, sink } = await startHarness({ path: "/leisen/mcp" });
    const root = await post("/runs", { question: "q" }, asOrchestrator());
    expect(root.response.status).toBe(404);
    const prefixed = await post("/leisen/runs", { question: "q" }, asOrchestrator());
    expect(prefixed.response.status).toBe(201);
    const runId = (prefixed.json as { runId: string }).runId;
    const finish = await post(`/leisen/runs/${runId}/finish`, { outcome: "resolved", confidence: 0.5, searchedSources: ["alpha"], citations: [] }, asOrchestrator());
    expect(finish.response.status).toBe(200);
    // 既存の startRun ヘルパーは /runs 固定なので使えない(404)。MCP は /leisen/mcp で動く
    await expect(startRun()).rejects.toThrow();
    const client = await connect("session-alice", CREDENTIAL);
    await client.callTool({ name: "search", arguments: { source: "alpha", query: "q" }, _meta: meta(runId) });
    expect(toolRecords(records(sink))[0]).toMatchObject({ runId, errorClass: null });
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("未申告・旧キー(裸の runId)の呼び出しは従来どおり単発 run として記録する", async () => {
    const { sink, alpha, connect } = await startHarness();
    const client = await connect("session-alice");
    await client.callTool({ name: "search", arguments: { source: "alpha", query: "q" } });
    await client.callTool({ name: "search", arguments: { source: "alpha", query: "q" }, _meta: { runId: "run-bare", iteration: 4 } });
    expect(alpha.calls).toHaveLength(2);
    const tools = toolRecords(records(sink));
    expect(tools[0]?.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(tools[1]).toMatchObject({ runId: "run-bare", iteration: 4, errorClass: null });
  });
});

describe("POST /runs/{runId}/finish と /feedback", () => {
  it("finish は answer_run_finish を Gateway の時刻・認証した userId で書き、有効でないソースの引用と searchedSources を落とす", async () => {
    const { sink, clock, post, asOrchestrator, startRun } = await startHarness();
    const { runId } = await startRun();
    clock.nowMs = NOW_MS + 30_000;
    const { response, json } = await post(
      `/runs/${runId}/finish`,
      {
        outcome: "resolved",
        confidence: 0.9,
        searchedSources: ["alpha", "beta", "alpha", "nope"],
        citations: [
          { sourceId: "alpha", documentId: "doc-1" },
          { sourceId: "nope", documentId: "x" },
          { sourceId: "beta", documentId: "doc-2" },
        ],
      },
      asOrchestrator(),
    );
    expect(response.status).toBe(200);
    expect(json).toEqual({ recorded: true });
    const finish = ofType(records(sink), "answer_run_finish");
    expect(finish).toHaveLength(1);
    expect(finish[0]).toMatchObject({
      runId,
      userId: "alice",
      recordedAt: new Date(NOW_MS + 30_000).toISOString(),
      endedAt: new Date(NOW_MS + 30_000).toISOString(),
      finalOutcome: "resolved",
      confidence: 0.9,
      searchedSources: ["alpha", "beta"],
      citedDocIds: ["alpha:doc-1", "beta:doc-2"],
      failureReason: null,
    });
    expect(finish[0]?.recordId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("feedback は answer_run_feedback を書き、finish の再送でも消えない(別の recordId の部分レコードとして残る)", async () => {
    const { sink, post, asOrchestrator, startRun } = await startHarness();
    const { runId } = await startRun();
    expect((await post(`/runs/${runId}/finish`, { outcome: "unresolved" }, asOrchestrator())).response.status).toBe(200);
    const fb = await post(`/runs/${runId}/feedback`, { outcome: "resolved" }, asOrchestrator());
    expect(fb.response.status).toBe(200);
    expect((await post(`/runs/${runId}/finish`, { outcome: "unresolved" }, asOrchestrator())).response.status).toBe(200);
    const all = records(sink);
    expect(ofType(all, "answer_run_feedback")).toEqual([expect.objectContaining({ runId, userId: "alice", userFeedback: "resolved" })]);
    const finishes = ofType(all, "answer_run_finish");
    expect(finishes).toHaveLength(2);
    expect(new Set(finishes.map((r) => r.recordId)).size).toBe(2);
  });

  it.each([
    ["Orchestrator の資格情報なし", "session-alice", null, undefined, 403, "orchestrator_credential_invalid"],
    ["他人のトークン", "session-bob", CREDENTIAL, undefined, 403, "invalid_run_id"],
    ["actor の違い", "session-alice", CREDENTIAL, AGENT, 403, "invalid_run_id"],
  ] as const)("finish / feedback: %s は拒否され、何も記録せず runId をエコーしない", async (_label, token, credential, actor, status, errorClass) => {
    const { sink, post, asOrchestrator, startRun } = await startHarness();
    const { runId } = await startRun("session-alice");
    const before = records(sink).length;
    const headers = asOrchestrator(token, credential);
    const finish = await post(`/runs/${runId}/finish`, { outcome: "resolved", ...(actor ? { actor } : {}) }, headers);
    expect(finish.response.status).toBe(status);
    expect(finish.json).toEqual({ error: { errorClass, message: expect.any(String) } });
    expect(finish.text).not.toContain(runId);
    const feedback = await post(`/runs/${runId}/feedback`, { outcome: "resolved", ...(actor ? { actor } : {}) }, headers);
    expect(feedback.response.status).toBe(status);
    expect(feedback.json).toEqual({ error: { errorClass, message: expect.any(String) } });
    expect(feedback.text).not.toContain(runId);
    expect(records(sink)).toHaveLength(before);
  });

  it("改竄・未知の kid・期限切れの runId を拒否する。feedback は有効期間後もフィードバックの期間内なら受ける", async () => {
    const { sink, clock, post, asOrchestrator, startRun } = await startHarness();
    const { runId } = await startRun();
    const [v, kid, payload, sig] = runId.split(".") as [string, string, string, string];
    for (const bad of [`${v}.${kid}.${payload}.${"A".repeat(43)}`, `${v}.k9.${payload}.${sig}`, "8b3c7c1e-7e0d-4a4f-9d4e-0d7b3f1f3a2a"]) {
      const r = await post(`/runs/${bad}/finish`, { outcome: "resolved" }, asOrchestrator());
      expect(r.response.status, bad).toBe(403);
      expect(r.json).toMatchObject({ error: { errorClass: "invalid_run_id" } });
    }
    clock.nowMs = NOW_MS + TTL * 1000;
    const late = await post(`/runs/${runId}/finish`, { outcome: "resolved" }, asOrchestrator());
    expect(late.response.status).toBe(403);
    expect(late.json).toMatchObject({ error: { errorClass: "invalid_run_id" } });
    const feedbackOk = await post(`/runs/${runId}/feedback`, { outcome: "unresolved" }, asOrchestrator());
    expect(feedbackOk.response.status).toBe(200);
    clock.nowMs = NOW_MS + FEEDBACK_WINDOW * 1000;
    const feedbackLate = await post(`/runs/${runId}/feedback`, { outcome: "unresolved" }, asOrchestrator());
    expect(feedbackLate.response.status).toBe(403);
    expect(ofType(records(sink), "answer_run_finish")).toHaveLength(0);
    expect(ofType(records(sink), "answer_run_feedback")).toHaveLength(1);
  });

  it("agent actor の run は同じ actor を申告した finish / feedback だけが通る", async () => {
    const { sink, post, asOrchestrator, startRun } = await startHarness();
    const { runId } = await startRun("session-alice", { question: "q", actor: AGENT });
    expect((await post(`/runs/${runId}/finish`, { outcome: "resolved" }, asOrchestrator())).response.status).toBe(403);
    expect((await post(`/runs/${runId}/finish`, { outcome: "resolved", actor: AGENT }, asOrchestrator())).response.status).toBe(200);
    expect((await post(`/runs/${runId}/feedback`, { outcome: "resolved", actor: AGENT }, asOrchestrator())).response.status).toBe(200);
    expect(ofType(records(sink), "answer_run_finish")).toHaveLength(1);
  });

  it("本文の検証: pending は不可、引用の件数・識別子の長さ・confidence の範囲・failureReason の形に上限", async () => {
    const { post, asOrchestrator, startRun } = await startHarness();
    const { runId } = await startRun();
    for (const body of [
      { outcome: "pending" },
      { outcome: "resolved", citations: Array.from({ length: 6 }, (_, i) => ({ sourceId: "alpha", documentId: `d${i}` })) },
      { outcome: "resolved", searchedSources: ["a", "b", "c", "d", "e", "f"] },
      { outcome: "resolved", citations: [{ sourceId: "alpha", documentId: "x".repeat(65) }] },
      { outcome: "resolved", confidence: 2 },
      { outcome: "error", failureReason: "Timeout: upstream" },
      { outcome: "resolved", userId: "bob" },
    ]) {
      const { response, json } = await post(`/runs/${runId}/finish`, body, asOrchestrator());
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(json).toMatchObject({ error: { errorClass: "invalid_request" } });
    }
    expect((await post(`/runs/${runId}/feedback`, { outcome: "error" }, asOrchestrator())).response.status).toBe(400);
  });
});

describe("fail-closed(ADR-011 §4、ADR-019 決定6)", () => {
  it("監査ストアに書けないとき POST /runs は runId を返さず、finish / feedback は 503 で失敗する", async () => {
    const working = await startHarness();
    const { runId } = await working.startRun();
    const failing = new FailingAuditSink();
    const { post, asOrchestrator, rawQueryStore } = await startHarness({ sink: failing });
    const start = await post("/runs", { question: "q" }, asOrchestrator());
    expect(start.response.status).toBe(503);
    expect(start.json).toEqual({ error: { errorClass: "audit_write_failed", message: expect.any(String) } });
    expect(start.text).not.toContain("injected");
    expect(JSON.stringify(start.json)).not.toContain("runId");
    // 生クエリ表には書けた分が残る(保持期間で消える。決定6)
    expect(await rawQueryStore!.findByDigest(digestQuery("q"))).toHaveLength(1);
    const finish = await post(`/runs/${runId}/finish`, { outcome: "resolved" }, asOrchestrator());
    expect(finish.response.status).toBe(503);
    const feedback = await post(`/runs/${runId}/feedback`, { outcome: "resolved" }, asOrchestrator());
    expect(feedback.response.status).toBe(503);
    expect(failing.attempts).toBeGreaterThanOrEqual(3);
  });

  it("生クエリ表に書けないときも POST /runs は runId を返さない(pending を書かない)", async () => {
    const sink = new CollectingAuditSink();
    const broken = new InMemoryRawQueryStore();
    broken.append = async () => {
      throw new Error("injected raw query failure");
    };
    const { post, asOrchestrator } = await startHarness({ sink, rawQueryStore: broken });
    const start = await post("/runs", { question: "q" }, asOrchestrator());
    expect(start.response.status).toBe(503);
    expect(start.text).not.toContain("injected");
    expect(sink.records).toHaveLength(0);
  });

  it("明示的に fail-open にした構成では書けなくても応答する(run API も同じ設定に従う)", async () => {
    const config = testConfig({ audit: { failureMode: "fail-open", confirmFailOpen: true } });
    const { post, asOrchestrator } = await startHarness({ sink: new FailingAuditSink(), config });
    const start = await post("/runs", { question: "q" }, asOrchestrator());
    expect(start.response.status).toBe(201);
    const { runId } = start.json as { runId: string };
    expect((await post(`/runs/${runId}/finish`, { outcome: "resolved" }, asOrchestrator())).response.status).toBe(200);
    expect((await post(`/runs/${runId}/feedback`, { outcome: "resolved" }, asOrchestrator())).response.status).toBe(200);
  });
});

describe("上限(TM-I5 (d))", () => {
  it("本文の大きさの上限は 3 経路すべてにかかる(413、接続を閉じる)", async () => {
    const { post, asOrchestrator, startRun } = await startHarness();
    const { runId } = await startRun();
    const big = JSON.stringify({ outcome: "resolved", searchedSources: ["x".repeat(3000)] });
    for (const path of ["/runs", `/runs/${runId}/finish`, `/runs/${runId}/feedback`]) {
      const { response, json } = await post(path, undefined, asOrchestrator(), big);
      expect(response.status, path).toBe(413);
      expect(response.headers.get("connection")).toBe("close");
      expect(json).toMatchObject({ error: { data: { errorClass: "payload_too_large" } } });
    }
  });

  it("利用者ごとの頻度上限は 3 経路の合計にかかり、他の利用者には影響しない", async () => {
    const { post, asOrchestrator, startRun } = await startHarness({ runtime: runtime({ maxRequestsPerUserPerMinute: 6 }) });
    const { runId } = await startRun(); // 1
    expect((await post(`/runs/${runId}/finish`, { outcome: "resolved" }, asOrchestrator())).response.status).toBe(200); // 2
    for (let i = 0; i < 4; i++) {
      expect((await post(`/runs/${runId}/feedback`, { outcome: "resolved" }, asOrchestrator())).response.status).toBe(200); // 3..6
    }
    const limited = await post("/runs", { question: "q" }, asOrchestrator());
    expect(limited.response.status).toBe(429);
    expect(limited.response.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(limited.json).toMatchObject({ error: { errorClass: "rate_limited" } });
    expect((await post(`/runs/${runId}/feedback`, { outcome: "resolved" }, asOrchestrator())).response.status).toBe(429);
    // 別の利用者は通る
    expect((await post("/runs", { question: "q" }, asOrchestrator("session-bob"))).response.status).toBe(201);
  });
});

describe("引用 docId の記録規則(ADR-019 決定5・7)", () => {
  it("Slack が有効な構成では質問原文を生クエリ表に書かず、citedDocIds も記録しない(他の sourceId で申告された Slack 形式の docId も残らない)", async () => {
    const config = testConfig({ connectors: [{ id: "alpha" }, { id: "beta", kind: "slack-rts" }] });
    const { sink, rawQueryStore, post, asOrchestrator, startRun } = await startHarness({ config });
    const { runId } = await startRun("session-alice", { question: "Slack で決まったこと" });
    expect(await rawQueryStore!.findByDigest(digestQuery("Slack で決まったこと"))).toEqual([]);
    expect(ofType(records(sink), "answer_run")[0]).toMatchObject({ finalQueryDigest: digestQuery("Slack で決まったこと") });
    const { response } = await post(
      `/runs/${runId}/finish`,
      {
        outcome: "resolved",
        searchedSources: ["alpha", "beta"],
        citations: [
          { sourceId: "alpha", documentId: "C123:1700000000.000100" },
          { sourceId: "alpha", documentId: "doc-1" },
          { sourceId: "beta", documentId: "C123:1700000000.000200" },
        ],
      },
      asOrchestrator(),
    );
    expect(response.status).toBe(200);
    const finish = ofType(records(sink), "answer_run_finish")[0];
    expect(finish).toMatchObject({ citedDocIds: [], searchedSources: ["alpha", "beta"] });
    expect(JSON.stringify(records(sink))).not.toContain("1700000000");
    expect(JSON.stringify(records(sink))).not.toContain("doc-1");
  });

  it("プライベートスコープを持つソースが有効なら、全件(shared に見える引用も)に hashed の規則をかける", async () => {
    const config = testConfig({
      connectors: [{ id: "alpha" }, { id: "beta", privateScopes: "included", confirmPrivateScopesIncluded: true }],
    });
    const { sink, post, asOrchestrator, startRun } = await startHarness({ config, docIdHmacKey: "dev-only-audit-hmac-key" });
    const { runId } = await startRun();
    const { response } = await post(
      `/runs/${runId}/finish`,
      { outcome: "resolved", citations: [{ sourceId: "alpha", documentId: "doc-1" }, { sourceId: "beta", documentId: "dm-1" }] },
      asOrchestrator(),
    );
    expect(response.status).toBe(200);
    const finish = ofType(records(sink), "answer_run_finish")[0]!;
    expect(finish.citedDocIds).toHaveLength(2);
    for (const id of finish.citedDocIds) expect(id).toMatch(/^hmac:[0-9a-f]{64}$/);
    expect(JSON.stringify(finish)).not.toContain("doc-1");
    expect(JSON.stringify(finish)).not.toContain("dev-only-audit-hmac-key");
  });

  it("hashed なのに鍵がない構成では finish を平文に倒さず 503 で拒否する", async () => {
    const config = testConfig({
      connectors: [{ id: "alpha" }, { id: "beta", privateScopes: "included", confirmPrivateScopesIncluded: true }],
    });
    const { sink, post, asOrchestrator, startRun } = await startHarness({ config });
    const { runId } = await startRun();
    const { response } = await post(`/runs/${runId}/finish`, { outcome: "resolved", citations: [{ sourceId: "alpha", documentId: "doc-1" }] }, asOrchestrator());
    expect(response.status).toBe(503);
    expect(ofType(records(sink), "answer_run_finish")).toHaveLength(0);
  });
});
