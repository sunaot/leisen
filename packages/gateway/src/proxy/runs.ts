/**
 * run API(ADR-019 決定3、T-023 段階 1)— Gateway の MCP とは別の HTTP + JSON の面。
 *
 * | 呼び出し | すること | 監査ストアに追記するもの |
 * |---|---|---|
 * | `POST /runs` `{ question, executionClass?, actor? }` | 本人を認証し、申告を ADR-015 の規則で検証し、署名付き runId を発行する | 生クエリ表に質問原文(決定7)→ pending の AnswerRun |
 * | `POST /runs/{runId}/finish` `{ outcome, confidence?, citations?, searchedSources?, failureReason?, actor? }` | runId を検証し、searchedSources を有効なソースに限り、引用 docId に決定5 の規則をかける | `answer_run_finish` |
 * | `POST /runs/{runId}/feedback` `{ outcome, actor? }` | runId の本人とフィードバックの期間を検証する | `answer_run_feedback` |
 *
 * - 認証は二重: 利用者本人の Bearer(HTTP 層が `/mcp` と同じく IdP Adapter で検証)に加えて、
 *   呼び出し元が Orchestrator であることの資格情報(デプロイ固有の共有秘密。専用ヘッダ
 *   ORCHESTRATOR_CREDENTIAL_HEADER)を求め、定数時間で比較する。名前空間付きのキーで runId を
 *   申告する `/mcp` の tools/call にも同じ資格情報を求める(gateway.ts)
 * - 記録は追記だけで、前の状態を読まない(Gateway はステートレスのまま)。finish / feedback は
 *   部分レコードで、昇格判定レポートが runId ごとに統合する
 * - 上限: 本文の大きさ(HTTP 層)・質問の長さ・引用とソースの件数(run/request.ts)・利用者ごとの
 *   頻度(3 経路の合計)。満たさないものは固定文言で拒否する
 * - 書き込み失敗は ADR-011 §4 の設定(audit.failureMode)に従う(決定6)。既定の fail-closed では
 *   `POST /runs` は runId を返さず、finish / feedback は失敗を返す
 * - 拒否の応答に申告値(runId・質問・本文)をエコーしない。runId の拒否は理由を区別せず
 *   同じ分類(invalid_run_id)にする(他人の runId の存在を確定させない)
 *
 * ソースの知識(有効なソース、Slack・プライベートスコープの有無)は run モジュールに入れず、
 * ここ(組み立て役)が deployment.yaml から判定の関数を作って注入する(決定10)。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import {
  type AuditLogger,
  type DocIdAuditConfig,
  type RawQueryStore,
} from "@kp/audit";
import { isSlackKind, type DeploymentConfig } from "../config/schema.js";
import type { Identity } from "../idp/types.js";
import {
  answerRunFeedbackRecord,
  answerRunFinishRecord,
  feedbackRunRequestSchema,
  finishRunRequestSchema,
  issueRunId,
  parseRunRequest,
  pendingAnswerRunRecord,
  recordsRawQuestion,
  startRunRequestSchema,
  verifyRunId,
  type RunIdKeyRing,
  type RunRequestLimits,
  type RunSourcePolicy,
  type RunSubject,
} from "../run/index.js";
import { PerKeyRateLimiter } from "./ratelimit.js";
import { parseActor, validateDeclaration } from "./session.js";
import {
  EXECUTION_CLASS_CONFIG_KEY,
  GatewayError,
  type GatewayErrorClass,
} from "./types.js";

/** Orchestrator の資格情報(共有秘密)を送るヘッダ(小文字。node:http はヘッダ名を小文字にする)。 */
export const ORCHESTRATOR_CREDENTIAL_HEADER = "x-kp-orchestrator-credential";

/** Orchestrator の資格情報の最小長(文字)。 */
export const MIN_ORCHESTRATOR_CREDENTIAL_CHARS = 16;

