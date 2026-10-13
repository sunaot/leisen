/**
 * Orchestrator の MCP サーバーの Streamable HTTP トランスポート(T-021、ADR-018 決定1・2・7)。
 *
 * Gateway の proxy/http.ts と同じ構造: Node 標準の node:http に SDK の
 * StreamableHTTPServerTransport を載せる(新規の外部依存を足さない)。SDK に触れるのは
 * serveMcpRequest()(トランスポート生成と handleRequest)だけで、認証の前段・本文の読み込み・
 * ルーティング・拒否応答は SDK 非依存の関数に分けてある。
 *
 * - 認証は Gateway に委譲する(決定2): Orchestrator は IdP を持たず、Bearer を検証しない。
 *   毎リクエストの `Authorization: Bearer <token>` を、JSON-RPC をディスパッチする前に
 *   (本文も読まずに)次の順で確かめる:
 *   1. 欠落・形式不正 → 401(Gateway にも問い合わせない)
 *   2. preflight: そのトークンで Gateway の tools/list を呼ぶ(リクエストごとに作り捨てる
 *      Gateway クライアント)。Gateway が unauthenticated → 401、到達不能・5xx(IdP 不達の
 *      503 を含む)・タイムアウト → 503(gateway_unavailable)、それ以外 → 500(internal_error)。
 *      initialize → notifications/initialized → tools/list の全体を1つの期限
 *      (preflightTimeoutMs、既定 10 秒)で打ち切る(セキュリティレビュー m1。SDK は
 *      notifications/initialized の送信に期限を持たないため、期限が来たら接続ごと閉じる)
 *   3. 通ったときだけ本文を読み(下記)、initialize / tools/list / tools/call をディスパッチする
 *   preflight の結果はキャッシュしない(失効・無効化に即応する。ループバックで数 ms)。
 *   拒否時は正規化エラー(HTTP ステータスと data.errorClass)と固定文言だけを返し、
 *   トークン・Gateway 由来の文言・生の例外メッセージを含めない。拒否したリクエストでは
 *   LLM もソースも呼ばれない
 * - 本文(セキュリティレビュー S2):preflight の後に上限付き(maxBodyBytes、既定 64 KiB)で
 *   読む。超過は 413(payload_too_large。宣言された Content-Length で超過が分かれば読まずに
 *   返す)で、残りを受け取らないよう接続を閉じる(connection: close)。JSON として解釈し、
 *   配列(JSON-RPC のバッチ)は 400(invalid_request)で断る。1回の POST で ask / feedback を
 *   多数並べて Gateway・LLM への呼び出しを増幅させないため(SDK は 100 件までのバッチを
 *   受ける)。解釈できない本文・オブジェクト以外も 400。オブジェクトだけを SDK に渡す
 *   (handleRequest の parsedBody。SDK は本文を読み直さない)
 * - Gateway が公開するソースと --config の照合(S6): preflight の tools/list の search の
 *   ソース enum を checkGatewaySources(tools.ts)に渡し、食い違えばそのリクエストの ask /
 *   feedback を config_mismatch にする(許す設定のときは retentionClass を non_persistable に)
 * - ステートレス: リクエストごとに Server + Transport を作り(利用者のトークンはその
 *   サーバーにだけ閉じ込める)、応答後に閉じる。応答は単発 JSON(enableJsonResponse)
 * - GET / DELETE(POST 以外の全メソッド)は 405(Allow: POST)。サーバー発のメッセージを
 *   送らず、終了すべきセッションもない(Gateway と同じ理由)。認証より前に返す
 * - `GET /healthz`: 認証不要の死活確認。`{"status":"ok"}` のみ(Gateway・利用者の情報を
 *   出さない。Gateway への疎通も見ない)
 * - 既知の限界: クライアントが接続を切っても進行中の run は止めない(run の時間上限で
 *   終わる)。本文の受信の期限(遅い送信)は Node の requestTimeout(既定 300 秒)に任せる。
 *   TLS・Host / Origin の検証・利用者単位の流量制御はリバースプロキシで担う(決定7)
 */
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { GATEWAY_REJECTION_ERROR_CODE } from "@leisen/gateway";
import { GatewayClientError } from "../errors.js";
import type { GatewayClient } from "../gateway/types.js";
import { sourcesFromTools } from "../tools.js";
import { untilAborted, type ServerLimits } from "./limits.js";
import {
  createOrchestratorMcpServer,
  defaultGatewayClientFactory,
  type GatewayClientFactory,
} from "./mcp.js";
import {
  checkGatewaySources,
  type GatewaySourceCheck,
  type GatewaySourcePolicy,
  type OrchestratorPort,
  type RetentionClass,
} from "./tools.js";

