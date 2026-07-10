/**
 * Deployment Profileのスキーマバージョン移行(T-010、ADR-005)。
 *
 * 設定スキーマはバージョン管理し、アップグレード時のマイグレーションを
 * 製品の一部として提供する。移行はzodパース前の生オブジェクトに対して行う
 * (旧バージョンの設定は現行スキーマを通らないため)。
 */
import { CURRENT_SCHEMA_VERSION } from "./schema.js";
import { DeploymentConfigError, type ConfigIssue } from "./validate.js";

/**
 * バージョンNの生設定をN+1形式に変換する関数。schemaVersionフィールドの
 * 増分は枠組み側(applyMigrations)が行うため、移行関数は構造変換のみ書く。
 */
export type ConfigMigration = (
  raw: Readonly<Record<string, unknown>>,
) => Record<string, unknown>;

/** fromVersion → 移行関数。スキーマ変更時にここへ追記する(現行v1のため空)。 */
export const MIGRATIONS: Readonly<Record<number, ConfigMigration>> = {};

export interface MigrateOptions {
  /** テスト用注入。省略時は MIGRATIONS */
  migrations?: Readonly<Record<number, ConfigMigration>>;
  /** テスト用注入。省略時は CURRENT_SCHEMA_VERSION */
  targetVersion?: number;
}

function schemaVersionIssue(message: string): ConfigIssue {
  return { code: "schema_violation", path: "schemaVersion", message };
}

/**
 * 生設定(YAMLパース直後)を現行スキーマバージョンまで順次移行する。
 * - schemaVersion 欠落・非整数は拒否(暗黙の既定を持たせない: どの版として
 *   書かれたか不明な設定を推測で解釈しない)
 * - 現行より新しいバージョンは拒否(新しい設定を古いビルドで黙って
 *   読み違えない)
 */
export function applyMigrations(
  raw: unknown,
  options: MigrateOptions = {},
): Record<string, unknown> {
  const migrations = options.migrations ?? MIGRATIONS;
  const targetVersion = options.targetVersion ?? CURRENT_SCHEMA_VERSION;

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new DeploymentConfigError([
      schemaVersionIssue("deployment config must be a YAML mapping at the top level"),
    ]);
  }

  const version = (raw as Record<string, unknown>)["schemaVersion"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new DeploymentConfigError([
      schemaVersionIssue(
        `schemaVersion must be a positive integer (current: ${targetVersion})`,
      ),
    ]);
  }
  if (version > targetVersion) {
    throw new DeploymentConfigError([
      schemaVersionIssue(
        `schemaVersion ${version} is newer than this build supports (${targetVersion}); ` +
          "upgrade the gateway before applying this config",
      ),
    ]);
  }

  let current = raw as Record<string, unknown>;
  for (let v = version; v < targetVersion; v++) {
    const migration = migrations[v];
    if (migration === undefined) {
      throw new DeploymentConfigError([
        schemaVersionIssue(
          `no migration path from schemaVersion ${v} to ${v + 1}`,
        ),
      ]);
    }
    current = { ...migration(current), schemaVersion: v + 1 };
  }
  return current;
}
