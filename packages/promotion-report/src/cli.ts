#!/usr/bin/env node
/**
 * 昇格判定レポートCLI(T-014)。
 *
 * 監査ログ(JSONL)とrawQueryテーブル(JSONL)を読み、ソース別未解決率・
 * 再検索回数分布・失敗クエリ原文のレポートを出力する。
 *
 * 使い方:
 *   kp-promotion-report \
 *     --audit audit-records.jsonl [--audit answer-runs.jsonl ...] \
 *     --sources sources.json \
 *     --accessor <監査閲覧担当のuserId> \
 *     --meta-audit-out meta-audit.jsonl \
 *     [--raw-queries raw-queries.jsonl] [--format text|json]
 *   kp-promotion-report --help(-h)で使い方を表示する(終了コード 0)
 *
 * - --audit は複数回指定できる(T-021、ADR-018 決定4)。Gateway の監査 JSONL(ToolInvocation
 *   等)と Orchestrator サービス(kp-ask serve)の AnswerRun の JSONL を別ファイルで渡し、
 *   全ファイルのレコードを結合してから集計する(順序はファイル順・行順。重複行は冪等キーで
 *   除く)。メタ監査の audit_log アクセスは結合した入力全体で1件
 * - --audit の行は Gateway の audit.sink: jsonl の形(ラッパーなし)と、audit.sink: stdout の形
 *   ({"kind":"audit", ...record}。kp-ask の stderr も同じ)のどちらも読む(input.ts。issue #38)
 * - sources.json: { "<sourceId>": { "nativeSearch": "full|degraded|none", "slack": bool } }。
 *   不備は「sources.json(<パス>): <場所>: <説明>」の形で1件1行(zod の生の JSON を出さない)
 * - 監査ログの閲覧はメタ監査の対象(ADR-013 §3)。本CLIは audit_access
 *   レコードを --meta-audit-out に追記する。このファイルを監査ストアへ
 *   取り込むこと。--accessor と --meta-audit-out は必須
 * - 入力レコードは全件zod検証する(不正レコードは即エラー、fail-closed)
 * - 終了コード: 0 正常(--help を含む)、1 入力の不備・読み込みの失敗、2 引数の誤り
 */
import { realpathSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  validateRecord,
  type AuditRecord,
  type RawQueryRecord,
} from "@kp/audit";
import { generatePromotionReport } from "./aggregate.js";
import {
  InputError,
  parseAuditJsonl,
  parseRawQueryJsonl,
  parseSourcesJson,
  unreadableFile,
} from "./input.js";
import { renderPromotionReportText } from "./render.js";
import type { SourcesMeta } from "./sources.js";

const USAGE =
  "usage: kp-promotion-report --audit <records.jsonl> [--audit <more.jsonl> ...] " +
  "--sources <sources.json> --accessor <userId> --meta-audit-out <meta.jsonl> " +
  "[--raw-queries <raw.jsonl>] [--format text|json]";

/** --help の表示(使い方と各オプションの説明)。 */
export const HELP = [
  USAGE,
  "",
  "昇格判定レポート(T-014、ADR-006): 監査ログからソース別未解決率・再検索回数分布・失敗クエリを集計します。",
  "",
  "options:",
  "  --audit <path>           監査レコードの JSONL(必須。複数回指定でき、全ファイルを結合して集計)。",
  "                           Gateway の audit.sink: jsonl のファイル、audit.sink: stdout の標準出力",
  '                           ({"kind":"audit", …} の行)、kp-ask / kp-ask serve の --answer-run-jsonl のファイル',
  '  --sources <path>         sources.json(必須): { "<sourceId>": { "nativeSearch": "full|degraded|none", "slack": true|false } }',
  "  --accessor <userId>      レポートを実行する監査閲覧担当の userId(必須。メタ監査に記録)",
  "  --meta-audit-out <path>  メタ監査(audit_access)レコードの追記先(必須)。監査ストアへ取り込むこと",
  "  --raw-queries <path>     生クエリ原文の JSONL(Gateway の audit.jsonl.rawQueryPath)。省略時は失敗クエリの原文を出さない",
  "  --format text|json       出力形式(既定 text。json はメタ監査レコードを除いた集計本体)",
  "  -h, --help               この使い方を表示する",
  "",
  "レポート本文には失敗クエリの原文(機密を含みうる)が出ます。監査統制外の場所へ保存・転記しないでください(docs/playbook.md)。",
  "exit codes: 0 ok, 1 invalid input or read error, 2 usage error",
].join("\n");

interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

interface CliArgs {
  /** 監査 JSONL(1つ以上。指定順に読んで結合する) */
  audit: string[];
  sources: string;
  accessor: string;
  metaAuditOut: string;
  rawQueries?: string;
  format: "text" | "json";
}

