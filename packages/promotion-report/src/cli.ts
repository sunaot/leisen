#!/usr/bin/env node
/**
 * 昇格判定レポートCLI(T-014)。
 *
 * 監査ログ(JSONL)とrawQueryテーブル(JSONL)を読み、ソース別未解決率・
 * 再検索回数分布・失敗クエリ原文のレポートを出力する。
 *
 * 使い方:
 *   kp-promotion-report \
 *     --audit audit-records.jsonl \
 *     --sources sources.json \
 *     --accessor <監査閲覧担当のuserId> \
 *     --meta-audit-out meta-audit.jsonl \
 *     [--raw-queries raw-queries.jsonl] [--format text|json]
 *
 * - sources.json: { "<sourceId>": { "nativeSearch": "full|degraded|none", "slack": bool } }
 * - 監査ログの閲覧はメタ監査の対象(ADR-013 §3)。本CLIは audit_access
 *   レコードを --meta-audit-out に追記する。このファイルを監査ストアへ
 *   取り込むこと。--accessor と --meta-audit-out は必須
 * - 入力レコードは全件zod検証する(不正レコードは即エラー、fail-closed)
 */
import { realpathSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  parseAuditRecord,
  rawQueryRecordSchema,
  validateRawQueryRecord,
  validateRecord,
  type AuditRecord,
  type RawQueryRecord,
} from "@kp/gateway";
import { generatePromotionReport } from "./aggregate.js";
import { renderPromotionReportText } from "./render.js";
import { sourcesMetaSchema } from "./sources.js";

const USAGE =
  "usage: kp-promotion-report --audit <records.jsonl> --sources <sources.json> " +
  "--accessor <userId> --meta-audit-out <meta.jsonl> " +
  "[--raw-queries <raw.jsonl>] [--format text|json]";

interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

interface CliArgs {
  audit: string;
  sources: string;
  accessor: string;
  metaAuditOut: string;
  rawQueries?: string;
  format: "text" | "json";
}

function parseArgs(argv: readonly string[]): CliArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new UsageError(`invalid argument: ${flag ?? ""}`);
    }
    values.set(flag.slice(2), value);
  }
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
    audit: required("audit"),
    sources: required("sources"),
    accessor: required("accessor"),
    metaAuditOut: required("meta-audit-out"),
    ...(rawQueries !== undefined ? { rawQueries } : {}),
    format,
  };
}

class UsageError extends Error {}

function parseJsonl<T>(
  content: string,
  path: string,
  parseLine: (input: unknown) => T,
): T[] {
  const records: T[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new Error(`${path}:${i + 1}: not valid JSON`);
    }
    try {
      records.push(parseLine(json));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${path}:${i + 1}: ${message}`);
    }
  }
  return records;
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    io.stderr(USAGE);
    return 2;
  }

  try {
    const records = parseJsonl<AuditRecord>(
      await readFile(args.audit, "utf8"),
      args.audit,
      parseAuditRecord,
    );
    const sources = sourcesMetaSchema.parse(
      JSON.parse(await readFile(args.sources, "utf8")),
    );
    let rawQueries: RawQueryRecord[] | undefined;
    if (args.rawQueries !== undefined) {
      rawQueries = parseJsonl<RawQueryRecord>(
        await readFile(args.rawQueries, "utf8"),
        args.rawQueries,
        (input) => {
          const record = rawQueryRecordSchema.parse(input);
          validateRawQueryRecord(record);
          return record;
        },
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
    io.stderr(error instanceof Error ? error.message : String(error));
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
