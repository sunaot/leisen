/**
 * T-007シナリオテスト用のモック群。
 * - ScriptedLlm: 応答列を再生する決定的なLLM(シナリオの再現可能性)
 * - ScenarioConnector: 検索台本(クエリ→ヒット)を持つインメモリコネクタ
 * - CollectingAuditSink: AnswerRun/ToolInvocationの観測
 * 秘密情報の実値は使わない(不変条件6)。
 */
import {
  ConnectorError,
  type AuthContext,
  type Connector,
  type ConnectorCapabilities,
  type Credential,
  type FetchResult,
  type ListResult,
  type SearchHit,
  type SearchResult,
  type SourceDescription,
} from "@kp/connector-sdk";
import {
  AuditLogger,
  Gateway,
  IdpError,
  MockIdpAdapter,
  deploymentConfigSchema,
  validateRecord,
  type AnswerRunRecord,
  type AuditRecord,
  type AuditSink,
  type CredentialProvider,
  type DeploymentConfig,
  type Identity,
} from "@kp/gateway";
import {
  Orchestrator,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  type OrchestratorLimits,
} from "../src/index.js";

/** 応答列を順に返すLLM。関数を渡すとリクエストを見て応答を作れる。 */
export class ScriptedLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];
  private cursor = 0;

  constructor(
    private readonly script: ReadonlyArray<
      LlmResponse | ((request: LlmRequest) => LlmResponse)
    >,
  ) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const step = this.script[this.cursor];
    if (!step) {
      throw new Error(
        `ScriptedLlm: unexpected LLM call #${this.cursor + 1} (script has ${this.script.length} steps)`,
      );
    }
    this.cursor += 1;
    return typeof step === "function" ? step(request) : step;
  }
}

export function toolUse(
  id: string,
  name: string,
  input: unknown,
): LlmResponse {
  return {
    content: [{ type: "tool_use", id, name, input }],
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 50 },
  };
}

export function textResponse(text: string): LlmResponse {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 50 },
  };
}

export function finalAnswer(
  input: unknown,
  overrides: Partial<LlmResponse> = {},
): LlmResponse {
  return {
    content: [{ type: "tool_use", id: "final-1", name: "final_answer", input }],
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 50 },
    ...overrides,
  };
}

export interface ScenarioDoc {
  readonly documentId: string;
  readonly title: string;
  readonly snippet: string;
  readonly content: string;
}

/**
 * 検索台本つきコネクタ。queryHits のキーに完全一致したクエリだけがヒットを返す
 * (「再検索で到達」シナリオをクエリの言い換えで再現するため)。
 */
export class ScenarioConnector implements Connector {
  readonly capabilities: ConnectorCapabilities = {
    nativeSearch: "full",
    ingest: false,
  };
  readonly searchQueries: string[] = [];

  constructor(
    public readonly sourceId: string,
    private readonly queryHits: ReadonlyMap<string, readonly ScenarioDoc[]>,
    private readonly options: {
      summary?: string;
      /** fetchで permission_denied を返すdocumentId(TM-B2テスト用) */
      deniedDocIds?: readonly string[];
    } = {},
  ) {}

