/**
 * 条件 4 の UI 側 LLM への入力を、LibreChat v0.8.7 の組み立てに合わせて再現する(T-027)。
 * 合成コーパス専用の比較実験(dev-search-eval)の中だけで使う。
 *
 * 出典(調査の記録は research_notes/エージェント検索ハーネス設計調査/librechat_ui_prompt.md):
 *   リポジトリ github.com/danny-avila/LibreChat、タグ v0.8.7、
 *   コミット 9e74cc0e57b395926122bd4062c1fcedc48ed465(リファレンス構成のイメージ
 *   ghcr.io/librechat-ai/librechat:v0.8.7 と同じ版)。@librechat/agents は lockfile の 3.2.46
 *
 * 再現すること(ソースコードで確かめたもの):
 * - ツール名は `<MCP のツール名>_mcp_<サーバー名>`(packages/data-provider/src/config.ts:2540、
 *   packages/api/src/mcp/registry/MCPServerInspector.ts:178)。説明とスキーマは MCP の tools/list の値のまま
 *   (packages/api/src/mcp/zod.ts の normalizeJsonSchema は ask の inputSchema を変えない)
 * - システムメッセージは「基本の instructions(通常の会話では promptPrefix。リファレンス構成では空)」と
 *   MCP の instructions の定型文を '\n\n' でつないで trim したもの(packages/api/src/agents/context.ts:98-106)。
 *   定型文は packages/api/src/mcp/MCPManager.ts:305-331 の formatInstructionsForContext
 * - リファレンス構成(deploy/compose/librechat/librechat.yaml)は `startup: false` で、ヘッダに実行時の
 *   プレースホルダを持つため、起動時の検査(MCPServerInspector.ts:75-81、144-148)が initialize の
 *   instructions を取りに行かず、`serverInstructions` は真偽値の true のまま定型文に入る(文字列 "true")
 * - 利用者が書いた引数はすべて MCP の tools/call にそのまま渡る(api/server/services/MCP.js の _call)。
 *   ここでは leisen-ask serve と同じ検証(server/tools.ts の runOrchestratorTool)を通して探索 LLM に渡す
 *
 * 再現しないこと(未確認、または リファレンス構成の既定では入らないもの):
 * - LangChain の bindTools がツール定義を API の形に変える際の細部(strict の付与など)は未確認
 * - 利用者のカスタム指示(promptPrefix)・artifacts・ファイル・メモリ・skills の文(既定では入らない)
 * - 会話履歴(この再現は 1 発言だけ)
 * - ツールの結果を UI 側 LLM に戻す部分(この再現は ask の呼び出しまで。LibreChat は content の text だけを
 *   戻し、structuredContent を渡さない。parsers.ts の formatToolContent)
 * - ask がエラーを返したときに UI 側 LLM が言い直す動き(この再現は 1 回だけ呼ぶ)
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { GatewayClient } from "../gateway/types.js";
import type { Orchestrator, RunInput, RunResult } from "../orchestrator.js";
import { ServerLimits } from "../server/limits.js";
import {
  ASK_TOOL_NAME,
  SERVER_INSTRUCTIONS,
  orchestratorToolDefinitions,
  runOrchestratorTool,
  type ToolOutcome,
} from "../server/tools.js";

/** 調べた LibreChat の版(表の注記・文書に出す)。 */
export const LIBRECHAT_SOURCE = Object.freeze({
  repository: "github.com/danny-avila/LibreChat",
  tag: "v0.8.7",
  commit: "9e74cc0e57b395926122bd4062c1fcedc48ed465",
  agents: "@librechat/agents 3.2.46",
});

/** MCP のツール名とサーバー名の区切り(packages/data-provider/src/config.ts:2540 `mcp_delimiter = '_mcp_'`)。 */
export const LIBRECHAT_MCP_DELIMITER = "_mcp_";

/** リファレンス構成の MCP サーバー名(deploy/compose/librechat/librechat.yaml の mcpServers のキー)。 */
export const LIBRECHAT_REFERENCE_SERVER_NAME = "leisen";

/**
 * リファレンス構成で定型文に入る値。`serverInstructions: true` が起動時に initialize の instructions で
 * 置き換えられず、真偽値のままテンプレートリテラルに入る(MCPManager.ts:292-293、MCPServerInspector.ts:75-81)。
 */
export const LIBRECHAT_REFERENCE_SERVER_INSTRUCTIONS = String(true);

/** UI 側 LLM への入力の再現の種類。 */
export const UI_PROMPT_STYLES = [
  /** 従来の近似: SERVER_INSTRUCTIONS をそのままシステムプロンプトに、ツール名 ask、question だけを渡す */
  "simple",
  /** LibreChat v0.8.7 のリファレンス構成どおり(定型文の instructions は "true") */
  "librechat",
  /** LibreChat v0.8.7 で serverInstructions に SERVER_INSTRUCTIONS の文字列を書いた場合 */
  "librechat-instructions",
] as const;
export type UiPromptStyle = (typeof UI_PROMPT_STYLES)[number];
export const DEFAULT_UI_PROMPT_STYLE: UiPromptStyle = "simple";

