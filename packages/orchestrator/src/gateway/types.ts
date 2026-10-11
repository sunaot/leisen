/**
 * Gateway クライアントの抽象(T-007)。
 *
 * Orchestrator はデータソースへ直接アクセスせず、必ず Gateway の4ツール
 * (search / fetch / list / describe)を経由する(不変条件2)。認可・監査
 * (ToolInvocation)・レート制御は Gateway 側で強制される(threat-model TB2:
 * Orchestrator は信頼しない配置)。この IF は SDK 非依存で、実装は
 * McpGatewayClient(MCP Streamable HTTP)。
 */

/** Gateway が tools/list で返すツール定義(MCP の Tool のうち使う部分)。 */
export interface GatewayToolSchema {
  readonly name: string;
  readonly description?: string | undefined;
  /** JSON Schema(type: object) */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/**
 * ツール結果として返る正規化エラー(Gateway の NormalizedToolError と同形)。
 * errorClass は Gateway の分類(source_not_connected / rate_limited / ...)。
 */
export interface GatewayToolError {
  readonly errorClass: string;
  readonly message: string;
  /** rate_limited 時の再試行待機ms */
  readonly retryAfterMs?: number;
}

/**
 * tools/call の結果。userId は Gateway がそのリクエストで認証した利用者(結果の `_meta`、
 * gateway/meta.ts の gatewayUserIdFromResultMeta)。Gateway が報告しなければ undefined。
 * Orchestrator は AnswerRun の主体をこの値に束縛する(セキュリティレビュー H1)。
 */
export type GatewayCallOutcome =
  | { readonly ok: true; readonly result: unknown; readonly userId?: string }
  | {
      readonly ok: false;
      readonly error: GatewayToolError;
      readonly userId?: string;
    };

export interface GatewayCallOptions {
  /** 中断用シグナル(run の時間上限)。中断時は GatewayClientError("aborted") */
  readonly signal?: AbortSignal;
}

/** `POST /runs` の結果(ADR-019 決定3・4)。 */
export interface StartRunResult {
  /** Gateway が発行した署名付き runId(以降の tools/call の `_meta`・finish・feedback に使う) */
  readonly runId: string;
  /** tools/call・finish を受ける期限(ISO 8601) */
  readonly expiresAt: string;
  /** feedback を受ける期限(ISO 8601) */
  readonly feedbackUntil: string;
}

/** `POST /runs/{runId}/finish` の申告(ADR-019 決定3)。 */
export interface FinishRunInput {
  readonly outcome: "resolved" | "unresolved" | "error";
  /** 0..1(error のときは Gateway が null にする) */
  readonly confidence: number | null;
  readonly searchedSources: readonly string[];
  /** 検証済みの出典(sourceId とコネクタ内の documentId。Gateway が記録の規則をかける) */
  readonly citations: readonly { readonly sourceId: string; readonly documentId: string }[];
  /** 正規化コード(lower snake_case)のみ。resolved なら null */
  readonly failureReason: string | null;
}

export interface GatewayClient {
  /** ツール定義の一覧。トランスポート層の失敗は GatewayClientError */
  listTools(options?: GatewayCallOptions): Promise<readonly GatewayToolSchema[]>;
  /**
   * ツールを1回呼ぶ。ツール結果のエラー(isError)は { ok: false } で返し、
   * トランスポート層の失敗(認証拒否・接続不能・タイムアウト)は GatewayClientError を投げる。
   * meta はリクエストの `_meta`(prefix 付きキーの runId / iteration / 実行区分 / actor。
   * buildGatewayMeta で組み立てる)。
   */
  callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    meta: Readonly<Record<string, unknown>>,
    options?: GatewayCallOptions,
  ): Promise<GatewayCallOutcome>;
  /**
   * run の開始を Gateway に申告し、署名付き runId を受け取る(run API、ADR-019 決定3)。
   * Gateway は生クエリ表と pending の AnswerRun を書く。失敗は GatewayClientError
   * (unauthenticated / orchestrator_credential_rejected / rate_limited / audit_write_failed /
   * gateway_unavailable 等)。失敗したら LLM を呼ばない(呼び出し側)
   */
  startRun(input: { readonly question: string }, options?: GatewayCallOptions): Promise<StartRunResult>;
  /**
   * run の終了を申告する(answer_run_finish)。失敗は GatewayClientError(run_not_accepted /
   * audit_write_failed 等)。失敗したら回答を返さない(呼び出し側、fail-closed)
   */
  finishRun(runId: string, input: FinishRunInput, options?: GatewayCallOptions): Promise<void>;
  /** 利用者フィードバックを申告する(answer_run_feedback)。本人・期間は Gateway が runId の署名で検証する */
  feedbackRun(
    runId: string,
    outcome: "resolved" | "unresolved",
    options?: GatewayCallOptions,
  ): Promise<void>;
  close(): Promise<void>;
}
