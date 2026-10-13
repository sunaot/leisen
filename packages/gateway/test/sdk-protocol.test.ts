/**
 * MCP SDK プロトコル回帰テスト(ADR-001追補3「SDK更新の進め方」の検証項目 (a)〜(d)、
 * docs/mcp-spec-2026-07-28-review.md §C-2)。
 *
 * 目的: `@modelcontextprotocol/sdk` の更新で、ネゴシエートされるプロトコル
 * バージョンや Streamable HTTP の挙動が黙って変わることを検知し、SDK更新PRで
 * 必ず人間のレビューが走るようにする(package.json は exact ピン留め)。
 *
 * SDK 1.30.1 での検証結果(2026-09-27。ADR-001追補3「SDK更新の検証結果」):
 * - 1.30.x は仕様2026-07-28版を実装していない(LATEST_PROTOCOL_VERSION=2025-11-25)
 * - (a) 旧版クライアントには要求された版で応答する。ステートレスモード
 *   (sessionIdGenerator: undefined)では mcp-session-id を一切発行しない。
 *   ステートレス transport はリクエスト間で再利用できない
 * - (b) resultType は自動付与されない
 * - (c) CacheableResult(ttlMs / cacheScope)の型・自動付与はない。ハンドラが
 *   返した追加フィールドはルーズな結果スキーマを型検証なしで素通りするだけ
 * - (d) 下記 PINNED_* の固定値アサート
 *
 * SDK 1.32.1 への更新(2026-10-13、ADR-001追補3「SDK更新の検証結果(2026-10-13、1.32.1)」)でも
 * (a)〜(d) の結果と下記の固定値は変わらない。
 *
 * GatewayのMCPサーバー面(src/proxy/mcp.ts)には依存せず、最小のSDK Serverで
 * SDK自体の挙動を固定する。サーバー面はT-003のHTTP配線で作り替えるため、
 * その検証は配線PRのテストが担う。
 */
import { createServer, type RequestListener } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type {
  FetchLike,
  Transport,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCErrorResponse,
  type JSONRPCMessage,
  type JSONRPCResultResponse,
  type RequestId,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * SDKがネゴシエートする最新プロトコルバージョンの固定値(SDK 1.30.1 時点。1.32.1 でも同じ)。
 *
 * この値が `2026-07-28` に変わったら、T-003 の保留項目(resultType 付与、
 * CacheableResult、Mcp-Method/Mcp-Name 検証、server/discover)を実装してから
 * このテストを更新すること。それ以外の値に変わった場合も、ADR-001追補3 決定6
 * (後方互換はSDKのネゴシエーションに委ねる)の前提を確認してから更新する。
 *
 * 注: 2026-07-28版の対応は v2 系の分割パッケージ(@modelcontextprotocol/server 等)で
 * 提供されている。v1 系(本依存)が対応しない限りこの値は変わらないため、保留の
 * 解除(v2 移行の判断を含む)は本テストではなく ADR-001追補3「SDK更新の検証結果」で
 * 追跡する。
 *
 * vitest の snapshot は `-u` で機械的に更新できてしまうため使わず、定数で固定する。
 */
const PINNED_PROTOCOL_VERSION = "2025-11-25";

/** SDK 1.30.1 / 1.32.1 の SUPPORTED_PROTOCOL_VERSIONS(順序込み)。旧版窓の変化もレビュー対象。 */
const PINNED_SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];

/** mcp-protocol-version ヘッダのないHTTP要求にSDKが仮定する版(2025-03-26以前のクライアント互換)。 */
const PINNED_DEFAULT_NEGOTIATED_PROTOCOL_VERSION = "2025-03-26";

/** ADR-001追補3 が設計前提とする仕様版。SDK 1.30.1 / 1.32.1 は未対応。 */
const TARGET_SPEC_VERSION = "2026-07-28";

const OLDER_SUPPORTED_VERSIONS = PINNED_SUPPORTED_PROTOCOL_VERSIONS.filter(
  (version) => version !== PINNED_PROTOCOL_VERSION,
);

const LEGACY_CLIENT_INFO = { name: "legacy-client", version: "0.0.0" };

const PROBE_TOOL: Tool = {
  name: "probe",
  inputSchema: { type: "object", properties: {} },
};

