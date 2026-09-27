/**
 * LLM 費用の概算(T-007、costLimitPerQuery の判定用)。
 *
 * usage のトークン数 × 価格表(config.ts、設定注入)で概算する。価格表はプロバイダ
 * ごとに分かれており(pricingFor)、呼び出し側が LLM クライアントの provider の表を渡す。
 * 表の行は応答の model で引く(findModelPrice)。価格表にないモデル・usage のない応答の分は
 * 概算できない(0 とみなさず「不明」にする)。不明な分があると estimatedCost は出さず、
 * 費用上限が設定されていれば到達扱いにする(fail-closed)。上限が設定されていなければ
 * 探索は止めない(ローカル推論など価格表のないバックエンドでも動かせる)。
 * 課金の正は各バックエンドの請求であり、ここの値は上限判定と表示のための近似。
 */
import type { ModelPrice, ModelPricing } from "./config.js";
import type { LlmAttemptUsage } from "./llm/types.js";

const PER_MILLION = 1_000_000;

/**
 * スナップショット付きのモデル ID の日付部分。Anthropic 形式(`-20260401`)、Vertex 形式
 * (`@20260401`)、OpenAI 形式(`-2026-04-01`)を受ける。日付以外の接尾辞(例: `-5`)は
 * 別モデルの可能性があるため元の ID に写さない(claude-opus-5-5 を claude-opus-5 の単価で
 * 数えない)。
 */
const SNAPSHOT_SUFFIX = /^(.+?)[-@](?:\d{8}|\d{4}-\d{2}-\d{2})$/;

/**
 * 価格表の行を引く。完全一致を優先し、なければスナップショット付き ID(元の ID +
 * 日付)を元の ID の行に写す(prefix 一致。残りが日付の場合に限る)。表の自前の
 * キーだけを見る(`constructor` 等の継承プロパティを単価と取り違えない)。
 */
export function findModelPrice(
  pricing: ModelPricing,
  model: string,
): ModelPrice | undefined {
  if (Object.hasOwn(pricing, model)) {
    return pricing[model];
  }
  const snapshot = SNAPSHOT_SUFFIX.exec(model);
  const base = snapshot?.[1];
  if (base !== undefined && Object.hasOwn(pricing, base)) {
    return pricing[base];
  }
  return undefined;
}

/** 1試行分の費用。価格表にないモデル、または usage のない応答なら undefined。 */
export function attemptCost(
  attempt: LlmAttemptUsage,
  pricing: ModelPricing,
): number | undefined {
  if (attempt.usageMissing === true) {
    return undefined;
  }
  const price = findModelPrice(pricing, attempt.model);
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

/** run 全体の使用量と概算費用の累計(1つのプロバイダの価格表で数える)。 */
export class UsageMeter {
  inputTokens = 0;
  outputTokens = 0;
  llmTurns = 0;
  /** 価格表で概算できた分の累計 */
  #knownCost = 0;
  readonly #unknownModels = new Set<string>();
  #usageMissing = false;

  constructor(private readonly pricing: ModelPricing) {}

  add(attempts: readonly LlmAttemptUsage[]): void {
    this.llmTurns += 1;
    for (const attempt of attempts) {
      this.inputTokens +=
        attempt.inputTokens +
        attempt.cacheCreationInputTokens +
        attempt.cacheReadInputTokens;
      this.outputTokens += attempt.outputTokens;
      if (attempt.usageMissing === true) {
        this.#usageMissing = true;
        continue;
      }
      const cost = attemptCost(attempt, this.pricing);
      if (cost === undefined) {
        this.#unknownModels.add(attempt.model);
      } else {
        this.#knownCost += cost;
      }
    }
  }

  /** 費用が不明な分(価格表にないモデル・usage のない応答)がなければ概算費用、あれば undefined。 */
  get estimatedCost(): number | undefined {
    return this.#unknownModels.size === 0 && !this.#usageMissing
      ? this.#knownCost
      : undefined;
  }

  get unknownModels(): readonly string[] {
    return [...this.#unknownModels];
  }

  /** usage を返さない応答があったか(トークン数は 0 として数えている)。 */
  get usageMissing(): boolean {
    return this.#usageMissing;
  }

  /**
   * 費用上限に達したか。上限が未設定なら判定しない(false)。設定されていて、費用が
   * 不明な分(価格表にないモデル・usage のない応答)があれば確認できないため到達扱い
   * (fail-closed)。
   */
  reached(limit: number | undefined): boolean {
    if (limit === undefined) {
      return false;
    }
    return (
      this.#unknownModels.size > 0 || this.#usageMissing || this.#knownCost >= limit
    );
  }
}
