/**
 * leisen-ask の LLM バックエンド指定(T-007、ADR-017 決定1)。
 *
 *   --llm anthropic|openai-compatible   既定 anthropic(環境変数 LEISEN_LLM_PROVIDER)
 *   --model <モデル>                     両方(環境変数 LEISEN_LLM_MODEL。openai-compatible では必須)
 *   --effort low..max                    anthropic のみ
 *   --llm-base-url <URL>                 openai-compatible のみ・必須(環境変数 LEISEN_LLM_BASE_URL)
 *   --llm-api-key-env <環境変数名>        openai-compatible のみ(キー不要のサーバーでは省略)
 *   --reasoning-effort low|medium|high   openai-compatible のみ(対応モデルのみ)
 *
 * ループバック以外の http のベース URL は、呼び出し側が --allow-insecure-upstream
 * (bin/upstream-options.ts)を解釈して options.allowInsecureHttp で許したときだけ通す
 * (httpBaseUrlSchema は変えず、ここで入口を分岐する)。
 *
 * フラグは環境変数より優先する。LEISEN_LLM_BASE_URL は openai-compatible のときだけ使う
 * (Claude API の接続先は SDK 標準の ANTHROPIC_BASE_URL で変える。残った環境変数で
 * Claude の資格情報を別の宛先へ送らないため)。エラーメッセージは固定文言で、入力値
 * (URL・環境変数名・キーの誤入力)をエコーしない。
 */
import {
  effortSchema,
  envVarNameSchema,
  httpBaseUrlSchema,
  insecureHttpBaseUrlSchema,
  llmBackendConfigSchema,
  reasoningEffortSchema,
  type LlmBackendConfigInput,
} from "../config.js";
import type { LlmErrorClass } from "../errors.js";
import type { LlmProvider } from "../llm/types.js";

export const CREDENTIALS_REQUIRED_MESSAGE =
  "Claude API の資格情報が必要です。ANTHROPIC_API_KEY を設定するか、`ant auth login` でプロファイルを作成してから再実行してください。";
export const CREDENTIALS_REJECTED_MESSAGE =
  "Claude API が資格情報を拒否しました(401)。ANTHROPIC_API_KEY などの資格情報を確認してください。";
export const OPENAI_COMPATIBLE_CREDENTIALS_REQUIRED_MESSAGE =
  "OpenAI 互換エンドポイントの資格情報が必要です。API キーを入れた環境変数の名前を --llm-api-key-env で指定し、その環境変数を設定してから再実行してください(LM Studio などキー不要のサーバーでは指定しません)。";
export const OPENAI_COMPATIBLE_CREDENTIALS_REJECTED_MESSAGE =
  "OpenAI 互換エンドポイントが資格情報を拒否しました(401)。--llm-api-key-env で指定した環境変数のキーを確認してください。";

/** USAGE に足す行。 */
export const LLM_USAGE_LINES: readonly string[] = [
  "  LLM バックエンド: [--llm anthropic|openai-compatible](既定 anthropic。環境変数 LEISEN_LLM_PROVIDER)",
  "    openai-compatible: --llm-base-url <URL>(LEISEN_LLM_BASE_URL) --model <モデル名>(LEISEN_LLM_MODEL)",
  "                       [--llm-api-key-env <環境変数名>] [--reasoning-effort low|medium|high]",
  "    例(LM Studio): --llm openai-compatible --llm-base-url http://localhost:1234/v1 --model <モデル名>",
];

/** parseArgs で受ける LLM 関係の値。 */
export interface LlmCliValues {
  readonly llm?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly "llm-base-url"?: string | undefined;
  readonly "llm-api-key-env"?: string | undefined;
  readonly "reasoning-effort"?: string | undefined;
}

export interface LlmCliParseOptions {
  /**
   * ループバック以外の http のベース URL を許す(--allow-insecure-upstream を解釈した結果。
   * NODE_ENV=production の拒否は解釈する側が済ませている)
   */
  readonly allowInsecureHttp?: boolean;
}

export type LlmCliParseResult =
  | { readonly ok: true; readonly config: LlmBackendConfigInput }
  | { readonly ok: false; readonly message: string };

const PROVIDER_NAMES: Readonly<Record<string, LlmProvider>> = {
  anthropic: "anthropic",
  "openai-compatible": "openai_compatible",
  openai_compatible: "openai_compatible",
};

