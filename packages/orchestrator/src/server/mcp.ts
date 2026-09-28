/**
 * Orchestrator の MCP サーバー面(T-021、ADR-018 決定1)— MCP SDK との接合部。
 *
 * SDK 依存の閉じ込め: このモジュールは SDK の Server 生成・ハンドラ登録・結果の形への写像
 * だけを持つ。ツール定義・引数検証・上限・ask / feedback の実行・結果の組み立ては SDK
 * 非依存の tools.ts / render.ts にある。認証の前段(Bearer の有無と Gateway での有効性の
 * 確認 = preflight)はトランスポート層(http.ts)が JSON-RPC のディスパッチ前に済ませる。
 * SDK を v2 系へ差し替えるときの手戻りは本モジュールと http.ts のトランスポート生成部に
 * 限られる(Gateway の proxy/mcp.ts と同じ方針)。
 *
 * ステートレス(Gateway と同じ規約、ADR-001 追補3): SDK 1.x の Server は1トランスポート
 * にしか接続できないため、HTTP ではリクエストごとに createOrchestratorMcpServer() で作り、
 * 応答後に閉じる。利用者のトークンはそのリクエストのサーバーにだけ閉じ込める(Gateway への
 * 接続を作る factory のクロージャ)。トークンは結果・エラー・ログのどこにも載せない
 * (不変条件6)。
 *
 * ask の Gateway 接続(initialize → notifications/initialized)にも run の時間上限が効く:
 * run は Gateway への全呼び出しに期限の signal を渡し、McpGatewayClient は接続そのものも
 * その signal で打ち切る(セキュリティレビュー m1。gateway/mcp-client.ts)。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { McpGatewayClient } from "../gateway/mcp-client.js";
import type { GatewayClient } from "../gateway/types.js";
import type { ServerLimits } from "./limits.js";
import {
  orchestratorToolDefinitions,
  runOrchestratorTool,
  SERVER_INSTRUCTIONS,
  type OrchestratorPort,
  type RetentionClass,
  type ToolContext,
  type ToolOutcome,
} from "./tools.js";

export const ORCHESTRATOR_SERVER_INFO = {
  name: "kp-orchestrator",
  version: "0.1.0",
} as const;

/** Gateway への接続を作る(既定 McpGatewayClient)。テストで差し替えられる。 */
export type GatewayClientFactory = (options: {
  readonly url: string;
  readonly sessionToken: string;
  /** MCP 1リクエストのタイムアウト(ms)。省略時はクライアントの既定 */
  readonly requestTimeoutMs?: number;
  /** ループバック以外の http の Gateway を許す(kp-ask serve の --allow-insecure-upstream) */
  readonly allowInsecureHttp?: boolean;
}) => GatewayClient;

export const defaultGatewayClientFactory: GatewayClientFactory = (options) =>
  new McpGatewayClient(options);

export interface OrchestratorMcpServerOptions {
  readonly orchestrator: OrchestratorPort;
  /** Gateway の MCP エンドポイント */
  readonly gatewayUrl: string;
  /**
   * このリクエストの利用者のトークン(Authorization: Bearer の値。秘密情報)。
   * Orchestrator は検証せず、Gateway への接続にそのまま載せる(ADR-018 決定2)
   */
  readonly sessionToken: string;
  readonly limits: ServerLimits;
  /**
   * このリクエストの ask の retentionClass(既定 persistable。ADR-018 決定5。Gateway の
   * ソースの照合で不一致を許したときは non_persistable。http.ts が決める)
   */
  readonly retentionClass?: RetentionClass;
  /**
   * Gateway が公開するソースが --config と食い違う(S6、checkGatewaySources)。true なら
   * ask / feedback を config_mismatch で拒否する
   */
  readonly configMismatch?: boolean;
  readonly createGatewayClient?: GatewayClientFactory;
  /** feedback の本人確認で Gateway に申告する runId の採番(テスト用) */
  readonly newVerificationRunId?: () => string;
  /** feedback の本人確認の期限(ms、既定 FEEDBACK_VERIFICATION_TIMEOUT_MS) */
  readonly verificationTimeoutMs?: number;
}

/** SDK 非依存の結果を MCP の CallToolResult に写す。 */
function toCallToolResult(outcome: ToolOutcome): CallToolResult {
  return {
    content: [{ type: "text", text: outcome.text }],
    structuredContent: outcome.structuredContent,
    ...(outcome.isError ? { isError: true } : {}),
  };
}

/**
 * 1リクエスト分の MCP サーバーを作る(ツールは ask と feedback)。initialize の結果に
 * instructions(出典をそのまま提示する等、UI 側の LLM への指示)を載せる。
 */
export function createOrchestratorMcpServer(options: OrchestratorMcpServerOptions): Server {
  const factory = options.createGatewayClient ?? defaultGatewayClientFactory;
  const { gatewayUrl, sessionToken } = options;
  const context: ToolContext = {
    orchestrator: options.orchestrator,
    createGatewayClient: () => factory({ url: gatewayUrl, sessionToken }),
    limits: options.limits,
    retentionClass: options.retentionClass ?? "persistable",
    configMismatch: options.configMismatch ?? false,
    ...(options.newVerificationRunId !== undefined
      ? { newVerificationRunId: options.newVerificationRunId }
      : {}),
    ...(options.verificationTimeoutMs !== undefined
      ? { verificationTimeoutMs: options.verificationTimeoutMs }
      : {}),
  };
  const server = new Server(ORCHESTRATOR_SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: SERVER_INSTRUCTIONS,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: orchestratorToolDefinitions(options.limits),
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> =>
      toCallToolResult(
        await runOrchestratorTool(context, request.params.name, request.params.arguments),
      ),
  );

  return server;
}
