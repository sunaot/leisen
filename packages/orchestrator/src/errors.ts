/**
 * Orchestrator の正規化エラー(T-007)。
 *
 * 分類コードは監査レコードの failureReason / errorClass と同じ規約(lower
 * snake_case、`^[a-z][a-z0-9_.]{0,63}$`)に揃える。メッセージは固定文言のみとし、
 * SDK・Gateway・下流の生の例外メッセージを載せない(TM-A2)。セッショントークン・
 * API キーは classifier の入力に来ても、メッセージ・プロパティのどちらにも
 * 写さない(不変条件6)。
 */

/** LLM 呼び出しの正規化分類(AnthropicLlmClient / ScriptedLlmClient が投げる)。 */
export type LlmErrorClass =
  /** Claude API の資格情報が解決できない(ANTHROPIC_API_KEY 等が無い) */
  | "llm_credentials_missing"
  /** 資格情報はあるが API が 401 で拒否した */
  | "llm_authentication_failed"
  /** 403(組織・ワークスペースの権限) */
  | "llm_permission_denied"
  /** 429(SDK の再試行後も解消しない) */
  | "llm_rate_limited"
  /** 529 overloaded_error */
  | "llm_overloaded"
  /** 5xx・409・接続失敗(SDK の再試行後も解消しない) */
  | "llm_unavailable"
  /** SDK のリクエストタイムアウト */
  | "llm_timeout"
  /** 呼び出し側の AbortSignal による中断(run の時間上限など) */
  | "llm_aborted"
  /** 400 / 404 / 422、または prefill を含むリクエスト */
  | "llm_invalid_request"
  /** stop_reason: refusal(安全分類器またはモデル自身の辞退) */
  | "llm_refusal"
  /** stop_reason: max_tokens(出力・ツール入力が途中で切れている) */
  | "llm_max_tokens"
  /** stop_reason: pause_turn(サーバーツールを使わない本構成では想定外) */
  | "llm_pause_turn"
  /** stop_reason: model_context_window_exceeded */
  | "llm_context_window_exceeded"
  /** 応答の形が想定外(stop_reason 欠落、未知のブロック型など) */
  | "llm_unexpected_response"
  /** 上記に当たらない SDK・クライアント側の失敗 */
  | "llm_client_error";

export class LlmError extends Error {
  constructor(
    public readonly errorClass: LlmErrorClass,
    /** 固定文言のみ。SDK の例外メッセージ・API キー・応答本文を含めない */
    message: string,
    /** refusal のカテゴリ(stop_details.category。秘密情報ではない) */
    public readonly refusalCategory?: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** Gateway との通信(MCP トランスポート)の正規化分類。ツール結果のエラーとは別。 */
export type GatewayClientErrorClass =
  /** HTTP 401: セッショントークンが無効・失効 */
  | "unauthenticated"
  /** 接続不能・5xx・429 など、Gateway に到達できない/応答できない */
  | "gateway_unavailable"
  /** MCP リクエストのタイムアウト */
  | "gateway_timeout"
  /** MCP として解釈できない応答、エンドポイント・パスの誤り */
  | "gateway_protocol_error"
  /** 上記以外で Gateway が要求を拒否した */
  | "gateway_rejected"
  /** 呼び出し側の AbortSignal による中断 */
  | "aborted";

export class GatewayClientError extends Error {
  constructor(
    public readonly errorClass: GatewayClientErrorClass,
    /** 固定文言のみ。トークン・URL のクエリ・SDK の例外メッセージを含めない */
    message: string,
  ) {
    super(message);
    this.name = "GatewayClientError";
  }
}

/** Orchestrator の API 利用側に返す分類(run の結果ではなく呼び出し自体の失敗)。 */
export type OrchestratorErrorClass =
  /** 質問・userId の欠落や過大 */
  | "invalid_input"
  /** AnswerRun を監査ストアへ書けない(fail-closed、ADR-011 §4) */
  | "audit_write_failed"
  /** recordFeedback の対象 run が見つからない(未完了・保持上限超過を含む) */
  | "run_not_found"
  /** recordFeedback の利用者が run の利用者と一致しない */
  | "feedback_forbidden";

export class OrchestratorError extends Error {
  constructor(
    public readonly errorClass: OrchestratorErrorClass,
    message: string,
  ) {
    super(message);
    this.name = "OrchestratorError";
  }
}
