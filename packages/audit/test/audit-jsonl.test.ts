/**
 * JSONL監査ストア(audit.sink: jsonl)のテスト。
 * - 1行=1 AuditRecord(ラッパーなし)で追記し、parseAuditRecord で読み戻せる
 * - at-least-once: 成否の不確かな失敗の再送で重複行が生じうる。読み手は
 *   requestId 等の冪等キーで重複を除く前提(jsonl.ts 冒頭のコメント)
 * - 途切れた行の後の追記は改行から始める
 * - rawQuery: 追記・findByDigest・purgeBefore(書き直し)
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BufferedAuditSink,
  JsonlAuditStore,
  JsonlRawQueryStore,
  digestQuery,
  parseAuditRecord,
  type AuditRecord,
  type RawQueryRecord,
} from "../src/index.js";

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "leisen-audit-jsonl-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function invocation(requestId: string): AuditRecord {
  return {
    recordType: "tool_invocation",
    requestId,
    runId: "run-1",
    iteration: 0,
    userId: "alice",
    timestamp: "2026-09-27T00:00:00.000Z",
    sourceId: "dev-docs",
    tool: "search",
    queryDigest: digestQuery("q"),
    filtersDigest: null,
    returnedHitCount: 1,
    fetchedDocCount: 0,
    latencyMs: 3,
    errorClass: null,
    retryCount: 0,
  };
}

async function readLines(path: string): Promise<string[]> {
  return (await readFile(path, "utf8")).split("\n").filter((line) => line !== "");
}

/** promotion-report と同じ読み方(空行を飛ばし、1行ずつ厳密に検証する)。 */
async function readAuditRecords(path: string): Promise<AuditRecord[]> {
  return (await readLines(path)).map((line) => parseAuditRecord(JSON.parse(line)));
}

