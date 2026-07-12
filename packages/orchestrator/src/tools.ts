/**
 * LLMへ公開するツール群(T-007)。
 *
 * search / fetch / list はGatewayの同名ツールへ写像する(describeの内容は
 * システムプロンプトに常時保持するため、ツールとしては公開しない)。
 * final_answer は探索ループの終了とT-007回答スキーマの申告に使う。
 * LLM出力は信用できない入力としてzodで検証し、不正はツールエラーで返す。
 */
import { z } from "zod";
import type { SearchFilters } from "@kp/connector-sdk";
import type { GatewayToolCall } from "@kp/gateway";
import type { LlmToolDefinition } from "./llm/types.js";

const filtersSchema = z.strictObject({
  updatedAfter: z.string().min(1).optional(),
  updatedBefore: z.string().min(1).optional(),
  container: z.string().min(1).optional(),
  author: z.string().min(1).optional(),
});

const searchInputSchema = z.strictObject({
  source: z.string().min(1),
  query: z.string().min(1),
  filters: filtersSchema.optional(),
  limit: z.number().int().min(1).optional(),
  cursor: z.string().min(1).optional(),
});

const fetchInputSchema = z.strictObject({
  source: z.string().min(1),
  documentId: z.string().min(1),
  pageCursor: z.string().min(1).optional(),
});

const listInputSchema = z.strictObject({
  source: z.string().min(1),
  containerId: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
});

export const citationSchema = z.strictObject({
  source: z.string().min(1),
  documentId: z.string().min(1),
});

export const finalAnswerInputSchema = z.strictObject({
  answer: z.string().min(1),
  citations: z.array(citationSchema).default([]),
  outcome: z.enum(["resolved", "unresolved"]),
  confidence: z.number().min(0).max(1),
});

export type FinalAnswerInput = z.infer<typeof finalAnswerInputSchema>;

export const FINAL_ANSWER_TOOL = "final_answer";

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/** LLMのtool_use入力をGateway呼び出しへ写像する。final_answerは対象外。 */
export function parseGatewayToolInput(
  name: string,
  input: unknown,
): GatewayToolCall {
  switch (name) {
    case "search": {
      const a = parseInput(searchInputSchema, input);
      const options = {
        ...(a.limit !== undefined ? { limit: a.limit } : {}),
        ...(a.cursor !== undefined ? { cursor: a.cursor } : {}),
      };
      // zodのoptionalは `string | undefined` になるため、undefinedキーを
      // 落としてexactOptionalPropertyTypesなSearchFiltersに合わせる
      const filters: SearchFilters | undefined = a.filters
        ? {
            ...(a.filters.updatedAfter !== undefined
              ? { updatedAfter: a.filters.updatedAfter }
              : {}),
            ...(a.filters.updatedBefore !== undefined
              ? { updatedBefore: a.filters.updatedBefore }
              : {}),
            ...(a.filters.container !== undefined
              ? { container: a.filters.container }
              : {}),
            ...(a.filters.author !== undefined
              ? { author: a.filters.author }
              : {}),
          }
        : undefined;
      return {
        tool: "search",
        sourceId: a.source,
        query: a.query,
        ...(filters !== undefined ? { filters } : {}),
        ...(Object.keys(options).length > 0 ? { options } : {}),
      };
    }
    case "fetch": {
      const a = parseInput(fetchInputSchema, input);
      return {
        tool: "fetch",
        sourceId: a.source,
        documentId: a.documentId,
        ...(a.pageCursor !== undefined ? { pageCursor: a.pageCursor } : {}),
      };
    }
    case "list": {
      const a = parseInput(listInputSchema, input);
      return {
        tool: "list",
        sourceId: a.source,
        ...(a.containerId !== undefined ? { containerId: a.containerId } : {}),
        ...(a.cursor !== undefined ? { cursor: a.cursor } : {}),
      };
    }
    default:
      throw new ToolInputError(`unknown tool: ${name}`);
  }
}

export function parseFinalAnswerInput(input: unknown): FinalAnswerInput {
  return parseInput(finalAnswerInputSchema, input);
}

function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    // zod issueはパスと期待型のみで入力値を含まない形にする(TM-A2と同様)
    throw new ToolInputError(
      `invalid tool input${at}: ${issue?.message ?? "unknown"}`,
    );
  }
  return parsed.data;
}

/**
 * ツール定義。sourceはenumで接続済みソースに限定し、未接続ソースへの
 * 呼び出しをスキーマ段階でも抑止する(実行時はGatewayが拒否する)。
 */
export function buildToolDefinitions(
  sourceIds: readonly string[],
): LlmToolDefinition[] {
  const source =
    sourceIds.length > 0
      ? { type: "string", enum: [...sourceIds] }
      : { type: "string" };
  return [
    {
      name: "search",
      description:
        "指定ソースを利用者本人の権限で検索し、スニペット付きのヒット一覧を返す",
      inputSchema: {
        type: "object",
        properties: {
          source,
          query: { type: "string" },
          filters: {
            type: "object",
            properties: {
              updatedAfter: { type: "string" },
              updatedBefore: { type: "string" },
              container: { type: "string" },
              author: { type: "string" },
            },
            additionalProperties: false,
          },
          limit: { type: "number" },
          cursor: { type: "string" },
        },
        required: ["source", "query"],
        additionalProperties: false,
      },
    },
    {
      name: "fetch",
      description: "検索ヒットのdocumentIdから本文(1ページ分)を取得する",
      inputSchema: {
        type: "object",
        properties: {
          source,
          documentId: { type: "string" },
          pageCursor: { type: "string" },
        },
        required: ["source", "documentId"],
        additionalProperties: false,
      },
    },
    {
      name: "list",
      description: "ソース内の区画(フォルダ、チャンネル等)を列挙する",
      inputSchema: {
        type: "object",
        properties: {
          source,
          containerId: { type: "string" },
          cursor: { type: "string" },
        },
        required: ["source"],
        additionalProperties: false,
      },
    },
    finalAnswerToolDefinition(),
  ];
}

export function finalAnswerToolDefinition(): LlmToolDefinition {
  return {
    name: FINAL_ANSWER_TOOL,
    description:
      "探索を終了し、利用者への最終回答を返す。回答は必ずこのツールで終えること",
    inputSchema: {
      type: "object",
      properties: {
        answer: { type: "string", description: "利用者への回答本文" },
        citations: {
          type: "array",
          description:
            "根拠文書。この会話中にsearch/fetchで観測したdocumentIdのみ",
          items: {
            type: "object",
            properties: {
              source: { type: "string" },
              documentId: { type: "string" },
            },
            required: ["source", "documentId"],
            additionalProperties: false,
          },
        },
        outcome: {
          type: "string",
          enum: ["resolved", "unresolved"],
          description:
            "出典付きで回答できたらresolved、できなければunresolved",
        },
        confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "回答の確信度",
        },
      },
      required: ["answer", "citations", "outcome", "confidence"],
      additionalProperties: false,
    },
  };
}
