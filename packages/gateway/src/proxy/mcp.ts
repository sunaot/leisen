/**
 * GatewayのMCPサーバー面(T-003、ADR-001)。
 *
 * 上流(Orchestrator)にはMCPサーバーとして4ツール(search / fetch / list /
 * describe)を公開し、実行はGatewayコア(認証注入・監査・レート制御)へ
 * 委譲する。MCPのリクエスト/レスポンスをここで横取りして監査と認証を注入する
 * (ADR-001 帰結)。
 *
 * セッション束縛: MCP自体はエンドユーザーIDを運ばないため、サーバー
 * インスタンスは「確立済みGatewaySessionごと」に作る。トランスポート層
 * (HTTPのAuthorizationヘッダ等)でセッショントークンを受けて
 * gateway.establishSession() を通してから本サーバーを接続すること。
 *
 * 下流(コネクタ)は現時点でin-processの Connector 実装(connector-sdk)を
 * 呼ぶ。外部プロセスのMCPサーバー型コネクタ(Slack公式MCP等、ADR-014)は
 * Connector IFを実装するMCPクライアントアダプタとして各コネクタタスク
 * (T-005/T-006)で追加する。IF境界は変えない(不変条件5)。
 *
 * ツール結果のエラーにはGatewayの正規化エラー(errorClass)のみを返し、
 * 生の例外メッセージ・スタックトレースを流さない(TM-A2)。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { SearchFilters, SearchOptions } from "@kp/connector-sdk";
import { z } from "zod";
import type { Gateway } from "./gateway.js";
import {
  GatewayError,
  type CallContext,
  type GatewaySession,
  type GatewayToolCall,
} from "./types.js";

export const GATEWAY_SERVER_INFO = {
  name: "kp-gateway",
  version: "0.1.0",
} as const;

const filtersSchema = z.strictObject({
  updatedAfter: z.string().min(1).optional(),
  updatedBefore: z.string().min(1).optional(),
  container: z.string().min(1).optional(),
  author: z.string().min(1).optional(),
});

const searchArgsSchema = z.strictObject({
  source: z.string().min(1),
  query: z.string().min(1),
  filters: filtersSchema.optional(),
  limit: z.number().int().min(1).optional(),
  cursor: z.string().min(1).optional(),
});

const fetchArgsSchema = z.strictObject({
  source: z.string().min(1),
  documentId: z.string().min(1),
  pageCursor: z.string().min(1).optional(),
});

const listArgsSchema = z.strictObject({
  source: z.string().min(1),
  containerId: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
});

const describeArgsSchema = z.strictObject({
  source: z.string().min(1),
});

/** Orchestrator(T-007)がrunId/iterationを申告するための_meta(ADR-011)。 */
const callMetaSchema = z.looseObject({
  runId: z.string().min(1).optional(),
  iteration: z.number().int().min(0).optional(),
});

/**
 * 既知の限界(T-003セキュリティレビュー minor-1): 引数バリデーション失敗は
 * ディスパッチ前に止まるため監査レコードを残さない。ソースアクセスは発生して
 * おらず(不変条件2の範囲外)、ADR-011の監査対象は「ツール呼び出し」= 資格情報
 * 取得以降のパイプラインとする。試行レベルの記録が必要になったらADR-011を
 * 改訂してから追加する。
 */
function parseToolCall(name: string, args: unknown): GatewayToolCall {
  switch (name) {
    case "search": {
      const a = parseArgs(searchArgsSchema, args);
      const filters = a.filters as SearchFilters | undefined;
      const options: SearchOptions = {
        ...(a.limit !== undefined ? { limit: a.limit } : {}),
        ...(a.cursor !== undefined ? { cursor: a.cursor } : {}),
      };
      return {
        tool: "search",
        sourceId: a.source,
        query: a.query,
        ...(filters !== undefined ? { filters } : {}),
        ...(Object.keys(options).length > 0 ? { options } : {}),
      };
    }
    case "fetch": {
      const a = parseArgs(fetchArgsSchema, args);
      return {
        tool: "fetch",
        sourceId: a.source,
        documentId: a.documentId,
        ...(a.pageCursor !== undefined ? { pageCursor: a.pageCursor } : {}),
      };
    }
    case "list": {
      const a = parseArgs(listArgsSchema, args);
      return {
        tool: "list",
        sourceId: a.source,
        ...(a.containerId !== undefined ? { containerId: a.containerId } : {}),
        ...(a.cursor !== undefined ? { cursor: a.cursor } : {}),
      };
    }
    case "describe": {
      const a = parseArgs(describeArgsSchema, args);
      return { tool: "describe", sourceId: a.source };
    }
    default:
      throw new GatewayError("invalid_request", `unknown tool: ${name}`);
  }
}

