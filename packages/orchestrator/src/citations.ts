/**
 * 出典の検証(T-007 受け入れ条件2、ADR-017 決定3)。
 *
 * - EvidenceLedger: この run で Gateway から実際に受け取った文書(search のヒット、
 *   fetch の結果)の台帳。キーは (sourceId, documentId)。documentId はコネクタ
 *   スコープの不透明な ID なので sourceId と組で照合する
 * - verifyCitations: LLM が申告した citations のうち、台帳にあるものだけを残す。
 *   title / url は LLM の申告ではなく台帳(ツール結果)の値で埋める。原典へのリンクは
 *   この citations[].url だけが運ぶ(回答本文の URL はすべて除去する。sanitize.ts、
 *   セキュリティレビュー 2026-09-27 M1)
 *
 * - 台帳は結果ごとの領域(scope、ADR-016 追補2 決定5)も記録する。"shared" 以外
 *   (欠落・未知の値)は private とし、同じ文書が複数回現れたら private を優先する。
 *   scope は監査の docId 分類(audit.ts の citedDocIdsForAudit)だけに使い、Answer の
 *   citations には載せない
 *
 * 台帳は run の間だけメモリに持ち、永続化しない(文書本文は保持しない)。
 */
import {
  normalizeDocumentScope,
  type DocumentScope,
  type FetchResult,
  type SearchHit,
} from "@leisen/connector-sdk";
import { z } from "zod";
import type { Citation, SubmitAnswerInput } from "./answer.js";

export interface EvidenceEntry {
  readonly sourceId: string;
  readonly documentId: string;
  readonly title: string | undefined;
  readonly url: string | undefined;
  /** 結果の領域(欠落・未知の値は private、複数回現れたら private を優先) */
  readonly scope: DocumentScope;
}

const documentRefSchema = z.object({
  documentId: z.string().min(1),
  title: z.string().optional(),
  url: z.string().min(1).optional(),
  // 値の検証は normalizeDocumentScope で行う(不正値で記録を落とさず private に倒す)
  scope: z.unknown().optional(),
});

const searchResultSchema = z.object({ hits: z.array(z.unknown()) });

/**
 * connector-sdk v0.4 の SearchHit / FetchResult が台帳の読み取り対象の形を満たすことを
 * 型で固定する(コネクタ IF の変更で台帳が黙って空になり、全出典が除外されるのを
 * コンパイル時に検知する。不変条件5)。
 */
type DocumentRef = z.infer<typeof documentRefSchema>;
type AssertAssignable<T extends U, U> = T;
export type SearchHitCarriesEvidence = AssertAssignable<
  Pick<SearchHit, "documentId" | "title" | "url" | "scope">,
  DocumentRef
>;
export type FetchResultCarriesEvidence = AssertAssignable<
  Pick<FetchResult, "documentId" | "title" | "url" | "scope">,
  DocumentRef
>;

function ledgerKey(sourceId: string, documentId: string): string {
  return `${sourceId}\u0000${documentId}`;
}

export class EvidenceLedger {
  readonly #entries = new Map<string, EvidenceEntry>();

  /** search の結果を記録する。記録したヒット数を返す(形が想定外の要素は無視)。 */
  recordSearch(sourceId: string, result: unknown): number {
    const parsed = searchResultSchema.safeParse(result);
    if (!parsed.success) {
      return 0;
    }
    let recorded = 0;
    for (const hit of parsed.data.hits) {
      const ref = documentRefSchema.safeParse(hit);
      if (ref.success) {
        this.#record(sourceId, ref.data);
        recorded += 1;
      }
    }
    return recorded;
  }

  /** fetch の結果を記録する。記録できたか(形が想定外なら false)を返す。 */
  recordFetch(sourceId: string, result: unknown): boolean {
    const ref = documentRefSchema.safeParse(result);
    if (!ref.success) {
      return false;
    }
    this.#record(sourceId, ref.data);
    return true;
  }

  get(sourceId: string, documentId: string): EvidenceEntry | undefined {
    return this.#entries.get(ledgerKey(sourceId, documentId));
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * 文書の領域(監査の docId 分類用、ADR-016 追補2 決定5)。台帳にない文書は
   * private(分類できないものは private 側に倒す)。
   */
  scopeOf(sourceId: string, documentId: string): DocumentScope {
    return this.get(sourceId, documentId)?.scope ?? "private";
  }

  #record(
    sourceId: string,
    ref: {
      documentId: string;
      title?: string | undefined;
      url?: string | undefined;
      scope?: unknown;
    },
  ): void {
    const key = ledgerKey(sourceId, ref.documentId);
    const existing = this.#entries.get(key);
    const scope = normalizeDocumentScope(ref.scope);
    this.#entries.set(key, {
      sourceId,
      documentId: ref.documentId,
      title: existing?.title ?? nonEmpty(ref.title),
      url: existing?.url ?? nonEmpty(ref.url),
      // 同じ文書が複数回現れたら private を優先する(一度でも private なら private)
      scope: existing?.scope === "private" ? "private" : scope,
    });
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

export interface CitationVerification {
  /** 台帳で確認できた出典(重複除去済み、申告順) */
  readonly verified: Citation[];
  /** 台帳にない(この run で受け取っていない)ため除外した件数 */
  readonly dropped: number;
}

/** LLM が申告した citations を台帳で検証する。 */
export function verifyCitations(
  citations: SubmitAnswerInput["citations"],
  ledger: EvidenceLedger,
): CitationVerification {
  const verified: Citation[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const citation of citations) {
    const key = ledgerKey(citation.sourceId, citation.documentId);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const entry = ledger.get(citation.sourceId, citation.documentId);
    if (entry === undefined) {
      dropped += 1;
      continue;
    }
    verified.push({
      documentId: entry.documentId,
      sourceId: entry.sourceId,
      ...(entry.title !== undefined ? { title: entry.title } : {}),
      ...(entry.url !== undefined ? { url: entry.url } : {}),
    });
  }
  return { verified, dropped };
}
