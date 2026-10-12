/**
 * run API(ADR-019)の実行時の構成の解決(起動コード)。
 *
 * deployment.yaml(gateway.runs)は秘密を環境変数名で参照する。ここで初めて値を読み、
 * RunRuntime(署名鍵の鍵束・Orchestrator の資格情報・期間・上限)に写す。戻り値は秘密を含む
 * ので、ログ・エラー・設定の出力(kp-gateway validate 等)に載せない(不変条件6)。
 *
 * - 署名鍵: 32 バイト以上のランダム値(hex / base64 / base64url)。kid は鍵の SHA-256 の先頭 8 文字。
 *   NODE_ENV=production では、未設定・復号不能・短い・開発用の例の値を起動拒否にする。それ以外で
 *   未設定なら起動ごとの一時鍵を使う(WARNING。再起動で期限内の runId が無効になる)
 * - 1 つ前の鍵: 設定があれば同じ規則で読み、現行と kid が違うことを確かめる
 * - Orchestrator の資格情報: 16 文字以上の、空白を含まない印字可能な ASCII(HTTP ヘッダで運ぶ。
 *   kp-ask 側の規則と同じ)。NODE_ENV=production では未設定・開発用の既定値を起動拒否にする。
 *   それ以外で未設定なら開発用の既定値(DEV_ORCHESTRATOR_CREDENTIAL。WARNING)
 * - docId の HMAC 鍵(audit.docIdHmacKeyEnv): privateScopeDocIds が hashed で、プライベート
 *   スコープを持つソースが有効なら必須(secret_env_missing)。run API の finish が引用を不可逆化
 *   するのに使う(決定5)。設定があれば 16 文字以上、本番では dev-only- で始まる値を拒否する
 * - 3 つの秘密(署名鍵・1 つ前の鍵・Orchestrator の資格情報・docId の鍵)は互いに別の値であること
 *   (run_secret_reused)。同じ値を使い回すと Orchestrator が署名鍵を持つのと同じになる
 * - フィードバックの期間は runId の有効期間より短くできない(run_feedback_window_too_short)
 */
import { createHash, randomBytes } from "node:crypto";
import type { ConfigIssue } from "../config/validate.js";
import type { DeploymentConfig } from "../config/schema.js";
import { createRunIdKeyRing, MIN_RUN_ID_KEY_BYTES, type RunIdSigningKey } from "../run/index.js";
import { MIN_ORCHESTRATOR_CREDENTIAL_CHARS, type RunRuntime } from "../proxy/runs.js";

/**
 * 開発用の Orchestrator の資格情報の既定値(production 以外で環境変数が未設定のとき)。
 * kp-ask も同じ既定値を使う。NODE_ENV=production では拒否される(dev_only_in_production)。
 */
export const DEV_ORCHESTRATOR_CREDENTIAL = "dev-only-orchestrator-credential";

/**
 * 開発用の runId 署名鍵の例(deploy/compose/.env.example の値)。base64url として復号できる
 * 52 文字(39 バイト)で、他のダミー秘密と同じく dev-only- で始める。公開済みの値なので
 * NODE_ENV=production では拒否される(dev_only_in_production)。
 */
export const DEV_RUN_ID_KEY_EXAMPLE = "dev-only-run-id-signing-key-not-for-production-00001";

/** 開発用のダミー秘密の接頭辞(deploy/compose/.env.example の規約)。本番では docId の鍵にも使えない。 */
export const DEV_SECRET_PREFIX = "dev-only-";

/** docId の HMAC 鍵の最小長(文字)。 */
export const MIN_DOC_ID_HMAC_KEY_CHARS = 16;

export interface ResolvedRunRuntime {
  readonly runtime: RunRuntime;
  /** 引用 docId の HMAC 鍵(hashed のとき)。秘密 */
  readonly docIdHmacKey: string | undefined;
  /** 起動ログ用の説明(秘密情報なし) */
  readonly description: string;
  /** 起動は拒否しないが注意が要る点(秘密情報なし) */
  readonly warnings: readonly string[];
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** hex / base64 / base64url の鍵素材を復号する(形が合わなければ undefined)。 */
export function decodeKeyMaterial(value: string): Buffer | undefined {
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    return Buffer.from(trimmed, "hex");
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    return Buffer.from(trimmed, "base64");
  }
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return Buffer.from(trimmed, "base64url");
  }
  return undefined;
}

/** kid: 鍵の SHA-256 の先頭 8 文字(鍵の値は復元できない)。 */
export function kidOf(key: Uint8Array): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

function signingKeyFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  envName: string,
  path: string,
  issues: ConfigIssue[],
  warnings: string[],
  options: { readonly required: boolean },
): RunIdSigningKey | undefined {
  const value = env[envName];
  if (value === undefined || value.trim() === "") {
    if (!options.required) {
      return undefined;
    }
    if (isProduction()) {
      issues.push({
        code: "run_signing_key_missing",
        path,
        message: `environment variable "${envName}" (runId signing key, 32+ random bytes) is not set; it is required when NODE_ENV=production`,
      });
      return undefined;
    }
    warnings.push(
      `run API: environment variable "${envName}" is not set; using an ephemeral runId signing key (runIds do not survive a restart; set it for anything beyond local development)`,
    );
    const key = randomBytes(MIN_RUN_ID_KEY_BYTES);
    return { kid: kidOf(key), key };
  }
  const key = decodeKeyMaterial(value);
  if (key === undefined || key.byteLength < MIN_RUN_ID_KEY_BYTES) {
    issues.push({
      code: "run_signing_key_invalid",
      path,
      message: `environment variable "${envName}" must hold at least ${MIN_RUN_ID_KEY_BYTES} random bytes encoded as hex, base64 or base64url (e.g. openssl rand -base64 32)`,
    });
    return undefined;
  }
  if (value.trim() === DEV_RUN_ID_KEY_EXAMPLE) {
    if (isProduction()) {
      issues.push({
        code: "dev_only_in_production",
        path,
        message: `environment variable "${envName}" holds the published development example key; it is disabled in production builds (NODE_ENV=production)`,
      });
      return undefined;
    }
    warnings.push(
      `run API: environment variable "${envName}" holds the published development example key; generate a deployment-specific key before exposing the gateway`,
    );
  }
  return { kid: kidOf(key), key };
}

function orchestratorCredentialFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  envName: string,
  path: string,
  issues: ConfigIssue[],
  warnings: string[],
): { readonly credential: string; readonly source: "env" | "dev-default" } | undefined {
  const value = env[envName];
  if (value === undefined || value === "") {
    if (isProduction()) {
      issues.push({
        code: "run_orchestrator_credential_missing",
        path,
        message: `environment variable "${envName}" (orchestrator credential shared with kp-ask) is not set; it is required when NODE_ENV=production`,
      });
      return undefined;
    }
    warnings.push(
      `run API: environment variable "${envName}" is not set; using the development-only orchestrator credential (kp-ask uses the same default; set it for anything beyond local development)`,
    );
    return { credential: DEV_ORCHESTRATOR_CREDENTIAL, source: "dev-default" };
  }
  if (value.length < MIN_ORCHESTRATOR_CREDENTIAL_CHARS || !/^[\x21-\x7e]+$/.test(value)) {
    issues.push({
      code: "run_orchestrator_credential_invalid",
      path,
      message: `environment variable "${envName}" must hold at least ${MIN_ORCHESTRATOR_CREDENTIAL_CHARS} printable ASCII characters without whitespace (it is sent as an HTTP header)`,
    });
    return undefined;
  }
  if (value === DEV_ORCHESTRATOR_CREDENTIAL) {
    if (isProduction()) {
      issues.push({
        code: "dev_only_in_production",
        path,
        message: `environment variable "${envName}" holds the development-only orchestrator credential; it is disabled in production builds (NODE_ENV=production)`,
      });
      return undefined;
    }
    warnings.push(
      `run API: environment variable "${envName}" holds the development-only orchestrator credential; generate a deployment-specific value before exposing the gateway`,
    );
  }
  return { credential: value, source: "env" };
}

/** hashed の HMAC 鍵が要る構成か(プライベートスコープを持つソースが有効で hashed)。 */
export function docIdHmacKeyRequired(config: DeploymentConfig): boolean {
  return (
    config.audit.privateScopeDocIds === "hashed" &&
    config.connectors.some((c) => c.enabled && c.privateScopes !== "excluded")
  );
}

/**
 * run API の実行時の構成を環境変数から解決する。不備は issues に足し、1 つでもあれば undefined。
 */
