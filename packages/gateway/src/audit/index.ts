/**
 * 監査ログ骨格 — 2層モデル(ADR-011)。zod化と検証強化は T-001。
 *
 * 設計意図:
 * - AnswerRun(会話/回答単位)と ToolInvocation(ツール呼び出し単位)の2層。
 *   runId で束ね、「ソース別未解決率」「再検索回数分布」(T-014)を集計可能にする。
 * - 全ツール呼び出しにつき ToolInvocation を正確に1レコード。Gateway以外から書かない。
 * - 秘密情報(トークン、認証ヘッダ、文書本文)のフィールドは存在させない。
 * - **post-filtering前の候補件数フィールドは存在させない(ADR-011/012)。**
 *   returnedHitCount は認可済み返却件数のみ。候補件数を追加してはならない
 *   (existence leak: 返却0件との差分から未認可文書の存在が漏れる)。
 * - 生クエリは queryDigest(SHA-256)のみ。rawQuery は短期保持の別テーブル
 *   (T-001で実装)に置き、digestで結合する。
 * - 書き込み失敗時の挙動は ADR-011(既定 fail-closed)。Gateway統合は T-003。
 */
import { createHash } from "node:crypto";

export type Outcome = "resolved" | "unresolved" | "error" | "pending";

/** 呼び出し主体(ADR-015)。agent の場合は on-behalf-of チェーンを記録する。 */
export type Actor =
  | { readonly kind: "human" }
  | {
      readonly kind: "agent";
      readonly agentId: string;
      /** 委譲の連鎖(最終的な人間の userId まで)。 */
      readonly onBehalfOfChain: readonly string[];
    };

/** 会話/回答単位のレコード。利用者フィードバックはここを更新する。 */
export interface AnswerRunRecord {
  runId: string;
  /** IdP上のユーザーID(権限の主体) */
  userId: string;
  actor: Actor;
  /** ISO 8601 */
  startedAt: string;
  endedAt: string | null;
  /** 最終質問のSHA-256 */
  finalQueryDigest: string | null;
  finalOutcome: Outcome;
  /** 0..1(Orchestrator申告) */
  confidence: number | null;
  /** 利用者フィードバック(解決/未解決ボタン) */
  userFeedback: "resolved" | "unresolved" | null;
  searchedSources: string[];
  citedDocIds: string[];
  failureReason: string | null;
}

/** ツール呼び出し単位のレコード。 */
export interface ToolInvocationRecord {
  requestId: string;
  /** 親の AnswerRun */
  runId: string;
  /** 探索ループ内の反復連番(0始まり) */
  iteration: number;
  userId: string;
  /** ISO 8601 */
  timestamp: string;
  sourceId: string;
  tool: "search" | "fetch" | "list" | "describe";
  /** 生クエリのSHA-256。集計・rawQueryテーブルとの結合キー */
  queryDigest: string | null;
  filtersDigest: string | null;
  /**
   * 認可済み返却件数のみ。post-filtering前の候補件数を
   * ここに(あるいは別フィールドとして)記録してはならない(ADR-011/012)。
   */
  returnedHitCount: number | null;
  fetchedDocCount: number;
  latencyMs: number;
  errorClass: string | null;
  retryCount: number;
}

export type AuditRecord =
  | ({ recordType: "answer_run" } & AnswerRunRecord)
  | ({ recordType: "tool_invocation" } & ToolInvocationRecord);

/**
 * 禁止フィールド(トップレベルのキー名のみの粗い実行時検知)。
 * 本命の防御は「型に存在させない」ことであり、ネストした値・本文の混入は
 * この検査では検出できない。深い検査は T-001 のzod化で扱う。
 */
const FORBIDDEN_KEYS = [
  "accessToken",
  "authorization",
  "content",
  "token",
  "credential",
  "snippet",
  "hitCount", // 旧v0.1の曖昧フィールド。returnedHitCountのみ許可(ADR-011)
  "candidateCount",
];

export function digestQuery(rawQuery: string): string {
  return createHash("sha256").update(rawQuery, "utf8").digest("hex");
}

function assertDigest(value: string | null, field: string): void {
  if (value !== null && !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${field} must be a sha256 hex digest or null`);
  }
}

function assertNoForbiddenKeys(record: object): void {
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      throw new Error(`audit record must not contain forbidden field: ${key}`);
    }
  }
}

/** レコードを検証する。禁止フィールドの混入は実行時にも拒否する。 */
export function validateRecord(record: AuditRecord): void {
  assertNoForbiddenKeys(record);
  if (record.recordType === "answer_run") {
    if (!record.runId || !record.userId) {
      throw new Error("answer_run record missing required identity fields");
    }
    if (record.actor.kind === "agent" && record.actor.onBehalfOfChain.length === 0) {
      throw new Error("agent actor requires a non-empty onBehalfOfChain (ADR-015)");
    }
    assertDigest(record.finalQueryDigest, "finalQueryDigest");
    return;
  }
  if (!record.requestId || !record.runId || !record.userId || !record.sourceId) {
    throw new Error("tool_invocation record missing required identity fields");
  }
  if (!Number.isInteger(record.iteration) || record.iteration < 0) {
    throw new Error("iteration must be a non-negative integer");
  }
  assertDigest(record.queryDigest, "queryDigest");
  assertDigest(record.filtersDigest, "filtersDigest");
}

/**
 * 監査シンク。write は Promise を返す(ADR-011)。実運用のシンクは永続ストアへの
 * 書き込み・backpressure・retry・local buffer・at-least-once・shutdown時flushを
 * 担うため非同期であり、IFを最初から async にしておく(同期前提だと後で全面手戻り)。
 * 具体実装(永続sink)はT-001/T-003。
 */
export interface AuditSink {
  write(record: AuditRecord): Promise<void>;
  /** shutdown時にバッファを永続化しきる。stdout等では no-op。 */
  flush?(): Promise<void>;
}

/**
 * デバッグ用シンク: 構造化JSONをstdoutへ。開発・ローカル用。
 * 注意: stdout単体では at-least-once を保証しない。本番監査には使わない。
 * Gateway統合(T-003)は ADR-011 に従い、書き込み失敗時に既定でツール呼び出しを
 * 失敗させる(fail-closed)。
 */
export class StdoutDebugAuditSink implements AuditSink {
  async write(record: AuditRecord): Promise<void> {
    validateRecord(record);
    process.stdout.write(JSON.stringify({ kind: "audit", ...record }) + "\n");
  }
}

export class AuditLogger {
  constructor(private readonly sink: AuditSink) {}

  async log(record: AuditRecord): Promise<void> {
    validateRecord(record);
    await this.sink.write(record);
  }
}
