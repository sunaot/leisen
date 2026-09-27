/**
 * 探索ループ(T-007、product-design §4.3、ADR-017)。
 *
 * 1 run の流れ:
 *   runId を採番(Gateway と同じ形式を検証)→ tools/list → 全ソースに describe
 *   (未接続は skippedSources へ)→ describe の結果の `_meta` から Gateway が認証した
 *   userId を得て、AnswerRun(pending)を書く → system prompt(固定部だけ)と最初の
 *   user ターン(ソース一覧・上限・質問)とツール定義を組む → LLM ↔ Gateway のツール
 *   呼び出しを反復 → submit_answer で提出された回答の出典を検証 → 回答本文を無害化
 *   (URL を残さない)→ AnswerRun(最終状態)を書く → Answer を返す
 *
 * 利用者の束縛(セキュリティレビュー 2026-09-27 H1): AnswerRun.userId は呼び出し元の
 * 申告ではなく、Gateway がそのリクエストで認証した userId(tools/call の結果の `_meta`)
 * にする。呼び出し元が userId を申告していて一致しなければ fail-closed(run を error、
 * failureReason: user_mismatch、以降 Gateway を呼ばない)。describe フェーズで Gateway が
 * 利用者を確認できない(HTTP の認証失敗・到達不能・報告なし)場合は AnswerRun を書かずに
 * error で終える(確認できない主体で監査レコードを書かない)。run の途中で別の userId が
 * 報告された場合も user_mismatch で止める。
 *
 * 監査の束ね(ADR-011 追記、ADR-001 追補3): runId はここで採番し、Gateway への
 * 全 tools/call の `_meta` に prefix 付きキーで runId / iteration / 実行区分
 * (human_in_the_loop)/ actor(human)を申告する(`_meta` の組み立ては
 * gateway/meta.ts の buildGatewayMeta に集約)。iteration はツール呼び出しごとに
 * 0 から単調増加(describe を含む。同一ターン内の並列呼び出しは応答内の順に採番)。
 * Gateway に送らなかった呼び出し(未接続ソース宛て・上限超過等)は番号を消費しない。
 *
 * 終了条件:
 * - submit_answer が呼ばれた(同じターンの他のツール呼び出しは実行しない)
 * - submit_answer を呼ばずにターンを終えた: 1回だけ催促し、それでも提出しなければ unresolved
 * - 上限(maxIterations / runTimeoutMs / costLimitPerQuery)に達した: 探索を止め、
 *   その時点の情報で submit_answer を促す最終ターンを1回だけ行う。ツール呼び出しの
 *   件数の上限(maxToolCallsPerTurn / maxToolCallsPerRun)を超えた分は実行せず、
 *   is_error の tool_result で返す
 * - LLM・Gateway の失敗: error
 *
 * 出典の検証(受け入れ条件2): citations は run 内で search ヒット / fetch 結果として
 * 受け取った文書に限る。検証済みの出典が0件なら unresolved にし、回答の先頭に
 * 注意を付け、confidence を 0.3 以下に丸める。回答本文からは URL をすべて除去し、
 * 原典へのリンクは citations[].url だけが運ぶ(sanitize.ts、M1。RS-4 / TM-D2)。
 */
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { isValidRunId, type AuditLogger } from "@kp/gateway";
import {
  answerSchema,
  SUBMIT_ANSWER_TOOL_NAME,
  submitAnswerInputSchema,
  type Answer,
  type AnswerOutcome,
  type Citation,
  type SkippedSource,
  type SubmitAnswerInput,
} from "./answer.js";
import {
  citedDocIdAuditProblem,
  finishedAnswerRun,
  pendingAnswerRun,
  type AnswerRunAuditRecord,
  type CitedDocIdAudit,
} from "./audit.js";
import { EvidenceLedger, verifyCitations } from "./citations.js";
import {
  MAX_QUESTION_CHARS,
  orchestratorSettingsSchema,
  type OrchestratorSettings,
  type OrchestratorSettingsInput,
} from "./config.js";
import { UsageMeter } from "./cost.js";
import {
  GatewayClientError,
  LlmError,
  OrchestratorError,
  type GatewayClientErrorClass,
} from "./errors.js";
import { buildGatewayMeta } from "./gateway/meta.js";
import type {
  GatewayClient,
  GatewayToolError,
  GatewayToolSchema,
} from "./gateway/types.js";
import { attemptsOf, type LlmClient, type LlmTurn } from "./llm/types.js";
import {
  buildFirstUserContent,
  buildSystemPrompt,
  finalTurnInstruction,
  loadExplorePrompt,
  NUDGE_MESSAGE,
  sourceBriefFromDescribe,
  TOOL_ERROR_PREFACE,
  TOOL_RESULT_PREFACE,
  type LimitReason,
  type SourceBrief,
} from "./prompt.js";
import { sanitizeAnswerText } from "./sanitize.js";
import {
  buildClaudeTools,
  isGatewayToolName,
  sourcesFromTools,
  type GatewayToolName,
} from "./tools.js";

/** 検証済みの出典がない回答の先頭に付ける注意。 */
export const NO_CITATION_NOTICE =
  "【注意】出典を確認できませんでした。この回答は検索結果の文書で裏付けられていません。";
/** 検証済みの出典がない回答の confidence の上限。 */
export const CONFIDENCE_CAP_WITHOUT_CITATIONS = 0.3;

const NOT_SUBMITTED_TEXT =
  "回答が提出されませんでした。探索した範囲では、根拠となる文書を確認できていません。";
const NO_SOURCES_TEXT = "検索できるソースがないため、検索していません。";
const TIMEOUT_BEFORE_SEARCH_TEXT =
  "探索の時間上限に達したため、検索を始められませんでした。";

