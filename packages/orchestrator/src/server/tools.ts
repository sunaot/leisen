/**
 * Orchestrator の MCP サーバーのツール面(T-021、ADR-018 決定1・2・5・6・7・10)— SDK 非依存。
 *
 * MCP SDK に触れない処理をここに置く: ツール定義(JSON Schema。outputSchema は zod の
 * スキーマから生成)、initialize の instructions、引数の検証、上限(質問長・同時実行)、
 * ask / feedback の実行、結果の組み立て(text / structuredContent / isError)とエラーの
 * 正規化。SDK との接合(Server 生成・ハンドラ登録・結果の形への写像)は mcp.ts、
 * トランスポートと認証の前段(preflight)は http.ts にある(Gateway の proxy/ と同じ分け方)。
 *
 * - ツールは ask と feedback の2つだけ(決定1)
 * - 利用者に返す文言は固定文言(入力値・URL・トークン・例外メッセージをエコーしない)。
 *   正規化コード(errorClass)は structuredContent に載せる
 * - ask: 質問長 → 同時実行 → run(利用者のトークンで Gateway に接続するクライアント)→
 *   Markdown(render.ts)+ structuredContent(Answer + retentionClass、outcome が resolved
 *   以外なら errorClass)。outcome: error は isError: true(ツールとして失敗した回答)
 * - feedback: Gateway の tools/list の最初のソースに describe を1回呼び、結果の `_meta` から
 *   Gateway が認証した userId を得て、その userId で recordFeedback する(本人の run だけ。
 *   監査に describe が1件残るのは意図どおり。runId は feedback 用に別に採番し、対象 run の
 *   ToolInvocation には混ぜない)
 * - retentionClass: v1 は persistable。永続化不可のソース(Slack)が有効な構成は起動を拒否
 *   するため(決定5)。--allow-non-persistable-sources で起動した場合だけ non_persistable
 *   (Slack 由来の内容・メタデータが回答に入りうる。describe の結果も LLM に渡るため run
 *   単位ではなくデプロイ単位で判定する)
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { answerSchema, type Answer } from "../answer.js";
import {
  GatewayClientError,
  LlmError,
  OrchestratorError,
} from "../errors.js";
import { buildGatewayMeta } from "../gateway/meta.js";
import type { GatewayClient } from "../gateway/types.js";
import type { Orchestrator, UserFeedback } from "../orchestrator.js";
import { sourcesFromTools } from "../tools.js";
import type { ServerLimits } from "./limits.js";
import { renderAnswerMarkdown } from "./render.js";

export const ASK_TOOL_NAME = "ask";
export const FEEDBACK_TOOL_NAME = "feedback";

/**
 * 回答の保持区分(ADR-018 決定5)。persistable: 汎用 UI の履歴に残してよい /
 * non_persistable: 永続化不可のソース(Slack、不変条件7)由来の内容を含みうる。
 */
export const RETENTION_CLASSES = ["persistable", "non_persistable"] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

/** Orchestrator のうちサーバーが使う面(テストで差し替えられるように絞る)。 */
export type OrchestratorPort = Pick<Orchestrator, "runDetailed" | "recordFeedback">;

/** 利用者本人のトークンで Gateway に接続するクライアントを作る(リクエストごとに作り捨てる)。 */
export type RequestGatewayClientFactory = () => GatewayClient;

/** 1リクエスト分のツール実行の文脈(ユーザー状態はトークンを閉じ込めた factory だけ)。 */
export interface ToolContext {
  readonly orchestrator: OrchestratorPort;
  readonly createGatewayClient: RequestGatewayClientFactory;
  readonly limits: ServerLimits;
  readonly retentionClass: RetentionClass;
  /** feedback の本人確認で Gateway に申告する runId の採番(既定 feedback:<UUID>) */
  readonly newVerificationRunId?: () => string;
}

