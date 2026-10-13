/**
 * GatewayのStreamable HTTPトランスポート(T-003、ADR-001 追補3)。
 *
 * Node標準の node:http に SDK の StreamableHTTPServerTransport を載せる
 * (SDKのexpressヘルパー等は使わず、新規の外部依存を追加しない)。
 * SDKに触れるのは serveMcpRequest()(トランスポート生成と handleRequest)だけで、
 * 認証・ルーティング・拒否応答はSDK非依存の関数に分けてある(SDKを v2系へ
 * 差し替えるときの手戻りを serveMcpRequest と mcp.ts に限定する)。
 *
 * - リクエスト単位認証(決定1): 毎リクエストの `Authorization: Bearer
 *   <セッショントークン>` を Gateway.authenticate(IdpAdapter.authenticate)で
 *   検証し、JSON-RPCをディスパッチする前に(ボディも読まずに)拒否する。
 *   initialize / tools/list を含む全MCPリクエストで認証を要求する(未認証には
 *   ツールスキーマも返さない)。拒否時は正規化エラー(HTTPステータスと
 *   data.errorClass)のみを返し、トークン値・IdP由来の文言・生の例外メッセージを
 *   含めない(unauthenticated → 401、idp_unavailable → 503、それ以外 → 500)
 * - ステートレス(決定2): 接続・サーバーインスタンスにユーザー状態を持たせない。
 *   SDK 1.x の Server は1トランスポートにしか接続できず、ステートレスモードの
 *   トランスポートはリクエスト間で再利用できないため、リクエストごとに
 *   Server+Transport を組み立て、応答後に閉じる。検証済み Identity は SDK の
 *   AuthInfo(req.auth → ハンドラの extra.authInfo)で渡す
 * - 応答はSSEでなく単発JSON(enableJsonResponse)。ツールのみを公開し、
 *   サーバー発の通知・リクエストを使わない(追補3 決定7)ためストリームは不要。
 *   通常は handleRequest の完了=応答の送出完了で、その後にリクエスト単位の部品を
 *   閉じる。ただし同一 POST に取り消し通知を含むバッチ(例: `[tools/call id=7,
 *   notifications/cancelled requestId=7]`)では handleRequest が完了せず、接続と
 *   リクエスト単位の部品が保持される(minor-6、未対応。公開前の必須条件として
 *   T-012 に記載)
 * - GET / DELETE(およびPOST以外の全メソッド)は 405(Allow: POST)。GETの
 *   スタンドアロンSSEストリームはサーバー発メッセージの受け口だが本Gatewayは
 *   送るものがなく、開いたままの接続とリクエスト単位の部品を無駄に抱えるだけに
 *   なる(仕様上 405 で「SSEストリームを提供しない」と示してよく、SDKクライアントも
 *   405 を正常系として扱う。2026-07-28版ではGETは subscriptions/listen に置換)。
 *   DELETE はセッション終了用だが、ステートレスで終了すべきセッションがない
 *   (仕様上 405 可)。405 はユーザー・ソースの情報を含まないため認証より前に
 *   返し、IdPへの無駄な照会を発生させない
 * - `POST /runs`・`POST /runs/{runId}/finish`・`POST /runs/{runId}/feedback`: run API
 *   (ADR-019 決定3、runs.ts)。MCP とは別の JSON の面で、本人の Bearer を `/mcp` と同じ手順で
 *   検証し、Orchestrator の資格情報(ORCHESTRATOR_CREDENTIAL_HEADER)を求める。本文は
 *   gateway.runs.limits.maxBodyBytes まで。`/mcp` の tools/call にも同じヘッダの検証結果を
 *   AuthInfo で渡す(名前空間付きの runId の受理に要る)
 * - `GET /healthz`: 認証不要の死活確認。`{"status":"ok"}` のみを返し、ソース
 *   一覧・利用者情報を出さない
 * - 監査: HTTP層で拒否したリクエストはGatewayコアに到達しないため監査対象外
 *   (tools.ts runToolCall の「既知の限界」)。コアに入った呼び出しは従来どおり
 *   1呼び出し=1レコード・fail-closed(gateway.ts)
 * - SDKに委ねるもの: Accept / Content-Type の検証、未対応の mcp-protocol-version
 *   (400)、JSON-RPCの構文検証。保留(SDK対応待ち): 仕様2026-07-28版の
 *   Mcp-Method / Mcp-Name ヘッダ検証は現行SDKが未実装のため、HTTP層で独自に
 *   手実装しない(追補3 決定6)
 *
 * 待ち受け(listen)は呼び出し側が deployment.yaml の gateway.http.host / port で
 * 行う(起動コード: bootstrap/assemble.ts の assembleGateway と leisen-gateway serve)。
 */
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  DEFAULT_GATEWAY_HTTP_PATH,
  GATEWAY_HEALTH_PATH,
} from "../config/schema.js";
import type { Identity } from "../idp/types.js";
import { isValidRunId } from "../run/runid.js";
import { runApiPathFor } from "../run/path.js";
import type { Gateway } from "./gateway.js";
import { createGatewayMcpServer, gatewayAuthInfo } from "./mcp.js";
import { ORCHESTRATOR_CREDENTIAL_HEADER, type RunApiResponse } from "./runs.js";
import {
  GATEWAY_REJECTION_ERROR_CODE,
  GatewayError,
  type GatewayErrorClass,
} from "./types.js";

