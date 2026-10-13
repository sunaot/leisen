#!/usr/bin/env node
/**
 * leisen-gateway CLI のエントリ(ビルド後は dist/bin/leisen-gateway.js)。
 *
 *   node packages/gateway/dist/bin/leisen-gateway.js serve --config examples/deployment.dev.yaml
 *
 * npm の bin(`npx leisen-gateway`)からは、リポジトリに含まれる起動シム
 * packages/gateway/bin/leisen-gateway.js 経由で読み込まれる。本体は cli/run.ts
 * (テストはそちらを直接呼ぶ。このファイルは読み込まれると即座に実行する)。
 */
import { runCli, waitForTerminationSignal } from "../cli/run.js";

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
  env: process.env,
  waitForShutdown: waitForTerminationSignal,
}).catch((error: unknown) => {
  // 想定外の失敗。生の例外メッセージ・スタックは出さない(TM-A2、不変条件6)
  process.stderr.write(
    `leisen-gateway: unexpected error (${error instanceof Error ? error.name : typeof error})\n`,
  );
  return 1;
});
