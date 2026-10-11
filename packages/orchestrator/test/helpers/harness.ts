/**
 * T-007 テストハーネス: 実 Gateway(@kp/gateway)を port 0 で listen させ、
 * McpGatewayClient(Streamable HTTP)で接続する。ネットワークは 127.0.0.1 のみ。
 *
 * gateway の test/helpers は gateway の src を直接 import しており、@kp/gateway
 * (dist)と混ぜるとクラスが二重になって instanceof(IdpError 等)の判定が壊れるため、
 * 同等物をここで @kp/gateway だけを使って用意する。
 *
 * - CorpusConnector: 文書コーパスを持つモックコネクタ(キーワード一致で検索)
 * - StubCredentialProvider: 環境変数に依存しない資格情報スタブ(未接続を注入できる)
 * - 監査ストアは Gateway だけが書く(ADR-019)。Orchestrator は run API で申告する。Gateway には
 *   run API の構成(署名鍵・Orchestrator の資格情報)を渡し、クライアントには資格情報を付ける。
 *   answerRuns() は pending の AnswerRun に finish / feedback の部分レコードを統合した形で返す
 *
 * 秘密情報の実値は使わない(ダミーは dev-only-...、不変条件6)。
 */
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  ConnectorError,
  type AuthContext,
  type Connector,
  type ConnectorCapabilities,
  type Credential,
  type FetchResult,
  type ListResult,
  type SearchFilters,
  type SearchOptions,
  type SearchResult,
  type SourceDescription,
} from "@kp/connector-sdk";
import {
  AuditLogger,
  BufferedAuditSink,
  InMemoryAuditStore,
  type AnswerRunRecord,
  type AuditRecord,
  type AuditSink,
  type RawQueryStore,
} from "@kp/audit";
import {
  DEV_ORCHESTRATOR_CREDENTIAL,
  Gateway,
  IdpError,
  MockIdpAdapter,
  createGatewayHttpServer,
  createRunIdKeyRing,
  deploymentConfigSchema,
  type CredentialProvider,
  type Identity,
  type IdpAdapter,
  type RunRuntime,
} from "@kp/gateway";
import { McpGatewayClient } from "../../src/index.js";

export const ALICE_TOKEN = "dev-only-session-alice";
export const BOB_TOKEN = "dev-only-session-bob";
/**
 * Gateway と Orchestrator が共有する資格情報。開発用の既定値と同じにして、kp-ask の CLI(環境変数
 * KP_ORCHESTRATOR_CREDENTIAL なし → 既定値)からも実 Gateway のハーネスに通るようにする。
 * 資格情報の不一致は client(token, "wrong-…") で注入する
 */
export const TEST_ORCHESTRATOR_CREDENTIAL = DEV_ORCHESTRATOR_CREDENTIAL;
/** 引用 docId の HMAC 鍵(テスト用のダミー。hashed の検証に使う)。 */
export const TEST_DOC_ID_HMAC_KEY = "dev-only-audit-hmac-key";

/** Gateway の run API の構成(テスト用。鍵は固定値)。 */
export function testRunRuntime(overrides: Partial<RunRuntime> = {}): RunRuntime {
  return {
    keys: createRunIdKeyRing({ current: { kid: "t1", key: Buffer.alloc(32, 7) } }),
    orchestratorCredential: Buffer.from(TEST_ORCHESTRATOR_CREDENTIAL, "utf8"),
    ttlSeconds: 600,
    feedbackWindowSeconds: 7 * 24 * 3600,
    limits: { maxQuestionChars: 4_000, maxCitations: 50, maxSearchedSources: 50, maxIdChars: 512 },
    maxBodyBytes: 64 * 1024,
    maxRequestsPerUserPerMinute: 1_000,
    ...overrides,
  };
}

/** pending の AnswerRun と finish / feedback の部分レコードを runId ごとに統合した形。 */
export type MergedAnswerRun = AnswerRunRecord & { recordType: "answer_run" };

