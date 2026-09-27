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
