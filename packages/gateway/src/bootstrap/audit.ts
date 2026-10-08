/**
 * 監査シンクの解決(起動コード。deployment.yaml の audit.sink、ADR-011)。
 *
 * - "stdout" → StdoutDebugAuditSink(開発用。at-least-once を保証しない)。
 *   生クエリ原文はプロセス内メモリ(InMemoryRawQueryStore)
 * - "jsonl"  → BufferedAuditSink(JsonlAuditStore(audit.jsonl.path))。
 *   rawQueryPath があれば JsonlRawQueryStore、なければ InMemoryRawQueryStore
 * - それ以外 → unknown_audit_sink で起動を拒否する(書き先の分からない監査は
 *   fail-closed の前提を崩すため、黙って stdout 等に倒さない)
 *
 * 相対パスは設定ファイルの所在ディレクトリ基準。出力先は起動時に書き込み可能か
 * 確かめる(ディレクトリの誤記を起動後の監査欠落として初めて知る事態を避ける。
 * BufferedAuditSink は書けない間もバッファ容量までは呼び出しを受理するため)。
 * 確認はアクセス権の照会のみで、ファイルは作らない(kp-gateway validate を
 * 副作用なしに保つ)。
 *
 * 未実装(T-012 以降): 保持期限(retentionDays / rawQueryRetentionDays)に基づく
 * 定期削除ジョブ。InMemoryRawQueryStore はプロセスの存続中に単調増加する
 * (再起動で消える)。
 */
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { JsonlAuditStore, JsonlRawQueryStore } from "../audit/jsonl.js";
import {
  InMemoryRawQueryStore,
  type RawQueryStore,
} from "../audit/rawquery.js";
import {
  BufferedAuditSink,
  StdoutDebugAuditSink,
  type AuditSink,
} from "../audit/sink.js";
import {
  AUDIT_SINK_JSONL,
  AUDIT_SINK_STDOUT,
  type AuditConfig,
} from "../config/schema.js";
import {
  DeploymentConfigError,
  type ConfigIssue,
} from "../config/validate.js";

export interface ResolvedAuditSink {
  readonly sink: AuditSink;
  readonly rawQueryStore: RawQueryStore;
  /** 起動ログ用の説明(出力先のパスを含む。秘密情報なし) */
  readonly description: string;
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "unknown error";
}

/** 追記先として使えるか(親ディレクトリが存在して書き込み可能、既存なら通常ファイルで書き込み可能)。 */
async function writableFileIssue(
  file: string,
  path: string,
): Promise<ConfigIssue | undefined> {
  const invalid = (message: string): ConfigIssue => ({
    code: "audit_sink_options_invalid",
    path,
    message,
  });
  try {
    await access(dirname(file), constants.W_OK);
  } catch (error) {
    return invalid(
      `directory of ${file} does not exist or is not writable (${errorCode(error)})`,
    );
  }
  try {
    if (!(await stat(file)).isFile()) {
      return invalid(`${file} is not a regular file`);
    }
    await access(file, constants.W_OK);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      return invalid(`${file} is not writable (${errorCode(error)})`);
    }
  }
  return undefined;
}

/**
 * audit セクションを監査シンクと rawQuery ストアに解決する。不備は
 * DeploymentConfigError(全件)で投げる。
 */
export async function resolveAuditSink(
  audit: AuditConfig,
  configDir: string,
): Promise<ResolvedAuditSink> {
  if (audit.sink === AUDIT_SINK_STDOUT) {
    return {
      sink: new StdoutDebugAuditSink(),
      rawQueryStore: new InMemoryRawQueryStore(),
      description: "stdout (development only; not at-least-once)",
    };
  }
  if (audit.sink !== AUDIT_SINK_JSONL) {
    throw new DeploymentConfigError([
      {
        code: "unknown_audit_sink",
        path: "audit.sink",
        message:
          `unknown audit sink "${audit.sink}" ` +
          `(supported: "${AUDIT_SINK_STDOUT}", "${AUDIT_SINK_JSONL}")`,
      },
    ]);
  }
  if (audit.jsonl === undefined) {
    // 通常は静的検証(validate.ts)で先に拒否される。検証を経ない設定への防波堤
    throw new DeploymentConfigError([
      {
        code: "audit_sink_options_missing",
        path: "audit.jsonl.path",
        message: `audit.sink "${AUDIT_SINK_JSONL}" requires audit.jsonl.path`,
      },
    ]);
  }

  const auditPath = resolve(configDir, audit.jsonl.path);
  const rawQueryPath =
    audit.jsonl.rawQueryPath !== undefined
      ? resolve(configDir, audit.jsonl.rawQueryPath)
      : undefined;
  const issues: ConfigIssue[] = [];
  const auditIssue = await writableFileIssue(auditPath, "audit.jsonl.path");
  if (auditIssue) {
    issues.push(auditIssue);
  }
  if (rawQueryPath !== undefined) {
    if (rawQueryPath === auditPath) {
      // 生クエリ原文は監査ログ本体と保持期間・閲覧経路を分ける(ADR-011 §3)
      issues.push({
        code: "audit_sink_options_invalid",
        path: "audit.jsonl.rawQueryPath",
        message: "rawQueryPath must be a different file from the audit log (ADR-011 §3)",
      });
    } else {
      const rawIssue = await writableFileIssue(
        rawQueryPath,
        "audit.jsonl.rawQueryPath",
      );
      if (rawIssue) {
        issues.push(rawIssue);
      }
    }
  }
  if (issues.length > 0) {
    throw new DeploymentConfigError(issues);
  }

  return {
    sink: new BufferedAuditSink(new JsonlAuditStore(auditPath)),
    rawQueryStore:
      rawQueryPath !== undefined
        ? new JsonlRawQueryStore(rawQueryPath)
        : new InMemoryRawQueryStore(),
    description:
      `jsonl ${auditPath}` +
      (rawQueryPath !== undefined
        ? ` (raw queries: ${rawQueryPath})`
        : " (raw queries: in memory only)"),
  };
}
