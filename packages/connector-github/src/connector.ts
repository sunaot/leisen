/**
 * GitHub コネクタ(T-019)。connector-sdk v0.4 の Connector を GitHub REST API
 * (Search / Issues / Contents / Orgs / Repos)で実装する。
 *
 * - 認可は GitHub に委譲する。全呼び出しを利用者本人の user access token で行い、
 *   権限外のリポジトリは GitHub 側で結果から除外される(auth-matrix §4)。
 *   独自の権限判定・ACL複製はしない(不変条件1)。本番の資格情報は GitHub App の
 *   user access token に限る(ADR-010 方式A。Token Vault の失効管理 TM-C4 の対象に
 *   するため)。PAT は開発時の MockCredentialProvider 経由に限る
 * - filters.container(repo: / org: 修飾子)は検索範囲のヒントであって安全境界では
 *   ない(修飾子は検索語にも書ける)。範囲外の結果を防ぐのは GitHub 側の認可である
 * - nativeSearch は "degraded": issue/PR は語彙検索、コード検索はデフォルト
 *   ブランチのみ・語彙一致のみ・厳しいレート制限(ADR-008 §5: コード専用索引は
 *   コア外)
 * - SearchResult に総件数を載せない。GitHub の total_count は読み捨てる(ADR-012)
 * - 検索・fetch 結果をキャッシュしない(ユーザー間共有の経路を作らない、不変条件4)
 * - プライベート領域(ADR-016 追補2 決定7): privateScopeHandling は "classified"。
 *   ソース側では除外せず、結果に scope を付けて除外は Gateway に任せる。GitHub には DM に
 *   当たる領域がなく、組織のリポジトリ(private / internal を含む)は shared とする。
 *   GitHub App を組織にだけインストールする前提(README の前提表)で、個人アカウントの
 *   非公開リポジトリは検索に現れない。ただし結果のメタデータから「所有者が個人アカウント
 *   (owner.type が User)で公開と確認できない」と判定できるもの(コード検索のヒット、
 *   list の repo)は private にする(開発用 PAT の経路への備え)。issue / PR の検索結果と
 *   fetch の応答は所有者の種別を含まないため shared(README「プライベート領域」)
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
import {
  GITHUB_TEXT_MATCH_MEDIA_TYPE,
  GitHubApiClient,
  type GitHubApiClientOptions,
} from "./api.js";
import {
  MAX_PER_PAGE,
  MAX_SEARCH_LIMIT,
  SEARCH_RESULT_WINDOW,
  decodeListCursor,
  decodePageCursor,
  decodeSearchCursor,
  encodeListCursor,
  encodePageCursor,
  encodeSearchCursor,
  type SearchStreamKind,
  type SearchStreamState,
} from "./cursor.js";
import {
  contentApiPath,
  decodeDocumentId,
  isValidContentPath,
  isValidOwner,
  isValidRef,
  parseRepoFullName,
  repoApiPath,
  tryEncodeDocumentId,
  type GitHubDocumentRef,
} from "./document-id.js";
import { integerOption } from "./options.js";
import {
  collapseWhitespace,
  decodeBase64Text,
  pageOfText,
  stripHtmlComments,
  truncateText,
} from "./text.js";

export const DEFAULT_GITHUB_SOURCE_ID = "github";
export const DEFAULT_SEARCH_LIMIT = 20;
/**
 * search の limit 上限(GitHub の per_page 上限 100 以内)。カーソル検証
 * (per_page 合計の上限)と共有するため cursor.ts で定義し、ここで再公開する。
 */
export { MAX_SEARCH_LIMIT };
export const DEFAULT_PAGE_CHARS = 20_000;
export const DEFAULT_MAX_COMMENTS = 30;
export const DEFAULT_LIST_PAGE_SIZE = 100;
export const DEFAULT_MAX_TOP_CONTAINERS = 30;

const SUPPORTED_FILTERS: readonly (keyof SearchFilters)[] = [
  "updatedAfter",
  "updatedBefore",
  "container",
  "author",
];

/** 検索結果の統合順(round-robin の順序、limit 配分の優先順)。 */
const STREAM_ORDER: readonly SearchStreamKind[] = ["issue", "pr", "code"];

