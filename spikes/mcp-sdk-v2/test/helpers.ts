/**
 * [スパイク] テスト共通部品。実物の Gateway コア(packages/gateway/src)と T-003 の
 * テスト用モック(packages/gateway/test/helpers/proxy.ts)を読み込むだけで、
 * packages/* は変更しない。
 */
import { createServer, type RequestListener } from "node:http";
import {
  AuditLogger,
  Gateway,
} from "../../../packages/gateway/src/index.js";
import {
  CollectingAuditSink,
  MockConnector,
  testConfig,
  testIdpAdapter,
} from "../../../packages/gateway/test/helpers/proxy.js";
import { createGatewayHttpEntry, type GatewayHttpOptions } from "../src/http.js";

export const MODERN = "2026-07-28";
export const ALICE = { authorization: "Bearer session-alice" };

export async function listen(listener: RequestListener) {
  const http = createServer(listener);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  return {
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    close: () =>
      new Promise<void>((resolve, reject) => {
        http.closeAllConnections();
        http.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** alpha / beta の2ソースを持つ実物の Gateway を v2 の HTTP 入口で起動する。 */
export async function startGateway(options: Partial<GatewayHttpOptions> = {}) {
  const alpha = new MockConnector("alpha");
  const beta = new MockConnector("beta");
  const sink = new CollectingAuditSink();
  const gateway = new Gateway({
    config: testConfig(),
    idpAdapter: testIdpAdapter(),
    connectors: [alpha, beta],
    auditLogger: new AuditLogger(sink),
  });
  const entry = createGatewayHttpEntry(gateway, { toolsListTtlMs: 300_000, ...options });
  const http = await listen((req, res) => void entry.listener(req, res));
  return {
    url: http.url,
    alpha,
    sink,
    close: async () => {
      await entry.handler.close();
      await http.close();
    },
  };
}

export interface Exchange {
  readonly method: string;
  /** JSON-RPC の method(本文から) */
  readonly rpc: string | undefined;
  readonly req: Headers;
  readonly status: number;
  readonly res: Headers;
  readonly body: Promise<string>;
}

/** SDK クライアントの実 HTTP 往復を記録する fetch(v1/v2 共通の公開オプション `fetch`)。 */
export function recordingFetch(exchanges: Exchange[]) {
  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const response = await fetch(url, init);
    const text = typeof init?.body === "string" ? init.body : undefined;
    const parsed: unknown = text === undefined ? undefined : JSON.parse(text);
    exchanges.push({
      method: init?.method ?? "GET",
      rpc: (parsed as { method?: string } | undefined)?.method,
      req: new Headers(init?.headers),
      status: response.status,
      res: response.headers,
      // クライアントの close() が進行中の本文読みを中断するため、失敗は空文字にする
      body: response.clone().text().catch(() => ""),
    });
    return response;
  };
}

/** 応答本文(JSON、または SSE の data 行)から JSON-RPC メッセージを取り出す。 */
export function messagesOf(text: string): Array<Record<string, unknown>> {
  if (text.trim() === "") return [];
  const lines = text.split("\n").filter((line) => line.startsWith("data:"));
  const chunks = lines.length > 0 ? lines.map((line) => line.slice(5).trim()) : [text];
  return chunks.filter((c) => c !== "").map((c) => JSON.parse(c) as Record<string, unknown>);
}

export async function resultOf(exchange: Exchange | undefined): Promise<Record<string, unknown>> {
  const [message] = messagesOf((await exchange?.body) ?? "");
  return (message?.["result"] ?? {}) as Record<string, unknown>;
}

/** SDK クライアントを介さない生の POST(旧版クライアント・ヘッダ欠落の再現用)。 */
export async function postRaw(url: URL, message: object, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(message),
  });
  const messages = messagesOf(await response.text());
  return { status: response.status, headers: response.headers, message: messages[0] };
}

/** 2026-07-28 版の per-request _meta envelope(SDK 定数と同じキー)。 */
export function envelope(): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN,
    "io.modelcontextprotocol/clientInfo": { name: "raw", version: "0.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}
