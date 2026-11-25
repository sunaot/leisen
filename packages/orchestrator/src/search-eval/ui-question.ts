/**
 * 条件 4(UI 側 LLM が作った question)の簡易な再現。
 *
 * leisen-ask serve が UI(LibreChat 等)に公開する ask のツール定義と initialize の instructions
 * (server/tools.ts の orchestratorToolDefinitions / SERVER_INSTRUCTIONS)を UI 側の LLM に与え、
 * 利用者の発言 1 つに対して ask を呼ばせ、その question を取り出す。LibreChat が UI 側の LLM に
 * 渡すシステムプロンプト全体は実装依存でリポジトリにないため、これは近似である(LibreChat の実走で
 * 採った ask の引数と突き合わせて妥当性を確かめる。reports/ の「同じ質問で、検索に入力するクエリの
 * 作り手だけを入れ替える」)。会話履歴は渡さない(1 発言だけ)。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { adaptRequestToCapabilities } from "../llm/capabilities.js";
import type { LlmClient } from "../llm/types.js";
import {
  ASK_TOOL_NAME,
  SERVER_INSTRUCTIONS,
  orchestratorToolDefinitions,
} from "../server/tools.js";

/** leisen-ask serve の既定の質問長の上限(server/limits.ts の既定と同じ値) */
export const UI_DEFAULT_MAX_QUESTION_CHARS = 4_000;
const UI_MAX_TOKENS = 4_000;

export type UiQuestionResult =
  | { readonly ok: true; readonly question: string }
  | { readonly ok: false; readonly errorClass: "ui_did_not_call_ask" | "ui_invalid_question" | "ui_llm_error" };

/** UI 側の LLM に送る要求(テストで形を確かめる)。 */
export function uiQuestionRequest(utterance: string, maxQuestionChars = UI_DEFAULT_MAX_QUESTION_CHARS) {
  const tools: Anthropic.Tool[] = orchestratorToolDefinitions({ maxQuestionChars }).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }));
  return {
    system: [{ type: "text" as const, text: SERVER_INSTRUCTIONS }],
    messages: [{ role: "user" as const, content: utterance }],
    tools,
    maxTokens: UI_MAX_TOKENS,
  };
}

/** 利用者の発言から、UI 側の LLM が ask に渡す question を得る。 */
export async function reproduceUiQuestion(
  llm: LlmClient,
  utterance: string,
  options: { readonly maxQuestionChars?: number; readonly signal?: AbortSignal } = {},
): Promise<UiQuestionResult> {
  const maxQuestionChars = options.maxQuestionChars ?? UI_DEFAULT_MAX_QUESTION_CHARS;
  let turn;
  try {
    turn = await llm.complete(
      adaptRequestToCapabilities(llm.capabilities, uiQuestionRequest(utterance, maxQuestionChars)),
      options.signal !== undefined ? { signal: options.signal } : {},
    );
  } catch {
    return { ok: false, errorClass: "ui_llm_error" };
  }
  const call = turn.message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === ASK_TOOL_NAME,
  );
  if (call === undefined) {
    return { ok: false, errorClass: "ui_did_not_call_ask" };
  }
  const input = call.input;
  const question =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)["question"]
      : undefined;
  if (typeof question !== "string" || question.trim() === "" || question.length > maxQuestionChars) {
    return { ok: false, errorClass: "ui_invalid_question" };
  }
  return { ok: true, question };
}
