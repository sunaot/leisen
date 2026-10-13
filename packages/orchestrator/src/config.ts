/**
 * Orchestrator の設定(T-007)。
 *
 * 探索ループの上限・価格表(orchestratorSettingsSchema)と、LLM バックエンドの設定
 * (llmBackendConfigSchema: provider で Anthropic / OpenAI 互換を選ぶ。ADR-017 決定1)を
 * zod で定義する。値はすべて設定注入可能で、コードに個社差分を入れない(不変条件8)。
 *
 * deployment.yaml との結合は後続タスクに委ねる。Gateway 側の `orchestrator`
 * セクション(packages/gateway/src/config/schema.ts の orchestratorSchema:
 * maxIterations 1..20 既定6、costLimitPerQuery 正数・任意)とフィールド名・範囲を
 * 揃えてあるので、結合時は `orchestratorSettingsSchema.parse({ ...config.orchestrator })`
 * の形でそのまま渡せる。
 */
import { z } from "zod";
import { LLM_PROVIDERS, type LlmProvider } from "./llm/types.js";

export const llmProviderSchema = z.enum(LLM_PROVIDERS);

/** Anthropic バックエンドの既定モデル(claude-api スキルの既定。変更は ADR-017 の確認事項)。 */
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
/** 1ターンに実行するツール呼び出しの上限(セキュリティレビュー 2026-09-27 m1)。 */
export const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 8;
/** 1 run に実行する LLM 起点のツール呼び出しの上限(describe フェーズは数えない。m1)。 */
export const DEFAULT_MAX_TOOL_CALLS_PER_RUN = 40;
export const DEFAULT_RUN_TIMEOUT_MS = 120_000;
/** 上限到達後に回答を促す最終ターン1回分の時間枠。 */
export const DEFAULT_FINAL_TURN_TIMEOUT_MS = 60_000;
/** Claude API 1リクエストのタイムアウト(SDK の再試行ごとに適用される)。 */
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;
/**
 * OpenAI 互換 1リクエストのタイムアウト。ローカル推論(LM Studio 等)は1ターンの生成が
 * 遅いことがあるため Claude API より長くする。タイムアウトは再試行しない
 */
export const DEFAULT_OPENAI_COMPATIBLE_TIMEOUT_MS = 120_000;
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
 * Anthropic バックエンドの既定の価格表(USD / 100万トークン)。claude-api スキルの
 * 価格表(2026-06-24 時点のキャッシュ)から、既定モデル・fallbacks の既定の受け先・
 * 同世代の主要モデルを載せる。キャッシュ書き込みは5分TTLの1.25倍、読み出しは0.1倍
 * (Claude Opus 5.5 は $0.20、Claude Fable 5.1 は $0.25 とスキルに明記)。導入先の
 * 課金通貨・契約単価に合わせて設定で差し替える。載っていないモデルは費用を概算できない
 * (警告になる)。OpenAI 互換バックエンドの既定の価格表は空(ローカル推論の費用は
 * 「不明」のまま扱い、0 とみなさない)。
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

/** モデルID → 単価(1プロバイダ分)。 */
export const modelPricingSchema = z.record(z.string().min(1), modelPriceSchema);
export type ModelPricing = Readonly<Record<string, ModelPrice>>;

/**
 * 価格表(プロバイダ → モデルID → 単価)。応答の model で引く(完全一致を優先し、
 * 日付スナップショット付き ID は元の ID の行を使う。cost.ts の findModelPrice)。
 * 同じモデル名でもプロバイダが違えば別の行(ローカル推論と商用 API を取り違えない)。
 */
export const pricingSchema = z.strictObject({
  anthropic: modelPricingSchema.default(() => ({ ...DEFAULT_PRICING })),
  openai_compatible: modelPricingSchema.default(() => ({})),
});
export type Pricing = z.infer<typeof pricingSchema>;