/** 失敗の分類ごとの回答文(既定は FAILURE_TEXT_DEFAULT)。 */
const FAILURE_TEXTS: Readonly<Record<string, string>> = {
  user_mismatch:
    "利用者を確認できなかったため、回答していません(user_mismatch)。",
  gateway_unauthenticated:
    "Gateway が利用者の認証を拒否したため、回答していません(gateway_unauthenticated)。サインインし直してから再度お試しください。",
};

/**
 * 文書単位で「使えない」ことを表す分類。permission_denied と not_found は区別せず
 * 同じ分類・固定文言で LLM に渡す(存在推定を増幅しない、TM-B2。Gateway も
 * `not_available` に正規化する。監査ログの errorClass は Gateway が区別を保つ)。
 */
const UNAVAILABLE_CLASSES: ReadonlySet<string> = new Set([
  "permission_denied",
  "not_found",
  "not_available",
]);
const UNAVAILABLE_ERROR: ToolErrorForLlm = {
  errorClass: "not_available",
  message: "この対象は利用できません。",
};

/** LLM に渡すツールエラーの message の上限(コネクタ由来の文言を長く流さない)。 */
const MAX_TOOL_ERROR_MESSAGE_CHARS = 500;

const TRANSPORT_ERROR_MESSAGES: Readonly<Record<GatewayClientErrorClass, string>> = {
  unauthenticated: "Gateway が利用者の認証を拒否しました。",
  gateway_unavailable: "Gateway に接続できませんでした。",
  gateway_timeout: "Gateway の応答がタイムアウトしました。",
  gateway_protocol_error: "Gateway の応答を解釈できませんでした。",
  gateway_rejected: "Gateway が要求を拒否しました。",
  aborted: "探索の時間上限に達したため中断しました。",
};

/** ツール呼び出しの件数の上限(m1)を超えた呼び出しに返すエラー(固定文言)。 */
const TURN_TOOL_CALL_LIMIT_ERROR: ToolErrorForLlm = {
  errorClass: "tool_call_limit_reached",
  message:
    "1ターンで実行できるツール呼び出しの上限を超えたため、この呼び出しは実行していません。",
};
const RUN_TOOL_CALL_LIMIT_ERROR: ToolErrorForLlm = {
  errorClass: "tool_call_limit_reached",
  message:
    "この質問で実行できるツール呼び出しの上限に達したため、この呼び出しは実行していません。",
};
/** run の途中で Gateway が別の利用者を報告した呼び出しに返すエラー(H1)。 */
const USER_MISMATCH_ERROR: ToolErrorForLlm = {
  errorClass: "user_mismatch",
  message: "利用者を確認できなかったため、探索を中止します。",
};

export type UserFeedback = "resolved" | "unresolved";

export interface OrchestratorOptions {
  readonly llm: LlmClient;
  /**
   * AnswerRun の書き込み先。リファレンス構成では Gateway と同じ監査ストアを共有する
   * (ToolInvocation と runId で束ねる。ADR-017 決定2)
   */
  readonly auditLogger: AuditLogger;
  /**
   * citedDocIds の記録方針(必須。セキュリティレビュー H2、ADR-013 §2、ADR-017
   * 確認事項5)。ソースの分類(Slack / プライベートスコープ)と audit.privateScopeDocIds、
   * hashed のときのデプロイ固有鍵。分類できないソースの docId は記録しない
   */
  readonly docIdAudit: CitedDocIdAudit;
  readonly settings?: OrchestratorSettingsInput;
  /** system prompt 固定部の差し替え(評価用)。省略時は prompts/explore.v2.md */
  readonly systemPrompt?: string;
  /** テスト用の時計・ID 注入(ID は Gateway の runId の形式 [A-Za-z0-9._:-]{1,128}) */
  readonly now?: () => number;
  readonly ids?: () => string;
  /** recordFeedback のために最終状態を覚えておく run 数(古いものから捨てる) */
  readonly feedbackWindow?: number;
}

export interface RunInput {
  readonly question: string;
  /**
   * 呼び出し元(利用者を認証したチャットUIのバックエンド等)が申告する質問者の userId
   * (任意)。AnswerRun の主体は Gateway が認証した userId に束縛し、申告は照合にだけ
   * 使う: 一致しなければ run を error(failureReason: user_mismatch)で終える(H1)
   */
  readonly userId?: string;
  /** 利用者本人のセッションで Gateway に接続するクライアント */
  readonly gateway: GatewayClient;
}

/** run の内部結果(Answer に組み立てる前)。 */
interface RunOutcome {
  readonly outcome: AnswerOutcome;
  readonly answerText: string;
  readonly citations: Citation[];
  readonly confidence: number;
  /** 正規化コード(lower snake_case)。resolved なら null */
  readonly failureReason: string | null;
}

interface ToolErrorForLlm {
  readonly errorClass: string;
  readonly message: string;
}

type Dispatched =
  | {
      readonly kind: "ok";
      readonly result: unknown;
      readonly userId: string | undefined;
    }
  | {
      readonly kind: "tool_error";
      readonly error: GatewayToolError;
      readonly userId: string | undefined;
    }
  | { readonly kind: "transport_error"; readonly errorClass: GatewayClientErrorClass };

type LlmCall =
  | { readonly kind: "ok"; readonly turn: LlmTurn }
  | { readonly kind: "aborted" }
  | { readonly kind: "error"; readonly errorClass: string };

type TurnAction =
  | {
      readonly kind: "submit";
      readonly input: SubmitAnswerInput;
      /** 同じターンで要求された他のツール呼び出し(実行しない)の数 */
      readonly ignoredCalls: number;
    }
  | { readonly kind: "invalid_submit" }
  | { readonly kind: "tools"; readonly calls: Anthropic.ToolUseBlock[] }
  | { readonly kind: "none" };

type PlannedCall =
  | {
      readonly ok: true;
      readonly tool: GatewayToolName;
      readonly source: string;
      readonly args: Readonly<Record<string, unknown>>;
    }
  | { readonly ok: false; readonly error: ToolErrorForLlm };