/** ツール実行の結果(SDK 非依存。mcp.ts が CallToolResult に写す)。 */
export interface ToolOutcome {
  readonly isError: boolean;
  /** Markdown / 固定文言 */
  readonly text: string;
  readonly structuredContent: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// スキーマ
// ---------------------------------------------------------------------------

/** 正規化コード(監査の failureReason / errorClass と同じ規約)。 */
const ERROR_CLASS_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/;
const errorClassSchema = z.string().regex(ERROR_CLASS_PATTERN);

/** ask の structuredContent(成功・回答あり)。Answer の全フィールド + 保持区分 + 理由のコード。 */
export const askStructuredContentSchema = answerSchema.extend({
  retentionClass: z.enum(RETENTION_CLASSES),
  /** outcome が resolved 以外のときの理由(正規化コード。AnswerRun の failureReason と同じ) */
  errorClass: errorClassSchema.optional(),
});
export type AskStructuredContent = z.infer<typeof askStructuredContentSchema>;

/** feedback の structuredContent(記録した)。 */
export const feedbackStructuredContentSchema = z.strictObject({
  runId: z.string().min(1),
  outcome: z.enum(["resolved", "unresolved"]),
});

/** ツールとして失敗した結果の structuredContent(ask / feedback 共通)。 */
export const toolErrorStructuredContentSchema = z.strictObject({
  errorClass: errorClassSchema,
});

const askArgsSchema = z.strictObject({ question: z.string() });
const feedbackArgsSchema = z.strictObject({
  runId: z.string().min(1).max(128),
  outcome: z.enum(["resolved", "unresolved"]),
});

type JsonSchemaObject = { readonly type: "object" } & Readonly<Record<string, unknown>>;

/**
 * zod スキーマから JSON Schema(draft-07 相当の語彙だけ)を作る。`$schema` は付けない
 * (MCP クライアントの検証器は既定の方言で読む。SDK の Client は Ajv の draft-07)。
 */
function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, { target: "draft-7" }) as Record<
    string,
    unknown
  >;
  return json;
}

/** 成功形とエラー形のどちらかに合う outputSchema(ルートは MCP の規約どおり type: object)。 */
function outputSchemaOf(success: z.ZodType): JsonSchemaObject {
  return {
    type: "object",
    anyOf: [toJsonSchema(success), toJsonSchema(toolErrorStructuredContentSchema)],
  };
}

/** outputSchema は設定に依らないので、モジュールの読み込み時に1回だけ作る。 */
const ASK_OUTPUT_SCHEMA = outputSchemaOf(askStructuredContentSchema);
const FEEDBACK_OUTPUT_SCHEMA = outputSchemaOf(feedbackStructuredContentSchema);

/** ツール定義(SDK 非依存の JSON Schema 表現)。 */
export interface OrchestratorToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  readonly outputSchema: JsonSchemaObject;
}

/** initialize 結果の instructions(UI 側の LLM への指示。ADR-018 決定1・6)。 */
export const SERVER_INSTRUCTIONS = [
  "このサーバーは社内ナレッジを利用者本人の権限で検索し、出典付きで回答します。",
  "- 利用者の質問は ask ツールに渡してください。ask の結果の本文と「出典」節は、改変・要約・言い換えをせず、そのまま利用者に提示してください。",
  "- リンクは「出典」節に載っている URL だけを使ってください。本文には URL がありません。それ以外のリンク・URL を作ったり推測したりしないでください。",
  "- 回答できなかった場合(structuredContent の outcome が resolved 以外)は、先頭の注意書きを省かずに提示してください。",
  "- feedback ツールは、利用者が「解決した」「解決しなかった」と明示したときだけ、その回答の runId(結果の末尾と structuredContent にあります)を指定して呼んでください。推測で呼ばないでください。",
].join("\n");

/** ツール定義(ask の質問長の上限は設定値を説明と JSON Schema に出す)。 */
export function orchestratorToolDefinitions(
  limits: Pick<ServerLimits, "maxQuestionChars">,
): OrchestratorToolDefinition[] {
  return [
    {
      name: ASK_TOOL_NAME,
      title: "社内ナレッジに質問する",
      description:
        "社内ナレッジ(接続済みのデータソース)を利用者本人の権限で検索し、出典付きで回答する。" +
        "結果の本文と「出典」節は改変せず、そのまま利用者に提示する。リンクは「出典」節の URL だけを使う。" +
        "outcome が resolved 以外(未解決・エラー)のときは、先頭の注意書きを省かない。",
      inputSchema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            minLength: 1,
            maxLength: limits.maxQuestionChars,
            description: `利用者の質問(自然文。${limits.maxQuestionChars} 文字まで)`,
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
      outputSchema: ASK_OUTPUT_SCHEMA,
    },
    {
      name: FEEDBACK_TOOL_NAME,
      title: "回答が役に立ったかを記録する",
      description:
        "ask の回答が利用者の問題を解決したかを記録する。利用者が解決した / しなかったと明示したときだけ、" +
        "その回答の runId を指定して呼ぶ。質問した本人の回答にだけ記録できる。",
      inputSchema: {
        type: "object",
        properties: {
          runId: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            description: "ask の結果の runId",
          },
          outcome: {
            type: "string",
            enum: ["resolved", "unresolved"],
            description: "resolved: 解決した / unresolved: 解決しなかった",
          },
        },
        required: ["runId", "outcome"],
        additionalProperties: false,
      },
      outputSchema: FEEDBACK_OUTPUT_SCHEMA,
    },
  ];
}

