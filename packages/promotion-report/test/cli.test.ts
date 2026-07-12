import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAuditRecord } from "@kp/gateway";
import { runCli } from "../src/cli.js";
import {
  fixtureRawQueries,
  fixtureRecords,
  fixtureSources,
} from "./fixture.js";

interface CapturedIo {
  out: string[];
  err: string[];
  io: { stdout(line: string): void; stderr(line: string): void };
}

function capture(): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (l) => out.push(l), stderr: (l) => err.push(l) },
  };
}

async function writeFixtureFiles(dir: string): Promise<{
  audit: string;
  sources: string;
  raw: string;
  metaOut: string;
}> {
  const audit = join(dir, "audit.jsonl");
  const sources = join(dir, "sources.json");
  const raw = join(dir, "raw.jsonl");
  const metaOut = join(dir, "meta-audit.jsonl");
  await writeFile(
    audit,
    fixtureRecords().map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  await writeFile(sources, JSON.stringify(fixtureSources()));
  await writeFile(
    raw,
    fixtureRawQueries().map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return { audit, sources, raw, metaOut };
}

describe("kp-promotion-report CLI", () => {
  it("正常系: レポートを出力し、メタ監査レコードをファイルに追記する", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t014-"));
    const files = await writeFixtureFiles(dir);
    const { out, io } = capture();

    const code = await runCli(
      [
        "--audit", files.audit,
        "--sources", files.sources,
        "--raw-queries", files.raw,
        "--accessor", "auditor-1",
        "--meta-audit-out", files.metaOut,
      ],
      io,
    );

    expect(code).toBe(0);
    expect(out.join("\n")).toContain("昇格判定レポート");

    // メタ監査(audit_log と raw_query の2件)が有効なレコードとして書かれている
    const metaLines = (await readFile(files.metaOut, "utf8"))
      .trim()
      .split("\n")
      .map((line) => parseAuditRecord(JSON.parse(line)));
    expect(metaLines).toHaveLength(2);
    expect(
      metaLines.map((r) => r.recordType === "audit_access" && r.target),
    ).toEqual(["audit_log", "raw_query"]);
  });

  it("json形式はメタ監査を除いた集計本体を出力する", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t014-"));
    const files = await writeFixtureFiles(dir);
    const { out, io } = capture();

    const code = await runCli(
      [
        "--audit", files.audit,
        "--sources", files.sources,
        "--accessor", "auditor-1",
        "--meta-audit-out", files.metaOut,
        "--format", "json",
      ],
      io,
    );

    expect(code).toBe(0);
    const body = JSON.parse(out.join("\n"));
    expect(body.totalRuns).toBe(5);
    expect(body.metaAuditRecords).toBeUndefined();
  });

  it("--accessor / --meta-audit-out 欠落はusageエラー(メタ監査なしで実行させない)", async () => {
    const { err, io } = capture();
    expect(
      await runCli(["--audit", "a.jsonl", "--sources", "s.json"], io),
    ).toBe(2);
    expect(err.join("\n")).toContain("--accessor is required");

    const { err: err2, io: io2 } = capture();
    expect(
      await runCli(
        ["--audit", "a.jsonl", "--sources", "s.json", "--accessor", "u"],
        io2,
      ),
    ).toBe(2);
    expect(err2.join("\n")).toContain("--meta-audit-out is required");
  });

  it("不正な監査レコード(禁止フィールド混入)は行番号つきで拒否する", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t014-"));
    const files = await writeFixtureFiles(dir);
    const bad = { ...JSON.parse(JSON.stringify(fixtureRecords()[0])), candidateCount: 100 };
    await writeFile(files.audit, JSON.stringify(bad) + "\n");
    const { err, io } = capture();

    const code = await runCli(
      [
        "--audit", files.audit,
        "--sources", files.sources,
        "--accessor", "auditor-1",
        "--meta-audit-out", files.metaOut,
      ],
      io,
    );

    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/audit\.jsonl:1: .*candidateCount/);
  });

  it("digestと原文が一致しないrawQueryレコードを拒否する", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t014-"));
    const files = await writeFixtureFiles(dir);
    const tampered = { ...fixtureRawQueries()[0], rawQuery: "改竄された原文" };
    await writeFile(files.raw, JSON.stringify(tampered) + "\n");
    const { err, io } = capture();

    const code = await runCli(
      [
        "--audit", files.audit,
        "--sources", files.sources,
        "--raw-queries", files.raw,
        "--accessor", "auditor-1",
        "--meta-audit-out", files.metaOut,
      ],
      io,
    );

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("queryDigest does not match");
  });
});
