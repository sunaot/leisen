/**
 * 回答本文の無害化(T-007 セキュリティレビュー 2026-09-27 M1、RS-4 / TM-D2)。
 *
 * 契約: **回答本文(Answer.answer)には URL を一切残さない。** 原典へのリンクは
 * citations[].url(ツール結果の値、citations.ts の証拠台帳)からのみ、利用側
 * (チャットUI・CLI)が描画する。回答中の画像・リンクの URL(クエリ文字列等)に機密を
 * 積んで外部へ送る経路(インジェクションによる exfiltration)を、許可リスト方式ではなく
 * 「本文には URL を置かない」構造で塞ぐ(旧実装の許可リスト+目印による保護は、参照定義・
 * 入れ子の括弧・実体参照・自動リンク・目印の偽造で迂回できた)。
 *
 * 手順(sanitizeAnswerText):
 * 1. 私用領域・制御文字・不可視の書式文字・孤立サロゲートを除く(タブと改行は残す)。
 *    目印の偽造や、見えない文字で URL を検出器から隠す経路を断つ
 * 2. Markdown のリンク・画像(inline / 参照形式、入れ子の角括弧・山括弧・括弧を含む宛先)
 *    をリンクテキスト(画像は代替テキスト)だけにし、参照定義の行を削除する。
 *    リンクにならなかった `![` の `!` は落とす(本文に画像の構文を残さない)
 * 3. 生の HTML(タグ・コメント・宣言・処理命令・CDATA・`<scheme:…>` 自動リンク)を
 *    除去し、残った `<` `>` を文字参照にエスケープする(行頭の引用記号 `>` は残す)。
 *    2・3 はコード(フェンスのコードブロック・インラインのコードスパン)の外だけに
 *    適用する(コード片を壊さない)
 * 4. URL らしき文字列を検出して除去する(コードの内外を問わない): 任意の `scheme://`、
 *    `//` なしでも絶対 URL・危険な動作になるスキーム(`http:evil`・`mailto:`・
 *    `javascript:` 等)、`www.`(大小文字無視)、プロトコル相対の `//host`、
 *    `label.tld/path`・`label.tld?query` 形式。検出は影の文字列(文字参照の復号・
 *    Markdown のバックスラッシュエスケープの解除・`\` を `/` とみなす・NFKC 正規化)の上で
 *    行い、元の文字列の対応範囲を除去する(`https&#58;//`・`https\://`・全角文字で
 *    組んだ URL も検出する)
 * 5. 最終検証(fail-closed): 結果に 2〜4 をもう一度かけ、変化があればそれも除去して
 *    件数を residual に数える(呼び出し側が warnings に記録する)。収束しなければ本文を
 *    固定文言に置き換える
 *
 * 既知の限界(README「既知の限界」): スキーム・`www.`・`//`・パス/クエリのない裸の
 * ドメイン名(`evil.example`)とメールアドレスは残す(ファイル名等と区別できない)。
 * 利用側は fuzzy な自動リンク(裸のドメインのリンク化)を無効にし、外部画像を自動取得
 * しない(T-009)。検出は保守的なため、`Node.js/Express` のような表記も除去されうる。
 */

/** 除去した URL の置き換え文字列(全角の括弧: Markdown の構文にならない)。 */
export const REMOVED_URL_MARKER = "［URL削除］";

/** 最終検証が収束しなかった場合の本文(fail-closed。通常は到達しない)。 */
export const UNSANITIZABLE_ANSWER_TEXT =
  "【注意】回答本文から URL を除去しきれなかったため、本文を表示しません。出典から原典を確認してください。";

export interface AnswerTextSanitization {
  readonly text: string;
  /** 手順 2〜4 で無害化したリンク・画像・参照定義・HTML・URL の件数 */
  readonly removed: number;
  /** 最終検証(手順 5)で追加に無害化した件数。0 以外は検出器の取りこぼしを示す */
  readonly residual: number;
}

export interface TextRewrite {
  readonly text: string;
  /** 無害化した箇所の件数 */
  readonly removed: number;
}

/** 最終検証の上限回数(各回は本文を短くするか変化なしで終わる)。 */
const MAX_VERIFY_PASSES = 5;
/** ラベルの再帰処理の深さの上限(入れ子のリンク・画像)。超えた分は括弧ごと文字列として扱う */
const MAX_LABEL_DEPTH = 8;
/** 1つのリンクとして探索する範囲の上限(文字数)。長大な入力で探索を二乗にしない */
const MAX_LINK_SCAN = 4_000;