export interface GatewayHttpServerOptions {
  /** MCPエンドポイントのパス(deployment.yaml の gateway.http.path)。既定 "/mcp" */
  readonly path?: string;
}

/** HTTP層の拒否で返す固定文言。例外やIdP由来のメッセージはエコーしない。 */
const REJECTION_MESSAGES: Partial<Record<GatewayErrorClass, string>> = {
  unauthenticated: "a valid bearer session token is required",
  idp_unavailable: "identity provider is unavailable",
  misconfigured: "gateway is misconfigured",
  internal_error: "internal error",
  invalid_request: "invalid request",
  not_found: "not found",
  payload_too_large: "request body exceeds the configured limit",
};

/** run API(ADR-019)のパス。`/runs`、`/runs/{runId}/finish`、`/runs/{runId}/feedback` */
export const GATEWAY_RUNS_PATH = runApiPathFor(DEFAULT_GATEWAY_HTTP_PATH);

type RequestAuthentication =
  | { readonly ok: true; readonly identity: Identity }
  | {
      readonly ok: false;
      readonly status: number;
      readonly errorClass: GatewayErrorClass;
      readonly headers: Readonly<Record<string, string>>;
    };

/**
 * `Authorization: Bearer <token>`(RFC 6750 §2.1)からトークンを取り出す。
 * スキーム名は大文字小文字を区別しない。形式不正は undefined(=未提示扱い)。
 */
function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  return /^Bearer +(\S+) *$/i.exec(header)?.[1];
}

/**
 * リクエスト単位認証(SDK非依存、追補3 決定1)。形式不正はIdPへ照会せずに拒否し、
 * IdPの判定は正規化エラー → HTTPステータスへ写す。
 */
async function authenticateRequest(
  gateway: Gateway,
  authorization: string | undefined,
): Promise<RequestAuthentication> {
  const token = bearerToken(authorization);
  if (token === undefined) {
    // 資格情報の提示なし: RFC 6750 §3.1 によりエラー詳細を付けない
    return {
      ok: false,
      status: 401,
      errorClass: "unauthenticated",
      headers: { "www-authenticate": "Bearer" },
    };
  }
  try {
    return { ok: true, identity: await gateway.authenticate(token) };
  } catch (error) {
    // Gateway.authenticate は正規化済み(GatewayError)。それ以外は想定外
    const errorClass =
      error instanceof GatewayError ? error.errorClass : "internal_error";
    if (errorClass === "unauthenticated") {
      return {
        ok: false,
        status: 401,
        errorClass,
        headers: { "www-authenticate": 'Bearer error="invalid_token"' },
      };
    }
    return {
      ok: false,
      status: errorClass === "idp_unavailable" ? 503 : 500,
      errorClass,
      headers: {},
    };
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

/** JSON-RPCエラー応答(idなし)の形で正規化エラーを返す(MCP Streamable HTTPの慣行)。 */
function sendRejection(
  res: ServerResponse,
  status: number,
  errorClass: GatewayErrorClass,
  headers: Readonly<Record<string, string>> = {},
): void {
  const message =
    status === 405
      ? "method not allowed"
      : status === 415
        ? "unsupported media type"
        : (REJECTION_MESSAGES[errorClass] ?? "request rejected");
  sendJson(
    res,
    status,
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: GATEWAY_REJECTION_ERROR_CODE,
        message,
        data: { errorClass },
      },
    },
    headers,
  );
}

