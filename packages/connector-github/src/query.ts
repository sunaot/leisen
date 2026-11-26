/**
 * GitHub の検索語の扱い: 最小限の正規化と、スニペットの一致箇所を探す語の取り出し
 * (2026-11-25)。構文は GitHub の検索のドキュメント(AND が既定、OR / NOT、引用符、
 * key:value の修飾子)による。
 */

/**
 * 引用符の外の空白(全角空白・タブ・改行を含む)の連続を半角空白 1 つにし、前後を詰める。
 * 引用符の中は変えない(閉じていない引用符のあとは中とみなす)。演算子・修飾子は変えない
 */
export function normalizeQuery(query: string): string {
  let out = "";
  let inQuote = false;
  let pendingSpace = false;
  for (const ch of query) {
    if (!inQuote && /\s/u.test(ch)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && out !== "") {
      out += " ";
    }
    pendingSpace = false;
    if (ch === '"') {
      inQuote = !inQuote;
    }
    out += ch;
  }
  return out.trim();
}

function splitTokens(query: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  for (const ch of query) {
    if (ch === '"') {
      inQuote = !inQuote;
    }
    if (!inQuote && ch === " ") {
      if (current !== "") {
        tokens.push(current);
      }
      current = "";
      continue;
    }
    current += ch;
  }
  if (current !== "") {
    tokens.push(current);
  }
  return tokens;
}

/** issue / PR・コード検索の修飾子(語として扱わない)。 */
const QUALIFIERS = new Set([
  "repo",
  "org",
  "user",
  "owner",
  "author",
  "assignee",
  "mentions",
  "commenter",
  "involves",
  "team",
  "label",
  "milestone",
  "project",
  "is",
  "state",
  "type",
  "reason",
  "in",
  "no",
  "linked",
  "draft",
  "status",
  "head",
  "base",
  "review",
  "reviewed-by",
  "review-requested",
  "user-review-requested",
  "team-review-requested",
  "language",
  "path",
  "filename",
  "extension",
  "size",
  "fork",
  "archived",
  "created",
  "updated",
  "closed",
  "merged",
  "comments",
  "reactions",
  "interactions",
  "sort",
]);

function usefulTerm(term: string): boolean {
  return [...term].length > 1 || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(term);
}

/**
 * スニペットの一致箇所を探す語の数の上限。超えた分は一致箇所の検索に使わないだけで、
 * GitHub に渡す query は変えない(長い query で計算量が増えないようにする)
 */
export const MAX_SNIPPET_TERMS = 32;
/** 一致箇所の検索に使う 1 語の長さの上限(コードポイント数)。超える語は使わない */
export const MAX_SNIPPET_TERM_CHARS = 100;

/**
 * 先頭の `(` の連続と末尾の `)` の連続を除く。正規表現(`/\)+$/` は `)))…)x` で入力長の
 * 二乗の時間がかかる)を使わず、両端から 1 文字ずつ見る
 */
function stripParens(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && token[start] === "(") {
    start += 1;
  }
  while (end > start && token[end - 1] === ")") {
    end -= 1;
  }
  return token.slice(start, end);
}

/** 長さが上限以内か(上限を超えた時点で数えるのをやめる)。 */
function withinTermChars(term: string): boolean {
  let count = 0;
  for (const _ of term) {
    count += 1;
    if (count > MAX_SNIPPET_TERM_CHARS) {
      return false;
    }
  }
  return true;
}

/**
 * スニペットの一致箇所を探す語。演算子(AND / OR / NOT と NOT の次の語)、否定(-語)、
 * 括弧、引用符、修飾子(repo: label: など)を除く。重複を除き、先頭から MAX_SNIPPET_TERMS 語
 * まで(MAX_SNIPPET_TERM_CHARS を超える語は使わない)
 */
export function snippetTerms(query: string): string[] {
  const terms = new Set<string>();
  let skipNext = false;
  for (const raw of splitTokens(normalizeQuery(query))) {
    if (terms.size >= MAX_SNIPPET_TERMS) {
      break;
    }
    const token = stripParens(raw);
    if (token === "") {
      continue;
    }
    if (token === "NOT") {
      skipNext = true;
      continue;
    }
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token === "AND" || token === "OR" || token.startsWith("-")) {
      continue;
    }
    const qualifier = /^([A-Za-z-]+):/u.exec(token);
    if (qualifier !== null && QUALIFIERS.has((qualifier[1] as string).toLowerCase())) {
      continue;
    }
    const term = token.replace(/"/g, "").trim();
    if (term !== "" && withinTermChars(term) && usefulTerm(term)) {
      terms.add(term);
    }
  }
  return [...terms];
}