/**
 * 回答本文を無害化する(手順 1〜5)。戻り値の text には URL らしき文字列・Markdown の
 * リンク/画像・生の HTML が残らない。
 */
export function sanitizeAnswerText(input: string): AnswerTextSanitization {
  const stripped = stripUnsafeCharacters(input);
  const markup = neutralizeMarkup(stripped);
  const urls = removeUrlLike(markup.text);
  const verified = verifyAnswerText(urls.text);
  return {
    text: verified.text,
    removed: markup.removed + urls.removed,
    residual: verified.removed,
  };
}

/**
 * 最終検証(手順 5、fail-closed): 本文に手順 2〜4 をかけ直し、変化がなくなるまで
 * (最大 MAX_VERIFY_PASSES 回)繰り返す。変化した箇所の件数を removed に返す。
 * 収束しなければ本文を固定文言(UNSANITIZABLE_ANSWER_TEXT)に置き換える。
 */
export function verifyAnswerText(input: string): TextRewrite {
  let current = stripUnsafeCharacters(input);
  let removed = current === input ? 0 : 1;
  for (let pass = 0; pass < MAX_VERIFY_PASSES; pass += 1) {
    const markup = neutralizeMarkup(current);
    const urls = removeUrlLike(markup.text);
    if (urls.text === current) {
      return { text: current, removed };
    }
    removed += Math.max(1, markup.removed + urls.removed);
    current = urls.text;
  }
  return { text: UNSANITIZABLE_ANSWER_TEXT, removed: removed + 1 };
}

// ---------------------------------------------------------------------------
// 1. 文字の除去
// ---------------------------------------------------------------------------

/**
 * 制御文字(Cc)・書式文字(Cf: ゼロ幅文字・双方向制御・タグ文字等)・私用領域(Co:
 * U+E000–U+F8FF と補助私用面)・孤立サロゲート(Cs)。タブと改行は残す(改行は先に
 * CRLF / CR を LF に揃える)。
 */
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu;

export function stripUnsafeCharacters(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE_CHARACTERS, (c) => (c === "\n" || c === "\t" ? c : ""));
}

// ---------------------------------------------------------------------------
// 2・3. Markdown のリンク・画像・参照定義、生の HTML
// ---------------------------------------------------------------------------

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

function isAsciiPunctuation(c: string | undefined): boolean {
  return c !== undefined && ASCII_PUNCTUATION.test(c);
}

/** 生の HTML(CommonMark の raw HTML の文法)と `<scheme:…>` 自動リンク。 */
const TAG_NAME = "[A-Za-z][A-Za-z0-9-]*";
const ATTRIBUTE_NAME = "[A-Za-z_:][A-Za-z0-9_.:-]*";
const ATTRIBUTE_VALUE = "(?:[^\\s\"'=<>`]+|'[^']*'|\"[^\"]*\")";
const ATTRIBUTE = `(?:\\s+${ATTRIBUTE_NAME}(?:\\s*=\\s*${ATTRIBUTE_VALUE})?)`;
const RAW_HTML_AT = new RegExp(
  [
    `<${TAG_NAME}${ATTRIBUTE}{0,100}\\s*\\/?>`,
    `<\\/${TAG_NAME}\\s*>`,
    // 属性の数・コメント・処理命令・CDATA・宣言は長さに上限を置く(閉じない入力で
    // 走査を二乗にしない)
    "<!-->|<!--->|<!--[\\s\\S]{0,4000}?-->",
    "<\\?[\\s\\S]{0,4000}?\\?>",
    "<!\\[CDATA\\[[\\s\\S]{0,4000}?\\]\\]>",
    "<![A-Za-z][^>]{0,4000}>",
    "<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\\s<>]*>",
  ].join("|"),
  "y",
);

/** 位置 at から始まる生の HTML の長さ(なければ 0)。段落をまたぐもの(空行を含む)は扱わない。 */
function rawHtmlLengthAt(text: string, at: number): number {
  RAW_HTML_AT.lastIndex = at;
  const match = RAW_HTML_AT.exec(text);
  if (match === null || /\n[ \t]*\n/.test(match[0])) {
    return 0;
  }
  return match[0].length;
}

interface Region {
  readonly start: number;
  readonly end: number;
  /** code: コード(そのまま残す)/ html: 生の HTML・自動リンク(除去する) */
  readonly kind: "code" | "html";
}