  private doc(documentId: string): ScenarioDoc | undefined {
    for (const docs of this.queryHits.values()) {
      const found = docs.find((d) => d.documentId === documentId);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  url(documentId: string): string {
    return `https://example.test/${this.sourceId}/${documentId}`;
  }

  async search(_auth: AuthContext, query: string): Promise<SearchResult> {
    this.searchQueries.push(query);
    const docs = this.queryHits.get(query) ?? [];
    const hits: SearchHit[] = docs.map((doc) => ({
      documentId: doc.documentId,
      title: doc.title,
      snippet: doc.snippet,
      url: this.url(doc.documentId),
    }));
    return { hits };
  }

  async fetch(_auth: AuthContext, documentId: string): Promise<FetchResult> {
    if (this.options.deniedDocIds?.includes(documentId)) {
      throw new ConnectorError("permission_denied", "not permitted");
    }
    const doc = this.doc(documentId);
    if (!doc) {
      throw new ConnectorError("not_found", "no such document");
    }
    return {
      documentId,
      title: doc.title,
      content: doc.content,
      url: this.url(documentId),
    };
  }

  async list(): Promise<ListResult> {
    return { entries: [] };
  }

  async describe(): Promise<SourceDescription> {
    return {
      sourceId: this.sourceId,
      displayName: this.sourceId,
      summary: this.options.summary ?? `mock source ${this.sourceId}`,
      topContainers: [
        { id: `${this.sourceId}-root`, name: "root", kind: "folder" },
      ],
      supportedFilters: ["updatedAfter"],
    };
  }
}

/** 資格情報スタブ。notConnected=true で source_not_connected を注入する。 */
export class StubCredentialProvider implements CredentialProvider {
  readonly method = "oauth_individual" as const;

  constructor(
    public readonly sourceId: string,
    private readonly notConnected = false,
  ) {}

  async getCredential(identity: Identity): Promise<Credential> {
    if (this.notConnected) {
      throw new IdpError(
        "source_not_connected",
        `source ${this.sourceId} is not connected for this user`,
      );
    }
    return {
      kind: "oauth_bearer",
      accessToken: `stub-access-${identity.userId}-${this.sourceId}`,
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
  }
}

export class CollectingAuditSink implements AuditSink {
  readonly records: AuditRecord[] = [];

  async write(record: AuditRecord): Promise<void> {
    validateRecord(record);
    this.records.push(record);
  }

  /** runIdの最新AnswerRunレコード(冪等上書きの意味論に合わせて最後の1件)。 */
  latestAnswerRun(runId: string): (AnswerRunRecord & { recordType: string }) | undefined {
    const runs = this.records.filter(
      (r): r is Extract<AuditRecord, { recordType: "answer_run" }> =>
        r.recordType === "answer_run" && r.runId === runId,
    );
    return runs[runs.length - 1];
  }
}

export const TEST_SESSIONS = {
  "session-alice": { userId: "alice" },
} as const;

export interface HarnessOptions {
  readonly connectors: readonly Connector[];
  /** source_not_connected を注入するソースID */
  readonly notConnectedSources?: readonly string[];
  readonly limits?: Partial<OrchestratorLimits>;
  readonly llm: LlmClient;
  readonly connectHint?: string;
  readonly redactCitedDocId?: (
    sourceId: string,
    documentId: string,
  ) => string | null;
}

export function testConfig(connectorIds: readonly string[]): DeploymentConfig {
  return deploymentConfigSchema.parse({
    schemaVersion: 1,
    deployment: { name: "test-deployment" },
    idp: { adapter: { kind: "mock" } },
    connectors: connectorIds.map((id) => ({ id })),
  });
}

export function buildHarness(options: HarnessOptions) {
  const sink = new CollectingAuditSink();
  const auditLogger = new AuditLogger(sink);
  const notConnected = new Set(options.notConnectedSources ?? []);
  const idpAdapter = new MockIdpAdapter(
    options.connectors.map(
      (c) => new StubCredentialProvider(c.sourceId, notConnected.has(c.sourceId)),
    ),
    { sessions: TEST_SESSIONS },
  );
  const gateway = new Gateway({
    config: testConfig(options.connectors.map((c) => c.sourceId)),
    idpAdapter,
    connectors: options.connectors,
    auditLogger,
  });
  let seq = 0;
  const orchestrator = new Orchestrator({
    gateway,
    llm: options.llm,
    auditLogger,
    limits: {
      maxIterations: 6,
      ...options.limits,
    },
    ...(options.connectHint !== undefined
      ? { connectHint: options.connectHint }
      : {}),
    // 必須オプション(fail-open既定を置かない)。テスト既定は素通し
    redactCitedDocId:
      options.redactCitedDocId ?? ((_source: string, docId: string) => docId),
    ids: () => `id-${++seq}`,
    now: () => 1_700_000_000_000 + seq * 1000,
  });
  return { orchestrator, gateway, sink };
}