/** MCP エンドポイントの既定のパス(Gateway と同じ)。 */
export const DEFAULT_ORCHESTRATOR_HTTP_PATH = "/mcp";
/** 認証不要の死活確認のパス。 */
export const ORCHESTRATOR_HEALTH_PATH = "/healthz";
/** preflight(Gateway への initialize → notifications/initialized → tools/list の全体)の既定の期限。 */
export const PREFLIGHT_TIMEOUT_MS = 10_000;
/**
 * POST 本文の既定の上限(バイト)。既定の質問長(4,000 文字)の ask なら、非 ASCII を
 * \uXXXX でエスケープして送っても収まる。
 */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export interface OrchestratorHttpDeps {
  readonly orchestrator: OrchestratorPort;
  /** Gateway の MCP エンドポイント(ループバック以外は https。McpGatewayClient の規則) */
  readonly gatewayUrl: string;
  /**
   * Orchestrator の資格情報(Gateway と共有する秘密。ADR-019 決定3)。ask / feedback の Gateway
   * クライアントに付ける(preflight の tools/list には付けない)。省略時は run API が拒否される
   */
  readonly orchestratorCredential?: string;
  /** 同時実行・質問長の上限(プロセスで1つ) */
  readonly limits: ServerLimits;
  /** 既定 persistable(ADR-018 決定5) */
  readonly retentionClass?: RetentionClass;
  /**
   * Gateway が公開するソースと --config の照合(S6)。省略時は照合しない(ライブラリとして
   * 組む場合。leisen-ask serve は常に渡す)
   */
  readonly sourcePolicy?: GatewaySourcePolicy;
  /** Gateway への接続を作る(既定 McpGatewayClient) */
  readonly createGatewayClient?: GatewayClientFactory;
  /** feedback の申告の期限(ms、既定 FEEDBACK_TIMEOUT_MS) */
  readonly feedbackTimeoutMs?: number;
}

export interface OrchestratorHttpServerOptions {
  /** MCP エンドポイントのパス。既定 "/mcp" */
  readonly path?: string;
  /** POST 本文の上限(バイト)。既定 64 KiB(DEFAULT_MAX_BODY_BYTES)。超過は 413 */
  readonly maxBodyBytes?: number;
  /** preflight 全体の期限(ms)。既定 10 秒(PREFLIGHT_TIMEOUT_MS)。超過は 503 */
  readonly preflightTimeoutMs?: number;
}

/** HTTP 層で拒否する分類(Gateway と同じ JSON の形で返す)。 */
type RejectionClass =
  | "unauthenticated"
  | "gateway_unavailable"
  | "internal_error"
  | "invalid_request"
  | "not_found"
  | "payload_too_large";

/** HTTP 層の拒否(分類と固定文言。例外や Gateway 由来のメッセージ・入力値はエコーしない)。 */
interface Rejection {
  readonly errorClass: RejectionClass;
  readonly message: string;
}

