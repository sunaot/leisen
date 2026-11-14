/**
 * esa の MCP ツールの応答の読み取り(ADR-023)。
 *
 * 応答の形は esa の REST API v1 の posts / categories に近い JSON(2026-11 に確認)。
 * - 投稿: number を持たず url(https://<team>.esa.io/posts/<number>)を持つ。タイトルは
 *   category_and_title_and_tags("カテゴリ/名前 #tag1 #tag2")の 1 文字列
 * - カテゴリ: { full_name, count, has_child }。count は投稿数で、利用者に見えない投稿を
 *   含みうるため childCount に使わない(ADR-016 追補2 決定4、ADR-012)
 * 想定外の形は source_unavailable にする(黙って空にしない)
 */
import { ConnectorError } from "@leisen/connector-sdk";

export interface EsaPost {
  readonly number: number;
  /** カテゴリのパス("" はカテゴリなし) */
  readonly category: string;
  readonly name: string;
  readonly tags: readonly string[];
  readonly wip: boolean;
  readonly bodyMd: string;
  readonly updatedAt?: string;
  readonly truncated: boolean;
}

export interface EsaCategory {
  readonly fullName: string;
  readonly hasChild: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(what: string): ConnectorError {
  return new ConnectorError("source_unavailable", `esa returned a malformed ${what}`);
}

/** "カテゴリ/名前 #tag1 #tag2" を分ける。名前に "/" は入らない(esa ではカテゴリになる)。 */
export function splitFullName(raw: string): { category: string; name: string; tags: string[] } {
  let rest = raw.trim();
  const tags: string[] = [];
  for (;;) {
    const match = /\s#([^\s#]+)$/.exec(rest);
    if (match === null) {
      break;
    }
    tags.unshift(match[1] as string);
    rest = rest.slice(0, match.index).trimEnd();
  }
  const slash = rest.lastIndexOf("/");
  if (slash < 0) {
    return { category: "", name: rest, tags };
  }
  return { category: rest.slice(0, slash), name: rest.slice(slash + 1), tags };
}

/** url の末尾の /posts/<number> から投稿番号を読む。 */
function postNumberFromUrl(url: unknown): number | undefined {
  if (typeof url !== "string") {
    return undefined;
  }
  const match = /\/posts\/(\d{1,12})(?:[/?#]|$)/.exec(url);
  return match !== null ? Number(match[1]) : undefined;
}

const TRUNCATION_MARK = "... (truncated)";

export function parsePost(value: unknown): EsaPost {
  if (!isRecord(value)) {
    throw malformed("post");
  }
  const number =
    typeof value["number"] === "number" && Number.isInteger(value["number"])
      ? value["number"]
      : postNumberFromUrl(value["url"]);
  if (number === undefined || number <= 0) {
    throw malformed("post (no post number)");
  }
  let category: string;
  let name: string;
  let tags: string[];
  if (typeof value["category_and_title_and_tags"] === "string") {
    ({ category, name, tags } = splitFullName(value["category_and_title_and_tags"]));
  } else if (typeof value["full_name"] === "string") {
    ({ category, name, tags } = splitFullName(value["full_name"]));
  } else if (typeof value["name"] === "string") {
    name = value["name"];
    category = typeof value["category"] === "string" ? value["category"] : "";
    tags = Array.isArray(value["tags"]) ? value["tags"].filter((t): t is string => typeof t === "string") : [];
  } else {
    throw malformed("post (no title)");
  }
  const wipRaw = value["wip"];
  // MCP は "WIP" / "Shipped"、REST は boolean
  const wip = wipRaw === true || (typeof wipRaw === "string" && wipRaw.toLowerCase() === "wip");
  const body = typeof value["body_md"] === "string" ? value["body_md"] : "";
  const truncated = body.endsWith(TRUNCATION_MARK);
  const updatedAt = typeof value["updated_at"] === "string" ? value["updated_at"] : undefined;
  return {
    number,
    category,
    name: name === "" ? `#${number}` : name,
    tags,
    wip,
    bodyMd: truncated ? body.slice(0, -TRUNCATION_MARK.length).trimEnd() : body,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    truncated,
  };
}

/** esa_search_posts の結果(配列。REST と同じ { posts: [...] } も受ける)。 */
export function parseSearchResult(value: unknown): EsaPost[] {
  const list = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value["posts"]) ? value["posts"] : undefined;
  if (list === undefined) {
    throw malformed("search result");
  }
  return list.map(parsePost);
}

/** esa_get_top_categories / esa_get_categories の結果のカテゴリ一覧。 */
export function parseCategories(value: unknown, parent: string | undefined): EsaCategory[] {
  if (!isRecord(value)) {
    throw malformed("category list");
  }
  const raw = Array.isArray(value["categories"])
    ? value["categories"]
    : Array.isArray(value["children"])
      ? value["children"]
      : undefined;
  if (raw === undefined) {
    throw malformed("category list");
  }
  const out: EsaCategory[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue;
    }
    const nameValue = typeof entry["full_name"] === "string" ? entry["full_name"] : typeof entry["name"] === "string" ? entry["name"] : undefined;
    if (nameValue === undefined || nameValue === "") {
      continue;
    }
    // 子カテゴリの full_name がパス全体か末尾だけかに依らず、パス全体にする
    const fullName =
      parent === undefined || parent === "" || nameValue.startsWith(`${parent}/`) ? nameValue : `${parent}/${nameValue}`;
    out.push({ fullName, hasChild: entry["has_child"] === true });
  }
  return out;
}

/** 応答に次のページがあるか(REST 形式の next_page。なければ undefined)。 */
export function nextPageOf(value: unknown): number | null | undefined {
  if (!isRecord(value) || !("next_page" in value)) {
    return undefined;
  }
  const next = value["next_page"];
  return typeof next === "number" && Number.isInteger(next) && next > 0 ? next : null;
}

/** スニペット用の平文化(front matter・HTML コメント・Markdown の記号を落として詰める)。 */
export function toPlainSnippet(markdown: string, maxChars: number): string {
  let text = markdown.replace(/\r\n?/g, "\n");
  text = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.|>)\s+/gm, "");
  text = text.replace(/[*_`~|]/g, "");
  text = text.replace(/\s+/g, " ").trim();
  return [...text].slice(0, maxChars).join("");
}
