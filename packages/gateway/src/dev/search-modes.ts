/**
 * 開発用コネクタ(dev-fixture)の検索方式。評価用に、実ソースの検索の仕様を模した方式を選べる
 * (settings.searchMode)。どの方式も合成コーパスだけを対象にし、実ソースには接続しない。
 *
 * - default: 現行の方式。空白区切りの全語 AND の部分一致、タイトル一致の多い順 → 更新の新しい順、
 *   スニペットは一致箇所の周辺(既存のテスト・dev-eval の前提。変えない)
 * - esa: 空白は AND、大文字の OR・引用符の語句・title: を解釈、タイトル一致を優遇、スニペットは本文の先頭
 * - redmine: 部分一致、先頭 5 語だけを使い残りは捨てる、関連度なしの更新日降順、AND / OR は設定、
 *   スニペットは本文の先頭、フィルタ非対応
 * - github: 空白は AND、issue / pull request / コードを種別ごとに検索して交互に並べる
 *   (種別の配分・カーソルはコネクタ側。fixture-connector.ts)
 *
 * 各方式の仕様は、describe の summary の日本語の文(searchModeSpec)と、検索プロファイル
 * (searchModeProfile。ADR-025)の一方または両方で伝える(settings.specDelivery)。実ソースの挙動を
 * 確かめたものではなく、調査(reports/エージェント検索ハーネス設計調査)の読解に基づく模擬である。
 * 検索プロファイルの根拠を tested とするのは、模擬の実装そのものが仕様であるため。
 */
import {
  ConnectorError,
  MAX_SNIPPET_CHARS,
  type SearchNotice,
  type SearchProfile,
} from "@leisen/connector-sdk";

export const DEV_FIXTURE_SEARCH_MODES = ["default", "esa", "redmine", "github"] as const;
export type DevFixtureSearchMode = (typeof DEV_FIXTURE_SEARCH_MODES)[number];

/** GitHub 型で使う文書の種別(省略時 issue)。 */
export const DEV_FIXTURE_DOCUMENT_KINDS = ["issue", "pull_request", "code"] as const;
export type DevFixtureDocumentKind = (typeof DEV_FIXTURE_DOCUMENT_KINDS)[number];

/** 一致箇所の周辺のスニペットの長さと、一致箇所より前に含める文字数(default / github のコード)。 */
const SNIPPET_LENGTH = 160;
const SNIPPET_LEADING_CONTEXT = 40;
/** esa 型のスニペット(本文の先頭)の長さ。connector-esa の toPlainSnippet と同じ */
export const ESA_SNIPPET_CHARS = 300;
/** Redmine 型が使う語の数の上限(6 語目以降は捨てる) */
export const REDMINE_MAX_TOKENS = 5;

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** クエリを空白(全角空白を含む)で分割し、語ごとの大文字小文字無視パターンにする。 */
export function termPatterns(query: string): RegExp[] {
  return query
    .split(/\s+/u)
    .filter((term) => term.length > 0)
    .map((term) => new RegExp(escapeRegExp(term), "iu"));
}

/** サロゲートペアを分断しない [start, end) に調整する。 */
function surrogateSafeRange(text: string, start: number, end: number): [number, number] {
  const isLow = (i: number) => {
    const c = text.charCodeAt(i);
    return c >= 0xdc00 && c <= 0xdfff;
  };
  const isHigh = (i: number) => {
    const c = text.charCodeAt(i);
    return c >= 0xd800 && c <= 0xdbff;
  };
  const safeStart = start > 0 && isLow(start) ? start - 1 : start;
  const safeEnd = end < text.length && end > 0 && isHigh(end - 1) ? end - 1 : end;
  return [safeStart, safeEnd];
}

function normalizeSpace(content: string): string {
  return content.replace(/\s+/gu, " ").trim();
}

