/**
 * Orchestrator の MCP サーバーのツール面(T-021、ADR-018 決定1・2・5・6・7・10)— SDK 非依存。
 *
 * MCP SDK に触れない処理をここに置く: ツール定義(JSON Schema。outputSchema は zod の
 * スキーマから生成)、initialize の instructions、引数の検証、上限(質問長・同時実行)、
 * ask / feedback の実行、結果の組み立て(text / structuredContent / isError)とエラーの
 * 正規化。SDK との接合(Server 生成・ハンドラ登録・結果の形への写像)は mcp.ts、
 * トランスポートと認証の前段(preflight)は http.ts にある(Gateway の proxy/ と同じ分け方)。
 *
 * - ツールは ask と feedback の2つだけ(決定1)。ask は question が必須で、userMessage / context /
 *   keepTerms / sources / period / depth は省略可能(ADR-026 決定1)。上限超過・有効でない sourceId・
 *   未知の引数は固定文言で拒否する(値をエコーしない)
 * - retentionClass が non_persistable なら、structuredContent と text の searchesTried から query と
 *   filters を除く(ADR-026 決定5、不変条件7)
 * - 利用者に返す文言は固定文言(入力値・URL・トークン・例外メッセージをエコーしない)。
 *   正規化コード(errorClass)は structuredContent に載せる
 * - ask: 質問長 → 同時実行 → run(利用者のトークンで Gateway に接続するクライアント)→
 *   Markdown(render.ts)+ structuredContent(Answer + retentionClass、outcome が resolved
 *   以外なら errorClass)。outcome: error は isError: true(ツールとして失敗した回答)
 * - structuredContent の citations は text の出典欄と同じ規則で無害化する(m3。render.ts の
 *   structuredCitation): title は制御文字・リンク・HTML・URL を除き、url は http / https の
 *   正規化形だけ(それ以外は省く)
 * - feedback: 同時実行の上限(ServerLimits.feedback。超過は ask と同じ固定文言の busy)→
 *   利用者のトークンで Gateway の run API(POST /runs/{runId}/feedback)に申告する(ADR-019
 *   決定3・8)。本人・期間は Gateway が runId の署名で検証し、Orchestrator は run を覚えない
 *   (再起動で消えない)。往復には期限(feedbackTimeoutMs、既定 FEEDBACK_TIMEOUT_MS)を置く
 * - retentionClass: v1 は persistable。永続化不可のソース(Slack)が有効な構成は起動を拒否
 *   するため(決定5)。--allow-non-persistable-sources で起動した場合だけ non_persistable
 *   (Slack 由来の内容・メタデータが回答に入りうる。describe の結果も LLM に渡るため run
 *   単位ではなくデプロイ単位で判定する)
 * - Gateway が公開するソースと --config の照合(セキュリティレビュー S6、checkGatewaySources):
 *   不変条件7 の判定と citedDocIds の分類は --config の中身で行うため、Gateway が --config で
 *   有効でないソースを公開していると Slack ソースを見逃す。preflight(http.ts)で得た Gateway の
 *   tools/list の search のソース enum(Orchestrator の discover と同じ読み方、sourcesFromTools)に
 *   --config の有効なコネクタにないソースがあれば、そのリクエストの ask / feedback を固定文言の
 *   config_mismatch にする(initialize / tools/list は通す)。--allow-non-persistable-sources の
 *   ときは不一致を許し、そのリクエストの retentionClass を non_persistable にする
 */
import { z } from "zod";
import { answerSchema, withoutSearchQueries, type Answer } from "../answer.js";
import {
  ASK_DEPTHS,
  MAX_CONTEXT_CHARS,
  MAX_KEEP_TERM_CHARS,
  MAX_KEEP_TERMS,
  MAX_REQUESTED_SOURCES,
  MAX_SOURCE_ID_CHARS,
  askPeriodSchema,
  normalizeAskExtras,
  type AskInputExtras,
} from "../ask-input.js";
import {
  GatewayClientError,
  LlmError,
  OrchestratorError,
} from "../errors.js";
import { failureTextFor } from "../failure-text.js";
import type { GatewayClient } from "../gateway/types.js";
import type { Orchestrator, UserFeedback } from "../orchestrator.js";
import { untilAborted, type ServerLimits } from "./limits.js";
import { renderAnswerMarkdown, structuredCitation } from "./render.js";

