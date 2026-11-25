/**
 * Redmine の検索語の扱い: 最小限の正規化と、スニペットの一致箇所を探す語の取り出し
 * (2026-11-25)。語の分け方は Redmine 本体の Redmine::Search::Tokenizer(lib/redmine/search.rb)
 * に合わせる: `"…"` の語句は 1 語、ほかは空白(\p{Zs})区切り、重複を除き、1 文字の語は
 * 漢字のみ残し、先頭の 5 語だけを使う。全文検索プラグインがある導入先では異なりうる。
 */

import type { SearchNotice } from "@leisen/connector-sdk";

/** Redmine が使う語の数の上限(Tokenizer::MAX_TOKENS) */
export const REDMINE_MAX_TOKENS = 5;

/**
 * 引用符の外の空白(全角空白・タブ・改行を含む)の連続を半角空白 1 つにし、前後を詰める。
 * 引用符の中は変えない(閉じていない引用符のあとは中とみなす)。Redmine 5.1 以降は全角空白も
 * 区切りとして扱うため、5.1 以降での語の分け方は変わらない(それより前の版では全角空白が
 * 区切りになる)
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

/**
 * Redmine の Tokenizer と同じ規則で語を取り出す(重複を除き、漢字以外の 1 文字の語を除く)。
 * 先頭の REDMINE_MAX_TOKENS 語に切る前の全体
 */
export function searchTokens(query: string): string[] {
  const tokens = [...query.matchAll(/"[^"]+"|[^\p{Zs}]+/gu)].map((match) =>
    match[0].replace(/^"\p{Zs}*|\p{Zs}*"$/gu, ""),
  );
  return [...new Set(tokens)].filter(
    (token) => [...token].length > 1 || /\p{Script=Han}/u.test(token),
  );
}

/** Redmine の Tokenizer と同じ規則で、スニペットの一致箇所を探す語を取り出す。 */
export function snippetTerms(query: string): string[] {
  return searchTokens(query).slice(0, REDMINE_MAX_TOKENS);
}

/**
 * 検索の通知(connector-sdk v0.6、ADR-025 決定4)。Redmine は先頭の REDMINE_MAX_TOKENS 語だけを
 * 使い残りを黙って捨てる(Redmine 本体のソースによる。実機では未確認)ので、query から数えた語が
 * 上限を超えるときに terms_dropped を返す。query だけから作り、検索の結果(件数を含む)には
 * よらない(ADR-012)
 */
export function searchNoticesFor(query: string): SearchNotice[] {
  return searchTokens(query).length > REDMINE_MAX_TOKENS
    ? [{ kind: "terms_dropped", keptTerms: REDMINE_MAX_TOKENS }]
    : [];
}
