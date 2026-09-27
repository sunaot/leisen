/**
 * LLM クライアントの薄い抽象(T-007、ADR-017 決定1)。
 *
 * 探索ループ(orchestrator.ts)はこの IF だけに依存し、実装を差し替えられる:
 * - AnthropicLlmClient(anthropic.ts): 公式 SDK で Claude API を呼ぶ本番実装
 * - ScriptedLlmClient(scripted.ts): 脚本で応答を返すテスト用実装(ネットワーク不要)
 *
 * メッセージ・ツール・応答の型は SDK の型(Anthropic.MessageParam / Anthropic.Tool /
 * Anthropic.Message)をそのまま使い、同等の型を自前定義しない。
 */
import type Anthropic from "@anthropic-ai/sdk";

/** 1ターン分の要求。モデル・effort・再試行などは実装側の設定で決める。 */
export interface LlmRequest {
  /**
   * system prompt。固定部(バージョン管理されたプロンプト)を先頭に、ソース一覧などの
   * 可変部を末尾に置く(プロンプトキャッシュの prefix 安定性)。
   */
  readonly system: readonly Anthropic.TextBlockParam[];
  /** 会話履歴。追記のみで編集しない(preserved thinking / キャッシュのため) */
  readonly messages: readonly Anthropic.MessageParam[];
  readonly tools: readonly Anthropic.Tool[];
  /** max_tokens(adaptive thinking の思考分を含む上限) */
  readonly maxTokens: number;
}

export interface LlmCallOptions {
  /** 中断用シグナル(run の時間上限)。中断時は LlmError("llm_aborted") で失敗する */
  readonly signal?: AbortSignal;
}

/** 課金単位の使用量(費用概算用)。 */
export interface LlmAttemptUsage {
  /** 実際に処理したモデル(価格表のキー) */
  readonly model: string;
  /** キャッシュ対象外の入力トークン(usage.input_tokens) */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

/** LLM の1ターンの応答。 */
export interface LlmTurn {
  /** 応答メッセージ(SDK の非 beta 型) */
  readonly message: Anthropic.Message;
  /**
   * 課金単位の使用量。省略時は message.usage を message.model の単価で数える。
   * server-side fallbacks 有効時は usage.iterations から試行ごとに入れる
   * (辞退した試行の課金も含めるため)。
   */
  readonly attempts?: readonly LlmAttemptUsage[];
}

export interface LlmClient {
  /**
   * 1ターン分の応答を返す。stop_reason が refusal / max_tokens / pause_turn 等で
   * 続行できない応答は LlmError として失敗させる(実装側で明示的に扱う)。
   */
  complete(request: LlmRequest, options?: LlmCallOptions): Promise<LlmTurn>;
}

/** 課金単位の使用量を取り出す(attempts 省略時は message.usage から作る)。 */
export function attemptsOf(turn: LlmTurn): readonly LlmAttemptUsage[] {
  if (turn.attempts !== undefined) {
    return turn.attempts;
  }
  const usage = turn.message.usage;
  return [
    {
      model: turn.message.model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    },
  ];
}
