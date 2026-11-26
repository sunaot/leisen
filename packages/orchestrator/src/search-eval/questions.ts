/**
 * 検索方式の比較実験(dev-search-eval)の質問セット(examples/eval/search-questions.json)。
 *
 * - 種類: known-item(題名・ID が分かっている 1 文書を探す)/ multi-doc(答えに複数文書が要る)/
 *   unanswerable(コーパスに答えがない)
 * - 各質問: 利用者の発言(utterance)、人が検索欄に直接入力するキーワード(keywords。1 要素が
 *   1 回の search の query)、正解の文書(relevant。sourceId:documentId)
 * - 合成コーパス専用。質問セットが指すコーパス(corpus.files と corpus.synthetic)も同じファイルに書く
 */
import { z } from "zod";

export const SEARCH_EVAL_CATEGORIES = ["known-item", "multi-doc", "unanswerable"] as const;
export type SearchEvalCategory = (typeof SEARCH_EVAL_CATEGORIES)[number];

const docRef = z.string().regex(/^[^:\s]+:\S+$/u, "sourceId:documentId の形で書く");

export const searchEvalQuestionSchema = z
  .strictObject({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
    category: z.enum(SEARCH_EVAL_CATEGORIES),
    /** multi-doc: 2 つ目の事柄が発言に明示されているか */
    secondExplicit: z.boolean().optional(),
    /** 利用者の発言(UI に入力する文) */
    utterance: z.string().min(1).max(2000),
    /** 人が検索欄に直接入力するキーワード(1 要素 = 1 回の search の query) */
    keywords: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
    /** 正解の文書(sourceId:documentId)。unanswerable は空 */
    relevant: z.array(docRef).max(10),
    /** unanswerable: どの文書にも同時に現れてはならない語の組(空白区切りの語をすべて含む文書があれば違反) */
    mustNotAppear: z.array(z.string().trim().min(1)).optional(),
    note: z.string().optional(),
  })
  .superRefine((question, ctx) => {
    if (question.category === "unanswerable" && question.relevant.length > 0) {
      ctx.addIssue({ code: "custom", message: "unanswerable の relevant は空にする", path: ["relevant"] });
    }
    if (question.category !== "unanswerable" && question.relevant.length === 0) {
      ctx.addIssue({ code: "custom", message: "relevant を 1 件以上書く", path: ["relevant"] });
    }
    if (question.category === "multi-doc" && question.relevant.length < 2) {
      ctx.addIssue({ code: "custom", message: "multi-doc の relevant は 2 件以上", path: ["relevant"] });
    }
    if (question.category !== "unanswerable" && question.mustNotAppear !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "mustNotAppear は unanswerable の質問にだけ書ける",
        path: ["mustNotAppear"],
      });
    }
  });
export type SearchEvalQuestion = z.infer<typeof searchEvalQuestionSchema>;

export const searchEvalQuestionSetSchema = z
  .strictObject({
    version: z.literal(1),
    description: z.string().optional(),
    /** 検索するソース(開発用コネクタの sourceId) */
    source: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/u),
    corpus: z.strictObject({
      /** コーパスファイル(質問セットのファイルからの相対パス) */
      files: z.array(z.string().min(1)).min(1).max(20),
      /** 乱数の種を固定して生成する無関係な文書 */
      synthetic: z
        .strictObject({ seed: z.number().int().min(0).max(0xffff_ffff), count: z.number().int().min(1) })
        .optional(),
    }),
    questions: z.array(searchEvalQuestionSchema).min(1).max(200),
  })
  .superRefine((set, ctx) => {
    const seen = new Set<string>();
    for (const [index, question] of set.questions.entries()) {
      if (seen.has(question.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate question id: ${question.id}`, path: ["questions", index, "id"] });
      }
      seen.add(question.id);
      for (const ref of question.relevant) {
        if (!ref.startsWith(`${set.source}:`)) {
          ctx.addIssue({
            code: "custom",
            message: `relevant は source(${set.source})の文書にする`,
            path: ["questions", index, "relevant"],
          });
        }
      }
    }
  });
export type SearchEvalQuestionSet = z.infer<typeof searchEvalQuestionSetSchema>;

/** コーパスの文書(照合に使う部分)。 */
export interface CorpusDocumentView {
  readonly id: string;
  readonly title: string;
  readonly content: string;
}

export interface CorpusIssue {
  readonly questionId: string;
  readonly message: string;
}

/**
 * 質問セットとコーパスの整合を確かめる: 正解の文書がコーパスにあること、unanswerable の
 * mustNotAppear の語の組をすべて含む文書がないこと。問題の一覧を返す(空なら整合)。
 */
export function checkQuestionsAgainstCorpus(
  set: SearchEvalQuestionSet,
  documents: readonly CorpusDocumentView[],
): CorpusIssue[] {
  const ids = new Set(documents.map((d) => d.id));
  const issues: CorpusIssue[] = [];
  const prefix = `${set.source}:`;
  for (const question of set.questions) {
    for (const ref of question.relevant) {
      const id = ref.slice(prefix.length);
      if (!ids.has(id)) {
        issues.push({ questionId: question.id, message: `正解の文書 ${ref} がコーパスにない` });
      }
    }
    for (const group of question.mustNotAppear ?? []) {
      const terms = group.split(/\s+/u).filter((t) => t !== "").map((t) => t.toLowerCase());
      const offending = documents.find((d) => {
        const text = `${d.title}\n${d.content}`.toLowerCase();
        return terms.every((t) => text.includes(t));
      });
      if (offending !== undefined) {
        issues.push({
          questionId: question.id,
          message: `答えられないはずの語の組「${group}」が文書 ${offending.id} にある`,
        });
      }
    }
  }
  return issues;
}
