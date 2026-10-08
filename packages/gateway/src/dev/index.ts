/**
 * 開発専用の部品(本番 NODE_ENV=production では構築を拒否する)。
 * - fixture-connector.ts  インメモリの開発用コネクタ(組み込み kind: dev-fixture)
 */
export * from "./fixture-connector.js";
