/**
 * 出典の検証(T-007 受け入れ条件2、ADR-017 決定3)と、回答中の URL の検証(RS-4 / TM-D2)。
 *
 * - EvidenceLedger: この run で Gateway から実際に受け取った文書(search のヒット、
 *   fetch の結果)の台帳。キーは (sourceId, documentId)。documentId はコネクタ
 *   スコープの不透明な ID なので sourceId と組で照合する
 * - verifyCitations: LLM が申告した citations のうち、台帳にあるものだけを残す。
 *   title / url は LLM の申告ではなく台帳(ツール結果)の値で埋める
 * - sanitizeAnswerUrls: 回答文中の URL のうち、台帳の url(原典)以外を除去する。
 *   文書本文に書かれていたリンクや、LLM が生成した URL は原典ではないので除去する
 *   (インジェクションによる exfiltration 対策。画像 URL のクエリ文字列に機密を
 *   積む経路を塞ぐ)
 *
 * 台帳は run の間だけメモリに持ち、永続化しない(文書本文は保持しない)。
 */
import type { FetchResult, SearchHit } from "@kp/connector-sdk";
import { z } from "zod";
import type { Citation, SubmitAnswerInput } from "./answer.js";

export interface EvidenceEntry {
  readonly sourceId: string;
  readonly documentId: string;
  readonly title: string | undefined;
  readonly url: string | undefined;
}

const documentRefSchema = z.object({
  documentId: z.string().min(1),
  title: z.string().optional(),
  url: z.string().min(1).optional(),
});

const searchResultSchema = z.object({ hits: z.array(z.unknown()) });

/**
 * connector-sdk v0.3 の SearchHit / FetchResult が台帳の読み取り対象の形を満たすことを
 * 型で固定する(コネクタ IF の変更で台帳が黙って空になり、全出典が除外されるのを
 * コンパイル時に検知する。不変条件5)。
 */
type DocumentRef = z.infer<typeof documentRefSchema>;
type AssertAssignable<T extends U, U> = T;
export type SearchHitCarriesEvidence = AssertAssignable<
  Pick<SearchHit, "documentId" | "title" | "url">,
  DocumentRef
>;
export type FetchResultCarriesEvidence = AssertAssignable<
  Pick<FetchResult, "documentId" | "title" | "url">,
  DocumentRef
>;

function ledgerKey(sourceId: string, documentId: string): string {
  return `${sourceId}\u0000${documentId}`;
}

/** URL の比較用の正規化(ホスト名の大小・既定ポート・パーセント符号化の揺れを吸収)。 */
export function normalizeUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

export class EvidenceLedger {
  readonly #entries = new Map<string, EvidenceEntry>();
  readonly #urls = new Set<string>();

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

  /** 原典として受け取った URL(正規化前の文字列)。 */
  get urls(): ReadonlySet<string> {
    return this.#urls;
  }

  get size(): number {
    return this.#entries.size;
  }

  #record(
    sourceId: string,
    ref: { documentId: string; title?: string | undefined; url?: string | undefined },
  ): void {
    const key = ledgerKey(sourceId, ref.documentId);
    const existing = this.#entries.get(key);
    this.#entries.set(key, {
      sourceId,
      documentId: ref.documentId,
      title: existing?.title ?? nonEmpty(ref.title),
      url: existing?.url ?? nonEmpty(ref.url),
    });
    if (ref.url !== undefined && ref.url !== "") {
      this.#urls.add(ref.url);
    }
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

/** 除去した URL の置き換え文字列。 */
export const REMOVED_URL_MARKER = "[未検証のURLを削除]";

/** ASCII の URL 構成文字(RFC 3986 の unreserved / reserved と %)。 */
const URL_CHAR = "A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%";
/** URL の直後に付きがちな句読点(URL の一部とみなさない) */
const TRAILING_PUNCTUATION = /[.,;:!?)\]'"]+$/;
/** 許可 URL の出現の直後が境界か(句読点のあと URL 文字が続かない) */
const BOUNDARY_AFTER = new RegExp(`^[.,;:!?)\\]'"]*(?:$|[^${URL_CHAR}])`);
/** Markdown のリンク・画像 `[text](target "title")` */
const MARKDOWN_LINK =
  /(!?)\[([^\]\n]*)\]\(\s*<?([^\s()<>]*)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
/** スキーム付き URL と www. で始まる URL(チャットUIが自動リンクしうるもの) */
const BARE_URL = /(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|www\.)[A-Za-z0-9\-._~:/?#@!$&()*+,;=%]+/g;
/** 保護中の許可 URL の目印(私用領域の文字で囲む。URL 構成文字と衝突しない) */
const TOKEN_OPEN = "";
const TOKEN_CLOSE = "";
const TOKEN_PATTERN = /(\d+)/g;
const WHOLE_TOKEN = /^\d+$/;

export interface UrlSanitization {
  readonly text: string;
  /** 除去した URL の件数 */
  readonly removed: number;
}

/**
 * 回答文中の URL のうち、許可集合(この run で受け取った原典の url)にないものを除去する。
 * 1. 許可 URL の出現を目印に置き換えて保護する(直後が URL の続きでないものに限る。
 *    許可 URL を前置きにした別 URL を通さない)
 * 2. Markdown のリンク・画像で、リンク先が保護された許可 URL でないものを除去する
 *    (リンクは表示文字列だけ残し、画像は丸ごと除去する)
 * 3. 残ったスキーム付き URL・www. URL を除去する
 * 4. 目印を許可 URL に戻す
 */
export function sanitizeAnswerUrls(
  text: string,
  allowedUrls: ReadonlySet<string>,
): UrlSanitization {
  // 表記揺れ(パーセント符号化の有無、ホスト名の大小)も同じ原典として扱う
  const variants = [...allowedUrls].flatMap((url) => [
    url,
    normalizeUrl(url),
    safeDecodeUri(url),
  ]);
  const allowed = [...new Set(variants.filter((url) => url !== ""))].sort(
    (a, b) => b.length - a.length,
  );
  const protectedUrls: string[] = [];
  let working = text;
  for (const url of allowed) {
    working = protectOccurrences(working, url, protectedUrls);
  }

  let removed = 0;
  working = working.replace(
    MARKDOWN_LINK,
    (match: string, bang: string, label: string, target: string) => {
      if (WHOLE_TOKEN.test(target)) {
        return match;
      }
      removed += 1;
      return bang === "!" ? REMOVED_URL_MARKER : `${label}${REMOVED_URL_MARKER}`;
    },
  );
  working = working.replace(BARE_URL, (match: string) => {
    const trailing = TRAILING_PUNCTUATION.exec(match)?.[0] ?? "";
    removed += 1;
    return `${REMOVED_URL_MARKER}${trailing}`;
  });

  const restored = working.replace(TOKEN_PATTERN, (match: string, index: string) => {
    return protectedUrls[Number(index)] ?? match;
  });
  return { text: restored, removed };
}

function safeDecodeUri(url: string): string {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

function protectOccurrences(text: string, url: string, store: string[]): string {
  let result = "";
  let cursor = 0;
  for (;;) {
    const at = text.indexOf(url, cursor);
    if (at === -1) {
      return result + text.slice(cursor);
    }
    const after = text.slice(at + url.length);
    result += text.slice(cursor, at);
    if (BOUNDARY_AFTER.test(after)) {
      store.push(url);
      result += `${TOKEN_OPEN}${store.length - 1}${TOKEN_CLOSE}`;
    } else {
      result += url;
    }
    cursor = at + url.length;
  }
}
