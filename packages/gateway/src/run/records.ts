/**
 * run の監査レコードの組み立て(ADR-019 決定3・5・7、T-023 段階 1)。
 *
 * Gateway が run API で受けた申告から、監査ストアに追記するレコードを作る:
 * - `POST /runs`              → pending の AnswerRun(userId は認証値、最終質問の digest だけ)
 * - `POST /runs/{id}/finish`  → `answer_run_finish`(部分レコード)
 * - `POST /runs/{id}/feedback`→ `answer_run_feedback`(部分レコード)
 *
 * 引用 docId の記録は、申告された sourceId に頼らない(決定5)。段階 1 の Gateway は引用の
 * 出所を検証できないので、docId の不可逆化(ADR-013 §2、不変条件7)の分類に申告の sourceId を
 * 使わず、構成全体で最も厳しい規則を全件にかける:
 * - 永続化不可のソース(Slack)が有効な構成 → citedDocIds は空(searchedSources だけ残す)
 * - それ以外で、プライベートスコープを持つソースが有効 → 全件に audit.privateScopeDocIds の
 *   規則(hashed / omitted)
 * - 有効でない sourceId の引用は記録しない。searchedSources も有効なソースだけを残す
 *
 * ソースの知識(有効なソース、Slack・プライベートスコープの有無)はここに入れず、組み立て役
 * (bootstrap / http.ts)が判定の関数として注入する(決定10)。このモジュールは例外を投げる
 * だけで、リクエストを失敗させるかの判断(決定6)は呼び出し側が行う。
 */
import {
  digestQuery,
  redactDocIdForAudit,
  type Actor,
  type AuditRecord,
  type DocIdAuditConfig,
  type FinishOutcome,
  type UserFeedback,
} from "@kp/audit";

/**
 * 構成から注入するソースの判定(ADR-019 決定10)。deployment.yaml の connectors[] から
 * 組み立て役が作る。
 */
export interface RunSourcePolicy {
  /** sourceId が有効なソースか(設定にあり enabled) */
  isEnabledSource(sourceId: string): boolean;
  /**
   * 永続化不可のソース(Slack。ADR-014、不変条件7)が有効な構成か。true なら質問原文を
   * 生クエリ表に書かず、引用 docId も記録しない(段階 1)
   */
  readonly persistenceForbiddenSourceEnabled: boolean;
  /**
   * プライベートスコープを持ちうるソース(privateScopes が excluded 以外)が有効な構成か。
   * true なら全件の引用に privateScopeDocIds の規則をかける
   */
  readonly privateScopeSourceEnabled: boolean;
}

/** 質問原文を生クエリ表に書いてよい構成か(決定7)。 */
export function recordsRawQuestion(policy: RunSourcePolicy): boolean {
  return !policy.persistenceForbiddenSourceEnabled;
}

export interface PendingRunInput {
  readonly runId: string;
  /** Gateway が認証した利用者 */
  readonly userId: string;
  /** このリクエストで検証した actor */
  readonly actor: Actor;
  /** ISO 8601(Gateway の時刻) */
  readonly startedAt: string;
  readonly question: string;
}

