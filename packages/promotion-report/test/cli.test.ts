import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAuditRecord } from "@kp/gateway";
import { isMainModule, runCli } from "../src/cli.js";
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
    expect(body.totalRuns).toBe(6);
    expect(body.metaAuditRecords).toBeUndefined();
    // 再検索回数は run 内の search 件数(旧 iterationDistribution / searchIterations は廃止)
    expect(body.searchCountDistribution).toEqual([
      { searchCount: 0, runs: 1, unresolvedRuns: 0 },
      { searchCount: 1, runs: 2, unresolvedRuns: 1 },
      { searchCount: 2, runs: 1, unresolvedRuns: 1 },
      { searchCount: 3, runs: 1, unresolvedRuns: 1 },
    ]);
    expect(body.iterationDistribution).toBeUndefined();
    expect(body.userMismatchWarnings).toEqual([]);
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

  it("監査 JSONL の重複行(at-least-once)を除いて集計する", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t014-"));
    const files = await writeFixtureFiles(dir);
    const lines = fixtureRecords().map((r) => JSON.stringify(r));
    // 再送で同じ行が2回ずつ書かれた JSONL(途切れた行の後の空行も含む)
    await writeFile(files.audit, [...lines, "", ...lines].join("\n") + "\n");
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
    expect(body.inputRecordCount).toBe(lines.length * 2);
    expect(body.duplicateRecordCount).toBe(lines.length);
    expect(body.totalRuns).toBe(6);
    const gdrive = body.sourceStats.find((s: { sourceId: string }) => s.sourceId === "gdrive");
    // describe 6件(各 run の冒頭)+ search / fetch 6件
    expect(gdrive.invocations).toBe(12);
    const searchRuns = body.searchCountDistribution.reduce(
      (sum: number, b: { runs: number }) => sum + b.runs,
      0,
    );
    expect(searchRuns).toBe(5);
  });
});

describe("isMainModule(エントリとして実行されたかの判定)", () => {
  it("argv[1] がシンボリックリンクでも実体が同じなら true(npm の bin リンク経由)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t014-main-"));
    const target = join(dir, "cli.js");
    const link = join(dir, "kp-promotion-report");
    await writeFile(target, "");
    await symlink(target, link);
    const url = pathToFileURL(target).href;

    expect(isMainModule(url, target)).toBe(true);
    expect(isMainModule(url, link)).toBe(true);
  });

  it("別のファイル・未指定・存在しないパスは false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t014-main-"));
    const target = join(dir, "cli.js");
    const other = join(dir, "other.js");
    await writeFile(target, "");
    await writeFile(other, "");
    const url = pathToFileURL(target).href;

    expect(isMainModule(url, other)).toBe(false);
    expect(isMainModule(url, undefined)).toBe(false);
    expect(isMainModule(url, "")).toBe(false);
    expect(isMainModule(url, join(dir, "missing.js"))).toBe(false);
  });
});

const PACKAGE_DIR = fileURLToPath(new URL("../", import.meta.url));
const DIST_CLI = join(PACKAGE_DIR, "dist", "cli.js");
const BIN_SHIM = join(PACKAGE_DIR, "bin", "kp-promotion-report.js");

// ビルド成果物(dist)がある場合のみ子プロセスで実行する(src は直接実行しない)
describe.skipIf(!existsSync(DIST_CLI))("ビルド成果物の実行(子プロセス)", () => {
  function run(entry: string, args: string[] = []) {
    return spawnSync(process.execPath, [entry, ...args], { encoding: "utf8" });
  }

  it("dist/cli.js をシンボリックリンク経由で起動しても実行される(何もせず 0 で終わらない)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t014-bin-"));
    const link = join(dir, "kp-promotion-report");
    await symlink(DIST_CLI, link);

    const viaLink = run(link);
    expect(viaLink.status).toBe(2);
    expect(viaLink.stderr).toContain("usage: kp-promotion-report");

    const direct = run(DIST_CLI);
    expect(direct.status).toBe(2);
    expect(direct.stderr).toContain("usage: kp-promotion-report");
  });

  it("npm の bin(起動シム)経由でも動く(.bin のシンボリックリンク経由を含む)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t014-bin-"));
    const link = join(dir, "kp-promotion-report");
    await symlink(BIN_SHIM, link);

    for (const entry of [BIN_SHIM, link]) {
      const result = run(entry);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("usage: kp-promotion-report");
    }
  });

  it("シム経由の実行でレポートを出し、メタ監査を1回だけ書く(二重実行しない)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t014-bin-"));
    const files = await writeFixtureFiles(dir);
    const link = join(dir, "kp-promotion-report");
    await symlink(BIN_SHIM, link);

    const result = run(link, [
      "--audit", files.audit,
      "--sources", files.sources,
      "--raw-queries", files.raw,
      "--accessor", "auditor-1",
      "--meta-audit-out", files.metaOut,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.split("# 昇格判定レポート")).toHaveLength(2);
    const metaLines = (await readFile(files.metaOut, "utf8")).trim().split("\n");
    expect(metaLines).toHaveLength(2);
  });
});