export interface GitHubConnectorOptions extends GitHubApiClientOptions {
  /** Connector.sourceId(deployment.yaml の connectors[].id と一致させる)。既定 "github" */
  readonly sourceId?: string;
  /** describe の表示名。既定 "GitHub" */
  readonly displayName?: string;
  /**
   * コード検索(/search/code)を行うか。既定 true。認証時でも毎分約10回と
   * 厳しいため、導入によっては false にして issue/PR 検索のみにする。
   */
  readonly searchCode?: boolean;
  /** search の limit 未指定時の返却件数。既定 20(1〜100) */
  readonly defaultSearchLimit?: number;
  /** snippet の最大文字数。既定かつ上限は MAX_SNIPPET_CHARS */
  readonly snippetChars?: number;
  /** fetch の1ページの文字数。既定 20000 */
  readonly pageChars?: number;
  /** fetch で issue/PR に含めるコメント数(最初の1ページのみ)。既定 30(0〜100) */
  readonly maxComments?: number;
  /** list の1ページの件数。既定 100(1〜100) */
  readonly listPageSize?: number;
  /** describe の topContainers(本人の所属 org)の上限数。既定 30(0〜100) */
  readonly maxTopContainers?: number;
}

interface LoadedDocument {
  readonly title: string;
  readonly url: string;
  readonly content: string;
}

interface StreamOutcome {
  readonly hits: SearchHit[];
  readonly next: SearchStreamState | undefined;
}

interface Page<T> {
  readonly entries: T[];
  readonly hasNextPage: boolean;
}

export class GitHubConnector implements Connector {
  readonly sourceId: string;
  readonly capabilities: ConnectorCapabilities = {
    nativeSearch: "degraded",
    ingest: false,
    privateScopeHandling: "classified",
  };
  private readonly api: GitHubApiClient;
  private readonly displayName: string;
  private readonly searchCode: boolean;
  private readonly defaultSearchLimit: number;
  private readonly snippetChars: number;
  private readonly pageChars: number;
  private readonly maxComments: number;
  private readonly listPageSize: number;
  private readonly maxTopContainers: number;
  private readonly webBaseUrl: string;

  constructor(options: GitHubConnectorOptions = {}) {
    const sourceId = options.sourceId ?? DEFAULT_GITHUB_SOURCE_ID;
    if (sourceId.trim() === "") {
      throw new RangeError("sourceId must be a non-empty string");
    }
    this.sourceId = sourceId;
    this.displayName = options.displayName ?? "GitHub";
    this.api = new GitHubApiClient(options);
    this.searchCode = options.searchCode ?? true;
    this.defaultSearchLimit = integerOption(
      "defaultSearchLimit",
      options.defaultSearchLimit,
      DEFAULT_SEARCH_LIMIT,
      1,
      MAX_SEARCH_LIMIT,
    );
    this.snippetChars = integerOption(
      "snippetChars",
      options.snippetChars,
      MAX_SNIPPET_CHARS,
      0,
      MAX_SNIPPET_CHARS,
    );
    this.pageChars = integerOption(
      "pageChars",
      options.pageChars,
      DEFAULT_PAGE_CHARS,
      2,
      1_000_000,
    );
    this.maxComments = integerOption(
      "maxComments",
      options.maxComments,
      DEFAULT_MAX_COMMENTS,
      0,
      MAX_PER_PAGE,
    );
    this.listPageSize = integerOption(
      "listPageSize",
      options.listPageSize,
      DEFAULT_LIST_PAGE_SIZE,
      1,
      MAX_PER_PAGE,
    );
    this.maxTopContainers = integerOption(
      "maxTopContainers",
      options.maxTopContainers,
      DEFAULT_MAX_TOP_CONTAINERS,
      0,
      MAX_PER_PAGE,
    );
    this.webBaseUrl = webBaseUrlOf(this.api.baseUrl);
  }

  // ---- search ----

