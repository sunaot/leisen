/**
 * 入力ファイルの読み込みと検証エラーの表示(T-014、issue #38 UX R9)。
 *
 * - 監査 JSONL(--audit): 1行1レコード。Gateway の audit.sink: jsonl のファイル(ラッパーなし)
 *   に加え、audit.sink: stdout の標準出力(と kp-ask の stderr)の `{"kind":"audit", ...record}`
 *   の行も読む(違いは封筒の `kind` だけ。gateway の StdoutDebugAuditSink /
 *   orchestrator の StderrDebugAuditSink)。封筒を外したレコードは JSONL と同じ検証にかける
 *   (fail-closed。禁止フィールド・型にないキーは拒否)
 * - 監査レコードでない行(JSON でない・recordType がない・kind が audit 以外)は、行番号と
 *   渡すべき形式の案内(AUDIT_INPUT_FORMAT_HINT)を付けて拒否する
 * - sources.json: 検証エラーは「sources.json(<パス>): <場所>: <日本語の説明>」の形で1件1行
 *   (zod の生の JSON を出さない)
 * - エラーの文言には行の内容(質問の digest・userId 等)を載せない。載せるのはファイルのパス・
 *   行番号・フィールドの場所・期待する型と実際の型だけ
 */
import {
  parseAuditRecord,
  rawQueryRecordSchema,
  validateRawQueryRecord,
  type AuditRecord,
  type RawQueryRecord,
} from "@kp/audit";
import type { z } from "zod";
import { sourcesMetaSchema, type SourcesMeta } from "./sources.js";

/** 利用者向けのエラー(1件1行。stderr にそのまま出す)。 */
export class InputError extends Error {
  constructor(readonly lines: readonly string[]) {
    super(lines.join("\n"));
    this.name = "InputError";
  }
}

/** --audit に渡すべき形式の案内(監査レコードでない行を拒否するときに添える)。 */
export const AUDIT_INPUT_FORMAT_HINT =
  "--audit には監査レコードの JSONL(1行1レコード)を渡してください: Gateway の audit.sink: jsonl のファイル" +
  "(ToolInvocation と run の記録を含む)、または audit.sink: stdout の標準出力({\"kind\":\"audit\", …} の行。" +
  "{\"kind\":\"audit\" で始まる行だけを渡す)";

type Issue = z.core.$ZodIssue;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "unknown error";
}

