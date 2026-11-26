/**
 * 比較実験の実行(dev-search-eval)。合成コーパス専用の開発用機能。
 *
 * - 検索方式ごとに、プロセス内に Gateway(@leisen/gateway)を 127.0.0.1 の空きポートで起動し、
 *   合成コーパスを持つ開発用コネクタ(dev-fixture)を 1 つだけ載せる。IdP・資格情報はモック、
 *   監査はメモリ(捨てる)。実ソース・外部の Gateway には接続しない(トレースに実データが入る経路を
 *   作らない)。ソースへのアクセスは条件 1・2 も含めて Gateway の tools/call を通す(不変条件2)
 * - 条件 1・2 は LLM なしで search を直接呼ぶ。条件 3・4 は Orchestrator(探索 LLM)を回す
 * - 本番(NODE_ENV=production)では開発用コネクタ・モック IdP が構築を拒否する
 */
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { AuditLogger, BufferedAuditSink, InMemoryAuditStore } from "@leisen/audit";
import {
  DEV_ORCHESTRATOR_CREDENTIAL,
  DevFixtureConnector,
  Gateway,
  MockCredentialProvider,
  MockIdpAdapter,
  createGatewayHttpServer,
  createRunIdKeyRing,
  deploymentConfigSchema,
  generateSyntheticCorpus,
  loadDevFixtureCorpusFile,
  mockTokenEnvVar,
  type DevFixtureDocument,
  type DevFixtureSearchMode,
  type DevFixtureSpecDelivery,
} from "@leisen/gateway";
import { McpGatewayClient } from "../gateway/mcp-client.js";
import type { GatewayClient } from "../gateway/types.js";
import type { LlmClient } from "../llm/types.js";
import type { Orchestrator } from "../orchestrator.js";
import { DEFAULT_RECALL_KS, caseMetrics, type CaseMetrics } from "./metrics.js";
import type { SearchEvalQuestion, SearchEvalQuestionSet } from "./questions.js";
import {
  MemoryTraceSink,
  TeeTraceSink,
  TracingGatewayClient,
  type SearchEvalCondition,
  type TraceCaseContext,
  type TraceSink,
} from "./trace.js";
import { DEFAULT_UI_PROMPT_STYLE, isLibreChatStyle, runAskLikeLibreChat, type UiPromptStyle } from "./librechat-ui.js";
import { UI_DEFAULT_MAX_QUESTION_CHARS, reproduceUiAsk, simpleQuestionOf } from "./ui-question.js";

/** 比較する検索方式(Redmine 型は AND / OR を別の方式として扱う)。 */
export const SEARCH_EVAL_MODES = ["default", "esa", "redmine-or", "redmine-and", "github"] as const;
export type SearchEvalMode = (typeof SEARCH_EVAL_MODES)[number];

export function connectorModeOf(mode: SearchEvalMode): {
  readonly searchMode: DevFixtureSearchMode;
  readonly redmineAllWords: boolean;
} {
  switch (mode) {
    case "redmine-or":
      return { searchMode: "redmine", redmineAllWords: false };
    case "redmine-and":
      return { searchMode: "redmine", redmineAllWords: true };
    default:
      return { searchMode: mode, redmineAllWords: false };
  }
}

/** 質問セットが指すコーパス(ファイル + 生成した文書)を読む。相対パスは質問セットのファイル基準。 */
export async function loadSearchEvalCorpus(
  questionSetPath: string,
  set: SearchEvalQuestionSet,
): Promise<DevFixtureDocument[]> {
  const baseDir = dirname(questionSetPath);
  const documents: DevFixtureDocument[] = [];
  for (const file of set.corpus.files) {
    documents.push(...(await loadDevFixtureCorpusFile(file, baseDir)));
  }
  if (set.corpus.synthetic !== undefined) {
    documents.push(...generateSyntheticCorpus(set.corpus.synthetic));
  }
  return documents;
}

/** プロセス内の評価用 Gateway。 */
export interface EvalGateway {
  /** 利用者のセッションと Orchestrator の資格情報(開発用の既定値)を持つクライアント */
  readonly client: GatewayClient;
  close(): Promise<void>;
}

