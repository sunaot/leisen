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
 * - userId は Gateway が認証した利用者(tools/call の結果の `_meta`)に束縛する。
 *   呼び出し元の自己申告は照合にだけ使う(セキュリティレビュー 2026-09-27 H1、
 *   orchestrator.ts)
 * - Slack 由来データ(ADR-014、不変条件7): searchedSources / skippedSources には
 *   deployment.yaml のソースID だけを入れ、Slack 由来のメタデータ(channel・permalink・
 *   ts 等)を入れない。citedDocIds は注入された分類(CitedDocIdAudit)で gateway の
 *   redaction(docid.ts)を通す: Slack は常に記録しない、プライベートスコープは
 *   audit.privateScopeDocIds(hashed / omitted)に従う、分類できないソースは記録しない
 *   (fail-closed。セキュリティレビュー H2、ADR-013 §2)
 */
import {
  digestQuery,
  redactDocIdForAudit,
  validateRecord,
  type Actor,
  type AnswerRunRecord,
  type AuditRecord,
  type AuditSink,
  type ConnectorConfig,
  type DeploymentConfig,
  type DocIdAuditConfig,
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
  docIdAudit: CitedDocIdAudit,
): AnswerRunAuditRecord {
  return {
    ...pending,
    endedAt: input.endedAt,
    finalOutcome: input.outcome,
    // error で終わった run の confidence は意味を持たない
    confidence: input.outcome === "error" ? null : input.confidence,
    searchedSources: [...input.searchedSources],
    citedDocIds: citedDocIdsForAudit(input.citations, docIdAudit),
    failureReason: input.failureReason,
  };
}

/** ソースの分類(citedDocIds の記録方針を決める)。 */
export interface SourceDocIdClass {
  /** DM・プライベートチャンネル・個人スコープ等を含むソースか(ADR-013 §1・§2) */
  readonly privateScope: boolean;
  /** Slack 由来か。true なら設定に関わらず記録しない(ADR-013 §2、ADR-014) */
  readonly slack: boolean;
}

/**
 * sourceId → 分類。分類できないソースは undefined を返す(fail-closed で記録しない)。
 * リファレンス構成・kp-ask では deployment.yaml の connectors[] から組み立てる
 * (kind が slack → slack、privateScopes が excluded 以外 → privateScope)。
 */
export type DocIdClassifier = (sourceId: string) => SourceDocIdClass | undefined;

/**
 * citedDocIds の記録方針(Orchestrator の必須オプション。セキュリティレビュー H2)。
 * privateScopeDocIds / hmacKey は gateway の docid.ts(DocIdAuditConfig)と同じ意味:
 * hashed はデプロイ固有鍵の HMAC で記録し、omitted は記録しない。hmacKey は秘密情報
 * (ログ・シリアライズ禁止、不変条件6)。
 */
export interface CitedDocIdAudit extends Readonly<DocIdAuditConfig> {
  readonly classify: DocIdClassifier;
}

/** 分類できないソースの扱い: プライベートスコープとみなし、omitted で記録しない(fail-closed)。 */
const UNKNOWN_SOURCE_ORIGIN = { privateScope: true, slackOrigin: false } as const;
const UNKNOWN_SOURCE_POLICY: DocIdAuditConfig = { privateScopeDocIds: "omitted" };

/** 分類器の戻り値を検証する(例外・想定外の形は分類できないものとして扱う)。 */
function classifySource(
  classify: DocIdClassifier,
  sourceId: string,
): SourceDocIdClass | undefined {
  let result: unknown;
  try {
    result = classify(sourceId);
  } catch {
    return undefined;
  }
  if (typeof result !== "object" || result === null) {
    return undefined;
  }
  const { privateScope, slack } = result as Partial<SourceDocIdClass>;
  return typeof privateScope === "boolean" && typeof slack === "boolean"
    ? { privateScope, slack }
    : undefined;
}

/**
 * citedDocIds を監査に記録してよい形にする(ADR-013 §2、ADR-017 確認事項5)。
 * documentId はコネクタスコープの不透明な ID のため `<sourceId>:<documentId>` で
 * 一意にし、gateway の redactDocIdForAudit(docid.ts)を通す:
 * - Slack と分類されたソース: 記録しない(常に)
 * - プライベートスコープのソース: hashed なら HMAC(hmac:…)、omitted なら記録しない
 * - それ以外(非プライベート・非 Slack): そのまま記録する
 * - 分類できないソース: 記録しない(プライベートスコープ + omitted とみなす。fail-closed)
 */
