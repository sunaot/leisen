/**
 * Orchestrator の MCP サーバーの Streamable HTTP トランスポート(T-021、ADR-018 決定1・2・7)。
 *
 * Gateway の proxy/http.ts と同じ構造: Node 標準の node:http に SDK の
 * StreamableHTTPServerTransport を載せる(新規の外部依存を足さない)。SDK に触れるのは
 * serveMcpRequest()(トランスポート生成と handleRequest)だけで、認証の前段・ルーティング・
 * 拒否応答は SDK 非依存の関数に分けてある。
 *
 * - 認証は Gateway に委譲する(決定2): Orchestrator は IdP を持たず、Bearer を検証しない。
 *   毎リクエストの `Authorization: Bearer <token>` を、JSON-RPC をディスパッチする前に
 *   (本文も読まずに)次の順で確かめる:
 *   1. 欠落・形式不正 → 401(Gateway にも問い合わせない)
 *   2. preflight: そのトークンで Gateway の tools/list を呼ぶ(リクエストごとに作り捨てる
 *      Gateway クライアント)。Gateway が unauthenticated → 401、到達不能・5xx(IdP 不達の
 *      503 を含む)・タイムアウト → 503(gateway_unavailable)、それ以外 → 500(internal_error)
 *   3. 通ったときだけ initialize / tools/list / tools/call をディスパッチする
 *   preflight の結果はキャッシュしない(失効・無効化に即応する。ループバックで数 ms)。
 *   拒否時は正規化エラー(HTTP ステータスと data.errorClass)と固定文言だけを返し、
 *   トークン・Gateway 由来の文言・生の例外メッセージを含めない。拒否したリクエストでは
 *   LLM もソースも呼ばれない
 * - ステートレス: リクエストごとに Server + Transport を作り(利用者のトークンはその
 *   サーバーにだけ閉じ込める)、応答後に閉じる。応答は単発 JSON(enableJsonResponse)
 * - GET / DELETE(POST 以外の全メソッド)は 405(Allow: POST)。サーバー発のメッセージを
 *   送らず、終了すべきセッションもない(Gateway と同じ理由)。認証より前に返す
 * - `GET /healthz`: 認証不要の死活確認。`{"status":"ok"}` のみ(Gateway・利用者の情報を
 *   出さない。Gateway への疎通も見ない)
 * - 既知の限界(Gateway と同じ): 同一 POST に取り消し通知を含むバッチでは handleRequest が
 *   完了せず接続が保持される(T-003 minor-6)。クライアントが接続を切っても進行中の run は
 *   止めない(run の時間上限で終わる)。TLS・Host / Origin の検証・利用者単位の流量制御は
 *   リバースプロキシで担う(決定7)
 */
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { GATEWAY_REJECTION_ERROR_CODE } from "@kp/gateway";
import { GatewayClientError } from "../errors.js";
import type { GatewayClient } from "../gateway/types.js";
import type { ServerLimits } from "./limits.js";
import {
  createOrchestratorMcpServer,
  defaultGatewayClientFactory,
  type GatewayClientFactory,
} from "./mcp.js";
import type { OrchestratorPort, RetentionClass } from "./tools.js";

/** MCP エンドポイントの既定のパス(Gateway と同じ)。 */
export const DEFAULT_ORCHESTRATOR_HTTP_PATH = "/mcp";
/** 認証不要の死活確認のパス。 */
export const ORCHESTRATOR_HEALTH_PATH = "/healthz";
/** preflight(Gateway の tools/list)1リクエストのタイムアウト。 */
export const PREFLIGHT_TIMEOUT_MS = 10_000;

export interface OrchestratorHttpDeps {
  readonly orchestrator: OrchestratorPort;
  /** Gateway の MCP エンドポイント(ループバック以外は https。McpGatewayClient の規則) */
  readonly gatewayUrl: string;
  /** 同時実行・質問長の上限(プロセスで1つ) */
  readonly limits: ServerLimits;
  /** 既定 persistable(ADR-018 決定5) */
  readonly retentionClass?: RetentionClass;
  /** Gateway への接続を作る(既定 McpGatewayClient) */
  readonly createGatewayClient?: GatewayClientFactory;
  /** feedback の本人確認で Gateway に申告する runId の採番(テスト用) */
  readonly newVerificationRunId?: () => string;
}

export interface OrchestratorHttpServerOptions {
  /** MCP エンドポイントのパス。既定 "/mcp" */
  readonly path?: string;
}

/** HTTP 層で拒否する分類(Gateway と同じ JSON の形で返す)。 */
type RejectionClass =
  | "unauthenticated"
  | "gateway_unavailable"
  | "internal_error"
  | "invalid_request"
  | "not_found";