  /**
   * issue(is:issue)・PR(is:pull-request)・コードの3本を本人トークンで並行に
   * 検索し、round-robin で統合する。
   * - issue と PR は別クエリにする(GitHub App の user access token では両者を
   *   1クエリで混在検索できず 422 になるため。Search API ドキュメント)
   * - limit は各ストリームの per_page に配分する(合計が limit)。カーソルは
   *   ストリームごとのページ番号を符号化し、継続時は初回の配分を引き継ぐ
   * - 一部のストリームだけが失敗した場合は残りの結果を返す(degraded)。
   *   rate_limited / source_unavailable のストリームは nextCursor に同じ
   *   ページを残して再試行できるようにする。auth_expired は常に失敗として返す
   */
  async search(
    auth: AuthContext,
    query: string,
    filters: SearchFilters = {},
    options: SearchOptions = {},
  ): Promise<SearchResult> {
    this.api.assertUsableCredential(auth);

    const terms = query.trim();
    const scope = containerQualifier(filters.container);
    const qualifiers = [
      ...(scope !== undefined ? [scope] : []),
      ...authorQualifier(filters.author),
      ...dateQualifiers(filters),
    ];
    if (terms === "" && qualifiers.length === 0) {
      throw new ConnectorError("invalid_request", "search query must not be empty");
    }
    // コード検索は検索語が必須で、author / updated 修飾子に対応しない。
    // フィルタを満たさない結果を混ぜないよう、その場合はコード検索を行わない
    const codeEligible =
      this.searchCode &&
      terms !== "" &&
      isAbsent(filters.author) &&
      isAbsent(filters.updatedAfter) &&
      isAbsent(filters.updatedBefore);

    const streams =
      options.cursor !== undefined
        ? decodeSearchCursor(options.cursor).filter(
            (stream) => stream.kind !== "code" || codeEligible,
          )
        : initialStreams(this.resolveLimit(options.limit), codeEligible);

    const issueQuery = [terms, ...qualifiers].filter((part) => part !== "").join(" ");
    const codeQuery = [terms, ...(scope !== undefined ? [scope] : [])].join(" ");

    const settled = await Promise.allSettled(
      streams.map((stream) =>
        this.searchStream(
          auth,
          stream,
          stream.kind === "code"
            ? codeQuery
            : `${issueQuery} ${stream.kind === "issue" ? "is:issue" : "is:pull-request"}`,
        ),
      ),
    );

    const hitLists: SearchHit[][] = [];
    const nextStreams: SearchStreamState[] = [];
    let firstError: ConnectorError | undefined;
    let authError: ConnectorError | undefined;
    let succeeded = 0;
    for (const [index, result] of settled.entries()) {
      const stream = streams[index];
      if (stream === undefined) {
        continue;
      }
      if (result.status === "fulfilled") {
        succeeded += 1;
        hitLists.push(result.value.hits);
        if (result.value.next !== undefined) {
          nextStreams.push(result.value.next);
        }
        continue;
      }
      const error: unknown = result.reason;
      if (!(error instanceof ConnectorError)) {
        // 分類済みでない例外(実装の不具合)は握りつぶさない
        throw error;
      }
      if (error.errorClass === "auth_expired") {
        authError ??= error;
      }
      firstError ??= error;
      if (
        error.errorClass === "rate_limited" ||
        error.errorClass === "source_unavailable"
      ) {
        // 同じページを再試行できるよう残す
        nextStreams.push(stream);
      }
    }
    if (authError !== undefined) {
      throw authError;
    }
    if (succeeded === 0 && firstError !== undefined) {
      throw firstError;
    }

    const hits = interleave(hitLists);
    return nextStreams.length > 0
      ? { hits, nextCursor: encodeSearchCursor(nextStreams) }
      : { hits };
  }

