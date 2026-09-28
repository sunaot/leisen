/**
 * ask ツールの text(Markdown)の組み立て(T-021、ADR-018 決定6: Answer 表示契約の v1)。
 *
 *   {注意書き(outcome が resolved 以外で、本文の先頭に既知の注意書きがないとき)}
 *
 *   {本文(Answer.answer。無害化済みで URL を含まない)}
 *
 *   ## 出典
 *   - [1] {title または documentId}(`{sourceId}:{documentId}`)— {url}
 *   (出典が 0 件なら「出典: なし」)
 *
 *   runId: `{runId}`
 *
 * - 本文は Orchestrator が無害化済み(sanitize.ts: URL・リンク・画像・生の HTML を残さない)。
 *   ここでは手を加えない(改変すると出典の検証と表示がずれる)
 * - 原典へのリンクは出典欄の url だけ。url は `http:` / `https:` の絶対 URL だけを描画し
 *   (javascript: / data: / 相対 URL 等は url を省く)、資格情報(user:pass@)付きは表示上の
 *   ホストと実際の宛先がずれる(`https://trusted@evil/`)ため省く。描画は URL の正規化形
 *   (空白・山括弧を含まない)
 * - title はソース由来の文字列(信頼しない入力)。制御文字・不可視の書式文字を除き、改行を
 *   空白にし、本文と同じ無害化(リンク・画像・HTML・URL の除去)を通してから Markdown の
 *   記号をエスケープする(出典欄の url 以外のリンク・画像を作らせない)。長さも切り詰める
 * - sourceId:documentId はコードスパンで描く(ID に URL らしき文字列があっても自動リンク
 *   されず、Markdown として解釈されない)。title がなければ documentId をラベルにする
 *   (これもコードスパン)
 * - 本文が閉じていないコードフェンス(``` / ~~~)で終わっていれば、閉じるフェンスを1行
 *   足す(出典節と runId がコードブロックに飲み込まれて表示されなくなるのを防ぐ。本文の
 *   内容は変えない)
 * - runId は feedback ツールに渡す識別子。structuredContent を LLM に渡さないクライアント
 *   (text だけを渡すもの)でも feedback を呼べるように text の末尾にも置く
 */
import type { Answer, Citation } from "../answer.js";
import { NO_CITATION_NOTICE } from "../orchestrator.js";
import {
  sanitizeAnswerText,
  stripUnsafeCharacters,
  UNSANITIZABLE_ANSWER_TEXT,
} from "../sanitize.js";

/** outcome: unresolved の本文の先頭に既知の注意書きがないときに付ける注意書き。 */
export const UNRESOLVED_NOTICE =
  "【注意】この質問は解決できませんでした(未解決)。以下は探索した範囲の結果です。";
/** outcome: error の本文の先頭に既知の注意書きがないときに付ける注意書き。 */
export const ERROR_NOTICE = "【注意】回答を生成できませんでした。";

/** 出典節の見出し。 */
export const SOURCES_HEADING = "## 出典";
/** 出典が 0 件のときの行。 */
export const NO_SOURCES_LINE = "出典: なし";

/**
 * 本文の先頭にあれば注意書きを重ねない既知の注意書き(Orchestrator と本モジュールの固定文言)。
 * 「【注意】」で始まるだけの本文(LLM が書いた文)では省かない。
 */
const KNOWN_NOTICES: readonly string[] = [
  NO_CITATION_NOTICE,
  UNSANITIZABLE_ANSWER_TEXT,
  UNRESOLVED_NOTICE,
  ERROR_NOTICE,
];

/** 出典欄に描く title の上限(文字数)。 */
const MAX_TITLE_CHARS = 200;
/** 出典欄に描く sourceId / documentId の上限(文字数)。 */
const MAX_ID_CHARS = 200;

/**
 * Markdown のインライン構文を作りうる ASCII 記号(バックスラッシュでエスケープする)。
 * `&` は含めない(無害化で残した文字参照 `&lt;` をそのまま `<` として表示させるため。
 * 文字参照は CommonMark で構文にならない)。
 */