/** 開始位置 → 範囲(走査中の参照を O(1) にする)。 */
type RegionIndex = ReadonlyMap<number, Region>;

function indexRegions(regions: readonly Region[]): RegionIndex {
  return new Map(regions.map((region) => [region.start, region]));
}

/** `<scheme:…>` の自動リンク(除去した跡に REMOVED_URL_MARKER を置く)。 */
const URI_AUTOLINK_START = /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:/;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** フェンスのコードブロック(閉じていなければ末尾まで。CommonMark と同じ)。 */
function fencedCodeRegions(text: string): Region[] {
  const regions: Region[] = [];
  let offset = 0;
  let open: { start: number; fence: string } | undefined;
  for (const line of text.split("\n")) {
    const lineEnd = offset + line.length;
    if (open === undefined) {
      const match = FENCE_OPEN.exec(line);
      const fence = match?.[1];
      // バッククォートのフェンスの情報文字列にバッククォートは入らない(入ればコードスパン)
      if (fence !== undefined && !(fence.startsWith("`") && (match?.[2] ?? "").includes("`"))) {
        open = { start: offset, fence };
      }
    } else {
      const trimmed = line.replace(/^ {0,3}/, "").replace(/[ \t]+$/, "");
      const char = open.fence.charAt(0);
      if (
        trimmed.length >= open.fence.length &&
        [...trimmed].every((c) => c === char)
      ) {
        regions.push({ start: open.start, end: lineEnd, kind: "code" });
        open = undefined;
      }
    }
    offset = lineEnd + 1;
  }
  if (open !== undefined) {
    regions.push({ start: open.start, end: text.length, kind: "code" });
  }
  return regions;
}

function backtickRunLength(text: string, at: number): number {
  let end = at;
  while (text[end] === "`") {
    end += 1;
  }
  return end - at;
}

/** 空行(段落の区切り)が from 以降 to より前にあるか。 */
function crossesBlankLine(text: string, from: number, to: number): boolean {
  return /\n[ \t]*\n/.test(text.slice(from, to));
}

/**
 * コード(フェンス・コードスパン)と生の HTML の範囲を、CommonMark の優先順位
 * (先に始まった構文が勝つ。バックスラッシュエスケープした記号は構文を開かない)で求める。
 */
function scanRegions(text: string): Region[] {
  const fenced = fencedCodeRegions(text);
  const regions: Region[] = [];
  let next = 0;
  let i = 0;
  while (i < text.length) {
    const block = fenced[next];
    if (block !== undefined && i >= block.start) {
      regions.push(block);
      i = block.end;
      next += 1;
      continue;
    }
    const limit = block?.start ?? text.length;
    const c = text[i];
    if (c === "\\" && isAsciiPunctuation(text[i + 1])) {
      i += 2;
      continue;
    }
    if (c === "`") {
      const run = backtickRunLength(text, i);
      let j = i + run;
      let closed = -1;
      while (j < limit) {
        if (text[j] === "`") {
          const candidate = backtickRunLength(text, j);
          if (candidate === run) {
            closed = j;
            break;
          }
          j += candidate;
          continue;
        }
        j += 1;
      }
      if (closed !== -1 && !crossesBlankLine(text, i, closed)) {
        regions.push({ start: i, end: closed + run, kind: "code" });
        i = closed + run;
      } else {
        i += run;
      }
      continue;
    }
    if (c === "<") {
      const length = rawHtmlLengthAt(text, i);
      if (length > 0 && i + length <= limit) {
        regions.push({ start: i, end: i + length, kind: "html" });
        i += length;
        continue;
      }
    }
    i += 1;
  }
  return regions;
}

/**
 * 参照定義(`[label]: 宛先`)。引用・リストの記号の後ろにも置ける。ラベルは改行を
 * 含みうる(空行は不可)。宛先が次の行にある形(`[label]:` だけの行)は次の行も消す。
 */
const REFERENCE_DEFINITION =
  /^((?:[ \t]*(?:>|[-+*](?=[ \t])|\d{1,9}[.)](?=[ \t])))*[ \t]*)\[((?:\\[\s\S]|[^\\[\]\n]|\n(?![ \t]*\n)){1,999})\]:([^\n]*)/gm;