export const ASK_TOOL_NAME = "ask";
export const FEEDBACK_TOOL_NAME = "feedback";

/**
 * 回答の保持区分(ADR-018 決定5)。persistable: 汎用 UI の履歴に残してよい /
 * non_persistable: 永続化不可のソース(Slack、不変条件7)由来の内容を含みうる。
 */
export const RETENTION_CLASSES = ["persistable", "non_persistable"] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

/** Orchestrator のうちサーバーが使う面(テストで差し替えられるように絞る)。 */
export type OrchestratorPort = Pick<Orchestrator, "runDetailed">;

/** feedback の申告(Gateway の run API への往復)の既定の期限(ms)。 */
export const FEEDBACK_TIMEOUT_MS = 10_000;

/**
 * Gateway が公開するソースと --config の照合の方針(セキュリティレビュー S6)。
 */
export interface GatewaySourcePolicy {
  /**
   * --config で有効なコネクタの sourceId(不変条件7 の判定と citedDocIds の分類に使った集合。
   * Gateway の tools/list は有効なコネクタだけを公開するため、無効なコネクタは含めない)
   */
  readonly knownSourceIds: readonly string[];
  /**
   * knownSourceIds にないソースを Gateway が公開していたときの扱い。
   * - reject: そのリクエストの ask / feedback を config_mismatch で拒否する
   * - non_persistable: 許し、そのリクエストの retentionClass を non_persistable にする
   *   (--allow-non-persistable-sources)
   */
  readonly onUnknownSource: "reject" | "non_persistable";
}

/** 1リクエスト分の照合結果。 */
export interface GatewaySourceCheck {
  /** true なら ask / feedback を config_mismatch で拒否する */
  readonly configMismatch: boolean;
  /** このリクエストの ask の retentionClass */
  readonly retentionClass: RetentionClass;
}

/**
 * Gateway の公開するソース(preflight の tools/list から sourcesFromTools で読んだもの)を
 * --config と照合する(S6)。policy がなければ照合しない(ライブラリとして組む場合)。
 */
export function checkGatewaySources(
  policy: GatewaySourcePolicy | undefined,
  gatewaySourceIds: readonly string[],
  retentionClass: RetentionClass,
): GatewaySourceCheck {
  if (policy === undefined) {
    return { configMismatch: false, retentionClass };
  }
  const known = new Set(policy.knownSourceIds);
  if (gatewaySourceIds.every((sourceId) => known.has(sourceId))) {
    return { configMismatch: false, retentionClass };
  }
  return policy.onUnknownSource === "non_persistable"
    ? { configMismatch: false, retentionClass: "non_persistable" }
    : { configMismatch: true, retentionClass };
}

/** 利用者本人のトークンで Gateway に接続するクライアントを作る(リクエストごとに作り捨てる)。 */
export type RequestGatewayClientFactory = () => GatewayClient;

