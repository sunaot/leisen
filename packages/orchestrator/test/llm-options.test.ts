/**
 * leisen-ask の LLM バックエンド指定(bin/llm-options.ts)の単体テスト。
 * フラグと環境変数(LEISEN_LLM_PROVIDER / LEISEN_LLM_BASE_URL / LEISEN_LLM_MODEL)の組み立て、
 * プロバイダと合わない指定の拒否、入力値をエコーしないこと、資格情報の案内を検証する。
 */
import { describe, expect, it } from "vitest";
import {
  CREDENTIALS_REJECTED_MESSAGE,
  CREDENTIALS_REQUIRED_MESSAGE,
  OPENAI_COMPATIBLE_CREDENTIALS_REJECTED_MESSAGE,
  OPENAI_COMPATIBLE_CREDENTIALS_REQUIRED_MESSAGE,
  backendHintFor,
  credentialsMessageFor,
  parseLlmCliOptions,
  type LlmCliValues,
} from "../src/bin/llm-options.js";

const LM_STUDIO = "http://localhost:1234/v1";

function parse(values: LlmCliValues, env: Record<string, string> = {}) {
  return parseLlmCliOptions(values, env);
}

describe("LLM バックエンドの指定", () => {
  it("既定は anthropic(--model / --effort はそのまま渡す)", () => {
    expect(parse({})).toEqual({ ok: true, config: { provider: "anthropic" } });
    expect(parse({ model: "claude-opus-5-5", effort: "low" })).toEqual({
      ok: true,
      config: { provider: "anthropic", model: "claude-opus-5-5", effort: "low" },
    });
  });

  it("openai-compatible: ベース URL・モデル・任意の apiKeyEnv / reasoningEffort", () => {
    expect(
      parse({
        llm: "openai-compatible",
        "llm-base-url": LM_STUDIO,
        model: "openai/gpt-oss-20b",
        "llm-api-key-env": "MY_LLM_KEY",
        "reasoning-effort": "medium",
      }),
    ).toEqual({
      ok: true,
      config: {
        provider: "openai_compatible",
        baseUrl: LM_STUDIO,
        model: "openai/gpt-oss-20b",
        apiKeyEnv: "MY_LLM_KEY",
        reasoningEffort: "medium",
      },
    });
  });

  it("環境変数でも指定でき、フラグが優先する", () => {
    const env = {
      LEISEN_LLM_PROVIDER: "openai_compatible",
      LEISEN_LLM_BASE_URL: LM_STUDIO,
      LEISEN_LLM_MODEL: "env-model",
    };
    expect(parse({}, env)).toEqual({
      ok: true,
      config: { provider: "openai_compatible", baseUrl: LM_STUDIO, model: "env-model" },
    });
    expect(parse({ model: "flag-model" }, env)).toMatchObject({
      ok: true,
      config: { model: "flag-model" },
    });
    expect(parse({ llm: "anthropic" }, env)).toEqual({
      ok: true,
      // LEISEN_LLM_BASE_URL は openai-compatible のときだけ使う(Claude の資格情報を別の宛先へ送らない)
      config: { provider: "anthropic", model: "env-model" },
    });
  });

  it.each([
    [{ llm: "gemini" }, "--llm"],
    [{ llm: "openai-compatible", model: "m" }, "--llm-base-url"],
    [{ llm: "openai-compatible", "llm-base-url": LM_STUDIO }, "--model"],
    [{ llm: "openai-compatible", "llm-base-url": LM_STUDIO, model: "" }, "--model"],
    [{ llm: "openai-compatible", "llm-base-url": LM_STUDIO, model: "m", effort: "high" }, "--effort は --llm anthropic 用"],
    [{ llm: "openai-compatible", "llm-base-url": LM_STUDIO, model: "m", "reasoning-effort": "max" }, "--reasoning-effort"],
    [{ "llm-base-url": LM_STUDIO }, "--llm-base-url は --llm openai-compatible 用"],
    [{ "llm-api-key-env": "MY_LLM_KEY" }, "--llm-api-key-env は --llm openai-compatible 用"],
    [{ "reasoning-effort": "low" }, "--reasoning-effort は --llm openai-compatible 用"],
    [{ effort: "ultra" }, "--effort"],
    [{ model: "" }, "--model"],
  ] as const)("不備のある指定 %j は拒否(%s)", (values, message) => {
    const result = parse(values);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain(message);
  });

  it.each([
    [{ "llm-base-url": "ftp://dev-only-host/v1" }],
    [{ "llm-base-url": "http://dev-only-gpu-box.example.test/v1" }],
    [{ "llm-base-url": "http://user:dev-only-password@localhost:1234/v1" }],
    [{ "llm-api-key-env": "dev-only-key-value!" }],
  ])("不正な値 %j はエコーしない", (values) => {
    const result = parse({ llm: "openai-compatible", model: "m", "llm-base-url": LM_STUDIO, ...values });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).not.toContain("dev-only");
  });
});

describe("資格情報の案内・確認の手がかり", () => {
  it("プロバイダごとの資格情報の案内(終了コード 2 の表示)", () => {
    expect(credentialsMessageFor("anthropic", "llm_credentials_missing")).toBe(CREDENTIALS_REQUIRED_MESSAGE);
    expect(credentialsMessageFor("anthropic", "llm_authentication_failed")).toBe(CREDENTIALS_REJECTED_MESSAGE);
    expect(credentialsMessageFor("openai_compatible", "llm_credentials_missing")).toBe(
      OPENAI_COMPATIBLE_CREDENTIALS_REQUIRED_MESSAGE,
    );
    expect(credentialsMessageFor("openai_compatible", "llm_authentication_failed")).toBe(
      OPENAI_COMPATIBLE_CREDENTIALS_REJECTED_MESSAGE,
    );
    expect(credentialsMessageFor("openai_compatible", "llm_unavailable")).toBeUndefined();
    expect(credentialsMessageFor("anthropic", undefined)).toBeUndefined();
  });

  it("OpenAI 互換の接続失敗・要求拒否には確認の手がかりを添える(Anthropic には添えない)", () => {
    expect(backendHintFor("openai_compatible", "llm_unavailable")).toContain("--llm-base-url");
    expect(backendHintFor("openai_compatible", "llm_invalid_request")).toContain("--model");
    expect(backendHintFor("openai_compatible", "llm_context_window_exceeded")).toContain("コンテキスト長");
    expect(backendHintFor("anthropic", "llm_unavailable")).toBeUndefined();
    expect(backendHintFor("openai_compatible", "llm_refusal")).toBeUndefined();
  });
});
