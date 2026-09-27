/**
 * LLM 費用の概算(T-007、costLimitPerQuery の判定用)。
 *
 * usage のトークン数 × 価格表(config.ts、設定注入)で概算する。価格表にない
 * モデルの分は概算できない(unknownModels に入れ、呼び出し側が警告・上限判定する)。
 * 課金の正は Anthropic の請求であり、ここの値は上限判定と表示のための近似。
 */
import type { ModelPrice } from "./config.js";
import type { LlmAttemptUsage } from "./llm/types.js";

const PER_MILLION = 1_000_000;

/** 1試行分の費用。価格表にないモデルなら undefined。 */
export function attemptCost(
  attempt: LlmAttemptUsage,
  pricing: Readonly<Record<string, ModelPrice>>,
): number | undefined {
  const price = pricing[attempt.model];
  if (price === undefined) {
    return undefined;
  }
  return (
    (attempt.inputTokens * price.inputPerMTok +
      attempt.outputTokens * price.outputPerMTok +
      attempt.cacheCreationInputTokens * price.cacheWritePerMTok +
      attempt.cacheReadInputTokens * price.cacheReadPerMTok) /
    PER_MILLION
  );
}

/** run 全体の使用量と概算費用の累計。 */
export class UsageMeter {
  inputTokens = 0;
  outputTokens = 0;
  llmTurns = 0;
  /** 価格表で概算できた分の累計 */
  #knownCost = 0;
  readonly #unknownModels = new Set<string>();

  constructor(private readonly pricing: Readonly<Record<string, ModelPrice>>) {}

  add(attempts: readonly LlmAttemptUsage[]): void {
    this.llmTurns += 1;
    for (const attempt of attempts) {
      this.inputTokens +=
        attempt.inputTokens +
        attempt.cacheCreationInputTokens +
        attempt.cacheReadInputTokens;
      this.outputTokens += attempt.outputTokens;
      const cost = attemptCost(attempt, this.pricing);
      if (cost === undefined) {
        this.#unknownModels.add(attempt.model);
      } else {
        this.#knownCost += cost;
      }
    }
  }

  /** 価格表にないモデルを使っていなければ概算費用、使っていれば undefined。 */
  get estimatedCost(): number | undefined {
    return this.#unknownModels.size === 0 ? this.#knownCost : undefined;
  }

  get unknownModels(): readonly string[] {
    return [...this.#unknownModels];
  }

  /**
   * 費用上限に達したか。価格表にないモデルを使った場合は費用を確認できないため
   * 上限に達したものとして扱う(fail-closed)。
   */
  reached(limit: number | undefined): boolean {
    if (limit === undefined) {
      return false;
    }
    return this.#unknownModels.size > 0 || this.#knownCost >= limit;
  }
}