function parseArgs<S extends z.ZodType>(schema: S, args: unknown): z.output<S> {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at =
      issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    // zodのissueはパスと期待型のみでツール引数の値を含まない形にする
    throw new GatewayError(
      "invalid_request",
      `invalid tool arguments${at}: ${issue?.message ?? "unknown"}`,
    );
  }
  return parsed.data;
}

function parseCallContext(meta: unknown): CallContext {
  const parsed = callMetaSchema.safeParse(meta ?? {});
  if (!parsed.success) {
    return {};
  }
  return {
    ...(parsed.data.runId !== undefined ? { runId: parsed.data.runId } : {}),
    ...(parsed.data.iteration !== undefined
      ? { iteration: parsed.data.iteration }
      : {}),
  };
}

function toolDefinitions(sourceIds: readonly string[]): Tool[] {
  // 有効ソースをenumとしてスキーマに自己記述させ、Orchestratorのソース選択を
  // 助ける(ADR-001の採用理由)。ソースの内容説明は describe ツールが返す
  const source =
    sourceIds.length > 0
      ? { type: "string" as const, enum: [...sourceIds] }
      : { type: "string" as const };
  const cursor = { type: "string" as const };
  return [
    {
      name: "search",
      description:
        "指定ソースを利用者本人の権限で検索し、スニペット付きのヒット一覧を返す",
      inputSchema: {
        type: "object",
        properties: {
          source,
          query: { type: "string" },
          filters: {
            type: "object",
            properties: {
              updatedAfter: { type: "string" },
              updatedBefore: { type: "string" },
              container: { type: "string" },
              author: { type: "string" },
            },
            additionalProperties: false,
          },
          limit: { type: "number" },
          cursor,
        },
        required: ["source", "query"],
        additionalProperties: false,
      },
    },
    {
      name: "fetch",
      description: "検索ヒットのdocumentIdから本文(1ページ分)を取得する",
      inputSchema: {
        type: "object",
        properties: {
          source,
          documentId: { type: "string" },
          pageCursor: cursor,
        },
        required: ["source", "documentId"],
        additionalProperties: false,
      },
    },
    {
      name: "list",
      description: "ソース内の区画(フォルダ、チャンネル等)を列挙する",
      inputSchema: {
        type: "object",
        properties: { source, containerId: { type: "string" }, cursor },
        required: ["source"],
        additionalProperties: false,
      },
    },
    {
      name: "describe",
      description: "ソースの内容説明・主要区画・対応フィルタを返す",
      inputSchema: {
        type: "object",
        properties: { source },
        required: ["source"],
        additionalProperties: false,
      },
    },
  ];
}

/**
 * 確立済みセッションに束縛されたMCPサーバーを作る。1接続=1セッション。
 * 接続クローズ時にセッション状態を破棄する。
 */
export function createGatewayMcpServer(
  gateway: Gateway,
  session: GatewaySession,
): Server {
  const server = new Server(GATEWAY_SERVER_INFO, {
    capabilities: { tools: {} },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions(gateway.enabledSourceIds()),
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      try {
        const call = parseToolCall(
          request.params.name,
          request.params.arguments,
        );
        const context = parseCallContext(request.params._meta);
        const outcome = await gateway.handleToolCall(session, call, context);
        return {
          content: [{ type: "text", text: JSON.stringify(outcome.result) }],
          structuredContent: outcome.result as unknown as Record<
            string,
            unknown
          >,
        };
      } catch (error) {
        const gatewayError =
          error instanceof GatewayError
            ? error
            : new GatewayError("internal_error", "unexpected error");
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                errorClass: gatewayError.errorClass,
                message: gatewayError.message,
                ...(gatewayError.retryAfterMs !== undefined
                  ? { retryAfterMs: gatewayError.retryAfterMs }
                  : {}),
              }),
            },
          ],
        };
      }
    },
  );

  server.onclose = () => {
    gateway.discardSession(session.sessionId);
  };

  return server;
}