/** 評価用の利用者(モック IdP のセッション)。値は開発用のダミーで秘密ではない */
const EVAL_SESSION_TOKEN = "dev-only-search-eval-session";
const EVAL_USER_ID = "search-eval-user";

export async function startEvalGateway(options: {
  readonly sourceId: string;
  readonly documents: readonly DevFixtureDocument[];
  readonly mode: SearchEvalMode;
  /**
   * 検索の仕様の伝え方(summary / both / profile / split)。省略時は開発用コネクタの既定(既定の方式は
   * 検索プロファイルを返し、模擬の方式は summary の自由文だけ)
   */
  readonly specDelivery?: DevFixtureSpecDelivery;
}): Promise<EvalGateway> {
  const { sourceId } = options;
  const connector = new DevFixtureConnector(sourceId, options.documents, {
    ...connectorModeOf(options.mode),
    ...(options.specDelivery !== undefined ? { specDelivery: options.specDelivery } : {}),
    displayName: "社内文書(開発用の合成コーパス)",
  });
  const provider = new MockCredentialProvider(sourceId, {
    env: { [mockTokenEnvVar(sourceId)]: "dev-only-search-eval-token" },
  });
  const idp = new MockIdpAdapter([provider], {
    sessions: { [EVAL_SESSION_TOKEN]: { userId: EVAL_USER_ID } },
  });
  const config = deploymentConfigSchema.parse({
    schemaVersion: 1,
    deployment: { name: "dev-search-eval" },
    idp: { adapter: { kind: "mock" } },
    connectors: [{ id: sourceId }],
  });
  const gateway = new Gateway({
    config,
    idpAdapter: idp,
    connectors: [connector],
    // 監査はメモリに書いて捨てる(本番の監査ストアは使わない)
    auditLogger: new AuditLogger(new BufferedAuditSink(new InMemoryAuditStore(), { retryBaseDelayMs: 1 })),
    runs: {
      keys: createRunIdKeyRing({ current: { kid: "eval1", key: randomBytes(32) } }),
      orchestratorCredential: Buffer.from(DEV_ORCHESTRATOR_CREDENTIAL, "utf8"),
      ttlSeconds: 3_600,
      feedbackWindowSeconds: 3_600,
      limits: { maxQuestionChars: 10_000, maxCitations: 50, maxSearchedSources: 50, maxIdChars: 512 },
      maxBodyBytes: 64 * 1024,
      maxRequestsPerUserPerMinute: 1_000_000,
    },
    docIdHmacKey: randomBytes(32).toString("hex"),
  });
  const server = createGatewayHttpServer(gateway);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const client = new McpGatewayClient({
    url: `http://127.0.0.1:${port}/mcp`,
    sessionToken: EVAL_SESSION_TOKEN,
    orchestratorCredential: DEV_ORCHESTRATOR_CREDENTIAL,
  });
  return {
    client,
    async close() {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface SearchEvalRunOptions {
  readonly mode: string;
  readonly source: string;
  readonly questions: readonly SearchEvalQuestion[];
  readonly conditions: readonly SearchEvalCondition[];
  readonly gateway: GatewayClient;
  readonly sink: TraceSink;
  /** 条件 3・4 の試行回数(条件 1・2 は決定的なので 1 回) */
  readonly repeat?: number;
  readonly ks?: readonly number[];
  /** 条件 3・4 の探索 LLM */
  readonly orchestrator?: Orchestrator;
  /** 条件 4 の UI 側 LLM */
  readonly uiLlm?: LlmClient;
  /** 条件 4 の UI 側 LLM への入力の再現の種類(既定 simple) */
  readonly uiPrompt?: UiPromptStyle;
  readonly onProgress?: (message: string) => void;
  /**
   * LLM の使用量の累計を返す関数(claude -p のクライアントなど、費用と時間を数えられる場合)。
   * 指定すると、条件 3・4 の試行ごとに差分を llm_usage としてトレースに書く
   */
  readonly llmUsage?: () => LlmUsageSnapshot;
  readonly now?: () => number;
}

/** LLM の使用量の累計(llmUsage が返す)。 */
export interface LlmUsageSnapshot {
  readonly calls: number;
  readonly costUsd: number;
  readonly durationMs: number;
  /** 失敗した呼び出しの分類 → 回数(累計) */
  readonly failures?: Readonly<Record<string, number>>;
}

function failureDiff(
  before: Readonly<Record<string, number>> | undefined,
  after: Readonly<Record<string, number>> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(after ?? {})) {
    const diff = count - (before?.[key] ?? 0);
    if (diff > 0) {
      out[key] = diff;
    }
  }
  return out;
}

function errorClassOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "errorClass" in error) {
    const value = (error as { errorClass: unknown }).errorClass;
    if (typeof value === "string" && /^[a-z][a-z0-9_]*$/u.test(value)) {
      return value;
    }
  }
  return "unexpected_error";
}

