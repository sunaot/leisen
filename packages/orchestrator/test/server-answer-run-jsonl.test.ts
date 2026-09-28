/**
 * AnswerRunJsonlSink(T-021、ADR-018 決定4)の単体:
 * - 1行1レコードの JSON を追記する(ラッパーなし。parseAuditRecord で読める)
 * - 新規作成するファイルのモードは 0600。既存のファイルには追記する
 * - 同時の書き込みも呼び出し順に並ぶ(直列化)
 * - ディレクトリがなければ失敗する(作らない)。失敗後の次の追記は改行から始める
 * - AnswerRun 以外・不正なレコードは書かない
 * - answerRunJsonlPathProblem: 書き込めない出力先を起動時に見つける(ファイルは作らない)
 */
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAuditRecord, type AuditRecord } from "@kp/gateway";
import {
  AnswerRunJsonlSink,
  answerRunJsonlPathProblem,
  pendingAnswerRun,
} from "../src/index.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "t021-jsonl-"));
}

function answerRun(runId: string): AuditRecord {
  return pendingAnswerRun({
    runId,
    userId: "alice",
    startedAt: "2026-09-28T00:00:00.000Z",
    question: "経費精算の締め日は?",
  });
}

async function lines(path: string): Promise<string[]> {
  return (await readFile(path, "utf8")).split("\n").filter((line) => line !== "");
}

describe("AnswerRunJsonlSink", () => {
  it("1行1レコードで追記し、新規作成のファイルは 0600", async () => {
    const path = join(await tempDir(), "answer-runs.jsonl");
    const sink = new AnswerRunJsonlSink(path);

    await sink.write(answerRun("run-1"));
    await sink.write(answerRun("run-2"));

    const written = await lines(path);
    expect(written.map((line) => (parseAuditRecord(JSON.parse(line)) as { runId: string }).runId)).toEqual([
      "run-1",
      "run-2",
    ]);
    // ラッパー(kind 等)を付けない
    expect(JSON.parse(written[0] ?? "{}")).not.toHaveProperty("kind");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    // 質問の原文は書かない(SHA-256 のみ)
    expect(await readFile(path, "utf8")).not.toContain("経費精算の締め日は?");
  });

  it("既存のファイルには追記する(上書きしない)", async () => {
    const path = join(await tempDir(), "answer-runs.jsonl");
    await writeFile(path, `${JSON.stringify(answerRun("run-0"))}\n`, { mode: 0o600 });
    await new AnswerRunJsonlSink(path).write(answerRun("run-1"));
    expect(await lines(path)).toHaveLength(2);
  });

  it("同時の書き込みも呼び出し順に並ぶ", async () => {
    const path = join(await tempDir(), "answer-runs.jsonl");
    const sink = new AnswerRunJsonlSink(path);
    const ids = Array.from({ length: 30 }, (_, i) => `run-${i}`);

    await Promise.all(ids.map((id) => sink.write(answerRun(id))));

    expect((await lines(path)).map((line) => (JSON.parse(line) as { runId: string }).runId)).toEqual(ids);
  });

  it("ディレクトリがなければ失敗し、作らない。書けるようになれば改行から追記を再開する", async () => {
    const dir = await tempDir();
    const sub = join(dir, "later");
    const path = join(sub, "answer-runs.jsonl");
    const sink = new AnswerRunJsonlSink(path);

    await expect(sink.write(answerRun("run-1"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(sub)).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(sub);
    await sink.write(answerRun("run-2"));
    const text = await readFile(path, "utf8");
    expect(text.startsWith("\n")).toBe(true);
    expect((await lines(path)).map((line) => (JSON.parse(line) as { runId: string }).runId)).toEqual([
      "run-2",
    ]);
  });

  it("AnswerRun 以外・禁止フィールドを含むレコードは書かない", async () => {
    const path = join(await tempDir(), "answer-runs.jsonl");
    const sink = new AnswerRunJsonlSink(path);
    const access: AuditRecord = {
      recordType: "audit_access",
      accessId: "access-1",
      accessorUserId: "auditor-1",
      timestamp: "2026-09-28T00:00:00.000Z",
      purpose: "violation_detection",
      target: "audit_log",
      scopeDescription: null,
    };
    await expect(sink.write(access)).rejects.toThrow(/answer_run/);
    const leaky = { ...answerRun("run-1"), candidateCount: 3 } as unknown as AuditRecord;
    await expect(sink.write(leaky)).rejects.toThrow();
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("answerRunJsonlPathProblem", () => {
  it("書き込める出力先(未作成のファイルを含む)は問題なし。ファイルは作らない", async () => {
    const dir = await tempDir();
    const path = join(dir, "answer-runs.jsonl");
    expect(await answerRunJsonlPathProblem(path)).toBeUndefined();
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(path, "");
    expect(await answerRunJsonlPathProblem(path)).toBeUndefined();
  });

  it("ディレクトリがない・ディレクトリを指している・書き込めないファイルは問題として返す", async () => {
    const dir = await tempDir();
    expect(await answerRunJsonlPathProblem(join(dir, "missing", "a.jsonl"))).toMatch(
      /does not exist or is not writable \(ENOENT\)/,
    );
    await mkdir(join(dir, "adir"));
    expect(await answerRunJsonlPathProblem(join(dir, "adir"))).toMatch(/is not a regular file/);
    if (process.getuid?.() !== 0) {
      // root はアクセス権を無視するため、root 以外でだけ確かめる
      const readonly = join(dir, "readonly.jsonl");
      await writeFile(readonly, "");
      await chmod(readonly, 0o400);
      expect(await answerRunJsonlPathProblem(readonly)).toMatch(/is not writable/);
    }
  });
});
