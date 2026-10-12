/**
 * 監査ログ — 2層モデル(ADR-011)+ zod検証(T-001)。
 *
 * モジュール構成:
 * - schema.ts    レコード定義(zod)。AnswerRun / ToolInvocation の2層に加え、
 *                メタ監査(audit_access)と削除実行記録(retention_purge)
 * - docid.ts     プライベートスコープdocIdの hashed/omitted 処理と
 *                Slack由来docIdの不記録(ADR-013 §2、ADR-014)
 * - rawquery.ts  生クエリ原文の短期保持別テーブル(queryDigestで結合)
 * - retention.ts 保持期間の設定注入と期限超過削除+削除実行の記録
 * - sink.ts      永続sink(retry・local buffer・at-least-once・flush)と
 *                stdoutデバッグsinkの分離、AuditLogger
 * - jsonl.ts     JSONLファイルの監査ストア・rawQueryテーブル(audit.sink: jsonl)
 *
 * 不変条件:
 * - 全ツール呼び出しにつき ToolInvocation を正確に1レコード。Gateway以外から書かない
 * - 秘密情報(トークン、認証ヘッダ、文書本文)のフィールドは存在させない
 * - post-filtering前の候補件数フィールドは存在させない(ADR-011/012)
 * - 書き込み失敗時の挙動は ADR-011(既定 fail-closed)。Gateway統合は T-003
 *
 * 集計サンプルクエリ(ソース別未解決率、再検索回数分布、rawQuery結合)は
 * docs/audit-queries.md を参照。
 */
export * from "./schema.js";
export * from "./docid.js";
export * from "./rawquery.js";
export * from "./retention.js";
export * from "./sink.js";
export * from "./jsonl.js";
