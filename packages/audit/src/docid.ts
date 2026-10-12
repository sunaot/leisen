/**
 * docId の監査ログ上の秘匿化(T-001、ADR-013 §2)。
 *
 * - プライベートスコープ(DM・プライベートチャンネル・個人スコープ)のdocIdは
 *   `audit.privateScopeDocIds: hashed | omitted`(既定 hashed)に従って処理する。
 *   hashed はデプロイ固有鍵のHMACであり、参照頻度集計(T-014)を保つための
 *   牽制であって暗号学的匿名化ではない(ADR-013の明記事項)。
 * - **Slack由来のdocIdは設定に関わらず記録しない(omitted扱い)。** Slackの
 *   文書ID(channel:ts、permalink)は低エントロピーで列挙可能なため、鍵付き
 *   HMACではADR-014の不可逆化要件を満たさない(ADR-013 §2、不変条件7)。
 * - HMAC鍵はデプロイ固有の秘密であり、ログ・監査レコード・エラーに含めない
 *   (不変条件6)。
 */
import { createHmac } from "node:crypto";

export type PrivateScopeDocIdPolicy = "hashed" | "omitted";

/** ADR-013 §2 の既定値。 */
export const DEFAULT_PRIVATE_SCOPE_DOC_ID_POLICY: PrivateScopeDocIdPolicy =
  "hashed";

export interface DocIdAuditConfig {
  /** deployment.yaml の audit.privateScopeDocIds(既定 hashed) */
  privateScopeDocIds: PrivateScopeDocIdPolicy;
  /**
   * hashed のときに必須のデプロイ固有鍵。シリアライズ・ログ出力禁止。
   */
  hmacKey?: string;
}

/**
 * docIdの出所。privateScope は結果ごとの scope(コネクタが付ける。connector-sdk v0.4)と
 * ソースの方針(privateScopes)の論理和で決める(ADR-016 追補2 決定5。citedDocIds は
 * Orchestrator の audit.ts が組み立てる)。
 */
export interface DocIdOrigin {
  /** DM・プライベートチャンネル・個人スコープ等のプライベートスコープか */
  privateScope: boolean;
  /** Slack(RTS/公式MCP)由来か。true なら設定に関わらず記録しない */
  slackOrigin: boolean;
}

const HMAC_PREFIX = "hmac:";

/**
 * 監査レコードに記録してよい形へdocIdを変換する。
 * 戻り値 null は「記録しない(omitted)」を意味し、呼び出し側はフィールド・
 * 配列要素から除外する。
 */
export function redactDocIdForAudit(
  docId: string,
  origin: DocIdOrigin,
  config: DocIdAuditConfig,
): string | null {
  if (origin.slackOrigin) {
    // ADR-013 §2: Slack由来は hashed 設定でも記録しない(ADR-014の不可逆化要件)
    return null;
  }
  if (!origin.privateScope) {
    return docId;
  }
  if (config.privateScopeDocIds === "omitted") {
    return null;
  }
  const key = config.hmacKey;
  if (!key) {
    // 鍵欠落時に平文へフォールバックしない(fail-closed)
    throw new Error(
      "audit.privateScopeDocIds=hashed requires a deployment-specific hmacKey",
    );
  }
  return (
    HMAC_PREFIX + createHmac("sha256", key).update(docId, "utf8").digest("hex")
  );
}

/**
 * citedDocIds 等の配列向け。omitted(null)になったものは配列から除外する。
 */
export function redactDocIdsForAudit(
  docIds: ReadonlyArray<{ docId: string; origin: DocIdOrigin }>,
  config: DocIdAuditConfig,
): string[] {
  const out: string[] = [];
  for (const { docId, origin } of docIds) {
    const redacted = redactDocIdForAudit(docId, origin, config);
    if (redacted !== null) {
      out.push(redacted);
    }
  }
  return out;
}