/**
 * 監査ストアのレコードから AnswerRun を統合する(昇格判定レポートと同じ規則の簡易版:
 * pending を土台に、recordedAt の最新の finish と feedback を重ねる。userId が違う部分
 * レコードは混ぜない)。順序は pending の出現順。
 */
export function mergeAnswerRuns(records: readonly AuditRecord[]): MergedAnswerRun[] {
  const merged = new Map<string, MergedAnswerRun>();
  for (const record of records) {
    if (record.recordType === "answer_run") {
      merged.set(record.runId, { ...record });
    }
  }
  const latest = new Map<string, string>();
  for (const record of records) {
    if (record.recordType !== "answer_run_finish" && record.recordType !== "answer_run_feedback") {
      continue;
    }
    const base = merged.get(record.runId);
    if (base === undefined || base.userId !== record.userId) {
      continue;
    }
    const key = `${record.recordType}:${record.runId}`;
    const previous = latest.get(key);
    if (previous !== undefined && previous > record.recordedAt) {
      continue;
    }
    latest.set(key, record.recordedAt);
    if (record.recordType === "answer_run_finish") {
      merged.set(record.runId, {
        ...base,
        endedAt: record.endedAt,
        finalOutcome: record.finalOutcome,
        confidence: record.confidence,
        searchedSources: record.searchedSources,
        citedDocIds: record.citedDocIds,
        failureReason: record.failureReason,
      });
    } else {
      merged.set(record.runId, { ...base, userFeedback: record.userFeedback });
    }
  }
  return [...merged.values()];
}

export interface CorpusDocument {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  /** 検索で一致させる語(クエリの語との部分一致) */
  readonly keywords: readonly string[];
  readonly url?: string;
  /** 結果の領域(ADR-016 追補2)。省略時は shared */
  readonly scope?: "private" | "shared";
}

interface RecordedCall {
  readonly tool: "search" | "fetch" | "list" | "describe";
  readonly userId: string;
  readonly target?: string;
}

export interface CorpusConnectorOptions {
  /** 全操作に入れる遅延(ms) */
  readonly delayMs?: number;
  readonly summary?: string;
}

export class CorpusConnector implements Connector {
  readonly capabilities: ConnectorCapabilities = {
    nativeSearch: "full",
    ingest: false,
    // 方針に関わらず全文書を返し、scope で分類する(除外は Gateway が行う)
    privateScopeHandling: "classified",
  };
  readonly calls: RecordedCall[] = [];

  constructor(
    public readonly sourceId: string,
    private readonly documents: readonly CorpusDocument[],
    private readonly options: CorpusConnectorOptions = {},
  ) {}

  urlOf(document: CorpusDocument): string {
    return document.url ?? `https://${this.sourceId}.example.test/docs/${document.id}`;
  }

  private async record(
    tool: RecordedCall["tool"],
    auth: AuthContext,
    target?: string,
  ): Promise<void> {
    this.calls.push({
      tool,
      userId: auth.userId,
      ...(target !== undefined ? { target } : {}),
    });
    if (this.options.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    }
  }