/** 1リクエスト分のツール実行の文脈(ユーザー状態はトークンを閉じ込めた factory だけ)。 */
export interface ToolContext {
  readonly orchestrator: OrchestratorPort;
  readonly createGatewayClient: RequestGatewayClientFactory;
  readonly limits: ServerLimits;
  readonly retentionClass: RetentionClass;
  /**
   * Gateway が公開するソースが --config と食い違う(checkGatewaySources)。true なら ask /
   * feedback を config_mismatch で拒否する(S6)
   */
  readonly configMismatch?: boolean;
  /** feedback の申告の期限(ms、既定 FEEDBACK_TIMEOUT_MS) */
  readonly feedbackTimeoutMs?: number;
  /**
   * ask の sources に指定できるソース(--config で有効なコネクタの sourceId。ADR-026 決定1)。
   * 省略時は形だけを検証し、有効なソースかは Orchestrator が Gateway の公開するソースで確かめる
   */
  readonly knownSourceIds?: readonly string[];
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

/**
 * ask の引数(ADR-026 決定1)。question 以外は省略可能。長さ・件数の上限と有効なソースは
 * runAsk(checkAskExtras)で検証する(上限ごとに固定文言で拒否するため)。
 */
const askArgsSchema = z.strictObject({
  question: z.string(),
  userMessage: z.string().optional(),
  context: z.string().optional(),
  keepTerms: z.array(z.string()).optional(),
  sources: z.array(z.string()).optional(),
  period: z
    .strictObject({
      updatedAfter: z.string().optional(),
      updatedBefore: z.string().optional(),
    })
    .optional(),
  depth: z.enum(ASK_DEPTHS).optional(),
});
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
  "- 利用者の質問は ask ツールに渡してください。",
  "- ask の userMessage には、利用者の直近の発言を、言い換え・要約・翻訳をせずにそのまま入れてください。question にも、直近の発言だけで意味が通るなら同じ発言をそのまま入れてください。固有名詞・ID・エラーメッセージ・引用符で囲まれた語句・英数字の表記は一字も変えないでください。検索はこれらの文字列の語をもとに行われます。",
  "- ask の keepTerms には、利用者の発言に含まれる変えてはならない語(固有名詞・ID・エラーメッセージ・引用符で囲まれた語句など)を、発言から一字も変えずに写してください。",
  "- 直近の発言だけでは意味が通らないとき(「それ」「さっきの件」など)に限り、指している対象を会話から補って context に書いてください(question は、補った対象を含めて 1 回で完結する質問にしてかまいません)。",
  "- sources(対象のソース)と period(期間)は、利用者が指定したときだけ書いてください。利用者が言っていない条件(用途・期間・範囲・対象のソース)は足さないでください。",
  "- ask は過去の会話を覚えていません。1 回の呼び出しで質問が完結するようにしてください。応答には 1〜2 分かかることがあります。",
  "- ask の結果の本文と「出典」節は、改変・要約・言い換えをせず、そのまま利用者に提示してください。",
  "- リンクは「出典」節に載っている URL だけを使ってください。本文には URL がありません。それ以外のリンク・URL を作ったり推測したりしないでください。",
  "- 回答できなかった場合(structuredContent の outcome が resolved 以外)は、先頭の注意書きを省かずに提示してください。「探した範囲」(試した検索の一覧)も省かずに示し、別の語で探し直すかを利用者に尋ねる材料にしてください。",
  "- feedback ツールは、利用者が「解決した」「解決しなかった」と明示したときだけ、その回答の runId(結果の末尾と structuredContent にあります)を指定して呼んでください。推測で呼ばないでください。",
].join("\n");

