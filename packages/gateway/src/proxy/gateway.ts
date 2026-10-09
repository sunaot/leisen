/**
 * Gatewayコア(T-003): 全ツール呼び出しの単一経路。
 *
 * パイプライン(1呼び出しごと):
 *   実行区分照合(ADR-015) → コネクタ解決(enabled) → レート制御 →
 *   資格情報取得(IdpAdapter、失敗時はコネクタを呼ばない) →
 *   コネクタ呼び出し(タイムアウト付き) → 結果の射影(既知フィールドのみ、
 *   snippet強制truncate、scope の正規化。ADR-016、TM-A1) →
 *   プライベート領域の方針の強制(privateScopes: excluded。ADR-016 追補2 決定4) →
 *   監査記録(正確に1レコード、失敗時は既定fail-closed、ADR-011 §4)
 *
 * ステートレス(ADR-001 追補3 決定1〜3): Gatewayは利用者ごとの状態を持たない。
 * 本人の確定はリクエスト単位(authenticate → bindSession)で行い、runId /
 * iteration は呼び出しごとの申告を記録する(呼び出しをまたぐ採番状態なし)。
 * インスタンス内の共有状態はソース別のレート制御窓のみ(ユーザー非依存)。
 *
 * 不変条件:
 * - 認可はデータソースに委譲する。ここでは本人資格情報の取得と受け渡しのみを
 *   行い、権限判定・ACL複製はしない(不変条件1)
 * - Gatewayを経由しないソースアクセス経路を作らない(不変条件2)。コネクタは
 *   このクラスにのみ登録し、Orchestratorへ直接公開しない
 * - 監査レコード・エラーメッセージに秘密情報・文書内容・候補件数を
 *   含めない(不変条件3/6、TM-A2)
 * - プライベート領域の除外は導入先の方針(deployment.yaml)の強制であって認可判定では
 *   ない(ADR-016 追補2)。誰が何を見てよいかはソースが本人の資格情報で決めたままで、
 *   ここでは認可済みの結果をコネクタが付けた scope で絞るだけ(権限モデル・ACL を持たない)。
 *   落とした件数は監査・デバッグログ・メトリクスのいずれにも出さない(ADR-013)
 */
import { randomUUID } from "node:crypto";
import {
  ConnectorError,
  MAX_SNIPPET_CHARS,
  normalizeDocumentScope,
  type AuthContext,
  type Connector,
  type ConnectorCapabilities,
  type ContainerEntry,
  type FetchResult,
  type HitAnchor,
  type ListResult,
  type SearchFilters,
  type SearchHit,
  type SearchResult,
  type SourceDescription,
} from "@kp/connector-sdk";
import { digestQuery, type ToolInvocationRecord } from "../audit/schema.js";
import type { AuditLogger } from "../audit/sink.js";
import type { RawQueryStore } from "../audit/rawquery.js";
import type { ConnectorConfig, DeploymentConfig } from "../config/schema.js";
import { assertValidDeploymentConfig } from "../config/validate.js";
import { IdpError, type IdpAdapter, type Identity } from "../idp/types.js";
import { SourceRateLimiter } from "./ratelimit.js";
import { resolveCallContext, validateDeclaration } from "./session.js";
import {
  GatewayError,
  PRIVATE_SCOPE_EXCLUDED_MESSAGE,
  type CallContext,
  type ExecutionClass,
  type GatewaySession,
  type GatewayToolCall,
  type GatewayToolResult,
  type SessionDeclaration,
} from "./types.js";

export interface GatewayOptions {
  config: DeploymentConfig;
  idpAdapter: IdpAdapter;
  /** このデプロイに組み込むコネクタ実体。configのconnectors[].idと突合する */
  connectors: readonly Connector[];
  auditLogger: AuditLogger;
  /**
   * 生クエリ原文の短期保持テーブル(ADR-011 §3)。省略時は原文を記録しない
   * (queryDigestのみ監査レコードに残る)。
   */
  rawQueryStore?: RawQueryStore;
  /** テスト用の時計・ID注入 */
  now?: () => number;
  ids?: () => string;
}

interface RegistryEntry {
  /**
   * コネクタ実体。無効化されたソースは実体の登録を要求しない(起動コードは
   * 無効なコネクタを構築しない)。有効なソースは構築時に登録を検証済み
   */
  connector: Connector | undefined;
  config: ConnectorConfig;
}

