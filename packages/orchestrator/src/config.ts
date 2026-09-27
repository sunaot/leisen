/**
 * Orchestrator の設定(T-007)。
 *
 * 探索ループの上限・価格表(orchestratorSettingsSchema)と、Claude API クライアントの
 * 設定(anthropicLlmSettingsSchema)を zod で定義する。値はすべて設定注入可能で、
 * コードに個社差分を入れない(不変条件8)。
 *
 * deployment.yaml との結合は後続タスクに委ねる。Gateway 側の `orchestrator`
 * セクション(packages/gateway/src/config/schema.ts の orchestratorSchema:
 * maxIterations 1..20 既定6、costLimitPerQuery 正数・任意)とフィールド名・範囲を
 * 揃えてあるので、結合時は `orchestratorSettingsSchema.parse({ ...config.orchestrator })`
 * の形でそのまま渡せる。
 */
import { z } from "zod";

/** 既定モデル(claude-api スキルの既定。変更は ADR-017 の確認事項)。 */
export const DEFAULT_MODEL = "claude-opus-5";
/**
 * 既定 effort。Claude Opus 5 の API 既定(high)と同じ値を明示する。明示しておくと、
 * 既定 effort が異なるモデル(例: Claude Opus 5.5 は medium)へ切り替えたときに
 * 挙動が黙って変わらない。
 */
export const DEFAULT_EFFORT = "high";
/** 非ストリーミング要求の max_tokens 既定(スキルの推奨値。thinking を含む上限)。 */
export const DEFAULT_MAX_TOKENS_PER_TURN = 16_000;
/** product-design §4.3 の初期値 N=6(deployment.yaml の既定と同じ)。 */
export const DEFAULT_MAX_ITERATIONS = 6;
export const DEFAULT_RUN_TIMEOUT_MS = 120_000;
/** 上限到達後に回答を促す最終ターン1回分の時間枠。 */
export const DEFAULT_FINAL_TURN_TIMEOUT_MS = 60_000;
/** Claude API 1リクエストのタイムアウト(SDK の再試行ごとに適用される)。 */
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;
/** SDK の既定と同じ再試行回数(429 / 5xx / 接続失敗)。 */
export const DEFAULT_LLM_MAX_RETRIES = 2;
/** 質問文の上限文字数(過大入力でコスト・ログを膨らませない)。 */
export const MAX_QUESTION_CHARS = 10_000;

export const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof effortSchema>;

/** 1モデルの単価(通貨単位/100万トークン)。既定値は USD。 */
export const modelPriceSchema = z.strictObject({
  inputPerMTok: z.number().min(0),
  outputPerMTok: z.number().min(0),
  /** キャッシュ書き込み(5分TTL)。通常は入力単価の1.25倍 */
  cacheWritePerMTok: z.number().min(0),
  /** キャッシュ読み出し。通常は入力単価の0.1倍 */
  cacheReadPerMTok: z.number().min(0),
});
export type ModelPrice = z.infer<typeof modelPriceSchema>;

/**
 * 既定の価格表(USD / 100万トークン)。claude-api スキルの価格表(2026-06-24 時点の
 * キャッシュ)から、既定モデル・fallbacks の既定の受け先・同世代の主要モデルを載せる。
 * キャッシュ書き込みは5分TTLの1.25倍、読み出しは0.1倍(Claude Opus 5.5 は $0.20、
 * Claude Fable 5.1 は $0.25 とスキルに明記)。導入先の課金通貨・契約単価に合わせて
 * 設定で差し替える。載っていないモデルは費用を概算できない(警告になる)。
 */
export const DEFAULT_PRICING: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5": {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheWritePerMTok: 6.25,
    cacheReadPerMTok: 0.5,
  },
  "claude-opus-5-5": {
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheWritePerMTok: 5,
    cacheReadPerMTok: 0.2,
  },
  "claude-fable-5-1": {
    inputPerMTok: 10,
    outputPerMTok: 50,
    cacheWritePerMTok: 12.5,
    cacheReadPerMTok: 0.25,
  },
  "claude-opus-4-8": {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheWritePerMTok: 6.25,
    cacheReadPerMTok: 0.5,
  },
  "claude-sonnet-5": {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheWritePerMTok: 2.5,
    cacheReadPerMTok: 0.2,
  },
  "claude-haiku-4-5": {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheWritePerMTok: 1.25,
    cacheReadPerMTok: 0.1,
  },
};

