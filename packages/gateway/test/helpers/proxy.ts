/**
 * T-003テスト用のモック群。
 * - MockConnector: 呼び出し記録付きのインメモリコネクタ(認可分岐・遅延・
 *   失敗を注入できる)
 * - StubCredentialProvider: 環境変数に依存しない資格情報スタブ
 * - CollectingAuditSink / FailingAuditSink: 監査書き込みの観測・失敗注入
 * 秘密情報の実値は使わない(不変条件6)。
 */
import type {
  AuthContext,
  Connector,
  ConnectorCapabilities,
  ContainerEntry,
  Credential,
  FetchResult,
  ListResult,
  SearchFilters,
  SearchOptions,
  SearchResult,
  SourceDescription,
} from "@leisen/connector-sdk";
import { validateRecord, type AuditRecord, type AuditSink } from "@leisen/audit";
import {
  MockIdpAdapter,
  type CredentialProvider,
  type Identity,
  IdpError,
  deploymentConfigSchema,
  type DeploymentConfig,
} from "../../src/index.js";

export interface MockConnectorOptions {
  /** searchヒットのsnippet(truncateテスト用に長い値を注入する) */
  snippet?: string;
  /** 全操作に注入する遅延(タイムアウトテスト用) */
  delayMs?: number;
  /** 全操作を失敗させる例外 */
  failWith?: Error;
}

interface RecordedCall {
  tool: "search" | "fetch" | "list" | "describe";
  auth: AuthContext;
  /** search のクエリ / fetch の documentId(ユーザー混線テストで呼び出し元を突合する) */
  target?: string;
}

export class MockConnector implements Connector {
  readonly capabilities: ConnectorCapabilities = {
    nativeSearch: "full",
    ingest: false,
    privateScopeHandling: "classified",
  };
  readonly calls: RecordedCall[] = [];
  lastSearch:
    | { query: string; filters?: SearchFilters; options?: SearchOptions }
    | undefined;

  constructor(
    public readonly sourceId: string,
    private readonly options: MockConnectorOptions = {},
  ) {}

  private async simulate(
    tool: RecordedCall["tool"],
    auth: AuthContext,
    target?: string,
  ) {
    this.calls.push({ tool, auth, ...(target !== undefined ? { target } : {}) });
    if (this.options.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    }
    if (this.options.failWith) {
      throw this.options.failWith;
    }
  }

  async search(
    auth: AuthContext,
    query: string,
    filters?: SearchFilters,
    options?: SearchOptions,
  ): Promise<SearchResult> {
    await this.simulate("search", auth, query);
    this.lastSearch = {
      query,
      ...(filters !== undefined ? { filters } : {}),
      ...(options !== undefined ? { options } : {}),
    };
    return {
      hits: [
        {
          documentId: `${this.sourceId}-doc-1`,
          title: `${this.sourceId} doc 1`,
          snippet: this.options.snippet ?? `snippet from ${this.sourceId}`,
          url: `https://example.test/${this.sourceId}/doc-1`,
          scope: "shared",
        },
      ],
    };
  }

  async fetch(
    auth: AuthContext,
    documentId: string,
    _pageCursor?: string,
  ): Promise<FetchResult> {
    await this.simulate("fetch", auth, documentId);
    return {
      documentId,
      title: `${this.sourceId} ${documentId}`,
      content: `content of ${documentId} from ${this.sourceId}`,
      url: `https://example.test/${this.sourceId}/${documentId}`,
      scope: "shared",
    };
  }

  async list(
    auth: AuthContext,
    _containerId?: string,
    _cursor?: string,
  ): Promise<ListResult> {
    await this.simulate("list", auth);
    const entries: ContainerEntry[] = [
      { id: `${this.sourceId}-root`, name: "root", kind: "folder", scope: "shared" },
    ];
    return { entries };
  }

  async describe(auth: AuthContext): Promise<SourceDescription> {
    await this.simulate("describe", auth);
    return {
      sourceId: this.sourceId,
      displayName: this.sourceId,
      summary: `mock source ${this.sourceId}`,
      topContainers: [],
      supportedFilters: ["updatedAfter"],
    };
  }
}

/** 環境変数に依存しない資格情報スタブ。failWithで認可分岐を注入する。 */
export class StubCredentialProvider implements CredentialProvider {
  readonly method = "oauth_individual" as const;

  constructor(
    public readonly sourceId: string,
    private readonly failWith?: IdpError,
  ) {}

  async getCredential(identity: Identity): Promise<Credential> {
    if (this.failWith) {
      throw this.failWith;
    }
    return {
      kind: "oauth_bearer",
      accessToken: `stub-access-${identity.userId}-${this.sourceId}`,
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
  }
}

export const TEST_SESSIONS = {
  "session-alice": { userId: "alice" },
  "session-bob": { userId: "bob" },
} as const;

export function testIdpAdapter(
  providers?: readonly CredentialProvider[],
): MockIdpAdapter {
  return new MockIdpAdapter(
    providers ?? [
      new StubCredentialProvider("alpha"),
      new StubCredentialProvider("beta"),
    ],
    { sessions: TEST_SESSIONS },
  );
}

/** deployment.yaml相当の検証済み設定(テスト既定: alpha/beta 2ソース)。 */
export function testConfig(overrides: Record<string, unknown> = {}): DeploymentConfig {
  return deploymentConfigSchema.parse({
    schemaVersion: 1,
    deployment: { name: "test-deployment" },
    idp: { adapter: { kind: "mock" } },
    connectors: [{ id: "alpha" }, { id: "beta" }],
    ...overrides,
  });
}

export class CollectingAuditSink implements AuditSink {
  readonly records: AuditRecord[] = [];

  async write(record: AuditRecord): Promise<void> {
    validateRecord(record);
    this.records.push(record);
  }
}

export class FailingAuditSink implements AuditSink {
  attempts = 0;

  async write(): Promise<void> {
    this.attempts += 1;
    throw new Error("injected audit sink failure");
  }
}