const REJECTIONS = {
  unauthenticated: {
    errorClass: "unauthenticated",
    message: "a valid bearer session token is required",
  },
  gatewayUnavailable: { errorClass: "gateway_unavailable", message: "the gateway is unavailable" },
  internalError: { errorClass: "internal_error", message: "internal error" },
  methodNotAllowed: { errorClass: "invalid_request", message: "method not allowed" },
  notFound: { errorClass: "not_found", message: "not found" },
  payloadTooLarge: {
    errorClass: "payload_too_large",
    message: "the request body is too large",
  },
  batchNotAccepted: {
    errorClass: "invalid_request",
    message: "JSON-RPC batch requests are not accepted; send one message per request",
  },
  invalidBody: {
    errorClass: "invalid_request",
    message: "the request body must be a single JSON-RPC message (a JSON object)",
  },
} as const satisfies Readonly<Record<string, Rejection>>;

type Preflight =
  | {
      readonly ok: true;
      /** Gateway の tools/list の search のソース enum(sourcesFromTools) */
      readonly gatewaySourceIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly rejection: Rejection;
      readonly headers: Readonly<Record<string, string>>;
    };

/**
 * `Authorization: Bearer <token>`(RFC 6750 §2.1)からトークンを取り出す(Gateway と同じ規則)。
 * スキーム名は大文字小文字を区別しない。形式不正は undefined(=未提示扱い)。
 */
function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  return /^Bearer +(\S+) *$/i.exec(header)?.[1];
}

/** 資格情報の提示なし: RFC 6750 §3.1 によりエラー詳細を付けない。 */
const MISSING_TOKEN_HEADERS: Readonly<Record<string, string>> = {
  "www-authenticate": "Bearer",
};
const INVALID_TOKEN: Preflight = {
  ok: false,
  status: 401,
  rejection: REJECTIONS.unauthenticated,
  headers: { "www-authenticate": 'Bearer error="invalid_token"' },
};
const GATEWAY_UNAVAILABLE: Preflight = {
  ok: false,
  status: 503,
  rejection: REJECTIONS.gatewayUnavailable,
  headers: {},
};
const PREFLIGHT_FAILED: Preflight = {
  ok: false,
  status: 500,
  rejection: REJECTIONS.internalError,
  headers: {},
};

/** Gateway クライアントの失敗を HTTP の拒否に写す。 */
function preflightRejection(error: unknown): Preflight {
  if (!(error instanceof GatewayClientError)) {
    return PREFLIGHT_FAILED;
  }
  switch (error.errorClass) {
    case "unauthenticated":
      return INVALID_TOKEN;
    case "gateway_unavailable":
    case "gateway_timeout":
      return GATEWAY_UNAVAILABLE;
    default:
      return PREFLIGHT_FAILED;
  }
}

/**
 * preflight(SDK 非依存): 利用者のトークンで Gateway の tools/list を呼び、Gateway の判断で
 * 有効性を確かめる(ADR-018 決定2)。クライアントはリクエストごとに作り捨てる。接続
 * (initialize → notifications/initialized)を含む全体を timeoutMs で打ち切り、期限切れは
 * 503(m1)。通れば Gateway の公開するソース(S6 の照合に使う)を返す。
 */
async function preflight(
  deps: OrchestratorHttpDeps,
  token: string,
  timeoutMs: number,
): Promise<Preflight> {
  const factory = deps.createGatewayClient ?? defaultGatewayClientFactory;
  const signal = AbortSignal.timeout(timeoutMs);
  let client: GatewayClient;
  try {
    client = factory({
      url: deps.gatewayUrl,
      sessionToken: token,
      requestTimeoutMs: timeoutMs,
    });
  } catch (error) {
    return preflightRejection(error);
  }
  try {
    const tools = await untilAborted(client.listTools({ signal }), signal);
    return { ok: true, gatewaySourceIds: sourcesFromTools(tools) };
  } catch (error) {
    return signal.aborted ? GATEWAY_UNAVAILABLE : preflightRejection(error);
  } finally {
    // 期限切れでも接続を閉じる(進行中の Gateway への HTTP 要求を中断する)
    await client.close().catch(() => undefined);
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

/** JSON-RPC エラー応答(id なし)の形で正規化エラーを返す(Gateway の拒否と同じ形)。 */
function sendRejection(
  res: ServerResponse,
  status: number,
  rejection: Rejection,
  headers: Readonly<Record<string, string>> = {},
): void {
  sendJson(
    res,
    status,
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: GATEWAY_REJECTION_ERROR_CODE,
        message: rejection.message,
        data: { errorClass: rejection.errorClass },
      },
    },
    headers,
  );
}

