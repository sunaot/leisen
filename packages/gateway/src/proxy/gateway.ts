/**
 * Gatewayコア(T-003): 全ツール呼び出しの単一経路。
 *
 * パイプライン(1呼び出しごと):
 *   実行区分照合(ADR-015) → コネクタ解決(enabled) → レート制御 →
 *   資格情報取得(IdpAdapter、失敗時はコネクタを呼ばない) →
 *   コネクタ呼び出し(タイムアウト付き) → snippet強制truncate(ADR-016) →
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
 */
import { randomUUID } from "node:crypto";
import {
  ConnectorError,
  MAX_SNIPPET_CHARS,
  type Connector,
  type ConnectorCapabilities,
  type AuthContext,
  type SearchResult,
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
  connector: Connector;
  config: ConnectorConfig;
}

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

    // 呼び出し可能なのは「設定に宣言され、かつ実体が登録されたソース」のみ。
    // 設定にないコネクタ実体は経路として存在させない(不変条件2)
    const byId = new Map(options.connectors.map((c) => [c.sourceId, c]));
    const rateLimits = new Map<string, number>();
    for (const connectorConfig of this.config.connectors) {
      const connector = byId.get(connectorConfig.id);
      if (!connector) {
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
      sourceId: call.sourceId,
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
    if (!entry.config.enabled) {
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
    // 束縛検証(TM-C6): 資格情報の主体がリクエストの本人と一致しなければ
    // コネクタを呼ばない(IdP Adapter実装の取り違えによる他人の資格情報の使用を防ぐ)
    if (auth.userId !== session.identity.userId) {
      throw new GatewayError(
        "internal_error",
        "credential subject does not match the authenticated user (TM-C6)",
      );
    }

    const raw = await withTimeout(
      this.invokeConnector(entry.connector, auth, call),
      entry.config.limits.timeoutMs,
      call.sourceId,
    );
    return postProcess(raw);
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

/**
 * snippetの強制truncate(ADR-016)。型コメントだけでは本文流入を防げない
 * ため、コネクタの返答を信用せずGatewayで切り詰める。
 */
function postProcess(result: GatewayToolResult): GatewayToolResult {
  if (result.tool !== "search") {
    return result;
  }
  const truncated: SearchResult = {
    ...result.result,
    hits: result.result.hits.map((hit) =>
      hit.snippet.length > MAX_SNIPPET_CHARS
        ? { ...hit, snippet: hit.snippet.slice(0, MAX_SNIPPET_CHARS) }
        : hit,
    ),
  };
  return { tool: "search", result: truncated };
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
    return new GatewayError(cause.errorClass, cause.message, cause.retryAfterMs);
  }
  return new GatewayError("internal_error", "unexpected error during tool call");
}
