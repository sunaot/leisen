/**
 * 開発専用の部品(本番 NODE_ENV=production では構築を拒否する)。
 * - fixture-connector.ts  インメモリの開発用コネクタ(組み込み kind: dev-fixture)
 * - search-modes.ts       開発用コネクタの検索方式(実ソースの検索の仕様の模擬。評価用)
 * - synthetic-corpus.ts   乱数の種を固定した合成コーパスの生成(評価用の無関係な文書)
 */
export * from "./fixture-connector.js";
export * from "./search-modes.js";
export * from "./synthetic-corpus.js";