/**
 * 設定に存在しないソースへの呼び出し(unknown_source)を監査に記録するときの
 * sourceId。クライアント(LLM)が指定した任意長・任意文字の値をそのまま監査に
 * 残さない。設定に同名のソースがあっても errorClass(unknown_source)で区別できる。
 * 設定に存在するソース(無効化されたもの=source_disabled を含む)は設定由来の
 * 値なのでそのまま記録する。
 */
const UNKNOWN_SOURCE_AUDIT_ID = "unknown";

const EXECUTION_CLASS_CONFIG_KEY = {
  human_in_the_loop: "humanInTheLoop",
  scheduled: "scheduled",
  autonomous: "autonomous",
} as const satisfies Record<
  ExecutionClass,
  keyof DeploymentConfig["agentExecution"]
>;

export class Gateway {
  private readonly config: DeploymentConfig;
  private readonly idpAdapter: IdpAdapter;
  private readonly auditLogger: AuditLogger;
  private readonly rawQueryStore: RawQueryStore | undefined;
  private readonly registry = new Map<string, RegistryEntry>();
  private readonly rateLimiter: SourceRateLimiter;
  private readonly now: () => number;
  private readonly ids: () => string;

  constructor(options: GatewayOptions) {
    this.config = options.config;
    this.idpAdapter = options.idpAdapter;
    this.auditLogger = options.auditLogger;
    this.rawQueryStore = options.rawQueryStore;
    this.now = options.now ?? Date.now;
    this.ids = options.ids ?? randomUUID;

    // コネクタ実体の重複と、設定との突合(危険設定は起動時拒否、ADR-005)
    const capabilities: Record<string, ConnectorCapabilities> = {};
    for (const connector of options.connectors) {
      if (capabilities[connector.sourceId]) {
        throw new GatewayError(
          "misconfigured",
          `duplicate connector registered for source: ${connector.sourceId}`,
        );
      }
      capabilities[connector.sourceId] = connector.capabilities;
    }
    assertValidDeploymentConfig(this.config, { capabilities });

    // 呼び出し可能なのは「設定で有効化され、かつ実体が登録されたソース」のみ。
    // 設定にないコネクタ実体は経路として存在させない(不変条件2)
    const byId = new Map(options.connectors.map((c) => [c.sourceId, c]));
    const rateLimits = new Map<string, number>();
    for (const connectorConfig of this.config.connectors) {
      const connector = byId.get(connectorConfig.id);
      if (!connector && connectorConfig.enabled) {
        // assertValidDeploymentConfig(unknown_connector_id)で先に落ちるが、
        // capabilitiesを渡さない経路で構築された場合の防波堤
        throw new GatewayError(
          "misconfigured",
          `no connector registered for configured source: ${connectorConfig.id}`,
        );
      }
      this.registry.set(connectorConfig.id, {
        connector,
        config: connectorConfig,
      });
      if (connectorConfig.limits.maxRequestsPerMinute !== undefined) {
        rateLimits.set(
          connectorConfig.id,
          connectorConfig.limits.maxRequestsPerMinute,
        );
      }
    }
    this.rateLimiter = new SourceRateLimiter(rateLimits, this.now);
  }

  /**
   * リクエスト単位の認証(ADR-001 追補3 決定1)。HTTP層がJSON-RPCを
   * ディスパッチする前に毎リクエスト呼ぶ。失敗は正規化エラー
   * (unauthenticated / idp_unavailable / misconfigured / internal_error)。
   */
  async authenticate(sessionToken: string): Promise<Identity> {
    try {
      return await this.idpAdapter.authenticate(sessionToken);
    } catch (error) {
      throw toGatewayError(error);
    }
  }

  /**
   * リクエスト単位のセッション解決(認証+申告の検証)。in-processの呼び出し元・
   * テスト向けの合成であり、結果をGateway側に保持しない。MCP経由では
   * HTTP層(http.ts)の authenticate と tools.ts の bindSession に分かれる。
   */
  async resolveSession(
    sessionToken: string,
    declaration: SessionDeclaration = {},
  ): Promise<GatewaySession> {
    // 申告の検証を先に行う(不正な申告でIdPへの照会を発生させない)
    const declared = validateDeclaration(declaration);
    return { identity: await this.authenticate(sessionToken), ...declared };
  }