const MARKDOWN_INLINE_SPECIALS = /[\\`*_[\]<>~|]/g;

function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/** 1行の表示用文字列にする(制御文字・不可視の書式文字を除き、空白類を1つの空白に)。 */
function singleLine(text: string): string {
  return stripUnsafeCharacters(text).replace(/\s+/g, " ").trim();
}

function escapeMarkdownInline(text: string): string {
  return text.replace(MARKDOWN_INLINE_SPECIALS, (c) => `\\${c}`);
}

/** コードスパン(内容のバッククォートの連なりより長いフェンスで囲む)。 */
function codeSpan(text: string): string {
  if (text === "") {
    return "` `";
  }
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** 行頭(空白 0〜3 個)のコードフェンス(CommonMark のフェンスのコードブロック)。 */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * 閉じていないコードフェンスがあれば、閉じるフェンスを足す(CommonMark では閉じていない
 * フェンスは文書の終わりまで続くため、後ろに足す出典節がコードとして表示されてしまう)。
 */
export function closeOpenCodeFence(body: string): string {
  let open: { readonly char: string; readonly length: number } | undefined;
  for (const line of body.split("\n")) {
    const match = FENCE_LINE.exec(line);
    const fence = match?.[1];
    if (fence === undefined) {
      continue;
    }
    const char = fence.charAt(0);
    const rest = match?.[2] ?? "";
    if (open === undefined) {
      // バッククォートのフェンスの info string はバッククォートを含められない(開始行にならない)
      if (!(char === "`" && rest.includes("`"))) {
        open = { char, length: fence.length };
      }
    } else if (char === open.char && fence.length >= open.length && rest.trim() === "") {
      open = undefined;
    }
  }
  return open === undefined ? body : `${body}\n${open.char.repeat(open.length)}`;
}

/** ソース由来の title を出典欄のラベルにする(空になれば undefined)。 */
export function citationTitleLabel(title: string | undefined): string | undefined {
  if (title === undefined) {
    return undefined;
  }
  const sanitized = sanitizeAnswerText(singleLine(title)).text;
  if (sanitized === UNSANITIZABLE_ANSWER_TEXT) {
    return undefined;
  }
  const label = truncate(singleLine(sanitized), MAX_TITLE_CHARS);
  return label === "" ? undefined : escapeMarkdownInline(label);
}

/**
 * 出典欄に描いてよい url(http / https の絶対 URL、資格情報なし)の正規化形。
 * それ以外は undefined(url を省く)。
 */
export function displayableSourceUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return undefined;
  }
  if (url.username !== "" || url.password !== "") {
    return undefined;
  }
  return url.href;
}

/** 出典1件の行。 */
export function renderCitationLine(citation: Citation, index: number): string {
  const sourceId = truncate(singleLine(citation.sourceId), MAX_ID_CHARS);
  const documentId = truncate(singleLine(citation.documentId), MAX_ID_CHARS);
  const label = citationTitleLabel(citation.title) ?? codeSpan(documentId);
  const url = displayableSourceUrl(citation.url);
  return `- [${index + 1}] ${label}(${codeSpan(`${sourceId}:${documentId}`)})${
    url !== undefined ? `— ${url}` : ""
  }`;
}

/** 出典節(見出し + 各行。0 件なら「出典: なし」)。 */
export function renderSourcesSection(citations: readonly Citation[]): string {
  const lines =
    citations.length === 0
      ? [NO_SOURCES_LINE]
      : citations.map((citation, index) => renderCitationLine(citation, index));
  return [SOURCES_HEADING, ...lines].join("\n");
}

/** outcome に応じた注意書き(本文の先頭に既知の注意書きがあれば付けない)。 */
function noticeFor(answer: Answer, body: string): string | undefined {
  if (answer.outcome === "resolved") {
    return undefined;
  }
  if (KNOWN_NOTICES.some((notice) => body.startsWith(notice))) {
    return undefined;
  }
  return answer.outcome === "error" ? ERROR_NOTICE : UNRESOLVED_NOTICE;
}

/** ask ツールの text(Markdown)を組み立てる。 */
export function renderAnswerMarkdown(answer: Answer): string {
  const body = closeOpenCodeFence(answer.answer.trim());
  const notice = noticeFor(answer, body);
  return [
    ...(notice !== undefined ? [notice] : []),
    ...(body !== "" ? [body] : []),
    renderSourcesSection(answer.citations),
    `runId: ${codeSpan(answer.runId)}`,
  ].join("\n\n");
}