/**
 * 一致箇所(最初に現れる語)の周辺を切り出す。本文に一致がない(タイトルのみの
 * 一致)場合は本文の先頭。本文全体は返さない(ADR-016)。
 */
export function matchSnippet(content: string, patterns: readonly RegExp[]): string {
  const text = normalizeSpace(content);
  let first = -1;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && (first === -1 || match.index < first)) {
      first = match.index;
    }
  }
  const from = first <= SNIPPET_LEADING_CONTEXT ? 0 : first - SNIPPET_LEADING_CONTEXT;
  const [start, end] = surrogateSafeRange(text, from, Math.min(text.length, from + SNIPPET_LENGTH));
  const snippet =
    (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
  return snippet.length > MAX_SNIPPET_CHARS ? snippet.slice(0, MAX_SNIPPET_CHARS) : snippet;
}

/** 本文の先頭を最大 maxChars 文字(省略記号を含む)で切り出す。検索語の位置は見ない。 */
export function headSnippet(content: string, maxChars: number): string {
  const text = normalizeSpace(content);
  const limit = Math.min(maxChars, MAX_SNIPPET_CHARS);
  if (text.length <= limit) {
    return text;
  }
  const [, end] = surrogateSafeRange(text, 0, limit - 1);
  return `${text.slice(0, end)}…`;
}

/** 1 回の search の照合と並べ方(方式ごと)。 */
export interface QueryPlan {
  /** タイトルと本文が一致するか */
  readonly matches: (title: string, content: string) => boolean;
  /** relevance の並べ方で使う、タイトルに一致した語(語の組)の数 */
  readonly titleScore: (title: string) => number;
  /** relevance: タイトル一致の多い順 → 更新の新しい順 / updated: 更新の新しい順だけ */
  readonly order: "relevance" | "updated";
  readonly snippet: (content: string, kind: DevFixtureDocumentKind) => string;
}

export interface QueryPlanOptions {
  /** Redmine 型: true ならすべての語を含む(AND)、false ならいずれかの語を含む(OR) */
  readonly redmineAllWords: boolean;
}

function emptyQueryError(): ConnectorError {
  return new ConnectorError("invalid_request", "query must contain at least one search term");
}

function andPlan(query: string, snippet: QueryPlan["snippet"] | undefined): QueryPlan {
  const patterns = termPatterns(query);
  if (patterns.length === 0) {
    throw emptyQueryError();
  }
  return {
    matches: (title, content) => patterns.every((p) => p.test(title) || p.test(content)),
    titleScore: (title) => patterns.filter((p) => p.test(title)).length,
    order: "relevance",
    snippet: snippet ?? ((content) => matchSnippet(content, patterns)),
  };
}

// ---------------------------------------------------------------------------
// esa 型
// ---------------------------------------------------------------------------

interface EsaTerm {
  readonly pattern: RegExp;
  /** title: で始まる語(タイトルだけを対象にする) */
  readonly titleOnly: boolean;
}

/** esa 型のクエリの語(引用符の語句・title:・OR)を切り出す。 */
const ESA_TOKEN = /(title:)?"([^"]*)"|(\S+)/gu;

/**
 * esa 型のクエリを AND で結ぶ語の組(各組は OR で結ぶ語)に分ける。OR は AND より先に結び付く
 * (「a b OR c d」は a かつ (b または c) かつ d)。先頭・末尾・連続の OR は無視する。
 */
