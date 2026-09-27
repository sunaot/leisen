/**
 * テキスト処理: snippet の切り詰め、本文のページ分割、base64 本文のテキスト判定。
 * 長さはすべて UTF-16 コード単位(String.prototype.length。Gateway の
 * MAX_SNIPPET_CHARS 判定と同じ単位)で数え、サロゲートペアを分断しない。
 */

const ELLIPSIS = "…";
/** git と同じ判定: 先頭 8000 バイトに NUL があればバイナリとみなす */
const BINARY_PROBE_BYTES = 8000;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** end の直前が上位サロゲートなら1つ手前で切る(ペアの分断防止)。 */
function safeCut(text: string, end: number, start = 0): number {
  if (
    end > start + 1 &&
    end < text.length &&
    isHighSurrogate(text.charCodeAt(end - 1))
  ) {
    return end - 1;
  }
  return end;
}

/**
 * maxChars 以内に切り詰める。切り詰めた場合は末尾を「…」にする
 * (「…」を含めて maxChars 以内)。
 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= ELLIPSIS.length) {
    return text.slice(0, safeCut(text, Math.max(0, maxChars)));
  }
  const cut = safeCut(text, maxChars - ELLIPSIS.length);
  return `${text.slice(0, cut).trimEnd()}${ELLIPSIS}`;
}

/** 連続する空白・改行を1つの空白にまとめる(snippet 用)。 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** issue テンプレート等の HTML コメントを除く(snippet 用)。 */
export function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, " ");
}

export interface TextPage {
  readonly content: string;
  readonly hasNext: boolean;
}

/**
 * 本文を pageChars ごとのページに分け、pageIndex(0始まり)のページを返す。
 * 範囲外なら undefined。空本文は空の1ページとして扱う。
 */
export function pageOfText(
  text: string,
  pageChars: number,
  pageIndex: number,
): TextPage | undefined {
  let start = 0;
  for (let index = 0; ; index += 1) {
    const end = safeCut(text, Math.min(start + pageChars, text.length), start);
    if (index === pageIndex) {
      return { content: text.slice(start, end), hasNext: end < text.length };
    }
    if (end >= text.length) {
      return undefined;
    }
    start = end;
  }
}

/**
 * base64 本文をテキストとして復号する。バイナリ(NUL を含む)または
 * 不正な UTF-8 なら undefined。BOM は除く。
 */
export function decodeBase64Text(content: string): string | undefined {
  const bytes = Buffer.from(content, "base64");
  if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
