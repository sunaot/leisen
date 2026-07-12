/**
 * Gatewayプロキシの型定義(T-003)。
 *
 * - MCP自体はエンドユーザーIDを運ばないため、Gatewayはセッション確立時に
 *   本人を確定し(IdpAdapter.authenticate)、以降の全ツール呼び出しを
 *   GatewaySession に束縛する(ADR-001 追補)。
 * - 実行区分(ADR-015)はセッション確立時にOrchestrator側が申告し、
 *   Gatewayが呼び出しごとに deployment.yaml の agentExecution と照合する。
 */
import type {
  FetchResult,
  ListResult,
  SearchFilters,
  SearchOptions,
  SearchResult,
  SourceDescription,
} from "@kp/connector-sdk";
import type { Actor } from "../audit/schema.js";
import type { Identity } from "../idp/types.js";

/** 実行区分(ADR-015)。Phase 1では human_in_the_loop 以外を既定拒否する。 */
export type ExecutionClass = "human_in_the_loop" | "scheduled" | "autonomous";

/**
 * セッション確立時にクライアント(Orchestrator)が申告する属性。
 * 省略時は「人間の対話セッション」(human_in_the_loop / human actor)。
 */
export interface SessionDeclaration {
  executionClass?: ExecutionClass;
  /** 呼び出し主体(ADR-011/015)。agent の場合 onBehalfOfChain 必須 */
  actor?: Actor;
}

/**
 * 認証済みセッション。全ツール呼び出しはこのセッション経由でのみ行える。
 * identity.session.subjectToken は秘密情報(不変条件6): このオブジェクトを
 * シリアライズする経路は必ず redactIdentity() を通す。
 */
export interface GatewaySession {
  readonly sessionId: string;
  readonly identity: Identity;
  readonly executionClass: ExecutionClass;
  readonly actor: Actor;
}

/** ツール呼び出しの監査コンテキスト。Orchestrator(T-007)が申告する。 */
export interface CallContext {
  /** 親のAnswerRun。省略時はセッション既定のrunIdを使う */
  runId?: string;
  /** 探索ループ内の反復連番(0始まり)。省略時はセッション内で自動採番 */
  iteration?: number;
}

/** コネクタツールごとの引数(connector-sdk v0.3のIFに対応)。 */
export type GatewayToolCall =
  | {
      tool: "search";
      sourceId: string;
      query: string;
      filters?: SearchFilters;
      options?: SearchOptions;
    }
  | {
      tool: "fetch";
      sourceId: string;
      documentId: string;
      pageCursor?: string;
    }
  | { tool: "list"; sourceId: string; containerId?: string; cursor?: string }
  | { tool: "describe"; sourceId: string };

export type GatewayToolResult =
  | { tool: "search"; result: SearchResult }
  | { tool: "fetch"; result: FetchResult }
  | { tool: "list"; result: ListResult }
  | { tool: "describe"; result: SourceDescription };

/**
 * Gateway層のエラー分類。監査ログの errorClass(正規化コード、lower
 * snake_case)と一致させる。生の例外メッセージを外へ流さない(TM-A2)。
 * - unauthenticated / source_not_connected / idp_unavailable / misconfigured:
 *   IdP層(IdpErrorClass)から透過
 * - auth_expired / permission_denied / rate_limited / not_found /
 *   source_unavailable / invalid_request: コネクタ(ConnectorErrorClass)から透過
 */
export type GatewayErrorClass =
  // Gateway自身が生成する分類
  | "execution_class_rejected"
  | "unknown_source"
  | "source_disabled"
  | "timeout"
  | "audit_write_failed"
  | "internal_error"
  // IdP層から透過(idp/types.ts IdpErrorClass)
  | "unauthenticated"
  | "source_not_connected"
  | "idp_unavailable"
  | "misconfigured"
  // コネクタから透過(connector-sdk ConnectorErrorClass)
  | "auth_expired"
  | "permission_denied"
  | "rate_limited"
  | "not_found"
  | "source_unavailable"
  | "invalid_request";

export class GatewayError extends Error {
  constructor(
    public readonly errorClass: GatewayErrorClass,
    /** メッセージに秘密情報・文書内容・候補件数を含めないこと(不変条件3/6) */
    message: string,
    /** rate_limited 時の再試行待機ms */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}