/**
 * SDK依存部(トランスポート生成と handleRequest)。認証済みの1リクエストを
 * リクエスト単位の Server + Transport で処理し、応答後に閉じる。
 */
async function serveMcpRequest(
  gateway: Gateway,
  identity: Identity,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const server = createGatewayMcpServer(gateway);
  // sessionIdGenerator を渡さない=ステートレスモード(Mcp-Session-Idを発行・
  // 検証しない)。exactOptionalPropertyTypes のため undefined を明示せず省略する
  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  try {
    // SDKの型宣言が exactOptionalPropertyTypes に非対応(onclose 等の getter が
    // `T | undefined` を返し、Transport IF の `onclose?: T` と一致しない)ため
    // 型だけ合わせる。実体は Transport IF を実装している
    await server.connect(transport as Transport);
    const authenticated: IncomingMessage & { auth?: AuthInfo } = req;
    // Orchestrator の資格情報(共有秘密)の検証結果を AuthInfo で渡す。名前空間付きのキーで
    // runId を申告する tools/call の受理に要る(ADR-019 決定3・4)
    authenticated.auth = gatewayAuthInfo(identity, {
      orchestratorVerified: gateway.verifyOrchestratorCredential(
        req.headers[ORCHESTRATOR_CREDENTIAL_HEADER],
      ),
    });
    await transport.handleRequest(authenticated, res);
  } finally {
    // JSON応答モードでは通常 handleRequest の完了=応答の送出完了。取り消し通知を
    // 含むバッチでは handleRequest が完了せずここに到達しない(minor-6、冒頭の注記)
    await server.close().catch(() => undefined);
  }
}

/** クエリ文字列を除いたパス(完全一致でルーティングする)。 */
function requestPath(url: string | undefined): string {
  const raw = url ?? "/";
  const query = raw.indexOf("?");
  return query === -1 ? raw : raw.slice(0, query);
}

