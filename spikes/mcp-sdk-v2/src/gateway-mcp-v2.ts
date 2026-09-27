/**
 * [スパイク] packages/gateway/src/proxy/mcp.ts を MCP TypeScript SDK v2(2.1.0)へ
 * 移植したもの。本流には入れない(docs/spikes/mcp-sdk-v2-migration-spike.md)。
 * 元ファイルとの差分が移行コストの実測値になるよう、SDK依存部以外は原文のまま。
 *
 * v1版からの変更点(ADR-001追補3 決定1〜5 に沿う):
 * - import を @modelcontextprotocol/server に変更。ハンドラ登録はメソッド名文字列
 * - サーバーはユーザー状態を持たない(決定2)。利用者は HTTP 入口(http.ts)が
 *   毎リクエストの Authorization から解決し、ctx.http.authInfo 経由で受け取る(決定1)
 * - runId / iteration は prefix 付き _meta キーで受ける(決定3・4)
 * - tools/list のキャッシュヒントを cacheHints で宣言する(決定5。2026-07-28版の
 *   応答にのみSDKが付与し、2025年版の応答には付かない)
 *
 * ツール結果のエラーにはGatewayの正規化エラー(errorClass)のみを返し、
 * 生の例外メッセージ・スタックトレースを流さない(TM-A2)。
 */
import {
  Server,
  type CallToolResult,
  type ServerContext,
  type Tool,
} from "@modelcontextprotocol/server";
import type { SearchFilters, SearchOptions } from "@kp/connector-sdk";
import { z } from "zod";
import type { Gateway } from "../../../packages/gateway/src/proxy/gateway.js";
import {
  GatewayError,
  type CallContext,
  type GatewaySession,
  type GatewayToolCall,
} from "../../../packages/gateway/src/proxy/types.js";

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

/** _meta 独自キー(ADR-001追補3 決定4。prefix は暫定、最終確定はT-013)。 */
export const META_RUN_ID = "io.github.sunaot.leisen/runId";
export const META_ITERATION = "io.github.sunaot.leisen/iteration";

/** Orchestrator(T-007)がrunId/iterationを申告するための_meta(ADR-011、決定3・4)。 */
const callMetaSchema = z.looseObject({
  [META_RUN_ID]: z.string().min(1).optional(),
  [META_ITERATION]: z.number().int().min(0).optional(),
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
  const runId = parsed.data[META_RUN_ID];
  const iteration = parsed.data[META_ITERATION];
  return {
    ...(runId !== undefined ? { runId } : {}),
    ...(iteration !== undefined ? { iteration } : {}),
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

/** HTTP入口が確立済みセッションを authInfo.extra に載せるキー(http.ts)。 */
export const GATEWAY_SESSION_EXTRA_KEY = "gatewaySession";

/**
 * HTTP入口(http.ts)が毎リクエスト解決したセッションを取り出す。authInfo は
 * SDK が素通しするだけで、ヘッダから自分で作ることはない。
 */
function sessionFromContext(ctx: ServerContext): GatewaySession {
  const candidate = ctx.http?.authInfo?.extra?.[GATEWAY_SESSION_EXTRA_KEY];
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "sessionId" in candidate &&
    "identity" in candidate
  ) {
    return candidate as GatewaySession;
  }
  throw new GatewayError("unauthenticated", "no authenticated session");
}

export interface GatewayMcpServerOptions {
  /** tools/list の ttlMs(決定5。deployment.yaml から注入、既定 300000) */
  readonly toolsListTtlMs: number;
}

/**
 * ユーザー状態を持たないMCPサーバーを作る(決定2)。createMcpHandler の
 * ファクトリとしてリクエストごとに呼ばれる。
 */
export function createGatewayMcpServer(
  gateway: Gateway,
  options: GatewayMcpServerOptions,
): Server {
  const server = new Server(GATEWAY_SERVER_INFO, {
    capabilities: { tools: {} },
    // 決定5: cacheScope は "private" 固定
    cacheHints: {
      "tools/list": { ttlMs: options.toolsListTtlMs, cacheScope: "private" },
    },
  });

  server.setRequestHandler("tools/list", async () => ({
    tools: toolDefinitions(gateway.enabledSourceIds()),
  }));

  server.setRequestHandler(
    "tools/call",
    async (request, ctx): Promise<CallToolResult> => {
      try {
        const session = sessionFromContext(ctx);
        const call = parseToolCall(
          request.params.name,
          request.params.arguments,
        );
        const context = parseCallContext(ctx.mcpReq._meta);
        const outcome = await gateway.handleToolCall(session, call, context);
        // 低水準 Server のハンドラは era 別の射影を自分で通す(v2 の作法)。
        // structuredContent がオブジェクトの場合はどちらの era でも恒等
        return server.projectCallToolResult(
          {
            content: [{ type: "text", text: JSON.stringify(outcome.result) }],
            structuredContent: outcome.result as unknown as Record<
              string,
              unknown
            >,
          },
          undefined,
        );
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

  // 決定1: server.onclose によるセッション破棄前提は撤回(破棄は http.ts がリクエスト単位で行う)
  return server;
}
