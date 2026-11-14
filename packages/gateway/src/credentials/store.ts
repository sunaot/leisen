/**
 * CredentialStore の SQLite 実装(ADR-022 決定 3。node:sqlite、追加依存なし)。
 *
 * - 置くのは暗号文(credentials)と、資格情報を含まない拒否リスト(denials)・使用済みの
 *   印(used_tokens)だけ。拒否リストと印のキーは SHA-256 にして保管する(userId を平文で
 *   増やさない)
 * - 比較交換(put の expectedVersion)で、複数プロセスが同じ行を更新しても後勝ちで
 *   上書きしない(更新トークンのローテーションの取りこぼし防止)
 * - ファイルは 0600 で作る。WAL モード
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { createRequire } from "node:module";
import type { CredentialStore, DenialKind, SealedCredential } from "./types.js";

// node:sqlite は Node 22.13 以降で利用できる(engines)。ESM の静的 import だと読み込み時に
// 実験的機能の警告が出るため、使う時点で読み込む
const require = createRequire(import.meta.url);

function loadSqlite(): typeof import("node:sqlite") {
  return require("node:sqlite") as typeof import("node:sqlite");
}

function hashKey(kind: string, key: string): string {
  return createHash("sha256").update(`${kind}\u001f${key}`, "utf8").digest("hex");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS credentials (
  user_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  kek_id TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  version INTEGER NOT NULL,
  connected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, source_id)
);
CREATE TABLE IF NOT EXISTS denials (
  key_hash TEXT PRIMARY KEY,
  revoked_before INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS used_tokens (
  id_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
`;

interface CredentialRow {
  user_id: string;
  source_id: string;
  kek_id: string;
  wrapped_key: string;
  ciphertext: string;
  version: number;
  connected_at: number;
  updated_at: number;
}

function toRecord(row: CredentialRow): SealedCredential {
  return {
    userId: row.user_id,
    sourceId: row.source_id,
    kekId: row.kek_id,
    wrappedKey: row.wrapped_key,
    ciphertext: row.ciphertext,
    version: Number(row.version),
    connectedAt: Number(row.connected_at),
    updatedAt: Number(row.updated_at),
  };
}

export class SqliteCredentialStore implements CredentialStore {
  readonly #db: DatabaseSyncType;
  readonly #path: string;

  /** path は ":memory:"(テスト)またはファイルパス */
  constructor(path: string) {
    this.#path = path;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    const existed = path !== ":memory:" && existsSync(path);
    const { DatabaseSync } = loadSqlite();
    this.#db = new DatabaseSync(path);
    if (path !== ":memory:") {
      if (!existed) {
        chmodSync(path, 0o600);
      }
      this.#db.exec("PRAGMA journal_mode = WAL;");
    }
    this.#db.exec("PRAGMA busy_timeout = 5000;");
    this.#db.exec(SCHEMA);
  }

  get description(): string {
    return `sqlite (${this.#path})`;
  }

  async get(userId: string, sourceId: string): Promise<SealedCredential | undefined> {
    const row = this.#db
      .prepare("SELECT * FROM credentials WHERE user_id = ? AND source_id = ?")
      .get(userId, sourceId) as CredentialRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  async put(record: SealedCredential, expectedVersion: number | null): Promise<boolean> {
    if (expectedVersion === null) {
      const result = this.#db
        .prepare(
          "INSERT OR IGNORE INTO credentials (user_id, source_id, kek_id, wrapped_key, ciphertext, version, connected_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          record.userId,
          record.sourceId,
          record.kekId,
          record.wrappedKey,
          record.ciphertext,
          record.version,
          record.connectedAt,
          record.updatedAt,
        );
      return Number(result.changes) === 1;
    }
    const result = this.#db
      .prepare(
        "UPDATE credentials SET kek_id = ?, wrapped_key = ?, ciphertext = ?, version = ?, connected_at = ?, updated_at = ? WHERE user_id = ? AND source_id = ? AND version = ?",
      )
      .run(
        record.kekId,
        record.wrappedKey,
        record.ciphertext,
        record.version,
        record.connectedAt,
        record.updatedAt,
        record.userId,
        record.sourceId,
        expectedVersion,
      );
    return Number(result.changes) === 1;
  }

  async delete(userId: string, sourceId: string): Promise<boolean> {
    const result = this.#db
      .prepare("DELETE FROM credentials WHERE user_id = ? AND source_id = ?")
      .run(userId, sourceId);
    return Number(result.changes) > 0;
  }

  async sourcesForUser(userId: string): Promise<string[]> {
    const rows = this.#db
      .prepare("SELECT source_id FROM credentials WHERE user_id = ? ORDER BY source_id")
      .all(userId) as Array<{ source_id: string }>;
    return rows.map((row) => row.source_id);
  }

  async allKeys(): Promise<Array<{ userId: string; sourceId: string }>> {
    const rows = this.#db
      .prepare("SELECT user_id, source_id FROM credentials ORDER BY user_id, source_id")
      .all() as Array<{ user_id: string; source_id: string }>;
    return rows.map((row) => ({ userId: row.user_id, sourceId: row.source_id }));
  }

  async addDenial(kind: DenialKind, key: string, revokedBefore: number, expiresAt: number): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO denials (key_hash, revoked_before, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(key_hash) DO UPDATE SET
           revoked_before = MAX(revoked_before, excluded.revoked_before),
           expires_at = MAX(expires_at, excluded.expires_at)`,
      )
      .run(hashKey(kind, key), revokedBefore, expiresAt);
  }

  async denial(kind: DenialKind, key: string): Promise<number | undefined> {
    const row = this.#db
      .prepare("SELECT revoked_before FROM denials WHERE key_hash = ?")
      .get(hashKey(kind, key)) as { revoked_before: number } | undefined;
    return row === undefined ? undefined : Number(row.revoked_before);
  }

  async markUsed(id: string, expiresAt: number): Promise<boolean> {
    const result = this.#db
      .prepare("INSERT OR IGNORE INTO used_tokens (id_hash, expires_at) VALUES (?, ?)")
      .run(hashKey("used", id), expiresAt);
    return Number(result.changes) === 1;
  }

  async purgeExpired(now: number): Promise<number> {
    const a = this.#db.prepare("DELETE FROM denials WHERE expires_at < ?").run(now);
    const b = this.#db.prepare("DELETE FROM used_tokens WHERE expires_at < ?").run(now);
    return Number(a.changes) + Number(b.changes);
  }

  close(): void {
    if (this.#db.isOpen) {
      this.#db.close();
    }
  }
}
