/**
 * AnswerRun の JSONL 監査シンク(T-021、ADR-018 決定4)。
 *
 * kp-ask serve(Orchestrator サービス)は AnswerRun を Gateway の監査 JSONL とは別の
 * ファイルに追記する(同じスキーマ。昇格判定レポートは --audit を複数回指定して両方を
 * 読む)。Gateway の JSONL は Gateway プロセスが単独で追記する前提のため、別プロセスから
 * 同じファイルへは書かない。Gateway の audit/jsonl.ts(JsonlAuditStore)に倣う:
 *
 * - 1行1レコードの JSON(ラッパーを付けない。promotion-report の parseAuditRecord で
 *   読める形)。書く前に validateRecord で検証する(禁止フィールド・型にないキーを書かない)
 * - 追記のみ(O_APPEND)。新規作成するファイルのモードは 0600(所有者のみ読み書き)
 * - 書き込みはプロセス内で直列化する(pending → 最終状態 → userFeedback の順序を保つ)
 * - 失敗は例外で返す。Orchestrator が audit_write_failed に写して run を失敗させる
 *   (fail-closed、ADR-011 §4)。バッファ・再試行はしない(書けない間は回答を返さない)
 * - ディレクトリは作らない(パスの誤記を黙って新しい場所への記録にしない)
 * - 途切れた行: 追記の途中で失敗した場合、次の追記は改行から始める(有効な行を不完全な
 *   行に連結させない。空行が生じうるため読み手は空行を読み飛ばす)
 * - 同じ runId の行が複数ある(pending → 最終状態 → フィードバック)。読み手は runId で
 *   重複を除き、後の行を採る(auditRecordIdempotencyKey。promotion-report も同じ)
 *
 * 運用上の制約: 1ファイルに書き込むのは1プロセスに限る。保持期限による削除(ADR-013 §3)は
 * Gateway の監査 JSONL と同じくファイルのローテーションと世代削除で行う(本モジュールの範囲外)。
 */
import { constants } from "node:fs";
import { access, appendFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { validateRecord, type AuditRecord, type AuditSink } from "@kp/gateway";

/** 新規作成するファイルのモード(所有者のみ読み書き)。 */
const FILE_MODE = 0o600;

export class AnswerRunJsonlSink implements AuditSink {
  #queue: Promise<unknown> = Promise.resolve();
  /** 直前の追記が失敗したか(次の追記を改行から始めるため) */
  #lastAppendFailed = false;

  constructor(readonly path: string) {}

  write(record: AuditRecord): Promise<void> {
    try {
      validateRecord(record);
      if (record.recordType !== "answer_run") {
        // このシンクは AnswerRun 専用(ToolInvocation 等は Gateway が書く、不変条件2)
        throw new Error("AnswerRunJsonlSink accepts answer_run records only");
      }
    } catch (error) {
      return Promise.reject(error);
    }
    const line = `${JSON.stringify(record)}\n`;
    return this.#exclusive(async () => {
      try {
        await appendFile(this.path, this.#lastAppendFailed ? `\n${line}` : line, {
          encoding: "utf8",
          mode: FILE_MODE,
          flag: "a",
        });
        this.#lastAppendFailed = false;
      } catch (error) {
        this.#lastAppendFailed = true;
        throw error;
      }
    });
  }

  #exclusive(task: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(task, task);
    this.#queue = next.catch(() => undefined);
    return next;
  }
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "unknown error";
}

/**
 * 追記先として使えるか(親ディレクトリが存在して書き込み可能、既存なら通常ファイルで
 * 書き込み可能)を確かめる。問題があれば説明(パスとエラーコードのみ)、なければ undefined。
 * 確認はアクセス権の照会のみで、ファイルもディレクトリも作らない(Gateway の
 * bootstrap/audit.ts と同じ規則)。
 */
export async function answerRunJsonlPathProblem(file: string): Promise<string | undefined> {
  try {
    await access(dirname(file), constants.W_OK);
  } catch (error) {
    return `directory of ${file} does not exist or is not writable (${errorCode(error)})`;
  }
  try {
    if (!(await stat(file)).isFile()) {
      return `${file} is not a regular file`;
    }
    await access(file, constants.W_OK);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      return `${file} is not writable (${errorCode(error)})`;
    }
  }
  return undefined;
}
