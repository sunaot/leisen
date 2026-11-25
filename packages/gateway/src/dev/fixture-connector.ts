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
 * - search: 既定(searchMode: default)は title / content の部分一致(大文字小文字無視、
 *   空白区切りの全語AND)。総件数は返さない(ADR-012/016: SearchResult に totalCount を持たない)。
 *   snippet は一致箇所の周辺を MAX_SNIPPET_CHARS 以内で切り出す。評価用に、実ソースの検索の
 *   仕様を模した方式(esa / redmine / github)を settings.searchMode で選べる(search-modes.ts。
 *   方式の仕様は describe の summary に載せる)
 * - コーパスに、乱数の種を固定して生成した無関係な文書を足せる(settings.synthetic、
 *   synthetic-corpus.ts。検索の適合率を測るための規模の確保)
 * - fetch: 本文を pageChars 文字(コードポイント)ごとにページングする
 * - list: 区画(文書の container)の一覧。区画は入れ子を持たない
 * - プライベート領域(ADR-016 追補2): 文書に任意の scope(private / shared、既定 shared)を
 *   付けられる。privateScopeHandling は "enforced": 方針(init.policy)が excluded のとき
 *   private の文書を search / list / describe から外し、fetch は private_scope_excluded で
 *   拒否する(ソース側の除外に相当。構築時に対象から外す)。全結果に scope を付ける。
 *   区画の scope は、区画内の(対象の)文書がすべて private なら private、それ以外は shared
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ConnectorError,
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
  type SourcePolicy,
} from "@leisen/connector-sdk";
import YAML from "yaml";
import { z } from "zod";
import type { ConnectorFactoryInit } from "../bootstrap/plugins.js";
import {
  DeploymentConfigError,
  type ConfigIssue,
} from "../config/validate.js";
import { assertNotProduction } from "../idp/mock.js";
import {
  DEV_FIXTURE_DOCUMENT_KINDS,
  DEV_FIXTURE_SEARCH_MODES,
  defaultSearchLimit,
  planQuery,
  searchModeSpec,
  type DevFixtureDocumentKind,
  type DevFixtureSearchMode,
  type QueryPlan,
} from "./search-modes.js";
import {
  MAX_SYNTHETIC_DOCUMENTS,
  generateSyntheticCorpus,
} from "./synthetic-corpus.js";

/** 組み込み開発用コネクタの kind。 */
export const DEV_FIXTURE_CONNECTOR_KIND = "dev-fixture";

/** fetch の1ページの既定文字数(コードポイント)。 */
export const DEFAULT_DEV_FIXTURE_PAGE_CHARS = 4000;
const MAX_SEARCH_LIMIT = 50;
const LIST_PAGE_SIZE = 50;
const TOP_CONTAINERS = 10;

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
  /**
   * 文書の領域(ADR-016 追補2)。private は DM・個人スコープ等に相当する合成データ。
   * 省略時は shared
   */
  scope: z.enum(["private", "shared"]).optional(),
  /** 種別(GitHub 型の検索方式で使う。省略時 issue。ほかの方式では使わない) */
  kind: z.enum(DEV_FIXTURE_DOCUMENT_KINDS).optional(),
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
    /** 検索方式(既定 default = 現行の AND 部分一致)。search-modes.ts */
    searchMode: z.enum(DEV_FIXTURE_SEARCH_MODES).default("default"),
    /** Redmine 型の語の結合(true: AND / false: OR。既定 false = connector-redmine の all_words=0 の意図) */
    redmineAllWords: z.boolean().default(false),
    /** 乱数の種を固定して生成した無関係な文書をコーパスに足す(synthetic-corpus.ts) */
    synthetic: z
      .strictObject({
        seed: z.number().int().min(0).max(0xffff_ffff),
        count: z.number().int().min(1).max(MAX_SYNTHETIC_DOCUMENTS),
      })
      .optional(),
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
  /** 導入単位の方針(ADR-016 追補2 決定1)。既定 excluded */
  policy?: SourcePolicy;
  /** 検索方式(既定 default)。search-modes.ts */
  searchMode?: DevFixtureSearchMode;
  /** Redmine 型の語の結合(true: AND / false: OR。既定 false) */
  redmineAllWords?: boolean;
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