/** run API の実行時の構成(秘密を含む。ログ・エラー・設定の出力に出さない。不変条件6)。 */
export interface RunRuntime {
  readonly keys: RunIdKeyRing;
  /** 呼び出し元が Orchestrator であることの資格情報(UTF-8 のバイト列) */
  readonly orchestratorCredential: Uint8Array;
  /** runId の有効期間(秒) */
  readonly ttlSeconds: number;
  /** 発行時刻からフィードバックを受ける期間(秒) */
  readonly feedbackWindowSeconds: number;
  readonly limits: RunRequestLimits;
  /** リクエスト本文の上限(バイト)。HTTP 層が使う */
  readonly maxBodyBytes: number;
  /** 利用者ごとの頻度上限(3 経路の合計、リクエスト/分) */
  readonly maxRequestsPerUserPerMinute: number;
}

/** deployment.yaml の connectors[] からソースの判定を作る(決定10)。 */
export function runSourcePolicyFromConfig(
  config: Pick<DeploymentConfig, "connectors">,
): RunSourcePolicy {
  const enabled = config.connectors.filter((c) => c.enabled);
  const ids = new Set(enabled.map((c) => c.id));
  return {
    isEnabledSource: (sourceId) => ids.has(sourceId),
    persistenceForbiddenSourceEnabled: enabled.some((c) => isSlackKind(c.kind)),
    privateScopeSourceEnabled: enabled.some((c) => c.privateScopes !== "excluded"),
  };
}

/** run API の応答(HTTP 層が書き出す)。 */
export interface RunApiResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** 拒否の固定文言(申告値をエコーしない)。 */
const RUN_REJECTION_MESSAGES: Partial<Record<GatewayErrorClass, string>> = {
  invalid_run_id:
    "the runId was not accepted (unknown, expired, or not issued for this user and actor; ADR-019)",
  orchestrator_credential_invalid: "a valid orchestrator credential is required",
  execution_class_rejected: "the declared execution class is not allowed by this deployment (ADR-015)",
  rate_limited: "too many run API requests for this user",
  audit_write_failed: "audit record could not be persisted; request rejected (fail-closed, ADR-011)",
  invalid_request: "invalid run request",
};

function rejection(
  status: number,
  errorClass: GatewayErrorClass,
  message: string = RUN_REJECTION_MESSAGES[errorClass] ?? "request rejected",
  headers?: Readonly<Record<string, string>>,
): RunApiResponse {
  return {
    status,
    body: { error: { errorClass, message } },
    ...(headers !== undefined ? { headers } : {}),
  };
}

/** 書き込み失敗の扱い(決定6)。fail-closed なら拒否、fail-open なら続行。 */
type WriteOutcome = { readonly ok: true } | { readonly ok: false; readonly response: RunApiResponse };

export interface RunApiDeps {
  readonly config: DeploymentConfig;
  readonly runtime: RunRuntime;
  readonly auditLogger: AuditLogger;
  /** 生クエリ原文の短期保持テーブル。省略時は原文を記録しない(digest だけ残る) */
  readonly rawQueryStore?: RawQueryStore | undefined;
  /** 引用 docId の不可逆化の設定(hashed には hmacKey が要る) */
  readonly docIdConfig: DocIdAuditConfig;
  readonly now?: () => number;
  readonly ids?: () => string;
}

export class RunApi {
  private readonly config: DeploymentConfig;
  private readonly runtime: RunRuntime;
  private readonly auditLogger: AuditLogger;
  private readonly rawQueryStore: RawQueryStore | undefined;
  private readonly docIdConfig: DocIdAuditConfig;
  private readonly policy: RunSourcePolicy;
  private readonly now: () => number;
  private readonly ids: () => string;
  private readonly rateLimiter: PerKeyRateLimiter;
  /** 資格情報の比較は長さを漏らさないよう SHA-256 のダイジェストどうしで行う */
  private readonly credentialDigest: Buffer;

  constructor(deps: RunApiDeps) {
    this.config = deps.config;
    this.runtime = deps.runtime;
    this.auditLogger = deps.auditLogger;
    this.rawQueryStore = deps.rawQueryStore;
    this.docIdConfig = deps.docIdConfig;
    this.policy = runSourcePolicyFromConfig(deps.config);
    this.now = deps.now ?? Date.now;
    this.ids = deps.ids ?? (() => crypto.randomUUID());
    this.rateLimiter = new PerKeyRateLimiter(deps.runtime.maxRequestsPerUserPerMinute, this.now);
    this.credentialDigest = createHash("sha256").update(deps.runtime.orchestratorCredential).digest();
  }

