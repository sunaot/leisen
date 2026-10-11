import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAuditRecord } from "@kp/audit";
import { HELP, isMainModule, runCli } from "../src/cli.js";
import { AUDIT_INPUT_FORMAT_HINT } from "../src/input.js";
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

describe("--audit の複数指定(Gateway の JSONL と Orchestrator の AnswerRun の JSONL、T-021)", () => {
  /**
   * リファレンス構成(ADR-018 決定4)の2ファイル: Gateway の監査 JSONL には ToolInvocation
   * (とメタ監査)、kp-ask serve の JSONL には AnswerRun(同じ runId の pending → 最終状態 →
   * フィードバックの行が並ぶ)。
   */
  async function writeSplitFiles(dir: string): Promise<{ gateway: string; answerRuns: string }> {
    const records = fixtureRecords();
    const gateway = join(dir, "gateway-audit.jsonl");
    const answerRuns = join(dir, "answer-runs.jsonl");
    await writeFile(
      gateway,
      records
        .filter((r) => r.recordType !== "answer_run")
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    const lines: string[] = [];
    for (const record of records) {
      if (record.recordType !== "answer_run") continue;
      // Orchestrator は開始時に pending を書き、終了時に同じ runId で最終状態を書く
      if (record.finalOutcome !== "pending") {
        lines.push(JSON.stringify({ ...record, finalOutcome: "pending", endedAt: null, confidence: null }));
      }
      lines.push(JSON.stringify(record));
    }
    await writeFile(answerRuns, lines.join("\n") + "\n");
    return { gateway, answerRuns };
  }

  async function report(
    audits: readonly string[],
    metaOut: string,
    sources: string,
  ): Promise<{ code: number; body: Record<string, unknown>; err: string[] }> {
    const { out, err, io } = capture();
    const code = await runCli(
      [
        ...audits.flatMap((path) => ["--audit", path]),
        "--sources", sources,
        "--accessor", "auditor-1",
        "--meta-audit-out", metaOut,
        "--format", "json",
      ],
      io,
    );
    return { code, body: code === 0 ? JSON.parse(out.join("\n")) : {}, err };
  }

  it("2つの JSONL を結合して1つの JSONL と同じ集計になる(ファイルの順序に依らない)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t021-"));
    const files = await writeFixtureFiles(dir);
    const split = await writeSplitFiles(dir);

    const combined = await report([files.audit], files.metaOut, files.sources);
    const both = await report([split.gateway, split.answerRuns], files.metaOut, files.sources);
    const reversed = await report([split.answerRuns, split.gateway], files.metaOut, files.sources);

    expect(both.code).toBe(0);
    expect(both.body["totalRuns"]).toBe(6);
    const comparable = (body: Record<string, unknown>) => ({
      totalRuns: body["totalRuns"],
      sourceStats: body["sourceStats"],
      searchCountDistribution: body["searchCountDistribution"],
      userMismatchWarnings: body["userMismatchWarnings"],
    });
    expect(comparable(both.body)).toEqual(comparable(combined.body));
    expect(comparable(reversed.body)).toEqual(comparable(combined.body));
    // AnswerRun の pending 行は同じ runId の後の行で置き換わる(重複ではなく更新として数える。issue #38)
    expect(both.body["duplicateRecordCount"]).toBe(0);
    expect(both.body["updatedRecordCount"]).toBe(5);
    expect(both.body["inputRecordCount"]).toBe(
      (combined.body["inputRecordCount"] as number) + 5,
    );
  });

  it("Gateway の JSONL だけでは run を数えられない(AnswerRun が Orchestrator 側にあるため)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t021-"));
    const files = await writeFixtureFiles(dir);
    const split = await writeSplitFiles(dir);

    const gatewayOnly = await report([split.gateway], files.metaOut, files.sources);

    expect(gatewayOnly.code).toBe(0);
    expect(gatewayOnly.body["totalRuns"]).toBe(0);
  });

  it("メタ監査の audit_log アクセスは結合した入力全体で1件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t021-"));
    const files = await writeFixtureFiles(dir);
    const split = await writeSplitFiles(dir);

    await report([split.gateway, split.answerRuns], files.metaOut, files.sources);

    const meta = (await readFile(files.metaOut, "utf8"))
      .trim()
      .split("\n")
      .map((line) => parseAuditRecord(JSON.parse(line)));
    expect(meta).toHaveLength(1);
    expect(meta[0]).toMatchObject({ recordType: "audit_access", target: "audit_log" });
  });

  it("どちらかのファイルの不正な行は、そのファイル名と行番号で拒否する", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t021-"));
    const files = await writeFixtureFiles(dir);
    const split = await writeSplitFiles(dir);
    await writeFile(split.answerRuns, "{\"recordType\":\"answer_run\"}\n");

    const result = await report([split.gateway, split.answerRuns], files.metaOut, files.sources);

    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/answer-runs\.jsonl:1: /);
  });

  it("--audit が1つもなければ usage エラー", async () => {
    const { err, io } = capture();
    expect(
      await runCli(["--sources", "s.json", "--accessor", "u", "--meta-audit-out", "m.jsonl"], io),
    ).toBe(2);
    expect(err.join("\n")).toContain("--audit is required");
    expect(err.join("\n")).toContain("[--audit <more.jsonl> ...]");
  });
});

