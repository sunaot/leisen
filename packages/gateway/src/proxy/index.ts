/**
 * Gateway MCPプロキシ骨格(T-003)。
 *
 * モジュール構成:
 * - types.ts     セッション・呼び出し・正規化エラーの型
 * - session.ts   MCPセッションと利用者アイデンティティの束縛(ADR-001 追補)
 * - ratelimit.ts ソース別レート制御(上限はdeployment.yamlから注入)
 * - gateway.ts   コアパイプライン(実行区分照合・資格情報取得・タイムアウト・
 *                snippet truncate・監査fail-closed)
 * - mcp.ts       MCPサーバー面(@modelcontextprotocol/sdk、ADR-001 追補2)
 */
export * from "./types.js";
export * from "./session.js";
export * from "./ratelimit.js";
export * from "./gateway.js";
export * from "./mcp.js";