function removeReferenceDefinitions(text: string): TextRewrite {
  const code = fencedCodeRegions(text);
  let removed = 0;
  let out = "";
  let cursor = 0;
  REFERENCE_DEFINITION.lastIndex = 0;
  for (;;) {
    const match = REFERENCE_DEFINITION.exec(text);
    if (match === null) {
      break;
    }
    const start = match.index;
    const prefix = match[1] ?? "";
    const label = match[2] ?? "";
    const rest = match[3] ?? "";
    if (
      start < cursor ||
      label.trim() === "" ||
      code.some((region) => start >= region.start && start < region.end)
    ) {
      continue;
    }
    let end = start + match[0].length;
    if (rest.trim() === "") {
      // 宛先が次の行にある(空行でなければ次の行も定義の一部)
      const nextEnd = text.indexOf("\n", end + 1);
      const nextLine = text.slice(end + 1, nextEnd === -1 ? text.length : nextEnd);
      if (end < text.length && nextLine.trim() !== "") {
        end = nextEnd === -1 ? text.length : nextEnd;
      }
    }
    const keptPrefix = prefix.replace(/[ \t]+$/, "");
    if (keptPrefix === "" && text[end] === "\n") {
      // 行ごと消す(空行を残さない)
      end += 1;
    }
    out += text.slice(cursor, start) + keptPrefix;
    cursor = end;
    removed += 1;
    REFERENCE_DEFINITION.lastIndex = Math.max(end, start + 1);
  }
  return { text: out + text.slice(cursor), removed };
}

interface ParsedLink {
  /** リンクテキスト(画像なら代替テキスト)の範囲 */
  readonly labelStart: number;
  readonly labelEnd: number;
  /** 構文全体の終端(排他的) */
  readonly end: number;
}

/**
 * 対応する角括弧の組を1回の走査で求める(`[` の位置 → `]` の位置)。入れ子と
 * バックスラッシュエスケープを考慮し、コードと生の HTML の範囲の中は見ない。空行
 * (段落の区切り)をまたぐ組、MAX_LINK_SCAN より長い組は対応なしとする。
 */
function matchBrackets(text: string, regions: RegionIndex): ReadonlyMap<number, number> {
  const pairs = new Map<number, number>();
  const open: number[] = [];
  let i = 0;
  while (i < text.length) {
    const region = regions.get(i);
    if (region !== undefined) {
      i = region.end;
      continue;
    }
    const c = text[i];
    if (c === "\\" && isAsciiPunctuation(text[i + 1])) {
      i += 2;
      continue;
    }
    if (c === "\n" && /^\n[ \t]*\n/.test(text.slice(i, i + 64))) {
      open.length = 0;
    } else if (c === "[") {
      open.push(i);
    } else if (c === "]") {
      const start = open.pop();
      if (start !== undefined && i - start <= MAX_LINK_SCAN) {
        pairs.set(start, i);
      }
    }
    i += 1;
  }
  return pairs;
}

function skipSpaces(text: string, at: number): number {
  let i = at;
  let newlines = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t") {
      i += 1;
    } else if (c === "\n" && newlines === 0) {
      newlines += 1;
      i += 1;
    } else {
      break;
    }
  }
  return i;
}

/**
 * inline リンクの `(宛先 "タイトル")` を読む(open は `(` の位置)。宛先は `<…>` 形式か、
 * 空白を含まず括弧の釣り合った文字列。読めれば `)` の直後、読めなければ -1。
 */
function inlineLinkTailEnd(text: string, open: number): number {
  const limit = Math.min(text.length, open + MAX_LINK_SCAN);
  let i = skipSpaces(text, open + 1);
  if (text[i] === "<") {
    i += 1;
    while (i < limit && text[i] !== ">") {
      if (text[i] === "\n" || text[i] === "<") {
        return -1;
      }
      i += text[i] === "\\" && isAsciiPunctuation(text[i + 1]) ? 2 : 1;
    }
    if (i >= limit) {
      return -1;
    }
    i += 1;
  } else {
    let depth = 0;
    while (i < limit) {
      const c = text[i];
      if (c === "\\" && isAsciiPunctuation(text[i + 1])) {
        i += 2;
        continue;
      }
      if (c === undefined || /\s/.test(c)) {
        break;
      }
      if (c === "(") {
        depth += 1;
      } else if (c === ")") {
        if (depth === 0) {
          break;
        }
        depth -= 1;
      }
      i += 1;
    }
  }
  i = skipSpaces(text, i);
  const quote = text[i];
  if (quote === '"' || quote === "'" || quote === "(") {
    const close = quote === "(" ? ")" : quote;
    i += 1;
    while (i < limit && text[i] !== close) {
      if (text[i] === "\n" && /^\n[ \t]*\n/.test(text.slice(i, i + 64))) {
        return -1;
      }
      i += text[i] === "\\" && isAsciiPunctuation(text[i + 1]) ? 2 : 1;
    }
    if (i >= limit) {
      return -1;
    }
    i = skipSpaces(text, i + 1);
  }
  return text[i] === ")" ? i + 1 : -1;
}

