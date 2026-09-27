#!/usr/bin/env node
// kp-gateway の npm bin(起動シム)。
//
// npm はインストール時(npm ci / npm install)に bin のリンク先ファイルが存在
// しないとリンクを作らない。ビルド成果物(dist/)はインストール時点では存在しない
// ため、リポジトリに含まれるこのファイルを bin に登録し、ビルド済みの CLI
// (src/bin/kp-gateway.ts → dist/bin/kp-gateway.js)を読み込む。これにより
// `npm ci && npm run build` の直後から `npx kp-gateway` が使える。
import { existsSync } from "node:fs";

const entry = new URL("../dist/bin/kp-gateway.js", import.meta.url);
if (!existsSync(entry)) {
  process.stderr.write(
    "kp-gateway: build output not found (packages/gateway/dist). Run `npm run build` first.\n",
  );
  process.exit(1);
}
await import(entry.href);