  async search(
    auth: AuthContext,
    query: string,
    _filters?: SearchFilters,
    _options?: SearchOptions,
  ): Promise<SearchResult> {
    await this.record("search", auth, query);
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term !== "");
    const hits = this.documents
      .filter((document) =>
        terms.some((term) =>
          document.keywords.some((keyword) => {
            const k = keyword.toLowerCase();
            return k.includes(term) || term.includes(k);
          }),
        ),
      )
      .map((document) => ({
        documentId: document.id,
        title: document.title,
        snippet: document.content.slice(0, 120),
        url: this.urlOf(document),
        scope: document.scope ?? "shared",
      }));
    return { hits };
  }

  async fetch(
    auth: AuthContext,
    documentId: string,
    _pageCursor?: string,
  ): Promise<FetchResult> {
    await this.record("fetch", auth, documentId);
    const document = this.documents.find((d) => d.id === documentId);
    if (document === undefined) {
      throw new ConnectorError("not_found", "document not found");
    }
    return {
      documentId: document.id,
      title: document.title,
      content: document.content,
      url: this.urlOf(document),
      scope: document.scope ?? "shared",
    };
  }

  async list(auth: AuthContext): Promise<ListResult> {
    await this.record("list", auth);
    return {
      entries: [{ id: `${this.sourceId}-root`, name: "root", kind: "folder", scope: "shared" }],
    };
  }

  async describe(auth: AuthContext): Promise<SourceDescription> {
    await this.record("describe", auth);
    return {
      sourceId: this.sourceId,
      displayName: `${this.sourceId} wiki`,
      summary: this.options.summary ?? `${this.sourceId} の社内文書`,
      topContainers: [{ id: `${this.sourceId}-root`, name: "root", kind: "folder", scope: "shared" }],
      supportedFilters: ["updatedAfter"],
    };
  }
}

/** 環境変数に依存しない資格情報スタブ。failWith で未接続などを注入する。 */
export class StubCredentialProvider implements CredentialProvider {
  readonly method = "oauth_individual" as const;

  constructor(
    public readonly sourceId: string,
    private readonly failWith?: IdpError,
  ) {}

  async getCredential(identity: Identity): Promise<Credential> {
    if (this.failWith !== undefined) {
      throw this.failWith;
    }
    return {
      kind: "oauth_bearer",
      accessToken: `dev-only-access-${identity.userId}-${this.sourceId}`,
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
  }
}

/** 認証に使われたトークンを記録する IdP(Authorization ヘッダの検証用)。 */
export class RecordingIdpAdapter implements IdpAdapter {
  readonly authenticatedTokens: string[] = [];
  failWith: Error | undefined;

  constructor(private readonly inner: IdpAdapter) {}

  async authenticate(sessionToken: string): Promise<Identity> {
    this.authenticatedTokens.push(sessionToken);
    if (this.failWith !== undefined) {
      throw this.failWith;
    }
    return this.inner.authenticate(sessionToken);
  }

  getCredential(identity: Identity, sourceId: string): Promise<AuthContext> {
    return this.inner.getCredential(identity, sourceId);
  }