interface ProbeExtras {
  /** tools/list の結果に足すフィールド((c) 返却経路の検証用) */
  readonly list?: Readonly<Record<string, unknown>>;
  /** tools/call の結果に足すフィールド((b) 返却経路の検証用) */
  readonly call?: Readonly<Record<string, unknown>>;
}

/** Gatewayと同じ capabilities(tools のみ、src/proxy/mcp.ts)を持つ最小のSDK Server。 */
function probeServer(extras: ProbeExtras = {}): Server {
  const server = new Server(
    { name: "sdk-protocol-probe", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    ...extras.list,
    tools: [PROBE_TOOL],
  }));
  server.setRequestHandler(CallToolRequestSchema, () => ({
    ...extras.call,
    content: [{ type: "text" as const, text: "ok" }],
  }));
  return server;
}

function resultOf(reply: unknown): Record<string, unknown> {
  if (!isJSONRPCResultResponse(reply)) {
    throw new Error(`expected a JSON-RPC result, got: ${JSON.stringify(reply)}`);
  }
  return reply.result;
}

type JsonRpcReply = JSONRPCResultResponse | JSONRPCErrorResponse;

/**
 * SDK Client を介さず生の JSON-RPC を送る InMemory セッション。SDK Client は
 * initialize で常に LATEST_PROTOCOL_VERSION を要求するため、旧版クライアントと
 * 結果の生の形はこちらで検証する。
 */
async function rawInMemorySession(server: Server) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const waiting = new Map<RequestId, (reply: JsonRpcReply) => void>();
  clientSide.onmessage = (message) => {
    if (
      (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) &&
      message.id !== undefined
    ) {
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  };
  await server.connect(serverSide);
  await clientSide.start();
  let lastId = 0;
  return {
    async request(
      method: string,
      params?: Record<string, unknown>,
    ): Promise<JsonRpcReply> {
      const id = ++lastId;
      const reply = new Promise<JsonRpcReply>((resolve) => {
        waiting.set(id, resolve);
      });
      await clientSide.send({
        jsonrpc: "2.0",
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      });
      return reply;
    },
    close: () => server.close(),
  };
}

function initializeParams(protocolVersion: string): Record<string, unknown> {
  return { protocolVersion, capabilities: {}, clientInfo: LEGACY_CLIENT_INFO };
}

// ---- Streamable HTTP helpers ----

/**
 * ステートレスモード(sessionIdGenerator: undefined)のサーバートランスポート。
 * SDKの例は `{ sessionIdGenerator: undefined }` と明示するが、本リポジトリの
 * exactOptionalPropertyTypes では型エラーになるためプロパティを省略する
 * (実行時は同一: 未指定 = undefined = ステートレス)。
 */
function statelessServerTransport(): StreamableHTTPServerTransport {
  return new StreamableHTTPServerTransport({});
}

/**
 * SDKのHTTPトランスポートの型定義は exactOptionalPropertyTypes と非互換
 * (`onclose` / `sessionId` が `T | undefined` の getter/プロパティで宣言され、
 * Transport IF の `onclose?: () => void` 等に代入できない)。1.29.0 から同じで、
 * 実行時の問題はない。HTTP配線(src 側、tsc 対象)でも同じ回避が要る。
 */
function asTransport(
  transport: StreamableHTTPServerTransport | StreamableHTTPClientTransport,
): Transport {
  return transport as Transport;
}

interface RunningHttpServer {
  readonly url: URL;
  close(): Promise<void>;
}

