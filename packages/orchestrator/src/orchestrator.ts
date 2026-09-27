/**
 * 探索ループ(T-007、product-design §4.3、ADR-017)。
 *
 * 1 run の流れ:
 *   AnswerRun(pending)を書く → tools/list → 全ソースに describe(未接続は
 *   skippedSources へ)→ system prompt(固定部+ソース一覧)とツール定義を組む →
 *   LLM ↔ Gateway のツール呼び出しを反復 → submit_answer で提出された回答の出典・
 *   URL を検証 → AnswerRun(最終状態)を書く → Answer を返す
 *
 * 監査の束ね(ADR-011 追記、ADR-001 追補3): runId はここで採番し、Gateway への
 * 全 tools/call の `_meta` に prefix 付きキーで runId / iteration / 実行区分
 * (human_in_the_loop)/ actor(human)を申告する(`_meta` の組み立ては
 * gateway/meta.ts の buildGatewayMeta に集約)。iteration はツール呼び出しごとに
 * 0 から単調増加(describe を含む。同一ターン内の並列呼び出しは応答内の順に採番)。
 * Gateway に送らなかった呼び出し(未接続ソース宛て等)は番号を消費しない。
 *
 * 終了条件:
 * - submit_answer が呼ばれた(同じターンの他のツール呼び出しは実行しない)
 * - submit_answer を呼ばずにターンを終えた: 1回だけ催促し、それでも提出しなければ unresolved
 * - 上限(maxIterations / runTimeoutMs / costLimitPerQuery)に達した: 探索を止め、
 *   その時点の情報で submit_answer を促す最終ターンを1回だけ行う
 * - LLM・Gateway の失敗: error
 *
 * 出典の検証(受け入れ条件2): citations は run 内で search ヒット / fetch 結果として
 * 受け取った文書に限る。検証済みの出典が0件なら unresolved にし、回答の先頭に
 * 注意を付け、confidence を 0.3 以下に丸める。回答文中の URL は受け取った原典の
 * url 以外を除去する(RS-4)。
 */
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { AuditLogger } from "@kp/gateway";
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
  finishedAnswerRun,
  pendingAnswerRun,
  type AnswerRunAuditRecord,
} from "./audit.js";
import { EvidenceLedger, sanitizeAnswerUrls, verifyCitations } from "./citations.js";
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
  buildSystemPrompt,
  finalTurnInstruction,
  loadExplorePrompt,
  NUDGE_MESSAGE,
  renderQuestion,
  sourceBriefFromDescribe,
  TOOL_RESULT_PREFACE,
  type LimitReason,
  type SourceBrief,
} from "./prompt.js";
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

/**
 * 文書単位で「使えない」ことを表す分類。permission_denied と not_found は区別せず
 * 同じ分類・固定文言で LLM に渡す(存在推定を増幅しない、TM-B2。Gateway も
 * `not_available` 等への正規化を予定。監査ログの errorClass は Gateway が区別を保つ)。
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

const TRANSPORT_ERROR_MESSAGES: Readonly<Record<GatewayClientErrorClass, string>> = {
  unauthenticated: "Gateway が利用者の認証を拒否しました。",
  gateway_unavailable: "Gateway に接続できませんでした。",
  gateway_timeout: "Gateway の応答がタイムアウトしました。",
  gateway_protocol_error: "Gateway の応答を解釈できませんでした。",
  gateway_rejected: "Gateway が要求を拒否しました。",
  aborted: "探索の時間上限に達したため中断しました。",
};

export type UserFeedback = "resolved" | "unresolved";

export interface OrchestratorOptions {
  readonly llm: LlmClient;
  /**
   * AnswerRun の書き込み先。リファレンス構成では Gateway と同じ監査ストアを共有する
   * (ToolInvocation と runId で束ねる。ADR-017 決定2)
   */
  readonly auditLogger: AuditLogger;
  readonly settings?: OrchestratorSettingsInput;
  /** system prompt 固定部の差し替え(評価用)。省略時は prompts/explore.v1.md */
  readonly systemPrompt?: string;
  /** テスト用の時計・ID 注入 */
  readonly now?: () => number;
  readonly ids?: () => string;
  /** recordFeedback のために最終状態を覚えておく run 数(古いものから捨てる) */
  readonly feedbackWindow?: number;
}