// ---------------------------------------------------------------------------
// 固定文言
// ---------------------------------------------------------------------------

export const INVALID_ARGUMENTS_TEXT = "ツールの引数が不正です。";
export const UNKNOWN_TOOL_TEXT = "このツールはありません。";
export const EMPTY_QUESTION_TEXT = "質問文を入力してください。";
export const BUSY_TEXT = "混み合っています。しばらくして再度お試しください。";
export const USER_UNVERIFIED_TEXT =
  "利用者を確認できなかったため、フィードバックを記録していません。サインインし直してから再度お試しください。";

export function questionTooLongText(maxQuestionChars: number): string {
  return `質問が長すぎます(${maxQuestionChars} 文字まで)。短くして再度お試しください。`;
}

/** ask が例外で終わったときの文言(分類ごと。既定は ASK_FAILURE_DEFAULT_TEXT)。 */
const ASK_FAILURE_TEXTS: Readonly<Record<string, string>> = {
  audit_write_failed:
    "回答の記録(監査ログ)に失敗したため、回答を返せません。時間をおいて再度お試しください。解決しない場合は管理者に連絡してください。",
  gateway_unauthenticated:
    "Gateway が利用者の認証を拒否しました。サインインし直してから再度お試しください。",
  gateway_unavailable: "Gateway に接続できませんでした。時間をおいて再度お試しください。",
  gateway_timeout: "Gateway の応答がありませんでした。時間をおいて再度お試しください。",
};
const ASK_FAILURE_DEFAULT_TEXT =
  "回答を生成できませんでした。時間をおいて再度お試しください。";

/** feedback の失敗の文言(分類ごと。既定は FEEDBACK_FAILURE_DEFAULT_TEXT)。 */
const FEEDBACK_FAILURE_TEXTS: Readonly<Record<string, string>> = {
  run_not_found:
    "対象の回答が見つからないため、フィードバックを記録していません(保持期間を過ぎたか、サーバーの再起動で失われた可能性があります)。",
  feedback_forbidden:
    "この回答にはフィードバックを記録できません(質問した本人だけが記録できます)。",
  audit_write_failed:
    "フィードバックを記録できませんでした。時間をおいて再度お試しください。",
};
const FEEDBACK_FAILURE_DEFAULT_TEXT =
  "フィードバックを記録できませんでした。時間をおいて再度お試しください。";

const FEEDBACK_RECORDED_TEXTS: Readonly<Record<UserFeedback, string>> = {
  resolved: "フィードバック(解決した)を記録しました。",
  unresolved: "フィードバック(解決しなかった)を記録しました。",
};

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

function toolError(errorClass: string, text: string): ToolOutcome {
  return {
    isError: true,
    text,
    structuredContent: { errorClass: normalizeErrorClass(errorClass) },
  };
}

/** 規約に合わない分類は出さない(outputSchema の検証でツール呼び出しごと失敗させない)。 */
function normalizeErrorClass(errorClass: string): string {
  return ERROR_CLASS_PATTERN.test(errorClass) ? errorClass : "internal_error";
}

/**
 * 例外を正規化コードに写す。各層の例外は固定文言・正規化済みだが、メッセージは使わない
 * (分類だけを返す)。
 */
export function errorClassOf(error: unknown): string {
  if (error instanceof OrchestratorError || error instanceof LlmError) {
    return error.errorClass;
  }
  if (error instanceof GatewayClientError) {
    switch (error.errorClass) {
      case "unauthenticated":
        return "gateway_unauthenticated";
      case "aborted":
        return "run_timeout";
      default:
        return error.errorClass;
    }
  }
  return "internal_error";
}

