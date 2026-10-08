/**
 * 能力フラグ(LlmCapabilities)の既定値と、要求をバックエンドの能力に合わせる処理
 * (T-007、ADR-017 決定1)。
 *
 * Orchestrator は要求を正準形(strict のツール定義・system 固定部のキャッシュの
 * ブレークポイント付き。tools.ts / answer.ts / prompt.ts が組む形)で作り、送る直前に
 * adaptRequestToCapabilities を1回通す。バックエンドの差を扱うのはここだけにして、
 * 探索ループ(制御層)は薄く保つ(product-design §3.3)。
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { LlmCapabilities, LlmRequest } from "./types.js";

/** Anthropic Messages API の能力(AnthropicLlmClient。ScriptedLlmClient の既定でもある)。 */
export const ANTHROPIC_CAPABILITIES: LlmCapabilities = Object.freeze({
  strictTools: true,
  thinking: "adaptive",
  effort: true,
  parallelToolCalls: true,
  promptCaching: true,
});

/**
 * OpenAI 互換 Chat Completions の能力の基本形(OpenAiCompatibleLlmClient)。
 * - strictTools: false。サーバーごとに strict の扱いが違う(未対応・無視・独自の制約
 *   生成)ため付けない。引数は Orchestrator と Gateway が検証する
 * - thinking: "none"。Chat Completions に思考の要求の標準はない(推論するモデルは内部で行う)
 * - effort: reasoningEffort を設定したときだけ true(クライアント側で上書き)
 * - parallelToolCalls: false。1応答で複数の呼び出しを返すかはサーバー・モデル依存で
 *   分からないため保守的にする(参照用。返ってきた呼び出しはすべて処理する)
 * - promptCaching: false。明示のブレークポイントの標準はない(サーバー側の自動
 *   prefix キャッシュは要求の形に依らない)
 */
export const OPENAI_COMPATIBLE_BASE_CAPABILITIES: LlmCapabilities = Object.freeze({
  strictTools: false,
  thinking: "none",
  effort: false,
  parallelToolCalls: false,
  promptCaching: false,
});

/**
 * 正準形の要求をバックエンドの能力に合わせる。
 * - 対応していれば thinking: "adaptive" / effort を付け、対応していなければ付けない
 * - strict に対応していなければツール定義から strict を外す
 * - キャッシュのブレークポイントに対応していなければ system から cache_control を外す
 * 同じ入力には同じ出力を返す(ツール定義・system の揺れはキャッシュを無効化するため)。
 * 入力は変更しない。
 */
export function adaptRequestToCapabilities(
  capabilities: LlmCapabilities,
  request: LlmRequest,
): LlmRequest {
  return {
    system: capabilities.promptCaching
      ? request.system
      : request.system.map(withoutCacheControl),
    messages: request.messages,
    tools: capabilities.strictTools ? request.tools : request.tools.map(withoutStrict),
    maxTokens: request.maxTokens,
    ...(capabilities.thinking === "adaptive" ? { thinking: "adaptive" as const } : {}),
    ...(capabilities.effort ? { effort: true } : {}),
  };
}

function withoutCacheControl(block: Anthropic.TextBlockParam): Anthropic.TextBlockParam {
  const { cache_control: _cacheControl, ...rest } = block;
  return rest;
}

function withoutStrict(tool: Anthropic.Tool): Anthropic.Tool {
  const { strict: _strict, ...rest } = tool;
  return rest;
}