type RequestBody =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "too_large" }
  /** 受信の途中で切断・失敗した(応答する相手がいない) */
  | { readonly kind: "failed" };

/**
 * POST 本文を上限付きで読む(S2)。宣言された Content-Length が上限を超えていれば読まずに
 * too_large、chunked 等で受信中に上限を超えたらその時点で too_large(以降は保持しない)。
 */
function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<RequestBody> {
  if (req.destroyed) {
    // preflight の間に切断された(以降のイベントは来ない)
    return Promise.resolve({ kind: "failed" });
  }
  const declared = req.headers["content-length"];
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    return Promise.resolve({ kind: "too_large" });
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (result: RequestBody) => {
      if (settled) {
        return;
      }
      settled = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onFailed);
      req.off("close", onFailed);
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        chunks.length = 0;
        settle({ kind: "too_large" });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      settle({ kind: "ok", text: Buffer.concat(chunks, size).toString("utf8") });
    };
    const onFailed = () => {
      settle({ kind: "failed" });
    };
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onFailed);
    req.once("close", onFailed);
  });
}

type ParsedBody =
  | { readonly kind: "message"; readonly message: Record<string, unknown> }
  | { readonly kind: "batch" }
  | { readonly kind: "invalid" };

/** 本文を1つの JSON-RPC メッセージ(JSON のオブジェクト)として解釈する。配列はバッチ。 */
function parseSingleMessage(text: string): ParsedBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid" };
  }
  if (Array.isArray(parsed)) {
    return { kind: "batch" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "invalid" };
  }
  return { kind: "message", message: parsed as Record<string, unknown> };
}

/**
 * SDK 依存部(トランスポート生成と handleRequest)。preflight を通った1リクエストを
 * リクエスト単位の Server + Transport で処理し、応答後に閉じる。本文は読み済みのものを
 * parsedBody として渡す(SDK は本文を読み直さない)。
 */
async function serveMcpRequest(
  deps: OrchestratorHttpDeps,
  token: string,
  sources: GatewaySourceCheck,
  message: Record<string, unknown>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const server = createOrchestratorMcpServer({
    orchestrator: deps.orchestrator,
    gatewayUrl: deps.gatewayUrl,
    sessionToken: token,
    ...(deps.orchestratorCredential !== undefined
      ? { orchestratorCredential: deps.orchestratorCredential }
      : {}),
    limits: deps.limits,
    retentionClass: sources.retentionClass,
    configMismatch: sources.configMismatch,
    ...(deps.createGatewayClient !== undefined
      ? { createGatewayClient: deps.createGatewayClient }
      : {}),
    ...(deps.feedbackTimeoutMs !== undefined ? { feedbackTimeoutMs: deps.feedbackTimeoutMs } : {}),
  });
  // sessionIdGenerator を渡さない=ステートレスモード(Mcp-Session-Id を発行・検証しない)
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  try {
    // SDK の型宣言が exactOptionalPropertyTypes に非対応のため型だけ合わせる
    // (Gateway の proxy/http.ts と同じ理由。実体は Transport IF を実装している)
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res, message);
  } finally {
    await server.close().catch(() => undefined);
  }
}

/** クエリ文字列を除いたパス(完全一致でルーティングする)。 */
function requestPath(url: string | undefined): string {
  const raw = url ?? "/";
  const query = raw.indexOf("?");
  return query === -1 ? raw : raw.slice(0, query);
}

