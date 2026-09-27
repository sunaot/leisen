/**
 * バックエンド共通の要求・応答の検査(T-007、ADR-017 決定1)。
 *
 * どのバックエンドも応答を Anthropic.Message の形に写してから、ここで同じ規則で
 * 「続行できる応答か」を判定する(content を読む前に stop_reason を見る)。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { LlmError } from "../errors.js";

/**
 * 末尾が assistant の履歴(prefill)は送らない。Anthropic の現行モデルでは 400 になり、
 * OpenAI 互換サーバーでは続きの生成として扱われうる(挙動がサーバー依存になる)。
 */
export function assertNoPrefill(messages: readonly Anthropic.MessageParam[]): void {
  const last = messages.at(-1);
  if (last === undefined) {
    throw new LlmError("llm_invalid_request", "messages must not be empty");
  }
  if (last.role === "assistant") {
    throw new LlmError(
      "llm_invalid_request",
      "assistant prefill is not supported by the current models",
    );
  }
}

/** stop_reason を content より先に判定し、続行できない応答を LlmError にする。 */
export function assertUsableStop(message: Anthropic.Message): void {
  const reason = message.stop_reason;
  switch (reason) {
    case "end_turn":
    case "tool_use":
    case "stop_sequence":
      return;
    case "refusal":
      // 部分出力(ストリーミング時)や空 content を回答として扱わない
      throw new LlmError(
        "llm_refusal",
        "the model declined the request (stop_reason: refusal)",
        message.stop_details?.category ?? undefined,
      );
    case "max_tokens":
      // ツール入力・回答が途中で切れている。切れた入力でツールを実行しない
      throw new LlmError(
        "llm_max_tokens",
        "the response was cut off at max_tokens",
      );
    case "pause_turn":
      // サーバーツールを宣言しないため想定外。再開には末尾 assistant の送信が要り、
      // サーバーツール以外では prefill 扱いの 400 になるので再開しない
      throw new LlmError(
        "llm_pause_turn",
        "unexpected pause_turn without server tools",
      );
    case "model_context_window_exceeded":
      throw new LlmError(
        "llm_context_window_exceeded",
        "the conversation exceeded the model context window",
      );
    case null:
      throw new LlmError(
        "llm_unexpected_response",
        "the response has no stop_reason",
      );
    default: {
      const unknown: never = reason;
      void unknown;
      throw new LlmError(
        "llm_unexpected_response",
        "the response has an unknown stop_reason",
      );
    }
  }
}