/** 条件 1・2: query を 1 つずつ search に直接入力する(LLM なし)。 */
async function runDirect(
  options: SearchEvalRunOptions,
  context: TraceCaseContext,
  sink: TraceSink,
  queries: readonly string[],
  limit: number,
): Promise<void> {
  const traced = new TracingGatewayClient(options.gateway, sink, context);
  for (const query of queries) {
    sink.write({ ...context, type: "case_start", input: query });
    // runId を申告しない呼び出し(Gateway は未申告として扱う)
    await traced.callTool("search", { source: options.source, query, limit }, {});
  }
}

/** 条件 3・4: Orchestrator に質問を渡す。 */
async function runOrchestrated(
  orchestrator: Orchestrator,
  options: SearchEvalRunOptions,
  context: TraceCaseContext,
  sink: TraceSink,
  question: string,
): Promise<void> {
  sink.write({ ...context, type: "case_start", input: question });
  const traced = new TracingGatewayClient(options.gateway, sink, context);
  try {
    const { answer } = await orchestrator.runDetailed({ question, gateway: traced });
    sink.write({
      ...context,
      type: "answer",
      outcome: answer.outcome,
      citations: answer.citations.map((c) => ({ sourceId: c.sourceId, documentId: c.documentId })),
      llmTurns: answer.usage.llmTurns,
      toolCalls: answer.usage.toolCalls,
    });
  } catch (error) {
    sink.write({ ...context, type: "case_error", errorClass: errorClassOf(error) });
  }
}

/**
 * 条件 4: UI 側 LLM に ask を呼ばせ、その引数で探索 LLM を回す。
 * - simple: 従来どおり question だけを Orchestrator に渡す
 * - librechat / librechat-instructions: 引数をすべて leisen-ask serve と同じ検証(runOrchestratorTool)に
 *   かけて渡す(LibreChat は書かれた引数をそのまま tools/call に載せる)
 * どちらも UI 側 LLM が書いた引数をトレースに残す。
 */
async function runOrchestratorUi(
  orchestrator: Orchestrator,
  uiLlm: LlmClient,
  options: SearchEvalRunOptions,
  context: TraceCaseContext,
  sink: TraceSink,
  utterance: string,
): Promise<void> {
  const uiPrompt = options.uiPrompt ?? DEFAULT_UI_PROMPT_STYLE;
  const ui = await reproduceUiAsk(uiLlm, utterance, { style: uiPrompt });
  if (!ui.ok) {
    sink.write({ ...context, type: "ui_question", question: null, uiPrompt });
    // simple は従来の分類のまま(引数がオブジェクトでなければ ui_invalid_question)
    const errorClass =
      !isLibreChatStyle(uiPrompt) && ui.errorClass === "ui_invalid_arguments" ? "ui_invalid_question" : ui.errorClass;
    sink.write({ ...context, type: "case_error", errorClass });
    return;
  }
  const recorded = { uiPrompt, toolName: ui.toolName, arguments: ui.arguments };
  if (!isLibreChatStyle(uiPrompt)) {
    const question = simpleQuestionOf(ui.arguments);
    sink.write({ ...context, type: "ui_question", question: question ?? null, ...recorded });
    if (question === undefined) {
      sink.write({ ...context, type: "case_error", errorClass: "ui_invalid_question" });
      return;
    }
    await runOrchestrated(orchestrator, options, context, sink, question);
    return;
  }
  const rawQuestion = ui.arguments["question"];
  const traced = new TracingGatewayClient(options.gateway, sink, context);
  let uiWritten = false;
  const writeUi = (rejectedErrorClass?: string) => {
    if (!uiWritten) {
      uiWritten = true;
      sink.write({
        ...context,
        type: "ui_question",
        question: typeof rawQuestion === "string" ? rawQuestion : null,
        ...recorded,
        ...(rejectedErrorClass !== undefined ? { rejectedErrorClass } : {}),
      });
    }
  };
  const result = await runAskLikeLibreChat({
    orchestrator,
    gateway: traced,
    args: ui.arguments,
    maxQuestionChars: UI_DEFAULT_MAX_QUESTION_CHARS,
    knownSourceIds: [options.source],
    onRunStart: (input) => {
      writeUi();
      sink.write({ ...context, type: "case_start", input: input.question });
    },
    onRunResult: ({ answer }) => {
      sink.write({
        ...context,
        type: "answer",
        outcome: answer.outcome,
        citations: answer.citations.map((c) => ({ sourceId: c.sourceId, documentId: c.documentId })),
        llmTurns: answer.usage.llmTurns,
        toolCalls: answer.usage.toolCalls,
      });
    },
  });
  if (!result.runStarted) {
    const rejected = result.outcome.structuredContent["errorClass"];
    const errorClass = typeof rejected === "string" ? rejected : "invalid_request";
    writeUi(errorClass);
    sink.write({ ...context, type: "case_error", errorClass: `ui_ask_rejected_${errorClass}` });
  } else if ("runError" in result) {
    sink.write({ ...context, type: "case_error", errorClass: errorClassOf(result.runError) });
  }
}