  /** リクエスト本文の上限(バイト)。HTTP 層が本文を読む前に使う。 */
  get maxBodyBytes(): number {
    return this.runtime.maxBodyBytes;
  }

  /** 呼び出し元が Orchestrator の資格情報を提示したか(定数時間比較)。 */
  verifyOrchestratorCredential(presented: string | string[] | undefined): boolean {
    if (typeof presented !== "string" || presented === "") {
      return false;
    }
    const digest = createHash("sha256").update(presented, "utf8").digest();
    return timingSafeEqual(digest, this.credentialDigest);
  }

  /**
   * tools/call で名前空間付きのキーで申告された runId を受理するか(ADR-019 決定4)。
   * 本人・actor・期限と署名を満たすものだけ。拒否の理由は返さない(呼び出し側は固定文言)。
   */
  acceptsDeclaredRunId(runId: unknown, subject: RunSubject): boolean {
    return verifyRunId(this.runtime.keys, {
      runId,
      subject,
      purpose: "call",
      nowMs: this.now(),
    }).ok;
  }

  private rateLimit(identity: Identity): RunApiResponse | undefined {
    const decision = this.rateLimiter.tryAcquire(identity.userId);
    if (decision.allowed) {
      return undefined;
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((decision.retryAfterMs ?? 0) / 1000));
    return rejection(429, "rate_limited", undefined, { "retry-after": String(retryAfterSeconds) });
  }

  private async write(task: () => Promise<void>): Promise<WriteOutcome> {
    try {
      await task();
      return { ok: true };
    } catch {
      // 元例外のメッセージは載せない(シンク由来の生エラーがレコード内容や接続情報を
      // 含みうるため。TM-A2)。fail-open は起動時に確認フラグを検証済み
      if (this.config.audit.failureMode === "fail-closed") {
        return { ok: false, response: rejection(503, "audit_write_failed") };
      }
      return { ok: true };
    }
  }

  /** `POST /runs`: runId を発行し、生クエリ表 → pending の AnswerRun の順に書く。 */
  async start(
    identity: Identity,
    orchestratorVerified: boolean,
    body: unknown,
  ): Promise<RunApiResponse> {
    if (!orchestratorVerified) {
      return rejection(403, "orchestrator_credential_invalid");
    }
    const limited = this.rateLimit(identity);
    if (limited) {
      return limited;
    }
    const parsed = parseRunRequest(startRunRequestSchema(this.runtime.limits), body);
    if (!parsed.ok) {
      return rejection(400, "invalid_request", parsed.message);
    }
    let declared;
    try {
      // 実行区分・actor は ADR-015 の規則で検証する(不正値は既定に丸めず拒否)
      declared = validateDeclaration({
        ...(parsed.value.executionClass !== undefined
          ? { executionClass: parsed.value.executionClass as never }
          : {}),
        ...(parsed.value.actor !== undefined ? { actor: parseActor(parsed.value.actor) } : {}),
      });
    } catch (error) {
      return rejection(
        400,
        "invalid_request",
        error instanceof GatewayError ? error.message : undefined,
      );
    }
    if (!this.config.agentExecution[EXECUTION_CLASS_CONFIG_KEY[declared.executionClass]].enabled) {
      return rejection(403, "execution_class_rejected");
    }

    const nowMs = this.now();
    const subject: RunSubject = { userId: identity.userId, actor: declared.actor };
    const issued = issueRunId(this.runtime.keys, {
      subject,
      ttlSeconds: this.runtime.ttlSeconds,
      nowMs,
    });
    const startedAt = new Date(nowMs).toISOString();
    const pending = pendingAnswerRunRecord({
      runId: issued.runId,
      userId: identity.userId,
      actor: declared.actor,
      startedAt,
      question: parsed.value.question,
    });

    // 生クエリ表 → pending の順(決定6)。永続化不可のソースが有効な構成では原文を書かない(決定7)
    if (this.rawQueryStore !== undefined && recordsRawQuestion(this.policy)) {
      const store = this.rawQueryStore;
      const digest = pending.recordType === "answer_run" ? pending.finalQueryDigest : null;
      const wrote = await this.write(() =>
        store.append({
          queryDigest: digest ?? "",
          rawQuery: parsed.value.question,
          userId: identity.userId,
          timestamp: startedAt,
        }),
      );
      if (!wrote.ok) {
        return wrote.response;
      }
    }
    const wrote = await this.write(() => this.auditLogger.log(pending));
    if (!wrote.ok) {
      return wrote.response;
    }
    return {
      status: 201,
      body: {
        runId: issued.runId,
        expiresAt: new Date(issued.expiresAt * 1000).toISOString(),
        feedbackUntil: new Date((issued.issuedAt + this.runtime.feedbackWindowSeconds) * 1000).toISOString(),
      },
    };
  }

