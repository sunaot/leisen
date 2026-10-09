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
 * - 監査ストアは Gateway と Orchestrator で共有する(リファレンス構成の前提、ADR-017 決定2)
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
  Gateway,
  IdpError,
  InMemoryAuditStore,
  MockIdpAdapter,
  createGatewayHttpServer,
  deploymentConfigSchema,
  type AuditRecord,
  type CredentialProvider,
  type Identity,
  type IdpAdapter,
} from "@kp/gateway";
import { McpGatewayClient, type CitedDocIdAudit } from "../../src/index.js";

export const ALICE_TOKEN = "dev-only-session-alice";
export const BOB_TOKEN = "dev-only-session-bob";

/**
 * テスト用の citedDocIds の記録方針: すべてのソースを「非プライベート・非 Slack」に
 * 分類する(citedDocIds が `<sourceId>:<documentId>` のまま記録される)。分類ごとの
 * 挙動は test/cited-docids.test.ts で検証する。
 */
export const TEST_DOC_ID_AUDIT: CitedDocIdAudit = {
  classify: () => ({ privateScope: false, slack: false }),
  privateScopeDocIds: "omitted",
};

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
}

export interface GatewayHarness {
  readonly url: string;
  readonly store: InMemoryAuditStore;
  /** Gateway と共有する監査ロガー(Orchestrator に渡す) */
  readonly auditLogger: AuditLogger;
  readonly idp: RecordingIdpAdapter;
  client(token?: string): McpGatewayClient;
  toolInvocations(runId?: string): Extract<AuditRecord, { recordType: "tool_invocation" }>[];
  answerRuns(): Extract<AuditRecord, { recordType: "answer_run" }>[];
  close(): Promise<void>;
}

export async function startGateway(options: GatewayHarnessOptions): Promise<GatewayHarness> {
  const store = new InMemoryAuditStore();
  const auditLogger = new AuditLogger(
    new BufferedAuditSink(store, { retryBaseDelayMs: 1 }),
  );
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
    connectors: options.connectors.map((connector) =>
      options.includedSources?.includes(connector.sourceId) === true
        ? {
            id: connector.sourceId,
            privateScopes: "included",
            confirmPrivateScopesIncluded: true,
          }
        : { id: connector.sourceId },
    ),
  });
  const gateway = new Gateway({
    config,
    idpAdapter: idp,
    connectors: options.connectors,
    auditLogger,
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
    client(token = ALICE_TOKEN) {
      const client = new McpGatewayClient({ url, sessionToken: token });
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
      return store
        .records()
        .flatMap((record) => (record.recordType === "answer_run" ? [record] : []));
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