/**
 * describe フェーズの結果。bound: Gateway が認証した userId が1つに定まった /
 * unbound: 定まらなかった(AnswerRun を書かずに error で終える)。
 */
type Discovery =
  | {
      readonly kind: "bound";
      readonly userId: string;
      readonly gatewayTools: readonly GatewayToolSchema[];
      readonly briefs: readonly SourceBrief[];
    }
  | { readonly kind: "unbound"; readonly reason: string };

/** 1 run の会話(追記のみ。履歴を編集しない — preserved thinking / キャッシュのため)。 */
interface Conversation {
  readonly gateway: GatewayClient;
  /** Gateway が認証した userId(以降の結果の `_meta` と照合する) */
  readonly userId: string;
  readonly system: readonly Anthropic.TextBlockParam[];
  readonly tools: readonly Anthropic.Tool[];
  readonly messages: Anthropic.MessageParam[];
  readonly activeSources: ReadonlySet<string>;
}

/** 1 run の可変状態。 */
class RunState {
  readonly ledger = new EvidenceLedger();
  readonly meter: UsageMeter;
  readonly warnings: string[] = [];
  readonly skipped = new Map<string, SkippedSource>();
  readonly searched = new Set<string>();
  /** tools/list が返したソース(deployment.yaml の順) */
  allSources: readonly string[] = [];
  /** Gateway へ送ったツール呼び出しの数(describe を含む) */
  toolCalls = 0;
  /** LLM が要求して Gateway へ送ったツール呼び出しの数(maxToolCallsPerRun の対象) */
  llmToolCalls = 0;
  /** 件数の上限で実行しなかった呼び出しの数(1ターンの上限 / run の上限) */
  turnLimitSkipped = 0;
  runLimitSkipped = 0;
  /** run を続けられない失敗(Gateway の認証拒否・利用者の不一致など)の正規化コード */
  fatal: string | undefined;
  #iteration = 0;

  constructor(
    readonly runId: string,
    pricing: OrchestratorSettings["pricing"],
  ) {
    this.meter = new UsageMeter(pricing);
  }

  nextIteration(): number {
    const iteration = this.#iteration;
    this.#iteration += 1;
    return iteration;
  }

  warn(message: string): void {
    if (!this.warnings.includes(message)) {
      this.warnings.push(message);
    }
  }

  skip(sourceId: string): void {
    if (!this.skipped.has(sourceId)) {
      this.skipped.set(sourceId, { sourceId, reason: "source_not_connected" });
    }
  }
}

export class Orchestrator {
  readonly settings: OrchestratorSettings;
  readonly #llm: LlmClient;
  readonly #auditLogger: AuditLogger;
  /** hmacKey(秘密情報)を含むため ES の private に持つ(JSON 化・inspect に出さない) */
  readonly #docIdAudit: CitedDocIdAudit;
  readonly #systemPrompt: string | undefined;
  readonly #now: () => number;
  readonly #ids: () => string;
  readonly #feedbackWindow: number;
  readonly #finished = new Map<string, AnswerRunAuditRecord>();