/**
 * 未接続ソースの接続導線(ADR-010 決定3)。実際の導線(接続画面の URL・UI)は
 * チャットUI(T-009)が確定させて注入する。既定値はプレースホルダ。
 */
export const DEFAULT_CONNECT_GUIDANCE =
  "これらのソースも検索対象にするには、データソースの接続画面から接続してください。";

/** 探索ループの設定。 */
export const orchestratorSettingsSchema = z.strictObject({
  /**
   * LLM のツール呼び出しターン数の上限(submit_answer だけのターンは数えない)。
   * 反復による API 呼び出し増幅の抑止(TM-D3)。範囲は deployment.yaml と同じ
   */
  maxIterations: z.number().int().min(1).max(20).default(DEFAULT_MAX_ITERATIONS),
  /** 探索フェーズの時間上限(ms、run 開始から)。到達すると進行中の呼び出しを中断する */
  runTimeoutMs: z.number().int().min(1).default(DEFAULT_RUN_TIMEOUT_MS),
  /** 上限到達後の最終ターン(回答の提出を促す1回)の時間枠(ms) */
  finalTurnTimeoutMs: z
    .number()
    .int()
    .min(1)
    .default(DEFAULT_FINAL_TURN_TIMEOUT_MS),
  /**
   * 1質問あたりの LLM 費用の上限(pricing の通貨単位)。省略時は上限なし。
   * usage × 価格表の概算で判定し、超過したターンの次は最終ターンのみ行う
   * (最終ターンの分だけ上限を超えうる)
   */
  costLimitPerQuery: z.number().positive().optional(),
  /** 1ターンの max_tokens(adaptive thinking の思考分を含む) */
  maxTokensPerTurn: z
    .number()
    .int()
    .min(1)
    // 非ストリーミング要求の実用上限(これを超える値はストリーミング実装が前提)
    .max(64_000)
    .default(DEFAULT_MAX_TOKENS_PER_TURN),
  /** モデルID → 単価。応答の model で引く */
  pricing: z
    .record(z.string().min(1), modelPriceSchema)
    .default({ ...DEFAULT_PRICING }),
  /** 未接続ソースを回答で案内するときの接続導線の文言(プレースホルダ、T-009で確定) */
  connectGuidance: z.string().min(1).default(DEFAULT_CONNECT_GUIDANCE),
});
export type OrchestratorSettings = z.infer<typeof orchestratorSettingsSchema>;
export type OrchestratorSettingsInput = z.input<typeof orchestratorSettingsSchema>;

/** Claude API クライアント(AnthropicLlmClient)の設定。 */
export const anthropicLlmSettingsSchema = z.strictObject({
  model: z.string().min(1).default(DEFAULT_MODEL),
  effort: effortSchema.default(DEFAULT_EFFORT),
  /** 1リクエストのタイムアウト(ms)。SDK は再試行ごとにこの時間を使う */
  timeoutMs: z.number().int().min(1).default(DEFAULT_LLM_TIMEOUT_MS),
  /** SDK の自動再試行回数(429 / 5xx / 接続失敗) */
  maxRetries: z.number().int().min(0).max(10).default(DEFAULT_LLM_MAX_RETRIES),
  /**
   * server-side fallbacks(beta `server-side-fallback-2026-07-01` + `fallbacks: "default"`)。
   * 安全分類器の refusal 時に API 側で別モデルが同じ要求を処理する。既定 off
   * (README「server-side fallbacks」と ADR-017 決定6を参照)
   */
  serverSideFallbacks: z.boolean().default(false),
});
export type AnthropicLlmSettings = z.infer<typeof anthropicLlmSettingsSchema>;
export type AnthropicLlmSettingsInput = z.input<typeof anthropicLlmSettingsSchema>;
