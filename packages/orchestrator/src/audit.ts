/**
 * AnswerRun(ADR-011 の上位層)の組み立て(T-007、ADR-017 決定2)。
 *
 * - Orchestrator は AnswerRun だけを書く。ToolInvocation は Gateway が書く
 *   (Gateway を経由しないツール呼び出し経路を作らない、不変条件2)。両者は runId で束ねる
 * - 冪等キーは runId(開始時 pending → 終了時の最終状態 → 利用者フィードバックで
 *   同じ runId のレコードを上書き再書き込みする。at-least-once の受け側は runId で
 *   重複除去する。InMemoryAuditStore は上書き)
 * - 永続化する値: runId / userId / actor / 時刻 / 質問の SHA-256(finalQueryDigest)/
 *   結果 / confidence / userFeedback / searchedSources / citedDocIds / failureReason
 *   (正規化コードのみ)。質問の原文・回答本文・タイトル・URL・スニペットは書かない
 * - Slack 由来データ(ADR-014、不変条件7): 現時点で Slack ソースは扱わないが、
 *   searchedSources / skippedSources には deployment.yaml のソースID だけを入れ、
 *   Slack 由来のメタデータ(channel・permalink・ts 等)を入れない。citedDocIds は
 *   gateway の redaction(docid.ts)を通し、Slack 由来は記録しない(omitted)
 */
import {
  digestQuery,
  redactDocIdsForAudit,
  validateRecord,
  type Actor,
  type AnswerRunRecord,
  type AuditRecord,
  type AuditSink,
} from "@kp/gateway";
import type { AnswerOutcome, Citation } from "./answer.js";

/** Phase 1 の実行区分は human-in-the-loop 固定(ADR-015、ADR-017 決定5)。 */
export const HUMAN_ACTOR: Actor = { kind: "human" };

export type AnswerRunAuditRecord = AnswerRunRecord & { recordType: "answer_run" };

export interface PendingAnswerRunInput {
  readonly runId: string;
  readonly userId: string;
  /** ISO 8601 */
  readonly startedAt: string;
  readonly question: string;
}

/** 開始時の pending レコード。 */
export function pendingAnswerRun(input: PendingAnswerRunInput): AnswerRunAuditRecord {
  return {
    recordType: "answer_run",
    runId: input.runId,
    userId: input.userId,
    actor: HUMAN_ACTOR,
    startedAt: input.startedAt,
    endedAt: null,
    finalQueryDigest: digestQuery(input.question),
    finalOutcome: "pending",
    confidence: null,
    userFeedback: null,
    searchedSources: [],
    citedDocIds: [],
    failureReason: null,
  };
}

export interface FinishedAnswerRunInput {
  /** ISO 8601 */
  readonly endedAt: string;
  readonly outcome: AnswerOutcome;
  readonly confidence: number;
  readonly searchedSources: readonly string[];
  readonly citations: readonly Citation[];
  /** 正規化コード(lower snake_case)のみ。生のエラーメッセージを入れない(TM-A2) */
  readonly failureReason: string | null;
}

/** 終了時の最終状態(同じ runId で pending を上書きする)。 */
export function finishedAnswerRun(
  pending: AnswerRunAuditRecord,
  input: FinishedAnswerRunInput,
): AnswerRunAuditRecord {
  return {
    ...pending,
    endedAt: input.endedAt,
    finalOutcome: input.outcome,
    // error で終わった run の confidence は意味を持たない
    confidence: input.outcome === "error" ? null : input.confidence,
    searchedSources: [...input.searchedSources],
    citedDocIds: citedDocIdsForAudit(input.citations),
    failureReason: input.failureReason,
  };
}

/**
 * citedDocIds を監査に記録してよい形にする(ADR-013 §2)。documentId はコネクタ
 * スコープの不透明な ID のため `<sourceId>:<documentId>` で一意にする。
 *
 * TODO(ADR-017 確認事項): プライベートスコープ / Slack 由来の分類をコネクタの
 * メタデータ(または deployment.yaml の privateScopes)から引く。現状は全ソースを
 * 「非プライベート・非 Slack」として通す。根拠: Slack コネクタは未実装(T-006 は
 * 法務確認待ち)で、privateScopes の既定 excluded ではプライベートスコープの文書が
 * 検索結果に現れない。consent / included を使う導入や Slack コネクタの追加の前に
 * 分類を実装すること(hashed には deployment 固有の HMAC 鍵が要る)。
 */
export function citedDocIdsForAudit(citations: readonly Citation[]): string[] {
  return redactDocIdsForAudit(
    citations.map((citation) => ({
      docId: `${citation.sourceId}:${citation.documentId}`,
      origin: { privateScope: false, slackOrigin: false },
    })),
    { privateScopeDocIds: "hashed" },
  );
}

/**
 * 開発用の監査シンク: レコードを1行の JSON で stderr へ書く(kp-ask 用。stdout は
 * 回答の表示に使う)。at-least-once を保証しないため本番監査に使わない
 * (gateway の StdoutDebugAuditSink と同じ位置づけ)。
 */
export class StderrDebugAuditSink implements AuditSink {
  constructor(
    private readonly writeLine: (line: string) => void = (line) => {
      process.stderr.write(`${line}\n`);
    },
  ) {}

  async write(record: AuditRecord): Promise<void> {
    validateRecord(record);
    this.writeLine(JSON.stringify({ kind: "audit", ...record }));
  }
}