export function citedDocIdsForAudit(
  citations: readonly Citation[],
  docIdAudit: CitedDocIdAudit,
): string[] {
  const out: string[] = [];
  for (const citation of citations) {
    const docId = `${citation.sourceId}:${citation.documentId}`;
    const classified = classifySource(docIdAudit.classify, citation.sourceId);
    const redacted =
      classified === undefined
        ? redactDocIdForAudit(docId, UNKNOWN_SOURCE_ORIGIN, UNKNOWN_SOURCE_POLICY)
        : redactDocIdForAudit(
            docId,
            { privateScope: classified.privateScope, slackOrigin: classified.slack },
            {
              privateScopeDocIds: docIdAudit.privateScopeDocIds,
              ...(docIdAudit.hmacKey !== undefined ? { hmacKey: docIdAudit.hmacKey } : {}),
            },
          );
    if (redacted !== null) {
      out.push(redacted);
    }
  }
  return out;
}

/**
 * citedDocIds の記録方針を検証する(Orchestrator の構築時)。hashed には空でない
 * hmacKey が要る(鍵がなければ平文へ倒さず構築を拒否する。docid.ts と同じ fail-closed)。
 * 戻り値は問題の説明(固定文言。鍵の値を含めない)、問題がなければ undefined。
 */
export function citedDocIdAuditProblem(docIdAudit: unknown): string | undefined {
  if (typeof docIdAudit !== "object" || docIdAudit === null) {
    return "docIdAudit (classify / privateScopeDocIds) is required";
  }
  const { classify, privateScopeDocIds, hmacKey } = docIdAudit as Partial<CitedDocIdAudit>;
  if (typeof classify !== "function") {
    return "docIdAudit.classify must be a function";
  }
  if (privateScopeDocIds !== "hashed" && privateScopeDocIds !== "omitted") {
    return "docIdAudit.privateScopeDocIds must be hashed or omitted";
  }
  if (hmacKey !== undefined && (typeof hmacKey !== "string" || hmacKey === "")) {
    return "docIdAudit.hmacKey must be a non-empty string when given";
  }
  if (privateScopeDocIds === "hashed" && hmacKey === undefined) {
    return "docIdAudit.privateScopeDocIds=hashed requires a deployment-specific hmacKey";
  }
  return undefined;
}

/**
 * Slack と分類するコネクタの kind(`slack`、または `slack-` で始まるプラグイン名)。
 * 広めに取るほど記録しない側に倒れる(ADR-013 §2)。kp-ask serve が永続化不可のソース
 * (不変条件7、ADR-014)の有効化を判定するのにも同じ規則を使う(ADR-018 決定5)。
 */
export function isSlackKind(kind: string): boolean {
  return kind === "slack" || kind.startsWith("slack-");
}

/**
 * deployment.yaml の connectors[] から分類器を作る: kind が slack → slack、
 * privateScopes が excluded 以外(consent / included)→ privateScope。
 * connectors[] にないソースは undefined(記録しない)。
 */
export function docIdClassifierFromConnectors(
  connectors: readonly Pick<ConnectorConfig, "id" | "kind" | "privateScopes">[],
): DocIdClassifier {
  const classes = new Map<string, SourceDocIdClass>(
    connectors.map((connector) => [
      connector.id,
      {
        privateScope: connector.privateScopes !== "excluded",
        slack: isSlackKind(connector.kind),
      },
    ]),
  );
  return (sourceId) => classes.get(sourceId);
}

/**
 * deployment.yaml から citedDocIds の記録方針を組み立てる(kp-ask の --config、
 * リファレンス構成)。audit.privateScopeDocIds に従い、hashed には hmacKey が要る
 * (Orchestrator の構築時に検証する)。
 */
export function docIdAuditFromDeployment(
  config: Pick<DeploymentConfig, "connectors" | "audit">,
  hmacKey: string | undefined,
): CitedDocIdAudit {
  return {
    classify: docIdClassifierFromConnectors(config.connectors),
    privateScopeDocIds: config.audit.privateScopeDocIds,
    ...(hmacKey !== undefined && hmacKey !== "" ? { hmacKey } : {}),
  };
}

/** 分類器を持たない構成の記録方針: どのソースの docId も記録しない(kp-ask の既定)。 */
export const OMIT_ALL_DOC_IDS: CitedDocIdAudit = {
  classify: () => undefined,
  privateScopeDocIds: "omitted",
};

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
