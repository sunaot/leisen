/**
 * run モジュール(ADR-019 決定10、T-023)。
 *
 * - runid.ts   runId の発行・検証(HMAC 署名、鍵束、期限)と runId の形の検証
 * - records.ts pending の AnswerRun と部分レコード(answer_run_finish / answer_run_feedback)の
 *              組み立て。引用 docId の記録規則(決定5)
 * - request.ts run API の本文の検証(上限付き)
 *
 * MCP(`@modelcontextprotocol/sdk`)・コネクタ IF(`@kp/connector-sdk`)・Gateway の proxy/・
 * idp/・config/ に依存しない(scripts/lint-imports.mjs が検査する)。認証済みの主体
 * (userId・actor)と値だけを受け取り、ソースの知識は判定の関数として注入される。
 * 組み立て役(bootstrap / proxy/http.ts)だけがすべてを知る。
 */
export * from "./path.js";
export * from "./runid.js";
export * from "./records.js";
export * from "./request.js";
