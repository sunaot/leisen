/**
 * モック API サーバーの共通部(node:http、127.0.0.1 の port 0 で listen)。
 * mock-anthropic-server.ts / mock-openai-server.ts が使う。
 *
 * - 要求本文を JSON として読み、ハンドラ(脚本)の返した応答を JSON で返す
 * - ハンドラが投げた例外(脚本内の expect の失敗など)は 500 で返しつつ scriptErrors に
 *   記録する。テストは最後に scriptErrors が空であることを確かめる(クライアント側の
 *   エラー分類に埋もれさせない)
 * - ヘッダは値を保持しない(資格情報のダミー値もテストの記録に残さない)。各モックが
 *   有無・スキームだけを取り出して記録する
 */
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockHttpRequest {
  readonly method: string;
  /** パス+クエリ */
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  /** JSON として読めた本文(読めなければ undefined) */
  readonly body: unknown;
}

export interface MockHttpReply {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** JSON にして返す本文(undefined なら空) */
  readonly body?: unknown;
}

export interface MockHttpServer {
  /** http://127.0.0.1:<port>(末尾スラッシュなし) */
  readonly url: string;
  /** ハンドラが投げた例外 */
  readonly scriptErrors: unknown[];
  close(): Promise<void>;
}

export async function startMockHttpServer(
  handler: (request: MockHttpRequest) => MockHttpReply | Promise<MockHttpReply>,
): Promise<MockHttpServer> {
  const scriptErrors: unknown[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = text === "" ? undefined : JSON.parse(text);
      } catch {
        body = undefined;
      }
      let reply: MockHttpReply;
      try {
        reply = await handler({
          method: req.method ?? "",
          path: req.url ?? "",
          headers: req.headers,
          body,
        });
      } catch (error) {
        scriptErrors.push(error);
        reply = { status: 500, body: { error: { message: "mock script failed" } } };
      }
      res.writeHead(reply.status ?? 200, {
        "content-type": "application/json",
        ...reply.headers,
      });
      res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    scriptErrors,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON として読めれば値、読めなければ undefined。 */
export function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 応答しない MCP サーバー(startStalledMcpServer)。 */
export interface StalledMcpServer extends MockHttpServer {
  /** 受け取った JSON-RPC の method(受け取った順) */
  readonly methods: readonly string[];
}

/**
 * 応答しない MCP サーバー(Gateway の代わり。preflight・接続の期限の検証用)。
 * respondToInitialize が true なら initialize にだけ応答し、以降(notifications/initialized・
 * tools/list など)には応答しない。false なら何にも応答しない。close で接続ごと閉じる。
 */
export async function startStalledMcpServer(options: {
  readonly respondToInitialize: boolean;
}): Promise<StalledMcpServer> {
  const methods: string[] = [];
  const server = await startMockHttpServer((request) => {
    const body = isRecord(request.body) ? request.body : {};
    const method = typeof body["method"] === "string" ? body["method"] : "(unknown)";
    methods.push(method);
    if (options.respondToInitialize && method === "initialize") {
      const params = body["params"];
      const protocolVersion =
        isRecord(params) && typeof params["protocolVersion"] === "string"
          ? params["protocolVersion"]
          : "2025-06-18";
      return {
        body: {
          jsonrpc: "2.0",
          id: body["id"],
          result: {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "stalled-gateway", version: "0.0.0" },
          },
        },
      };
    }
    // 応答しない(接続は close まで開いたまま)
    return new Promise<MockHttpReply>(() => undefined);
  });
  return { ...server, methods };
}
