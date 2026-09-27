/**
 * [スパイク] Gateway の Streamable HTTP 入口(T-003 HTTP配線)を SDK v2 で書いた試作。
 *
 * - createMcpHandler(factory) が 2026-07-28 版をリクエスト単位で処理し、既定の
 *   legacy: 'stateless' で 2025 年版(v1 系クライアントの initialize フロー)も
 *   同じエンドポイントで処理する(決定6: 後方互換は SDK に委ねる)
 * - 毎リクエストの Authorization: Bearer <セッショントークン> で本人を確定する(決定1)。
 *   失敗は MCP の処理に入る前に HTTP 401 で返す(トークン値・IdP の生エラーは返さない)
 * - 確立したセッションは authInfo.extra に載せ、SDK が ctx.http.authInfo として
 *   ハンドラへ素通しする。生のセッショントークンは入口より内側へ渡さない(不変条件6)
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  toNodeHandler,
  type NodeIncomingMessageLike,
} from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  type AuthInfo,
  type CreateMcpHandlerOptions,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import type { Gateway } from "../../../packages/gateway/src/proxy/gateway.js";
import type { GatewaySession } from "../../../packages/gateway/src/proxy/types.js";
import {
  GATEWAY_SESSION_EXTRA_KEY,
  createGatewayMcpServer,
  type GatewayMcpServerOptions,
} from "./gateway-mcp-v2.js";

export interface GatewayHttpOptions extends GatewayMcpServerOptions {
  readonly legacy?: CreateMcpHandlerOptions["legacy"];
}

export interface GatewayHttpEntry {
  readonly handler: McpHttpHandler;
  readonly listener: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

function bearerToken(header: string | undefined): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(header ?? "")?.[1];
}

function authInfoFor(session: GatewaySession): AuthInfo {
  return {
    token: session.sessionId,
    clientId: "kp-gateway",
    scopes: [],
    extra: { [GATEWAY_SESSION_EXTRA_KEY]: session },
  };
}

export function createGatewayHttpEntry(
  gateway: Gateway,
  options: GatewayHttpOptions,
): GatewayHttpEntry {
  const handler = createMcpHandler(
    () => createGatewayMcpServer(gateway, options),
    options.legacy !== undefined ? { legacy: options.legacy } : {},
  );
  const serve = toNodeHandler(handler);
  const listener = async (req: IncomingMessage, res: ServerResponse) => {
    let session: GatewaySession;
    try {
      const token = bearerToken(req.headers.authorization);
      if (token === undefined) throw new Error("missing bearer token");
      session = await gateway.establishSession(token);
    } catch {
      res
        .writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": 'Bearer error="invalid_token"',
        })
        .end(JSON.stringify({ error: "invalid_token" }));
      return;
    }
    try {
      // exactOptionalPropertyTypes: @types/node の IncomingMessage.method は
      // `string | undefined`、NodeIncomingMessageLike.method は `method?: string`
      // のため直接は渡せない(TS2379)。実行時の形は同一なので型だけ合わせる
      const nodeReq = Object.assign(req, { auth: authInfoFor(session) });
      await serve(nodeReq as NodeIncomingMessageLike, res);
    } finally {
      gateway.discardSession(session.sessionId);
    }
  };
  return { handler, listener };
}