  constructor(options: OrchestratorOptions) {
    this.settings = orchestratorSettingsSchema.parse(options.settings ?? {});
    const problem = citedDocIdAuditProblem(options.docIdAudit);
    if (problem !== undefined) {
      // 鍵の値はメッセージに含めない(citedDocIdAuditProblem は固定文言)
      throw new OrchestratorError("invalid_configuration", problem);
    }
    const { classify, privateScopeDocIds, hmacKey } = options.docIdAudit;
    this.#docIdAudit = {
      classify,
      privateScopeDocIds,
      ...(hmacKey !== undefined ? { hmacKey } : {}),
    };
    this.#llm = options.llm;
    this.#auditLogger = options.auditLogger;
    this.#systemPrompt = options.systemPrompt;
    this.#now = options.now ?? Date.now;
    this.#ids = options.ids ?? randomUUID;
    this.#feedbackWindow = options.feedbackWindow ?? 1_000;
  }

  /**
   * 1つの質問について探索し、回答を返す。LLM・Gateway の失敗は outcome: "error" の
   * Answer で返す。describe フェーズで Gateway が利用者を確認できなかった場合も error の
   * Answer を返すが、AnswerRun は書かない(recordFeedback の対象にもならない)。
   * AnswerRun を監査ストアへ書けない場合は OrchestratorError("audit_write_failed")で
   * 失敗させる(fail-closed、ADR-011 §4)。
   */
  async run(input: RunInput): Promise<Answer> {
    const question = input.question.trim();
    if (question === "" || question.length > MAX_QUESTION_CHARS) {
      throw new OrchestratorError(
        "invalid_input",
        `question must be 1..${MAX_QUESTION_CHARS} characters`,
      );
    }
    const declaredUserId = input.userId;
    if (declaredUserId !== undefined && declaredUserId.trim() === "") {
      throw new OrchestratorError("invalid_input", "userId must not be empty when given");
    }
    const fixedPrompt = this.#systemPrompt ?? (await loadExplorePrompt());
    const runId = this.#ids();
    if (!isValidRunId(runId)) {
      // Gateway は形式外の runId を未申告として別 run に記録する(監査の束ねが黙って
      // 壊れる)。ids の注入のずれを Gateway にアクセスする前に止める(m5)
      throw new OrchestratorError(
        "invalid_configuration",
        "the generated runId must match [A-Za-z0-9._:-]{1,128}",
      );
    }
    const startedMs = this.#now();
    const state = new RunState(runId, this.settings.pricing);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.settings.runTimeoutMs);
    timer.unref();
    let pending: AnswerRunAuditRecord | undefined;
    let closed = false;
    try {
      const discovery = await this.#discover(input.gateway, state, deadline.signal);
      if (discovery.kind === "unbound") {
        // 確認できない主体で AnswerRun を書かない(H1)。回答は error で返す
        return this.#assemble(failure(discovery.reason), state);
      }
      pending = pendingAnswerRun({
        runId,
        userId: discovery.userId,
        startedAt: new Date(startedMs).toISOString(),
        question,
      });
      // 開始を記録できなければ LLM を呼ばず、以降 Gateway にもアクセスしない(fail-closed)
      await this.#writeAudit(pending);

      const result =
        declaredUserId !== undefined && declaredUserId !== discovery.userId
          ? failure("user_mismatch")
          : await this.#explore(
              {
                question,
                gateway: input.gateway,
                fixedPrompt,
                startedMs,
                discovery,
              },
              state,
              deadline.signal,
            );
      const answer = this.#assemble(result, state);
      const finished = finishedAnswerRun(
        pending,
        {
          endedAt: new Date(this.#now()).toISOString(),
          outcome: answer.outcome,
          confidence: answer.confidence,
          searchedSources: answer.searchedSources,
          citations: answer.citations,
          failureReason: result.failureReason,
        },
        this.#docIdAudit,
      );
      await this.#writeAudit(finished);
      closed = true;
      this.#remember(finished);
      return answer;
    } catch (error) {
      if (pending !== undefined && !closed) {
        // 想定外の失敗(実装の不具合・監査の書き込み失敗)。AnswerRun を pending の
        // まま残さないよう error で閉じてから元の例外を投げ直す(m6)
        await this.#closeWithError(
          pending,
          state,
          error instanceof OrchestratorError ? error.errorClass : "internal_error",
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 利用者フィードバック(解決した / しない)で AnswerRun の userFeedback を更新し、
   * 同じ runId で再書き込みする(受け入れ条件3)。options.userId(必須)が run の
   * 利用者(Gateway が認証した userId)と一致しないフィードバックは拒否する(他人の
   * run への書き込みで集計を汚させない。セキュリティレビュー m4)。
   */
  async recordFeedback(
    runId: string,
    feedback: UserFeedback,
    options: { readonly userId: string },
  ): Promise<void> {
    if (feedback !== "resolved" && feedback !== "unresolved") {
      throw new OrchestratorError("invalid_input", "feedback must be resolved or unresolved");
    }
    const userId: unknown = options?.userId;
    if (typeof userId !== "string" || userId.trim() === "") {
      throw new OrchestratorError(
        "invalid_input",
        "userId of the user giving the feedback is required",
      );
    }
    const record = this.#finished.get(runId);
    if (record === undefined) {
      throw new OrchestratorError(
        "run_not_found",
        "the run is unknown, unfinished, or no longer kept for feedback",
      );
    }
    if (userId !== record.userId) {
      throw new OrchestratorError(
        "feedback_forbidden",
        "feedback must come from the user who asked the question",
      );
    }
    const updated: AnswerRunAuditRecord = { ...record, userFeedback: feedback };
    await this.#writeAudit(updated);
    this.#finished.set(runId, updated);
  }

  // -------------------------------------------------------------------------
  // describe フェーズと利用者の束縛
  // -------------------------------------------------------------------------

  /**
   * tools/list と全ソースへの describe を行い、結果の `_meta` から Gateway が認証した
   * userId を1つに定める(H1)。HTTP の認証失敗・到達不能・報告なし・食い違いは unbound。
   */
  async #discover(
    gateway: GatewayClient,
    state: RunState,
    signal: AbortSignal,
  ): Promise<Discovery> {
    let gatewayTools: readonly GatewayToolSchema[];
    try {
      gatewayTools = await gateway.listTools({ signal });
    } catch (error) {
      if (signal.aborted) {
        return { kind: "unbound", reason: "run_timeout" };
      }
      if (error instanceof GatewayClientError) {
        return {
          kind: "unbound",
          reason:
            error.errorClass === "unauthenticated"
              ? "gateway_unauthenticated"
              : error.errorClass,
        };
      }
      throw error;
    }
    state.allSources = sourcesFromTools(gatewayTools);
    if (state.allSources.length === 0) {
      return { kind: "unbound", reason: "no_searchable_sources" };
    }

    const described = await this.#describeSources(gateway, state, signal);
    if (described.unauthenticated) {
      return { kind: "unbound", reason: "gateway_unauthenticated" };
    }
    const reported = new Set(described.userIds);
    const [userId] = reported;
    if (reported.size !== 1 || userId === undefined) {
      // 0件: 利用者を報告した結果がない / 2件以上: Gateway の報告が食い違う
      return {
        kind: "unbound",
        reason:
          reported.size === 0 && described.transportError !== undefined
            ? described.transportError
            : "user_unverified",
      };
    }
    return { kind: "bound", userId, gatewayTools, briefs: described.briefs };
  }

  /** 全ソースに describe を並行に呼ぶ(iteration はソースの順に採番)。 */
  async #describeSources(
    gateway: GatewayClient,
    state: RunState,
    signal: AbortSignal,
  ): Promise<{
    readonly briefs: SourceBrief[];
    readonly userIds: readonly string[];
    readonly unauthenticated: boolean;
    readonly transportError: string | undefined;
  }> {
    const userIds: string[] = [];
    let unauthenticated = false;
    let transportError: string | undefined;
    const briefs = await Promise.all(
      state.allSources.map((sourceId) =>
        this.#dispatch(gateway, state, "describe", { source: sourceId }, signal).then(
          (dispatched): SourceBrief => {
            switch (dispatched.kind) {
              case "ok":
                if (dispatched.userId !== undefined) {
                  userIds.push(dispatched.userId);
                }
                return sourceBriefFromDescribe(sourceId, dispatched.result);
              case "tool_error": {
                if (dispatched.userId !== undefined) {
                  userIds.push(dispatched.userId);
                }
                if (dispatched.error.errorClass === "source_not_connected") {
                  // 未接続のソースは以降の検索対象から外す(ADR-010 決定3)
                  state.skip(sourceId);
                  return { sourceId };
                }
                // 警告・describeError も LLM に渡すものと同じ正規化後の分類にする(m7)
                const errorClass = errorForLlm(dispatched.error).errorClass;
                state.warn(
                  `ソース ${sourceId} の説明(describe)を取得できませんでした(${errorClass})。検索対象には残しています。`,
                );
                return { sourceId, describeError: errorClass };
              }
              case "transport_error":
                if (dispatched.errorClass === "unauthenticated") {
                  unauthenticated = true;
                } else if (dispatched.errorClass === "aborted") {
                  transportError ??= "run_timeout";
                } else {
                  transportError ??= dispatched.errorClass;
                  state.warn(
                    `ソース ${sourceId} の説明(describe)を取得できませんでした(${dispatched.errorClass})。検索対象には残しています。`,
                  );
                }
                return { sourceId };
            }
          },
        ),
      ),
    );
    return { briefs, userIds, unauthenticated, transportError };
  }

  // -------------------------------------------------------------------------
  // 探索
  // -------------------------------------------------------------------------

  async #explore(
    context: {
      readonly question: string;
      readonly gateway: GatewayClient;
      readonly fixedPrompt: string;
      readonly startedMs: number;
      readonly discovery: Extract<Discovery, { kind: "bound" }>;
    },
    state: RunState,
    signal: AbortSignal,
  ): Promise<RunOutcome> {
    if (signal.aborted) {
      return unresolved(TIMEOUT_BEFORE_SEARCH_TEXT, "run_timeout");
    }
    const activeSources = state.allSources.filter((s) => !state.skipped.has(s));
    if (activeSources.length === 0) {
      return unresolved(NO_SOURCES_TEXT, "no_searchable_sources");
    }

    const conversation: Conversation = {
      gateway: context.gateway,
      userId: context.discovery.userId,
      // system は固定部だけ。ソース一覧(describe 結果)は最初の user ターンにデータとして
      // 渡す(H3。コネクタ由来の文字列を system と同じ権威で読ませない)
      system: buildSystemPrompt(context.fixedPrompt),
      tools: buildClaudeTools(context.discovery.gatewayTools, activeSources),
      messages: [
        {
          role: "user",
          content: buildFirstUserContent({
            sources: context.discovery.briefs.filter(
              (brief) => !state.skipped.has(brief.sourceId),
            ),
            skippedSources: [...state.skipped.values()],
            maxIterations: this.settings.maxIterations,
            today: localDate(context.startedMs),
            question: context.question,
          }),
        },
      ],
      activeSources: new Set(activeSources),
    };
    return this.#loop(conversation, state, signal);
  }

  async #loop(
    conversation: Conversation,
    state: RunState,
    signal: AbortSignal,
  ): Promise<RunOutcome> {
    let toolTurns = 0;
    let nudged = false;
    for (;;) {
      const pendingLimit: LimitReason | undefined = signal.aborted
        ? "run_timeout"
        : state.meter.reached(this.settings.costLimitPerQuery)
          ? "cost_limit_reached"
          : undefined;
      if (pendingLimit !== undefined) {
        conversation.messages.push({
          role: "user",
          content: [this.#instruction(pendingLimit)],
        });
        return this.#finalTurn(conversation, state, pendingLimit);
      }

      const called = await this.#callLlm(conversation, state, signal);
      if (called.kind === "aborted") {
        // 応答前に打ち切った要求は履歴に入らない(追記のみの原則は保たれる)
        conversation.messages.push({
          role: "user",
          content: [this.#instruction("run_timeout")],
        });
        return this.#finalTurn(conversation, state, "run_timeout");
      }
      if (called.kind === "error") {
        return failure(called.errorClass);
      }
      const message = called.turn.message;
      // 応答は thinking ブロックを含めてそのまま追記する(編集しない)
      conversation.messages.push({ role: "assistant", content: message.content });

      const action = interpretTurn(message);
      switch (action.kind) {
        case "submit":
          return this.#finish(action.input, state, undefined, action.ignoredCalls);
        case "invalid_submit":
          return notSubmitted("invalid_answer_submission");
        case "none":
          if (nudged) {
            return notSubmitted("answer_not_submitted");
          }
          nudged = true;
          conversation.messages.push({
            role: "user",
            content: [{ type: "text", text: NUDGE_MESSAGE }],
          });
          continue;
        case "tools": {
          let limit: LimitReason | undefined;
          let results: Anthropic.ToolResultBlockParam[];
          if (state.meter.reached(this.settings.costLimitPerQuery)) {
            limit = "cost_limit_reached";
            results = action.calls.map((call) => notExecuted(call.id, "cost_limit_reached"));
          } else {
            toolTurns += 1;
            results = await this.#executeTurn(conversation, action.calls, state, signal);
            if (state.fatal !== undefined) {
              return failure(state.fatal);
            }
            if (signal.aborted) {
              limit = "run_timeout";
            } else if (toolTurns >= this.settings.maxIterations) {
              limit = "max_iterations_reached";
            }
          }
          // tool_result は1つの user メッセージにまとめて返す(並列呼び出しの作法)
          if (limit !== undefined) {
            conversation.messages.push({
              role: "user",
              content: [...results, this.#instruction(limit)],
            });
            return this.#finalTurn(conversation, state, limit);
          }
          conversation.messages.push({ role: "user", content: results });
          continue;
        }
      }
    }
  }

  /** 上限到達後の最終ターン(1回だけ)。ここで要求されたツールは実行しない。 */
  async #finalTurn(
    conversation: Conversation,
    state: RunState,
    limit: LimitReason,
  ): Promise<RunOutcome> {
    state.warn(limitWarning(limit, this.settings));
    const called = await this.#callLlm(
      conversation,
      state,
      AbortSignal.timeout(this.settings.finalTurnTimeoutMs),
    );
    if (called.kind === "aborted") {
      return notSubmitted(limit);
    }
    if (called.kind === "error") {
      return failure(called.errorClass);
    }
    const message = called.turn.message;
    conversation.messages.push({ role: "assistant", content: message.content });
    const action = interpretTurn(message);
    if (action.kind === "submit") {
      return this.#finish(action.input, state, limit, action.ignoredCalls);
    }
    if (action.kind === "tools") {
      state.warn(
        `上限到達後に要求されたツール呼び出し ${action.calls.length} 件は実行していません。`,
      );
    }
    return notSubmitted(
      action.kind === "invalid_submit" ? "invalid_answer_submission" : limit,
    );
  }

  async #callLlm(
    conversation: Conversation,
    state: RunState,
    signal: AbortSignal,
  ): Promise<LlmCall> {
    let turn: LlmTurn;
    try {
      turn = await this.#llm.complete(
        {
          system: conversation.system,
          // 呼び出し時点の履歴の複製を渡す(後の追記を要求に混ぜない)
          messages: [...conversation.messages],
          tools: conversation.tools,
          maxTokens: this.settings.maxTokensPerTurn,
        },
        { signal },
      );
    } catch (error) {
      if (signal.aborted) {
        return { kind: "aborted" };
      }
      if (error instanceof LlmError) {
        return { kind: "error", errorClass: error.errorClass };
      }
      // LlmClient 実装の不具合(AnthropicLlmClient は常に LlmError に正規化する)
      throw error;
    }
    state.meter.add(attemptsOf(turn));
    return { kind: "ok", turn };
  }

  /**
   * 1ターン分のツール呼び出しを Gateway に送り、tool_result を応答内の順に作る。
   * 件数の上限(m1): 応答内の順で maxToolCallsPerTurn 件を超えた分、run 全体で
   * maxToolCallsPerRun 件に達した後の分は実行しない(is_error、固定文言)。
   * iteration の採番(#dispatch 内)は同期的に行うので、並列呼び出しでも応答内の順になる。
   */
  #executeTurn(
    conversation: Conversation,
    calls: readonly Anthropic.ToolUseBlock[],
    state: RunState,
    signal: AbortSignal,
  ): Promise<Anthropic.ToolResultBlockParam[]> {
    return Promise.all(
      calls.map((call, index) => {
        if (index >= this.settings.maxToolCallsPerTurn) {
          state.turnLimitSkipped += 1;
          return Promise.resolve(errorResult(call.id, TURN_TOOL_CALL_LIMIT_ERROR));
        }
        const planned = planToolCall(call, conversation.activeSources, state);
        if (!planned.ok) {
          return Promise.resolve(errorResult(call.id, planned.error));
        }
        if (state.llmToolCalls >= this.settings.maxToolCallsPerRun) {
          state.runLimitSkipped += 1;
          return Promise.resolve(errorResult(call.id, RUN_TOOL_CALL_LIMIT_ERROR));
        }
        state.llmToolCalls += 1;
        return this.#executeToolCall(conversation, call, planned, state, signal);
      }),
    );
  }

  /** 検証済みの1件のツール呼び出しを Gateway に送り、tool_result を作る。 */
  #executeToolCall(
    conversation: Conversation,
    call: Anthropic.ToolUseBlock,
    planned: Extract<PlannedCall, { ok: true }>,
    state: RunState,
    signal: AbortSignal,
  ): Promise<Anthropic.ToolResultBlockParam> {
    return this.#dispatch(conversation.gateway, state, planned.tool, planned.args, signal).then(
      (dispatched) => {
        if (
          dispatched.kind !== "transport_error" &&
          dispatched.userId !== undefined &&
          dispatched.userId !== conversation.userId
        ) {
          // run の途中で別の利用者が報告された: 結果を使わずに止める(H1)
          state.fatal = "user_mismatch";
          return errorResult(call.id, USER_MISMATCH_ERROR);
        }
        switch (dispatched.kind) {
          case "ok":
            state.searched.add(planned.source);
            if (planned.tool === "search") {
              state.ledger.recordSearch(planned.source, dispatched.result);
            } else if (planned.tool === "fetch") {
              state.ledger.recordFetch(planned.source, dispatched.result);
            }
            return dataResult(call.id, {
              tool: planned.tool,
              source: planned.source,
              result: dispatched.result,
            });
          case "tool_error":
            if (dispatched.error.errorClass === "source_not_connected") {
              // 途中で未接続になったソースは skippedSources にだけ載せる(m11)
              state.skip(planned.source);
            }
            return errorResult(call.id, errorForLlm(dispatched.error));
          case "transport_error":
            if (dispatched.errorClass === "unauthenticated") {
              state.fatal = "gateway_unauthenticated";
            }
            return errorResult(call.id, {
              errorClass:
                dispatched.errorClass === "aborted" ? "run_timeout" : dispatched.errorClass,
              message: TRANSPORT_ERROR_MESSAGES[dispatched.errorClass],
            });
        }
      },
    );
  }

  /**
   * Gateway へ tools/call を1回送る。iteration の採番と `_meta` の組み立て
   * (buildGatewayMeta。実行区分は Phase 1 の human_in_the_loop 固定、ADR-015)は
   * 呼び出し時に同期的に行う(Promise を返す前に番号が確定する)。
   */
  #dispatch(
    gateway: GatewayClient,
    state: RunState,
    tool: GatewayToolName,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<Dispatched> {
    const iteration = state.nextIteration();
    state.toolCalls += 1;
    const meta = buildGatewayMeta({ runId: state.runId, iteration });
    return gateway.callTool(tool, args, meta, { signal }).then(
      (outcome): Dispatched =>
        outcome.ok
          ? { kind: "ok", result: outcome.result, userId: outcome.userId }
          : { kind: "tool_error", error: outcome.error, userId: outcome.userId },
      (error: unknown): Dispatched => {
        if (signal.aborted) {
          return { kind: "transport_error", errorClass: "aborted" };
        }
        if (error instanceof GatewayClientError) {
          return { kind: "transport_error", errorClass: error.errorClass };
        }
        // GatewayClient 実装の不具合
        throw error;
      },
    );
  }

  /** submit_answer の入力を検証し、run の結果にする(受け入れ条件2)。 */
  #finish(
    input: SubmitAnswerInput,
    state: RunState,
    limit: LimitReason | undefined,
    ignoredCalls: number,
  ): RunOutcome {
    if (ignoredCalls > 0) {
      state.warn(
        `submit_answer と同じターンで要求されたツール呼び出し ${ignoredCalls} 件は実行していません。`,
      );
    }
    const { verified, dropped } = verifyCitations(input.citations, state.ledger);
    if (dropped > 0) {
      state.warn(
        `この run で受け取っていない文書を指す出典 ${dropped} 件を除外しました。`,
      );
    }
    const reason = input.unresolvedReason?.trim() ?? "";
    // 本文の URL の除去は #assemble で回答全体に対して行う(M1)
    const text =
      reason !== ""
        ? `${input.answer.trim()}\n\n未解決の理由: ${reason}`
        : input.answer.trim();
    const confidence = clamp01(input.confidence);
    if (verified.length === 0) {
      return {
        outcome: "unresolved",
        answerText: text === "" ? NO_CITATION_NOTICE : `${NO_CITATION_NOTICE}\n\n${text}`,
        citations: [],
        confidence: Math.min(confidence, CONFIDENCE_CAP_WITHOUT_CITATIONS),
        failureReason:
          limit ?? (input.citations.length > 0 ? "citations_unverified" : "no_citations"),
      };
    }
    if (reason !== "") {
      return {
        outcome: "unresolved",
        answerText: text,
        citations: verified,
        confidence,
        failureReason: limit ?? "model_reported_unresolved",
      };
    }
    return {
      outcome: "resolved",
      answerText: text,
      citations: verified,
      confidence,
      failureReason: null,
    };
  }

  /**
   * run の結果を Answer に組み立てる。回答本文(未接続ソースの案内を含む全体)は
   * sanitizeAnswerText で無害化し、URL を残さない(M1。原典へのリンクは
   * citations[].url だけが運ぶ)。除去があれば warnings に記録する。
   */
  #assemble(result: RunOutcome, state: RunState): Answer {
    const skipped = [...state.skipped.values()];
    const body =
      skipped.length > 0
        ? `${result.answerText}\n\n${skippedNotice(skipped, this.settings.connectGuidance)}`
        : result.answerText;
    const sanitized = sanitizeAnswerText(body);
    if (sanitized.removed > 0) {
      state.warn(
        `回答本文に含まれていたリンク・画像・HTML・URL ${sanitized.removed} 件を除去しました(原典へのリンクは出典の url を参照してください)。`,
      );
    }
    if (sanitized.residual > 0) {
      state.warn(
        `最終検証で回答本文から URL・リンクらしき文字列 ${sanitized.residual} 件を追加で除去しました。`,
      );
    }
    if (state.turnLimitSkipped > 0) {
      state.warn(
        `1ターンのツール呼び出しの上限(maxToolCallsPerTurn=${this.settings.maxToolCallsPerTurn})を超えた ${state.turnLimitSkipped} 件は実行していません。`,
      );
    }
    if (state.runLimitSkipped > 0) {
      state.warn(
        `ツール呼び出しの上限(maxToolCallsPerRun=${this.settings.maxToolCallsPerRun})に達した後の ${state.runLimitSkipped} 件は実行していません。`,
      );
    }
    const unknownModels = state.meter.unknownModels;
    if (unknownModels.length > 0) {
      state.warn(
        `価格表にないモデル(${unknownModels.join(", ")})を使ったため、費用を概算できません。`,
      );
    }
    const estimatedCost = state.meter.estimatedCost;
    return answerSchema.parse({
      runId: state.runId,
      answer: sanitized.text.trim(),
      citations: result.citations,
      searchedSources: this.#searchedSources(state),
      skippedSources: skipped,
      confidence: result.confidence,
      outcome: result.outcome,
      usage: {
        inputTokens: state.meter.inputTokens,
        outputTokens: state.meter.outputTokens,
        llmTurns: state.meter.llmTurns,
        toolCalls: state.toolCalls,
        ...(estimatedCost !== undefined ? { estimatedCost } : {}),
      },
      warnings: [...state.warnings],
    });
  }

  /**
   * search / fetch / list が成功したソース(deployment.yaml の順で決定的に並べる)。
   * run の途中で未接続になったソースは skippedSources にだけ載せる(m11)。
   */
  #searchedSources(state: RunState): string[] {
    return state.allSources.filter(
      (sourceId) => state.searched.has(sourceId) && !state.skipped.has(sourceId),
    );
  }

  #instruction(limit: LimitReason): Anthropic.TextBlockParam {
    return {
      type: "text",
      text: finalTurnInstruction(limit, this.settings.maxIterations),
    };
  }

  /** 想定外の失敗で終わる run の AnswerRun を error で閉じる(書けなくても元の例外を優先)。 */
  async #closeWithError(
    pending: AnswerRunAuditRecord,
    state: RunState,
    failureReason: string,
  ): Promise<void> {
    let failed: AnswerRunAuditRecord;
    try {
      failed = finishedAnswerRun(
        pending,
        {
          endedAt: new Date(this.#now()).toISOString(),
          outcome: "error",
          confidence: 0,
          searchedSources: this.#searchedSources(state),
          citations: [],
          failureReason,
        },
        this.#docIdAudit,
      );
    } catch {
      return;
    }
    const written = await this.#writeAudit(failed).then(
      () => true,
      () => false,
    );
    if (written) {
      this.#remember(failed);
    }
  }

  async #writeAudit(record: AnswerRunAuditRecord): Promise<void> {
    try {
      await this.#auditLogger.log(record);
    } catch {
      // シンク由来の生エラーは載せない(TM-A2)
      throw new OrchestratorError(
        "audit_write_failed",
        "the AnswerRun audit record could not be persisted (fail-closed, ADR-011)",
      );
    }
  }

  #remember(record: AnswerRunAuditRecord): void {
    this.#finished.delete(record.runId);
    this.#finished.set(record.runId, record);
    while (this.#finished.size > this.#feedbackWindow) {
      const oldest = this.#finished.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.#finished.delete(oldest.value);
    }
  }
}

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function interpretTurn(message: Anthropic.Message): TurnAction {
  const uses = message.content.filter(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  const submits = uses.filter((block) => block.name === SUBMIT_ANSWER_TOOL_NAME);
  const others = uses.filter((block) => block.name !== SUBMIT_ANSWER_TOOL_NAME);
  const submit = submits[0];
  if (submit !== undefined) {
    const parsed = submitAnswerInputSchema.safeParse(submit.input);
    if (!parsed.success) {
      return { kind: "invalid_submit" };
    }
    return {
      kind: "submit",
      input: parsed.data,
      ignoredCalls: others.length + submits.length - 1,
    };
  }
  return others.length > 0 ? { kind: "tools", calls: others } : { kind: "none" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * ツール呼び出しを Gateway に送る前に検証する(strict のツール定義で形は保証されるが、
 * 防御的に確認する)。ここで弾いた呼び出しは Gateway に送らず、iteration も消費しない。
 */
function planToolCall(
  call: Anthropic.ToolUseBlock,
  activeSources: ReadonlySet<string>,
  state: RunState,
): PlannedCall {
  if (!isGatewayToolName(call.name)) {
    return {
      ok: false,
      error: { errorClass: "unknown_tool", message: "このツールは使えません。" },
    };
  }
  if (!isRecord(call.input)) {
    return {
      ok: false,
      error: { errorClass: "invalid_request", message: "ツールの引数が不正です。" },
    };
  }
  const source = call.input["source"];
  if (typeof source !== "string" || !activeSources.has(source)) {
    return {
      ok: false,
      error: {
        errorClass: "unknown_source",
        message: "このソースは検索対象ではありません。",
      },
    };
  }
  if (state.skipped.has(source)) {
    return {
      ok: false,
      error: {
        errorClass: "source_not_connected",
        message: "利用者が未接続のソースです。",
      },
    };
  }
  return { ok: true, tool: call.name, source, args: call.input };
}

/**
 * LLM に渡すツールエラー(permission_denied / not_found は区別しない、TM-B2)。
 * message はコネクタ由来の文言を含みうるため長さを切り詰める。
 */
function errorForLlm(error: GatewayToolError): ToolErrorForLlm {
  if (UNAVAILABLE_CLASSES.has(error.errorClass)) {
    return UNAVAILABLE_ERROR;
  }
  return {
    errorClass: error.errorClass,
    message:
      error.message.length > MAX_TOOL_ERROR_MESSAGE_CHARS
        ? `${error.message.slice(0, MAX_TOOL_ERROR_MESSAGE_CHARS)}…`
        : error.message,
  };
}

/**
 * 成功したツール結果。固定の前置き(データであり指示ではない)と、データ本体の
 * JSON を別ブロックに分けて渡す(文書本文をデータとして区切る、TM-D1)。
 */
function dataResult(
  toolUseId: string,
  payload: { tool: GatewayToolName; source: string; result: unknown },
): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: [
      { type: "text", text: TOOL_RESULT_PREFACE },
      { type: "text", text: JSON.stringify(payload) },
    ],
  };
}

/**
 * 失敗したツール結果。成功結果と同じく、固定の前置き(ツールエラーはデータ)と
 * { errorClass, message } の JSON を別ブロックに分けて渡す(m7)。
 */
function errorResult(
  toolUseId: string,
  error: ToolErrorForLlm,
): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    is_error: true,
    content: [
      { type: "text", text: TOOL_ERROR_PREFACE },
      {
        type: "text",
        text: JSON.stringify({ errorClass: error.errorClass, message: error.message }),
      },
    ],
  };
}