  private resolveLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit)) {
      return this.defaultSearchLimit;
    }
    return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(limit)));
  }

  private async searchStream(
    auth: AuthContext,
    stream: SearchStreamState,
    q: string,
  ): Promise<StreamOutcome> {
    const code = stream.kind === "code";
    const response = await this.api.get(auth, {
      endpoint: code ? "search.code" : "search.issues",
      resource: code ? "code_search" : "search",
      path: code ? "/search/code" : "/search/issues",
      query: { q, per_page: stream.perPage, page: stream.page },
      // コード検索は一致箇所の断片(text_matches)を snippet に使う
      ...(code ? { accept: GITHUB_TEXT_MATCH_MEDIA_TYPE } : {}),
    });
    // total_count / incomplete_results は読まない(件数を外へ出さない、ADR-012)
    const items = asRecord(response.data)?.items;
    if (!Array.isArray(items)) {
      throw unexpectedShape(code ? "search.code" : "search.issues");
    }
    const hits: SearchHit[] = [];
    for (const item of items.slice(0, stream.perPage)) {
      const hit = code ? this.codeHit(item) : this.issueHit(item);
      if (hit !== undefined) {
        hits.push(hit);
      }
    }
    const hasNext =
      response.hasNextPage && stream.page * stream.perPage < SEARCH_RESULT_WINDOW;
    return {
      hits,
      next: hasNext ? { ...stream, page: stream.page + 1 } : undefined,
    };
  }

  private issueHit(item: unknown): SearchHit | undefined {
    const record = asRecord(item);
    if (record === undefined) {
      return undefined;
    }
    const repo = repoFromApiUrl(asString(record.repository_url));
    const number = asPositiveInteger(record.number);
    const title = asString(record.title);
    if (repo === undefined || number === undefined || title === undefined) {
      return undefined;
    }
    const isPullRequest = asRecord(record.pull_request) !== undefined;
    const ref: GitHubDocumentRef = {
      type: isPullRequest ? "pr" : "issue",
      owner: repo.owner,
      repo: repo.repo,
      number,
    };
    const documentId = tryEncodeDocumentId(ref);
    if (documentId === undefined) {
      return undefined;
    }
    const body = asString(record.body) ?? "";
    const updatedAt = asString(record.updated_at);
    const state = asString(record.state);
    const author = asString(asRecord(record.user)?.login);
    return {
      documentId,
      title,
      snippet: truncateText(
        collapseWhitespace(stripHtmlComments(body)),
        this.snippetChars,
      ),
      url:
        asHttpUrl(record.html_url) ??
        `${this.webBaseUrl}/${repo.owner}/${repo.repo}/${isPullRequest ? "pull" : "issues"}/${number}`,
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      meta: {
        type: isPullRequest ? "pull_request" : "issue",
        repository: `${repo.owner}/${repo.repo}`,
        number: String(number),
        ...(state !== undefined ? { state } : {}),
        ...(author !== undefined ? { author } : {}),
      },
      // 検索 API の issue / PR は通常 repository(所有者の種別)を含まない。含む場合だけ判定する
      scope: scopeOfRepository(record.repository),
    };
  }

  private codeHit(item: unknown): SearchHit | undefined {
    const record = asRecord(item);
    if (record === undefined) {
      return undefined;
    }
    const path = asString(record.path);
    const fullName = asString(asRecord(record.repository)?.full_name);
    const repo = fullName !== undefined ? parseRepoFullName(fullName) : undefined;
    if (path === undefined || repo === undefined || !isValidContentPath(path)) {
      return undefined;
    }
    const gitRef = refOfCodeItem(record) ?? "";
    const documentId = tryEncodeDocumentId({
      type: "file",
      owner: repo.owner,
      repo: repo.repo,
      ref: gitRef,
      path,
    });
    if (documentId === undefined) {
      return undefined;
    }
    return {
      documentId,
      title: path,
      snippet: truncateText(codeFragments(record.text_matches), this.snippetChars),
      url: asHttpUrl(record.html_url) ?? this.blobUrl(repo.owner, repo.repo, gitRef, path),
      anchor: { kind: "section", value: path, label: path },
      meta: {
        type: "code",
        repository: `${repo.owner}/${repo.repo}`,
        path,
        ...(gitRef !== "" ? { ref: gitRef } : {}),
      },
      scope: scopeOfRepository(record.repository),
    };
  }

  // ---- fetch ----

  /**
   * documentId の本文を返す。issue/PR は本文+先頭コメント(最初の1ページ、
   * maxComments 件まで)、file は contents API の base64 本文(1MB 以下の
   * テキストのみ。バイナリ・巨大ファイルは invalid_request)。
   * 本文は pageChars ごとにページングする。ページ取得のたびにソースから
   * 取り直す(本文をキャッシュしない。不変条件4)。
   */
  async fetch(
    auth: AuthContext,
    documentId: string,
    pageCursor?: string,
  ): Promise<FetchResult> {
    this.api.assertUsableCredential(auth);
    const ref = decodeDocumentId(documentId);
    const pageIndex = pageCursor === undefined ? 0 : decodePageCursor(pageCursor);

    const document =
      ref.type === "file"
        ? await this.loadFile(auth, ref)
        : await this.loadIssue(auth, ref);

    const page = pageOfText(document.content, this.pageChars, pageIndex);
    if (page === undefined) {
      throw new ConnectorError(
        "invalid_request",
        "page cursor is out of range for this document",
      );
    }
    return {
      documentId,
      title: document.title,
      content: page.content,
      url: document.url,
      ...(page.hasNext ? { nextPageCursor: encodePageCursor(pageIndex + 1) } : {}),
      // issues.get / repos.getContent の応答は所有者の種別を含まないため判定できない。
      // GitHub App を組織にだけインストールする前提で shared(README「プライベート領域」)
      scope: "shared",
    };
  }

  private async loadIssue(
    auth: AuthContext,
    ref: Extract<GitHubDocumentRef, { type: "issue" | "pr" }>,
  ): Promise<LoadedDocument> {
    const issuePath = `${repoApiPath(ref.owner, ref.repo)}/issues/${ref.number}`;
    const response = await this.api.get(auth, {
      endpoint: "issues.get",
      resource: "core",
      path: issuePath,
    });
    const issue = asRecord(response.data);
    if (issue === undefined) {
      throw unexpectedShape("issues.get");
    }

    const commentCount = asNonNegativeInteger(issue.comments) ?? 0;
    let comments: unknown[] = [];
    if (this.maxComments > 0 && commentCount > 0) {
      const commentResponse = await this.api.get(auth, {
        endpoint: "issues.listComments",
        resource: "core",
        path: `${issuePath}/comments`,
        query: { per_page: this.maxComments, page: 1 },
      });
      if (!Array.isArray(commentResponse.data)) {
        throw unexpectedShape("issues.listComments");
      }
      comments = commentResponse.data.slice(0, this.maxComments);
    }

    const isPullRequest = asRecord(issue.pull_request) !== undefined;
    const title = asString(issue.title) ?? `${ref.owner}/${ref.repo}#${ref.number}`;
    return {
      title,
      url:
        asHttpUrl(issue.html_url) ??
        `${this.webBaseUrl}/${ref.owner}/${ref.repo}/${isPullRequest ? "pull" : "issues"}/${ref.number}`,
      content: formatIssue(ref, issue, title, comments, commentCount),
    };
  }

  private async loadFile(
    auth: AuthContext,
    ref: Extract<GitHubDocumentRef, { type: "file" }>,
  ): Promise<LoadedDocument> {
    const response = await this.api.get(auth, {
      endpoint: "repos.getContent",
      resource: "core",
      path: contentApiPath(ref.owner, ref.repo, ref.path),
      ...(ref.ref !== "" ? { query: { ref: ref.ref } } : {}),
    });
    if (Array.isArray(response.data)) {
      throw new ConnectorError(
        "invalid_request",
        "documentId refers to a directory, not a file",
      );
    }
    const file = asRecord(response.data);
    if (file === undefined) {
      throw unexpectedShape("repos.getContent");
    }
    if (file.type !== "file") {
      // symlink(リポジトリ外を指すもの)・submodule 等
      throw new ConnectorError(
        "invalid_request",
        "documentId does not refer to a regular file",
      );
    }
    const content = asString(file.content);
    if (file.encoding !== "base64" || content === undefined) {
      throw new ConnectorError(
        "invalid_request",
        "file content is not available as text (binary, or larger than the 1MB contents API limit)",
      );
    }
    const text = decodeBase64Text(content);
    if (text === undefined) {
      throw new ConnectorError(
        "invalid_request",
        "binary files cannot be fetched as text",
      );
    }
    return {
      title: ref.path,
      url: asHttpUrl(file.html_url) ?? this.blobUrl(ref.owner, ref.repo, ref.ref, ref.path),
      content: text,
    };
  }

  // ---- list ----

  /**
   * - containerId 未指定: 本人の所属 org(kind "other")→ 本人がアクセスできる
   *   repo(kind "repository")の順に列挙する
   * - containerId が org 名: その org の repo のうち本人に見えるもの
   * repo の配下(ディレクトリ)は列挙しない(search の filters.container で絞る)。
   */
  async list(
    auth: AuthContext,
    containerId?: string,
    cursor?: string,
  ): Promise<ListResult> {
    this.api.assertUsableCredential(auth);
    if (containerId === undefined || containerId === "") {
      return this.listRoot(auth, cursor);
    }
    if (isValidOwner(containerId)) {
      return this.listOrgRepos(auth, containerId, cursor);
    }
    if (parseRepoFullName(containerId) !== undefined) {
      throw new ConnectorError(
        "invalid_request",
        'a repository has no child containers; search it with filters.container = "owner/repo"',
      );
    }
    throw new ConnectorError(
      "invalid_request",
      "invalid containerId (expected an organization login)",
    );
  }

  private async listRoot(auth: AuthContext, cursor: string | undefined): Promise<ListResult> {
    const position =
      cursor === undefined
        ? ({ phase: "orgs", page: 1 } as const)
        : decodeListCursor(cursor, undefined);

    if (position.phase === "orgs") {
      const orgs = await this.fetchOrgs(auth, position.page, this.listPageSize);
      if (orgs.hasNextPage) {
        return {
          entries: orgs.entries,
          nextCursor: encodeListCursor({ phase: "orgs", page: position.page + 1 }),
        };
      }
      // org を列挙し終えたページでは repo の先頭ページも続けて返す
      const repos = await this.fetchRepos(auth, "/user/repos", "repos.listForAuthenticatedUser", 1);
      return {
        entries: [...orgs.entries, ...repos.entries],
        ...(repos.hasNextPage
          ? { nextCursor: encodeListCursor({ phase: "repos", page: 2 }) }
          : {}),
      };
    }

    const repos = await this.fetchRepos(
      auth,
      "/user/repos",
      "repos.listForAuthenticatedUser",
      position.page,
    );
    return {
      entries: repos.entries,
      ...(repos.hasNextPage
        ? { nextCursor: encodeListCursor({ phase: "repos", page: position.page + 1 }) }
        : {}),
    };
  }

  private async listOrgRepos(
    auth: AuthContext,
    org: string,
    cursor: string | undefined,
  ): Promise<ListResult> {
    const page = cursor === undefined ? 1 : decodeListCursor(cursor, org).page;
    const repos = await this.fetchRepos(
      auth,
      `/orgs/${encodeURIComponent(org)}/repos`,
      "repos.listForOrg",
      page,
    );
    return {
      entries: repos.entries,
      ...(repos.hasNextPage
        ? { nextCursor: encodeListCursor({ phase: "org_repos", page: page + 1, org }) }
        : {}),
    };
  }

  private async fetchOrgs(
    auth: AuthContext,
    page: number,
    perPage: number,
  ): Promise<Page<ContainerEntry>> {
    const response = await this.api.get(auth, {
      endpoint: "orgs.listForAuthenticatedUser",
      resource: "core",
      path: "/user/orgs",
      query: { per_page: perPage, page },
    });
    if (!Array.isArray(response.data)) {
      throw unexpectedShape("orgs.listForAuthenticatedUser");
    }
    const entries: ContainerEntry[] = [];
    for (const item of response.data) {
      const login = asString(asRecord(item)?.login);
      if (login !== undefined && isValidOwner(login)) {
        // 組織は業務の領域(shared)
        entries.push({ id: login, name: login, kind: "other", scope: "shared" });
      }
    }
    return { entries, hasNextPage: response.hasNextPage };
  }

  private async fetchRepos(
    auth: AuthContext,
    path: string,
    endpoint: string,
    page: number,
  ): Promise<Page<ContainerEntry>> {
    const response = await this.api.get(auth, {
      endpoint,
      resource: "core",
      path,
      query: { per_page: this.listPageSize, page, sort: "full_name" },
    });
    if (!Array.isArray(response.data)) {
      throw unexpectedShape(endpoint);
    }
    const entries: ContainerEntry[] = [];
    for (const item of response.data) {
      const fullName = asString(asRecord(item)?.full_name);
      if (fullName !== undefined && parseRepoFullName(fullName) !== undefined) {
        entries.push({
          id: fullName,
          name: fullName,
          kind: "repository",
          scope: scopeOfRepository(item),
        });
      }
    }
    return { entries, hasNextPage: response.hasNextPage };
  }

  // ---- describe ----

  /** 本人の所属 org を topContainers として返す(本人トークンで取得、TM-B3)。 */
  async describe(auth: AuthContext): Promise<SourceDescription> {
    this.api.assertUsableCredential(auth);
    const topContainers =
      this.maxTopContainers > 0
        ? (await this.fetchOrgs(auth, 1, this.maxTopContainers)).entries.slice(
            0,
            this.maxTopContainers,
          )
        : [];
    return {
      sourceId: this.sourceId,
      displayName: this.displayName,
      summary: this.summary(),
      topContainers,
      supportedFilters: [...SUPPORTED_FILTERS],
    };
  }

  private summary(): string {
    const scope =
      "利用者本人がアクセスできる GitHub の issue・pull request" +
      (this.searchCode ? "・コード" : "") +
      "を GitHub 検索 API で検索する(権限外のリポジトリは結果に現れない)。" +
      "issue・PR はタイトル・本文・コメントの語彙一致検索。";
    const code = this.searchCode
      ? "コード検索は degraded: デフォルトブランチのみ・384KB 未満のファイル・語彙一致のみで、" +
        "レート制限が厳しい(認証時 毎分約10回)。author / updatedAfter / updatedBefore を指定するとコード検索は行わない。"
      : "コード検索はこの導入では無効(issue・PR のみを検索する)。";
    const usage =
      'filters.container は "owner/repo" または組織名で、検索範囲を絞るヒントであり安全境界ではない' +
      "(範囲外の結果を防ぐのは GitHub 側の本人権限による認可)。filters.author は GitHub のログイン名。" +
      "fetch は issue / PR の本文と先頭のコメント、または 1MB 以下のテキストファイルを返す。";
    return `${scope}${code}${usage}`;
  }

  private blobUrl(owner: string, repo: string, gitRef: string, path: string): string {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const refSegment = gitRef !== "" ? encodeURIComponent(gitRef) : "HEAD";
    return `${this.webBaseUrl}/${owner}/${repo}/blob/${refSegment}/${encodedPath}`;
  }
}