interface RouteOptions {
  readonly mcpPath: string;
  readonly maxBodyBytes: number;
  readonly preflightTimeoutMs: number;
}

async function routeMcp(
  deps: OrchestratorHttpDeps,
  options: RouteOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "POST") {
    sendRejection(res, 405, REJECTIONS.methodNotAllowed, { allow: "POST" });
    return;
  }
  const token = bearerToken(req.headers.authorization);
  if (token === undefined) {
    // 資格情報の提示なし: Gateway にも問い合わせず、本文も読まない
    sendRejection(res, 401, REJECTIONS.unauthenticated, MISSING_TOKEN_HEADERS);
    return;
  }
  const checked = await preflight(deps, token, options.preflightTimeoutMs);
  if (!checked.ok) {
    sendRejection(res, checked.status, checked.rejection, checked.headers);
    return;
  }
  const body = await readRequestBody(req, options.maxBodyBytes);
  if (body.kind === "failed") {
    res.destroy();
    return;
  }
  if (body.kind === "too_large") {
    // 残りは読み捨て、応答後に接続を閉じる(上限を超えて送り続ける相手から受け取り続けない)
    req.resume();
    sendRejection(res, 413, REJECTIONS.payloadTooLarge, { connection: "close" });
    return;
  }
  const parsed = parseSingleMessage(body.text);
  if (parsed.kind !== "message") {
    sendRejection(
      res,
      400,
      parsed.kind === "batch" ? REJECTIONS.batchNotAccepted : REJECTIONS.invalidBody,
    );
    return;
  }
  const sources = checkGatewaySources(
    deps.sourcePolicy,
    checked.gatewaySourceIds,
    deps.retentionClass ?? "persistable",
  );
  // 認証済みの応答(回答・出典)を中間キャッシュに乗せない
  res.setHeader("cache-control", "no-store");
  await serveMcpRequest(deps, token, sources, parsed.message, req, res);
}

async function route(
  deps: OrchestratorHttpDeps,
  options: RouteOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const path = requestPath(req.url);
  if (path === options.mcpPath) {
    await routeMcp(deps, options, req, res);
    return;
  }
  if (path === ORCHESTRATOR_HEALTH_PATH) {
    if (req.method !== "GET") {
      sendRejection(res, 405, REJECTIONS.methodNotAllowed, { allow: "GET" });
      return;
    }
    sendJson(res, 200, { status: "ok" });
    return;
  }
  sendRejection(res, 404, REJECTIONS.notFound);
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

/** Orchestrator を公開する HTTP リクエストリスナー(既存の HTTP サーバーへ載せる場合用)。 */
export function createOrchestratorRequestListener(
  deps: OrchestratorHttpDeps,
  options: OrchestratorHttpServerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const routeOptions: RouteOptions = {
    mcpPath: options.path ?? DEFAULT_ORCHESTRATOR_HTTP_PATH,
    maxBodyBytes: positiveInteger("maxBodyBytes", options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES),
    preflightTimeoutMs: positiveInteger(
      "preflightTimeoutMs",
      options.preflightTimeoutMs ?? PREFLIGHT_TIMEOUT_MS,
    ),
  };
  if (deps.feedbackTimeoutMs !== undefined) {
    positiveInteger("feedbackTimeoutMs", deps.feedbackTimeoutMs);
  }
  return (req, res) => {
    route(deps, routeOptions, req, res).catch(() => {
      // 想定外の失敗。生の例外メッセージは返さない
      if (!res.headersSent) {
        sendRejection(res, 500, REJECTIONS.internalError);
      } else {
        res.destroy();
      }
    });
  };
}

/**
 * Orchestrator を公開する http.Server を作る(listen は呼び出し側が行う。leisen-ask serve)。
 */
export function createOrchestratorHttpServer(
  deps: OrchestratorHttpDeps,
  options: OrchestratorHttpServerOptions = {},
): HttpServer {
  return createServer(createOrchestratorRequestListener(deps, options));
}
