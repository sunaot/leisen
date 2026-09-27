/**
 * 開発用のインメモリコネクタ(組み込みの connectors[].kind: dev-fixture)。
 *
 * 実SaaS・実資格情報なしで Gateway を手元で起動し、MCPクライアントから
 * search / fetch / list / describe を試すためのもの(README「手元で動かす」)。
 * 本番(NODE_ENV=production)では構築を拒否する(assertNotProduction。起動コードも
 * dev_only_in_production として事前に拒否する)。
 *
 * - コーパス: settings.corpusFile(YAML/JSON。`documents:` 配下に文書を並べる。
 *   相対パスは設定ファイルの所在ディレクトリ基準)、または settings.documents。
 *   どちらもなければ組み込みの小さなサンプル。合成データのみを置く(機密・実名・
 *   秘密情報を含めない)
 * - 認可: 利用者ごとの権限分岐を持たない(全文書が全利用者に見える開発用データ)。
 *   ただし実ソースと同様に本人のベアラー資格情報を要求する(Gateway が IdP Adapter
 *   経由で取得した AuthContext が渡ることの確認。トークンの値は照合も記録もしない)
 * - search: title / content の部分一致(大文字小文字無視、空白区切りの全語AND)。
 *   総件数は返さない(ADR-012/016: SearchResult に totalCount を持たない)。
 *   snippet は一致箇所の周辺を MAX_SNIPPET_CHARS 以内で切り出す
 * - fetch: 本文を pageChars 文字(コードポイント)ごとにページングする
 * - list: 区画(文書の container)の一覧。区画は入れ子を持たない
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ConnectorError,
  MAX_SNIPPET_CHARS,
  type AuthContext,
  type Connector,
  type ConnectorCapabilities,
  type ContainerEntry,
  type FetchResult,
  type ListResult,
  type SearchFilters,
  type SearchHit,
  type SearchOptions,
  type SearchResult,
  type SourceDescription,
} from "@kp/connector-sdk";
import YAML from "yaml";
import { z } from "zod";
import type { ConnectorFactoryInit } from "../bootstrap/plugins.js";
import {
  DeploymentConfigError,
  type ConfigIssue,
} from "../config/validate.js";
import { assertNotProduction } from "../idp/mock.js";

/** 組み込み開発用コネクタの kind。 */
export const DEV_FIXTURE_CONNECTOR_KIND = "dev-fixture";

/** fetch の1ページの既定文字数(コードポイント)。 */
export const DEFAULT_DEV_FIXTURE_PAGE_CHARS = 4000;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const LIST_PAGE_SIZE = 50;
const TOP_CONTAINERS = 10;
/** snippet の本体の長さと、一致箇所より前に含める文字数 */
const SNIPPET_LENGTH = 160;
const SNIPPET_LEADING_CONTEXT = 40;

const documentSchema = z.strictObject({
  /** コネクタスコープで一意な文書ID(fetch の documentId) */
  id: z.string().min(1),
  title: z.string().min(1),
  /** プレーンテキストの本文 */
  content: z.string(),
  url: z.string().min(1),
  /** 区画(フォルダ等に相当)。filters.container / list の対象 */
  container: z.string().min(1).optional(),
  author: z.string().min(1).optional(),
  /** ISO 8601(オフセット付き)。filters.updatedAfter / updatedBefore の対象 */
  updatedAt: z.iso.datetime({ offset: true }).optional(),
});

export type DevFixtureDocument = z.infer<typeof documentSchema>;

const documentsSchema = z
  .array(documentSchema)
  .min(1)
  .superRefine((documents, ctx) => {
    const seen = new Set<string>();
    documents.forEach((document, index) => {
      if (seen.has(document.id)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "id"],
          message: `duplicate document id "${document.id}"`,
        });
      }
      seen.add(document.id);
    });
  });

/** connectors[].settings(kind: dev-fixture)。 */
const settingsSchema = z
  .strictObject({
    /** コーパスファイル(YAML/JSON)。相対パスは設定ファイルの所在ディレクトリ基準 */
    corpusFile: z.string().min(1).optional(),
    /** コーパスを設定に直接書く場合 */
    documents: documentsSchema.optional(),
    /** fetch の1ページの文字数 */
    pageChars: z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .default(DEFAULT_DEV_FIXTURE_PAGE_CHARS),
    /** describe の表示名 */
    displayName: z.string().min(1).optional(),
    /** describe の内容説明 */
    summary: z.string().min(1).optional(),
  })
  .refine((s) => s.corpusFile === undefined || s.documents === undefined, {
    error: "specify either corpusFile or documents, not both",
    path: ["documents"],
  });