function notExecuted(toolUseId: string, limit: LimitReason): Anthropic.ToolResultBlockParam {
  return errorResult(toolUseId, {
    errorClass: limit,
    message: "上限に達したため、このツール呼び出しは実行していません。",
  });
}

function failure(errorClass: string): RunOutcome {
  return {
    outcome: "error",
    answerText:
      FAILURE_TEXTS[errorClass] ??
      `回答を生成できませんでした(${errorClass})。時間をおいて再度お試しください。`,
    citations: [],
    confidence: 0,
    failureReason: errorClass,
  };
}

function unresolved(text: string, failureReason: string): RunOutcome {
  return {
    outcome: "unresolved",
    answerText: text,
    citations: [],
    confidence: 0,
    failureReason,
  };
}

function notSubmitted(failureReason: string): RunOutcome {
  return unresolved(`${NO_CITATION_NOTICE}\n\n${NOT_SUBMITTED_TEXT}`, failureReason);
}

function limitWarning(limit: LimitReason, settings: OrchestratorSettings): string {
  switch (limit) {
    case "max_iterations_reached":
      return `探索の上限(maxIterations=${settings.maxIterations})に達したため、その時点の情報で回答しています。`;
    case "run_timeout":
      return `探索の時間上限(runTimeoutMs=${settings.runTimeoutMs})に達したため、その時点の情報で回答しています。`;
    case "cost_limit_reached":
      return `費用の上限(costLimitPerQuery=${String(settings.costLimitPerQuery)})に達したため、その時点の情報で回答しています。`;
  }
}

/** 未接続ソースの案内(ADR-010 決定3。接続導線は設定で差し替える。URL は書かない)。 */
function skippedNotice(skipped: readonly SkippedSource[], guidance: string): string {
  return `※ 未接続のため検索していないソース: ${skipped
    .map((s) => s.sourceId)
    .join("、")}。${guidance}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/** 実行環境のローカル日付(YYYY-MM-DD)。 */
function localDate(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
