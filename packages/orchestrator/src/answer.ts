/**
 * 回答スキーマ(T-007)と、回答提出ツール `submit_answer`(ADR-017 決定3)。
 *
 * - Answer: Orchestrator.run の戻り値。citations は run 内で実際に受け取った
 *   文書に検証済みのものだけ(citations.ts)。title / url は LLM の申告ではなく
 *   ツール結果(証拠台帳)から埋める
 * - submit_answer: LLM が最終回答を提出するクライアント側ツール(strict)。
 *   JSON Schema の数値範囲(minimum / maximum)は strict のツール定義で使えないため、
 *   confidence の 0..1 はクライアント側で丸める
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/**
 * スキップしたソースの理由。現状は未接続(ADR-010 決定3)のみ。追加する場合は
 * ここと回答の案内文(orchestrator.ts)を併せて更新する。
 */
export const skipReasonSchema = z.enum(["source_not_connected"]);
export type SkipReason = z.infer<typeof skipReasonSchema>;

export const skippedSourceSchema = z.strictObject({
  sourceId: z.string().min(1),
  reason: skipReasonSchema,
});
export type SkippedSource = z.infer<typeof skippedSourceSchema>;

export const citationSchema = z.strictObject({
  documentId: z.string().min(1),
  sourceId: z.string().min(1),
  /** ツール結果(search ヒット / fetch 結果)の title */
  title: z.string().optional(),
  /** ツール結果の url(原典。LLM が生成した URL は入れない) */
  url: z.string().optional(),
});
export type Citation = z.infer<typeof citationSchema>;

export const answerOutcomeSchema = z.enum(["resolved", "unresolved", "error"]);
export type AnswerOutcome = z.infer<typeof answerOutcomeSchema>;

export const answerUsageSchema = z.strictObject({
  /** 入力トークンの合計(キャッシュ書き込み・読み出しを含む) */
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  /** LLM 呼び出し回数 */
  llmTurns: z.number().int().min(0),
  /** Gateway へのツール呼び出し回数(describe を含む。Gateway の ToolInvocation 件数と一致する) */
  toolCalls: z.number().int().min(0),
  /** 価格表による概算費用(価格表にないモデルを使った場合は省略) */
  estimatedCost: z.number().min(0).optional(),
});
export type AnswerUsage = z.infer<typeof answerUsageSchema>;

export const answerSchema = z.strictObject({
  runId: z.string().min(1),
  answer: z.string(),
  citations: z.array(citationSchema),
  /** search / fetch / list が成功したソース(describe だけのソースは含めない) */
  searchedSources: z.array(z.string().min(1)),
  /** 未接続のため検索しなかったソース(ADR-010 決定3) */
  skippedSources: z.array(skippedSourceSchema),
  confidence: z.number().min(0).max(1),
  outcome: answerOutcomeSchema,
  usage: answerUsageSchema,
  warnings: z.array(z.string()),
});
export type Answer = z.infer<typeof answerSchema>;

// ---------------------------------------------------------------------------
// submit_answer
// ---------------------------------------------------------------------------

export const SUBMIT_ANSWER_TOOL_NAME = "submit_answer";

/**
 * 回答本文の文字数上限。トークン上限(maxTokensPerTurn)とは独立した防御層で、
 * 無害化処理(sanitize.ts)への入力サイズを多層で制限する(再レビュー 2026-09-27)。
 * 64000 トークン(設定上限)の日本語本文でも十分に収まる値にしている。
 */
export const MAX_ANSWER_CHARS = 200_000;

/** submit_answer の入力(strict で形は保証されるが、防御的に検証する)。 */
export const submitAnswerInputSchema = z.object({
  answer: z.string().max(MAX_ANSWER_CHARS),
  citations: z.array(
    z.object({
      documentId: z.string(),
      sourceId: z.string(),
      quote: z.string().optional(),
    }),
  ),
  confidence: z.number(),
  unresolvedReason: z.string().optional(),
});
export type SubmitAnswerInput = z.infer<typeof submitAnswerInputSchema>;

/**
 * submit_answer のツール定義(strict)。citations[].sourceId は run の有効ソースの
 * enum にする(未接続・無効なソースを出典にさせない)。
 */
export function submitAnswerTool(activeSources: readonly string[]): Anthropic.Tool {
  return {
    name: SUBMIT_ANSWER_TOOL_NAME,
    description:
      "最終回答を提出する。探索を終えたら必ずこのツールで回答を提出する(通常のテキスト応答は回答として扱われない)。" +
      "citations には、この会話で search のヒットまたは fetch の結果として実際に受け取った文書だけを入れる。" +
      "質問に答えられなかった場合も、探索した範囲を answer に書き、unresolvedReason に理由を書いて提出する。",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        answer: {
          type: "string",
          description:
            "利用者への回答本文。引用した文書で裏付けられる内容に限る。確信が持てない場合はその旨と探索した範囲を書く",
        },
        citations: {
          type: "array",
          description: "回答の根拠にした文書(ツール結果の documentId と sourceId をそのまま使う)",
          items: {
            type: "object",
            properties: {
              documentId: { type: "string" },
              sourceId: { type: "string", enum: [...activeSources] },
              quote: {
                type: "string",
                description: "根拠にした箇所の短い抜粋(任意)",
              },
            },
            required: ["documentId", "sourceId"],
            additionalProperties: false,
          },
        },
        confidence: {
          type: "number",
          description: "回答が引用文書で裏付けられている度合い(0〜1)",
        },
        unresolvedReason: {
          type: "string",
          description: "質問に答えられなかった場合のみ、その理由",
        },
      },
      required: ["answer", "citations", "confidence"],
      additionalProperties: false,
    },
  };
}
