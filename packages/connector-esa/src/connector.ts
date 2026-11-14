/**
 * esa コネクタ(ADR-023、T-026)。connector-sdk v0.4 の Connector を、esa 公式の
 * リモート MCP サーバーの読み取り系ツールで実装する。
 *
 * - 全呼び出しを利用者本人の OAuth アクセストークンで行う(不変条件1)。トークンの出どころ
 *   (Token Vault / ESC / 開発用の mock_env)はコネクタからは見えない(ADR-022)
 * - 検索の対象チームは設定で 1 つに固定する。本人が別のチームに属していても、導入先の
 *   チーム以外を検索しない(ADR-005、1 デプロイ = 1 社)
 * - esa の閲覧権限はチームのメンバー(とゲストのカテゴリ制限)で esa が判定する。コネクタは
 *   権限を複製・判定しない(不変条件1・ADR-003)
 * - 領域(scope): esa にはチーム内の非公開領域の仕組みがないため既定はすべて shared。
 *   慣習で個人の場所として扱うカテゴリ(例: Users)を settings.privateCategories で private に
 *   分類し、除外は Gateway に任せる(classified、ADR-016 追補2)
 * - 件数を返さない: 検索の total_count、カテゴリの count(投稿数)は使わない(ADR-012)
 */
import {
  ConnectorError,
  MAX_SNIPPET_CHARS,
  type AuthContext,
  type Connector,
  type ConnectorCapabilities,
  type ContainerEntry,
  type DocumentScope,
  type FetchResult,
  type ListResult,
  type SearchFilters,
  type SearchHit,
  type SearchOptions,
  type SearchResult,
  type SourceDescription,
} from "@leisen/connector-sdk";
import { EsaMcpClient, type EsaMcpCaller, type EsaReadTool, type FetchLike } from "./mcp.js";
import { nextPageOf, parseCategories, parsePost, parseSearchResult, toPlainSnippet, type EsaPost } from "./parse.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { integerOption } from "./options.js";

export interface EsaConnectorOptions {
  readonly sourceId: string;
  /** esa のチーム名(<team>.esa.io の <team>) */
  readonly team: string;
  readonly displayName?: string;
  /** describe の summary(このソースに何があるかの説明。エージェントの初手選択に使う) */
  readonly summary?: string;
  /** リモート MCP サーバーの URL(既定 https://mcp.esa.io/) */
  readonly mcpUrl?: string;
  readonly timeoutMs?: number;
  readonly defaultSearchLimit?: number;
  readonly snippetChars?: number;
  readonly pageChars?: number;
  readonly maxTopContainers?: number;
  /** WIP の投稿を検索に含めるか(既定 true) */
  readonly includeWip?: boolean;
  /** private に分類するカテゴリ(前方一致。例: ["Users"]) */
  readonly privateCategories?: readonly string[];
  /** 本番の判定(既定は NODE_ENV=production)。テスト用の注入 */
  readonly production?: boolean;
  /** テスト用の注入 */
  readonly fetchImpl?: FetchLike;
  readonly caller?: EsaMcpCaller;
  readonly now?: () => number;
}

export const DEFAULT_MCP_URL = "https://mcp.esa.io/";
/** 本番で許すトークンの送り先(OAuth の resource=https://mcp.esa.io と同じオリジン。ADR-023 決定 2) */
export const ESA_MCP_ORIGIN = "https://mcp.esa.io";

/**
 * mcpUrl の上書きは開発・テストだけ。本番(NODE_ENV=production)では本人のトークンを
 * mcp.esa.io 以外へ送らない(設定の誤り・改ざんによる token passthrough を防ぐ)
 */
function checkMcpUrlForEnvironment(url: string, production: boolean): void {
  if (!production) {
    return;
  }
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new RangeError("mcpUrl must be an absolute URL");
  }
  if (origin !== ESA_MCP_ORIGIN) {
    throw new RangeError(`mcpUrl must be on ${ESA_MCP_ORIGIN} in production (overriding it is for development and tests only)`);
  }
}
const TEAM_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SCREEN_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DOCUMENT_ID_PATTERN = /^post:(\d{1,12})$/;
/** esa の検索のページ番号の上限(深いページングを止める) */
const MAX_PAGE = 100;