const corpusFileSchema = z.strictObject({ documents: documentsSchema });

/** settings.corpusFile / documents がないときの組み込みサンプル(合成データ)。 */
export const DEV_FIXTURE_SAMPLE_DOCUMENTS: readonly DevFixtureDocument[] = [
  {
    id: "sample-expense",
    title: "経費精算の手引き(サンプル)",
    content:
      "経費精算は発生月の翌月10日までに申請する。領収書の画像を添付し、" +
      "上長の承認を得てから経理担当が確認する。交通費は経路と運賃を記入する。",
    url: "https://intranet.example.test/sample/expense",
    container: "総務",
    author: "総務部",
    updatedAt: "2026-04-01T09:00:00+09:00",
  },
  {
    id: "sample-vpn",
    title: "VPN接続の手順(サンプル)",
    content:
      "社外から社内システムを使うときはVPNに接続する。接続用アプリを起動し、" +
      "社内アカウントでサインインして多要素認証を完了する。接続できない場合は" +
      "情報システム部の問い合わせ窓口へ連絡する。",
    url: "https://intranet.example.test/sample/vpn",
    container: "情報システム",
    author: "情報システム部",
    updatedAt: "2026-05-12T10:30:00+09:00",
  },
  {
    id: "sample-onboarding",
    title: "入社初日のオンボーディング(サンプル)",
    content:
      "入社初日は貸与PCの受け取り、アカウントの有効化、社内ポータルの確認を行う。" +
      "最初の1週間でメンターと面談し、所属チームの業務の進め方を把握する。",
    url: "https://intranet.example.test/sample/onboarding",
    container: "人事",
    author: "人事部",
    updatedAt: "2026-03-20T09:00:00+09:00",
  },
];

export interface DevFixtureConnectorOptions {
  /** fetch の1ページの文字数(コードポイント)。既定 4000 */
  pageChars?: number;
  displayName?: string;
  summary?: string;
  /** テスト用の時計(資格情報の失効判定) */
  now?: () => number;
}

interface IndexedDocument {
  readonly document: DevFixtureDocument;
  /** コーパス内の順序(並び順の安定化) */
  readonly order: number;
  readonly updatedAtMs: number | undefined;
}

type CursorKind = "search" | "fetch" | "list";

function encodeCursor(kind: CursorKind, offset: number): string {
  return Buffer.from(JSON.stringify({ k: kind, o: offset }), "utf8").toString(
    "base64url",
  );
}