/** 検証エラーの場所(例: gdrive.nativeSearch。ルートは「(ルート)」)。 */
export function issueLocation(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "(ルート)" : path.map((segment) => String(segment)).join(".");
}

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let current = input;
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === "number") {
      current = current[segment];
    } else if (isObject(current) && typeof segment === "string" && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** 実際の値の型(値そのものは出さない)。 */
function typeLabel(value: unknown): string {
  if (value === undefined) return "未指定";
  if (value === null) return "null";
  if (Array.isArray(value)) return "配列";
  switch (typeof value) {
    case "string":
      return "文字列";
    case "number":
      return "数値";
    case "boolean":
      return "真偽値";
    case "object":
      return "オブジェクト";
    default:
      return typeof value;
  }
}

const EXPECTED_LABELS: Readonly<Record<string, string>> = {
  object: "オブジェクト",
  record: "オブジェクト",
  array: "配列",
  string: "文字列",
  number: "数値",
  int: "整数",
  boolean: "真偽値(true / false)",
  null: "null",
};

/** zod の検証エラー1件を日本語の説明にする(入力の値は出さず、型だけを出す)。 */
export function describeIssue(issue: Issue, input: unknown): string {
  const actual = valueAt(input, issue.path);
  switch (issue.code) {
    case "invalid_type": {
      if (actual === undefined) {
        return "必須です(未指定)";
      }
      const expected = EXPECTED_LABELS[issue.expected] ?? issue.expected;
      return `${expected}にしてください(実際: ${typeLabel(actual)})`;
    }
    case "invalid_value":
      return `${issue.values.map((value) => String(value)).join(" / ")} のいずれかにしてください${
        actual === undefined ? "(未指定)" : ""
      }`;
    case "unrecognized_keys":
      return `未知のキー ${issue.keys.join(", ")} があります`;
    case "invalid_key":
      return "キーが不正です(空でない文字列にしてください)";
    case "invalid_union": {
      const options = (issue as { options?: unknown }).options;
      return Array.isArray(options)
        ? `${options.map((option) => String(option)).join(" / ")} のいずれかにしてください${
            actual === undefined ? "(未指定)" : ""
          }`
        : "どの形式にも合いません";
    }
    case "too_small":
    case "too_big":
    case "invalid_format":
    case "custom":
      // スキーマの文言(期待する形式。入力の値は含まない)
      return `値が不正です(${issue.message})`;
    default:
      return `値が不正です(${issue.code})`;
  }
}

/** zod の検証エラーか(パッケージを跨いだ zod の複製でも判定できるよう形で見る)。 */
function zodIssuesOf(error: unknown): readonly Issue[] | undefined {
  if (error instanceof Error && error.name === "ZodError") {
    const issues = (error as { issues?: unknown }).issues;
    return Array.isArray(issues) ? (issues as Issue[]) : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// sources.json
// ---------------------------------------------------------------------------

const SOURCES_SHAPE =
  '{ "<sourceId>": { "nativeSearch": "full|degraded|none", "slack": true|false } }';

/** sources.json の検証エラー1件の説明(sources.json に固有の補足を足す)。 */
function describeSourcesIssue(issue: Issue, input: unknown): string {
  const description = describeIssue(issue, input);
  if (issue.path.length === 0) {
    return `${description}。形式: ${SOURCES_SHAPE}`;
  }
  if (issue.code === "unrecognized_keys") {
    return `${description}(指定できるのは nativeSearch と slack)`;
  }
  if (issue.path.length === 1 && issue.code === "invalid_type") {
    return `${description}。形式: { "nativeSearch": "full|degraded|none", "slack": true|false }`;
  }
  return description;
}

/** sources.json を読む。不備は「sources.json(<パス>): <場所>: <説明>」の InputError。 */
export function parseSourcesJson(text: string, path: string): SourcesMeta {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new InputError([`sources.json(${path}): JSON として読めません`]);
  }
  const parsed = sourcesMetaSchema.safeParse(json);
  if (!parsed.success) {
    throw new InputError(
      parsed.error.issues.map(
        (issue) =>
          `sources.json(${path}): ${issueLocation(issue.path)}: ${describeSourcesIssue(issue, json)}`,
      ),
    );
  }
  return parsed.data;
}

/** ファイルを読めないときの InputError(パスとエラーコードだけ)。 */
export function unreadableFile(label: string, error: unknown): InputError {
  return new InputError([`${label}: 読めません(${errorCode(error)})`]);
}

// ---------------------------------------------------------------------------
// JSONL(監査レコード・rawQuery)
// ---------------------------------------------------------------------------

/** 1行の検証の失敗(行番号を付けて InputError にする)。 */
class LineError extends Error {}

/** --raw-queries に渡すべき形式の案内。 */
export const RAW_QUERY_INPUT_FORMAT_HINT =
  "--raw-queries には Gateway の audit.jsonl.rawQueryPath のファイル(1行1レコード)を渡してください";

function parseJsonl<T>(
  content: string,
  path: string,
  parseLine: (input: unknown) => T,
  formatHint: string,
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
      throw new InputError([`${path}:${i + 1}: JSON として読めません。${formatHint}`]);
    }
    try {
      records.push(parseLine(json));
    } catch (error) {
      if (error instanceof LineError) {
        throw new InputError([`${path}:${i + 1}: ${error.message}`]);
      }
      const issues = zodIssuesOf(error);
      const detail =
        issues !== undefined
          ? issues
              .map((issue) => `${issueLocation(issue.path)}: ${describeIssue(issue, json)}`)
              .join("; ")
          : error instanceof Error
            ? error.message
            : String(error);
      throw new InputError([`${path}:${i + 1}: レコードが不正です: ${detail}`]);
    }
  }
  return records;
}

/**
 * 監査 JSONL の1行を監査レコードとして読む。audit.sink: stdout の封筒(`kind: "audit"`)は
 * 外す。監査レコードでない行は渡すべき形式を案内して拒否する。
 */
export function parseAuditLine(input: unknown): AuditRecord {
  if (!isObject(input)) {
    throw new LineError(`監査レコードではありません(JSON のオブジェクトでない)。${AUDIT_INPUT_FORMAT_HINT}`);
  }
  let record: Record<string, unknown> = input;
  if (Object.hasOwn(input, "kind")) {
    if (input["kind"] !== "audit") {
      throw new LineError(
        `監査レコードではありません("kind" が "audit" 以外の行)。${AUDIT_INPUT_FORMAT_HINT}`,
      );
    }
    // audit.sink: stdout(kp-ask の stderr も同じ)の封筒を外す
    const { kind: _envelope, ...rest } = input;
    record = rest;
  }
  if (!Object.hasOwn(record, "recordType")) {
    throw new LineError(`監査レコードではありません(recordType がない)。${AUDIT_INPUT_FORMAT_HINT}`);
  }
  return parseAuditRecord(record);
}

/** 監査 JSONL(--audit の1ファイル)を読む。 */
export function parseAuditJsonl(content: string, path: string): AuditRecord[] {
  return parseJsonl(content, path, parseAuditLine, AUDIT_INPUT_FORMAT_HINT);
}

/** rawQuery の JSONL(--raw-queries)を読む。 */
export function parseRawQueryJsonl(content: string, path: string): RawQueryRecord[] {
  return parseJsonl(
    content,
    path,
    (input) => {
      const record = rawQueryRecordSchema.parse(input);
      validateRawQueryRecord(record);
      return record;
    },
    RAW_QUERY_INPUT_FORMAT_HINT,
  );
}