export function parseEsaQuery(query: string): EsaTerm[][] {
  const tokens: (EsaTerm | "OR")[] = [];
  for (const match of query.matchAll(ESA_TOKEN)) {
    const [, quotedPrefix, quoted, bare] = match;
    if (quoted !== undefined) {
      if (quoted.trim() !== "") {
        tokens.push({ pattern: new RegExp(escapeRegExp(quoted), "iu"), titleOnly: quotedPrefix !== undefined });
      }
      continue;
    }
    if (bare === undefined) {
      continue;
    }
    if (bare === "OR") {
      tokens.push("OR");
      continue;
    }
    const titleOnly = bare.toLowerCase().startsWith("title:");
    const text = titleOnly ? bare.slice("title:".length) : bare;
    if (text !== "") {
      tokens.push({ pattern: new RegExp(escapeRegExp(text), "iu"), titleOnly });
    }
  }
  const groups: EsaTerm[][] = [];
  let joinNext = false;
  for (const token of tokens) {
    if (token === "OR") {
      joinNext = groups.length > 0;
      continue;
    }
    const last = groups[groups.length - 1];
    if (joinNext && last !== undefined) {
      last.push(token);
    } else {
      groups.push([token]);
    }
    joinNext = false;
  }
  return groups;
}

function esaPlan(query: string): QueryPlan {
  const groups = parseEsaQuery(query);
  if (groups.length === 0) {
    throw emptyQueryError();
  }
  const termMatches = (term: EsaTerm, title: string, content: string) =>
    term.pattern.test(title) || (!term.titleOnly && term.pattern.test(content));
  return {
    matches: (title, content) =>
      groups.every((group) => group.some((term) => termMatches(term, title, content))),
    titleScore: (title) =>
      groups.filter((group) => group.some((term) => term.pattern.test(title))).length,
    order: "relevance",
    snippet: (content) => headSnippet(content, ESA_SNIPPET_CHARS),
  };
}

// ---------------------------------------------------------------------------
// Redmine 型
// ---------------------------------------------------------------------------

const REDMINE_TOKEN = /"([^"]+)"|(\S+)/gu;

/**
 * Redmine 型のクエリの語。引用符の語句は 1 語。重複と 1 文字の語を除き、先頭 5 語だけを使う
 * (Redmine の検索の語の切り出しを模す)。
 */
export function redmineTokens(query: string): string[] {
  const tokens: string[] = [];
  for (const match of query.matchAll(REDMINE_TOKEN)) {
    const token = (match[1] ?? match[2] ?? "").trim();
    if (Array.from(token).length > 1 && !tokens.includes(token)) {
      tokens.push(token);
    }
  }
  return tokens.slice(0, REDMINE_MAX_TOKENS);
}

function redminePlan(query: string, options: QueryPlanOptions): QueryPlan | "no_terms" {
  if (query.trim() === "") {
    throw emptyQueryError();
  }
  const patterns = redmineTokens(query).map((token) => new RegExp(escapeRegExp(token), "iu"));
  if (patterns.length === 0) {
    // Redmine は使える語がなければ結果を返さない(エラーにはしない)
    return "no_terms";
  }
  const hit = (p: RegExp, title: string, content: string) => p.test(title) || p.test(content);
  return {
    matches: options.redmineAllWords
      ? (title, content) => patterns.every((p) => hit(p, title, content))
      : (title, content) => patterns.some((p) => hit(p, title, content)),
    titleScore: () => 0,
    order: "updated",
    snippet: (content) => headSnippet(content, MAX_SNIPPET_CHARS),
  };
}

// ---------------------------------------------------------------------------

/**
 * 方式ごとの照合を組み立てる。語がない(空白だけの)クエリは invalid_request。Redmine 型で
 * 使える語が残らなかったときは "no_terms"(結果なし)。
 */
export function planQuery(
  mode: DevFixtureSearchMode,
  query: string,
  options: QueryPlanOptions,
): QueryPlan | "no_terms" {
  switch (mode) {
    case "default":
      return andPlan(query, undefined);
    case "esa":
      return esaPlan(query);
    case "redmine":
      return redminePlan(query, options);
    case "github": {
      const patterns = termPatterns(query);
      return andPlan(query, (content, kind) =>
        kind === "code" ? matchSnippet(content, patterns) : headSnippet(content, MAX_SNIPPET_CHARS),
      );
    }
  }
}