async function listen(listener: RequestListener): Promise<RunningHttpServer> {
  const httpServer = createServer(listener);
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return {
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.closeAllConnections();
        httpServer.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/**
 * SDKのステートレス構成(sessionIdGenerator: undefined)。ステートレス transport は
 * リクエスト間で再利用できず、Server も同時に1つの transport にしか接続できない
 * (下の "cannot reuse" テスト)ため、リクエストごとに Server + transport を作る。
 * GET(スタンドアロンSSE)は SDK のステートレス例と同じく 405 を返す。
 */
const statelessListener: RequestListener = (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" }).end();
    return;
  }
  const server = probeServer();
  const transport = statelessServerTransport();
  res.on("close", () => {
    void server.close();
  });
  server
    .connect(asTransport(transport))
    .then(() => transport.handleRequest(req, res))
    .catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
};

interface HttpExchange {
  readonly method: string;
  readonly requestHeaders: Headers;
  readonly status: number;
  readonly responseHeaders: Headers;
}

/** SDKクライアントトランスポートの実HTTP往復を記録する fetch(公開オプション `fetch`)。 */
function recordingFetch(exchanges: HttpExchange[]): FetchLike {
  return async (url, init) => {
    const response = await fetch(url, init);
    exchanges.push({
      method: init?.method ?? "GET",
      requestHeaders: new Headers(init?.headers),
      status: response.status,
      responseHeaders: response.headers,
    });
    return response;
  };
}

interface RawHttpReply {
  readonly status: number;
  readonly headers: Headers;
  readonly messages: unknown[];
}

/** SDK Client を介さない生の POST(旧版クライアント・未対応版の再現用)。 */
async function postJsonRpc(
  url: URL,
  message: JSONRPCMessage,
  headers: Record<string, string> = {},
): Promise<RawHttpReply> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(message),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    messages: parseJsonRpcBody(response.headers.get("content-type"), text),
  };
}

/** 応答本文(JSON、またはSSEの data 行)から JSON-RPC メッセージを取り出す。 */
function parseJsonRpcBody(contentType: string | null, text: string): unknown[] {
  if (text.trim() === "") return [];
  if (contentType?.includes("text/event-stream")) {
    return text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .filter((data) => data !== "")
      .map((data): unknown => JSON.parse(data));
  }
  return [JSON.parse(text) as unknown];
}

// ---- tests ----

describe("(d) pinned protocol versions — an SDK update must fail here and force review", () => {
  it("still has 2025-11-25 as the latest version; 2026-07-28 is not implemented", () => {
    expect(LATEST_PROTOCOL_VERSION).toBe(PINNED_PROTOCOL_VERSION);
    expect(SUPPORTED_PROTOCOL_VERSIONS).not.toContain(TARGET_SPEC_VERSION);
  });

  it("keeps the supported-version window and the header-less default unchanged", () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual(
      PINNED_SUPPORTED_PROTOCOL_VERSIONS,
    );
    expect(DEFAULT_NEGOTIATED_PROTOCOL_VERSION).toBe(
      PINNED_DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
    );
  });
});

