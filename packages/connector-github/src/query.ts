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
 * スニペットの一致箇所を探す語。演算子(AND / OR / NOT と NOT の次の語)、否定(-語)、
 * 括弧、引用符、修飾子(repo: label: など)を除く
 */
export function snippetTerms(query: string): string[] {
  const terms: string[] = [];
  let skipNext = false;
  for (const raw of splitTokens(normalizeQuery(query))) {
    const token = raw.replace(/^\(+/, "").replace(/\)+$/, "");
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
    if (term !== "" && usefulTerm(term) && !terms.includes(term)) {
      terms.push(term);
    }
  }
  return terms;
}