  invalidateUser(userId: string): void {
    this.inner.invalidateUser(userId);
  }
}

export interface GatewayHarnessOptions {
  readonly connectors: readonly Connector[];
  /** 資格情報プロバイダが source_not_connected を投げるソース */
  readonly notConnected?: readonly string[];
  /** privateScopes: included(確認フラグ付き)にするソース。ほかは既定の excluded */
  readonly includedSources?: readonly string[];
  /** Slack(永続化不可)として扱うソース(kind: slack) */
  readonly slackSources?: readonly string[];
  /** run API の構成(既定 testRunRuntime())。undefined を明示すると run API なし */
  readonly runs?: RunRuntime | undefined;
  /**
   * 監査シンクの装飾(fail-closed の注入・書き込みの観測用)。既定の sink(InMemoryAuditStore への
   * BufferedAuditSink)を受け取り、Gateway に渡す sink を返す。store にはこの sink 経由で届いた分だけが残る
   */
  readonly wrapSink?: (inner: AuditSink) => AuditSink;
  /** 生クエリ表(run の質問原文・search のクエリ原文の書き先)。既定はなし(書かない) */
  readonly rawQueryStore?: RawQueryStore;
  /** 時計の注入 */
  readonly now?: () => number;
}

export interface GatewayHarness {
  readonly url: string;
  readonly store: InMemoryAuditStore;
  /** Gateway の監査ロガー(Gateway だけが書く) */
  readonly auditLogger: AuditLogger;
  readonly idp: RecordingIdpAdapter;
  /** 利用者のトークンと Orchestrator の資格情報を持つクライアント(credential: null で資格情報なし) */
  client(token?: string, credential?: string | null): McpGatewayClient;
  toolInvocations(runId?: string): Extract<AuditRecord, { recordType: "tool_invocation" }>[];
  /** pending の AnswerRun に finish / feedback を統合したもの(pending の出現順) */
  answerRuns(): MergedAnswerRun[];
  /** 監査ストアの全レコード(重複除去済み。種別のフィルタ用) */
  records(): AuditRecord[];
  close(): Promise<void>;
}

export async function startGateway(options: GatewayHarnessOptions): Promise<GatewayHarness> {
  const store = new InMemoryAuditStore();
  const baseSink: AuditSink = new BufferedAuditSink(store, { retryBaseDelayMs: 1 });
  const auditLogger = new AuditLogger(options.wrapSink !== undefined ? options.wrapSink(baseSink) : baseSink);
  const notConnected = new Set(options.notConnected ?? []);
  const providers = options.connectors.map(
    (connector) =>
      new StubCredentialProvider(
        connector.sourceId,
        notConnected.has(connector.sourceId)
          ? new IdpError("source_not_connected", "source not connected")
          : undefined,
      ),
  );
  const idp = new RecordingIdpAdapter(
    new MockIdpAdapter(providers, {
      sessions: {
        [ALICE_TOKEN]: { userId: "alice" },
        [BOB_TOKEN]: { userId: "bob" },
      },
    }),
  );
  const config = deploymentConfigSchema.parse({
    schemaVersion: 1,
    deployment: { name: "t007-test" },
    idp: { adapter: { kind: "mock" } },
    connectors: options.connectors.map((connector) => ({
      id: connector.sourceId,
      ...(options.slackSources?.includes(connector.sourceId) === true ? { kind: "slack" } : {}),
      ...(options.includedSources?.includes(connector.sourceId) === true
        ? { privateScopes: "included", confirmPrivateScopesIncluded: true }
        : {}),
    })),
  });
  const runs = "runs" in options ? options.runs : testRunRuntime();
  const gateway = new Gateway({
    config,
    idpAdapter: idp,
    connectors: options.connectors,
    auditLogger,
    ...(runs !== undefined ? { runs, docIdHmacKey: TEST_DOC_ID_HMAC_KEY } : {}),
    ...(options.rawQueryStore !== undefined ? { rawQueryStore: options.rawQueryStore } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const server = createGatewayHttpServer(gateway);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/mcp`;
  const clients: McpGatewayClient[] = [];

  return {
    url,
    store,
    auditLogger,
    idp,
    client(token = ALICE_TOKEN, credential: string | null = TEST_ORCHESTRATOR_CREDENTIAL) {
      const client = new McpGatewayClient({
        url,
        sessionToken: token,
        ...(credential !== null ? { orchestratorCredential: credential } : {}),
      });
      clients.push(client);
      return client;
    },
    toolInvocations(runId) {
      return store
        .records()
        .flatMap((record) =>
          record.recordType === "tool_invocation" &&
          (runId === undefined || record.runId === runId)
            ? [record]
            : [],
        );
    },
    answerRuns() {
      return mergeAnswerRuns(store.records());
    },
    records() {
      return [...store.records()];
    },
    async close() {
      await Promise.all(clients.map((client) => client.close()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 経費精算まわりの小さなコーパス(シナリオ共通)。 */
export const EXPENSE_POLICY: CorpusDocument = {
  id: "doc-expense-policy",
  title: "経費精算規程",
  content:
    "経費精算の締め日は毎月25日です。申請は経費精算システムから行い、領収書の画像を添付してください。",
  keywords: ["経費精算", "締め日", "経費規程"],
};

export const TRAVEL_GUIDE: CorpusDocument = {
  id: "doc-travel-guide",
  title: "Business travel guide",
  content:
    "Expense reimbursement for business travel must be filed within 30 days. See the finance portal.",
  // 英語の文書なので日本語の語では一致しない(再検索シナリオの前提)
  keywords: ["expense", "reimbursement", "travel"],
};