describe("(a)(d) version negotiation over InMemoryTransport", () => {
  it("negotiates the pinned version between the SDK Client and Server", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    // Client はネゴシエート結果を公開APIで保持しない(getServerVersion() は serverInfo)。
    // initialize 応答の受信時に Transport IF の setProtocolVersion で渡すので、それを記録する
    const negotiated: string[] = [];
    const observed: Transport = clientSide;
    observed.setProtocolVersion = (version) => {
      negotiated.push(version);
    };
    // Protocol.connect は既存の onmessage を連鎖呼び出しするため、生の応答も記録できる
    const received: JSONRPCMessage[] = [];
    clientSide.onmessage = (message) => {
      received.push(message);
    };
    const sent: JSONRPCMessage[] = [];
    const send = clientSide.send.bind(clientSide);
    clientSide.send = (message, options) => {
      sent.push(message);
      return send(message, options);
    };

    const server = probeServer();
    await server.connect(serverSide);
    const client = new Client({ name: "sdk-protocol-probe", version: "0.0.0" });
    try {
      await client.connect(clientSide);

      // SDK Client は常に LATEST を要求する(T-005/T-006 でGatewayがクライアントになる場合も同じ)
      const initRequest = sent
        .filter(isJSONRPCRequest)
        .find((message) => message.method === "initialize");
      expect(initRequest?.params?.["protocolVersion"]).toBe(
        PINNED_PROTOCOL_VERSION,
      );
      // initialize 応答そのもの
      const initReply = received.find(
        (message) =>
          isJSONRPCResultResponse(message) && message.id === initRequest?.id,
      );
      expect(resultOf(initReply).protocolVersion).toBe(PINNED_PROTOCOL_VERSION);
      // Client がネゴシエート結果としてトランスポートに渡した値
      expect(negotiated).toEqual([PINNED_PROTOCOL_VERSION]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each(OLDER_SUPPORTED_VERSIONS)(
    "answers an older client requesting %s in that same version (decision 6)",
    async (version) => {
      const session = await rawInMemorySession(probeServer());
      try {
        const reply = await session.request(
          "initialize",
          initializeParams(version),
        );
        expect(resultOf(reply).protocolVersion).toBe(version);
      } finally {
        await session.close();
      }
    },
  );

  it("answers a client requesting 2026-07-28 with 2025-11-25 (unknown to this SDK)", async () => {
    const session = await rawInMemorySession(probeServer());
    try {
      const reply = await session.request(
        "initialize",
        initializeParams(TARGET_SPEC_VERSION),
      );
      expect(resultOf(reply).protocolVersion).toBe(PINNED_PROTOCOL_VERSION);
    } finally {
      await session.close();
    }
  });
});

// (b)(c) の新仕様フィールドは対応SDKを採用するまで保留(ADR-001追補3「SDK更新の検証結果」)。
// 2025-11-25 でネゴシエートしている間は、Gatewayのハンドラで手で付与しない。
describe("(b)(c) 2026-07-28 result fields are absent from SDK v1 (1.30.1 / 1.32.1)", () => {
  it("does not attach resultType to results, nor declare it in result schemas (b)", async () => {
    const session = await rawInMemorySession(probeServer());
    try {
      const list = resultOf(await session.request("tools/list"));
      const call = resultOf(
        await session.request("tools/call", { name: "probe", arguments: {} }),
      );
      expect(list).not.toHaveProperty("resultType");
      expect(call).not.toHaveProperty("resultType");
    } finally {
      await session.close();
    }
    expect(Object.keys(ListToolsResultSchema.shape)).not.toContain("resultType");
    expect(Object.keys(CallToolResultSchema.shape)).not.toContain("resultType");
    expect(CallToolResultSchema.safeParse({ content: [] }).success).toBe(true);
  });

  it("does not attach ttlMs / cacheScope to tools/list, nor declare them (c)", async () => {
    const session = await rawInMemorySession(probeServer());
    try {
      const list = resultOf(await session.request("tools/list"));
      expect(list).not.toHaveProperty("ttlMs");
      expect(list).not.toHaveProperty("cacheScope");
    } finally {
      await session.close();
    }
    expect(Object.keys(ListToolsResultSchema.shape).sort()).toEqual([
      "_meta",
      "nextCursor",
      "tools",
    ]);
    expect(ListToolsResultSchema.safeParse({ tools: [] }).success).toBe(true);
  });

  it("only passes handler-supplied extra fields through, untyped (the sole return path today)", async () => {
    const extras = {
      list: { ttlMs: 300000, cacheScope: "private" },
      call: { resultType: "complete" },
    };
    const session = await rawInMemorySession(probeServer(extras));
    try {
      const list = resultOf(await session.request("tools/list"));
      const call = resultOf(
        await session.request("tools/call", { name: "probe", arguments: {} }),
      );
      expect(list).toMatchObject(extras.list);
      expect(call).toMatchObject(extras.call);
    } finally {
      await session.close();
    }
    // 結果スキーマはルーズで、値を検証せずに残す(CacheableResult の型を知らない)
    expect(
      ListToolsResultSchema.parse({ tools: [], ttlMs: "not-a-number" }),
    ).toHaveProperty("ttlMs", "not-a-number");
  });
});

describe("(a) Streamable HTTP in stateless mode (sessionIdGenerator: undefined)", () => {
  let http: RunningHttpServer;

  beforeAll(async () => {
    http = await listen(statelessListener);
  });

  afterAll(async () => {
    await http.close();
  });

  it("serves initialize → tools/list for the SDK client without any mcp-session-id", async () => {
    const exchanges: HttpExchange[] = [];
    const transport = new StreamableHTTPClientTransport(http.url, {
      fetch: recordingFetch(exchanges),
    });
    const client = new Client({ name: "sdk-protocol-probe", version: "0.0.0" });
    try {
      await client.connect(asTransport(transport));
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["probe"]);

      expect(transport.sessionId).toBeUndefined();
      expect(transport.protocolVersion).toBe(PINNED_PROTOCOL_VERSION);

      // 初期化後、SDKクライアントは非同期に GET でスタンドアロンSSEを開こうとする。
      // 405 は「GETストリームなし」として許容される
      await vi.waitFor(() => {
        expect(exchanges.some((e) => e.method === "GET")).toBe(true);
      });
    } finally {
      await client.close();
    }

    // initialize(200) → notifications/initialized(202) → tools/list(200)
    const posts = exchanges.filter((e) => e.method === "POST");
    expect(posts.map((e) => e.status)).toEqual([200, 202, 200]);
    expect(exchanges.find((e) => e.method === "GET")?.status).toBe(405);
    for (const exchange of exchanges) {
      expect(exchange.responseHeaders.get("mcp-session-id")).toBeNull();
      expect(exchange.requestHeaders.get("mcp-session-id")).toBeNull();
      // 2026-07-28版の Mcp-Method / Mcp-Name ヘッダはSDKクライアントが送らない
      expect(exchange.requestHeaders.get("mcp-method")).toBeNull();
      expect(exchange.requestHeaders.get("mcp-name")).toBeNull();
    }
    // initialize 以降の要求はネゴシエート済みの版をヘッダで運ぶ
    const afterInitialize = exchanges.slice(1);
    expect(afterInitialize.length).toBeGreaterThan(0);
    for (const exchange of afterInitialize) {
      expect(exchange.requestHeaders.get("mcp-protocol-version")).toBe(
        PINNED_PROTOCOL_VERSION,
      );
    }
  });

  it("answers an older client (2025-06-18) in its own version without issuing a session", async () => {
    const init = await postJsonRpc(http.url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: initializeParams("2025-06-18"),
    });
    expect(init.status).toBe(200);
    expect(init.headers.get("mcp-session-id")).toBeNull();
    expect(resultOf(init.messages[0]).protocolVersion).toBe("2025-06-18");

    const list = await postJsonRpc(
      http.url,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { "mcp-protocol-version": "2025-06-18" },
    );
    expect(list.status).toBe(200);
    expect(list.headers.get("mcp-session-id")).toBeNull();
    expect(resultOf(list.messages[0])).toMatchObject({
      tools: [{ name: "probe" }],
    });

    // 2025-03-26 以前のクライアントは mcp-protocol-version ヘッダを送らない。ヘッダなしも受理される
    const headerless = await postJsonRpc(http.url, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    });
    expect(headerless.status).toBe(200);
    expect(headerless.headers.get("mcp-session-id")).toBeNull();
  });

  it("rejects the 2026-07-28 version header and has no server/discover (new spec not implemented)", async () => {
    const newSpec = await postJsonRpc(
      http.url,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { "mcp-protocol-version": TARGET_SPEC_VERSION },
    );
    expect(newSpec.status).toBe(400);
    expect(newSpec.messages[0]).toMatchObject({ error: { code: -32000 } });

    const discover = await postJsonRpc(
      http.url,
      { jsonrpc: "2.0", id: 2, method: "server/discover" },
      { "mcp-protocol-version": PINNED_PROTOCOL_VERSION },
    );
    expect(discover.messages[0]).toMatchObject({
      error: { code: ErrorCode.MethodNotFound },
    });
  });

  it("cannot reuse a stateless transport across requests, so Server + transport are built per request", async () => {
    const server = probeServer();
    const shared = statelessServerTransport();
    await server.connect(asTransport(shared));
    const reused = await listen((req, res) => {
      shared.handleRequest(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    try {
      const headers = { "mcp-protocol-version": PINNED_PROTOCOL_VERSION };
      const first = await postJsonRpc(
        reused.url,
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        headers,
      );
      const second = await postJsonRpc(
        reused.url,
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        headers,
      );
      expect(first.status).toBe(200);
      // SDKは2回目で "Stateless transport cannot be reused across requests" を投げる
      expect(second.status).toBe(500);
      // Server(Protocol)は同時に1つの transport にしか接続できない
      await expect(
        server.connect(asTransport(statelessServerTransport())),
      ).rejects.toThrow(/Already connected/);
    } finally {
      await reused.close();
      await server.close();
    }
  });
});
