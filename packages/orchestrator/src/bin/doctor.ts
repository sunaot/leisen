/**
 * leisen-ask doctor — Orchestrator から見た経路を順に確かめて、どこで止まっているかを示す
 * 診断ツール(手元の開発・導入時の切り分け用)。
 *
 * `leisen-ask serve` と同じ引数・環境変数で実行する(`serve` を `doctor` に置き換えるだけ)。
 * serve を起動しないで、次を確かめる:
 *   1. 設定: deployment.yaml の読み込み、探索の時間上限と runId・トークンの有効期間の釣り合い
 *   2. LLM: 接続先のホストが引くアドレス(IPv4 / IPv6)と各アドレスへの TCP 接続、`/models` と
 *      モデルの有無、短い会話の要求 1 回(応答時間)。Mac のネットワークのアドレス(172.x 等)を
 *      指していればネットワークが変わると届かなくなる旨を注意する
 *   3. Gateway: アドレスと TCP 接続、`/healthz`、認可サーバーを使う構成ならメタデータと
 *      `/token` での Orchestrator の資格情報の照合(交換の中身を送らないので監査に残らない)
 *   4. serve の待ち受け先: 既に serve が応答しているか
 *
 * トークン・API キー・Orchestrator の資格情報・プロンプトの本文は出さない(不変条件6)。URL は
 * スキーム・ホスト・ポートだけを出す。
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, Socket } from "node:net";
import { parseArgs } from "node:util";
import { loadDeploymentConfig, DeploymentConfigError } from "@leisen/gateway";
import { orchestratorSettingsSchema } from "../config.js";
import type { CliIo } from "./leisen-ask.js";
import { accessTokenTtlWarning, askTokenLifetimeMs, parseServeArgs, ServeUsageError, settingsFromDeployment, type ServeArgs } from "./serve.js";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface CheckResult {
  readonly section: string;
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly hint?: string;
  readonly ms?: number;
}

export interface DoctorDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** 名前解決(既定 node:dns の lookup、all: true) */
  readonly lookup?: (host: string) => Promise<readonly { address: string; family: number }[]>;
  /** TCP 接続を試す(既定 node:net。成功なら undefined、失敗ならエラーコード) */
  readonly connect?: (address: string, port: number, timeoutMs: number) => Promise<string | undefined>;
  readonly now?: () => number;
}

export const DOCTOR_USAGE = [
  "usage: leisen-ask doctor <leisen-ask serve と同じ引数> [--skip-chat] [--json]",
  "",
  "  serve を起動せずに、設定・LLM・Gateway への経路を順に確かめて結果を一覧にします。",
  "  serve と同じ引数・環境変数(LEISEN_LLM_BASE_URL / LEISEN_LLM_MODEL 等)で実行してください。",
  "  --skip-chat  LLM への短い会話の要求(1 回)を送らない",
  "  --json       結果を JSON で標準出力に出す",
  "  問題(✘)があれば終了コード 1、引数の誤りは 2。",
].join("\n");

const TCP_TIMEOUT_MS = 3_000;
const HTTP_TIMEOUT_MS = 10_000;

function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "(URL を解釈できない)";
  }
}

function isLoopbackAddress(address: string): boolean {
  return address === "::1" || address.startsWith("127.");
}

/** Mac のネットワークで振られる私設アドレス(ネットワークが変わると変わりうる)。 */
function isPrivateLanAddress(address: string): boolean {
  return /^10\./.test(address) || /^192\.168\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address) || /^169\.254\./.test(address);
}

async function defaultLookup(host: string): Promise<readonly { address: string; family: number }[]> {
  return dnsLookup(host, { all: true, verbatim: true });
}

function defaultConnect(address: string, port: number, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (code: string | undefined) => {
      socket.destroy();
      resolve(code);
    };
    socket.setTimeout(timeoutMs, () => done("ETIMEDOUT"));
    socket.once("error", (error: NodeJS.ErrnoException) => done(error.code ?? "ERROR"));
    socket.connect(port, address, () => done(undefined));
  });
}

