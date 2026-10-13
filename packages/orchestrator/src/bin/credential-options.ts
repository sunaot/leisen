/**
 * Orchestrator の資格情報(Gateway と共有する秘密。ADR-019 決定3)— 環境変数
 * LEISEN_ORCHESTRATOR_CREDENTIAL。leisen-ask(1問)と leisen-ask serve の両方で受ける。
 *
 * - Gateway の run API(POST /runs 等)と、runId を申告する tools/call は、利用者本人の Bearer に
 *   加えてこの資格情報を求める(利用者が自分のトークンで run API を直接呼び、AnswerRun を偽る
 *   ことを防ぐ)。Gateway 側は deployment.yaml の gateway.runs.orchestratorCredentialEnv
 *   (既定 LEISEN_ORCHESTRATOR_CREDENTIAL)で同じ値を読む
 * - 未設定なら、NODE_ENV=production では固定文言で拒否する(終了コード 2)。それ以外では
 *   開発用の既定値(Gateway の DEV_ORCHESTRATOR_CREDENTIAL。Gateway も未設定のときに同じ値を使う)
 *   で動き、WARNING を 1 行出す
 * - 値はログ・エラー・使い方の表示に出さない(不変条件6)
 */
import { DEV_ORCHESTRATOR_CREDENTIAL, MIN_ORCHESTRATOR_CREDENTIAL_CHARS } from "@leisen/gateway";
import { isProductionEnv } from "./upstream-options.js";

export const ORCHESTRATOR_CREDENTIAL_ENV = "LEISEN_ORCHESTRATOR_CREDENTIAL";

export const ORCHESTRATOR_CREDENTIAL_REQUIRED_IN_PRODUCTION =
  `NODE_ENV=production では環境変数 ${ORCHESTRATOR_CREDENTIAL_ENV}(Gateway と共有する Orchestrator の資格情報、` +
  `${MIN_ORCHESTRATOR_CREDENTIAL_CHARS} 文字以上)が必須です。Gateway の gateway.runs.orchestratorCredentialEnv が指す環境変数と同じ値を設定してください。`;

export const ORCHESTRATOR_CREDENTIAL_TOO_SHORT =
  `環境変数 ${ORCHESTRATOR_CREDENTIAL_ENV} は ${MIN_ORCHESTRATOR_CREDENTIAL_CHARS} 文字以上にしてください(Gateway と同じ値)。`;

export const ORCHESTRATOR_CREDENTIAL_DEV_DEFAULT_WARNING =
  `WARNING: 環境変数 ${ORCHESTRATOR_CREDENTIAL_ENV} が未設定のため、開発用の既定の資格情報を使います` +
  "(Gateway も未設定で動いているときだけ通ります。手元の開発以外では Gateway と同じ値を設定してください)";

export const ORCHESTRATOR_CREDENTIAL_USAGE_LINE =
  `  run の記録(AnswerRun)は Gateway の run API に申告します。環境変数 ${ORCHESTRATOR_CREDENTIAL_ENV} に` +
  " Gateway と共有する Orchestrator の資格情報を設定してください(未設定なら開発用の既定値で WARNING。NODE_ENV=production では必須)。";

type Env = Readonly<Record<string, string | undefined>>;

export type OrchestratorCredentialOption =
  | { readonly ok: true; readonly credential: string; readonly source: "env" | "dev-default" }
  | { readonly ok: false; readonly message: string };

/** 環境変数から資格情報を決める(値はメッセージに含めない)。 */
export function resolveOrchestratorCredential(env: Env): OrchestratorCredentialOption {
  const value = env[ORCHESTRATOR_CREDENTIAL_ENV];
  if (value === undefined || value === "") {
    if (isProductionEnv(env)) {
      return { ok: false, message: ORCHESTRATOR_CREDENTIAL_REQUIRED_IN_PRODUCTION };
    }
    return { ok: true, credential: DEV_ORCHESTRATOR_CREDENTIAL, source: "dev-default" };
  }
  if (value.length < MIN_ORCHESTRATOR_CREDENTIAL_CHARS || /\s/.test(value)) {
    return { ok: false, message: ORCHESTRATOR_CREDENTIAL_TOO_SHORT };
  }
  if (value === DEV_ORCHESTRATOR_CREDENTIAL && isProductionEnv(env)) {
    return { ok: false, message: ORCHESTRATOR_CREDENTIAL_REQUIRED_IN_PRODUCTION };
  }
  return { ok: true, credential: value, source: value === DEV_ORCHESTRATOR_CREDENTIAL ? "dev-default" : "env" };
}

/** 起動ログ用の説明(値は出さない)。 */
export function describeOrchestratorCredential(source: "env" | "dev-default"): string {
  return source === "env" ? `env ${ORCHESTRATOR_CREDENTIAL_ENV}` : "development default";
}