/** カーソルを検証してオフセットを返す(不正な値は invalid_request)。 */
function decodeCursor(cursor: string | undefined, kind: CursorKind): number {
  if (cursor === undefined) {
    return 0;
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (typeof parsed === "object" && parsed !== null) {
      const { k, o } = parsed as { k?: unknown; o?: unknown };
      if (k === kind && typeof o === "number" && Number.isSafeInteger(o) && o > 0) {
        return o;
      }
    }
  } catch {
    // 下の invalid_request に集約する
  }
  throw new ConnectorError("invalid_request", `invalid ${kind} cursor`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** クエリを空白(全角空白を含む)で分割し、語ごとの大文字小文字無視パターンにする。 */
function termPatterns(query: string): RegExp[] {
  return query
    .split(/\s+/u)
    .filter((term) => term.length > 0)
    .map((term) => new RegExp(escapeRegExp(term), "iu"));
}

/** サロゲートペアを分断しない [start, end) に調整する。 */
function surrogateSafeRange(
  text: string,
  start: number,
  end: number,
): [number, number] {
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

/**
 * 一致箇所(最初に現れる語)の周辺を切り出す。本文に一致がない(タイトルのみの
 * 一致)場合は本文の先頭。本文全体は返さない(ADR-016)。
 */
function makeSnippet(content: string, patterns: readonly RegExp[]): string {
  const text = content.replace(/\s+/gu, " ").trim();
  let first = -1;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && (first === -1 || match.index < first)) {
      first = match.index;
    }
  }
  const from = first <= SNIPPET_LEADING_CONTEXT ? 0 : first - SNIPPET_LEADING_CONTEXT;
  const [start, end] = surrogateSafeRange(
    text,
    from,
    Math.min(text.length, from + SNIPPET_LENGTH),
  );
  const snippet =
    (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
  return snippet.length > MAX_SNIPPET_CHARS
    ? snippet.slice(0, MAX_SNIPPET_CHARS)
    : snippet;
}

function parseFilterTime(value: string | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new ConnectorError(
      "invalid_request",
      `filters.${name} must be an ISO 8601 timestamp`,
    );
  }
  return ms;
}

export class DevFixtureConnector implements Connector {
  readonly capabilities: ConnectorCapabilities = {
    nativeSearch: "full",
    ingest: false,
  };
  private readonly documents: readonly IndexedDocument[];
  private readonly byId: ReadonlyMap<string, DevFixtureDocument>;
  /** 区画 → 文書数(コーパスでの初出順) */
  private readonly containers: ReadonlyMap<string, number>;
  private readonly pageChars: number;
  private readonly displayName: string;
  private readonly summary: string;
  private readonly now: () => number;

  constructor(
    public readonly sourceId: string,
    documents: readonly DevFixtureDocument[],
    options: DevFixtureConnectorOptions = {},
  ) {
    assertNotProduction("DevFixtureConnector");
    const validated = documentsSchema.parse(documents);
    this.documents = validated.map((document, order) => ({
      document,
      order,
      updatedAtMs:
        document.updatedAt !== undefined ? Date.parse(document.updatedAt) : undefined,
    }));
    this.byId = new Map(validated.map((d) => [d.id, d]));
    const containers = new Map<string, number>();
    for (const { container } of validated) {
      if (container !== undefined) {
        containers.set(container, (containers.get(container) ?? 0) + 1);
      }
    }
    this.containers = containers;
    this.pageChars = options.pageChars ?? DEFAULT_DEV_FIXTURE_PAGE_CHARS;
    this.displayName = options.displayName ?? `開発用フィクスチャ(${sourceId})`;
    this.summary =
      options.summary ??
      `開発用の合成文書コーパス(${validated.length}件)。実在の組織・人物・秘密情報は含まない。`;
    this.now = options.now ?? Date.now;
  }

  async search(
    auth: AuthContext,
    query: string,
    filters?: SearchFilters,
    options?: SearchOptions,
  ): Promise<SearchResult> {
    this.assertCredential(auth);
    const patterns = termPatterns(query);
    if (patterns.length === 0) {
      throw new ConnectorError(
        "invalid_request",
        "query must contain at least one search term",
      );
    }
    const after = parseFilterTime(filters?.updatedAfter, "updatedAfter");
    const before = parseFilterTime(filters?.updatedBefore, "updatedBefore");

    const matches = this.documents
      .filter(({ document, updatedAtMs }) => {
        if (filters?.container !== undefined && document.container !== filters.container) {
          return false;
        }
        if (filters?.author !== undefined && document.author !== filters.author) {
          return false;
        }
        // 期間の両端を含む。更新日時のない文書は期間指定時に対象外
        if (after !== undefined && (updatedAtMs === undefined || updatedAtMs < after)) {
          return false;
        }
        if (before !== undefined && (updatedAtMs === undefined || updatedAtMs > before)) {
          return false;
        }
        return patterns.every((p) => p.test(document.title) || p.test(document.content));
      })
      .map((entry) => ({
        entry,
        titleScore: patterns.filter((p) => p.test(entry.document.title)).length,
      }))
      // タイトル一致の多い順 → 更新の新しい順 → コーパス順
      .sort(
        (a, b) =>
          b.titleScore - a.titleScore ||
          (b.entry.updatedAtMs ?? -Infinity) - (a.entry.updatedAtMs ?? -Infinity) ||
          a.entry.order - b.entry.order,
      );

    const offset = decodeCursor(options?.cursor, "search");
    const limit = Math.min(options?.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const hits: SearchHit[] = matches
      .slice(offset, offset + limit)
      .map(({ entry: { document } }) => {
        const meta: Record<string, string> = {
          ...(document.container !== undefined ? { container: document.container } : {}),
          ...(document.author !== undefined ? { author: document.author } : {}),
        };
        return {
          documentId: document.id,
          title: document.title,
          snippet: makeSnippet(document.content, patterns),
          url: document.url,
          ...(document.updatedAt !== undefined ? { updatedAt: document.updatedAt } : {}),
          ...(Object.keys(meta).length > 0 ? { meta } : {}),
        };
      });
    // 総件数は返さない(ADR-012/016)。続きの有無だけをカーソルで示す
    return offset + limit < matches.length
      ? { hits, nextCursor: encodeCursor("search", offset + limit) }
      : { hits };
  }

  async fetch(
    auth: AuthContext,
    documentId: string,
    pageCursor?: string,
  ): Promise<FetchResult> {
    this.assertCredential(auth);
    const document = this.byId.get(documentId);
    if (document === undefined) {
      throw new ConnectorError("not_found", "document not found");
    }
    const chars = Array.from(document.content);
    const offset = decodeCursor(pageCursor, "fetch");
    // カーソルは本文の途中を指す(offset 0 はカーソルなし=先頭。空の本文も1ページ)
    if (offset > 0 && offset >= chars.length) {
      throw new ConnectorError("invalid_request", "invalid fetch cursor");
    }
    const end = offset + this.pageChars;
    return {
      documentId: document.id,
      title: document.title,
      content: chars.slice(offset, end).join(""),
      url: document.url,
      ...(end < chars.length ? { nextPageCursor: encodeCursor("fetch", end) } : {}),
    };
  }

  async list(
    auth: AuthContext,
    containerId?: string,
    cursor?: string,
  ): Promise<ListResult> {
    this.assertCredential(auth);
    if (containerId !== undefined) {
      if (!this.containers.has(containerId)) {
        throw new ConnectorError("not_found", "container not found");
      }
      // 区画は入れ子を持たない
      return { entries: [] };
    }
    const offset = decodeCursor(cursor, "list");
    const all = this.containerEntries();
    const end = offset + LIST_PAGE_SIZE;
    return end < all.length
      ? { entries: all.slice(offset, end), nextCursor: encodeCursor("list", end) }
      : { entries: all.slice(offset) };
  }

  async describe(auth: AuthContext): Promise<SourceDescription> {
    this.assertCredential(auth);
    return {
      sourceId: this.sourceId,
      displayName: this.displayName,
      summary: this.summary,
      topContainers: this.containerEntries().slice(0, TOP_CONTAINERS),
      supportedFilters: ["updatedAfter", "updatedBefore", "container", "author"],
    };
  }

  private containerEntries(): ContainerEntry[] {
    return [...this.containers].map(([name, count]) => ({
      id: name,
      name,
      kind: "folder",
      childCount: count,
    }));
  }

  /**
   * 実ソースと同様に本人のベアラー資格情報を要求する(不変条件1の実演)。
   * トークンの値は照合も記録もしない(不変条件6)。
   */
  private assertCredential(auth: AuthContext): void {
    const { credential } = auth;
    if (credential.kind !== "oauth_bearer") {
      throw new ConnectorError(
        "permission_denied",
        "dev-fixture accepts only the caller's bearer credential",
      );
    }
    if (credential.accessToken.length === 0 || credential.expiresAt <= this.now()) {
      throw new ConnectorError(
        "auth_expired",
        "the caller's credential is missing or expired",
      );
    }
  }
}

function settingsIssues(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
  basePath: string,
  messagePrefix = "",
): ConfigIssue[] {
  return issues.map((issue) => ({
    code: "connector_settings_invalid",
    path: [basePath, ...issue.path.map(String)].join("."),
    message: `${messagePrefix}${issue.message}`,
  }));
}

async function loadCorpusFile(
  corpusFile: string,
  configDir: string,
): Promise<DevFixtureDocument[]> {
  const path = resolve(configDir, corpusFile);
  const fail = (message: string): never => {
    throw new DeploymentConfigError([
      { code: "connector_settings_invalid", path: "settings.corpusFile", message },
    ]);
  };
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    fail(`cannot read corpus file ${path} (${code})`);
  }
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch {
    fail(`corpus file ${path} is not valid YAML/JSON`);
  }
  const parsed = corpusFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DeploymentConfigError(
      settingsIssues(parsed.error.issues, "settings.corpusFile", `corpus file ${path}: `),
    );
  }
  return parsed.data.documents;
}

/**
 * 組み込み kind: dev-fixture の factory(bootstrap/plugins.ts の ConnectorFactory)。
 * settings の不備は DeploymentConfigError(connector_settings_invalid、パスは
 * コネクタ宣言からの相対 "settings.*")で報告する。
 */
export async function createDevFixtureConnector(
  init: ConnectorFactoryInit,
): Promise<DevFixtureConnector> {
  assertNotProduction(`connector kind '${DEV_FIXTURE_CONNECTOR_KIND}'`);
  const parsed = settingsSchema.safeParse(init.settings);
  if (!parsed.success) {
    throw new DeploymentConfigError(settingsIssues(parsed.error.issues, "settings"));
  }
  const settings = parsed.data;
  const documents =
    settings.corpusFile !== undefined
      ? await loadCorpusFile(settings.corpusFile, init.configDir)
      : (settings.documents ?? DEV_FIXTURE_SAMPLE_DOCUMENTS);
  return new DevFixtureConnector(init.sourceId, documents, {
    pageChars: settings.pageChars,
    ...(settings.displayName !== undefined ? { displayName: settings.displayName } : {}),
    ...(settings.summary !== undefined ? { summary: settings.summary } : {}),
  });
}
