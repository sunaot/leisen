/**
 * 条件 4(UI 側 LLM が作った question)の簡易な再現。
 *
 * leisen-ask serve が UI(LibreChat 等)に公開する ask のツール定義と initialize の instructions
 * (server/tools.ts の orchestratorToolDefinitions / SERVER_INSTRUCTIONS)を UI 側の LLM に与え、
 * 利用者の発言 1 つに対して ask を呼ばせ、その question を取り出す。LibreChat が UI 側の LLM に
 * 渡すシステムプロンプト全体は実装依存でリポジトリにないため、これは近似である(LibreChat の実走で
 * 採った ask の引数と突き合わせて妥当性を確かめる。reports/ の「同じ質問で、検索に入力するクエリの
 * 作り手だけを入れ替える」)。会話履歴は渡さない(1 発言だけ)。
 *
 * LibreChat v0.8.7 の組み立てに合わせた再現(--ui-prompt librechat / librechat-instructions)は
 * librechat-ui.ts。uiAskRequest / reproduceUiAsk は再現の種類を選べ、UI 側 LLM が書いた ask の引数を
 * すべて返す(simple では従来どおり question だけを探索 LLM に渡す。runner.ts)。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { adaptRequestToCapabilities } from "../llm/capabilities.js";
import type { LlmClient } from "../llm/types.js";
import {
  ASK_TOOL_NAME,
  SERVER_INSTRUCTIONS,
  orchestratorToolDefinitions,
} from "../server/tools.js";
import {
  DEFAULT_UI_PROMPT_STYLE,
  isLibreChatStyle,
  libreChatSystemPrompt,
  libreChatTools,
  uiAskToolName,
  type UiPromptStyle,
} from "./librechat-ui.js";

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

/** UI 側の LLM に送る要求(再現の種類を選ぶ。simple は uiQuestionRequest と同じ)。 */
export function uiAskRequest(
  utterance: string,
  style: UiPromptStyle = DEFAULT_UI_PROMPT_STYLE,
  maxQuestionChars = UI_DEFAULT_MAX_QUESTION_CHARS,
) {
  if (!isLibreChatStyle(style)) {
    return uiQuestionRequest(utterance, maxQuestionChars);
  }
  return {
    system: [{ type: "text" as const, text: libreChatSystemPrompt(style) }],
    messages: [{ role: "user" as const, content: utterance }],
    tools: libreChatTools(maxQuestionChars),
    // LibreChat は UI 側 LLM の max_tokens をこの用途では決めない。claude -p の模擬では効かない
    maxTokens: UI_MAX_TOKENS,
  };
}

export type UiAskResult =
  | {
      readonly ok: true;
      /** UI 側 LLM が呼んだツールの名前(simple は ask、librechat は ask_mcp_leisen) */
      readonly toolName: string;
      /** UI 側 LLM が書いた引数(オブジェクト。値は検証していない) */
      readonly arguments: Readonly<Record<string, unknown>>;
    }
  | { readonly ok: false; readonly errorClass: "ui_did_not_call_ask" | "ui_invalid_arguments" | "ui_llm_error" };

/** 利用者の発言から、UI 側の LLM が ask に渡す引数(すべて)を得る。 */
export async function reproduceUiAsk(
  llm: LlmClient,
  utterance: string,
  options: {
    readonly style?: UiPromptStyle;
    readonly maxQuestionChars?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<UiAskResult> {
  const style = options.style ?? DEFAULT_UI_PROMPT_STYLE;
  const maxQuestionChars = options.maxQuestionChars ?? UI_DEFAULT_MAX_QUESTION_CHARS;
  let turn;
  try {
    turn = await llm.complete(
      adaptRequestToCapabilities(llm.capabilities, uiAskRequest(utterance, style, maxQuestionChars)),
      options.signal !== undefined ? { signal: options.signal } : {},
    );
  } catch {
    return { ok: false, errorClass: "ui_llm_error" };
  }
  const toolName = uiAskToolName(style);
  const call = turn.message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === toolName,
  );
  if (call === undefined) {
    return { ok: false, errorClass: "ui_did_not_call_ask" };
  }
  const input = call.input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errorClass: "ui_invalid_arguments" };
  }
  return { ok: true, toolName, arguments: input as Record<string, unknown> };
}

/** simple の再現で探索 LLM に渡す question(従来の規則: 空・上限超過・文字列でなければ undefined)。 */
export function simpleQuestionOf(
  args: Readonly<Record<string, unknown>>,
  maxQuestionChars = UI_DEFAULT_MAX_QUESTION_CHARS,
): string | undefined {
  const question = args["question"];
  if (typeof question !== "string" || question.trim() === "" || question.length > maxQuestionChars) {
    return undefined;
  }
  return question;
}

/** 利用者の発言から、UI 側の LLM が ask に渡す question を得る(simple の再現)。 */
export async function reproduceUiQuestion(
  llm: LlmClient,
  utterance: string,
  options: { readonly maxQuestionChars?: number; readonly signal?: AbortSignal } = {},
): Promise<UiQuestionResult> {
  const maxQuestionChars = options.maxQuestionChars ?? UI_DEFAULT_MAX_QUESTION_CHARS;
  const ui = await reproduceUiAsk(llm, utterance, { ...options, style: "simple" });
  if (!ui.ok) {
    return { ok: false, errorClass: ui.errorClass === "ui_invalid_arguments" ? "ui_invalid_question" : ui.errorClass };
  }
  const question = simpleQuestionOf(ui.arguments, maxQuestionChars);
  if (question === undefined) {
    return { ok: false, errorClass: "ui_invalid_question" };
  }
  return { ok: true, question };
}