export function createGitHubConnector(
  options: GitHubConnectorOptions = {},
): GitHubConnector {
  return new GitHubConnector(options);
}

// ---- 検索クエリの組み立て ----

function isAbsent(value: string | undefined): boolean {
  return value === undefined || value === "";
}

/**
 * filters.container → repo: / org: 修飾子。値は構文で検証し、空白や
 * コロンによる修飾子の混入を拒否する。
 */
function containerQualifier(container: string | undefined): string | undefined {
  if (container === undefined || container === "") {
    return undefined;
  }
  const repo = parseRepoFullName(container);
  if (repo !== undefined) {
    return `repo:${repo.owner}/${repo.repo}`;
  }
  if (isValidOwner(container)) {
    return `org:${container}`;
  }
  throw new ConnectorError(
    "invalid_request",
    'filters.container must be "owner/repo" or an organization login',
  );
}

/** filters.author → author: 修飾子(GitHub App の bot は "name[bot]")。 */
function authorQualifier(author: string | undefined): string[] {
  if (author === undefined || author === "") {
    return [];
  }
  const login = author.startsWith("@") ? author.slice(1) : author;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}(\[bot\])?$/.test(login)) {
    throw new ConnectorError(
      "invalid_request",
      "filters.author must be a GitHub login",
    );
  }
  return [`author:${login}`];
}