/** 方式ごとの既定の件数(GitHub 型は connector-github と同じ 20)。 */
export function defaultSearchLimit(mode: DevFixtureSearchMode): number {
  return mode === "github" ? 20 : 10;
}

// ---------------------------------------------------------------------------
// 検索プロファイルと検索の通知(connector-sdk v0.6、ADR-025)
// ---------------------------------------------------------------------------

/**
 * 検索の仕様の伝え方(settings.specDelivery。評価用)。
 * - summary: summary の自由文だけ(検索プロファイルと通知を返さない)
 * - both: 自由文 + 検索プロファイル + 通知
 * - profile: 検索プロファイル + 通知だけ(summary は内容の説明だけ)
 */
export const DEV_FIXTURE_SPEC_DELIVERIES = ["summary", "both", "profile"] as const;
export type DevFixtureSpecDelivery = (typeof DEV_FIXTURE_SPEC_DELIVERIES)[number];

/**
 * 伝え方の既定: 既定の検索方式は検索プロファイルを返す(summary に検索の仕様の文はない)、
 * 模擬の方式は summary の自由文だけ(T-027 の計測の条件を変えない)。
 */
export function defaultSpecDelivery(mode: DevFixtureSearchMode): DevFixtureSpecDelivery {
  return mode === "default" ? "both" : "summary";
}

/**
 * 既定の検索方式の検索プロファイル。search の実装(空白区切りの全語 AND の部分一致、タイトル一致の
 * 多い順 → 更新の新しい順、一致箇所の周辺のスニペット)そのものなので、根拠は tested。演算子・
 * 修飾子・引用符は解釈せず、記号も語として照合する。語数・文字数の上限はない(項目を書かない)
 */
export const DEFAULT_MODE_SEARCH_PROFILE: SearchProfile = {
  termJoin: { value: "and", basis: "tested" },
  matchUnit: { value: "substring", basis: "tested" },
  naturalLanguage: { value: "unsupported", basis: "tested" },
  phraseQuote: { value: "unsupported", basis: "tested" },
  operators: { value: [], basis: "tested" },
  qualifiers: { value: [], basis: "tested" },
  ranking: { value: "recency", basis: "tested" },
  titleBoost: { value: true, basis: "tested" },
  snippet: { value: "match_context", basis: "tested" },
};

/**
 * esa 型の模擬(esaPlan)の検索プロファイル。空白は AND、OR(大文字)・引用符の語句・title: を
 * 解釈し、それ以外の記法(-語、( )、in: などの修飾子)は文字として照合する。タイトル一致の多い順
 * → 更新の新しい順、スニペットは本文の先頭。実装そのものが仕様なので根拠は tested(実際の esa の
 * 挙動を確かめたものではない)
 */
export const ESA_MODE_SEARCH_PROFILE: SearchProfile = {
  termJoin: { value: "and", basis: "tested" },
  matchUnit: { value: "substring", basis: "tested" },
  naturalLanguage: { value: "unsupported", basis: "tested" },
  phraseQuote: { value: "supported", basis: "tested" },
  operators: { value: ["or"], basis: "tested" },
  qualifiers: { value: [{ name: "title", target: "title" }], basis: "tested" },
  ranking: { value: "recency", basis: "tested" },
  titleBoost: { value: true, basis: "tested" },
  snippet: { value: "leading_text", basis: "tested" },
};

/**
 * Redmine 型の模擬(redminePlan)の検索プロファイル。部分一致、引用符の語句は 1 語、先頭 5 語だけを
 * 使い残りは黙って捨てる、関連度もタイトルの優遇もない更新の新しい順、スニペットは本文の先頭。
 * 語の結合は設定(redmineAllWords)による。根拠は tested(実際の Redmine を確かめたものではない)
 */