function fail(message: string): LlmCliParseResult {
  return { ok: false, message };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

/** フラグと環境変数から LLM バックエンドの設定(createLlmClient の入力)を組む。 */
export function parseLlmCliOptions(
  values: LlmCliValues,
  env: Readonly<Record<string, string | undefined>>,
  options: LlmCliParseOptions = {},
): LlmCliParseResult {
  const allowInsecureHttp = options.allowInsecureHttp === true;
  const providerName = values.llm ?? nonEmpty(env["LEISEN_LLM_PROVIDER"]) ?? "anthropic";
  const provider = Object.hasOwn(PROVIDER_NAMES, providerName)
    ? PROVIDER_NAMES[providerName]
    : undefined;
  if (provider === undefined) {
    return fail("--llm(または環境変数 LEISEN_LLM_PROVIDER)は anthropic / openai-compatible のいずれかです。");
  }
  const model = values.model ?? nonEmpty(env["LEISEN_LLM_MODEL"]);

  if (provider === "anthropic") {
    if (values["llm-base-url"] !== undefined) {
      return fail(
        "--llm-base-url は --llm openai-compatible 用です(Claude API の接続先は ANTHROPIC_BASE_URL で変えます)。",
      );
    }
    if (values["llm-api-key-env"] !== undefined) {
      return fail(
        "--llm-api-key-env は --llm openai-compatible 用です(Claude API の資格情報は ANTHROPIC_API_KEY 等の環境から解決します)。",
      );
    }
    if (values["reasoning-effort"] !== undefined) {
      return fail("--reasoning-effort は --llm openai-compatible 用です(Claude では --effort を使います)。");
    }
    let effort: string | undefined;
    if (values.effort !== undefined) {
      const parsed = effortSchema.safeParse(values.effort);
      if (!parsed.success) {
        return fail("--effort は low / medium / high / xhigh / max のいずれかです。");
      }
      effort = parsed.data;
    }
    const config = {
      provider,
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
    };
    const checked = llmBackendConfigSchema.safeParse(config);
    return checked.success
      ? { ok: true, config: config as LlmBackendConfigInput }
      : fail("--model の指定が不正です。");
  }

  if (values.effort !== undefined) {
    return fail("--effort は --llm anthropic 用です(OpenAI 互換では --reasoning-effort を使います)。");
  }
  const baseUrl = values["llm-base-url"] ?? nonEmpty(env["LEISEN_LLM_BASE_URL"]);
  if (baseUrl === undefined) {
    return fail(
      "--llm openai-compatible では --llm-base-url(または環境変数 LEISEN_LLM_BASE_URL)でベース URL を指定してください(例: LM Studio は http://localhost:1234/v1)。",
    );
  }
  // 検証の入口で分岐する: --allow-insecure-upstream のときだけループバック以外の http も通す
  if (allowInsecureHttp) {
    if (!insecureHttpBaseUrlSchema.safeParse(baseUrl).success) {
      return fail(
        "--llm-base-url は http / https の URL で指定してください(資格情報・フラグメントを含めない)。",
      );
    }
  } else if (!httpBaseUrlSchema.safeParse(baseUrl).success) {
    return fail(
      "--llm-base-url は https の URL で指定してください(http はループバック localhost / 127.0.0.1 / [::1] のみ。資格情報を含めない)。" +
        "開発・評価用途で別ホストの http に接続する場合は --allow-insecure-upstream を付けます(本番では使えません)。",
    );
  }
  if (model === undefined || model === "") {
    return fail(
      "--llm openai-compatible では --model(または環境変数 LEISEN_LLM_MODEL)でモデル名を指定してください(LM Studio なら GET <ベース URL>/models で確認できます)。",
    );
  }
  const apiKeyEnv = values["llm-api-key-env"];
  if (apiKeyEnv !== undefined && !envVarNameSchema.safeParse(apiKeyEnv).success) {
    return fail(
      "--llm-api-key-env には API キーを入れた環境変数の名前を指定してください(キーの値そのものは指定しない)。",
    );
  }
  const reasoningEffort = values["reasoning-effort"];
  if (reasoningEffort !== undefined && !reasoningEffortSchema.safeParse(reasoningEffort).success) {
    return fail("--reasoning-effort は low / medium / high のいずれかです。");
  }
  const config = {
    provider,
    baseUrl,
    model,
    ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(allowInsecureHttp ? { allowInsecureHttp: true } : {}),
  };
  const checked = llmBackendConfigSchema.safeParse(config);
  return checked.success
    ? { ok: true, config: config as LlmBackendConfigInput }
    : fail("LLM バックエンドの指定が不正です。");
}

/** 資格情報の不備で終えるときの表示(終了コード 2)。該当しなければ undefined。 */
export function credentialsMessageFor(
  provider: LlmProvider,
  errorClass: LlmErrorClass | undefined,
): string | undefined {
  if (errorClass === "llm_credentials_missing") {
    return provider === "anthropic"
      ? CREDENTIALS_REQUIRED_MESSAGE
      : OPENAI_COMPATIBLE_CREDENTIALS_REQUIRED_MESSAGE;
  }
  if (errorClass === "llm_authentication_failed") {
    return provider === "anthropic"
      ? CREDENTIALS_REJECTED_MESSAGE
      : OPENAI_COMPATIBLE_CREDENTIALS_REJECTED_MESSAGE;
  }
  return undefined;
}

/** 失敗時に添える確認の手がかり(OpenAI 互換のみ。ローカルサーバーの典型的なつまずき)。 */
export function backendHintFor(
  provider: LlmProvider,
  errorClass: LlmErrorClass | undefined,
): string | undefined {
  if (provider !== "openai_compatible") {
    return undefined;
  }
  switch (errorClass) {
    case "llm_unavailable":
    case "llm_timeout":
      return "OpenAI 互換エンドポイントに接続できないか、応答がありませんでした。--llm-base-url のサーバー(LM Studio ならローカルサーバー)が起動していて、モデルがロードされているか確認してください。";
    case "llm_invalid_request":
      return "OpenAI 互換エンドポイントが要求を拒否しました。--model のモデル名(GET <ベース URL>/models で確認)と、ツール呼び出しに対応したモデルかを確認してください。";
    case "llm_context_window_exceeded":
      return "会話がモデルのコンテキスト長を超えました。サーバー側でモデルをより長いコンテキスト長でロードしてください。";
    default:
      return undefined;
  }
}
