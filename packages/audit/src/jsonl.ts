/**
 * JSONLファイルの監査ストア(起動コードの audit.sink: jsonl、ADR-011 §3-4)。
 *
 * - JsonlAuditStore: 監査レコード(AuditRecord)を1行1件のJSONで追記する
 *   append-only の AuditStoreWriter。BufferedAuditSink(retry・ローカルバッファ・
 *   flush)の書き込み先として使う。行の形式は昇格判定レポート(promotion-report)の
 *   入力(1行=1レコード、parseAuditRecord で検証できる形。ラッパーを付けない)
 * - JsonlRawQueryStore: 生クエリ原文の短期保持テーブル(RawQueryStore)。監査ログ
 *   本体とは別ファイルにする(ADR-011 §3。質問文自体が機密を含みうる、TM-F4)
 *
 * at-least-once と重複(ADR-011 §4): BufferedAuditSink は書き込みの成否が
 * 確定しない失敗(追記は済んだが例外が返った等)でもバッチを再送するため、
 * **同じレコードが複数行に現れうる**。読み手は requestId / runId / accessId /
 * purgeId(レコード種別ごとの冪等キー。sink.ts の InMemoryAuditStore と同じ)で
 * 重複を除いて扱う前提とする(promotion-report もこの前提で読む)。
 *
 * 途切れた行: 追記の途中で失敗した場合(ENOSPC等)、末尾に不完全な行が残りうる。
 * 次の追記は改行から始め、有効な行が不完全な行に連結されないようにする(空行が
 * 生じうるため、読み手は空行を読み飛ばす)。不完全な行自体は不正なJSONとして
 * 残り、読み手(promotion-report)は行番号付きのエラーで検出する(fail-closed)。
 *
 * 運用上の制約:
 * - 1ファイルに書き込むのは1プロセスに限る(複数プロセスの同時追記の原子性は
 *   ファイルシステムに依存するため保証しない)
 * - 新規作成するファイルのモードは 0600(所有者のみ読み書き)
 * - 保持期限超過分の削除(ADR-013 §3)の定期ジョブは本モジュールの範囲外
 *   (リファレンスデプロイ T-012 以降)。監査ログ本体は append-only のため、
 *   期限処理はファイルのローテーションと世代削除で行う想定。rawQuery は
 *   purgeBefore(ファイルの書き直し)を提供する
 */
import { randomUUID } from "node:crypto";
import { appendFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import {
  rawQueryRecordSchema,
  validateRawQueryRecord,
  type RawQueryRecord,
  type RawQueryStore,
} from "./rawquery.js";
import { validateRecord, type AuditRecord } from "./schema.js";
import type { AuditStoreWriter } from "./sink.js";

/** 新規作成するファイルのモード(所有者のみ読み書き)。 */
const FILE_MODE = 0o600;

function toJsonLines(records: readonly unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

/**
 * 監査レコードを JSONL で追記する AuditStoreWriter。BufferedAuditSink と組み合わせて
 * 使う(再送による重複行がありうる。モジュール冒頭のコメント参照)。
 */
export class JsonlAuditStore implements AuditStoreWriter {
  /** 直前の追記が失敗したか(次の追記を改行から始めるため) */
  private lastAppendFailed = false;

  constructor(readonly path: string) {}

  async writeBatch(records: readonly AuditRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }
    // 永続化前に検証する(禁止フィールド・型に存在しないキーを書かない)
    for (const record of records) {
      validateRecord(record);
    }
    const lines = toJsonLines(records);
    try {
      await appendFile(this.path, this.lastAppendFailed ? `\n${lines}` : lines, {
        encoding: "utf8",
        mode: FILE_MODE,
      });
      this.lastAppendFailed = false;
    } catch (error) {
      this.lastAppendFailed = true;
      throw error;
    }
  }
}

/**
 * 生クエリ原文の JSONL テーブル。追記・検索・期限切れ削除をプロセス内で直列化する
 * (purgeBefore の書き直し中の追記を失わないため)。
 */
export class JsonlRawQueryStore implements RawQueryStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {}

  async append(record: RawQueryRecord): Promise<void> {
    // 検証の失敗も reject で返す(RawQueryStore の他の実装と同じ振る舞い)
    validateRawQueryRecord(record);
    await this.exclusive(() =>
      appendFile(this.path, toJsonLines([record]), {
        encoding: "utf8",
        mode: FILE_MODE,
      }),
    );
  }

  findByDigest(queryDigest: string): Promise<readonly RawQueryRecord[]> {
    return this.exclusive(async () =>
      (await this.readAll()).filter((r) => r.queryDigest === queryDigest),
    );
  }

  /**
   * cutoff より前のレコードを削除する。残すレコードを一時ファイルに書いてから
   * rename で置き換える(途中で失敗しても元ファイルは壊れない)。
   */
  purgeBefore(cutoffIso: string): Promise<number> {
    const cutoff = Date.parse(cutoffIso);
    if (Number.isNaN(cutoff)) {
      return Promise.reject(
        new Error("cutoffIso must be a valid ISO 8601 timestamp"),
      );
    }
    return this.exclusive(async () => {
      const records = await this.readAll();
      const kept = records.filter((r) => Date.parse(r.timestamp) >= cutoff);
      const deleted = records.length - kept.length;
      if (deleted === 0) {
        return 0;
      }
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, toJsonLines(kept), {
          encoding: "utf8",
          mode: FILE_MODE,
        });
        await rename(temporary, this.path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      return deleted;
    });
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * 全レコードを読む(ファイルがなければ空)。不正な行は行番号付きで拒否する
   * (fail-closed)。行の内容は機密を含みうるため、エラーメッセージに載せない
   * (JSON.parse の例外文言は入力の断片を含むため使わない)。
   */
  private async readAll(): Promise<RawQueryRecord[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const records: RawQueryRecord[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]?.trim();
      if (!line) {
        continue;
      }
      try {
        const record = rawQueryRecordSchema.parse(JSON.parse(line));
        validateRawQueryRecord(record);
        records.push(record);
      } catch {
        throw new Error(`${this.path}:${i + 1}: invalid raw query record`);
      }
    }
    return records;
  }
}
