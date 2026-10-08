/**
 * LLM バックエンドの薄い抽象(T-007、ADR-017 決定1)。
 *
 * LLM バックエンドは設定で選ぶプラグイン境界。探索ループ(orchestrator.ts)はこの IF
 * だけに依存し、実装を差し替えられる:
 * - AnthropicLlmClient(anthropic.ts): 公式 SDK で Anthropic Messages API を呼ぶ
 * - OpenAiCompatibleLlmClient(openai-compatible.ts): OpenAI 互換 Chat Completions
 *   (LM Studio / vLLM / llama.cpp server / Ollama 等)を fetch で呼ぶ
 * - ScriptedLlmClient(scripted.ts): 脚本で応答を返すテスト用実装(ネットワーク不要)
 *
 * 会話の内部表現は Anthropic SDK の型(Anthropic.MessageParam / Anthropic.Tool /
 * Anthropic.Message)をそのまま使い、同等の型を自前定義しない。他形式のバックエンドは
 * 実装側でこの表現と相互に変換する。バックエンドの差は能力フラグ(LlmCapabilities)で
 * 吸収し、Orchestrator は対応している機能だけを要求に付ける。
 */
import type Anthropic from "@anthropic-ai/sdk";

/** LLM バックエンドの種類(設定の provider。価格表の第1キーでもある)。 */
export const LLM_PROVIDERS = ["anthropic", "openai_compatible"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/**
 * バックエンドの能力フラグ。Orchestrator はこれを見て、対応している機能だけを要求に付ける
 * (strict のツール定義・思考・推論の深さの制御・キャッシュのブレークポイント)。
 */
export interface LlmCapabilities {
  /**
   * ツール定義の strict(引数がスキーマに適合することの保証)に対応するか。false なら
   * strict を付けない。その場合も引数は Orchestrator(submit_answer)と Gateway(zod)が検証する
   */
  readonly strictTools: boolean;
  /**
   * 思考の要求方式。"adaptive" なら要求に thinking: "adaptive" を付ける。"none" は思考を
   * 要求しない(モデルが内部で推論していても関知しない)
   */
  readonly thinking: "adaptive" | "none";
  /**
   * 推論の深さの制御(Anthropic: output_config.effort / OpenAI 互換: reasoning_effort)を
   * 送れるか。段階の値はバックエンドの設定で決まる(対応する段階がバックエンドごとに違うため)
   */
  readonly effort: boolean;
  /**
   * 1応答で複数のツール呼び出しを返しうるか。参照用: Orchestrator は並列の有無に関わらず
   * 応答内の全呼び出しを処理する
   */
  readonly parallelToolCalls: boolean;
  /** 明示のキャッシュブレークポイント(cache_control)に対応するか。false なら system に付けない */
  readonly promptCaching: boolean;
  /** コンテキスト長(トークン)。設定で分かる場合のみ。参照用(上限判定には使っていない) */
  readonly maxContextTokens?: number;
}

/**
 * 1ターン分の要求。モデル・effort の段階・再試行などは実装側の設定で決める。
 * Orchestrator は正準形(strict のツール定義・キャッシュのブレークポイント付き)を組み、
 * adaptRequestToCapabilities(capabilities.ts)でバックエンドの能力に合わせてから渡す。
 */
export interface LlmRequest {
  /**
   * system prompt(バージョン管理された固定部。run ごとに変わるソース一覧・上限・質問は
   * 最初の user ターンに入る)。cache_control は capabilities.promptCaching のときだけ付く
   */
  readonly system: readonly Anthropic.TextBlockParam[];
  /** 会話履歴。追記のみで編集しない(preserved thinking / キャッシュのため) */
  readonly messages: readonly Anthropic.MessageParam[];
  /** ツール定義。strict: true は capabilities.strictTools のときだけ付く */
  readonly tools: readonly Anthropic.Tool[];
  /** max_tokens(思考分を含む上限) */
  readonly maxTokens: number;
  /**
   * 思考の要求。capabilities.thinking が "adaptive" のときだけ Orchestrator が付ける。
   * 省略時は thinking パラメータを送らない
   */
  readonly thinking?: "adaptive";
  /**
   * 推論の深さの制御を付けるか(値はバックエンドの設定)。capabilities.effort のときだけ
   * Orchestrator が true にする。省略時・false は送らない
   */
  readonly effort?: boolean;
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
  /**
   * 応答が使用量(usage)を返さなかった。トークン数は 0 として数えるが、費用は
   * 「不明」扱いにする(0 とみなして費用上限をすり抜けさせない)
   */
  readonly usageMissing?: boolean;
}

/** LLM の1ターンの応答。 */
export interface LlmTurn {
  /** 応答メッセージ(SDK の非 beta 型。他形式のバックエンドはこの型へ変換して返す) */
  readonly message: Anthropic.Message;
  /**
   * 課金単位の使用量。省略時は message.usage を message.model の単価で数える。
   * server-side fallbacks 有効時は usage.iterations から試行ごとに入れる
   * (辞退した試行の課金も含めるため)。
   */
  readonly attempts?: readonly LlmAttemptUsage[];
  /**
   * 引数を解釈できなかった tool_use の id(OpenAI 互換で function.arguments が JSON
   * オブジェクトとして読めなかった場合など。観測・テスト用)。該当ブロックの input は
   * null(オブジェクトでない値)にしてある。Orchestrator の引数検査がこれを不正な入力として
   * 扱い、Gateway に送らずに is_error の tool_result(invalid_request)を返す
   * (submit_answer なら不正な提出)。履歴を他形式に戻すときは空オブジェクトとして送る
   */
  readonly invalidToolUseIds?: readonly string[];
}

export interface LlmClient {
  /** バックエンドの種類(価格表の引き当てに使う) */
  readonly provider: LlmProvider;
  /** 対応している機能(Orchestrator が要求に付けるものを決める) */
  readonly capabilities: LlmCapabilities;
  /**
   * 1ターン分の応答を返す。stop_reason が refusal / max_tokens / pause_turn 等で
   * 続行できない応答は LlmError として失敗させる(実装側で明示的に扱う)。
   * 失敗はすべて LlmError に正規化する。
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