  /** 有効なソースID一覧(MCPツールスキーマの自己記述用)。 */
  enabledSourceIds(): readonly string[] {
    return [...this.registry.entries()]
      .filter(([, entry]) => entry.config.enabled)
      .map(([id]) => id);
  }

  /**
   * ツール呼び出しの単一エントリポイント。成功・失敗を問わず監査レコードを
   * リクエストごとに正確に1件書く。監査書き込みに失敗した場合は
   * audit.failureMode に従う(既定fail-closed: 結果を破棄して失敗させる)。
   */
  async handleToolCall(
    session: GatewaySession,
    call: GatewayToolCall,
    context: CallContext = {},
  ): Promise<GatewayToolResult> {
    const { runId, iteration } = resolveCallContext(context, this.ids);
    const requestId = this.ids();
    const startedMs = this.now();

    let result: GatewayToolResult | undefined;
    let error: GatewayError | undefined;
    try {
      result = await this.execute(session, call);
    } catch (cause) {
      error = toGatewayError(cause);
    }

    const record: ToolInvocationRecord = {
      requestId,
      runId,
      iteration,
      userId: session.identity.userId,
      timestamp: new Date(startedMs).toISOString(),
      sourceId: this.registry.has(call.sourceId)
        ? call.sourceId
        : UNKNOWN_SOURCE_AUDIT_ID,
      tool: call.tool,
      queryDigest: call.tool === "search" ? digestQuery(call.query) : null,
      filtersDigest:
        call.tool === "search" && call.filters !== undefined
          ? digestQuery(canonicalJson(call.filters))
          : null,
      returnedHitCount:
        result?.tool === "search" ? result.result.hits.length : null,
      fetchedDocCount: result?.tool === "fetch" ? 1 : 0,
      latencyMs: Math.max(0, this.now() - startedMs),
      errorClass: error ? error.errorClass : null,
      retryCount: 0,
    };

    // 監査レコードの書き込み。失敗時はfailureModeに従う。
    // fail-closed: 記録できない呼び出しは結果を返さない(ADR-011 §4)。
    // fail-open: 呼び出し結果を優先する(confirmFailOpen必須、起動時検証済み)
    try {
      await this.auditLogger.log({ recordType: "tool_invocation", ...record });
    } catch {
      if (this.config.audit.failureMode === "fail-closed") {
        // 元例外のメッセージは載せない(シンク由来の生エラーがレコード内容や
        // 接続情報を含みうるため。TM-A2)
        throw new GatewayError(
          "audit_write_failed",
          "audit record could not be persisted; tool call rejected (fail-closed, ADR-011)",
        );
      }
    }

    // 生クエリ原文は監査本体と別の短期保持テーブル(ADR-011 §3)。監査レコード
    // は上で永続化済みのため、原文の保存失敗はfailureModeの対象にしない
    // (queryDigestは監査側に残り、失われるのはT-014の原文参照のみ)
    if (call.tool === "search" && this.rawQueryStore) {
      try {
        await this.rawQueryStore.append({
          queryDigest: digestQuery(call.query),
          rawQuery: call.query,
          userId: session.identity.userId,
          timestamp: new Date(startedMs).toISOString(),
        });
      } catch {
        // 許容(上記コメント参照)
      }
    }

    if (error) {
      throw error;
    }
    // executeが例外を投げない限りresultは必ずある
    if (!result) {
      throw new GatewayError("internal_error", "tool call produced no result");
    }
    return result;
  }

