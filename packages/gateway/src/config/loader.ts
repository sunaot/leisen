/**
 * Deployment Profileローダー(T-010)。
 *
 * 読み込みパイプライン: YAMLパース → バージョン移行 → zodスキーマ検証 →
 * 静的検証(危険設定の拒否)。どの段でも失敗は DeploymentConfigError に
 * 集約し、起動を止める(ADR-005: 危険設定は起動時拒否)。
 */
import { readFileSync } from "node:fs";
import YAML, { YAMLParseError } from "yaml";
import type { IdpAdapterConfig } from "../idp/factory.js";
import type { RetentionConfig } from "@kp/audit";
import { applyMigrations, type MigrateOptions } from "./migrate.js";
import {
  deploymentConfigSchema,
  type DeploymentConfig,
  type IdpAdapterConfigSection,
} from "./schema.js";
import {
  assertValidDeploymentConfig,
  DeploymentConfigError,
  type ConfigIssue,
  type ValidateOptions,
} from "./validate.js";

export interface LoadOptions extends ValidateOptions, MigrateOptions {}

/**
 * YAMLテキストから検証済みのDeploymentConfigを得る。
 * capability連動の検証を効かせるには options.capabilities を渡すこと
 * (Gateway起動パスでは必須。省略はテスト・ツール用)。
 */
export function parseDeploymentConfig(
  yamlText: string,
  options: LoadOptions = {},
): DeploymentConfig {
  let raw: unknown;
  try {
    // prettyErrors: false — 既定の整形は該当行の抜粋(コードフレーム)をメッセージに含める
    raw = YAML.parse(yamlText, { prettyErrors: false });
  } catch (error) {
    // YAML のエラー文は該当行の抜粋やファイル中のトークン(アンカー名・タグ名等)を含みうるため
    // 載せない。誤って書かれた秘密の値が stderr や kp-ask --json の stdout に出る経路を作らない
    // (不変条件6)。位置はエラーコードと行・列だけで示す
    throw new DeploymentConfigError([
      { code: "schema_violation", path: "(file)", message: describeYamlParseError(error, yamlText) },
    ]);
  }

  const migrated = applyMigrations(raw, options);

  const parsed = deploymentConfigSchema.safeParse(migrated);
  if (!parsed.success) {
    // schema.ts は秘密情報のフィールドを持たないため、zodのissue(パスと
    // 受領値の型情報を含む)をそのままエラーに載せてよい(不変条件6)
    const issues: ConfigIssue[] = parsed.error.issues.map((issue) => ({
      code: "schema_violation",
      path: issue.path.map(String).join(".") || "(root)",
      message: issue.message,
    }));
    throw new DeploymentConfigError(issues);
  }

  assertValidDeploymentConfig(parsed.data, options);
  return parsed.data;
}

/**
 * YAML の構文エラーを、ファイルの内容を含めずにエラーコードと位置(行・列)だけで表す。
 * `error.message` は使わない(該当行の抜粋・アンカー名・タグ名などファイル由来の文字列を含みうる)。
 */
function describeYamlParseError(error: unknown, yamlText: string): string {
  if (!(error instanceof YAMLParseError)) return "invalid YAML";
  const code: string = typeof error.code === "string" && error.code.length > 0 ? error.code : "PARSE_ERROR";
  const offset = Array.isArray(error.pos) ? error.pos[0] : undefined;
  if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) {
    return `invalid YAML (${code})`;
  }
  const head = yamlText.slice(0, offset);
  const line = (head.match(/\n/g)?.length ?? 0) + 1;
  const column = offset - (head.lastIndexOf("\n") + 1) + 1;
  return `invalid YAML (${code} at line ${line}, column ${column})`;
}

/** deployment.yaml をファイルから読み込む。 */
export function loadDeploymentConfig(
  filePath: string,
  options: LoadOptions = {},
): DeploymentConfig {
  return parseDeploymentConfig(readFileSync(filePath, "utf8"), options);
}

/**
 * 設定のIdPセクションを idp/factory.ts の IdpAdapterConfig に解決する。
 * 秘密情報は設定ファイルに置かず環境変数名(clientSecretEnv)で参照する
 * 方式のため、ここで初めて値を読む。戻り値は clientSecret を含むので、
 * ログ・エラーに載せないこと(不変条件6)。
 */
export function resolveIdpAdapterConfig(
  adapter: IdpAdapterConfigSection,
  env: Readonly<Record<string, string | undefined>> = process.env,
): IdpAdapterConfig {
  switch (adapter.kind) {
    case "mock":
      return { kind: "mock" };
    case "keycloak": {
      const clientSecret = env[adapter.clientSecretEnv];
      if (clientSecret === undefined || clientSecret === "") {
        // エラーには環境変数の「名前」のみを載せる(値は存在しないか空)
        throw new DeploymentConfigError([
          {
            code: "secret_env_missing",
            path: "idp.adapter.clientSecretEnv",
            message: `environment variable "${adapter.clientSecretEnv}" is not set or empty`,
          },
        ]);
      }
      return {
        kind: "keycloak",
        baseUrl: adapter.baseUrl,
        realm: adapter.realm,
        clientId: adapter.clientId,
        clientSecret,
        allowedClients: adapter.allowedClients,
        requireAudience: adapter.requireAudience,
        ...(adapter.allowedIssuers !== undefined
          ? { allowedIssuers: adapter.allowedIssuers }
          : {}),
        ...(adapter.timeoutMs !== undefined ? { timeoutMs: adapter.timeoutMs } : {}),
      };
    }
  }
}

/** 監査セクションを保持期間設定(audit/retention.ts)に写す。 */
export function retentionConfigFrom(
  audit: DeploymentConfig["audit"],
): RetentionConfig {
  return {
    auditRetentionDays: audit.retentionDays,
    rawQueryRetentionDays: audit.rawQueryRetentionDays,
    telemetryRetentionDays: audit.telemetryRetentionDays,
  };
}