/** HTTP 層の拒否で返す固定文言。例外や Gateway 由来のメッセージはエコーしない。 */
const REJECTION_MESSAGES: Readonly<Record<RejectionClass, string>> = {
  unauthenticated: "a valid bearer session token is required",
  gateway_unavailable: "the gateway is unavailable",
  internal_error: "internal error",
  invalid_request: "method not allowed",
  not_found: "not found",
};

type Preflight =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: number;
      readonly errorClass: RejectionClass;
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
  errorClass: "unauthenticated",
  headers: { "www-authenticate": 'Bearer error="invalid_token"' },
};
const GATEWAY_UNAVAILABLE: Preflight = {
  ok: false,
  status: 503,
  errorClass: "gateway_unavailable",
  headers: {},
};
const PREFLIGHT_FAILED: Preflight = {
  ok: false,
  status: 500,
  errorClass: "internal_error",
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
 * 有効性を確かめる(ADR-018 決定2)。クライアントはリクエストごとに作り捨てる。
 */
async function preflight(
  deps: OrchestratorHttpDeps,
  token: string,
): Promise<Preflight> {
  const factory = deps.createGatewayClient ?? defaultGatewayClientFactory;
  let client: GatewayClient;
  try {
    client = factory({
      url: deps.gatewayUrl,
      sessionToken: token,
      requestTimeoutMs: PREFLIGHT_TIMEOUT_MS,
    });
  } catch (error) {
    return preflightRejection(error);
  }
  try {
    await client.listTools();
    return { ok: true };
  } catch (error) {
    return preflightRejection(error);
  } finally {
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
  errorClass: RejectionClass,
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
        message: REJECTION_MESSAGES[errorClass],
        data: { errorClass },
      },
    },
    headers,
  );
}

/**
 * SDK 依存部(トランスポート生成と handleRequest)。preflight を通った1リクエストを
 * リクエスト単位の Server + Transport で処理し、応答後に閉じる。
 */
async function serveMcpRequest(
  deps: OrchestratorHttpDeps,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const server = createOrchestratorMcpServer({
    orchestrator: deps.orchestrator,
    gatewayUrl: deps.gatewayUrl,
    sessionToken: token,
    limits: deps.limits,
    ...(deps.retentionClass !== undefined ? { retentionClass: deps.retentionClass } : {}),
    ...(deps.createGatewayClient !== undefined
      ? { createGatewayClient: deps.createGatewayClient }
      : {}),
    ...(deps.newVerificationRunId !== undefined
      ? { newVerificationRunId: deps.newVerificationRunId }
      : {}),
  });
  // sessionIdGenerator を渡さない=ステートレスモード(Mcp-Session-Id を発行・検証しない)
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  try {
    // SDK の型宣言が exactOptionalPropertyTypes に非対応のため型だけ合わせる
    // (Gateway の proxy/http.ts と同じ理由。実体は Transport IF を実装している)
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res);
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

async function route(
  deps: OrchestratorHttpDeps,
  mcpPath: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const path = requestPath(req.url);
  if (path === mcpPath) {
    if (req.method !== "POST") {
      sendRejection(res, 405, "invalid_request", { allow: "POST" });
      return;
    }
    const token = bearerToken(req.headers.authorization);
    if (token === undefined) {
      // 資格情報の提示なし: Gateway にも問い合わせない
      sendRejection(res, 401, "unauthenticated", MISSING_TOKEN_HEADERS);
      return;
    }
    const checked = await preflight(deps, token);
    if (!checked.ok) {
      sendRejection(res, checked.status, checked.errorClass, checked.headers);
      return;
    }
    // 認証済みの応答(回答・出典)を中間キャッシュに乗せない
    res.setHeader("cache-control", "no-store");
    await serveMcpRequest(deps, token, req, res);
    return;
  }
  if (path === ORCHESTRATOR_HEALTH_PATH) {
    if (req.method !== "GET") {
      sendRejection(res, 405, "invalid_request", { allow: "GET" });
      return;
    }
    sendJson(res, 200, { status: "ok" });
    return;
  }
  sendRejection(res, 404, "not_found");
}

/** Orchestrator を公開する HTTP リクエストリスナー(既存の HTTP サーバーへ載せる場合用)。 */
export function createOrchestratorRequestListener(
  deps: OrchestratorHttpDeps,
  options: OrchestratorHttpServerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const mcpPath = options.path ?? DEFAULT_ORCHESTRATOR_HTTP_PATH;
  return (req, res) => {
    route(deps, mcpPath, req, res).catch(() => {
      // 想定外の失敗。生の例外メッセージは返さない
      if (!res.headersSent) {
        sendRejection(res, 500, "internal_error");
      } else {
        res.destroy();
      }
    });
  };
}

/**
 * Orchestrator を公開する http.Server を作る(listen は呼び出し側が行う。kp-ask serve)。
 */
export function createOrchestratorHttpServer(
  deps: OrchestratorHttpDeps,
  options: OrchestratorHttpServerOptions = {},
): HttpServer {
  return createServer(createOrchestratorRequestListener(deps, options));
}