/** run API のリクエスト本文を読む(上限超過は読み捨てて 413)。 */
type BodyRead =
  | { readonly ok: true; readonly json: unknown }
  | { readonly ok: false; readonly status: number; readonly errorClass: GatewayErrorClass };

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<BodyRead> {
  const contentType = req.headers["content-type"] ?? "";
  if (!/^application\/json\b/i.test(contentType)) {
    return { ok: false, status: 415, errorClass: "invalid_request" };
  }
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, status: 413, errorClass: "payload_too_large" };
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    received += buffer.byteLength;
    if (received > maxBytes) {
      return { ok: false, status: 413, errorClass: "payload_too_large" };
    }
    chunks.push(buffer);
  }
  try {
    return { ok: true, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch {
    return { ok: false, status: 400, errorClass: "invalid_request" };
  }
}

/**
 * run API(runsPath = runApiPathFor(MCP のパス))配下のパスを解釈する。runId は形(文字種・長さ)
 * だけを見る(検証は RunApi)。
 */
function parseRunsPath(
  path: string,
  runsPath: string,
): { readonly kind: "start" } | { readonly kind: "finish" | "feedback"; readonly runId: string } | undefined {
  if (path === runsPath) {
    return { kind: "start" };
  }
  const rest = path.startsWith(`${runsPath}/`) ? path.slice(runsPath.length + 1) : undefined;
  if (rest === undefined) {
    return undefined;
  }
  const segments = rest.split("/");
  if (segments.length !== 2) {
    return undefined;
  }
  const [runId, action] = segments as [string, string];
  if (!isValidRunId(runId) || (action !== "finish" && action !== "feedback")) {
    return undefined;
  }
  return { kind: action, runId };
}

/** run API の応答を書き出す(認証済み応答はキャッシュさせない)。 */
function sendRunApiResponse(res: ServerResponse, response: RunApiResponse): void {
  sendJson(res, response.status, response.body, response.headers ?? {});
}

/**
 * run API(ADR-019 決定3)。MCP とは別の HTTP + JSON の面。本人の Bearer を `/mcp` と同じ
 * 手順で検証し、Orchestrator の資格情報の有無は RunApi が判定する(資格情報なしは 403)。
 * 拒否の応答は `{ error: { errorClass, message } }` の固定文言で、申告値をエコーしない。
 */
async function serveRunsRequest(
  gateway: Gateway,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  runsPath: string,
): Promise<void> {
  const target = parseRunsPath(path, runsPath);
  const runs = gateway.runs;
  if (target === undefined || runs === undefined) {
    sendRejection(res, 404, "not_found");
    return;
  }
  if (req.method !== "POST") {
    sendRejection(res, 405, "invalid_request", { allow: "POST" });
    return;
  }
  const auth = await authenticateRequest(gateway, req.headers.authorization);
  if (!auth.ok) {
    sendRejection(res, auth.status, auth.errorClass, auth.headers);
    return;
  }
  const orchestratorVerified = runs.verifyOrchestratorCredential(
    req.headers[ORCHESTRATOR_CREDENTIAL_HEADER],
  );
  const body = await readJsonBody(req, runs.maxBodyBytes);
  if (!body.ok) {
    // 上限超過の本文は読み捨てて接続を閉じる(残りを受け続けない)
    sendRejection(res, body.status, body.errorClass, body.status === 413 ? { connection: "close" } : {});
    return;
  }
  switch (target.kind) {
    case "start":
      sendRunApiResponse(res, await runs.start(auth.identity, orchestratorVerified, body.json));
      return;
    case "finish":
      sendRunApiResponse(
        res,
        await runs.finish(auth.identity, orchestratorVerified, target.runId, body.json),
      );
      return;
    case "feedback":
      sendRunApiResponse(
        res,
        await runs.feedback(auth.identity, orchestratorVerified, target.runId, body.json),
      );
      return;
  }
}

async function route(
  gateway: Gateway,
  mcpPath: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const path = requestPath(req.url);
  // run API は MCP エンドポイントと同じディレクトリの runs(run/path.ts)。Orchestrator も同じ規則で導く
  const runsPath = runApiPathFor(mcpPath);
  if (path === runsPath || path.startsWith(`${runsPath}/`)) {
    await serveRunsRequest(gateway, req, res, path, runsPath);
    return;
  }
  if (path === mcpPath) {
    if (req.method !== "POST") {
      sendRejection(res, 405, "invalid_request", { allow: "POST" });
      return;
    }
    const auth = await authenticateRequest(gateway, req.headers.authorization);
    if (!auth.ok) {
      sendRejection(res, auth.status, auth.errorClass, auth.headers);
      return;
    }
    // 認証済み応答(検索結果等)を中間キャッシュに乗せない
    res.setHeader("cache-control", "no-store");
    await serveMcpRequest(gateway, auth.identity, req, res);
    return;
  }
  if (path === GATEWAY_HEALTH_PATH) {
    if (req.method !== "GET") {
      sendRejection(res, 405, "invalid_request", { allow: "GET" });
      return;
    }
    sendJson(res, 200, { status: "ok" });
    return;
  }
  sendRejection(res, 404, "not_found");
}

/**
 * Gatewayを公開するHTTPリクエストリスナー(既存のHTTPサーバーへ載せる場合用)。
 */
export function createGatewayRequestListener(
  gateway: Gateway,
  options: GatewayHttpServerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const mcpPath = options.path ?? DEFAULT_GATEWAY_HTTP_PATH;
  return (req, res) => {
    route(gateway, mcpPath, req, res).catch(() => {
      // 想定外の失敗。生の例外メッセージは返さない(TM-A2)
      if (!res.headersSent) {
        sendRejection(res, 500, "internal_error");
      } else {
        res.destroy();
      }
    });
  };
}

/**
 * Gatewayを公開する http.Server を作る(listen は呼び出し側が行う)。
 * 例: `createGatewayHttpServer(gateway, { path: config.gateway.http.path })
 *   .listen(config.gateway.http.port, config.gateway.http.host)`
 */
export function createGatewayHttpServer(
  gateway: Gateway,
  options: GatewayHttpServerOptions = {},
): HttpServer {
  return createServer(createGatewayRequestListener(gateway, options));
}