export function resolveRunRuntime(
  config: DeploymentConfig,
  env: Readonly<Record<string, string | undefined>>,
  issues: ConfigIssue[],
): ResolvedRunRuntime | undefined {
  const runs = config.gateway.runs;
  const warnings: string[] = [];
  const before = issues.length;

  const current = signingKeyFromEnv(env, runs.signingKeyEnv, "gateway.runs.signingKeyEnv", issues, warnings, {
    required: true,
  });
  const previous = signingKeyFromEnv(
    env,
    runs.previousSigningKeyEnv,
    "gateway.runs.previousSigningKeyEnv",
    issues,
    warnings,
    { required: false },
  );
  if (current !== undefined && previous !== undefined && previous.kid === current.kid) {
    issues.push({
      code: "run_signing_key_invalid",
      path: "gateway.runs.previousSigningKeyEnv",
      message: `environment variables "${runs.signingKeyEnv}" and "${runs.previousSigningKeyEnv}" hold the same key; unset the previous key when it is not being rotated`,
    });
  }
  const credential = orchestratorCredentialFromEnv(
    env,
    runs.orchestratorCredentialEnv,
    "gateway.runs.orchestratorCredentialEnv",
    issues,
    warnings,
  );

  let docIdHmacKey = env[config.audit.docIdHmacKeyEnv];
  if (docIdHmacKey === "") {
    docIdHmacKey = undefined;
  }
  if (docIdHmacKey === undefined && docIdHmacKeyRequired(config)) {
    issues.push({
      code: "secret_env_missing",
      path: "audit.docIdHmacKeyEnv",
      message: `environment variable "${config.audit.docIdHmacKeyEnv}" is not set; it is required to hash cited document IDs of private-scope sources (audit.privateScopeDocIds: hashed, ADR-019 決定5)`,
    });
  }
  if (docIdHmacKey !== undefined) {
    if (docIdHmacKey.length < MIN_DOC_ID_HMAC_KEY_CHARS) {
      issues.push({
        code: "doc_id_hmac_key_invalid",
        path: "audit.docIdHmacKeyEnv",
        message: `environment variable "${config.audit.docIdHmacKeyEnv}" must hold at least ${MIN_DOC_ID_HMAC_KEY_CHARS} characters (e.g. openssl rand -hex 32)`,
      });
    } else if (docIdHmacKey.startsWith(DEV_SECRET_PREFIX)) {
      if (isProduction()) {
        issues.push({
          code: "dev_only_in_production",
          path: "audit.docIdHmacKeyEnv",
          message: `environment variable "${config.audit.docIdHmacKeyEnv}" holds a development-only value (${DEV_SECRET_PREFIX}…); it is disabled in production builds (NODE_ENV=production)`,
        });
      } else {
        warnings.push(
          `audit: environment variable "${config.audit.docIdHmacKeyEnv}" holds a development-only value (${DEV_SECRET_PREFIX}…); generate a deployment-specific key before exposing the gateway`,
        );
      }
    }
  }

  // 秘密の使い回し: 署名鍵・1 つ前の鍵・Orchestrator の資格情報・docId の鍵は互いに別の値(値そのものは
  // 比べるだけで、メッセージには環境変数名だけを出す)
  const secretEnvNames = [
    runs.signingKeyEnv,
    runs.previousSigningKeyEnv,
    runs.orchestratorCredentialEnv,
    config.audit.docIdHmacKeyEnv,
  ];
  const seen = new Map<string, string>();
  for (const envName of secretEnvNames) {
    const value = env[envName];
    if (value === undefined || value.trim() === "") continue;
    const other = seen.get(value.trim());
    const isKeyRotationPair =
      (other === runs.signingKeyEnv && envName === runs.previousSigningKeyEnv) ||
      (other === runs.previousSigningKeyEnv && envName === runs.signingKeyEnv);
    // 現行と 1 つ前の鍵が同じ場合は上の kid の検査(run_signing_key_invalid)が報告する
    if (other !== undefined && other !== envName && !isKeyRotationPair) {
      issues.push({
        code: "run_secret_reused",
        path: "gateway.runs",
        message: `environment variables "${other}" and "${envName}" hold the same value; the runId signing key, the orchestrator credential and the docId HMAC key must be distinct secrets (ADR-019)`,
      });
    }
    seen.set(value.trim(), envName);
  }
  if (runs.feedbackWindowSec < runs.ttlSec) {
    issues.push({
      code: "run_feedback_window_too_short",
      path: "gateway.runs.feedbackWindowSec",
      message: `feedbackWindowSec (${runs.feedbackWindowSec}) must not be shorter than ttlSec (${runs.ttlSec}); feedback is accepted from issuance for the whole run lifetime`,
    });
  }

  if (issues.length > before || current === undefined || credential === undefined) {
    return undefined;
  }
  const keys = createRunIdKeyRing({ current, previous });
  const runtime: RunRuntime = {
    keys,
    orchestratorCredential: Buffer.from(credential.credential, "utf8"),
    ttlSeconds: runs.ttlSec,
    feedbackWindowSeconds: runs.feedbackWindowSec,
    limits: {
      maxQuestionChars: runs.limits.maxQuestionChars,
      maxCitations: runs.limits.maxCitations,
      maxSearchedSources: runs.limits.maxSearchedSources,
      maxIdChars: runs.limits.maxIdChars,
    },
    maxBodyBytes: runs.limits.maxBodyBytes,
    maxRequestsPerUserPerMinute: runs.limits.maxRequestsPerUserPerMinute,
  };
  const keySource = env[runs.signingKeyEnv] ? `env ${runs.signingKeyEnv}` : "ephemeral";
  const description =
    `/runs (signing key: ${keySource}, kid ${keys.current.kid}` +
    `${keys.previous !== undefined ? ` + previous kid ${keys.previous.kid}` : ""}; ` +
    `orchestrator credential: ${credential.source === "env" ? `env ${runs.orchestratorCredentialEnv}` : "development default"}; ` +
    `ttl ${runs.ttlSec}s, feedback window ${runs.feedbackWindowSec}s)`;
  return { runtime, docIdHmacKey, description, warnings };
}
