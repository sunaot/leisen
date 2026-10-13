/**
 * leisen-ask の npm bin(起動シム bin/leisen-ask.js、T-021 / UX レビュー R7)。ビルド成果物(dist)が
 * ある場合だけ子プロセスで実行する(src は直接実行しない)。
 *
 * - シム経由・シムへのシンボリックリンク(npm の .bin)経由でも CLI が1回だけ動く
 * - dist/bin/leisen-ask.js を直接起動しても動く(自分がエントリのときだけ自動実行する)
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_DIR = fileURLToPath(new URL("../", import.meta.url));
const DIST_CLI = join(PACKAGE_DIR, "dist", "bin", "leisen-ask.js");
const BIN_SHIM = join(PACKAGE_DIR, "bin", "leisen-ask.js");

function run(entry: string, args: readonly string[]) {
  return spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", env: {} });
}

describe.skipIf(!existsSync(DIST_CLI))("leisen-ask の起動シム(子プロセス)", () => {
  it("シム・シムへのシンボリックリンク・dist の直接起動のいずれでも serve --help が1回だけ出る", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t021-bin-"));
    const link = join(dir, "leisen-ask");
    await symlink(BIN_SHIM, link);

    for (const entry of [BIN_SHIM, link, DIST_CLI]) {
      const result = run(entry, ["serve", "--help"]);
      expect(result.status).toBe(0);
      expect(result.stdout.split("usage: leisen-ask serve")).toHaveLength(2);
    }
  });

  it("引数の不備は終了コード 2(serve も従来の質問モードも)", () => {
    const serve = run(BIN_SHIM, ["serve"]);
    expect(serve.status).toBe(2);
    expect(serve.stderr).toContain("--gateway");

    const ask = run(BIN_SHIM, []);
    expect(ask.status).toBe(2);
    expect(ask.stderr).toContain("usage: leisen-ask");
  });
});
