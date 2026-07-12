/**
 * 昇格判定レポート(T-014、ADR-006「有効化は証拠駆動」)。
 *
 * - aggregate.ts  監査ログ(ADR-011の2層モデル)からの集計。純粋関数
 * - render.ts     テキスト表示と判定ガイド(product-design.md 5.1)
 * - sources.ts    昇格判定の対象分類(Slack対象外=ADR-014、
 *                 index-required適用外=ADR-007)
 * - cli.ts        CLIエントリポイント(kp-promotion-report)
 *
 * 集計と表示は分離してある(将来の管理画面化のため)。監査ログへの
 * アクセスはメタ監査の対象(ADR-013 §3)。入口は generatePromotionReport
 * のみとし、メタ監査の書き込み成功をレポート返却の前提にする(fail-closed)。
 * 集計だけの関数は意図的に公開しない。
 */
export {
  generatePromotionReport,
  type FailedQuery,
  type IterationBucket,
  type PromotionReport,
  type PromotionReportInput,
  type SourceStat,
} from "./aggregate.js";
export * from "./render.js";
export * from "./sources.js";
export { runCli } from "./cli.js";