/** updatedAfter / updatedBefore → updated:>= / updated:<=(ISO 8601 を UTC に正規化)。 */
function dateQualifiers(filters: SearchFilters): string[] {
  const qualifiers: string[] = [];
  if (!isAbsent(filters.updatedAfter)) {
    qualifiers.push(`updated:>=${isoDate(filters.updatedAfter, "updatedAfter")}`);
  }
  if (!isAbsent(filters.updatedBefore)) {
    qualifiers.push(`updated:<=${isoDate(filters.updatedBefore, "updatedBefore")}`);
  }
  return qualifiers;
}

function isoDate(value: string | undefined, name: string): string {
  const time = value === undefined ? Number.NaN : Date.parse(value);
  if (Number.isNaN(time)) {
    throw new ConnectorError(
      "invalid_request",
      `filters.${name} must be an ISO 8601 date-time`,
    );
  }
  // 修飾子に入る値は正規化した日時だけにする(利用者入力を直接埋め込まない)
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function initialStreams(limit: number, includeCode: boolean): SearchStreamState[] {
  const kinds = STREAM_ORDER.filter((kind) => kind !== "code" || includeCode);
  const base = Math.floor(limit / kinds.length);
  const remainder = limit % kinds.length;
  return kinds
    .map((kind, index) => ({
      kind,
      page: 1,
      perPage: base + (index < remainder ? 1 : 0),
    }))
    .filter((stream) => stream.perPage > 0);
}

function interleave(lists: readonly SearchHit[][]): SearchHit[] {
  const merged: SearchHit[] = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let index = 0; index < longest; index += 1) {
    for (const list of lists) {
      const hit = list[index];
      if (hit !== undefined) {
        merged.push(hit);
      }
    }
  }
  return merged;
}