export function redmineModeSearchProfile(allWords: boolean): SearchProfile {
  return {
    termJoin: { value: allWords ? "and" : "or", basis: "tested" },
    matchUnit: { value: "substring", basis: "tested" },
    naturalLanguage: { value: "unsupported", basis: "tested" },
    phraseQuote: { value: "supported", basis: "tested" },
    operators: { value: [], basis: "tested" },
    qualifiers: { value: [], basis: "tested" },
    maxTerms: { value: { limit: REDMINE_MAX_TOKENS, overflow: "dropped" }, basis: "tested" },
    ranking: { value: "recency", basis: "tested" },
    titleBoost: { value: false, basis: "tested" },
    snippet: { value: "leading_text", basis: "tested" },
  };
}

/**
 * GitHub 型の模擬の検索プロファイル。空白は AND の部分一致(引用符・演算子・修飾子は解釈しない)、
 * 種類の中でタイトル(パス)一致の多い順 → 更新の新しい順、スニペットは種類による(issue と PR は
 * 本文の先頭、コードは一致箇所の周辺)。根拠は tested(実際の GitHub を確かめたものではない)
 */
export const GITHUB_MODE_SEARCH_PROFILE: SearchProfile = {
  termJoin: { value: "and", basis: "tested" },
  matchUnit: { value: "substring", basis: "tested" },
  naturalLanguage: { value: "unsupported", basis: "tested" },
  phraseQuote: { value: "unsupported", basis: "tested" },
  operators: { value: [], basis: "tested" },
  qualifiers: { value: [], basis: "tested" },
  ranking: { value: "recency", basis: "tested" },
  titleBoost: { value: true, basis: "tested" },
  snippet: { value: "mixed", basis: "tested" },
};

/** 方式ごとの検索プロファイル(利用者によらない定数。ADR-025 決定3)。 */
export function searchModeProfile(
  mode: DevFixtureSearchMode,
  options: QueryPlanOptions,
): SearchProfile {
  switch (mode) {
    case "default":
      return DEFAULT_MODE_SEARCH_PROFILE;
    case "esa":
      return ESA_MODE_SEARCH_PROFILE;
    case "redmine":
      return redmineModeSearchProfile(options.redmineAllWords);
    case "github":
      return GITHUB_MODE_SEARCH_PROFILE;
  }
}

/** Redmine 型で、使う語の候補(重複と 1 文字の語を除いた後、上限で切る前)の数。 */
function redmineCandidateCount(query: string): number {
  const tokens = new Set<string>();
  for (const match of query.matchAll(REDMINE_TOKEN)) {
    const token = (match[1] ?? match[2] ?? "").trim();
    if (Array.from(token).length > 1) {
      tokens.add(token);
    }
  }
  return tokens.size;
}

/** esa 型が解釈せず文字として照合する修飾子の形(title: 以外の「名前:」)。 */
const ESA_UNSUPPORTED_QUALIFIER = /^[a-z][a-z_]{0,15}:/u;

/**
 * esa 型の模擬が解釈しない記法を含むか: 引用符の外の語のうち、title: 以外の修飾子の形(in: など)、
 * 語の前の -、( )。いずれも模擬では文字として照合する。
 */
function esaHasUninterpretedSyntax(query: string): boolean {
  for (const match of query.matchAll(ESA_TOKEN)) {
    const bare = match[3];
    if (bare === undefined) {
      continue;
    }
    const qualifier = ESA_UNSUPPORTED_QUALIFIER.exec(bare);
    if (qualifier !== null && qualifier[0].toLowerCase() !== "title:") {
      return true;
    }
    if (/^-\S/u.test(bare) || bare.startsWith("(") || bare.endsWith(")")) {
      return true;
    }
  }
  return false;
}

/**
 * 模擬の検索が返す通知(ADR-025 決定4)。query の形だけから作る(認可前の候補の有無・件数を
 * 使わない。ADR-012)。
 * - Redmine 型: 使える語が上限(5 語)を超えたとき terms_dropped(keptTerms = 5)
 * - esa 型: 解釈しない記法(title: 以外の修飾子、-語、( ))を含むとき operator_ignored
 * - 既定・GitHub 型: 語を捨てる・指定を無視する処理がないため、通知はない
 */