describe("JsonlAuditStore", () => {
  it("1行1レコードで追記し、parseAuditRecord で読み戻せる", async () => {
    const path = join(await tempDir(), "audit.jsonl");
    const store = new JsonlAuditStore(path);
    await store.writeBatch([invocation("req-1"), invocation("req-2")]);
    await store.writeBatch([invocation("req-3")]);
    const records = await readAuditRecords(path);
    expect(records.map((r) => (r.recordType === "tool_invocation" ? r.requestId : ""))).toEqual([
      "req-1",
      "req-2",
      "req-3",
    ]);
    // ラッパー(stdout sink の kind 等)を付けない
    expect(Object.keys(JSON.parse((await readLines(path))[0] ?? "{}"))).not.toContain("kind");
  });

  it("新規作成するファイルは所有者のみ読み書き可(0600)", async () => {
    const path = join(await tempDir(), "audit.jsonl");
    await new JsonlAuditStore(path).writeBatch([invocation("req-1")]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("空のバッチは何も書かない", async () => {
    const path = join(await tempDir(), "audit.jsonl");
    await new JsonlAuditStore(path).writeBatch([]);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("不正なレコード(禁止フィールド)は書かずに拒否する", async () => {
    const path = join(await tempDir(), "audit.jsonl");
    const bad = { ...invocation("req-1"), rawQuery: "secret question" } as unknown as AuditRecord;
    await expect(new JsonlAuditStore(path).writeBatch([bad])).rejects.toThrow(
      /forbidden field/,
    );
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("書き込み失敗の後の追記は改行から始め、途切れた行に連結しない", async () => {
    const logs = join(await tempDir(), "logs");
    const path = join(logs, "audit.jsonl");
    const store = new JsonlAuditStore(path);
    // 1回目: 出力先のディレクトリがなく失敗する
    await expect(store.writeBatch([invocation("req-0")])).rejects.toMatchObject({
      code: "ENOENT",
    });
    // 失敗した追記が途中まで書かれた状態(途切れた行)を模す
    await mkdir(logs);
    await writeFile(path, '{"recordType":"tool_invoc');
    await store.writeBatch([invocation("req-1")]);
    await store.writeBatch([invocation("req-2")]);
    const lines = (await readFile(path, "utf8")).split("\n");
    expect(lines[0]).toBe('{"recordType":"tool_invoc');
    expect(parseAuditRecord(JSON.parse(lines[1] ?? ""))).toMatchObject({ requestId: "req-1" });
    // 成功した後は通常どおり(余分な空行を入れない)
    expect(parseAuditRecord(JSON.parse(lines[2] ?? ""))).toMatchObject({ requestId: "req-2" });
    expect(lines).toHaveLength(4);
  });
});

describe("BufferedAuditSink + JsonlAuditStore(at-least-once)", () => {
  it("書き込みごとに1行ずつ永続化される", async () => {
    const path = join(await tempDir(), "audit.jsonl");
    const sink = new BufferedAuditSink(new JsonlAuditStore(path));
    await sink.write(invocation("req-1"));
    await sink.write(invocation("req-2"));
    await sink.flush();
    expect(await readLines(path)).toHaveLength(2);
    expect(sink.bufferedCount()).toBe(0);
  });

  it("追記は済んだのに失敗が返った場合は再送され、重複行が生じる(読み手は requestId で除く)", async () => {
    const path = join(await tempDir(), "audit.jsonl");
    /** 1回目は追記した後に失敗を返す(応答喪失などの成否不明な失敗を模す) */
    class AckLostStore extends JsonlAuditStore {
      private failed = false;
      override async writeBatch(records: readonly AuditRecord[]): Promise<void> {
        await super.writeBatch(records);
        if (!this.failed) {
          this.failed = true;
          throw new Error("acknowledgement lost");
        }
      }
    }
    const sink = new BufferedAuditSink(new AckLostStore(path), { retryBaseDelayMs: 1 });
    await sink.write(invocation("req-1"));
    await sink.flush();

    const records = await readAuditRecords(path);
    expect(records).toHaveLength(2);
    const unique = new Map(
      records.map((r) => [r.recordType === "tool_invocation" ? r.requestId : "", r]),
    );
    expect([...unique.keys()]).toEqual(["req-1"]);
  });

  it("書けない出力先ではレコードをバッファに残し、flush で失敗を知らせる", async () => {
    const dir = await tempDir();
    const sink = new BufferedAuditSink(
      new JsonlAuditStore(join(dir, "missing-dir", "audit.jsonl")),
      { maxRetries: 0, retryBaseDelayMs: 1 },
    );
    await sink.write(invocation("req-1")); // バッファ容量内なので受理される
    expect(sink.bufferedCount()).toBe(1);
    await expect(sink.flush()).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("JsonlRawQueryStore", () => {
  function rawRecord(rawQuery: string, timestamp: string): RawQueryRecord {
    return { queryDigest: digestQuery(rawQuery), rawQuery, userId: "alice", timestamp };
  }

  it("追記した原文を digest で引ける。ファイルがなければ空", async () => {
    const path = join(await tempDir(), "raw.jsonl");
    const store = new JsonlRawQueryStore(path);
    expect(await store.findByDigest(digestQuery("q1"))).toEqual([]);
    await store.append(rawRecord("q1", "2026-09-01T00:00:00Z"));
    await store.append(rawRecord("q2", "2026-09-02T00:00:00Z"));
    await store.append(rawRecord("q1", "2026-09-03T00:00:00Z"));
    const found = await store.findByDigest(digestQuery("q1"));
    expect(found.map((r) => r.timestamp)).toEqual([
      "2026-09-01T00:00:00Z",
      "2026-09-03T00:00:00Z",
    ]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("digest が原文と一致しないレコードは追記しない", async () => {
    const path = join(await tempDir(), "raw.jsonl");
    const store = new JsonlRawQueryStore(path);
    await expect(
      store.append({ ...rawRecord("q1", "2026-09-01T00:00:00Z"), rawQuery: "other" }),
    ).rejects.toThrow(/queryDigest/);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("purgeBefore は期限より前の行を削除してファイルを書き直し、削除件数を返す", async () => {
    const dir = await tempDir();
    const path = join(dir, "raw.jsonl");
    const store = new JsonlRawQueryStore(path);
    await store.append(rawRecord("old", "2026-08-01T00:00:00Z"));
    await store.append(rawRecord("new", "2026-09-20T00:00:00Z"));
    expect(await store.purgeBefore("2026-09-01T00:00:00Z")).toBe(1);
    expect(await store.findByDigest(digestQuery("old"))).toEqual([]);
    expect(await store.findByDigest(digestQuery("new"))).toHaveLength(1);
    expect(await readLines(path)).toHaveLength(1);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    // 削除対象がなければファイルを書き換えない
    expect(await store.purgeBefore("2026-09-01T00:00:00Z")).toBe(0);
    // ファイルがなければ0件
    expect(await new JsonlRawQueryStore(join(dir, "none.jsonl")).purgeBefore("2026-09-01T00:00:00Z")).toBe(0);
  });

  it("purgeBefore と並行した追記を失わない(プロセス内で直列化する)", async () => {
    const path = join(await tempDir(), "raw.jsonl");
    const store = new JsonlRawQueryStore(path);
    await store.append(rawRecord("old", "2026-08-01T00:00:00Z"));
    const results = await Promise.all([
      store.purgeBefore("2026-09-01T00:00:00Z"),
      store.append(rawRecord("during-1", "2026-09-10T00:00:00Z")),
      store.append(rawRecord("during-2", "2026-09-11T00:00:00Z")),
    ]);
    expect(results[0]).toBe(1);
    expect(await readLines(path)).toHaveLength(2);
  });

  it("不正な cutoff を拒否する", async () => {
    const store = new JsonlRawQueryStore(join(await tempDir(), "raw.jsonl"));
    await expect(store.purgeBefore("not-a-date")).rejects.toThrow(/ISO 8601/);
  });

  it("空行は読み飛ばし、不正な行は行番号付きで拒否する(行の内容はエコーしない)", async () => {
    const path = join(await tempDir(), "raw.jsonl");
    const valid = JSON.stringify(rawRecord("q1", "2026-09-01T00:00:00Z"));
    await writeFile(path, `${valid}\n\n${valid}\n`);
    const store = new JsonlRawQueryStore(path);
    expect(await store.findByDigest(digestQuery("q1"))).toHaveLength(2);

    await writeFile(path, `${valid}\n{"rawQuery":"confidential question`);
    const error = await store.findByDigest(digestQuery("q1")).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toBe(`${path}:2: invalid raw query record`);
    expect(error?.message).not.toContain("confidential");
  });
});