/** 参照リンクの `[ref]` / `[]`(open は `[` の位置)の直後。読めなければ -1。 */
function referenceLabelEnd(text: string, open: number): number {
  let i = open + 1;
  const limit = Math.min(text.length, open + 1_000);
  while (i < limit) {
    const c = text[i];
    if (c === "\\" && isAsciiPunctuation(text[i + 1])) {
      i += 2;
      continue;
    }
    if (c === "[") {
      return -1;
    }
    if (c === "]") {
      return i + 1;
    }
    i += 1;
  }
  return -1;
}

/** `[` の位置 open から、inline リンク・参照リンク(完全・省略形)を読む。 */
function parseLinkAt(
  text: string,
  open: number,
  brackets: ReadonlyMap<number, number>,
): ParsedLink | undefined {
  const close = brackets.get(open);
  if (close === undefined) {
    return undefined;
  }
  const after = close + 1;
  let end = -1;
  if (text[after] === "(") {
    end = inlineLinkTailEnd(text, after);
  } else if (text[after] === "[") {
    end = referenceLabelEnd(text, after);
  }
  return end === -1 ? undefined : { labelStart: open + 1, labelEnd: close, end };
}

/**
 * 手順 2・3: 参照定義を消し、コードの外のリンク・画像をテキストにし、生の HTML を
 * 除去して `<` `>` をエスケープする。
 */