export function searchModeNotices(mode: DevFixtureSearchMode, query: string): SearchNotice[] {
  switch (mode) {
    case "redmine":
      return redmineCandidateCount(query) > REDMINE_MAX_TOKENS
        ? [{ kind: "terms_dropped", keptTerms: REDMINE_MAX_TOKENS }]
        : [];
    case "esa":
      return esaHasUninterpretedSyntax(query) ? [{ kind: "operator_ignored" }] : [];
    case "default":
    case "github":
      return [];
  }
}

/**
 * describe の summary に足す検索の仕様(日本語)。default は現行の summary を変えないため空。
 */
export function searchModeSpec(mode: DevFixtureSearchMode, options: QueryPlanOptions): string {
  switch (mode) {
    case "default":
      return "";
    case "esa":
      return (
        "検索の仕様(esa 型を模した開発用の方式): 空白で区切った語は、すべてを含む文書だけを返す(AND)。" +
        "語と語の間に大文字の OR を置くと、前後の語のどちらかを含めばよい(OR は AND より先に結び付く。" +
        "例: 「経費 OR 交通費 申請」は「経費または交通費」かつ「申請」)。" +
        '引用符で囲んだ語句("経費 精算")は空白も含めてそのまま一致させる。' +
        "title:語 はタイトルに含む文書だけに絞る(title:\"語句\" も可)。" +
        "一致は大文字小文字を区別しない部分一致で、表記ゆれ(長音・全角と半角・同義語)は吸収しない。" +
        "並び順はタイトルに一致した語の数が多い順、次に更新の新しい順。" +
        `スニペットは本文の先頭(最大 ${ESA_SNIPPET_CHARS} 字)で、一致箇所とは限らない。` +
        "filters は updatedAfter / updatedBefore / container / author に対応する。"
      );
    case "redmine":
      return (
        "検索の仕様(Redmine 型を模した開発用の方式): 空白で区切った語(引用符で囲んだ語句は 1 語)から、" +
        `重複と 1 文字の語を除いた先頭 ${REDMINE_MAX_TOKENS} 語だけを使い、残りの語は捨てる。` +
        "一致はタイトルと本文の、大文字小文字を区別しない部分一致。" +
        (options.redmineAllWords
          ? "すべての語を含む文書だけを返す(AND)。"
          : "いずれかの語を含む文書を返す(OR)。語を足すほど結果は増える。") +
        "関連度による並べ替えはなく、更新の新しい順に並ぶ(語を足しても目的の文書が上に来るとは限らない)。" +
        `スニペットは本文の先頭(最大 ${MAX_SNIPPET_CHARS} 字)で、一致箇所とは限らない。` +
        "filters には対応しない(指定すると invalid_request)。"
      );
    case "github":
      return (
        "検索の仕様(GitHub 型を模した開発用の方式): issue・pull request・コードの 3 種類を別々に検索し、" +
        "種類ごとの結果を交互に並べて返す。1 回の件数の枠を種類ごとにほぼ等分するため、" +
        "ある種類の結果が少なくても他の種類の枠は増えない。種類を選ぶ指定はない。" +
        "ヒットの meta.type に種類(issue / pull_request / code)が入る。" +
        "空白で区切った語は、すべてを含む文書だけを返す(AND。大文字小文字を区別しない部分一致)。" +
        "種類の中では、タイトル(コードはファイルのパス)に一致した語の数が多い順、次に更新の新しい順。" +
        `スニペットは issue と pull request が本文の先頭(最大 ${MAX_SNIPPET_CHARS} 字)、コードが一致箇所の周辺。` +
        "filters.author / updatedAfter / updatedBefore を指定するとコードは検索しない。" +
        `既定の件数は ${defaultSearchLimit("github")}。`
      );
  }
}