export function isUiPromptStyle(value: string): value is UiPromptStyle {
  return (UI_PROMPT_STYLES as readonly string[]).includes(value);
}

export function isLibreChatStyle(style: UiPromptStyle): boolean {
  return style === "librechat" || style === "librechat-instructions";
}

/** LibreChat がツールに付ける名前(MCPServerInspector.ts:178 `${tool.name}${Constants.mcp_delimiter}${serverName}`)。 */
export function libreChatToolName(toolName: string, serverName = LIBRECHAT_REFERENCE_SERVER_NAME): string {
  return `${toolName}${LIBRECHAT_MCP_DELIMITER}${serverName}`;
}

/**
 * MCP の instructions の定型文(packages/api/src/mcp/MCPManager.ts:305-331 formatInstructionsForContext。
 * サーバー 1 つの場合)。文面は v0.8.7 のまま(英語)。
 */
export function libreChatMcpInstructions(serverName: string, instructions: string): string {
  const formattedInstructions = `## ${serverName} MCP Server Instructions

${instructions}`;
  return `# MCP Server Instructions

The following MCP servers are available with their specific instructions:

${formattedInstructions}

Please follow these instructions when using tools from the respective MCP servers.`;
}

/**
 * システムメッセージの本文(packages/api/src/agents/context.ts:98-106 buildAgentInstructions:
 * `[baseInstructions, mcpInstructions].filter(Boolean).join('\n\n').trim()`)。baseInstructions は
 * 通常の会話の promptPrefix(リファレンス構成の既定は空)。additional_instructions は既定で空なので足さない。
 */
export function libreChatSystemPrompt(style: UiPromptStyle, baseInstructions = ""): string {
  const instructions =
    style === "librechat-instructions" ? SERVER_INSTRUCTIONS : LIBRECHAT_REFERENCE_SERVER_INSTRUCTIONS;
  const mcpInstructions = libreChatMcpInstructions(LIBRECHAT_REFERENCE_SERVER_NAME, instructions);
  return [baseInstructions, mcpInstructions].filter((part) => part !== "").join("\n\n").trim();
}

/** LibreChat が UI 側 LLM に渡すツール定義(名前だけを変え、説明とスキーマはそのまま)。 */
export function libreChatTools(maxQuestionChars: number): Anthropic.Tool[] {
  return orchestratorToolDefinitions({ maxQuestionChars }).map((tool) => ({
    name: libreChatToolName(tool.name),
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

/** ask のツール名(再現の種類ごと)。 */
export function uiAskToolName(style: UiPromptStyle): string {
  return isLibreChatStyle(style) ? libreChatToolName(ASK_TOOL_NAME) : ASK_TOOL_NAME;
}

/** client.close() だけを何もしない形にする(runOrchestratorTool は run の後にクライアントを閉じる)。 */
function withoutClose(client: GatewayClient): GatewayClient {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "close") {
        return () => Promise.resolve();
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export interface LibreChatAskResult {
  /** ask の結果(leisen-ask serve が返すもの) */
  readonly outcome: ToolOutcome;
  /** 引数の検証を通って探索 LLM の run を始めた(false なら引数で拒否された) */
  readonly runStarted: boolean;
  /** run が例外で終わった場合の例外 */
  readonly runError?: unknown;
}

/**
 * UI 側 LLM が書いた ask の引数を、leisen-ask serve と同じ検証(runOrchestratorTool)にかけて実行する。
 * 引数はそのまま渡す(question 以外の userMessage / context / keepTerms / sources / period / depth も)。
 * onRunStart は検証を通った run の入力(question は前後の空白を除いた値)を受け、onRunResult は結果を受ける。
 */
export async function runAskLikeLibreChat(params: {
  readonly orchestrator: Pick<Orchestrator, "runDetailed">;
  /** 比較実験の Gateway のクライアント(閉じない) */
  readonly gateway: GatewayClient;
  readonly args: unknown;
  readonly maxQuestionChars: number;
  /** sources に指定できるソース(--config で有効なコネクタの sourceId に当たるもの) */
  readonly knownSourceIds: readonly string[];
  readonly onRunStart?: (input: Omit<RunInput, "gateway">) => void;
  readonly onRunResult?: (result: RunResult) => void;
}): Promise<LibreChatAskResult> {
  let runStarted = false;
  let runError: unknown;
  let failed = false;
  const outcome = await runOrchestratorTool(
    {
      orchestrator: {
        runDetailed: async (input) => {
          runStarted = true;
          const { gateway: _gateway, ...rest } = input;
          params.onRunStart?.(rest);
          try {
            const result = await params.orchestrator.runDetailed(input);
            params.onRunResult?.(result);
            return result;
          } catch (error) {
            failed = true;
            runError = error;
            throw error;
          }
        },
      },
      createGatewayClient: () => withoutClose(params.gateway),
      limits: new ServerLimits({ maxQuestionChars: params.maxQuestionChars, maxConcurrentRuns: 1 }),
      retentionClass: "persistable",
      knownSourceIds: params.knownSourceIds,
    },
    ASK_TOOL_NAME,
    params.args,
  );
  return { outcome, runStarted, ...(failed ? { runError } : {}) };
}
