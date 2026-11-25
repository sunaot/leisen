/**
 * 一致箇所を含むスニペットの切り出し(ADR-016 の規約: 長さは snippetChars 以内で、
 * MAX_SNIPPET_CHARS を超えない。本文全体を入れない)。
 *
 * 入力は本人の資格情報で取得した検索結果の本文だけで、切り出す位置を変えるだけで量は
 * 増やさない。長さは UTF-16 コード単位(Gateway の MAX_SNIPPET_CHARS 判定と同じ単位)で
 * 数え、サロゲートペアを分断しない。
 */

const ELLIPSIS = "…";
/** 1 語あたりに数える出現の上限(長い本文での計算量を抑える) */
const MAX_OCCURRENCES_PER_TERM = 50;
/**
 * 一致箇所の検索に使う語の数の上限(呼び出し側の snippetTerms も同じ上限で切る。ここでも切り、
 * 語数 × 出現数の組み合わせの計算量を抑える)
 */
const MAX_TERMS = 32;
/** この長さ未満のスニペットでは位置を動かさない(前後の省略記号で中身がなくなる) */
const MIN_WINDOW_CHARS = 20;

interface Occurrence {
  readonly start: number;
  readonly end: number;
  readonly term: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function occurrences(text: string, terms: readonly string[]): Occurrence[] {
  const found: Occurrence[] = [];
  terms.forEach((term, index) => {
    if (term === "") {
      return;
    }
    const pattern = new RegExp(escapeRegExp(term), "giu");
    let count = 0;
    for (const match of text.matchAll(pattern)) {
      found.push({ start: match.index, end: match.index + match[0].length, term: index });
      count += 1;
      if (count >= MAX_OCCURRENCES_PER_TERM) {
        break;
      }
    }
  });
  return found.sort((a, b) => a.start - b.start);
}

function distinctTermsWithin(list: readonly Occurrence[], from: number, to: number): number {
  const seen = new Set<number>();
  for (const occurrence of list) {
    if (occurrence.start >= from && occurrence.end <= to) {
      seen.add(occurrence.term);
    }
  }
  return seen.size;
}

/**
 * スニペットの開始位置。検索語が最も多く(種類の数で)入る範囲を選び、同数なら先に現れる
 * 方にする。本文の先頭から切った場合と同じだけ語が入るなら 0(先頭)。語が本文に
 * なければ 0。大文字・小文字は区別しない
 */
export function matchWindowStart(text: string, terms: readonly string[], maxChars: number): number {
  if (terms.length === 0 || maxChars < MIN_WINDOW_CHARS || text.length <= maxChars) {
    return 0;
  }
  const list = occurrences(text, terms.slice(0, MAX_TERMS));
  if (list.length === 0) {
    return 0;
  }
  // 先頭から切る場合は末尾の省略記号、途中から切る場合は前後の省略記号の分を除く
  const headBest = distinctTermsWithin(list, 0, maxChars - ELLIPSIS.length);
  const span = maxChars - 2 * ELLIPSIS.length;
  const lead = Math.min(60, Math.floor(span / 5));
  let bestStart = 0;
  let bestCount = headBest;
  for (const occurrence of list) {
    const start = Math.max(0, occurrence.start - lead);
    const count = distinctTermsWithin(list, start, start + span);
    if (count > bestCount) {
      bestCount = count;
      bestStart = start;
    }
  }
  return bestStart;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * start(> 0)から maxChars 以内のスニペットを作る。先頭に省略記号を付け、
 * 末尾を切った場合は末尾にも付ける(省略記号を含めて maxChars 以内)
 */
export function windowSnippet(text: string, start: number, maxChars: number): string {
  let from = start;
  if (from > 0 && from < text.length && isLowSurrogate(text.charCodeAt(from))) {
    from += 1;
  }
  const rest = text.slice(from).trimStart();
  const room = maxChars - ELLIPSIS.length;
  if (rest.length <= room) {
    return `${ELLIPSIS}${rest}`;
  }
  let cut = room - ELLIPSIS.length;
  if (cut > 0 && isHighSurrogate(rest.charCodeAt(cut - 1))) {
    cut -= 1;
  }
  return `${ELLIPSIS}${rest.slice(0, cut).trimEnd()}${ELLIPSIS}`;
}