/** 開始時の pending の AnswerRun。質問は digest だけ(原文は生クエリ表。決定7)。 */
export function pendingAnswerRunRecord(input: PendingRunInput): AuditRecord {
  return {
    recordType: "answer_run",
    runId: input.runId,
    userId: input.userId,
    actor: input.actor,
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

/** 申告された引用(sourceId と、そのコネクタ内の documentId)。 */
export interface DeclaredCitation {
  readonly sourceId: string;
  readonly documentId: string;
}

/** `POST /runs/{id}/finish` の申告(検証済み。request.ts)。 */
export interface FinishDeclaration {
  readonly outcome: FinishOutcome;
  /** 0..1。error のときは記録しない(null) */
  readonly confidence: number | null;
  readonly searchedSources: readonly string[];
  readonly citations: readonly DeclaredCitation[];
  /** 正規化コードのみ(TM-A2) */
  readonly failureReason: string | null;
}

/** Gateway が付ける部分レコードの識別と時刻。 */
export interface PartialRecordEnvelope {
  /** 冪等キー(Gateway が採番) */
  readonly recordId: string;
  readonly runId: string;
  /** Gateway が認証した利用者 */
  readonly userId: string;
  /** ISO 8601(Gateway の時刻) */
  readonly recordedAt: string;
}

/** 全件プライベートスコープ扱い(決定5)。Slack 由来の判定は構成全体の規則で先に処理する。 */
const PRIVATE_ORIGIN = { privateScope: true, slackOrigin: false } as const;
const PUBLIC_ORIGIN = { privateScope: false, slackOrigin: false } as const;

/**
 * 引用 docId を監査に記録してよい形にする(決定5)。documentId はコネクタスコープの不透明な
 * ID のため `<sourceId>:<documentId>` で一意にし、docid.ts の redaction を通す。
 * hashed の規則が必要なのに hmacKey がなければ例外(平文へ倒さない。docid.ts と同じ)。
 */
export function citedDocIdsForRun(
  citations: readonly DeclaredCitation[],
  policy: RunSourcePolicy,
  docIdConfig: DocIdAuditConfig,
): string[] {
  if (policy.persistenceForbiddenSourceEnabled) {
    // 段階 1 では出所を検証できないため、Slack の docId が他の sourceId で申告されても
    // 平文で残らないよう全件を記録しない(TM-I5 (g))
    return [];
  }
  const origin = policy.privateScopeSourceEnabled ? PRIVATE_ORIGIN : PUBLIC_ORIGIN;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const citation of citations) {
    if (!policy.isEnabledSource(citation.sourceId)) {
      continue;
    }
    const docId = `${citation.sourceId}:${citation.documentId}`;
    if (seen.has(docId)) {
      continue;
    }
    seen.add(docId);
    const redacted = redactDocIdForAudit(docId, origin, docIdConfig);
    if (redacted !== null) {
      out.push(redacted);
    }
  }
  return out;
}

/** searchedSources を有効なソースに限り、重複を除く(申告の順は保つ)。 */
export function searchedSourcesForRun(
  searchedSources: readonly string[],
  policy: RunSourcePolicy,
): string[] {
  const out: string[] = [];
  for (const sourceId of searchedSources) {
    if (policy.isEnabledSource(sourceId) && !out.includes(sourceId)) {
      out.push(sourceId);
    }
  }
  return out;
}

/** 終了の部分レコード(決定3)。endedAt は Gateway が記録した時刻。 */
export function answerRunFinishRecord(
  envelope: PartialRecordEnvelope,
  declaration: FinishDeclaration,
  policy: RunSourcePolicy,
  docIdConfig: DocIdAuditConfig,
): AuditRecord {
  return {
    recordType: "answer_run_finish",
    recordId: envelope.recordId,
    runId: envelope.runId,
    userId: envelope.userId,
    recordedAt: envelope.recordedAt,
    endedAt: envelope.recordedAt,
    finalOutcome: declaration.outcome,
    // error で終わった run の confidence は意味を持たない
    confidence: declaration.outcome === "error" ? null : declaration.confidence,
    searchedSources: searchedSourcesForRun(declaration.searchedSources, policy),
    citedDocIds: citedDocIdsForRun(declaration.citations, policy, docIdConfig),
    failureReason: declaration.failureReason,
  };
}

/** 利用者フィードバックの部分レコード(決定8)。 */
export function answerRunFeedbackRecord(
  envelope: PartialRecordEnvelope,
  feedback: UserFeedback,
): AuditRecord {
  return {
    recordType: "answer_run_feedback",
    recordId: envelope.recordId,
    runId: envelope.runId,
    userId: envelope.userId,
    recordedAt: envelope.recordedAt,
    userFeedback: feedback,
  };
}
