/**
 * 比較実験のトレース(合成コーパス専用の開発用機能)。
 *
 * 探索 LLM(または条件 1・2 の直接入力)が発行した search のクエリ(ソース・query・filters・limit)、
 * 返ったヒット(順位・documentId・title)、fetch した documentId、最終回答の出典を、1 行 1 イベントの
 * JSONL として残す。
 *
 * - 監査ログ(@leisen/audit)・Gateway の本番経路には手を入れない。記録は Orchestrator が使う
 *   GatewayClient を包む TracingGatewayClient で行う(Orchestrator 本体は変えない)
 * - 実ソースのデータをトレースに書く経路を作らない: TracingGatewayClient を作るのは比較実験
 *   (search-eval/runner.ts)だけで、相手は比較実験が自分で起動したプロセス内の Gateway と、
 *   合成コーパスを持つ開発用コネクタ(dev-fixture)だけ。leisen-ask / leisen-ask serve / 既存の
 *   dev-eval(外部の Gateway に接続する)からは使わない
 * - 資格情報(トークン)は記録しない(不変条件6)。記録するのはツールの引数と結果の一部だけ
 */
import { appendFileSync, writeFileSync } from "node:fs";
import type {
  FinishRunInput,
  GatewayCallOptions,
  GatewayCallOutcome,
  GatewayClient,
  GatewayToolSchema,
  StartRunResult,
} from "../gateway/types.js";

/** 実験の条件(README「比較実験」)。 */
export const SEARCH_EVAL_CONDITIONS = [
  /** 1: 人が書いたキーワードを search に直接入力する */
  "keywords",
  /** 2: 利用者の発言をそのまま search に入力する */
  "utterance",
  /** 3: 利用者の発言を Orchestrator(探索 LLM)に渡す */
  "orchestrator-utterance",
  /** 4: UI 側 LLM が作った question を Orchestrator に渡す */
  "orchestrator-ui",
] as const;
export type SearchEvalCondition = (typeof SEARCH_EVAL_CONDITIONS)[number];

/** 1 回の試行(方式 × 条件 × 質問 × 回)を特定する文脈。 */
export interface TraceCaseContext {
  readonly mode: string;
  readonly condition: SearchEvalCondition;
  readonly questionId: string;
  readonly attempt: number;
}

export interface TracedHit {
  readonly rank: number;
  readonly documentId: string;
  readonly title: string;
}

export type TraceEvent =
  | (TraceCaseContext & {
      readonly type: "case_start";
      /** search の query(条件 1・2)または Orchestrator に渡す質問(条件 3・4) */
      readonly input: string;
    })
  | (TraceCaseContext & {
      readonly type: "ui_question";
      /** UI 側 LLM が ask に渡した question(ask を呼ばなかったら null) */
      readonly question: string | null;
    })
  | (TraceCaseContext & {
      readonly type: "search";
      readonly source: string;
      readonly query: string;
      readonly filters?: Readonly<Record<string, unknown>>;
      readonly limit?: number;
      readonly hits: readonly TracedHit[];
      readonly hasMore: boolean;
      /** ツールエラーの分類(成功なら省略) */
      readonly errorClass?: string;
    })
  | (TraceCaseContext & {
      readonly type: "fetch";
      readonly source: string;
      readonly documentId: string;
      readonly errorClass?: string;
    })
  | (TraceCaseContext & {
      readonly type: "answer";
      readonly outcome: string;
      readonly citations: readonly { readonly sourceId: string; readonly documentId: string }[];
      readonly llmTurns?: number;
      readonly toolCalls?: number;
    })
  | (TraceCaseContext & {
      readonly type: "llm_usage";
      /** この試行での LLM の呼び出し回数(UI 側 LLM と探索 LLM の合計) */
      readonly calls: number;
      /** 費用(USD。claude -p の total_cost_usd の合計。読めない分は含まない) */
      readonly costUsd: number;
      /** LLM の呼び出しの所要時間の合計(ms) */
      readonly llmDurationMs: number;
      /** 試行全体の実時間(ms) */
      readonly elapsedMs: number;
    })
  | (TraceCaseContext & {
      readonly type: "case_error";
      /** 固定の分類(例外の文言は書かない) */
      readonly errorClass: string;
    });