function categoryPathOk(path: string): boolean {
  return path !== "" && path.length <= 255 && !/["\n\r\t]/.test(path) && !path.startsWith("/") && !path.endsWith("/");
}

/** 検索語に足す修飾子の値(空白を含むカテゴリは引用符で囲む)。 */
function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/** ISO 8601 を esa の日付(YYYY-MM-DD)にする。解釈できなければ invalid_request。 */
function esaDate(value: string, name: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new ConnectorError("invalid_request", `${name} must be an ISO 8601 date`);
  }
  return new Date(time).toISOString().slice(0, 10);
}

export class EsaConnector implements Connector {
  readonly sourceId: string;
  readonly capabilities: ConnectorCapabilities = {
    nativeSearch: "full",
    ingest: false,
    privateScopeHandling: "classified",
  };
  readonly #team: string;
  readonly #displayName: string;
  readonly #summary: string;
  readonly #caller: EsaMcpCaller;
  readonly #defaultLimit: number;
  readonly #snippetChars: number;
  readonly #pageChars: number;
  readonly #maxTopContainers: number;
  readonly #includeWip: boolean;
  readonly #privateCategories: readonly string[];
  readonly #now: () => number;

  constructor(options: EsaConnectorOptions) {
    if (typeof options.sourceId !== "string" || options.sourceId === "") {
      throw new RangeError("sourceId is required");
    }
    if (typeof options.team !== "string" || !TEAM_PATTERN.test(options.team)) {
      throw new RangeError("team must be an esa team name (lowercase letters, digits and -)");
    }
    this.sourceId = options.sourceId;
    this.#team = options.team;
    this.#displayName = options.displayName ?? `esa (${options.team})`;
    this.#summary =
      options.summary ??
      `esa team ${options.team}: Markdown posts (design docs, meeting notes, how-tos, daily reports) organized by category`;
    const timeoutMs = integerOption("timeoutMs", options.timeoutMs, 15_000, 1_000, 120_000);
    this.#defaultLimit = integerOption("defaultSearchLimit", options.defaultSearchLimit, 10, 1, 100);
    this.#snippetChars = integerOption("snippetChars", options.snippetChars, 300, 1, MAX_SNIPPET_CHARS);
    this.#pageChars = integerOption("pageChars", options.pageChars, 20_000, 1_000, 200_000);
    this.#maxTopContainers = integerOption("maxTopContainers", options.maxTopContainers, 30, 1, 100);
    this.#includeWip = options.includeWip ?? true;
    const privateCategories = options.privateCategories ?? [];
    for (const category of privateCategories) {
      if (typeof category !== "string" || !categoryPathOk(category)) {
        throw new RangeError("privateCategories must be category paths without quotes or leading/trailing /");
      }
    }
    this.#privateCategories = privateCategories;
    const mcpUrl = options.mcpUrl ?? DEFAULT_MCP_URL;
    checkMcpUrlForEnvironment(mcpUrl, options.production ?? process.env["NODE_ENV"] === "production");
    this.#caller =
      options.caller ??
      new EsaMcpClient({
        url: mcpUrl,
        timeoutMs,
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      });
    this.#now = options.now ?? Date.now;
  }

