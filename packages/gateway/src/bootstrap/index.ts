/**
 * 起動コード(kp-gateway CLI、リファレンスデプロイ T-012)。
 *
 * - assemble.ts  設定 → コネクタ・資格情報プロバイダ・IdP Adapter・監査シンク・
 *                Gateway・HTTPサーバーの組み立て(assembleGateway)
 * - plugins.ts   コネクタ実装の解決(プログラム登録 → 組み込み → プラグイン)と
 *                factory の契約(ConnectorFactory)
 * - audit.ts     監査シンクの解決(stdout / jsonl)
 */
export * from "./assemble.js";
export * from "./plugins.js";
export * from "./audit.js";
