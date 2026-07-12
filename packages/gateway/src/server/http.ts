/**
 * GatewayのHTTP面(T-012)。
 *
 * MCP Streamable HTTPトランスポートでGatewayのMCPサーバー面(proxy/mcp.ts)を
 * 公開する。セッション束縛はmcp.tsの設計どおり「トランスポート層で
 * Authorizationヘッダのセッショントークンを受け、establishSession() を通して
 * からMCPサーバーを接続する」を実装する(1 MCPセッション=1 GatewaySession)。
 *
 * - 初期化リクエスト(mcp-session-idヘッダなしのPOST)でBearerトークンを検証し、
 *   確立したGatewaySessionに束縛したMCPサーバー+トランスポートを作る
 * - 以降のリクエストは mcp-session-id でトランスポートへルーティングする
 *   (セッションIDの検証・404/400応答はSDKトランスポートが行う)
 * - /healthz は認証不要の死活確認。設定・ソース情報を返さない(TM-A2)
 *
 * エラー応答には正規化エラー(errorClass)のみを載せ、生の例外メッセージ・
 * トークン値を流さない(不変条件6、TM-A2)。
 *
 * SessionDeclaration(実行区分・actor申告)は現状既定値のみ
 * (human_in_the_loop / human)。Orchestrator(T-007)が申告を必要とした
 * 時点で、このHTTP面の受け口を拡張する(ADR-015)。
 */
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createGatewayMcpServer } from "../proxy/mcp.js";
import type { Gateway } from "../proxy/gateway.js";
import { GatewayError, type GatewayErrorClass } from "../proxy/types.js";

export interface GatewayHttpOptions {
  /** 待受アドレス。既定 127.0.0.1(コンテナ実行時は 0.0.0.0 を明示する) */
  host?: string;
  /** 待受ポート。0でエフェメラル(テスト用)。既定 3000 */
  port?: number;
  /** MCPエンドポイントのパス。既定 "/mcp" */
  mcpPath?: string;
  /** ヘルスチェックのパス。既定 "/healthz" */
  healthPath?: string;
}

export interface StartedGatewayHttpServer {
  server: HttpServer;
  /** 実際に待ち受けているポート(port: 0 指定時の解決値) */
  port: number;
  /** 全MCPセッションを閉じてHTTPサーバーを停止する */
  close(): Promise<void>;
}

const DEFAULT_PORT = 3000;

function errorStatus(errorClass: GatewayErrorClass): number {
  switch (errorClass) {
    case "unauthenticated":
      return 401;
    case "invalid_request":
      return 400;
    case "idp_unavailable":
      return 503;
    default:
      return 500;
  }
}

function sendError(res: ServerResponse, error: GatewayError): void {
  const status = errorStatus(error.errorClass);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (status === 401) {
    headers["www-authenticate"] = "Bearer";
  }
  res.writeHead(status, headers);
  res.end(
    JSON.stringify({
      error: { errorClass: error.errorClass, message: error.message },
    }),
  );
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1];
}

/** 初期化リクエストのボディ上限。超過は認証前に拒否する。 */
const MAX_INITIALIZE_BODY_BYTES = 1024 * 1024;

