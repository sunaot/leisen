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
} from "@leisen/connector-sdk";
import type { Actor } from "@leisen/audit";
import type { Identity } from "../idp/types.js";

/** 実行区分(ADR-015)。Phase 1では human_in_the_loop 以外を既定拒否する。 */
export type ExecutionClass = "human_in_the_loop" | "scheduled" | "autonomous";

/** 実行区分 → deployment.yaml の agentExecution のキー。 */
export const EXECUTION_CLASS_CONFIG_KEY = {
  human_in_the_loop: "humanInTheLoop",
  scheduled: "scheduled",
  autonomous: "autonomous",
} as const satisfies Record<ExecutionClass, "humanInTheLoop" | "scheduled" | "autonomous">;

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
  /**
   * 旧キー(裸の `runId`)または in-process の呼び出し元が申告した runId。不正値は未申告
   * として扱い、呼び出し単位の新規 runId(単発 run)で記録する(ADR-011 追記)
   */
  runId?: string;
  /**
   * 探索ループ内の反復連番(0始まり)。runId と組でのみ意味を持つ:
   * runId 申告時に省略すれば 0、runId 未申告(単発run)なら常に 0
   */
  iteration?: number;
  /**
   * 名前空間付きのキー(`io.github.sunaot.leisen/runId`)で申告された runId(ADR-019 決定4)。
   * Gateway が発行した署名付きの値で、本人・actor・期限を満たし、呼び出し元が Orchestrator の
   * 資格情報を提示していなければ、その呼び出しを固定文言で拒否し `invalid_run_id` の単発 run
   * として記録する(申告値は記録しない)。runId(旧キー)より優先する
   */
  declaredRunId?: unknown;
  /** HTTP 層が Orchestrator の資格情報(共有秘密)を検証済みか。declaredRunId の受理に必要 */
  orchestratorVerified?: boolean;
}

/** コネクタツールごとの引数(connector-sdk v0.4のIFに対応)。 */
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
 * - not_available: LLM/利用者向け正規化(TM-B2、tools.ts normalizeToolError)のみで
 *   生成される。permission_denied と not_found を区別せずに返すための分類で、
 *   監査レコードの errorClass には元の分類(permission_denied / not_found)が残る
 * - private_scope_excluded: 方針(privateScopes: excluded)によるプライベート領域の
 *   拒否(ADR-016 追補2 決定4)。Gateway の強制(fetch)またはコネクタ(enforced)が
 *   生成する。LLM・利用者には固定文言(PRIVATE_SCOPE_EXCLUDED_MESSAGE)だけを返す
 */
export type GatewayErrorClass =
  // Gateway自身が生成する分類
  | "execution_class_rejected"
  | "unknown_source"
  | "source_disabled"
  | "timeout"
  | "audit_write_failed"
  | "internal_error"
  // run API(ADR-019): 名前空間付きで申告された runId が形式・署名・本人・actor・期限の
  // どれかを満たさない、または Orchestrator の資格情報なしで申告された(TM-I5)
  | "invalid_run_id"
  // run API: 呼び出し元が Orchestrator であることの資格情報が欠落・不一致
  | "orchestrator_credential_invalid"
  // run API: リクエスト本文が上限を超えた
  | "payload_too_large"
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
  | "invalid_request"
  // 方針の強制(ADR-016 追補2 決定4)。Gateway の射影またはコネクタ(enforced)から
  | "private_scope_excluded"
  // LLM/利用者向け正規化(TM-B2)のみで生成される。監査レコードの errorClass には
  // 元の分類(permission_denied / not_found)が残る(gateway.ts は正規化前に記録する)
  | "not_available";

/**
 * GatewayがJSON-RPCエラーとして拒否を返すときのコード(HTTP層の拒否、
 * ツール一覧の拒否)。JSON-RPCの実装定義サーバーエラー範囲(仕様2026-07-28版
 * でも -32000〜-32019 は実装定義)で、SDKのHTTP層拒否と同じ値。分類は
 * data.errorClass(GatewayErrorClass)で返す。
 */
export const GATEWAY_REJECTION_ERROR_CODE = -32000;

/**
 * private_scope_excluded の固定文言(ADR-016 追補2 決定4)。コネクタ由来の文言
 * (会話の種別・チャンネル名等を含みうる)は LLM・利用者に返さない。
 */
export const PRIVATE_SCOPE_EXCLUDED_MESSAGE =
  "the requested document is in a private scope (DMs, private channels, personal space) that this deployment excludes from search";

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
