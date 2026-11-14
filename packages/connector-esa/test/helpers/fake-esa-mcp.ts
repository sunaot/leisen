/**
 * テスト用の esa リモート MCP サーバーのフェイク(公式 SDK のサーバーを 127.0.0.1 で動かす)。
 * - Authorization: Bearer <許可したトークン> 以外は 401(mcp.esa.io と同じ)
 * - 受けた要求の Authorization・ツール名・引数を記録する
 * - トークンは開発用のダミー値だけを使う(不変条件6)
 */
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export const GOOD_TOKEN = "dummy-esa-token-for-tests";

export interface ToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly authorization: string | undefined;
}

export type ToolHandler = (args: Record<string, unknown>) => { text: string; isError?: boolean } | Promise<{ text: string; isError?: boolean }>;

export interface FakeEsaMcp {
  readonly url: string;
  readonly calls: ToolCall[];
  readonly httpStatuses: number[];
  setTool(name: string, handler: ToolHandler): void;
  /** 次の要求に返す HTTP 状態(429 等)。undefined で通常に戻す */
  forceStatus(status: number | undefined): void;
  /** 応答を返さずに待たせる(期限の試験) */
  hang(enabled: boolean): void;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : (JSON.parse(text) as unknown);
}

export async function startFakeEsaMcp(): Promise<FakeEsaMcp> {
  const tools = new Map<string, ToolHandler>();
  const calls: ToolCall[] = [];
  const httpStatuses: number[] = [];
  let forced: number | undefined;
  let hanging = false;
  const http: HttpServer = createServer((req, res) => {
    void (async () => {
      if (hanging) {
        return; // 応答しない
      }
      if (forced !== undefined) {
        httpStatuses.push(forced);
        res.writeHead(forced, { "content-type": "text/plain" }).end("secret-looking body that must not be echoed");
        return;
      }
      const authorization = req.headers.authorization;
      if (authorization !== `Bearer ${GOOD_TOKEN}`) {
        httpStatuses.push(401);
        res
          .writeHead(401, { "www-authenticate": 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"' })
          .end("Missing or invalid Authorization header");
        return;
      }
      const body = req.method === "POST" ? await readBody(req) : undefined;
      const server = new Server({ name: "fake-esa", version: "0.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: [...tools.keys()].map((name) => ({ name, inputSchema: { type: "object" as const } })),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;
        calls.push({ name: request.params.name, args, authorization });
        const handler = tools.get(request.params.name);
        if (handler === undefined) {
          return { content: [{ type: "text" as const, text: "Error: unknown tool" }], isError: true };
        }
        const result = await handler(args);
        return { content: [{ type: "text" as const, text: result.text }], ...(result.isError ? { isError: true } : {}) };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport as Transport);
      httpStatuses.push(200);
      await transport.handleRequest(req, res, body);
    })();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    calls,
    httpStatuses,
    setTool: (name, handler) => tools.set(name, handler),
    forceStatus: (status) => {
      forced = status;
    },
    hang: (enabled) => {
      hanging = enabled;
    },
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
