#!/usr/bin/env node
/**
 * import 境界の検査(ADR-019 決定10、T-023)。
 *
 * 監査のモジュール(@kp/audit)と Gateway の run モジュールは、同じプロセスに同居しても
 * MCP・コネクタ IF・認証・設定に依存させない。ここでは TypeScript ソースの import / export
 * 文と動的 import の指定子を読み、各境界の許可リストに合わないものを違反として報告する
 * (違反があれば終了コード 1。CI の `npm run lint:imports` から呼ぶ)。
 *
 * - packages/audit/src       : 許可 = node:*、zod、同じディレクトリ木の中の相対パス
 * - packages/gateway/src/run : 許可 = node:*、zod、@kp/audit、同じディレクトリ木の中の相対パス
 *   (段階 2 で作る。存在しないうちは検査対象から外す)
 *
 * 禁止側を列挙しない(許可リスト方式): `proxy/`・`idp/`・`config/`・`@modelcontextprotocol/sdk`・
 * `@kp/connector-sdk` を名指しで禁止すると、新しい依存が増えたときに検査から漏れる。
 *
 * 使い方: node scripts/lint-imports.mjs [--root <dir>]
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** 境界の定義。dir はリポジトリルートからの相対パス */
export const BOUNDARIES = [
  {
    name: "@kp/audit",
    dir: "packages/audit/src",
    allowBare: [/^node:/, /^zod$/],
  },
  {
    name: "gateway run module",
    dir: "packages/gateway/src/run",
    allowBare: [/^node:/, /^zod$/, /^@kp\/audit$/],
  },
];

const SPECIFIER_PATTERNS = [
  // import x from "..." / import { x } from "..." / import type { x } from "..." / import "..."
  /\bimport\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g,
  // export { x } from "..." / export * from "..."
  /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g,
  // import("...")
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

async function listTsFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listTsFiles(path)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

function specifiersOf(source) {
  const found = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      found.push(match[1]);
    }
  }
  return found;
}

function isInside(baseDir, target) {
  const rel = relative(baseDir, target);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel);
}

/**
 * 1 つの境界を検査し、違反の一覧を返す。各違反は { file, specifier, reason }。
 * 境界のディレクトリがなければ空配列(段階 2 までの run モジュール)。
 */
export async function checkBoundary(root, boundary) {
  const baseDir = resolve(root, boundary.dir);
  try {
    if (!(await stat(baseDir)).isDirectory()) return [];
  } catch {
    return [];
  }
  const violations = [];
  for (const file of await listTsFiles(baseDir)) {
    const source = await readFile(file, "utf8");
    for (const specifier of specifiersOf(source)) {
      const shown = relative(root, file);
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier);
        if (!isInside(baseDir, target) && target !== baseDir) {
          violations.push({
            file: shown,
            specifier,
            reason: `relative import leaves ${boundary.dir}`,
          });
        }
        continue;
      }
      if (!boundary.allowBare.some((pattern) => pattern.test(specifier))) {
        violations.push({
          file: shown,
          specifier,
          reason: `not in the allow list of ${boundary.name}`,
        });
      }
    }
  }
  return violations;
}

export async function checkImports(root, boundaries = BOUNDARIES) {
  const all = [];
  for (const boundary of boundaries) {
    all.push(...(await checkBoundary(root, boundary)));
  }
  return all;
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const rootFlag = process.argv.indexOf("--root");
  const root = resolve(
    rootFlag >= 0 && process.argv[rootFlag + 1]
      ? process.argv[rootFlag + 1]
      : join(dirname(fileURLToPath(import.meta.url)), ".."),
  );
  const violations = await checkImports(root);
  if (violations.length === 0) {
    console.log(`lint-imports: ok (${BOUNDARIES.map((b) => b.dir).join(", ")})`);
    process.exit(0);
  }
  console.error(`lint-imports: ${violations.length} violation(s) (ADR-019 決定10)`);
  for (const v of violations) {
    console.error(`  ${v.file}: "${v.specifier}" — ${v.reason}`);
  }
  process.exit(1);
}