  private async execute(
    session: GatewaySession,
    call: GatewayToolCall,
  ): Promise<GatewayToolResult> {
    // 実行区分の照合(ADR-015)。Phase 1設定では human_in_the_loop のみ
    // enabled になりうる(scheduled/autonomousの有効化は起動時拒否)
    const classKey = EXECUTION_CLASS_CONFIG_KEY[session.executionClass];
    if (!this.config.agentExecution[classKey].enabled) {
      throw new GatewayError(
        "execution_class_rejected",
        `execution class "${session.executionClass}" is not allowed by this deployment (ADR-015)`,
      );
    }

    const entry = this.registry.get(call.sourceId);
    if (!entry) {
      throw new GatewayError(
        "unknown_source",
        `source "${call.sourceId}" is not available in this deployment`,
      );
    }
    // 無効化されたソース(実体の有無によらない)。有効なソースに実体がない
    // 状態は構築時に拒否済みのため、connector の欠落はここでは無効化と同義
    const { connector } = entry;
    if (!entry.config.enabled || connector === undefined) {
      throw new GatewayError(
        "source_disabled",
        `source "${call.sourceId}" is disabled in this deployment`,
      );
    }

    const rate = this.rateLimiter.tryAcquire(call.sourceId);
    if (!rate.allowed) {
      throw new GatewayError(
        "rate_limited",
        `source "${call.sourceId}" rate limit exceeded`,
        rate.retryAfterMs,
      );
    }

    // 資格情報取得。失敗(未接続・失効・IdP不達)時はコネクタを呼ばない
    const auth = await this.idpAdapter.getCredential(
      session.identity,
      call.sourceId,
    );
    // 束縛検証(TM-C6): AuthContext.userId(資格情報に付くラベル)がリクエストの
    // 本人と一致しなければコネクタを呼ばない。限界: 組み込みアダプタ
    // (CredentialResolvingIdpAdapter 系: Mock / Keycloak)は identity.userId を
    // そのままラベルに写すため、ここで検出できるのは「ラベルの不一致」(独自
    // アダプタ実装がラベルを取り違えた場合)のみ。ラベルは本人のまま中身の
    // 資格情報(トークン)が他人のものになる取り違え(プロバイダ・キャッシュの誤り)は
    // 検出できない。後者はアダプタ実装側の契約テスト(キャッシュキー規約等、T-004)で担保する
    if (auth.userId !== session.identity.userId) {
      throw new GatewayError(
        "internal_error",
        "credential subject does not match the authenticated user (TM-C6)",
      );
    }

    const raw = await withTimeout(
      this.invokeConnector(connector, auth, call),
      entry.config.limits.timeoutMs,
      call.sourceId,
    );
    return enforcePrivateScopes(projectResult(raw), entry.config.privateScopes);
  }

  private async invokeConnector(
    connector: Connector,
    auth: AuthContext,
    call: GatewayToolCall,
  ): Promise<GatewayToolResult> {
    switch (call.tool) {
      case "search":
        return {
          tool: "search",
          result: await connector.search(
            auth,
            call.query,
            call.filters,
            call.options,
          ),
        };
      case "fetch":
        return {
          tool: "fetch",
          result: await connector.fetch(auth, call.documentId, call.pageCursor),
        };
      case "list":
        return {
          tool: "list",
          result: await connector.list(auth, call.containerId, call.cursor),
        };
      case "describe":
        return { tool: "describe", result: await connector.describe(auth) };
    }
  }
}

// ---- 結果の射影(TM-A1、ADR-016) ----
//
// コネクタの返答を信用せず、IF(connector-sdk v0.4)の既知フィールドだけから
// 組み立て直す。型に存在しないフィールド(totalCount・debug・候補統計等)は実行時にも
// 外へ出さない(不変条件3。型定義だけでは実行時の混入を防げない)。
// - 必須フィールドの型不正はコネクタの契約違反として internal_error(固定文言。
//   値はエコーしない)
// - 任意フィールドは型が合う場合だけ残す。meta は string → string の組だけ残す
// - snippet は MAX_SNIPPET_CHARS で強制 truncate(ADR-016)
// - scope は "shared" 以外(欠落・未知の値)を "private" に正規化する(ADR-016 追補2 決定4)
// 射影後の値は文字列・数値・配列・プレーンオブジェクトだけで構成される。

const ANCHOR_KINDS: Readonly<Record<HitAnchor["kind"], true>> = {
  page: true,
  section: true,
  message: true,
  row: true,
};

const CONTAINER_KINDS: Readonly<Record<ContainerEntry["kind"], true>> = {
  folder: true,
  channel: true,
  repository: true,
  space: true,
  other: true,
};

const SEARCH_FILTER_KEYS: Readonly<Record<keyof SearchFilters, true>> = {
  updatedAfter: true,
  updatedBefore: true,
  container: true,
  author: true,
};

function malformedResult(): GatewayError {
  return new GatewayError(
    "internal_error",
    "connector returned a malformed result",
  );
}

type PlainRecord = Readonly<Record<string, unknown>>;

