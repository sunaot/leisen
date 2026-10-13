/**
 * 昇格判定の対象分類(T-014)。
 *
 * 監査ログの sourceId はデプロイ設定上の識別子であり、それ自体では
 * 「Slackか」「nativeSearchクラスは何か」が分からない。レポート実行者
 * (導入支援エンジニア)が sources メタファイルで明示的に分類を与える。
 * 分類がないソースは判定対象に含めない(安全側)。
 */
import { z } from "zod";
import type { ConnectorCapabilities } from "@leisen/connector-sdk";

/** ソース1件の分類メタ。CLIでは JSON ファイルとして与える。 */
export const sourceMetaSchema = z.strictObject({
  /** コネクタ実装の ConnectorCapabilities.nativeSearch と一致させる */
  nativeSearch: z.enum(["full", "degraded", "none"]),
  /**
   * Slack(RTS/公式MCP)経由のソースなら true。Slackは中央インデックス化が
   * 原則不可のため昇格判定の対象外(ADR-014)。
   */
  slack: z.boolean().default(false),
});

export const sourcesMetaSchema = z.record(z.string().min(1), sourceMetaSchema);

export type SourceMeta = z.infer<typeof sourceMetaSchema>;
export type SourcesMeta = z.infer<typeof sourcesMetaSchema>;

/** 昇格判定上の扱い。 */
export type PromotionEligibility =
  /** 証拠駆動ゲートの判定対象 */
  | "eligible"
  /** Slack: 昇格判定の対象外(ADR-014) */
  | "excluded_slack"
  /** nativeSearch "none": 検索層必須クラスであり証拠駆動ゲートの適用外(ADR-007) */
  | "exempt_index_required"
  /** sourcesメタに分類がない。分類を与えるまで判定対象にしない */
  | "unclassified";

export function classifySource(
  sourceId: string,
  sources: SourcesMeta,
): PromotionEligibility {
  const meta = sources[sourceId];
  if (!meta) return "unclassified";
  if (meta.slack) return "excluded_slack";
  if (meta.nativeSearch === "none") return "exempt_index_required";
  return "eligible";
}

/** 型の食い違い検知用: sourcesメタの nativeSearch はコネクタ能力の部分集合 */
export type NativeSearchClass = ConnectorCapabilities["nativeSearch"];
