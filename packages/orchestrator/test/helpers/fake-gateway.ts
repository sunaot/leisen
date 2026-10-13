/**
 * 脚本で応答する GatewayClient(実 Gateway では作れない応答 — 利用者の報告の欠落・食い違い、
 * run の途中の分類の変化 — を再現するためのテスト用)。ツール定義は @leisen/gateway の
 * toolDefinitions をそのまま使う。
 */
import { toolDefinitions } from "@leisen/gateway";
import type {
  FinishRunInput,
  GatewayCallOutcome,
  GatewayClient,
  GatewayToolSchema,
  StartRunResult,
} from "../../src/index.js";

export interface FakeCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly meta: Readonly<Record<string, unknown>>;
}

export type FakeHandler = (
  call: FakeCall,
  index: number,
) => GatewayCallOutcome | Promise<GatewayCallOutcome>;

export class FakeGatewayClient implements GatewayClient {
  readonly calls: FakeCall[] = [];
  /** run API への申告(開始・終了・フィードバック)の記録 */
  readonly started: { readonly question: string }[] = [];
  readonly finished: { readonly runId: string; readonly input: FinishRunInput }[] = [];
  readonly feedbacks: { readonly runId: string; readonly outcome: "resolved" | "unresolved" }[] = [];
  /** startRun / finishRun を失敗させる(テスト用の注入) */
  startError: Error | undefined;
  finishError: Error | undefined;
  /** runId の有効期間(秒)。startRun の expiresAt に使う */
  ttlSeconds = 600;

  constructor(
    private readonly sources: readonly string[],
    private readonly handler: FakeHandler,
  ) {}

  async startRun(input: { readonly question: string }): Promise<StartRunResult> {
    if (this.startError !== undefined) {
      throw this.startError;
    }
    this.started.push({ question: input.question });
    const issuedAt = Date.now();
    return {
      runId: `fake-run-${this.started.length}`,
      expiresAt: new Date(issuedAt + this.ttlSeconds * 1000).toISOString(),
      feedbackUntil: new Date(issuedAt + 7 * 24 * 3600 * 1000).toISOString(),
    };
  }

  async finishRun(runId: string, input: FinishRunInput): Promise<void> {
    if (this.finishError !== undefined) {
      throw this.finishError;
    }
    this.finished.push({ runId, input });
  }

  async feedbackRun(runId: string, outcome: "resolved" | "unresolved"): Promise<void> {
    this.feedbacks.push({ runId, outcome });
  }

  async listTools(): Promise<readonly GatewayToolSchema[]> {
    return toolDefinitions(this.sources).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    meta: Readonly<Record<string, unknown>>,
  ): Promise<GatewayCallOutcome> {
    const call = { name, args, meta };
    this.calls.push(call);
    return this.handler(call, this.calls.length - 1);
  }

  async close(): Promise<void> {}
}

/** describe の成功結果(userId を省略すると Gateway が利用者を報告しない応答になる)。 */
export function describeOk(sourceId: string, userId?: string): GatewayCallOutcome {
  return {
    ok: true,
    result: {
      sourceId,
      displayName: sourceId,
      summary: `${sourceId} の社内文書`,
      topContainers: [],
      supportedFilters: ["updatedAfter"],
    },
    ...(userId !== undefined ? { userId } : {}),
  };
}

/** search の成功結果(1件ヒット)。 */
export function searchHit(
  sourceId: string,
  documentId: string,
  userId: string,
): GatewayCallOutcome {
  return {
    ok: true,
    result: {
      hits: [
        {
          documentId,
          title: `${documentId} の文書`,
          snippet: "経費精算の締め日は毎月25日です。",
          url: `https://${sourceId}.example.test/docs/${documentId}`,
        },
      ],
    },
    userId,
  };
}