export function neutralizeMarkup(input: string, depth = 0): TextRewrite {
  const definitions = removeReferenceDefinitions(input);
  const text = definitions.text;
  const regions = indexRegions(scanRegions(text));
  const brackets = matchBrackets(text, regions);
  let removed = definitions.removed;
  let out = "";
  let i = 0;
  // 行頭から空白と `>` しか出ていないか(行頭の引用記号の `>` はエスケープしない)
  let quotePrefix = true;
  while (i < text.length) {
    const current = text[i];
    if (current === "\n") {
      quotePrefix = true;
    } else if (current !== " " && current !== "\t" && current !== ">") {
      quotePrefix = false;
    }
    const region = regions.get(i);
    if (region !== undefined) {
      if (region.kind === "code") {
        out += text.slice(region.start, region.end);
      } else {
        // 生の HTML は跡を残さず除く。`<scheme:…>` の自動リンクは URL として目印に置き換える
        if (URI_AUTOLINK_START.test(text.slice(region.start, region.end))) {
          out += REMOVED_URL_MARKER;
        }
        removed += 1;
      }
      i = region.end;
      continue;
    }
    const c = text[i] ?? "";
    const next = text[i + 1];
    if (c === "\\" && isAsciiPunctuation(next)) {
      // エスケープした < > は文字参照にする(生の HTML として解釈する UI でもタグにしない)
      out += next === "<" ? "&lt;" : next === ">" ? "&gt;" : `${c}${next ?? ""}`;
      i += 2;
      continue;
    }
    if (c === "[" || (c === "!" && next === "[")) {
      const open = c === "[" ? i : i + 1;
      const link = parseLinkAt(text, open, brackets);
      if (link !== undefined) {
        // リンク・画像はテキストだけ残す(ラベル内の入れ子のリンク・画像・HTML も同じ規則で)
        const label = text.slice(link.labelStart, link.labelEnd);
        if (depth < MAX_LABEL_DEPTH) {
          const inner = neutralizeMarkup(label, depth + 1);
          out += inner.text;
          removed += inner.removed + 1;
        } else {
          out += label.replace(/[!<>[\]]/g, "");
          removed += 1;
        }
        i = link.end;
        continue;
      }
      if (c === "!") {
        // 画像にならなかった `![` も `!` を落とす(本文に画像の構文を残さない)
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (c === "<") {
      out += "&lt;";
      i += 1;
      continue;
    }
    if (c === ">") {
      out += quotePrefix ? ">" : "&gt;";
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return { text: out, removed };
}

// ---------------------------------------------------------------------------
// 4. URL らしき文字列
// ---------------------------------------------------------------------------

/**
 * ASCII 以外の文字で表記したエンティティ名のうち、ASCII の記号・空白を表すもの
 * (HTML5 の名前付き文字参照)。表にない名前は復号せずに扱う。
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  Tab: "\t",
  NewLine: "\n",
  nbsp: " ",
  NonBreakingSpace: " ",
  excl: "!",
  quot: '"',
  QUOT: '"',
  num: "#",
  dollar: "$",
  percnt: "%",
  amp: "&",
  AMP: "&",
  apos: "'",
  lpar: "(",
  rpar: ")",
  ast: "*",
  midast: "*",
  plus: "+",
  comma: ",",
  period: ".",
  sol: "/",
  colon: ":",
  semi: ";",
  lt: "<",
  LT: "<",
  equals: "=",
  gt: ">",
  GT: ">",
  quest: "?",
  commat: "@",
  lsqb: "[",
  lbrack: "[",
  bsol: "\\",
  rsqb: "]",
  rbrack: "]",
  Hat: "^",
  lowbar: "_",
  UnderBar: "_",
  grave: "`",
  DiacriticalGrave: "`",
  lcub: "{",
  lbrace: "{",
  verbar: "|",
  vert: "|",
  VerticalLine: "|",
  rcub: "}",
  rbrace: "}",
};

const ENTITY_AT = /&(?:#([0-9]{1,7})|#[xX]([0-9A-Fa-f]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/y;

/** 位置 at の文字参照を復号する(表にない名前付き参照は undefined)。 */
function entityAt(text: string, at: number): { decoded: string; length: number } | undefined {
  ENTITY_AT.lastIndex = at;
  const match = ENTITY_AT.exec(text);
  if (match === null) {
    return undefined;
  }
  const [whole, decimal, hex, name] = match;
  if (name !== undefined) {
    const decoded = NAMED_ENTITIES[name];
    return decoded === undefined ? undefined : { decoded, length: whole.length };
  }
  const codePoint = Number.parseInt(decimal ?? hex ?? "", decimal !== undefined ? 10 : 16);
  const valid =
    codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff);
  return {
    decoded: valid ? String.fromCodePoint(codePoint) : "�",
    length: whole.length,
  };
}

/**
 * 検出用の影の文字列。各文字(UTF-16 単位)が元の文字列のどの範囲に由来するかを
 * starts / ends に持つ(文字参照・エスケープ・NFKC で長さが変わっても元の範囲を除去できる)。
 */
interface Shadow {
  readonly text: string;
  readonly starts: readonly number[];
  readonly ends: readonly number[];
}

/** 検出用の正規化: NFKC(全角・互換文字を ASCII 側へ)と、`\` を `/` とみなす。 */
function normalizeForDetection(value: string): string {
  return value.normalize("NFKC").replace(/\\/g, "/");
}

function buildShadow(source: string): Shadow {
  const parts: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const push = (value: string, start: number, end: number): void => {
    for (let k = 0; k < value.length; k += 1) {
      starts.push(start);
      ends.push(end);
    }
    parts.push(value);
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "&") {
      const entity = entityAt(source, i);
      if (entity !== undefined) {
        push(normalizeForDetection(entity.decoded), i, i + entity.length);
        i += entity.length;
        continue;
      }
    }
    if (c === "\\" && isAsciiPunctuation(source[i + 1])) {
      // Markdown のエスケープ: 表示されるのは続く記号だけ(`https\://` は `https://`)
      push(normalizeForDetection(source[i + 1] ?? ""), i, i + 2);
      i += 2;
      continue;
    }
    const codePoint = source.codePointAt(i) ?? 0;
    const width = codePoint > 0xffff ? 2 : 1;
    push(normalizeForDetection(source.slice(i, i + width)), i, i + width);
    i += width;
  }
  return { text: parts.join(""), starts, ends };
}

/** URL を構成する ASCII 文字(RFC 3986 の unreserved / reserved と %)。 */
const URL_CHARS = "A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%";
/** ホスト名のラベルの文字(国際化ドメイン名を含む)。 */
const HOST_CHAR = "[\\p{L}\\p{N}\\p{M}_%\\-]";
const PORT = "(?::\\d{1,5})?";
const PATH_TAIL = `(?:[/?#][${URL_CHARS}]*)?`;
/**
 * `//` なしでも絶対 URL として解釈される特別なスキーム(http: 等)や、リンクにすると
 * 危険な動作・送信になるスキーム。大小文字は区別しない。
 */
const SPECIAL_SCHEMES = [
  "https?",
  "ftps?",
  "sftp",
  "wss?",
  "file",
  "mailto",
  "javascript",
  "vbscript",
  "data",
  "blob",
  "tel",
  "sms",
  "xmpp",
  "ircs?",
  "news",
  "nntp",
  "telnet",
  "ssh",
  "git",
  "svn",
  "ldaps?",
  "smb",
  "magnet",
  "webcal",
  "feed",
  "intent",
  "sips?",
  "callto",
  "facetime",
  "skype",
  "tg",
  "market",
  "view-source",
  "jar",
].join("|");

/**
 * URL らしき文字列の検出器(影の文字列に対して使う)。左から順に重ならないよう一致させる。
 * (a) 任意のスキームの `scheme://…`(ホストは国際化ドメイン名を含む)
 * (b) 特別・危険なスキームの `scheme:…`(`http:evil`・`mailto:`・`javascript:` 等)
 * (c) `www.`(大小文字無視)
 * (d) プロトコル相対の `//host`(ホストはドットを含むもの・IPv6 リテラル)
 * (e) `label.tld/path` / `label.tld?query`(ASCII のラベルはホスト全体を除去する。
 *     ASCII 以外の先頭ラベルは最初のドットから除去する: 分かち書きしない日本語の文を
 *     ラベルとして巻き込まないため。残るのは URL にならない文字列だけ)
 */
const URL_LIKE = new RegExp(
  [
    `(?<![A-Za-z0-9+.\\-])[A-Za-z][A-Za-z0-9+.\\-]{0,31}:\\/\\/[^\\s/?#<>"'\`]*${PATH_TAIL}`,
    `(?<![A-Za-z0-9+.\\-])(?:${SPECIAL_SCHEMES}):(?=\\S)[${URL_CHARS}]*`,
    `www\\.${HOST_CHAR}[\\p{L}\\p{N}\\p{M}_%.\\-]*${PORT}${PATH_TAIL}`,
    `(?<!\\/)\\/\\/+(?:[^\\s/?#@<>"'\`]*@)?(?:${HOST_CHAR}+(?:\\.${HOST_CHAR}+)+|\\[[0-9A-Fa-f:.]+\\])${PORT}${PATH_TAIL}`,
    `(?<![A-Za-z0-9_\\-])[A-Za-z0-9_\\-]*(?<=${HOST_CHAR})\\.(?:${HOST_CHAR}+\\.)*(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9\\-]{1,59})${PORT}(?:\\/[${URL_CHARS}]*|[?#][${URL_CHARS}]+)`,
  ].join("|"),
  "giu",
);

/** URL の直後に付きがちな句読点(文の一部として残す)。 */
const TRAILING_PUNCTUATION = /[.,;!?'")\]]+$/;

interface Span {
  start: number;
  end: number;
}

/** 影の文字列で URL らしき範囲を探し、元の文字列の範囲(重なり・隣接は併合)で返す。 */
export function findUrlLikeSpans(text: string): readonly Span[] {
  const shadow = buildShadow(text);
  const spans: Span[] = [];
  URL_LIKE.lastIndex = 0;
  for (const match of shadow.text.matchAll(URL_LIKE)) {
    const matched = match[0].replace(TRAILING_PUNCTUATION, "");
    if (matched === "") {
      continue;
    }
    const first = match.index;
    if (first === undefined) {
      continue;
    }
    const last = first + matched.length - 1;
    const start = shadow.starts[first];
    const end = shadow.ends[last];
    if (start === undefined || end === undefined) {
      continue;
    }
    const previous = spans.at(-1);
    if (previous !== undefined && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
    } else {
      spans.push({ start, end });
    }
  }
  return spans;
}

/** 手順 4: URL らしき文字列を REMOVED_URL_MARKER に置き換える。 */
export function removeUrlLike(text: string): TextRewrite {
  const spans = findUrlLikeSpans(text);
  if (spans.length === 0) {
    return { text, removed: 0 };
  }
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + REMOVED_URL_MARKER;
    cursor = span.end;
  }
  return { text: out + text.slice(cursor), removed: spans.length };
}