class BodyLimitError extends Error {}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new BodyLimitError("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startGatewayHttpServer(
  gateway: Gateway,
  options: GatewayHttpOptions = {},
): Promise<StartedGatewayHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_PORT;
  const mcpPath = options.mcpPath ?? "/mcp";
  const healthPath = options.healthPath ?? "/healthz";

  /** mcp-session-id → 接続済みトランスポート */
  const transports = new Map<string, StreamableHTTPServerTransport>();

  async function handleMcp(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId =
      typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;

    // 確立済みセッション: SDKトランスポートへルーティング(不明IDのヘッダ付き
    // リクエストもSDK側の検証に委ねると当該トランスポートに届かないため、
    // ここで404を返す)。
    // 注意(T-012セキュリティレビュー minor-2): MCP Streamable HTTPの設計上、
    // 確立後のリクエストは mcp-session-id がベアラ資格として機能する
    // (122bitランダムUUID)。session-idは秘匿対象。IdPトークンの失効は
    // セッション層では即時反映されないが、資格情報の取得はツール呼び出し
    // ごとに行われるため、失効の即時反映は IdpAdapter.invalidateUser
    // (TM-C4)が担う
    if (sessionId !== undefined) {
      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              errorClass: "invalid_request",
              message: "unknown or expired mcp session",
            },
          }),
        );
        return;
      }
      await transport.handleRequest(req, res);
      return;
    }

    // 新規セッション(初期化リクエスト)。トークン検証が先(認証なしに
    // MCPサーバー実体を作らない)
    if (req.method !== "POST") {
      sendError(
        res,
        new GatewayError(
          "invalid_request",
          "an mcp session is required (initialize with POST first)",
        ),
      );
      return;
    }
    const token = bearerToken(req);
    if (token === undefined) {
      sendError(
        res,
        new GatewayError(
          "unauthenticated",
          "missing bearer token (Authorization header)",
        ),
      );
      return;
    }

    // initializeでないリクエストはIdP認証(establishSession)前に拒否する。
    // トークン付き非initialize連投によるIdP呼び出しの増幅を防ぐ
    // (T-012セキュリティレビュー minor-1)
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(await readBody(req, MAX_INITIALIZE_BODY_BYTES));
    } catch (error) {
      const message =
        error instanceof BodyLimitError
          ? "request body too large"
          : "request body must be JSON";
      sendError(res, new GatewayError("invalid_request", message));
      return;
    }
    const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
    if (!messages.some(isInitializeRequest)) {
      sendError(
        res,
        new GatewayError(
          "invalid_request",
          "a request without mcp-session-id must be an initialize request",
        ),
      );
      return;
    }

    let session;
    try {
      session = await gateway.establishSession(token);
    } catch (error) {
      sendError(
        res,
        error instanceof GatewayError
          ? error
          : new GatewayError("internal_error", "session establishment failed"),
      );
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sid) => {
        transports.set(sid, transport);
      },
    });
    const server = createGatewayMcpServer(gateway, session);
    // mcp.tsが設定したonclose(GatewaySession破棄)にルーティング表の掃除を重ねる
    const discardSession = server.onclose;
    server.onclose = () => {
      if (transport.sessionId !== undefined) {
        transports.delete(transport.sessionId);
      }
      discardSession?.();
    };
    // SDKのアクセサ型(`(() => void) | undefined`)がexactOptionalPropertyTypes
    // 下でTransportのオプショナルプロパティに適合しないための型調整(実行時
    // 挙動には影響しない)
    await server.connect(transport as Transport);
    // ボディは上でinitialize判定のために消費済みなので、パース結果を渡す
    await transport.handleRequest(req, res, parsedBody);

    // 初期化が成立しなかった(SDKが4xxを返済み)場合は接続を残さない
    if (transport.sessionId === undefined) {
      await transport.close();
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "gateway"}`);
    if (req.method === "GET" && url.pathname === healthPath) {
      // 認証不要の死活確認。デプロイ情報・ソース情報を返さない(TM-A2)
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (url.pathname === mcpPath) {
      handleMcp(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                errorClass: "internal_error",
                // 生の例外メッセージを流さない(TM-A2)
                message: "unexpected error handling mcp request",
              },
            }),
          );
        } else {
          res.end();
        }
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: { errorClass: "invalid_request", message: "unknown path" },
      }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const boundPort =
    address !== null && typeof address === "object" ? address.port : port;

  return {
    server,
    port: boundPort,
    close: async () => {
      // トランスポートcloseがserver.onclose経由でGatewaySessionを破棄する
      await Promise.all(
        [...transports.values()].map((transport) =>
          transport.close().catch(() => {}),
        ),
      );
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