function portOf(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

class Recorder {
  readonly results: CheckResult[] = [];
  add(result: CheckResult): CheckResult {
    this.results.push(result);
    return result;
  }
}

/** ホストの名前解決と、各アドレスへの TCP 接続。届くアドレスがなければ fail。 */
async function checkNetwork(
  rec: Recorder,
  section: string,
  rawUrl: string,
  deps: Required<Pick<DoctorDependencies, "lookup" | "connect" | "now">>,
  role: string,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    rec.add({ section, name: "URL", status: "fail", detail: "URL を解釈できません" });
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = portOf(url);
  let addresses: readonly { address: string; family: number }[];
  const t0 = deps.now();
  try {
    addresses = isIP(host) !== 0 ? [{ address: host, family: isIP(host) }] : await deps.lookup(host);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "ERROR";
    rec.add({ section, name: "名前解決", status: "fail", detail: `${host} を引けません(${code})`, hint: "ホスト名の綴りと、ネットワーク(VPN・テザリング等)の状態を確かめてください" });
    return false;
  }
  const list = addresses.map((a) => `${a.address}(IPv${a.family})`).join(", ");
  const lan = addresses.find((a) => isPrivateLanAddress(a.address));
  rec.add({
    section,
    name: "名前解決",
    status: lan !== undefined ? "warn" : "ok",
    detail: `${host} → ${list}`,
    ms: deps.now() - t0,
    ...(lan !== undefined
      ? { hint: `${role}が Mac のネットワークのアドレス(${lan.address})を指しています。Wi-Fi・テザリング等でネットワークが変わるとアドレスが変わり届かなくなります。同じ Mac で動いているなら 127.0.0.1 を指定してください` }
      : {}),
  });
  let reachable = 0;
  for (const { address } of addresses) {
    const t = deps.now();
    const code = await deps.connect(address, port, TCP_TIMEOUT_MS);
    if (code === undefined) reachable += 1;
    rec.add({
      section,
      name: `TCP ${address.includes(":") ? `[${address}]` : address}:${port}`,
      status: code === undefined ? "ok" : "fail",
      detail: code === undefined ? "接続できます" : `接続できません(${code})`,
      ms: deps.now() - t,
      ...(code !== undefined
        ? {
            hint:
              code === "ECONNREFUSED"
                ? `そのアドレス・ポートで待ち受けているものがありません。${role}が起動しているか、待ち受けのアドレス(IPv4 / IPv6、ローカルネットワークでの待ち受けの設定)とポートを確かめてください`
                : code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "ENETUNREACH"
                  ? "経路がありません。アドレスが今のネットワークのものか、ファイアウォールを確かめてください"
                  : undefined,
          }
        : {}),
    } as CheckResult);
  }
  if (addresses.length > 1 && reachable > 0 && reachable < addresses.length) {
    rec.add({
      section,
      name: "アドレスの選び方",
      status: "warn",
      detail: `${addresses.length} 個のアドレスのうち ${reachable} 個にだけ接続できます`,
      hint: "Node は届かないほうのアドレスを先に試すことがあります(例: localhost が IPv6 の ::1 を引き、待ち受けは IPv4 だけ)。届くアドレス(127.0.0.1 等)を直接指定すると確実です",
    });
  }
  return reachable > 0;
}

async function timedFetch(
  f: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  now: () => number,
): Promise<{ response?: Response; error?: string; ms: number }> {
  const t0 = now();
  try {
    const response = await f(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    return { response, ms: now() - t0 };
  } catch (error) {
    const e = error as { name?: string; cause?: { code?: string } };
    const code = e.name === "TimeoutError" ? "timeout" : e.cause?.code ?? e.name ?? "error";
    return { error: code, ms: now() - t0 };
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function checkLlm(rec: Recorder, args: ServeArgs, deps: Required<Omit<DoctorDependencies, "env">> & { env: DoctorDependencies["env"] }, skipChat: boolean): Promise<void> {
  const section = "LLM";
  const llm = args.llm as { provider?: string; baseUrl?: string; model?: string; apiKeyEnv?: string; timeoutMs?: number };
  if (llm.provider !== "openai_compatible" || llm.baseUrl === undefined) {
    rec.add({ section, name: "バックエンド", status: "skip", detail: `${llm.provider ?? "anthropic"}(Claude API)。接続の診断は OpenAI 互換(LM Studio 等)だけ対応` });
    return;
  }
  const base = llm.baseUrl.replace(/\/+$/, "");
  rec.add({ section, name: "設定", status: "ok", detail: `OpenAI 互換、接続先 ${originOf(base)}、モデル ${llm.model ?? "(未指定)"}` });
  if (!(await checkNetwork(rec, section, base, deps, "LLM の接続先"))) {
    return;
  }
  const headers: Record<string, string> = { accept: "application/json" };
  const key = llm.apiKeyEnv !== undefined ? deps.env[llm.apiKeyEnv] : undefined;
  if (key !== undefined && key !== "") headers["authorization"] = `Bearer ${key}`;
  const models = await timedFetch(deps.fetch, `${base}/models`, { headers }, HTTP_TIMEOUT_MS, deps.now);
  if (models.response === undefined) {
    rec.add({ section, name: "GET /models", status: "fail", detail: `応答がありません(${models.error})`, ms: models.ms, hint: "Orchestrator と同じ Node の fetch で届きません。上の TCP の結果と、LLM のサーバーが起動しているかを確かめてください" });
    return;
  }
  const body = await readJson(models.response);
  const ids = isRecord(body) && Array.isArray(body["data"]) ? body["data"].map((m) => (isRecord(m) && typeof m["id"] === "string" ? m["id"] : "")).filter((id) => id !== "") : [];
  if (!models.response.ok) {
    rec.add({ section, name: "GET /models", status: "fail", detail: `HTTP ${models.response.status}`, ms: models.ms, hint: models.response.status === 404 ? "ベース URL の末尾(/v1 の有無)を確かめてください" : models.response.status === 401 ? "API キー(--llm-api-key-env)を確かめてください" : undefined } as CheckResult);
    return;
  }
  rec.add({ section, name: "GET /models", status: "ok", detail: `HTTP 200、モデル ${ids.length} 件`, ms: models.ms });
  if (llm.model !== undefined) {
    const found = ids.includes(llm.model);
    rec.add({
      section,
      name: "モデル",
      status: found ? "ok" : "fail",
      detail: found ? `${llm.model} があります` : `${llm.model} が一覧にありません`,
      ...(found ? {} : { hint: `利用できるモデル: ${ids.join(", ") || "(なし)"}。LEISEN_LLM_MODEL(--model)を一覧の id に合わせてください` }),
    });
    if (!found) return;
  }
  if (skipChat) {
    rec.add({ section, name: "会話の要求", status: "skip", detail: "--skip-chat" });
    return;
  }
  const timeoutMs = llm.timeoutMs ?? 120_000;
  const chat = await timedFetch(
    deps.fetch,
    `${base}/chat/completions`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ model: llm.model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 16, stream: false }),
    },
    timeoutMs,
    deps.now,
  );
  if (chat.response === undefined) {
    rec.add({ section, name: "会話の要求", status: "fail", detail: `応答がありません(${chat.error})`, ms: chat.ms, hint: chat.error === "timeout" ? `${Math.round(timeoutMs / 1000)} 秒以内に応答がありません。モデルの読み込み中・メモリ不足・別の要求の処理中を疑ってください(LLM のサーバーのログ)` : undefined } as CheckResult);
    return;
  }
  const chatBody = await readJson(chat.response);
  const errorObject = isRecord(chatBody) && isRecord(chatBody["error"]);
  if (!chat.response.ok || errorObject) {
    rec.add({ section, name: "会話の要求", status: "fail", detail: `HTTP ${chat.response.status}${errorObject ? "、エラーの応答" : ""}`, ms: chat.ms, hint: "LLM のサーバーのログで、この時刻のエラー(コンテキスト長・メモリ・モデルの読み込み)を確かめてください" });
    return;
  }
  rec.add({
    section,
    name: "会話の要求",
    status: chat.ms > 30_000 ? "warn" : "ok",
    // 所要時間は detail に書く(ms を付けると括弧で二重に出る)
    detail: `HTTP 200、${(chat.ms / 1000).toFixed(1)} 秒`,
    ...(chat.ms > 30_000 ? { hint: "短い要求でも遅いです。探索の 1 手はさらに時間がかかります。モデルの推論の設定(thinking)や、orchestrator.runTimeoutSec を見直してください" } : {}),
  });
}

async function checkGateway(rec: Recorder, args: ServeArgs, deps: Required<Omit<DoctorDependencies, "env">>): Promise<void> {
  const section = "Gateway";
  rec.add({ section, name: "設定", status: "ok", detail: `MCP エンドポイント ${originOf(args.gateway)}` });
  if (!(await checkNetwork(rec, section, args.gateway, deps, "Gateway"))) {
    return;
  }
  const origin = new URL(args.gateway).origin;
  const health = await timedFetch(deps.fetch, `${origin}/healthz`, {}, HTTP_TIMEOUT_MS, deps.now);
  rec.add(
    health.response?.ok === true
      ? { section, name: "GET /healthz", status: "ok", detail: "HTTP 200", ms: health.ms }
      : { section, name: "GET /healthz", status: "fail", detail: health.response !== undefined ? `HTTP ${health.response.status}` : `応答がありません(${health.error})`, ms: health.ms, hint: "Gateway が起動しているか、--gateway のホスト・ポートを確かめてください" },
  );
  if (args.authorizationServer === undefined) {
    rec.add({ section, name: "認可サーバー", status: "skip", detail: "--authorization-server なし(IdP のトークンをそのまま Gateway に渡す構成)" });
    return;
  }
  const meta = await timedFetch(deps.fetch, `${origin}/.well-known/oauth-authorization-server`, {}, HTTP_TIMEOUT_MS, deps.now);
  const metaBody = meta.response?.ok === true ? await readJson(meta.response) : undefined;
  const issuer = isRecord(metaBody) && typeof metaBody["issuer"] === "string" ? metaBody["issuer"] : undefined;
  if (issuer === undefined) {
    rec.add({ section, name: "認可サーバーのメタデータ", status: "fail", detail: meta.response !== undefined ? `HTTP ${meta.response.status}` : `応答がありません(${meta.error})`, hint: "Gateway の gateway.authorizationServer.enabled: true を確かめてください" });
  } else {
    const same = issuer.replace(/\/+$/, "") === args.authorizationServer.issuer.replace(/\/+$/, "");
    rec.add({
      section,
      name: "認可サーバーのメタデータ",
      status: same ? "ok" : "warn",
      detail: `issuer ${issuer}`,
      ...(same ? {} : { hint: `--authorization-server(${args.authorizationServer.issuer})と Gateway の発行者(publicBaseUrl)が違います` }),
    });
  }
  // 交換の中身なしで Orchestrator の資格情報だけを照合する(401 = 資格情報の不一致、400 = 一致)
  const basic = Buffer.from(`leisen-orchestrator:${args.orchestratorCredential}`).toString("base64");
  const probe = await timedFetch(
    deps.fetch,
    `${origin}/token`,
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` }, body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange" },
    HTTP_TIMEOUT_MS,
    deps.now,
  );
  const status = probe.response?.status;
  rec.add(
    status === 400
      ? { section, name: "Orchestrator の資格情報", status: "ok", detail: "Gateway が受け付けます", ms: probe.ms }
      : status === 401
        ? { section, name: "Orchestrator の資格情報", status: "fail", detail: "Gateway が拒否しました(401)", ms: probe.ms, hint: "LEISEN_ORCHESTRATOR_CREDENTIAL を Gateway と同じ値にしてください(両方とも未設定なら開発用の既定値で一致します)" }
        : { section, name: "Orchestrator の資格情報", status: "fail", detail: status !== undefined ? `想定外の応答(HTTP ${status})` : `応答がありません(${probe.error})`, ms: probe.ms },
  );
}

function checkConfig(rec: Recorder, args: ServeArgs): { ok: boolean } {
  const section = "設定";
  let config: ReturnType<typeof loadDeploymentConfig>;
  try {
    config = loadDeploymentConfig(args.config);
  } catch (error) {
    rec.add({ section, name: "deployment.yaml", status: "fail", detail: error instanceof DeploymentConfigError ? error.message : "読めませんでした" });
    return { ok: false };
  }
  rec.add({ section, name: "deployment.yaml", status: "ok", detail: `${config.deployment.name}、有効なソース ${config.connectors.filter((c) => c.enabled).map((c) => c.id).join(", ") || "(なし)"}` });
  const settings = orchestratorSettingsSchema.parse(settingsFromDeployment(config));
  const needMs = askTokenLifetimeMs(settings);
  rec.add({ section, name: "探索の時間上限", status: "ok", detail: `${Math.round(settings.runTimeoutMs / 1000)} 秒 + 最終ターン ${Math.round(settings.finalTurnTimeoutMs / 1000)} 秒(orchestrator.runTimeoutSec)` });
  const runTtlSec = config.gateway.runs.ttlSec;
  if (runTtlSec * 1000 < needMs) {
    rec.add({ section, name: "runId の有効期間", status: "warn", detail: `gateway.runs.ttlSec ${runTtlSec} 秒 < run に要る ${Math.ceil(needMs / 1000)} 秒`, hint: "探索は runId の有効期間に合わせて短くされます。gateway.runs.ttlSec を延ばすか、orchestrator.runTimeoutSec を短くしてください" });
  } else {
    rec.add({ section, name: "runId の有効期間", status: "ok", detail: `gateway.runs.ttlSec ${runTtlSec} 秒` });
  }
  if (args.authorizationServer !== undefined) {
    const warning = accessTokenTtlWarning(config, settings);
    rec.add(
      warning === undefined
        ? { section, name: "トークンの有効期間", status: "ok", detail: `gateway.authorizationServer.accessTokenTtlSec ${config.gateway.authorizationServer.accessTokenTtlSec} 秒` }
        : { section, name: "トークンの有効期間", status: "warn", detail: `accessTokenTtlSec ${config.gateway.authorizationServer.accessTokenTtlSec} 秒 < run に要る ${Math.ceil(needMs / 1000)} 秒`, hint: warning },
    );
  }
  return { ok: true };
}

async function checkListen(rec: Recorder, args: ServeArgs, deps: Required<Omit<DoctorDependencies, "env">>): Promise<void> {
  const host = args.listen.host.includes(":") ? `[${args.listen.host}]` : args.listen.host;
  const target = host === "0.0.0.0" ? "127.0.0.1" : host === "[::]" ? "[::1]" : host;
  const health = await timedFetch(deps.fetch, `http://${target}:${args.listen.port}/healthz`, {}, 3_000, deps.now);
  rec.add(
    health.response?.ok === true
      ? { section: "serve", name: `待ち受け ${host}:${args.listen.port}`, status: "ok", detail: "serve が応答しています(起動中)" }
      : { section: "serve", name: `待ち受け ${host}:${args.listen.port}`, status: "skip", detail: "応答なし(serve は起動していません。起動すればここで待ち受けます)" },
  );
}

const MARK: Record<CheckStatus, string> = { ok: "✔", warn: "⚠", fail: "✘", skip: "·" };

export function formatResults(results: readonly CheckResult[]): string {
  const lines: string[] = [];
  let section = "";
  for (const r of results) {
    if (r.section !== section) {
      section = r.section;
      lines.push("", `■ ${section}`);
    }
    const ms = r.ms !== undefined && r.ms >= 1 ? `(${r.ms < 1000 ? `${Math.round(r.ms)} ms` : `${(r.ms / 1000).toFixed(1)} 秒`})` : "";
    lines.push(`  ${MARK[r.status]} ${r.name}: ${r.detail}${ms}`);
    if (r.hint !== undefined) lines.push(`      → ${r.hint}`);
  }
  const fails = results.filter((r) => r.status === "fail").length;
  const warns = results.filter((r) => r.status === "warn").length;
  lines.push("", fails === 0 ? `問題なし(注意 ${warns} 件)` : `問題 ${fails} 件、注意 ${warns} 件。最初の ✘ から順に直してください`);
  return lines.join("\n").replace(/^\n/, "");
}

export async function runDoctor(argv: readonly string[], io: CliIo, deps: DoctorDependencies): Promise<number> {
  const skipChat = argv.includes("--skip-chat");
  const json = argv.includes("--json");
  const rest = argv.filter((a) => a !== "--skip-chat" && a !== "--json");
  if (rest.includes("--help") || rest.includes("-h") || rest[0] === "help") {
    io.stdout(DOCTOR_USAGE);
    return 0;
  }
  let args: ServeArgs;
  try {
    const parsed = parseServeArgs(rest, deps.env);
    if (parsed === "help") {
      io.stdout(DOCTOR_USAGE);
      return 0;
    }
    args = parsed;
  } catch (error) {
    io.stderr(`leisen-ask doctor: ${error instanceof ServeUsageError ? error.message : "引数を解釈できませんでした。"}`);
    io.stderr(DOCTOR_USAGE);
    return 2;
  }
  const full = {
    fetch: deps.fetch ?? fetch,
    lookup: deps.lookup ?? defaultLookup,
    connect: deps.connect ?? defaultConnect,
    now: deps.now ?? Date.now,
    env: deps.env,
  };
  const rec = new Recorder();
  checkConfig(rec, args);
  await checkLlm(rec, args, full, skipChat);
  await checkGateway(rec, args, full);
  await checkListen(rec, args, full);
  const failed = rec.results.some((r) => r.status === "fail");
  if (json) {
    io.stdout(JSON.stringify({ ok: !failed, results: rec.results }, null, 2));
  } else {
    io.stdout(formatResults(rec.results));
  }
  return failed ? 1 : 0;
}
