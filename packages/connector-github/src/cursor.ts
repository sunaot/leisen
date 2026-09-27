/**
 * 不透明カーソルの符号化・復号。
 *
 * GitHub のページ番号をコネクタ内部の状態として base64url(JSON) に包む。
 * カーソルは LLM から改変されて戻りうるため、復号時に構造と値域を厳格に
 * 検証し、不正なら invalid_request とする(受領値はエコーしない)。
 * カーソルには件数(total_count 等)を入れない(ADR-012)。
 */
import { ConnectorError } from "@kp/connector-sdk";

const MAX_CURSOR_LENGTH = 1024;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;

/** GitHub の per_page 上限。 */
export const MAX_PER_PAGE = 100;
/** GitHub 検索が1クエリで返す結果の上限(これより先のページは取得できない)。 */
export const SEARCH_RESULT_WINDOW = 1000;
/** 一覧系の走査ページ上限(暴走防止。100件×1000ページ) */
const MAX_LIST_PAGE = 1000;
/** fetch 本文のページ上限 */
const MAX_CONTENT_PAGE = 100_000;

function encodeCursor(payload: object): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, what: string): Record<string, unknown> {
  const invalid = new ConnectorError("invalid_request", `invalid ${what}`);
  if (cursor.length > MAX_CURSOR_LENGTH || !CURSOR_PATTERN.test(cursor)) {
    throw invalid;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalid;
  }
  return parsed as Record<string, unknown>;
}

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

// ---- search ----

/** 検索ストリーム: issue / PR は /search/issues の別クエリ、code は /search/code。 */
export type SearchStreamKind = "issue" | "pr" | "code";

export interface SearchStreamState {
  readonly kind: SearchStreamKind;
  /** 次に取得する GitHub のページ番号(1始まり) */
  readonly page: number;
  /** このストリームの per_page(カーソルの寿命中は固定) */
  readonly perPage: number;
}

const STREAM_KINDS: readonly SearchStreamKind[] = ["issue", "pr", "code"];

function isStreamKind(value: unknown): value is SearchStreamKind {
  return STREAM_KINDS.includes(value as SearchStreamKind);
}

export function encodeSearchCursor(streams: readonly SearchStreamState[]): string {
  return encodeCursor({
    k: "search",
    v: 1,
    s: streams.map((stream) => [stream.kind, stream.page, stream.perPage]),
  });
}

export function decodeSearchCursor(cursor: string): SearchStreamState[] {
  const what = "search cursor";
  const invalid = new ConnectorError("invalid_request", `invalid ${what}`);
  const payload = decodeCursor(cursor, what);
  if (
    payload.k !== "search" ||
    payload.v !== 1 ||
    !Array.isArray(payload.s) ||
    payload.s.length === 0 ||
    payload.s.length > STREAM_KINDS.length
  ) {
    throw invalid;
  }
  const seen = new Set<SearchStreamKind>();
  const streams: SearchStreamState[] = [];
  for (const entry of payload.s as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 3) {
      throw invalid;
    }
    const [kind, page, perPage] = entry as unknown[];
    if (
      !isStreamKind(kind) ||
      seen.has(kind) ||
      !isIntegerIn(perPage, 1, MAX_PER_PAGE) ||
      !isIntegerIn(page, 1, Math.ceil(SEARCH_RESULT_WINDOW / perPage))
    ) {
      throw invalid;
    }
    seen.add(kind);
    streams.push({ kind, page, perPage });
  }
  return streams;
}

// ---- list ----

export type ListCursorState =
  | { readonly phase: "orgs" | "repos"; readonly page: number }
  | { readonly phase: "org_repos"; readonly page: number; readonly org: string };

export function encodeListCursor(state: ListCursorState): string {
  return encodeCursor({
    k: "list",
    v: 1,
    ph: state.phase,
    p: state.page,
    ...(state.phase === "org_repos" ? { o: state.org.toLowerCase() } : {}),
  });
}

/**
 * list カーソルを復号する。org 一覧のカーソルは対象 org に束縛し、別の
 * containerId での再利用を拒否する。
 */
export function decodeListCursor(
  cursor: string,
  org: string | undefined,
): ListCursorState {
  const what = "list cursor";
  const invalid = new ConnectorError("invalid_request", `invalid ${what}`);
  const payload = decodeCursor(cursor, what);
  if (payload.k !== "list" || payload.v !== 1 || !isIntegerIn(payload.p, 1, MAX_LIST_PAGE)) {
    throw invalid;
  }
  const page = payload.p;
  if (org === undefined) {
    if ((payload.ph === "orgs" || payload.ph === "repos") && payload.o === undefined) {
      return { phase: payload.ph, page };
    }
    throw invalid;
  }
  if (payload.ph === "org_repos" && payload.o === org.toLowerCase()) {
    return { phase: "org_repos", page, org };
  }
  throw invalid;
}

// ---- fetch(本文ページ) ----

export function encodePageCursor(pageIndex: number): string {
  return encodeCursor({ k: "page", v: 1, p: pageIndex });
}

/** 本文ページのカーソル → ページ番号(0始まり。カーソルなしが 0)。 */
export function decodePageCursor(cursor: string): number {
  const what = "page cursor";
  const payload = decodeCursor(cursor, what);
  if (payload.k !== "page" || payload.v !== 1 || !isIntegerIn(payload.p, 1, MAX_CONTENT_PAGE)) {
    throw new ConnectorError("invalid_request", `invalid ${what}`);
  }
  return payload.p;
}
