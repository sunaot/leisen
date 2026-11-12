import {
  ConnectorError,
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

type FetchLike = typeof fetch;
type JsonObject = Record<string, unknown>;

export interface RedmineConnectorOptions {
  readonly sourceId: string;
  readonly baseUrl?: string;
  readonly displayName?: string;
  readonly timeoutMs?: number;
  readonly defaultSearchLimit?: number;
  readonly fetchImpl?: FetchLike;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const MAX_PAGE_SIZE = 100;
const CAPABILITIES: ConnectorCapabilities = {
  nativeSearch: "degraded",
  ingest: false,
  privateScopeHandling: "classified",
};

function record(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function finiteInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function safeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function encodedCursor(value: number): string {
  return `offset:${value}`;
}

function cursorOffset(value: string | undefined): number {
  if (value === undefined) return 0;
  const match = /^offset:(\d{1,10})$/.exec(value);
  if (!match) throw new ConnectorError("invalid_request", "invalid Redmine cursor");
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset)) {
    throw new ConnectorError("invalid_request", "invalid Redmine cursor");
  }
  return offset;
}

function baseUrlOf(value: string | undefined): URL {
  let url: URL;
  try {
    url = new URL(value ?? "https://redmine.example.invalid");
  } catch {
    throw new ConnectorError("invalid_request", "baseUrl must be an absolute URL");
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ConnectorError(
      "invalid_request",
      "baseUrl must use https (http is allowed on loopback) and must not contain credentials, query, or fragment",
    );
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

function issueDocumentId(id: number): string {
  return `issue:${id}`;
}

function issueNoteDocumentId(issueId: number, noteId: number): string {
  return `issue-note:${issueId}:${noteId}`;
}

function findJournal(issue: JsonObject, noteId: number): JsonObject | undefined {
  if (!Array.isArray(issue.journals)) return undefined;
  for (const entry of issue.journals) {
    const journal = record(entry);
    if (journal?.id === noteId) return journal;
  }
  return undefined;
}

function wikiDocumentId(project: string, title: string): string {
  return `wiki:${encodeURIComponent(project)}/${encodeURIComponent(title)}`;
}

function decodeWikiDocumentId(documentId: string): { project: string; title: string } | undefined {
  const match = /^wiki:([^/]+)\/(.+)$/.exec(documentId);
  if (!match) return undefined;
  try {
    const project = decodeURIComponent(match[1] ?? "");
    const title = decodeURIComponent(match[2] ?? "");
    if (!project || !title || project.includes("/") || title.includes("\0")) return undefined;
    return { project, title };
  } catch {
    return undefined;
  }
}

export class RedmineConnector implements Connector {
  readonly sourceId: string;
  readonly capabilities = CAPABILITIES;
  private readonly baseUrl: URL;
  private readonly displayName: string;
  private readonly timeoutMs: number;
  private readonly defaultSearchLimit: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: RedmineConnectorOptions) {
    if (!options.sourceId) throw new ConnectorError("invalid_request", "sourceId is required");
    if (!options.baseUrl) throw new ConnectorError("invalid_request", "baseUrl is required");
    this.sourceId = options.sourceId;
    this.baseUrl = baseUrlOf(options.baseUrl);
    this.displayName = options.displayName ?? "Redmine";
    this.timeoutMs = this.integerOption("timeoutMs", options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 120_000);
    this.defaultSearchLimit = this.integerOption(
      "defaultSearchLimit",
      options.defaultSearchLimit,
      DEFAULT_SEARCH_LIMIT,
      1,
      MAX_SEARCH_LIMIT,
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async describe(auth: AuthContext): Promise<SourceDescription> {
    const projects = await this.projects(auth, 0, 20);
    return {
      sourceId: this.sourceId,
      displayName: this.displayName,
      summary:
        "本人の Redmine API キーで、アクセスできるプロジェクトの Issue、Issue のノート、Wiki ページを探す。ノートの検索可否を含め、検索対象は Redmine の設定やプラグインに依存する。",
      topContainers: projects.items.slice(0, 10).flatMap((project) => {
        const id = finiteInt(project.id);
        const name = string(project.name);
        if (id === undefined || !name) return [];
        return [this.projectEntry(id, name, project.is_public === true)];
      }),
      supportedFilters: [],
    };
  }

  async search(
    auth: AuthContext,
    query: string,
    _filters: SearchFilters = {},
    options: SearchOptions = {},
  ): Promise<SearchResult> {
    const q = query.trim();
    if (!q) throw new ConnectorError("invalid_request", "search query must not be empty");
    if (Object.values(_filters).some((value) => value !== undefined)) {
      throw new ConnectorError("invalid_request", "Redmine connector does not support search filters yet");
    }
    const limit = this.integerOption("limit", options.limit, this.defaultSearchLimit, 1, MAX_SEARCH_LIMIT);
    const offset = cursorOffset(options.cursor);
    const params = new URLSearchParams({
      q,
      issues: "1",
      wiki_pages: "1",
      all_words: "0",
      limit: String(limit),
      offset: String(offset),
    });
    const body = await this.request(auth, `search.json?${params.toString()}`);
    const root = record(body);
    const results = root?.results;
    if (!Array.isArray(results)) {
      throw new ConnectorError("source_unavailable", "Redmine returned an invalid search response");
    }
    const hits: SearchHit[] = [];
    const projectScopes = new Map<string, DocumentScope>();
    for (const raw of results) {
      const result = record(raw);
      if (!result) continue;
      const type = string(result.type)?.toLowerCase();
      const id = finiteInt(result.id);
      const title = safeText(result.title);
      if (!title) continue;
      const note = type === "issue-note" ? this.issueNoteLocation(result.url) : undefined;
      if (type === "issue-note" && (!note || note.noteId !== id)) continue;
      const issueId = note?.issueId ?? id;
      if (type?.includes("issue") && issueId !== undefined) {
        let issue: JsonObject;
        try {
          issue = await this.issue(auth, issueId, note !== undefined);
        } catch (error) {
          if (error instanceof ConnectorError && error.errorClass === "not_found") continue;
          throw error;
        }
        const journal = note ? findJournal(issue, note.noteId) : undefined;
        const notes = safeText(journal?.notes);
        if (note && !notes) continue;
        const desc = note ? notes : safeText(string(result.description) ?? issue.description);
        const updatedAt = string(result.datetime);
        const projectId = finiteInt(record(issue.project)?.id);
        let scope: DocumentScope = "private";
        const canBeShared = note
          ? issue.is_private === false && journal?.private_notes === false
          : issue.is_private !== true;
        if (canBeShared && projectId !== undefined) {
          const projectKey = String(projectId);
          let projectScope = projectScopes.get(projectKey);
          if (projectScope === undefined) {
            const project = await this.project(auth, projectKey);
            projectScope = project?.is_public === true ? "shared" : "private";
            projectScopes.set(projectKey, projectScope);
          }
          if (projectScope === "shared") scope = "shared";
        }
        hits.push({
          documentId: note ? issueNoteDocumentId(issueId, note.noteId) : issueDocumentId(issueId),
          title,
          snippet: desc.slice(0, 500),
          url: this.webUrl(note ? `issues/${issueId}#change-${note.noteId}` : `issues/${issueId}`),
          ...(updatedAt !== undefined ? { updatedAt } : {}),
          scope,
        });
      } else if (type?.includes("wiki")) {
        const parsed = this.wikiLocation(result.url);
        if (!parsed) continue;
        const project = await this.project(auth, parsed.project);
        if (!project) continue;
        const updatedAt = string(result.datetime);
        hits.push({
          documentId: wikiDocumentId(parsed.project, parsed.title),
          title,
          snippet: safeText(result.description).slice(0, 500),
          url: this.webUrl(`projects/${encodeURIComponent(parsed.project)}/wiki/${encodeURIComponent(parsed.title)}`),
          ...(updatedAt !== undefined ? { updatedAt } : {}),
          scope: project.is_public === true ? "shared" : "private",
        });
      }
    }
    const totalCount = finiteInt(root?.total_count);
    return {
      hits,
      ...(totalCount !== undefined && offset + results.length < totalCount
        ? { nextCursor: encodedCursor(offset + results.length) }
        : {}),
    };
  }

  async fetch(auth: AuthContext, documentId: string): Promise<FetchResult> {
    const noteMatch = /^issue-note:([1-9]\d{0,11}):([1-9]\d{0,11})$/.exec(documentId);
    if (noteMatch) {
      const issueId = Number(noteMatch[1]);
      const noteId = Number(noteMatch[2]);
      const issue = await this.issue(auth, issueId, true);
      const journal = findJournal(issue, noteId);
      const content = safeText(journal?.notes);
      if (!content) throw new ConnectorError("not_found", "Redmine issue note is not available");
      const projectId = finiteInt(record(issue.project)?.id);
      let scope: DocumentScope = "private";
      if (issue.is_private === false && journal?.private_notes === false && projectId !== undefined) {
        const project = await this.project(auth, String(projectId));
        if (project?.is_public === true) scope = "shared";
      }
      const subject = string(issue.subject) ?? `Issue #${issueId}`;
      return {
        documentId,
        title: `${subject} (note #${noteId})`,
        content: content.slice(0, 100_000),
        url: this.webUrl(`issues/${issueId}#change-${noteId}`),
        scope,
      };
    }
    const issueMatch = /^issue:(\d{1,12})$/.exec(documentId);
    if (issueMatch) {
      const id = Number(issueMatch[1]);
      const issue = await this.issue(auth, id);
      if (!issue) throw new ConnectorError("not_found", "Redmine issue is not available");
      const title = string(issue.subject) ?? `Issue #${id}`;
      const projectId = finiteInt(record(issue.project)?.id);
      const project = projectId === undefined ? undefined : await this.project(auth, String(projectId));
      const content = [
        `# ${title}`,
        `Project: ${string(record(issue.project)?.name) ?? "(unknown)"}`,
        `Status: ${string(record(issue.status)?.name) ?? "(unknown)"}`,
        `Updated: ${string(issue.updated_on) ?? "(unknown)"}`,
        "",
        safeText(issue.description),
      ].join("\n");
      return {
        documentId,
        title: `Issue #${id}: ${title}`,
        content: content.slice(0, 100_000),
        url: this.webUrl(`issues/${id}`),
        scope: issue.is_private === true || project?.is_public !== true ? "private" : "shared",
      };
    }
    const wiki = decodeWikiDocumentId(documentId);
    if (wiki) {
      const [pageBody, project] = await Promise.all([
        this.request(auth, `projects/${encodeURIComponent(wiki.project)}/wiki/${encodeURIComponent(wiki.title)}.json`),
        this.project(auth, wiki.project),
      ]);
      const page = record(record(pageBody)?.wiki_page);
      if (!page || !project) throw new ConnectorError("not_found", "Redmine wiki page is not available");
      return {
        documentId,
        title: string(page.title) ?? wiki.title,
        content: safeText(page.text).slice(0, 100_000),
        url: this.webUrl(`projects/${encodeURIComponent(wiki.project)}/wiki/${encodeURIComponent(wiki.title)}`),
        scope: project.is_public === true ? "shared" : "private",
      };
    }
    throw new ConnectorError("invalid_request", "invalid Redmine documentId");
  }

  async list(auth: AuthContext, containerId?: string, cursor?: string): Promise<ListResult> {
    const offset = cursorOffset(cursor);
    const limit = MAX_PAGE_SIZE;
    const projectResult = containerId
      ? { items: [await this.project(auth, containerId)].filter((project): project is JsonObject => project !== undefined), totalCount: 1 }
      : await this.projects(auth, offset, limit);
    const entries = projectResult.items.flatMap((project) => {
      const id = finiteInt(project.id);
      const name = string(project.name);
      if (id === undefined || !name) return [];
      return [this.projectEntry(id, name, project.is_public === true)];
    });
    return {
      entries,
      ...(!containerId && offset + entries.length < projectResult.totalCount
        ? { nextCursor: encodedCursor(offset + entries.length) }
        : {}),
    };
  }

  private async issue(auth: AuthContext, id: number, includeJournals = false): Promise<JsonObject> {
    const path = `issues/${id}.json`;
    const body = await this.request(auth, includeJournals ? `${path}?include=journals` : path);
    const issue = record(record(body)?.issue);
    if (!issue) {
      throw new ConnectorError("source_unavailable", "Redmine returned an invalid issue response");
    }
    return issue;
  }

  private async project(auth: AuthContext, id: string): Promise<JsonObject | undefined> {
    const body = await this.request(auth, `projects/${encodeURIComponent(id)}.json`);
    return record(record(body)?.project);
  }

  private async projects(
    auth: AuthContext,
    offset: number,
    limit: number,
  ): Promise<{ items: JsonObject[]; totalCount: number }> {
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    const body = await this.request(auth, `projects.json?${params.toString()}`);
    const root = record(body);
    if (!Array.isArray(root?.projects)) {
      throw new ConnectorError("source_unavailable", "Redmine returned an invalid projects response");
    }
    return {
      items: root.projects.flatMap((item) => (record(item) ? [record(item)!] : [])),
      totalCount: finiteInt(root.total_count) ?? root.projects.length,
    };
  }

  private projectEntry(id: number, name: string, isPublic: boolean): ContainerEntry {
    return {
      id: String(id),
      name,
      kind: "other",
      scope: isPublic ? "shared" : "private",
    };
  }

  private issueNoteLocation(value: unknown): { issueId: number; noteId: number } | undefined {
    const raw = string(value);
    if (!raw) return undefined;
    try {
      const url = new URL(raw, this.baseUrl);
      const prefix = this.baseUrl.pathname;
      if (url.origin !== this.baseUrl.origin || !url.pathname.startsWith(prefix)) return undefined;
      const issue = /^issues\/([1-9]\d{0,11})$/.exec(url.pathname.slice(prefix.length));
      const note = /^#change-([1-9]\d{0,11})$/.exec(url.hash);
      if (issue && note) return { issueId: Number(issue[1]), noteId: Number(note[1]) };
    } catch {
      return undefined;
    }
    return undefined;
  }

  private wikiLocation(value: unknown): { project: string; title: string } | undefined {
    const raw = string(value);
    if (!raw) return undefined;
    try {
      const url = new URL(raw);
      if (url.origin !== this.baseUrl.origin) return undefined;
      const prefix = this.baseUrl.pathname;
      if (!url.pathname.startsWith(prefix)) return undefined;
      const parts = url.pathname.slice(prefix.length).split("/");
      if (parts[0] !== "projects" || parts[2] !== "wiki" || !parts[1] || !parts[3]) return undefined;
      return { project: decodeURIComponent(parts[1]), title: decodeURIComponent(parts.slice(3).join("/")) };
    } catch {
      return undefined;
    }
  }

  private webUrl(path: string): string {
    return new URL(path, this.baseUrl).toString();
  }

  private async request(auth: AuthContext, path: string): Promise<unknown> {
    const credential = auth.credential;
    if (credential.kind !== "api_key" || credential.apiKey.trim() === "") {
      throw new ConnectorError("invalid_request", "Redmine connector requires an api_key credential");
    }
    if (
      credential.expiresAt !== undefined &&
      (!Number.isFinite(credential.expiresAt) || credential.expiresAt <= Date.now())
    ) {
      throw new ConnectorError("auth_expired", "Redmine API key is expired");
    }
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl.origin || !url.pathname.startsWith(this.baseUrl.pathname)) {
      throw new ConnectorError("invalid_request", "invalid Redmine API path");
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Redmine-API-Key": credential.apiKey,
          "User-Agent": "Leisen-Redmine-Connector/0.1",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ConnectorError("source_unavailable", "Redmine request failed");
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ConnectorError("source_unavailable", "Redmine API redirected the request");
    }
    if (response.status === 401) throw new ConnectorError("auth_expired", "Redmine rejected the API key");
    if (response.status === 403) throw new ConnectorError("permission_denied", "Redmine denied the request");
    if (response.status === 404) throw new ConnectorError("not_found", "Redmine resource is not available");
    if (response.status === 429) throw new ConnectorError("rate_limited", "Redmine rate limit was reached");
    if (response.status === 422) throw new ConnectorError("invalid_request", "Redmine rejected the request");
    if (!response.ok) {
      throw new ConnectorError("source_unavailable", "Redmine API is unavailable");
    }
    try {
      return await response.json();
    } catch {
      throw new ConnectorError("source_unavailable", "Redmine returned invalid JSON");
    }
  }

  private integerOption(name: string, value: number | undefined, fallback: number, min: number, max: number): number {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new ConnectorError("invalid_request", `${name} must be an integer between ${min} and ${max}`);
    }
    return value;
  }
}