const isOrchestrated = (condition: SearchEvalCondition) =>
  condition === "orchestrator-utterance" || condition === "orchestrator-ui";

/** 1 つの検索方式について、質問 × 条件を実行し、試行ごとの指標を返す。 */
export async function runSearchEval(options: SearchEvalRunOptions): Promise<CaseMetrics[]> {
  const ks = options.ks ?? DEFAULT_RECALL_KS;
  const limit = Math.max(...ks);
  const repeat = options.repeat ?? 1;
  const results: CaseMetrics[] = [];
  for (const condition of options.conditions) {
    const attempts =
      condition === "keywords" || condition === "utterance" ? 1 : repeat;
    if ((condition === "orchestrator-utterance" || condition === "orchestrator-ui") && options.orchestrator === undefined) {
      throw new Error(`condition ${condition} needs an orchestrator (LLM)`);
    }
    if (condition === "orchestrator-ui" && options.uiLlm === undefined) {
      throw new Error("condition orchestrator-ui needs a UI-side LLM");
    }
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      for (const question of options.questions) {
        const context: TraceCaseContext = {
          mode: options.mode,
          condition,
          questionId: question.id,
          attempt,
        };
        const memory = new MemoryTraceSink();
        const sink = new TeeTraceSink([memory, options.sink]);
        options.onProgress?.(`${options.mode} / ${condition} / ${question.id}(${attempt} 回目)`);
        const now = options.now ?? Date.now;
        const startedAt = now();
        const usageBefore = isOrchestrated(condition) ? options.llmUsage?.() : undefined;
        try {
          switch (condition) {
            case "keywords":
              await runDirect(options, context, sink, question.keywords, limit);
              break;
            case "utterance":
              await runDirect(options, context, sink, [question.utterance], limit);
              break;
            case "orchestrator-utterance":
              await runOrchestrated(options.orchestrator as Orchestrator, options, context, sink, question.utterance);
              break;
            case "orchestrator-ui":
              await runOrchestratorUi(
                options.orchestrator as Orchestrator,
                options.uiLlm as LlmClient,
                options,
                context,
                sink,
                question.utterance,
              );
              break;
          }
        } catch (error) {
          sink.write({ ...context, type: "case_error", errorClass: errorClassOf(error) });
        }
        if (usageBefore !== undefined && options.llmUsage !== undefined) {
          const after = options.llmUsage();
          const failures = failureDiff(usageBefore.failures, after.failures);
          sink.write({
            ...context,
            type: "llm_usage",
            calls: after.calls - usageBefore.calls,
            costUsd: after.costUsd - usageBefore.costUsd,
            llmDurationMs: after.durationMs - usageBefore.durationMs,
            elapsedMs: now() - startedAt,
            ...(Object.keys(failures).length > 0 ? { failures } : {}),
          });
        }
        results.push(caseMetrics(question, context, memory.events, ks));
      }
    }
  }
  return results;
}

