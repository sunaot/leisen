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

export type GatewayCallOutcome =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: GatewayToolError };

export interface GatewayCallOptions {
  /** 中断用シグナル(run の時間上限)。中断時は GatewayClientError("aborted") */
  readonly signal?: AbortSignal;
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
  close(): Promise<void>;
}
