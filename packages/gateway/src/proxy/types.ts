/**
 * Gatewayプロキシの型定義(T-003)。
 *
 * - MCP自体はエンドユーザーIDを運ばないため、Gatewayは**リクエストごとに**
 *   Bearerセッショントークンを検証して本人を確定し(IdpAdapter.authenticate)、
 *   そのリクエストのツール呼び出しをリクエスト単位の GatewaySession に束縛する
 *   (ADR-001 追補3 決定1)。接続・サーバーインスタンスにユーザー状態を
 *   持たせない(決定2)。旧設計の「1接続=1セッション」(追補2)は撤回済み。
 * - 実行区分・actor(ADR-015)はOrchestratorがリクエストごとに `_meta` で申告し
 *   (meta.ts)、Gatewayが呼び出しごとに deployment.yaml の agentExecution と照合する。
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
 * リクエストごとにクライアント(Orchestrator)が申告する属性。MCP経由では
 * `_meta` の `io.github.sunaot.leisen/executionClass` / `.../actor` で申告する
 * (meta.ts)。省略時は「人間の対話セッション」(human_in_the_loop / human actor)。
 */
export interface SessionDeclaration {
  executionClass?: ExecutionClass;
  /** 呼び出し主体(ADR-011/015)。agent の場合 onBehalfOfChain 必須 */
  actor?: Actor;
}

/**
 * リクエスト単位の認証済みセッション(ADR-001 追補3 決定1)。1回のMCP
 * リクエストの処理中だけ存在し、Gatewayはこれを保持・再利用しない
 * (接続やサーバーインスタンスに束縛しない。セッションIDも持たない)。
 * 全ツール呼び出しはこのセッション経由でのみ行える。
 * identity.session.subjectToken は秘密情報(不変条件6): このオブジェクトを
 * シリアライズする経路は必ず redactIdentity() を通す。
 */
export interface GatewaySession {
  readonly identity: Identity;
  readonly executionClass: ExecutionClass;
  readonly actor: Actor;
}

/**
 * ツール呼び出しの監査コンテキスト。採番主体はOrchestrator(T-007)で、
 * `_meta` で申告する(ADR-011 追記 2026-09-17)。Gatewayは呼び出しをまたぐ
 * 採番状態を持たない。
 */
export interface CallContext {
  /** 親のAnswerRun。未申告なら呼び出し単位の新規runId(単発run) */
  runId?: string;
  /**
   * 探索ループ内の反復連番(0始まり)。runId と組でのみ意味を持つ:
   * runId 申告時に省略すれば 0、runId 未申告(単発run)なら常に 0
   */
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

/**
 * GatewayがJSON-RPCエラーとして拒否を返すときのコード(HTTP層の拒否、
 * ツール一覧の拒否)。JSON-RPCの実装定義サーバーエラー範囲(仕様2026-07-28版
 * でも -32000〜-32019 は実装定義)で、SDKのHTTP層拒否と同じ値。分類は
 * data.errorClass(GatewayErrorClass)で返す。
 */
export const GATEWAY_REJECTION_ERROR_CODE = -32000;

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