function codeFragments(textMatches: unknown): string {
  if (!Array.isArray(textMatches)) {
    return "";
  }
  const fragments: string[] = [];
  for (const match of textMatches) {
    const fragment = asString(asRecord(match)?.fragment);
    if (fragment !== undefined && fragment.trim() !== "") {
      fragments.push(fragment.replace(/\r\n?/g, "\n").trim());
    }
  }
  return fragments.join("\n…\n");
}

/** code search の item から ref(コミットSHA)を取り出す。url の ?ref= → html_url の /blob/<ref>/。 */
function refOfCodeItem(record: Record<string, unknown>): string | undefined {
  const apiUrl = parseUrl(asString(record.url));
  const fromQuery = apiUrl?.searchParams.get("ref");
  if (fromQuery !== undefined && fromQuery !== null && isValidRef(fromQuery)) {
    return fromQuery;
  }
  const htmlUrl = parseUrl(asString(record.html_url));
  const match = htmlUrl !== undefined ? /\/blob\/([^/]+)\//.exec(htmlUrl.pathname) : null;
  if (match?.[1] !== undefined) {
    const candidate = safeDecode(match[1]);
    if (candidate !== undefined && isValidRef(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** ".../repos/{owner}/{repo}" 形式の API URL から owner / repo を取り出す(GHES の /api/v3 にも対応)。 */
function repoFromApiUrl(value: string | undefined): { owner: string; repo: string } | undefined {
  const url = parseUrl(value);
  const match = url !== undefined ? /\/repos\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname) : null;
  if (match?.[1] === undefined || match[2] === undefined) {
    return undefined;
  }
  const owner = safeDecode(match[1]);
  const repo = safeDecode(match[2]);
  if (owner === undefined || repo === undefined) {
    return undefined;
  }
  return parseRepoFullName(`${owner}/${repo}`);
}

// ---- 本文の整形 ----

function formatIssue(
  ref: Extract<GitHubDocumentRef, { type: "issue" | "pr" }>,
  issue: Record<string, unknown>,
  title: string,
  comments: readonly unknown[],
  commentCount: number,
): string {
  const pullRequest = asRecord(issue.pull_request);
  const merged = asString(pullRequest?.merged_at) !== undefined;
  const state = merged ? "merged" : asString(issue.state);
  const author = asString(asRecord(issue.user)?.login);
  const labels = Array.isArray(issue.labels)
    ? issue.labels
        .map((label) => asString(asRecord(label)?.name))
        .filter((name): name is string => name !== undefined)
    : [];

  const facts = [
    `${pullRequest !== undefined ? "Pull request" : "Issue"} ${ref.owner}/${ref.repo}#${ref.number}`,
    ...(state !== undefined ? [`state: ${state}`] : []),
    ...(author !== undefined ? [`author: @${author}`] : []),
    ...optionalFact("created", asString(issue.created_at)),
    ...optionalFact("updated", asString(issue.updated_at)),
    ...(labels.length > 0 ? [`labels: ${labels.join(", ")}`] : []),
  ];
  const lines = [`# ${title}`, facts.join(" | "), "", asString(issue.body) || "(no description)"];

  if (comments.length > 0) {
    const more = commentCount > comments.length ? ` of ${commentCount}` : "";
    lines.push("", `## Comments (first ${comments.length}${more})`);
    for (const comment of comments) {
      const record = asRecord(comment);
      const login = asString(asRecord(record?.user)?.login) ?? "unknown";
      const createdAt = asString(record?.created_at);
      lines.push(
        "",
        `### @${login}${createdAt !== undefined ? ` (${createdAt})` : ""}`,
        asString(record?.body) ?? "",
      );
    }
  }
  return lines.join("\n");
}

function optionalFact(label: string, value: string | undefined): string[] {
  return value !== undefined ? [`${label}: ${value}`] : [];
}

// ---- 実行時の形状検査(外部APIの応答を型アサーションだけで信用しない) ----

/**
 * リポジトリの領域(ADR-016 追補2 決定7、README「プライベート領域」)。
 * - 所有者が個人アカウント(owner.type === "User")で、公開(private: false または
 *   visibility: "public")と確認できないもの → private(個人スコープ。迷うものは private)
 * - それ以外(組織の所有、公開の個人リポジトリ、所有者の種別が分からないもの)→ shared。
 *   種別が分からないものを shared にするのは、GitHub App を組織にだけインストールする
 *   前提(README の前提表)で個人の非公開リポジトリが結果に現れないため
 */
export function scopeOfRepository(repository: unknown): DocumentScope {
  const record = asRecord(repository);
  if (asString(asRecord(record?.owner)?.type) !== "User") {
    return "shared";
  }
  const isPublic = record?.private === false || record?.visibility === "public";
  return isPublic ? "shared" : "private";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value
    : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function parseUrl(value: string | undefined): URL | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** http(s) の URL のみ採用する(javascript: 等を結果に載せない)。 */
function asHttpUrl(value: unknown): string | undefined {
  const url = parseUrl(asString(value));
  return url !== undefined && (url.protocol === "https:" || url.protocol === "http:")
    ? url.toString()
    : undefined;
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function unexpectedShape(endpoint: string): ConnectorError {
  return new ConnectorError(
    "source_unavailable",
    `GitHub API ${endpoint} returned an unexpected response shape`,
  );
}

/**
 * API のベースURLから Web の URL を導く(html_url が欠けた場合の予備)。
 * api.github.com → github.com、api.<sub>.ghe.com → <sub>.ghe.com、
 * GitHub Enterprise Server(https://HOST/api/v3)→ https://HOST。
 */
function webBaseUrlOf(apiBaseUrl: string): string {
  const url = new URL(apiBaseUrl);
  if (url.hostname.startsWith("api.")) {
    return `${url.protocol}//${url.hostname.slice(4)}${url.port !== "" ? `:${url.port}` : ""}`;
  }
  return url.origin;
}
