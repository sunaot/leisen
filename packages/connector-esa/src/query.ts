/**
 * esa の検索語の扱い: 最小限の正規化、スニペットの一致箇所を探す語の取り出し、
 * filters の修飾子を付けるときの括弧(T-026 の改善、2026-11-25)。
 *
 * 構文は esa の検索ヘルプ(docs.esa.io/posts/104)の記述による。リモート MCP 経由での
 * 実機の挙動(AND の厳密さ、括弧の中に書ける記法)は未確認のため、括弧で包むのは
 * ヘルプの例と同じ形(語と OR だけ)に限る。
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

/** 引用符の外の空白で区切る(引用符は語に残す)。正規化済みの検索語を受ける。 */
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

/** 値を照合の語として残す修飾子(記事名・本文・コメントの語)。 */
const TEXT_QUALIFIERS = new Set(["name", "title", "body", "comment", "keyword"]);
/** 語として扱わない修飾子(カテゴリ・タグ・人・日付・状態・数値・並び順)。 */
const OTHER_QUALIFIERS = new Set([
  "full_name",
  "category",
  "in",
  "on",
  "tag",
  "user",
  "updated_by",
  "wip",
  "kind",
  "created",
  "updated",
  "stars",
  "watches",
  "comments",
  "number",
  "done",
  "undone",
  "sort",
]);

function unquote(value: string): string {
  return value.replace(/"/g, "").trim();
}

/** 1 文字の語は漢字・かな以外は使わない(どこにでも一致して位置の手掛かりにならない)。 */
function usefulTerm(term: string): boolean {
  return [...term].length > 1 || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(term);
}

/**
 * スニペットの一致箇所を探す語。演算子(OR、|)、否定(-語)、括弧、引用符、
 * タグ(#)・人(@)、照合の語でない修飾子を除く。title: / body: 等は値を語にする
 */
export function snippetTerms(query: string): string[] {
  const terms: string[] = [];
  for (const raw of splitTokens(normalizeQuery(query))) {
    const token = raw.replace(/^\(+/, "").replace(/\)+$/, "");
    if (token === "" || token === "OR" || token === "|") {
      continue;
    }
    if (token.startsWith("-") || token.startsWith("#") || token.startsWith("@")) {
      continue;
    }
    let term = token;
    const qualifier = /^([A-Za-z_]+):(.*)$/su.exec(token);
    if (qualifier !== null) {
      const key = (qualifier[1] as string).toLowerCase();
      if (TEXT_QUALIFIERS.has(key)) {
        term = qualifier[2] as string;
      } else if (OTHER_QUALIFIERS.has(key)) {
        continue;
      }
    }
    term = unquote(term);
    if (term !== "" && usefulTerm(term) && !terms.includes(term)) {
      terms.push(term);
    }
  }
  return terms;
}

/**
 * filters の修飾子を後ろに付けるとき、検索語を括弧で包むか。
 * esa は「左から順に処理し、() で優先順位を調整できる」(ヘルプ)。`A OR B in:x` は
 * OR と修飾子の結合の順が実機で未確認のため、ヘルプの例(`in:日報 (えさ OR 餌)`)と
 * 同じ形、すなわち OR / | と通常の語だけからなる検索語に限って `(A OR B)` にする。
 * 引用符・括弧・否定・修飾子・タグを含む検索語は包まない(括弧の中での扱いが未確認)
 */
export function shouldParenthesize(query: string): boolean {
  if (query === "" || /["()]/.test(query)) {
    return false;
  }
  const tokens = query.split(" ");
  let hasOr = false;
  for (const token of tokens) {
    if (token === "OR" || token === "|") {
      hasOr = true;
      continue;
    }
    if (/^[-#@]/.test(token) || token.includes(":") || token.includes("|")) {
      return false;
    }
  }
  if (!hasOr) {
    return false;
  }
  // 先頭・末尾の OR、OR の連続は包まない(esa での解釈が分からない形)
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  if (first === "OR" || first === "|" || last === "OR" || last === "|") {
    return false;
  }
  for (let i = 1; i < tokens.length; i += 1) {
    const prev = tokens[i - 1];
    const cur = tokens[i];
    if ((prev === "OR" || prev === "|") && (cur === "OR" || cur === "|")) {
      return false;
    }
  }
  return true;
}