describe("使い方・入力の不備の表示(issue #38)", () => {
  async function run(argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
    const { out, err, io } = capture();
    const code = await runCli(argv, io);
    return { code, out, err };
  }

  function args(files: { audit: string; sources: string; metaOut: string }, ...extra: string[]): string[] {
    return [
      "--audit", files.audit,
      "--sources", files.sources,
      "--accessor", "auditor-1",
      "--meta-audit-out", files.metaOut,
      ...extra,
    ];
  }

  it.each([["--help"], ["-h"], ["--audit", "a.jsonl", "--help"]])(
    "%j は使い方を stdout に出して終了コード 0(メタ監査も書かない)",
    async (...argv) => {
      const result = await run(argv);
      expect(result.code).toBe(0);
      expect(result.out).toEqual([HELP]);
      expect(result.err).toEqual([]);
      expect(HELP).toContain("usage: kp-promotion-report");
      expect(HELP).toContain("--raw-queries");
      expect(HELP).toContain("audit.sink: stdout");
    },
  );

  it.each([
    [
      [],
      ["sources.json(SRC): (ルート): オブジェクトにしてください(実際: 配列)。形式: { \"<sourceId>\": { \"nativeSearch\": \"full|degraded|none\", \"slack\": true|false } }"],
    ],
    [
      { gdrive: {} },
      ["sources.json(SRC): gdrive.nativeSearch: full / degraded / none のいずれかにしてください(未指定)"],
    ],
    [
      { gdrive: { nativeSearch: "partial" }, wiki: { nativeSearch: "full", slack: "no" } },
      [
        "sources.json(SRC): gdrive.nativeSearch: full / degraded / none のいずれかにしてください",
        "sources.json(SRC): wiki.slack: 真偽値(true / false)にしてください(実際: 文字列)",
      ],
    ],
    [
      { gdrive: { nativeSearch: "full", native_search: "full" } },
      ["sources.json(SRC): gdrive: 未知のキー native_search があります(指定できるのは nativeSearch と slack)"],
    ],
    [
      { gdrive: 3 },
      ["sources.json(SRC): gdrive: オブジェクトにしてください(実際: 数値)。形式: { \"nativeSearch\": \"full|degraded|none\", \"slack\": true|false }"],
    ],
  ])("sources.json %j の不備は「sources.json(<パス>): <場所>: <説明>」で1件1行(終了コード 1)", async (sources, expected) => {
    const dir = await mkdtemp(join(tmpdir(), "t014-"));
    const files = await writeFixtureFiles(dir);
    await writeFile(files.sources, JSON.stringify(sources));

    const result = await run(args(files));

    expect(result.code).toBe(1);
    expect(result.err).toEqual(expected.map((line) => line.replace("SRC", files.sources)));
    expect(result.err.join("\n")).not.toContain('"code"');
    await expect(readFile(files.metaOut, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sources.json が JSON でない・ない場合もファイル名付きで出す", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t014-"));
    const files = await writeFixtureFiles(dir);
    await writeFile(files.sources, "{ gdrive: ");
    expect((await run(args(files))).err).toEqual([`sources.json(${files.sources}): JSON として読めません`]);

    const missing = join(dir, "missing.json");
    const result = await run(args({ ...files, sources: missing }));
    expect(result.code).toBe(1);
    expect(result.err).toEqual([`sources.json(${missing}): 読めません(ENOENT)`]);
  });

  it("audit.sink: stdout の行({\"kind\":\"audit\", …})も読み、JSONL と同じ集計になる", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t014-"));
    const files = await writeFixtureFiles(dir);
    const stdoutCapture = join(dir, "gateway-stdout.log");
    await writeFile(
      stdoutCapture,
      fixtureRecords().map((r) => JSON.stringify({ kind: "audit", ...r })).join("\n") + "\n",
    );

    const plain = await run(args(files, "--format", "json"));
    const enveloped = await run(args({ ...files, audit: stdoutCapture }, "--format", "json"));

    expect(enveloped.code).toBe(0);
    const body = (out: string[]) => {
      const { generatedAt: _generatedAt, ...rest } = JSON.parse(out.join("\n")) as Record<string, unknown>;
      return rest;
    };
    expect(body(enveloped.out)).toEqual(body(plain.out));
    expect(body(enveloped.out)["totalRuns"]).toBe(6);
  });

  it.each([
    ["kind が audit 以外の行", JSON.stringify({ kind: "log", message: "listening" }), '"kind" が "audit" 以外'],
    ["recordType のない JSON", JSON.stringify({ level: "info" }), "recordType がない"],
    ["JSON でない行(起動ログなど)", "kp-gateway: listening on …", "JSON として読めません"],
  ])("%s は行番号と渡すべき形式の案内を出して拒否する", async (_label, line, reason) => {
    const dir = await mkdtemp(join(tmpdir(), "t014-"));
    const files = await writeFixtureFiles(dir);
    const first = JSON.stringify({ kind: "audit", ...fixtureRecords()[0] });
    await writeFile(files.audit, `${first}\n${line}\n`);

    const result = await run(args(files));

    expect(result.code).toBe(1);
    expect(result.err).toHaveLength(1);
    expect(result.err[0]).toMatch(/audit\.jsonl:2: /);
    expect(result.err[0]).toContain(reason);
    expect(result.err[0]).toContain(AUDIT_INPUT_FORMAT_HINT);
  });

  it("封筒を外したレコードも JSONL と同じ検証にかける(禁止フィールド・型にないキーは拒否。zod の生の JSON は出さない)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t014-"));
    const files = await writeFixtureFiles(dir);
    const record = fixtureRecords()[0] as Record<string, unknown>;
    await writeFile(
      files.audit,
      [
        JSON.stringify({ kind: "audit", ...record, extraField: 1 }),
      ].join("\n") + "\n",
    );
    const unknownKey = await run(args(files));
    expect(unknownKey.code).toBe(1);
    expect(unknownKey.err).toEqual([
      `${files.audit}:1: レコードが不正です: (ルート): 未知のキー extraField があります`,
    ]);

    await writeFile(files.audit, JSON.stringify({ kind: "audit", ...record, candidateCount: 3 }) + "\n");
    const forbidden = await run(args(files));
    expect(forbidden.err.join("\n")).toMatch(/audit\.jsonl:1: .*candidateCount/);

    await writeFile(files.audit, JSON.stringify({ recordType: "answer_runs" }) + "\n");
    const unknownType = await run(args(files));
    expect(unknownType.err).toEqual([
      `${files.audit}:1: レコードが不正です: recordType: answer_run / tool_invocation / answer_run_finish / answer_run_feedback / audit_access / retention_purge のいずれかにしてください`,
    ]);
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