function asPlainRecord(value: unknown): PlainRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as PlainRecord)
    : undefined;
}

function requireRecord(value: unknown): PlainRecord {
  const record = asPlainRecord(value);
  if (record === undefined) {
    throw malformedResult();
  }
  return record;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") {
    throw malformedResult();
  }
  return value;
}

function requireArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw malformedResult();
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isKnownKey<K extends string>(
  table: Readonly<Record<K, true>>,
  value: unknown,
): value is K {
  return typeof value === "string" && Object.hasOwn(table, value);
}

function projectAnchor(value: unknown): HitAnchor | undefined {
  const anchor = asPlainRecord(value);
  if (
    anchor === undefined ||
    !isKnownKey(ANCHOR_KINDS, anchor["kind"]) ||
    typeof anchor["value"] !== "string"
  ) {
    return undefined;
  }
  const label = optionalString(anchor["label"]);
  return {
    kind: anchor["kind"],
    value: anchor["value"],
    ...(label !== undefined ? { label } : {}),
  };
}

function projectMeta(value: unknown): Record<string, string> | undefined {
  const meta = asPlainRecord(value);
  if (meta === undefined) {
    return undefined;
  }
  // fromEntries は __proto__ 等のキーも自身のデータプロパティとして作る
  return Object.fromEntries(
    Object.entries(meta).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function projectHit(value: unknown): SearchHit {
  const hit = requireRecord(value);
  const snippet = requireString(hit["snippet"]);
  const anchor = projectAnchor(hit["anchor"]);
  const updatedAt = optionalString(hit["updatedAt"]);
  const meta = projectMeta(hit["meta"]);
  return {
    documentId: requireString(hit["documentId"]),
    title: requireString(hit["title"]),
    // snippetの強制truncate(ADR-016)。型コメントだけでは本文流入を防げない
    snippet:
      snippet.length > MAX_SNIPPET_CHARS
        ? snippet.slice(0, MAX_SNIPPET_CHARS)
        : snippet,
    url: requireString(hit["url"]),
    ...(anchor !== undefined ? { anchor } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(meta !== undefined ? { meta } : {}),
    scope: normalizeDocumentScope(hit["scope"]),
  };
}

function projectSearchResult(value: unknown): SearchResult {
  const result = requireRecord(value);
  const nextCursor = optionalString(result["nextCursor"]);
  return {
    hits: requireArray(result["hits"]).map(projectHit),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

function projectFetchResult(value: unknown): FetchResult {
  const result = requireRecord(value);
  const nextPageCursor = optionalString(result["nextPageCursor"]);
  return {
    documentId: requireString(result["documentId"]),
    title: requireString(result["title"]),
    content: requireString(result["content"]),
    url: requireString(result["url"]),
    ...(nextPageCursor !== undefined ? { nextPageCursor } : {}),
    scope: normalizeDocumentScope(result["scope"]),
  };
}

function projectEntry(value: unknown): ContainerEntry {
  const entry = requireRecord(value);
  const kind = entry["kind"];
  if (!isKnownKey(CONTAINER_KINDS, kind)) {
    throw malformedResult();
  }
  const childCount = entry["childCount"];
  return {
    id: requireString(entry["id"]),
    name: requireString(entry["name"]),
    kind,
    ...(typeof childCount === "number" &&
    Number.isSafeInteger(childCount) &&
    childCount >= 0
      ? { childCount }
      : {}),
    scope: normalizeDocumentScope(entry["scope"]),
  };
}

function projectListResult(value: unknown): ListResult {
  const result = requireRecord(value);
  const nextCursor = optionalString(result["nextCursor"]);
  return {
    entries: requireArray(result["entries"]).map(projectEntry),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

function projectDescription(value: unknown): SourceDescription {
  const description = requireRecord(value);
  return {
    sourceId: requireString(description["sourceId"]),
    displayName: requireString(description["displayName"]),
    summary: requireString(description["summary"]),
    topContainers: requireArray(description["topContainers"]).map(projectEntry),
    supportedFilters: requireArray(description["supportedFilters"]).filter(
      (filter): filter is keyof SearchFilters =>
        isKnownKey(SEARCH_FILTER_KEYS, filter),
    ),
  };
}

/** コネクタの返答を既知フィールドだけに射影する(上記の規則)。 */
function projectResult(result: GatewayToolResult): GatewayToolResult {
  switch (result.tool) {
    case "search":
      return { tool: "search", result: projectSearchResult(result.result) };
    case "fetch":
      return { tool: "fetch", result: projectFetchResult(result.result) };
    case "list":
      return { tool: "list", result: projectListResult(result.result) };
    case "describe":
      return { tool: "describe", result: projectDescription(result.result) };
  }
}

// ---- プライベート領域の方針の強制(ADR-016 追補2 決定4) ----
//
// 射影済み(scope は正規化済み)の結果に deployment.yaml の privateScopes を適用する。
// - excluded(既定): search / list / describe は private の結果を落とす。fetch は本文を
//   捨てて private_scope_excluded で失敗させる(LLM は任意の documentId で fetch できる)
// - included(確認フラグ付き): そのまま返す
// - consent は起動時に拒否される(validate.ts、決定6)。万一届いても excluded と同じ扱い
// 監査の returnedHitCount は落とした後の件数(handleToolCall が結果から数える)。
// 落とした件数・事実は LLM・利用者にも、監査・デバッグログ・メトリクスにも出さない
// (利用者・クエリと結び付くと「その利用者のプライベート領域に一致する文書がある」ことを
// 示すため。ADR-013)。
// TODO(ADR-016 追補2 決定4): 落とした・拒否した事実は、利用者・クエリ・docId・時刻と
// 結合できない分離テレメトリ(日単位の集計、sourceId・ツール・能力・件数バケットのみ)に
// 記録する。書き込み先が未実装のため、現在は落とす処理だけを行う。

/** 方針が private の結果を返してよいか(included のときだけ)。 */
function privateScopesAllowed(
  privateScopes: ConnectorConfig["privateScopes"],
): boolean {
  return privateScopes === "included";
}

function enforcePrivateScopes(
  result: GatewayToolResult,
  privateScopes: ConnectorConfig["privateScopes"],
): GatewayToolResult {
  if (privateScopesAllowed(privateScopes)) {
    return result;
  }
  switch (result.tool) {
    case "search":
      return {
        tool: "search",
        result: {
          ...result.result,
          hits: result.result.hits.filter((hit) => hit.scope === "shared"),
        },
      };
    case "fetch":
      if (result.result.scope !== "shared") {
        // 本文は返さない(このスコープを抜けた時点で参照を失う)
        throw new GatewayError(
          "private_scope_excluded",
          PRIVATE_SCOPE_EXCLUDED_MESSAGE,
        );
      }
      return result;
    case "list":
      return {
        tool: "list",
        result: {
          ...result.result,
          entries: result.result.entries.filter(
            (entry) => entry.scope === "shared",
          ),
        },
      };
    case "describe":
      return {
        tool: "describe",
        result: {
          ...result.result,
          topContainers: result.result.topContainers.filter(
            (entry) => entry.scope === "shared",
          ),
        },
      };
  }
}

/** キー順序に依存しないJSON(filtersDigestの正規化用)。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  sourceId: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // タイムアウト後の遅延失敗をunhandled rejectionにしない。
      // 注: 骨格では下流の処理自体は中断されない(コネクタIFがabortを
      // 受け取れるようになった時点でキャンセル伝播を実装する)
      promise.catch(() => {});
      reject(
        new GatewayError(
          "timeout",
          `connector call to "${sourceId}" exceeded ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

/**
 * 例外をGatewayの正規化エラーへ写像する。IdpError / ConnectorError の
 * メッセージは各層の規約で秘密情報を含まないため透過する。それ以外の
 * 生例外はメッセージを外に流さない(TM-A2)。
 */
function toGatewayError(cause: unknown): GatewayError {
  if (cause instanceof GatewayError) {
    return cause;
  }
  if (cause instanceof IdpError) {
    return new GatewayError(cause.errorClass, cause.message);
  }
  if (cause instanceof ConnectorError) {
    if (cause.errorClass === "private_scope_excluded") {
      // コネクタ(enforced)の拒否。文言は固定にする(会話の種別等を含みうるため)
      return new GatewayError(
        "private_scope_excluded",
        PRIVATE_SCOPE_EXCLUDED_MESSAGE,
      );
    }
    return new GatewayError(cause.errorClass, cause.message, cause.retryAfterMs);
  }
  return new GatewayError("internal_error", "unexpected error during tool call");
}