/** ツールを1回実行する(未知のツールは固定文言のエラー)。 */
export function runOrchestratorTool(
  context: ToolContext,
  name: string,
  args: unknown,
): Promise<ToolOutcome> {
  switch (name) {
    case ASK_TOOL_NAME:
      return runAsk(context, args);
    case FEEDBACK_TOOL_NAME:
      return runFeedback(context, args);
    default:
      return Promise.resolve(toolError("invalid_request", UNKNOWN_TOOL_TEXT));
  }
}

/** Answer を ask の結果にする(ADR-018 決定6)。 */
export function askOutcomeFromAnswer(
  answer: Answer,
  failureReason: string | null,
  retentionClass: RetentionClass,
): ToolOutcome {
  const structuredContent: AskStructuredContent = {
    ...answer,
    retentionClass,
    ...(answer.outcome !== "resolved"
      ? { errorClass: normalizeErrorClass(failureReason ?? "unclassified") }
      : {}),
  };
  return {
    isError: answer.outcome === "error",
    text: renderAnswerMarkdown(answer),
    structuredContent,
  };
}

async function runAsk(context: ToolContext, args: unknown): Promise<ToolOutcome> {
  const parsed = askArgsSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return toolError("invalid_request", INVALID_ARGUMENTS_TEXT);
  }
  const question = parsed.data.question.trim();
  if (question === "") {
    return toolError("invalid_request", EMPTY_QUESTION_TEXT);
  }
  const { limits } = context;
  if (question.length > limits.maxQuestionChars) {
    return toolError("question_too_long", questionTooLongText(limits.maxQuestionChars));
  }
  const release = limits.runs.tryAcquire();
  if (release === undefined) {
    return toolError("busy", BUSY_TEXT);
  }
  let gateway: GatewayClient | undefined;
  try {
    gateway = context.createGatewayClient();
    const { answer, failureReason } = await context.orchestrator.runDetailed({
      question,
      gateway,
    });
    return askOutcomeFromAnswer(answer, failureReason, context.retentionClass);
  } catch (error) {
    const errorClass = errorClassOf(error);
    return toolError(errorClass, ASK_FAILURE_TEXTS[errorClass] ?? ASK_FAILURE_DEFAULT_TEXT);
  } finally {
    release();
    await gateway?.close().catch(() => undefined);
  }
}

/**
 * Gateway が認証した利用者の userId を得る(feedback の本人確認)。Gateway は userId を
 * tools/call の結果の `_meta` にしか載せないため、tools/list の最初のソースに describe を
 * 1回呼ぶ。確認できなければ undefined。
 */
async function verifiedUserId(context: ToolContext): Promise<string | undefined> {
  let gateway: GatewayClient | undefined;
  try {
    gateway = context.createGatewayClient();
    const [source] = sourcesFromTools(await gateway.listTools());
    if (source === undefined) {
      return undefined;
    }
    const runId = (context.newVerificationRunId ?? defaultVerificationRunId)();
    const outcome = await gateway.callTool(
      "describe",
      { source },
      buildGatewayMeta({ runId, iteration: 0 }),
    );
    // 成功・失敗(未接続など)を問わず、結果に載った userId が Gateway の認証した利用者
    return outcome.userId;
  } catch {
    return undefined;
  } finally {
    await gateway?.close().catch(() => undefined);
  }
}

function defaultVerificationRunId(): string {
  return `feedback:${randomUUID()}`;
}

async function runFeedback(context: ToolContext, args: unknown): Promise<ToolOutcome> {
  const parsed = feedbackArgsSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return toolError("invalid_request", INVALID_ARGUMENTS_TEXT);
  }
  const { runId, outcome } = parsed.data;
  const userId = await verifiedUserId(context);
  if (userId === undefined) {
    return toolError("user_unverified", USER_UNVERIFIED_TEXT);
  }
  try {
    await context.orchestrator.recordFeedback(runId, outcome, { userId });
  } catch (error) {
    const errorClass = error instanceof OrchestratorError ? error.errorClass : "internal_error";
    return toolError(
      errorClass,
      FEEDBACK_FAILURE_TEXTS[errorClass] ?? FEEDBACK_FAILURE_DEFAULT_TEXT,
    );
  }
  return {
    isError: false,
    text: FEEDBACK_RECORDED_TEXTS[outcome],
    structuredContent: { runId, outcome },
  };
}