  /** 本人のアクセストークンを取り出す(oauth_bearer だけ。期限切れは auth_expired)。 */
  #token(auth: AuthContext): string {
    const credential = auth?.credential;
    if (credential === undefined || credential === null) {
      throw new ConnectorError("auth_expired", "no credential for esa; the user must connect esa");
    }
    if (credential.kind !== "oauth_bearer") {
      throw new ConnectorError("invalid_request", `esa connector requires an oauth_bearer credential (got ${credential.kind})`);
    }
    if (typeof credential.accessToken !== "string" || credential.accessToken === "") {
      throw new ConnectorError("auth_expired", "esa access token is missing; the user must connect esa");
    }
    if (!Number.isFinite(credential.expiresAt)) {
      throw new ConnectorError("auth_expired", "esa access token has no valid expiry time; the user must reconnect esa");
    }
    // 0 以下は「失効時刻不明」(ADR-016 追補3)。esa の 401 に委ねる
    if (credential.expiresAt > 0 && credential.expiresAt <= this.#now()) {
      throw new ConnectorError("auth_expired", "esa access token has expired");
    }
    return credential.accessToken;
  }

  #call(auth: AuthContext, tool: EsaReadTool, args: Record<string, unknown>): Promise<unknown> {
    const token = this.#token(auth);
    return this.#caller.callTool(token, tool, { teamName: this.#team, ...args });
  }

  #scopeOfCategory(category: string): DocumentScope {
    for (const prefix of this.#privateCategories) {
      if (category === prefix || category.startsWith(`${prefix}/`)) {
        return "private";
      }
    }
    return "shared";
  }

  #postUrl(number: number): string {
    return `https://${this.#team}.esa.io/posts/${number}`;
  }

  #buildQuery(query: string, filters: SearchFilters | undefined): string {
    if (typeof query !== "string") {
      throw new ConnectorError("invalid_request", "query must be a string");
    }
    const parts = [query.trim()];
    if (filters?.updatedAfter !== undefined) {
      parts.push(`updated:>${esaDate(filters.updatedAfter, "updatedAfter")}`);
    }
    if (filters?.updatedBefore !== undefined) {
      parts.push(`updated:<${esaDate(filters.updatedBefore, "updatedBefore")}`);
    }
    if (filters?.container !== undefined) {
      if (!categoryPathOk(filters.container)) {
        throw new ConnectorError("invalid_request", "container must be an esa category path");
      }
      parts.push(`in:${quoteIfNeeded(filters.container)}`);
    }
    if (filters?.author !== undefined) {
      if (!SCREEN_NAME_PATTERN.test(filters.author)) {
        throw new ConnectorError("invalid_request", "author must be an esa screen_name");
      }
      parts.push(`user:${filters.author}`);
    }
    if (!this.#includeWip) {
      parts.push("wip:false");
    }
    return parts.filter((p) => p !== "").join(" ");
  }

  async search(auth: AuthContext, query: string, filters?: SearchFilters, options?: SearchOptions): Promise<SearchResult> {
    const esaQuery = this.#buildQuery(query, filters);
    const limit = integerOptionOrInvalid("limit", options?.limit, this.#defaultLimit, 1, 100);
    const page = options?.cursor !== undefined ? decodeCursor(options.cursor, "s") : 1;
    const raw = await this.#call(auth, "esa_search_posts", {
      query: esaQuery,
      page,
      perPage: limit,
      sort: "best_match",
    });
    const posts = parseSearchResult(raw);
    const hits = posts.map((post) => this.#toHit(post));
    const next = nextPageOf(raw);
    const hasMore = next === undefined ? posts.length >= limit : next !== null;
    return {
      hits,
      ...(hasMore && page < MAX_PAGE ? { nextCursor: encodeCursor("s", page + 1) } : {}),
    };
  }

  #toHit(post: EsaPost): SearchHit {
    const meta: Record<string, string> = {};
    if (post.category !== "") {
      meta["category"] = post.category;
    }
    if (post.tags.length > 0) {
      meta["tags"] = post.tags.join(" ");
    }
    if (post.wip) {
      meta["wip"] = "true";
    }
    return {
      documentId: `post:${post.number}`,
      title: post.name,
      snippet: toPlainSnippet(post.bodyMd, this.#snippetChars),
      url: this.#postUrl(post.number),
      ...(post.updatedAt !== undefined ? { updatedAt: post.updatedAt } : {}),
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
      scope: this.#scopeOfCategory(post.category),
    };
  }

  async fetch(auth: AuthContext, documentId: string, pageCursor?: string): Promise<FetchResult> {
    const match = typeof documentId === "string" ? DOCUMENT_ID_PATTERN.exec(documentId) : null;
    if (match === null) {
      throw new ConnectorError("invalid_request", "documentId is not an esa post id");
    }
    const number = Number(match[1]);
    const pageIndex = pageCursor !== undefined ? decodeCursor(pageCursor, "f") : 0;
    const raw = await this.#call(auth, "esa_get_post", { postNumber: number, truncate: false });
    const post = parsePost(raw);
    if (post.number !== number) {
      throw new ConnectorError("source_unavailable", "esa returned a different post");
    }
    const header = [
      `# ${post.name}`,
      post.category !== "" ? `category: ${post.category}` : undefined,
      post.tags.length > 0 ? `tags: ${post.tags.map((t) => `#${t}`).join(" ")}` : undefined,
      post.wip ? "status: WIP" : undefined,
      post.updatedAt !== undefined ? `updated: ${post.updatedAt}` : undefined,
      post.truncated ? "(note: esa returned a truncated body)" : undefined,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    const full = `${header}\n\n${post.bodyMd}`;
    const chars = [...full];
    const start = pageIndex * this.#pageChars;
    if (pageIndex > 0 && start >= chars.length) {
      throw new ConnectorError("invalid_request", "page cursor is out of range");
    }
    const end = start + this.#pageChars;
    return {
      documentId,
      title: post.name,
      content: chars.slice(start, end).join(""),
      url: this.#postUrl(post.number),
      ...(end < chars.length ? { nextPageCursor: encodeCursor("f", pageIndex + 1) } : {}),
      scope: this.#scopeOfCategory(post.category),
    };
  }

  #toEntry(fullName: string): ContainerEntry {
    const slash = fullName.lastIndexOf("/");
    return {
      id: fullName,
      name: slash < 0 ? fullName : fullName.slice(slash + 1),
      kind: "folder",
      scope: this.#scopeOfCategory(fullName),
    };
  }

  async list(auth: AuthContext, containerId?: string, cursor?: string): Promise<ListResult> {
    if (containerId === undefined || containerId === "") {
      if (cursor !== undefined) {
        throw new ConnectorError("invalid_request", "top-level categories have no further pages");
      }
      const raw = await this.#call(auth, "esa_get_top_categories", {});
      return { entries: parseCategories(raw, undefined).map((c) => this.#toEntry(c.fullName)) };
    }
    if (!categoryPathOk(containerId)) {
      throw new ConnectorError("invalid_request", "containerId must be an esa category path");
    }
    const page = cursor !== undefined ? decodeCursor(cursor, "l") : 1;
    const perPage = 100;
    const raw = await this.#call(auth, "esa_get_categories", { select: containerId, page, perPage });
    const categories = parseCategories(raw, containerId).filter((c) => c.fullName !== containerId);
    const next = nextPageOf(raw);
    const hasMore = next === undefined ? categories.length >= perPage : next !== null;
    return {
      entries: categories.map((c) => this.#toEntry(c.fullName)),
      ...(hasMore && page < MAX_PAGE ? { nextCursor: encodeCursor("l", page + 1) } : {}),
    };
  }

  async describe(auth: AuthContext): Promise<SourceDescription> {
    const raw = await this.#call(auth, "esa_get_top_categories", {});
    const top = parseCategories(raw, undefined)
      .filter((c) => c.hasChild)
      .slice(0, this.#maxTopContainers)
      .map((c) => this.#toEntry(c.fullName));
    return {
      sourceId: this.sourceId,
      displayName: this.#displayName,
      summary: this.#summary,
      topContainers: top,
      supportedFilters: ["updatedAfter", "updatedBefore", "container", "author"],
    };
  }
}

function integerOptionOrInvalid(name: string, value: number | undefined, fallback: number, min: number, max: number): number {
  try {
    return integerOption(name, value, fallback, min, max);
  } catch (error) {
    throw new ConnectorError("invalid_request", error instanceof Error ? error.message : `${name} is invalid`);
  }
}

export function createEsaConnector(options: EsaConnectorOptions): EsaConnector {
  return new EsaConnector(options);
}