function parseArgs(argv: readonly string[]): CliArgs | "help" {
  if (argv.some((arg) => arg === "--help" || arg === "-h")) {
    return "help";
  }
  const values = new Map<string, string>();
  const audit: string[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new UsageError(`invalid argument: ${flag ?? ""}`);
    }
    const name = flag.slice(2);
    if (name === "audit") {
      // 複数回指定できる(Gateway の監査 JSONL と Orchestrator の AnswerRun の JSONL)
      if (!value) throw new UsageError("--audit is required");
      audit.push(value);
      continue;
    }
    values.set(name, value);
  }
  if (audit.length === 0) throw new UsageError("--audit is required");
  const required = (name: string): string => {
    const v = values.get(name);
    if (!v) throw new UsageError(`--${name} is required`);
    return v;
  };
  const format = values.get("format") ?? "text";
  if (format !== "text" && format !== "json") {
    throw new UsageError(`--format must be text or json, got: ${format}`);
  }
  const known = new Set([
    "audit",
    "sources",
    "accessor",
    "meta-audit-out",
    "raw-queries",
    "format",
  ]);
  for (const key of values.keys()) {
    if (!known.has(key)) throw new UsageError(`unknown option: --${key}`);
  }
  const rawQueries = values.get("raw-queries");
  return {
    audit,
    sources: required("sources"),
    accessor: required("accessor"),
    metaAuditOut: required("meta-audit-out"),
    ...(rawQueries !== undefined ? { rawQueries } : {}),
    format,
  };
}

class UsageError extends Error {}

/** ファイルを読む(読めなければパスとエラーコードだけの InputError)。 */
async function readInput(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw unreadableFile(label, error);
  }
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
): Promise<number> {
  let args: CliArgs;
  try {
    const parsed = parseArgs(argv);
    if (parsed === "help") {
      io.stdout(HELP);
      return 0;
    }
    args = parsed;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    io.stderr(USAGE);
    return 2;
  }

  try {
    // 全ファイルのレコードをファイル順・行順に結合してから集計する
    const records: AuditRecord[] = [];
    for (const path of args.audit) {
      const parsed = parseAuditJsonl(await readInput(path, `--audit(${path})`), path);
      for (const record of parsed) records.push(record);
    }
    const sources: SourcesMeta = parseSourcesJson(
      await readInput(args.sources, `sources.json(${args.sources})`),
      args.sources,
    );
    let rawQueries: RawQueryRecord[] | undefined;
    if (args.rawQueries !== undefined) {
      rawQueries = parseRawQueryJsonl(
        await readInput(args.rawQueries, `--raw-queries(${args.rawQueries})`),
        args.rawQueries,
      );
    }

    // メタ監査の永続化が済むまでレポートは返らない(fail-closed)
    const report = await generatePromotionReport(
      {
        records,
        sources,
        ...(rawQueries !== undefined ? { rawQueries } : {}),
        accessorUserId: args.accessor,
      },
      async (metaAuditRecords) => {
        for (const record of metaAuditRecords) validateRecord(record);
        await appendFile(
          args.metaAuditOut,
          metaAuditRecords.map((r) => JSON.stringify(r)).join("\n") + "\n",
          "utf8",
        );
      },
    );

    if (args.format === "json") {
      const { metaAuditRecords: _written, ...body } = report;
      io.stdout(JSON.stringify(body, null, 2));
    } else {
      io.stdout(renderPromotionReportText(report));
    }
    return 0;
  } catch (error) {
    if (error instanceof InputError) {
      for (const line of error.lines) io.stderr(line);
    } else {
      io.stderr(error instanceof Error ? error.message : String(error));
    }
    return 1;
  }
}

/**
 * プロセスのエントリ。標準入出力につなぎ、終了コードを process.exitCode に設定する。
 * `node dist/cli.js`(下の isMainModule)と npm の bin(起動シム
 * bin/kp-promotion-report.js)の両方から呼ばれる。
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  process.exitCode = await runCli(argv, {
    stdout: (line) => process.stdout.write(line + "\n"),
    stderr: (line) => process.stderr.write(line + "\n"),
  });
}

/**
 * moduleUrl のモジュールがプロセスのエントリ(process.argv[1])として実行されたか。
 * 両側を realpath で正規化して比べる: シンボリックリンク経由の起動(npm の bin リンク、
 * workspace のリンク node_modules/@kp/promotion-report 等)では argv[1] がリンクのパス、
 * import.meta.url が実体のパスになり、そのまま比べると一致しない(何もせず exit 0 で
 * 終わってしまう)。解決できないパスはエントリではないとみなす。
 */
export function isMainModule(moduleUrl: string, argv1: string | undefined): boolean {
  if (typeof argv1 !== "string" || argv1 === "") {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await main();
}