  /** runId を検証する(finish / feedback 共通)。拒否は理由を区別しない。 */
  private verify(
    runId: string,
    identity: Identity,
    actorDeclaration: unknown,
    purpose: "finish" | "feedback",
  ): { readonly ok: true } | { readonly ok: false; readonly response: RunApiResponse } {
    let actor;
    try {
      actor = parseActor(actorDeclaration ?? { kind: "human" });
    } catch {
      return { ok: false, response: rejection(400, "invalid_request", "invalid actor declaration") };
    }
    const result = verifyRunId(this.runtime.keys, {
      runId,
      subject: { userId: identity.userId, actor },
      purpose,
      nowMs: this.now(),
      feedbackWindowSeconds: this.runtime.feedbackWindowSeconds,
    });
    return result.ok ? { ok: true } : { ok: false, response: rejection(403, "invalid_run_id") };
  }

  /** `POST /runs/{runId}/finish`: 終了の部分レコードを書く。 */
  async finish(
    identity: Identity,
    orchestratorVerified: boolean,
    runId: string,
    body: unknown,
  ): Promise<RunApiResponse> {
    if (!orchestratorVerified) {
      return rejection(403, "orchestrator_credential_invalid");
    }
    const limited = this.rateLimit(identity);
    if (limited) {
      return limited;
    }
    const parsed = parseRunRequest(finishRunRequestSchema(this.runtime.limits), body);
    if (!parsed.ok) {
      return rejection(400, "invalid_request", parsed.message);
    }
    const verified = this.verify(runId, identity, parsed.value.actor, "finish");
    if (!verified.ok) {
      return verified.response;
    }
    let record;
    try {
      record = answerRunFinishRecord(
        {
          recordId: this.ids(),
          runId,
          userId: identity.userId,
          recordedAt: new Date(this.now()).toISOString(),
        },
        {
          outcome: parsed.value.outcome,
          confidence: parsed.value.confidence,
          searchedSources: parsed.value.searchedSources,
          citations: parsed.value.citations,
          failureReason: parsed.value.failureReason,
        },
        this.policy,
        this.docIdConfig,
      );
    } catch {
      // hashed の鍵欠落など(起動時に検証するため通常は到達しない)。平文に倒さない
      return rejection(503, "audit_write_failed");
    }
    const wrote = await this.write(() => this.auditLogger.log(record));
    return wrote.ok ? { status: 200, body: { recorded: true } } : wrote.response;
  }

  /** `POST /runs/{runId}/feedback`: 利用者フィードバックの部分レコードを書く。 */
  async feedback(
    identity: Identity,
    orchestratorVerified: boolean,
    runId: string,
    body: unknown,
  ): Promise<RunApiResponse> {
    if (!orchestratorVerified) {
      return rejection(403, "orchestrator_credential_invalid");
    }
    const limited = this.rateLimit(identity);
    if (limited) {
      return limited;
    }
    const parsed = parseRunRequest(feedbackRunRequestSchema(), body);
    if (!parsed.ok) {
      return rejection(400, "invalid_request", parsed.message);
    }
    const verified = this.verify(runId, identity, parsed.value.actor, "feedback");
    if (!verified.ok) {
      return verified.response;
    }
    const record = answerRunFeedbackRecord(
      {
        recordId: this.ids(),
        runId,
        userId: identity.userId,
        recordedAt: new Date(this.now()).toISOString(),
      },
      parsed.value.outcome,
    );
    const wrote = await this.write(() => this.auditLogger.log(record));
    return wrote.ok ? { status: 200, body: { recorded: true } } : wrote.response;
  }
}