/** プロバイダの価格表を取り出す。 */
export function pricingFor(pricing: Pricing, provider: LlmProvider): ModelPricing {
  return pricing[provider];
}

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
  /**
   * 1ターンに実行するツール呼び出しの上限(応答内の順で先頭から)。超えた分は実行せず
   * is_error の tool_result(固定文言)で返し、warnings に記録する(TM-D3 の増幅抑止)
   */
  maxToolCallsPerTurn: z
    .number()
    .int()
    .min(1)
    .max(64)
    .default(DEFAULT_MAX_TOOL_CALLS_PER_TURN),
  /**
   * 1 run に実行する LLM 起点のツール呼び出しの上限(最初の describe は数えない)。
   * 超えた分の扱いは maxToolCallsPerTurn と同じ
   */
  maxToolCallsPerRun: z
    .number()
    .int()
    .min(1)
    .max(1_000)
    .default(DEFAULT_MAX_TOOL_CALLS_PER_RUN),
  /** 探索フェーズの時間上限(ms、run 開始から)。到達すると進行中の呼び出しを中断する */
  runTimeoutMs: z.number().int().min(1).default(DEFAULT_RUN_TIMEOUT_MS),
  /** 上限到達後の最終ターン(回答の提出を促す1回)の時間枠(ms) */
  finalTurnTimeoutMs: z
    .number()
    .int()
    .min(1)
    .default(DEFAULT_FINAL_TURN_TIMEOUT_MS),
  /**
   * 1質問あたりの LLM 費用の上限(pricing の通貨単位)。省略時は上限なし(費用が不明な
   * バックエンドでも探索を止めない)。usage × 価格表の概算で判定し、超過したターンの次は
   * 最終ターンのみ行う(最終ターンの分だけ上限を超えうる)。設定時に費用が不明
   * (価格表にないモデル・usage なし)なら確認できないため到達扱い(fail-closed)
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
  /** プロバイダ → モデルID → 単価。LLM クライアントの provider と応答の model で引く */
  pricing: pricingSchema.prefault({}),
  /** 未接続ソースを回答で案内するときの接続導線の文言(プレースホルダ、T-009で確定) */
  connectGuidance: z.string().min(1).default(DEFAULT_CONNECT_GUIDANCE),
});
export type OrchestratorSettings = z.infer<typeof orchestratorSettingsSchema>;
export type OrchestratorSettingsInput = z.input<typeof orchestratorSettingsSchema>;

/** Anthropic Messages API クライアント(AnthropicLlmClient)の設定。 */
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

// ---------------------------------------------------------------------------
// OpenAI 互換 Chat Completions(OpenAiCompatibleLlmClient)
// ---------------------------------------------------------------------------

/** reasoning_effort の段階(gpt-oss 等が受ける low / medium / high に限る)。 */
export const reasoningEffortSchema = z.enum(["low", "medium", "high"]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

/**
 * http を許すループバックのホスト(URL.hostname の表記。IPv6 は角括弧付き)。Gateway の
 * 接続先(gateway/mcp-client.ts、m3)と同じ規則にそろえる。
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * LLM バックエンドのベース URL。ループバック以外は https 必須(会話には利用者の権限で取得した
 * 文書の本文が入り、API キーも載る。Gateway の接続先と同じ規則)。資格情報(user:pass@)・
 * フラグメントは載せさせない(ログに残りやすい。キーは apiKeyEnv の環境変数から Authorization
 * ヘッダで送る)。エラーメッセージに入力値を含めない(クエリに秘密が載っている可能性がある)。
 */
export const httpBaseUrlSchema = z.string().refine(
  (value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (
      (url.protocol === "https:" ||
        (url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname))) &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
    );
  },
  {
    message:
      "https の URL を指定する(http はループバックのみ。資格情報・フラグメントを含めない)",
  },
);

/**
 * allowInsecureHttp(leisen-ask の `--allow-insecure-upstream`)のときだけ使うベース URL の検証。ループバック
 * 以外の http も通す(開発・評価用途。例: compose のコンテナからホストの LM Studio へ
 * `http://host.docker.internal:1234/v1`)。平文の http では会話(利用者の権限で取得した文書の本文)
 * とキーが経路上で読めるため、本番(NODE_ENV=production)では使わせない(leisen-ask の引数の解釈と
 * OpenAiCompatibleLlmClient の構築で拒否する)。資格情報・フラグメントを載せない規則は
 * httpBaseUrlSchema と同じ。エラーメッセージに入力値を含めない。
 */
export const insecureHttpBaseUrlSchema = z.string().refine(
  (value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
    );
  },
  {
    message: "http / https の URL を指定する(資格情報・フラグメントを含めない)",
  },
);

/**
 * API キーを入れた環境変数の名前。キーの値そのものを設定に書かせないため、名前の形
 * (英数字と _)に限る。エラーメッセージに入力値を含めない。
 */
export const envVarNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, {
    message: "API キーを入れた環境変数の名前を指定する(キーの値そのものは書かない)",
  });

/** 秘密情報を運びうる・トランスポートが管理するヘッダ(extraHeaders に置かせない)。 */
const RESERVED_HEADER_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "api-key",
  "host",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
]);

/** RFC 9110 の token(ヘッダ名)。 */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;

/**
 * 追加の HTTP ヘッダ(経路の識別など秘密でないもの)。認証系のヘッダは置けない
 * (キーは apiKeyEnv で渡す。設定ファイルに秘密を書かない、不変条件6)。
 */
export const extraHeadersSchema = z
  .record(
    z.string().regex(HEADER_NAME_PATTERN, { message: "ヘッダ名が不正" }),
    // 表示可能な ASCII とタブに限る(改行によるヘッダ注入を防ぎ、fetch が送れない値を
    // 設定時に弾く。送信時に弾かれると接続失敗と区別できない)
    z
      .string()
      .max(1_024)
      .regex(/^[\t\x20-\x7e]*$/, { message: "ヘッダ値は表示可能な ASCII 文字に限る" }),
  )
  .refine(
    (headers) =>
      Object.keys(headers).every((name) => !RESERVED_HEADER_NAMES.has(name.toLowerCase())),
    {
      message:
        "認証・トランスポート系のヘッダ(Authorization 等)は extraHeaders に置けない(キーは apiKeyEnv で渡す)",
    },
  );