export interface RunInput {
  readonly question: string;
  /**
   * 質問者の userId(AnswerRun の主体)。利用者を認証した呼び出し元(チャットUIの
   * バックエンド等)が渡す申告値。Gateway が認証して記録する ToolInvocation の
   * userId と runId で突き合わせられる(ADR-017 確認事項)
   */
  readonly userId: string;
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
  | { readonly kind: "ok"; readonly result: unknown }
  | { readonly kind: "tool_error"; readonly error: GatewayToolError }
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

/** 1 run の会話(追記のみ。履歴を編集しない — preserved thinking / キャッシュのため)。 */
interface Conversation {
  readonly gateway: GatewayClient;
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
  toolCalls = 0;
  /** run を続けられない失敗(Gateway の認証拒否など)の正規化コード */
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
  readonly #systemPrompt: string | undefined;
  readonly #now: () => number;
  readonly #ids: () => string;
  readonly #feedbackWindow: number;
  readonly #finished = new Map<string, AnswerRunAuditRecord>();

  constructor(options: OrchestratorOptions) {
    this.settings = orchestratorSettingsSchema.parse(options.settings ?? {});
    this.#llm = options.llm;
    this.#auditLogger = options.auditLogger;
    this.#systemPrompt = options.systemPrompt;
    this.#now = options.now ?? Date.now;
    this.#ids = options.ids ?? randomUUID;
    this.#feedbackWindow = options.feedbackWindow ?? 1_000;
  }

