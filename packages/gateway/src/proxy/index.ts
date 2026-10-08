/**
 * Gateway MCPプロキシ(T-003)。MCP仕様2026-07-28版(ステートレス)を設計前提と
 * する(ADR-001 追補3): 利用者はリクエストごとに認証し、接続・サーバー
 * インスタンスにユーザー状態を持たせない。
 *
 * モジュール構成:
 * - types.ts     リクエスト単位セッション・呼び出し・正規化エラーの型
 * - session.ts   リクエストと利用者アイデンティティの束縛(状態を持たない)
 * - meta.ts      `_meta` の独自申告(名前空間prefix、runId / iteration・
 *                実行区分・actor)
 * - ratelimit.ts ソース別レート制御(上限はdeployment.yamlから注入)
 * - gateway.ts   コアパイプライン(実行区分照合・資格情報取得・タイムアウト・
 *                snippet truncate・監査fail-closed)
 * - tools.ts     MCPツール面のSDK非依存ロジック(ツール定義・引数検証・
 *                リクエスト単位セッションの組み立て・エラー正規化)
 * - mcp.ts       MCP SDKとの接合(Server生成・ハンドラ登録・AuthInfo、
 *                @modelcontextprotocol/sdk、ADR-001 追補2)。ユーザー状態を
 *                持たない部品
 * - http.ts      Streamable HTTPトランスポート(node:http、リクエスト単位認証、
 *                GET /healthz)。SDKに触れるのはトランスポート生成部のみ
 *
 * 上記のうちSDKに依存するのは mcp.ts と http.ts のトランスポート部分だけで、
 * 認証・`_meta` の解決・エラー正規化・監査はSDK非依存(SDK差し替え時の
 * 手戻りを限定する)。
 */
export * from "./types.js";
export * from "./session.js";
export * from "./meta.js";
export * from "./ratelimit.js";
export * from "./gateway.js";
export * from "./tools.js";
export * from "./mcp.js";
export * from "./http.js";