/** OpenAI 互換 Chat Completions クライアント(OpenAiCompatibleLlmClient)の設定の項目。 */
const openAiCompatibleLlmSettingsShape = {
  /**
   * ベース URL(例: LM Studio は http://localhost:1234/v1)。`/chat/completions` を足して呼ぶ。
   * 形の検証は allowInsecureHttp で分岐する(refineBaseUrl)
   */
  baseUrl: z.string(),
  /** モデル名(LM Studio ならロードしたモデルの ID。GET {baseUrl}/models で確認できる) */
  model: z.string().min(1),
  /**
   * API キーを入れた環境変数の名前(任意。LM Studio 等のキー不要なサーバーでは省略)。
   * 指定時は Authorization: Bearer で送る。値をコード・設定ファイルに置かない
   */
  apiKeyEnv: envVarNameSchema.optional(),
  /** 1リクエストのタイムアウト(ms)。タイムアウトは再試行しない */
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .default(DEFAULT_OPENAI_COMPATIBLE_TIMEOUT_MS),
  /** 再試行回数(429 / 5xx / 接続失敗のみ。指数バックオフ、Retry-After を尊重) */
  maxRetries: z.number().int().min(0).max(10).default(DEFAULT_LLM_MAX_RETRIES),
  /**
   * reasoning_effort(対応モデルのみ。gpt-oss 等)。指定したときだけ送る
   * (未指定なら能力フラグ effort は false)
   */
  reasoningEffort: reasoningEffortSchema.optional(),
  /** 追加の HTTP ヘッダ(秘密でないもの) */
  extraHeaders: extraHeadersSchema.optional(),
  /** サーバーでロードしたコンテキスト長(参照用。能力フラグ maxContextTokens に出す) */
  maxContextTokens: z.number().int().positive().optional(),
  /**
   * ループバック以外の http のベース URL を許す(leisen-ask の `--allow-insecure-upstream`。開発・評価用途)。
   * 本番(NODE_ENV=production)では OpenAiCompatibleLlmClient の構築を拒否する
   */
  allowInsecureHttp: z.boolean().optional(),
};

/**
 * ベース URL の検証(入口で分岐する)。allowInsecureHttp が true のときだけ
 * insecureHttpBaseUrlSchema(ループバック以外の http も通す)、それ以外は httpBaseUrlSchema。
 */
function refineBaseUrl(
  settings: { readonly baseUrl: string; readonly allowInsecureHttp?: boolean | undefined },
  ctx: z.RefinementCtx,
): void {
  const schema =
    settings.allowInsecureHttp === true ? insecureHttpBaseUrlSchema : httpBaseUrlSchema;
  const checked = schema.safeParse(settings.baseUrl);
  if (!checked.success) {
    ctx.addIssue({
      code: "custom",
      path: ["baseUrl"],
      // スキーマの固定文言だけを使う(入力値を含めない)
      message: checked.error.issues[0]?.message ?? "invalid base URL",
    });
  }
}

/** OpenAI 互換 Chat Completions クライアント(OpenAiCompatibleLlmClient)の設定。 */
export const openAiCompatibleLlmSettingsSchema = z
  .strictObject(openAiCompatibleLlmSettingsShape)
  .superRefine(refineBaseUrl);
export type OpenAiCompatibleLlmSettings = z.infer<typeof openAiCompatibleLlmSettingsSchema>;
export type OpenAiCompatibleLlmSettingsInput = z.input<
  typeof openAiCompatibleLlmSettingsSchema
>;

// ---------------------------------------------------------------------------
// LLM バックエンドの選択(createLlmClient の入力)
// ---------------------------------------------------------------------------

export const anthropicBackendConfigSchema = anthropicLlmSettingsSchema.extend({
  provider: z.literal("anthropic"),
});
export const openAiCompatibleBackendConfigSchema = z
  .strictObject({
    ...openAiCompatibleLlmSettingsShape,
    provider: z.literal("openai_compatible"),
  })
  .superRefine(refineBaseUrl);

/**
 * LLM バックエンドの設定(ADR-017 決定1)。provider で実装を選ぶ。
 * - anthropic: Anthropic Messages API(公式 SDK。資格情報は SDK が環境から解決)
 * - openai_compatible: OpenAI 互換 Chat Completions(LM Studio / vLLM / llama.cpp / Ollama 等)
 */
export const llmBackendConfigSchema = z.discriminatedUnion("provider", [
  anthropicBackendConfigSchema,
  openAiCompatibleBackendConfigSchema,
]);
export type LlmBackendConfig = z.infer<typeof llmBackendConfigSchema>;
export type LlmBackendConfigInput = z.input<typeof llmBackendConfigSchema>;