/** ツール定義(ask の質問長の上限は設定値を説明と JSON Schema に出す)。 */
export function orchestratorToolDefinitions(
  limits: Pick<ServerLimits, "maxQuestionChars">,
  knownSourceIds?: readonly string[],
): OrchestratorToolDefinition[] {
  return [
    {
      name: ASK_TOOL_NAME,
      title: "社内ナレッジに質問する",
      description:
        "社内ナレッジ(接続済みのデータソース)を利用者本人の権限で検索し、出典付きで回答する。\n\n" +
        "引数の書き方:\n" +
        "- userMessage: 利用者の直近の発言を、言い換え・要約・翻訳をせずにそのまま入れる。固有名詞、ID、エラーメッセージ、引用符で囲まれた語句、英数字の表記は一字も変えない。\n" +
        "- question(必須): 1 回の呼び出しで完結する質問。直近の発言だけで意味が通るなら、その発言をそのまま入れる。\n" +
        "- keepTerms: 利用者の発言に含まれる変えてはならない語を、発言から一字も変えずに写す。\n" +
        "- context: 直近の発言だけでは意味が通らないとき(「それ」「さっきの件」など)に限り、指している対象を会話から補って書く。利用者の発言ではない補足はここに書く。\n" +
        "- sources / period: 利用者が対象のソース・期間を指定したときだけ書く。利用者が言っていない条件(用途・期間・範囲・対象のソース)を足さない。\n" +
        "- depth: 利用者が手早い回答・徹底した調査を求めたときだけ書く(省略時は standard)。\n" +
        "- このツールは過去の会話を覚えていない。1 回の呼び出しで質問が完結するように書く。\n\n" +
        "結果の本文と「出典」節は改変せず、そのまま利用者に提示する。リンクは「出典」節の URL だけを使う。" +
        "outcome が resolved 以外(未解決・エラー)のときは、先頭の注意書きを省かない。「探した範囲」も省かない。応答には 1〜2 分かかることがある。",
      inputSchema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            minLength: 1,
            maxLength: limits.maxQuestionChars,
            description: `1 回の呼び出しで完結する質問(必須。直近の発言だけで意味が通るなら、その発言をそのまま入れる。固有名詞・ID・エラーメッセージ・引用符の語句は変えない。${limits.maxQuestionChars} 文字まで)`,
          },
          userMessage: {
            type: "string",
            maxLength: limits.maxQuestionChars,
            description: `利用者の直近の発言そのもの(一字も変えずに写す。言い換え・要約・翻訳をしない。${limits.maxQuestionChars} 文字まで)`,
          },
          context: {
            type: "string",
            maxLength: MAX_CONTEXT_CHARS,
            description: `会話から分かっている前提(「それ」が指す対象など)。直近の発言だけでは意味が通らないときに限り書く。利用者の発言ではない(${MAX_CONTEXT_CHARS} 文字まで)`,
          },
          keepTerms: {
            type: "array",
            maxItems: MAX_KEEP_TERMS,
            items: { type: "string", maxLength: MAX_KEEP_TERM_CHARS },
            description: `変えてはならない語(固有名詞・ID・エラーメッセージ・引用符で囲まれた語句など)。利用者の発言から一字も変えずに写す(${MAX_KEEP_TERMS} 個まで、各 ${MAX_KEEP_TERM_CHARS} 文字まで)`,
          },
          sources: {
            type: "array",
            maxItems: knownSourceIds !== undefined ? knownSourceIds.length : MAX_REQUESTED_SOURCES,
            items:
              knownSourceIds !== undefined
                ? { type: "string", enum: [...knownSourceIds] }
                : { type: "string", minLength: 1, maxLength: MAX_SOURCE_ID_CHARS },
            description: "対象のソースの sourceId。利用者が対象のソースを指定したときだけ書く",
          },
          period: {
            type: "object",
            properties: {
              updatedAfter: {
                type: "string",
                description: "この日時以降に更新された文書(ISO 8601。例: 2026-01-01)",
              },
              updatedBefore: {
                type: "string",
                description: "この日時以前に更新された文書(ISO 8601)",
              },
            },
            additionalProperties: false,
            description: "利用者が期間を指定したときだけ書く",
          },
          depth: {
            type: "string",
            enum: [...ASK_DEPTHS],
            description:
              "探索の深さ(quick: 手早く / standard: 通常 / thorough: 徹底して)。利用者が求めたときだけ書く",
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
/** Gateway が runId を受け付けなかった(他人の run・期間外・不明な runId。理由は区別しない)。 */
export const FEEDBACK_NOT_ACCEPTED_TEXT =
  "この回答にはフィードバックを記録できません(質問した本人が、回答から一定の期間内に記録できます)。";
/** Gateway が公開するソースと --config の食い違い(S6)。ソース名はエコーしない。 */
export const CONFIG_MISMATCH_TEXT =
  "このサーバーの設定と Gateway が公開しているデータソースが一致しないため、処理を中止しました。管理者に連絡してください。";

/** ask の追加の引数が上限を超えた(値はエコーしない。ADR-026 決定1・6)。 */
export function argumentsTooLongText(maxQuestionChars: number): string {
  return `ツールの引数が上限を超えています(userMessage は ${maxQuestionChars} 文字まで、context は ${MAX_CONTEXT_CHARS} 文字まで、keepTerms は ${MAX_KEEP_TERMS} 個・各 ${MAX_KEEP_TERM_CHARS} 文字まで)。`;
}
/** sources に有効でないソースがある(ソース名はエコーしない)。 */
export const UNKNOWN_SOURCE_TEXT =
  "指定されたソースに、検索対象ではないものが含まれています。sources を省くか、検索対象のソースを指定してください。";

export function questionTooLongText(maxQuestionChars: number): string {
  return `質問が長すぎます(${maxQuestionChars} 文字まで)。短くして再度お試しください。`;
}

/**
 * ask が例外で終わったときの文言(分類ごと)。表にない分類は failure-text の分類ごとの文言に
 * 倒す(issue #38: 設定・接続先の誤りと一時的な障害を区別する)。
 */
const ASK_FAILURE_TEXTS: Readonly<Record<string, string>> = {
  audit_write_failed:
    "回答の記録(監査ログ)に失敗したため、回答を返せません。時間をおいて再度お試しください。解決しない場合は管理者に連絡してください。",
  gateway_unauthenticated:
    "Gateway が利用者の認証を拒否しました。サインインし直してから再度お試しください。",
  gateway_unavailable: "Gateway に接続できませんでした。時間をおいて再度お試しください。",
  gateway_timeout: "Gateway の応答がありませんでした。時間をおいて再度お試しください。",
  run_not_accepted:
    "回答の記録(run)を Gateway が受け付けなかったため、回答を返せません。時間をおいて再度お試しください。",
  orchestrator_credential_rejected:
    "このサーバーの設定(Orchestrator の資格情報)が Gateway と一致しないため、処理を中止しました。管理者に連絡してください。",
  rate_limited: "Gateway の要求回数の上限に達しました。時間をおいて再度お試しください。",
};
/** feedback の失敗の文言(分類ごと。既定は FEEDBACK_FAILURE_DEFAULT_TEXT)。 */
const FEEDBACK_FAILURE_TEXTS: Readonly<Record<string, string>> = {
  run_not_accepted: FEEDBACK_NOT_ACCEPTED_TEXT,
  gateway_unauthenticated: USER_UNVERIFIED_TEXT,
  orchestrator_credential_rejected:
    "このサーバーの設定(Orchestrator の資格情報)が Gateway と一致しないため、フィードバックを記録できません。管理者に連絡してください。",
  rate_limited: "要求が多すぎます。時間をおいて再度お試しください。",
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
  original: Answer,
  failureReason: string | null,
  retentionClass: RetentionClass,
): ToolOutcome {
  // 永続化できないソース(Slack)が有効な構成では、試した検索から query と filters を除く
  // (UI の履歴に残るため。ADR-026 決定5、不変条件7)。text の「探した範囲」も同じ値から作る
  const answer = retentionClass === "non_persistable" ? withoutSearchQueries(original) : original;
  const structuredContent: AskStructuredContent = {
    ...answer,
    // 出典欄と同じ規則で無害化する(m3)
    citations: answer.citations.map(structuredCitation),
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
  if (context.configMismatch === true) {
    return toolError("config_mismatch", CONFIG_MISMATCH_TEXT);
  }
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
  const extras = checkAskExtras(parsed.data, context);
  if (!extras.ok) {
    return extras.outcome;
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
      ...extras.value,
      gateway,
    });
    return askOutcomeFromAnswer(answer, failureReason, context.retentionClass);
  } catch (error) {
    const errorClass = errorClassOf(error);
    return toolError(errorClass, ASK_FAILURE_TEXTS[errorClass] ?? failureTextFor(errorClass));
  } finally {
    release();
    await gateway?.close().catch(() => undefined);
  }
}

type CheckedExtras =
  | { readonly ok: true; readonly value: AskInputExtras }
  | { readonly ok: false; readonly outcome: ToolOutcome };

/**
 * ask の追加の引数の上限と有効なソースを検証する(ADR-026 決定1)。拒否は固定文言で、値を
 * エコーしない(決定6)。前後の空白を除き、空の文字列・空の配列は省略と同じに扱う。
 */
function checkAskExtras(args: z.infer<typeof askArgsSchema>, context: ToolContext): CheckedExtras {
  const { limits } = context;
  const { period } = args;
  const extras = normalizeAskExtras({
    ...(args.userMessage !== undefined ? { userMessage: args.userMessage } : {}),
    ...(args.context !== undefined ? { context: args.context } : {}),
    ...(args.keepTerms !== undefined ? { keepTerms: args.keepTerms } : {}),
    ...(args.sources !== undefined ? { sources: args.sources } : {}),
    ...(period !== undefined
      ? {
          period: {
            ...(period.updatedAfter !== undefined ? { updatedAfter: period.updatedAfter } : {}),
            ...(period.updatedBefore !== undefined ? { updatedBefore: period.updatedBefore } : {}),
          },
        }
      : {}),
    ...(args.depth !== undefined ? { depth: args.depth } : {}),
  });
  // keepTerms の件数は空の要素・重複を除く前の数にも上限をかける(大きな配列を受けない)
  if (
    (extras.userMessage?.length ?? 0) > limits.maxQuestionChars ||
    (extras.context?.length ?? 0) > MAX_CONTEXT_CHARS ||
    (args.keepTerms?.length ?? 0) > MAX_KEEP_TERMS ||
    (extras.keepTerms ?? []).some((term) => term.length > MAX_KEEP_TERM_CHARS)
  ) {
    return {
      ok: false,
      outcome: toolError("arguments_too_long", argumentsTooLongText(limits.maxQuestionChars)),
    };
  }
  const known = context.knownSourceIds;
  if (
    (args.sources?.length ?? 0) > MAX_REQUESTED_SOURCES ||
    (args.sources ?? []).some(
      (sourceId) =>
        sourceId === "" ||
        sourceId.length > MAX_SOURCE_ID_CHARS ||
        (known !== undefined && !known.includes(sourceId)),
    )
  ) {
    return { ok: false, outcome: toolError("unknown_source", UNKNOWN_SOURCE_TEXT) };
  }
  if (extras.period !== undefined && !askPeriodSchema.safeParse(extras.period).success) {
    return { ok: false, outcome: toolError("invalid_request", INVALID_ARGUMENTS_TEXT) };
  }
  return { ok: true, value: extras };
}

async function runFeedback(context: ToolContext, args: unknown): Promise<ToolOutcome> {
  if (context.configMismatch === true) {
    return toolError("config_mismatch", CONFIG_MISMATCH_TEXT);
  }
  const parsed = feedbackArgsSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return toolError("invalid_request", INVALID_ARGUMENTS_TEXT);
  }
  const { runId, outcome } = parsed.data;
  // Gateway への往復を伴うため、ask とは別枠で同時実行数を抑える(待たせない)
  const release = context.limits.feedback.tryAcquire();
  if (release === undefined) {
    return toolError("busy", BUSY_TEXT);
  }
  const signal = AbortSignal.timeout(context.feedbackTimeoutMs ?? FEEDBACK_TIMEOUT_MS);
  let gateway: GatewayClient | undefined;
  try {
    // 利用者のトークンと Orchestrator の資格情報で Gateway の run API に申告する(ADR-019 決定8)。
    // 本人・期間の検証は Gateway(runId の署名)。signal に従わないクライアントでも期限で打ち切る
    gateway = context.createGatewayClient();
    await untilAborted(gateway.feedbackRun(runId, outcome, { signal }), signal);
    return {
      isError: false,
      text: FEEDBACK_RECORDED_TEXTS[outcome],
      structuredContent: { runId, outcome },
    };
  } catch (error) {
    const errorClass = errorClassOf(error);
    return toolError(
      errorClass,
      FEEDBACK_FAILURE_TEXTS[errorClass] ?? FEEDBACK_FAILURE_DEFAULT_TEXT,
    );
  } finally {
    release();
    await gateway?.close().catch(() => undefined);
  }
}
