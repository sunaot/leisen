/**
 * MCPツール面のSDK非依存ロジック(T-003)。
 *
 * MCP SDK(プロトコル層)に触れない処理をここに置く: ツール定義(JSON Schema)、
 * ツール引数の検証、リクエスト単位セッションの組み立て(検証済みIdentityと
 * `_meta` の申告、ADR-001 追補3)、Gatewayコア(監査・認証注入)への委譲、
 * エラーの正規化。SDKとの接合(Server生成・ハンドラ登録・AuthInfo・結果の形)は
 * mcp.ts、トランスポートは http.ts に閉じ込め、SDKの差し替え(v1系 → 仕様
 * 2026-07-28版対応のv2系)の手戻りをそこだけに限定する。
 */
import type { SearchFilters, SearchOptions } from "@kp/connector-sdk";
import { z } from "zod";
import type { Identity } from "../idp/types.js";
import type { Gateway } from "./gateway.js";
import { callContextFromMeta, declarationFromMeta } from "./meta.js";
import { bindSession } from "./session.js";
import {
  GatewayError,
  type GatewayErrorClass,
  type GatewayToolCall,
  type GatewayToolResult,
} from "./types.js";

/** MCPツール定義(SDK非依存のJSON Schema表現)。 */
export interface GatewayToolDefinition {
  name: GatewayToolCall["tool"];
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, object>;
    required: string[];
    additionalProperties: false;
  };
}

/** ツール結果・拒否で返す正規化エラー(生の例外メッセージを流さない、TM-A2)。 */
export interface NormalizedToolError {
  readonly errorClass: GatewayErrorClass;
  readonly message: string;
  /** rate_limited 時の再試行待機ms */
  readonly retryAfterMs?: number;
}

export type ToolCallOutcome =
  | { readonly ok: true; readonly result: GatewayToolResult["result"] }
  | { readonly ok: false; readonly error: NormalizedToolError };

export type ToolListOutcome =
  | { readonly ok: true; readonly tools: GatewayToolDefinition[] }
  | { readonly ok: false; readonly error: NormalizedToolError };

/** トランスポートから届いた1回の tools/call(SDKの型に依存しない形)。 */
export interface ToolCallRequest {
  /** トランスポート層が検証済みの利用者。なければ fail-closed で拒否する */
  readonly identity: Identity | undefined;
  readonly name: string;
  readonly arguments: unknown;
  /** リクエストの `_meta`(meta.ts が解釈する) */
  readonly meta: unknown;
}

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

/** ツール名と引数を検証し、Gatewayコアの呼び出し形に変換する。 */
export function parseToolCall(name: string, args: unknown): GatewayToolCall {
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

/**
 * ツール定義。有効ソースをenumとしてスキーマに自己記述させ、Orchestratorの
 * ソース選択を助ける(ADR-001の採用理由)。ソースの内容説明は describe ツールが返す。
 * 引数は deployment.yaml 由来の有効ソースのみで、利用者に依存させない(listTools)。
 */
export function toolDefinitions(
  sourceIds: readonly string[],
): GatewayToolDefinition[] {
  const source =
    sourceIds.length > 0
      ? { type: "string", enum: [...sourceIds] }
      : { type: "string" };
  const cursor = { type: "string" };
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
 * 例外を正規化エラーへ写す。GatewayError(IdP・コネクタ由来を含め各層の規約で
 * 秘密情報を含まない)以外はメッセージを流さない(TM-A2)。
 */
export function normalizeToolError(error: unknown): NormalizedToolError {
  const gatewayError =
    error instanceof GatewayError
      ? error
      : new GatewayError("internal_error", "unexpected error");
  return {
    errorClass: gatewayError.errorClass,
    message: gatewayError.message,
    ...(gatewayError.retryAfterMs !== undefined
      ? { retryAfterMs: gatewayError.retryAfterMs }
      : {}),
  };
}

const UNAUTHENTICATED: NormalizedToolError = {
  errorClass: "unauthenticated",
  message: "request carries no verified identity",
};

/**
 * tools/list(ADR-001 追補3 決定5、ADR-012): 内容はユーザー・接続に依存しない。
 * 有効ソースは deployment.yaml 由来のみで、利用者ごとに絞り込まない(ソースの
 * 可視性で認可状態を漏らさない)。identity は内容に使わず、検証済みアイデンティティ
 * のないリクエストにツールスキーマを返さないためだけに見る(防御的既定。HTTP層が
 * ディスパッチ前に拒否するため通常は到達しない、誤配線への防波堤)。
 * 仕様2026-07-28版で必須の ttlMs / cacheScope("private" 固定、ttlMs は
 * deployment.yaml 注入)はSDK未対応のため保留(SDK対応待ち)。
 */
export function listTools(
  gateway: Gateway,
  identity: Identity | undefined,
): ToolListOutcome {
  if (identity === undefined) {
    return { ok: false, error: UNAUTHENTICATED };
  }
  return { ok: true, tools: toolDefinitions(gateway.enabledSourceIds()) };
}

/**
 * 1回の tools/call を処理する: 検証済みIdentity(なければ fail-closed)と
 * `_meta` の申告からリクエスト単位の GatewaySession を作り、ツール引数を検証して
 * Gatewayコアへ委譲する。失敗はすべて正規化エラーとして返す。
 *
 * 既知の限界(T-003セキュリティレビュー minor-1): 監査レコードを残すのは
 * Gatewayコア(handleToolCall)に入った呼び出しのみ(実行区分照合以降。区分・
 * ソース・レート制御の拒否も1レコード残る)。その手前で止まる次の拒否は
 * 監査対象外とする:
 * - HTTP層の拒否(Authorization欠落・不正、IdP不達、405等。http.ts)
 * - Identity のないリクエスト、`_meta` の申告不正、ツール引数の不正
 * いずれもソースアクセスは発生しておらず(不変条件2の範囲外)、ADR-011の
 * 監査対象は「ツール呼び出し」とする。試行レベルの記録(認証失敗の記録を
 * 含む)が必要になったらADR-011を改訂してから追加する。
 */
export async function runToolCall(
  gateway: Gateway,
  request: ToolCallRequest,
): Promise<ToolCallOutcome> {
  if (request.identity === undefined) {
    return { ok: false, error: UNAUTHENTICATED };
  }
  try {
    const session = bindSession(
      request.identity,
      declarationFromMeta(request.meta),
    );
    const call = parseToolCall(request.name, request.arguments);
    const outcome = await gateway.handleToolCall(
      session,
      call,
      callContextFromMeta(request.meta),
    );
    return { ok: true, result: outcome.result };
  } catch (error) {
    return { ok: false, error: normalizeToolError(error) };
  }
}