/** 文書の領域(省略時は shared)。 */
function scopeOf(document: DevFixtureDocument): "private" | "shared" {
  return document.scope ?? "shared";
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

/** GitHub 型の種別(省略時 issue)。 */
function kindOf(document: DevFixtureDocument): DevFixtureDocumentKind {
  return document.kind ?? "issue";
}

function hasAnyFilter(filters: SearchFilters | undefined): boolean {
  return (
    filters !== undefined &&
    (filters.updatedAfter !== undefined ||
      filters.updatedBefore !== undefined ||
      filters.container !== undefined ||
      filters.author !== undefined)
  );
}

/**
 * 並べ替え。relevance: タイトル一致の多い順 → 更新の新しい順 → コーパス順 /
 * updated: 更新の新しい順 → コーパス順(関連度を使わない)。
 */
function rank(matches: readonly IndexedDocument[], plan: QueryPlan): IndexedDocument[] {
  const scored = matches.map((entry) => ({
    entry,
    titleScore: plan.order === "relevance" ? plan.titleScore(entry.document.title) : 0,
  }));
  scored.sort(
    (a, b) =>
      b.titleScore - a.titleScore ||
      (b.entry.updatedAtMs ?? -Infinity) - (a.entry.updatedAtMs ?? -Infinity) ||
      a.entry.order - b.entry.order,
  );
  return scored.map(({ entry }) => entry);
}

export class DevFixtureConnector implements Connector {
  readonly capabilities: ConnectorCapabilities = {
    nativeSearch: "full",
    ingest: false,
    privateScopeHandling: "enforced",
  };
  /** 検索対象の文書(excluded では private の文書を含まない) */
  private readonly documents: readonly IndexedDocument[];
  private readonly byId: ReadonlyMap<string, DevFixtureDocument>;
  /** excluded の方針で対象から外した文書の ID(fetch の拒否の分類に使う) */
  private readonly excludedIds: ReadonlySet<string>;
  /** 区画 → 文書数と、区画内の文書がすべて private か(コーパスでの初出順) */
  private readonly containers: ReadonlyMap<
    string,
    { count: number; allPrivate: boolean }
  >;
  private readonly pageChars: number;
  private readonly displayName: string;
  private readonly summary: string;
  private readonly searchMode: DevFixtureSearchMode;
  private readonly redmineAllWords: boolean;
  private readonly now: () => number;

  constructor(
    public readonly sourceId: string,
    documents: readonly DevFixtureDocument[],
    options: DevFixtureConnectorOptions = {},
  ) {
    assertNotProduction("DevFixtureConnector");
    const parsed = documentsSchema.parse(documents);
    const privateScopes = options.policy?.privateScopes ?? "excluded";
    // ソース側の除外に相当: excluded では private の文書を最初から対象に入れない
    const validated =
      privateScopes === "included"
        ? parsed
        : parsed.filter((d) => scopeOf(d) === "shared");
    this.excludedIds = new Set(
      parsed.filter((d) => !validated.includes(d)).map((d) => d.id),
    );
    this.documents = validated.map((document, order) => ({
      document,
      order,
      updatedAtMs:
        document.updatedAt !== undefined ? Date.parse(document.updatedAt) : undefined,
    }));
    this.byId = new Map(validated.map((d) => [d.id, d]));
    const containers = new Map<string, { count: number; allPrivate: boolean }>();
    for (const document of validated) {
      const { container } = document;
      if (container !== undefined) {
        const current = containers.get(container) ?? { count: 0, allPrivate: true };
        containers.set(container, {
          count: current.count + 1,
          allPrivate: current.allPrivate && scopeOf(document) === "private",
        });
      }
    }
    this.containers = containers;
    this.pageChars = options.pageChars ?? DEFAULT_DEV_FIXTURE_PAGE_CHARS;
    this.displayName = options.displayName ?? `開発用フィクスチャ(${sourceId})`;
    this.searchMode = options.searchMode ?? "default";
    this.redmineAllWords = options.redmineAllWords ?? false;
    const contentSummary =
      options.summary ??
      `開発用の合成文書コーパス(${validated.length}件)。実在の組織・人物・秘密情報は含まない。`;
    // 既定の方式は summary を変えない。ほかの方式は検索の仕様を日本語で足す
    const spec = searchModeSpec(this.searchMode, { redmineAllWords: this.redmineAllWords });
    this.summary = spec === "" ? contentSummary : `${contentSummary}\n${spec}`;
    this.now = options.now ?? Date.now;
  }

  async search(
    auth: AuthContext,
    query: string,
    filters?: SearchFilters,
    options?: SearchOptions,
  ): Promise<SearchResult> {
    this.assertCredential(auth);
    const plan = planQuery(this.searchMode, query, { redmineAllWords: this.redmineAllWords });
    if (this.searchMode === "redmine" && hasAnyFilter(filters)) {
      // connector-redmine と同じく、フィルタは未対応(invalid_request)
      throw new ConnectorError(
        "invalid_request",
        "this source (redmine-style search) does not support search filters",
      );
    }
    const after = parseFilterTime(filters?.updatedAfter, "updatedAfter");
    const before = parseFilterTime(filters?.updatedBefore, "updatedBefore");
    if (plan === "no_terms") {
      return { hits: [] };
    }

    const matches = this.documents.filter(({ document, updatedAtMs }) => {
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
      return plan.matches(document.title, document.content);
    });
    const ranked = rank(matches, plan);
    const limit = Math.min(options?.limit ?? defaultSearchLimit(this.searchMode), MAX_SEARCH_LIMIT);
    if (this.searchMode === "github") {
      const codeEligible =
        filters?.author === undefined &&
        filters?.updatedAfter === undefined &&
        filters?.updatedBefore === undefined;
      return this.githubPage(ranked, plan, limit, codeEligible, options?.cursor);
    }

    const offset = decodeCursor(options?.cursor, "search");
    const hits = ranked.slice(offset, offset + limit).map((entry) => this.toHit(entry, plan));
    // 総件数は返さない(ADR-012/016)。続きの有無だけをカーソルで示す
    return offset + limit < ranked.length
      ? { hits, nextCursor: encodeCursor("search", offset + limit) }
      : { hits };
  }

  /**
   * GitHub 型: 種別(issue → pull_request → code)ごとに件数の枠を等分し(connector-github の
   * initialStreams と同じ配分)、1 ページ内で種別を交互に並べる。カーソルはページ番号
   * (継続時も同じ limit を前提にする。開発用の簡略化)。
   */
  private githubPage(
    ranked: readonly IndexedDocument[],
    plan: QueryPlan,
    limit: number,
    codeEligible: boolean,
    cursor: string | undefined,
  ): SearchResult {
    const kinds: DevFixtureDocumentKind[] = codeEligible
      ? ["issue", "pull_request", "code"]
      : ["issue", "pull_request"];
    const page = decodeCursor(cursor, "search");
    const base = Math.floor(limit / kinds.length);
    const remainder = limit % kinds.length;
    const windows = kinds.map((kind, index) => {
      const share = base + (index < remainder ? 1 : 0);
      const stream = ranked.filter((entry) => kindOf(entry.document) === kind);
      return {
        items: stream.slice(page * share, (page + 1) * share),
        more: stream.length > (page + 1) * share,
      };
    });
    const hits: SearchHit[] = [];
    for (let i = 0; windows.some((w) => i < w.items.length); i += 1) {
      for (const window of windows) {
        const entry = window.items[i];
        if (entry !== undefined) {
          hits.push(this.toHit(entry, plan));
        }
      }
    }
    return windows.some((w) => w.more)
      ? { hits, nextCursor: encodeCursor("search", page + 1) }
      : { hits };
  }

  private toHit({ document }: IndexedDocument, plan: QueryPlan): SearchHit {
    const meta: Record<string, string> = {
      ...(document.container !== undefined ? { container: document.container } : {}),
      ...(document.author !== undefined ? { author: document.author } : {}),
      ...(this.searchMode === "github" ? { type: kindOf(document) } : {}),
    };
    return {
      documentId: document.id,
      title: document.title,
      snippet: plan.snippet(document.content, kindOf(document)),
      url: document.url,
      ...(document.updatedAt !== undefined ? { updatedAt: document.updatedAt } : {}),
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
      scope: scopeOf(document),
    };
  }

  async fetch(
    auth: AuthContext,
    documentId: string,
    pageCursor?: string,
  ): Promise<FetchResult> {
    this.assertCredential(auth);
    if (this.excludedIds.has(documentId)) {
      // 方針(excluded)による拒否。本人が取得できる文書なので not_found とは区別する
      // (ADR-016 追補2 決定4。enforced のコネクタは自ら同じ分類で拒否してよい)
      throw new ConnectorError(
        "private_scope_excluded",
        "document is in a private scope excluded by this deployment",
      );
    }
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
      scope: scopeOf(document),
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
      supportedFilters:
        this.searchMode === "redmine"
          ? []
          : ["updatedAfter", "updatedBefore", "container", "author"],
    };
  }

  private containerEntries(): ContainerEntry[] {
    return [...this.containers].map(([name, { count, allPrivate }]) => ({
      id: name,
      name,
      kind: "folder",
      childCount: count,
      scope: allPrivate ? "private" : "shared",
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
    // expiresAt が 0 以下は「失効時刻不明」(ADR-016 追補 2026-11-14)。判定せずに受ける
    if (credential.accessToken.length === 0 || (credential.expiresAt > 0 && credential.expiresAt <= this.now())) {
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
 * コーパスファイル(YAML/JSON。`documents:` 配下に文書)を読む。評価の道具が、デプロイ設定と同じ形式の
 * コーパスを読むために使う(相対パスは baseDir 基準)。不備は DeploymentConfigError。
 */
export async function loadDevFixtureCorpusFile(
  path: string,
  baseDir: string,
): Promise<DevFixtureDocument[]> {
  assertNotProduction("loadDevFixtureCorpusFile");
  return loadCorpusFile(path, baseDir);
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
  const base =
    settings.corpusFile !== undefined
      ? await loadCorpusFile(settings.corpusFile, init.configDir)
      : (settings.documents ?? DEV_FIXTURE_SAMPLE_DOCUMENTS);
  const documents =
    settings.synthetic !== undefined
      ? [...base, ...generateSyntheticCorpus(settings.synthetic)]
      : base;
  return new DevFixtureConnector(init.sourceId, documents, {
    pageChars: settings.pageChars,
    ...(settings.displayName !== undefined ? { displayName: settings.displayName } : {}),
    ...(settings.summary !== undefined ? { summary: settings.summary } : {}),
    policy: init.policy,
    searchMode: settings.searchMode,
    redmineAllWords: settings.redmineAllWords,
  });
}