  /**
   * 1つの質問について探索し、回答を返す。LLM・Gateway の失敗は outcome: "error" の
   * Answer で返す。AnswerRun を監査ストアへ書けない場合は OrchestratorError
   * ("audit_write_failed")で失敗させる(fail-closed、ADR-011 §4)。
   */
  async run(input: RunInput): Promise<Answer> {
    const question = input.question.trim();
    if (question === "" || question.length > MAX_QUESTION_CHARS) {
      throw new OrchestratorError(
        "invalid_input",
        `question must be 1..${MAX_QUESTION_CHARS} characters`,
      );
    }
    if (input.userId.trim() === "") {
      throw new OrchestratorError("invalid_input", "userId is required");
    }
    const fixedPrompt = this.#systemPrompt ?? (await loadExplorePrompt());
    const runId = this.#ids();
    const startedMs = this.#now();
    const pending = pendingAnswerRun({
      runId,
      userId: input.userId,
      startedAt: new Date(startedMs).toISOString(),
      question,
    });
    // 開始を記録できなければ Gateway に一切アクセスしない(fail-closed)
    await this.#writeAudit(pending);

    const state = new RunState(runId, this.settings.pricing);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.settings.runTimeoutMs);
    timer.unref();
    let result: RunOutcome;
    try {
      result = await this.#explore(
        { question, gateway: input.gateway, fixedPrompt, startedMs },
        state,
        deadline.signal,
      );
    } catch (error) {
      // 想定外の失敗(実装の不具合)。AnswerRun を pending のまま残さないよう
      // error で閉じてから元の例外を投げ直す
      const failed = finishedAnswerRun(pending, {
        endedAt: new Date(this.#now()).toISOString(),
        outcome: "error",
        confidence: 0,
        searchedSources: this.#searchedSources(state),
        citations: [],
        failureReason: "internal_error",
      });
      await this.#writeAudit(failed).catch(() => undefined);
      this.#remember(failed);
      throw error;
    } finally {
      clearTimeout(timer);
    }

    const answer = this.#assemble(result, state);
    const finished = finishedAnswerRun(pending, {
      endedAt: new Date(this.#now()).toISOString(),
      outcome: answer.outcome,
      confidence: answer.confidence,
      searchedSources: answer.searchedSources,
      citations: answer.citations,
      failureReason: result.failureReason,
    });
    await this.#writeAudit(finished);
    this.#remember(finished);
    return answer;
  }

  /**
   * 利用者フィードバック(解決した / しない)で AnswerRun の userFeedback を更新し、
   * 同じ runId で再書き込みする(受け入れ条件3)。options.userId を渡すと、質問者と
   * 一致しないフィードバックを拒否する(他人の run への書き込みで集計を汚させない)。
   */
  async recordFeedback(
    runId: string,
    feedback: UserFeedback,
    options: { readonly userId?: string } = {},
  ): Promise<void> {
    if (feedback !== "resolved" && feedback !== "unresolved") {
      throw new OrchestratorError("invalid_input", "feedback must be resolved or unresolved");
    }
    const record = this.#finished.get(runId);
    if (record === undefined) {
      throw new OrchestratorError(
        "run_not_found",
        "the run is unknown, unfinished, or no longer kept for feedback",
      );
    }
    if (options.userId !== undefined && options.userId !== record.userId) {
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
  // 探索
  // -------------------------------------------------------------------------

  async #explore(
    context: {
      readonly question: string;
      readonly gateway: GatewayClient;
      readonly fixedPrompt: string;
      readonly startedMs: number;
    },
    state: RunState,
    signal: AbortSignal,
  ): Promise<RunOutcome> {
    let gatewayTools: readonly GatewayToolSchema[];
    try {
      gatewayTools = await context.gateway.listTools({ signal });
    } catch (error) {
      if (signal.aborted) {
        return unresolved(TIMEOUT_BEFORE_SEARCH_TEXT, "run_timeout");
      }
      if (error instanceof GatewayClientError) {
        return failure(
          error.errorClass === "unauthenticated"
            ? "gateway_unauthenticated"
            : error.errorClass,
        );
      }
      throw error;
    }
    state.allSources = sourcesFromTools(gatewayTools);

    const briefs = await this.#describeSources(context.gateway, state, signal);
    if (state.fatal !== undefined) {
      return failure(state.fatal);
    }
    if (signal.aborted) {
      return unresolved(TIMEOUT_BEFORE_SEARCH_TEXT, "run_timeout");
    }
    const activeSources = state.allSources.filter((s) => !state.skipped.has(s));
    if (activeSources.length === 0) {
      return unresolved(NO_SOURCES_TEXT, "no_searchable_sources");
    }

    const conversation: Conversation = {
      gateway: context.gateway,
      system: buildSystemPrompt(context.fixedPrompt, {
        sources: briefs.filter((brief) => !state.skipped.has(brief.sourceId)),
        skippedSources: [...state.skipped.values()],
        maxIterations: this.settings.maxIterations,
      }),
      tools: buildClaudeTools(gatewayTools, activeSources),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: renderQuestion(context.question, localDate(context.startedMs)),
            },
          ],
        },
      ],
      activeSources: new Set(activeSources),
    };
    return this.#loop(conversation, state, signal);
  }

  /** 全ソースに describe を並行に呼ぶ(iteration はソースの順に採番)。 */
  async #describeSources(
    gateway: GatewayClient,
    state: RunState,
    signal: AbortSignal,
  ): Promise<SourceBrief[]> {
    return Promise.all(
      state.allSources.map((sourceId) =>
        this.#dispatch(gateway, state, "describe", { source: sourceId }, signal).then(
          (dispatched): SourceBrief => {
            switch (dispatched.kind) {
              case "ok":
                return sourceBriefFromDescribe(sourceId, dispatched.result);
              case "tool_error":
                if (dispatched.error.errorClass === "source_not_connected") {
                  // 未接続のソースは以降の検索対象から外す(ADR-010 決定3)
                  state.skip(sourceId);
                  return { sourceId };
                }
                state.warn(
                  `ソース ${sourceId} の説明(describe)を取得できませんでした(${dispatched.error.errorClass})。検索対象には残しています。`,
                );
                return { sourceId, describeError: dispatched.error.errorClass };
              case "transport_error":
                if (dispatched.errorClass === "unauthenticated") {
                  state.fatal = "gateway_unauthenticated";
                } else if (dispatched.errorClass !== "aborted") {
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
            results = await Promise.all(
              action.calls.map((call) =>
                this.#executeToolCall(conversation, call, state, signal),
              ),
            );
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
   * LLM が要求した1件のツール呼び出しを Gateway に送り、tool_result を作る。
   * iteration の採番(#dispatch 内)は同期的に行うので、並列呼び出しでも応答内の順になる。
   */
  #executeToolCall(
    conversation: Conversation,
    call: Anthropic.ToolUseBlock,
    state: RunState,
    signal: AbortSignal,
  ): Promise<Anthropic.ToolResultBlockParam> {
    const planned = planToolCall(call, conversation.activeSources, state);
    if (!planned.ok) {
      return Promise.resolve(errorResult(call.id, planned.error));
    }
    return this.#dispatch(conversation.gateway, state, planned.tool, planned.args, signal).then(
      (dispatched) => {
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
          ? { kind: "ok", result: outcome.result }
          : { kind: "tool_error", error: outcome.error },
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
    const body =
      reason !== ""
        ? `${input.answer.trim()}\n\n未解決の理由: ${reason}`
        : input.answer.trim();
    const { text, removed } = sanitizeAnswerUrls(body, state.ledger.urls);
    if (removed > 0) {
      state.warn(
        `回答に含まれていた、検索結果の原典以外の URL ${removed} 件を除去しました。`,
      );
    }
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

  #assemble(result: RunOutcome, state: RunState): Answer {
    const skipped = [...state.skipped.values()];
    const answerText =
      skipped.length > 0
        ? `${result.answerText}\n\n${skippedNotice(skipped, this.settings.connectGuidance)}`
        : result.answerText;
    const unknownModels = state.meter.unknownModels;
    if (unknownModels.length > 0) {
      state.warn(
        `価格表にないモデル(${unknownModels.join(", ")})を使ったため、費用を概算できません。`,
      );
    }
    const estimatedCost = state.meter.estimatedCost;
    return answerSchema.parse({
      runId: state.runId,
      answer: answerText,
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

  /** search / fetch / list が成功したソース(deployment.yaml の順で決定的に並べる)。 */
  #searchedSources(state: RunState): string[] {
    return state.allSources.filter((sourceId) => state.searched.has(sourceId));
  }

  #instruction(limit: LimitReason): Anthropic.TextBlockParam {
    return {
      type: "text",
      text: finalTurnInstruction(limit, this.settings.maxIterations),
    };
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

/** LLM に渡すツールエラー(permission_denied / not_found は区別しない、TM-B2)。 */
function errorForLlm(error: GatewayToolError): ToolErrorForLlm {
  if (UNAVAILABLE_CLASSES.has(error.errorClass)) {
    return UNAVAILABLE_ERROR;
  }
  return { errorClass: error.errorClass, message: error.message };
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

/** 失敗したツール結果(内容は { errorClass, message } の JSON)。 */
function errorResult(
  toolUseId: string,
  error: ToolErrorForLlm,
): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    is_error: true,
    content: JSON.stringify({ errorClass: error.errorClass, message: error.message }),
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
    answerText: `回答を生成できませんでした(${errorClass})。時間をおいて再度お試しください。`,
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

/** 未接続ソースの案内(ADR-010 決定3。接続導線は設定で差し替える)。 */
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
