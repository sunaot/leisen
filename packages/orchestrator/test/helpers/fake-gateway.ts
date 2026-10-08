/**
 * 脚本で応答する GatewayClient(実 Gateway では作れない応答 — 利用者の報告の欠落・食い違い、
 * run の途中の分類の変化 — を再現するためのテスト用)。ツール定義は @kp/gateway の
 * toolDefinitions をそのまま使う。
 */
import { toolDefinitions } from "@kp/gateway";
import type {
  GatewayCallOutcome,
  GatewayClient,
  GatewayToolSchema,
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

  constructor(
    private readonly sources: readonly string[],
    private readonly handler: FakeHandler,
  ) {}

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
