/**
 * T-021 テストハーネス: Orchestrator の MCP サーバー(server/http.ts)を port 0 で listen させる。
 * Gateway は test/helpers/harness.ts の startGateway(実 Gateway、モック IdP、コーパス型の
 * モックコネクタ)。MCP クライアントは SDK の Client + StreamableHTTPClientTransport
 * (Authorization: Bearer は requestInit.headers)。ネットワークは 127.0.0.1 のみ。
 *
 * 秘密情報の実値は使わない(ダミーは dev-only-...、不変条件6)。
 */
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AuditRecord } from "@kp/audit";
import {
  McpGatewayClient,
  Orchestrator,
  ServerLimits,
  createOrchestratorHttpServer,
  scriptedSubmit,
  scriptedToolUse,
  type GatewayClientFactory,
  type GatewaySourcePolicy,
  type LlmClient,
  type LlmTurn,
  type OrchestratorSettingsInput,
  type RetentionClass,
  type ScriptContext,
  type ServerLimitsInput,
} from "../../src/index.js";
import { TEST_ORCHESTRATOR_CREDENTIAL } from "./harness.js";
import { searchHits } from "./script.js";

export type AnswerRunRecord = Extract<AuditRecord, { recordType: "answer_run" }>;

export interface OrchestratorServerOptions {
  readonly gatewayUrl: string;
  readonly llm: LlmClient;
  readonly limits?: ServerLimitsInput;
  readonly retentionClass?: RetentionClass;
  readonly createGatewayClient?: GatewayClientFactory;
  /** Orchestrator の資格情報(既定 TEST_ORCHESTRATOR_CREDENTIAL。null で付けない) */
  readonly orchestratorCredential?: string | null;
  /** feedback の申告の期限(ms) */
  readonly feedbackTimeoutMs?: number;
  /** Gateway が公開するソースと --config の照合(S6) */
  readonly sourcePolicy?: GatewaySourcePolicy;
  readonly path?: string;
  /** POST 本文の上限(バイト) */
  readonly maxBodyBytes?: number;
  /** preflight 全体の期限(ms) */
  readonly preflightTimeoutMs?: number;
  /** 探索の設定(runTimeoutMs 等) */
  readonly settings?: OrchestratorSettingsInput;
}

export interface OrchestratorServerHarness {
  /** MCP エンドポイント(http://127.0.0.1:<port>/mcp) */
  readonly url: string;
  readonly origin: string;
  readonly orchestrator: Orchestrator;
  readonly limits: ServerLimits;
  /** SDK の MCP クライアントで接続する(token 省略時は Authorization を付けない) */
  connect(token?: string): Promise<Client>;
  close(): Promise<void>;
}

export async function startOrchestratorServer(
  options: OrchestratorServerOptions,
): Promise<OrchestratorServerHarness> {
  const orchestrator = new Orchestrator({
    llm: options.llm,
    ...(options.settings !== undefined ? { settings: options.settings } : {}),
  });
  const limits = new ServerLimits(options.limits);
  const credential =
    options.orchestratorCredential === undefined
      ? TEST_ORCHESTRATOR_CREDENTIAL
      : options.orchestratorCredential;
  const server = createOrchestratorHttpServer(
    {
      orchestrator,
      gatewayUrl: options.gatewayUrl,
      ...(credential !== null ? { orchestratorCredential: credential } : {}),
      limits,
      ...(options.retentionClass !== undefined ? { retentionClass: options.retentionClass } : {}),
      ...(options.createGatewayClient !== undefined
        ? { createGatewayClient: options.createGatewayClient }
        : {}),
      ...(options.feedbackTimeoutMs !== undefined
        ? { feedbackTimeoutMs: options.feedbackTimeoutMs }
        : {}),
      ...(options.sourcePolicy !== undefined ? { sourcePolicy: options.sourcePolicy } : {}),
    },
    {
      ...(options.path !== undefined ? { path: options.path } : {}),
      ...(options.maxBodyBytes !== undefined ? { maxBodyBytes: options.maxBodyBytes } : {}),
      ...(options.preflightTimeoutMs !== undefined
        ? { preflightTimeoutMs: options.preflightTimeoutMs }
        : {}),
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const url = `${origin}${options.path ?? "/mcp"}`;
  const clients: Client[] = [];

  return {
    url,
    origin,
    orchestrator,
    limits,
    async connect(token) {
      const client = await connectMcpClient(url, token);
      clients.push(client);
      return client;
    },
    async close() {
      await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** SDK の MCP クライアント(Streamable HTTP)。token があれば Authorization: Bearer を付ける。 */
export async function connectMcpClient(url: string, token?: string): Promise<Client> {
  const client = new Client({ name: "t021-test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    token === undefined ? {} : { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  // SDK の型宣言が exactOptionalPropertyTypes に非対応のため型だけ合わせる
  await client.connect(transport as Transport);
  return client;
}

/** JSON-RPC の本文(認証の前段の検証用。生の HTTP で送る)。 */
export const RAW_BODIES = {
  initialize: {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t021-raw", version: "0.0.0" },
    },
  },
  "tools/list": { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  "tools/call": {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "ask", arguments: { question: "経費精算の締め日は?" } },
  },
} as const;

/** 生の HTTP POST(MCP の Accept / Content-Type を付ける)。 */
export function rawPost(
  url: string,
  body: unknown,
  authorization?: string,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(authorization !== undefined ? { authorization } : {}),
    },
    body: JSON.stringify(body),
  });
}

/**
 * 全ターン共通の脚本: 直前に search のヒットがなければ alpha を検索し、あれば最初の
 * ヒットを出典にして回答を提出する(複数の run で同じ LLM クライアントを共有できる)。
 */
export function searchThenSubmit(
  answer = "経費精算の締め日は毎月25日です。",
  query = "締め日",
): (context: ScriptContext) => LlmTurn {
  return (context) => {
    const [hit] = searchHits(context);
    if (hit === undefined) {
      return scriptedToolUse([{ name: "search", input: { source: "alpha", query } }]);
    }
    return scriptedSubmit({
      answer,
      citations: [{ documentId: hit.documentId, sourceId: hit.source }],
      confidence: 0.9,
    });
  };
}


/** Orchestrator から Gateway への呼び出しの数(countingGatewayClients が数える)。 */
export interface GatewayCallCounts {
  listTools: number;
  callTool: number;
  readonly calledTools: string[];
}

/**
 * 呼び出しを数える Gateway クライアントの factory(実体は McpGatewayClient)。preflight の
 * tools/list と、ask / feedback が Gateway に送った tools/list・tools/call を数える。
 */
export function countingGatewayClients(): {
  readonly counts: GatewayCallCounts;
  readonly factory: GatewayClientFactory;
} {
  const counts: GatewayCallCounts = { listTools: 0, callTool: 0, calledTools: [] };
  const factory: GatewayClientFactory = (options) => {
    const inner = new McpGatewayClient(options);
    return {
      listTools(callOptions) {
        counts.listTools += 1;
        return inner.listTools(callOptions);
      },
      callTool(name, args, meta, callOptions) {
        counts.callTool += 1;
        counts.calledTools.push(name);
        return inner.callTool(name, args, meta, callOptions);
      },
      startRun: (input, callOptions) => inner.startRun(input, callOptions),
      finishRun: (runId, input, callOptions) => inner.finishRun(runId, input, callOptions),
      feedbackRun: (runId, outcome, callOptions) => inner.feedbackRun(runId, outcome, callOptions),
      close: () => inner.close(),
    };
  };
  return { counts, factory };
}
