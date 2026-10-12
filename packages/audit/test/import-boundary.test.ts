/**
 * import 境界の検査(scripts/lint-imports.mjs、ADR-019 決定10)。
 * - リポジトリの現状が境界を満たす(違反 0)
 * - 禁止された依存(MCP SDK / connector-sdk / Gateway の proxy・idp・config への相対パス)を
 *   監査モジュールに書くと検出される
 * - 境界のディレクトリがなければ検査しない(run モジュールは段階 2 で作る)
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — 検査スクリプトは型定義のない ESM(scripts/ 配下)
import { BOUNDARIES, checkBoundary, checkImports } from "../../../scripts/lint-imports.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

type Violation = { file: string; specifier: string; reason: string };
type Boundary = { name: string; dir: string; allowBare: RegExp[] };

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function fakeRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kp-lint-imports-"));
  tempDirs.push(root);
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), body, "utf8");
  }
  return root;
}

const auditBoundary = (BOUNDARIES as Boundary[]).find((b) => b.dir === "packages/audit/src")!;
const runBoundary = (BOUNDARIES as Boundary[]).find((b) => b.dir === "packages/gateway/src/run")!;

describe("lint-imports: the repository satisfies the boundaries", () => {
  it("reports no violation for packages/audit/src (and the run module once it exists)", async () => {
    const violations = (await checkImports(REPO_ROOT)) as Violation[];
    expect(violations).toEqual([]);
  });

  it("defines both boundaries of ADR-019 決定10", () => {
    expect(auditBoundary).toBeDefined();
    expect(runBoundary).toBeDefined();
    expect(runBoundary.allowBare.some((p) => p.test("@kp/audit"))).toBe(true);
    expect(auditBoundary.allowBare.some((p) => p.test("@kp/audit"))).toBe(false);
  });
});

describe("lint-imports: forbidden dependencies are detected", () => {
  it("flags MCP SDK, connector-sdk, and Gateway-internal relative imports from @kp/audit", async () => {
    const root = await fakeRepo({
      "packages/audit/src/index.ts": [
        'import { z } from "zod";',
        'import { createHash } from "node:crypto";',
        'import { schema } from "./schema.js";',
        'import { Server } from "@modelcontextprotocol/sdk/server/index.js";',
        'import type { Connector } from "@kp/connector-sdk";',
        'import { Gateway } from "../../gateway/src/proxy/gateway.js";',
        'export * from "../../gateway/src/config/index.js";',
        'const lazy = await import("../../gateway/src/idp/index.js");',
      ].join("\n"),
      "packages/audit/src/schema.ts": "export const schema = 1;\n",
    });
    const violations = (await checkBoundary(root, auditBoundary)) as Violation[];
    expect(violations.map((v) => v.specifier).sort()).toEqual(
      [
        "../../gateway/src/config/index.js",
        "../../gateway/src/idp/index.js",
        "../../gateway/src/proxy/gateway.js",
        "@kp/connector-sdk",
        "@modelcontextprotocol/sdk/server/index.js",
      ].sort(),
    );
    for (const v of violations) {
      expect(v.file).toBe("packages/audit/src/index.ts");
    }
  });

  it("lets the run module import @kp/audit but not proxy/, idp/, config/ or the MCP SDK", async () => {
    const root = await fakeRepo({
      "packages/gateway/src/run/index.ts": [
        'import { validateRecord } from "@kp/audit";',
        'import { timingSafeEqual } from "node:crypto";',
        'import { issue } from "./runid.js";',
        'import { GatewayError } from "../proxy/types.js";',
        'import type { Identity } from "../idp/types.js";',
        'import { deploymentConfigSchema } from "../config/schema.js";',
        'import { Server } from "@modelcontextprotocol/sdk/server/index.js";',
      ].join("\n"),
      "packages/gateway/src/run/runid.ts": "export const issue = 1;\n",
    });
    const violations = (await checkBoundary(root, runBoundary)) as Violation[];
    expect(violations.map((v) => v.specifier).sort()).toEqual(
      [
        "../config/schema.js",
        "../idp/types.js",
        "../proxy/types.js",
        "@modelcontextprotocol/sdk/server/index.js",
      ].sort(),
    );
  });

  it("fails when a boundary directory does not exist (a renamed module must not silently drop the check)", async () => {
    const root = await fakeRepo({ "packages/audit/src/index.ts": 'import { z } from "zod";\n' });
    expect(await checkBoundary(root, runBoundary)).toEqual([
      expect.objectContaining({ file: "packages/gateway/src/run", reason: expect.stringContaining("does not exist") }),
    ]);
    expect((await checkImports(root)) as Violation[]).toHaveLength(1);
  });

  it("detects re-exports in every form (export * as ns from, export { x } from, export type)", async () => {
    const root = await fakeRepo({
      "packages/audit/src/a.ts": 'export * as sdk from "@modelcontextprotocol/sdk";\n',
      "packages/audit/src/b.ts": 'export { Server } from "@modelcontextprotocol/sdk/server/index.js";\n',
      "packages/audit/src/c.ts": 'export type { Connector } from "@kp/connector-sdk";\n',
      "packages/audit/src/d.ts": 'export * from "zod";\n',
    });
    const violations = (await checkBoundary(root, auditBoundary)) as Violation[];
    expect(violations.map((v) => v.specifier).sort()).toEqual(
      ["@kp/connector-sdk", "@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/server/index.js"].sort(),
    );
  });

  it("ignores .d.ts files and reads nested directories", async () => {
    const root = await fakeRepo({
      "packages/audit/src/types.d.ts": 'import { Server } from "@modelcontextprotocol/sdk";\n',
      "packages/audit/src/nested/deep.ts": 'import yaml from "yaml";\n',
    });
    const violations = (await checkBoundary(root, auditBoundary)) as Violation[];
    expect(violations).toEqual([
      {
        file: "packages/audit/src/nested/deep.ts",
        specifier: "yaml",
        reason: "not in the allow list of @kp/audit",
      },
    ]);
  });
});
