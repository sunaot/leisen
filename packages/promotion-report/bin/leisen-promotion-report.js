#!/usr/bin/env node
// leisen-promotion-report の npm bin(起動シム)。
//
// npm はインストール時(npm ci / npm install)に bin のリンク先ファイルが存在
// しないとリンクを作らない。ビルド成果物(dist/)はインストール時点では存在しない
// ため、リポジトリに含まれるこのファイルを bin に登録し、ビルド済みの CLI
// (src/cli.ts → dist/cli.js)を読み込んで main() を呼ぶ。これにより
// `npm ci && npm run build` の直後から `npx leisen-promotion-report` が使える
// (packages/gateway/bin/leisen-gateway.js と同じ方式)。
// dist/cli.js は自分がエントリのときだけ自動実行するため(isMainModule)、
// このシムから読み込んだときは二重に実行されない。
import { existsSync } from "node:fs";

const entry = new URL("../dist/cli.js", import.meta.url);
if (!existsSync(entry)) {
  process.stderr.write(
    "leisen-promotion-report: build output not found (packages/promotion-report/dist). Run `npm run build` first.\n",
  );
  process.exit(1);
}
const { main } = await import(entry.href);
await main();