export type SearchTraceEvent = Extract<TraceEvent, { type: "search" }>;
export type FetchTraceEvent = Extract<TraceEvent, { type: "fetch" }>;
export type AnswerTraceEvent = Extract<TraceEvent, { type: "answer" }>;

/** トレースの書き先。 */
export interface TraceSink {
  write(event: TraceEvent): void;
}

/** メモリに溜める書き先(集計とテスト用)。 */
export class MemoryTraceSink implements TraceSink {
  readonly events: TraceEvent[] = [];
  write(event: TraceEvent): void {
    this.events.push(event);
  }
}

/** JSONL ファイルへの書き先(開始時にファイルを空にする)。 */
export class JsonlTraceSink implements TraceSink {
  constructor(private readonly path: string) {
    writeFileSync(path, "", "utf8");
  }
  write(event: TraceEvent): void {
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf8");
  }
}

/** 複数の書き先へ同じイベントを書く。 */
export class TeeTraceSink implements TraceSink {
  constructor(private readonly sinks: readonly TraceSink[]) {}
  write(event: TraceEvent): void {
    for (const sink of this.sinks) {
      sink.write(event);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** search の結果(structuredContent の { hits, nextCursor })から順位付きのヒットを読む。 */
export function tracedHitsOf(result: unknown): { hits: TracedHit[]; hasMore: boolean } {
  if (!isRecord(result) || !Array.isArray(result["hits"])) {
    return { hits: [], hasMore: false };
  }
  const hits: TracedHit[] = [];
  for (const hit of result["hits"]) {
    if (isRecord(hit) && typeof hit["documentId"] === "string") {
      hits.push({
        rank: hits.length + 1,
        documentId: hit["documentId"],
        title: typeof hit["title"] === "string" ? hit["title"] : "",
      });
    }
  }
  return { hits, hasMore: typeof result["nextCursor"] === "string" };
}

function optionalFilters(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) && Object.keys(value).length > 0 ? value : undefined;
}

/**
 * GatewayClient を包み、search / fetch の呼び出しと結果をトレースに書く。それ以外の呼び出しは
 * そのまま委ねる(結果は変えない)。
 */
export class TracingGatewayClient implements GatewayClient {
  constructor(
    private readonly inner: GatewayClient,
    private readonly sink: TraceSink,
    private readonly context: TraceCaseContext,
  ) {}

  listTools(options?: GatewayCallOptions): Promise<readonly GatewayToolSchema[]> {
    return this.inner.listTools(options);
  }

  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    meta: Readonly<Record<string, unknown>>,
    options?: GatewayCallOptions,
  ): Promise<GatewayCallOutcome> {
    const outcome = await this.inner.callTool(name, args, meta, options);
    const source = typeof args["source"] === "string" ? args["source"] : "";
    if (name === "search") {
      const filters = optionalFilters(args["filters"]);
      const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
      const { hits, hasMore } = outcome.ok ? tracedHitsOf(outcome.result) : { hits: [], hasMore: false };
      this.sink.write({
        ...this.context,
        type: "search",
        source,
        query: typeof args["query"] === "string" ? args["query"] : "",
        ...(filters !== undefined ? { filters } : {}),
        ...(limit !== undefined ? { limit } : {}),
        hits,
        hasMore,
        ...(outcome.ok ? {} : { errorClass: outcome.error.errorClass }),
      });
    } else if (name === "fetch") {
      this.sink.write({
        ...this.context,
        type: "fetch",
        source,
        documentId: typeof args["documentId"] === "string" ? args["documentId"] : "",
        ...(outcome.ok ? {} : { errorClass: outcome.error.errorClass }),
      });
    }
    return outcome;
  }

  startRun(input: { readonly question: string }, options?: GatewayCallOptions): Promise<StartRunResult> {
    return this.inner.startRun(input, options);
  }

  finishRun(runId: string, input: FinishRunInput, options?: GatewayCallOptions): Promise<void> {
    return this.inner.finishRun(runId, input, options);
  }

  feedbackRun(runId: string, outcome: "resolved" | "unresolved", options?: GatewayCallOptions): Promise<void> {
    return this.inner.feedbackRun(runId, outcome, options);
  }

  /** 包んだクライアントは呼び出し側が閉じる(試行ごとに閉じない) */
  async close(): Promise<void> {}
}
