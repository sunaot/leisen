/**
 * 資格情報の事象の記録(ADR-022 決定 9)。監査ストアへの書き手は Gateway だけ(不変条件2)。
 * トークン・メールアドレス・ソース側のアカウント識別子を渡さない(型に置き場がない)。
 */
import { randomUUID } from "node:crypto";
import type { AuditLogger, CredentialEventType, CredentialMethod } from "@leisen/audit";

export interface CredentialEvent {
  readonly userId: string;
  readonly event: CredentialEventType;
  readonly sourceId?: string;
  readonly method?: CredentialMethod;
  readonly outcome: "success" | "failure";
  /** 正規化済みの理由コード(英小文字・数字・_ .) */
  readonly reason?: string;
  readonly clientId?: string;
}

export type CredentialEventSink = (event: CredentialEvent) => Promise<void>;

/** 理由コードの形に正規化する(監査スキーマの reasonCode に合わせる)。 */
export function toReasonCode(value: string): string {
  const code = value.toLowerCase().replace(/[^a-z0-9_.]/g, "_").replace(/^[^a-z]+/, "");
  return (code === "" ? "unknown" : code).slice(0, 64);
}

export function auditCredentialEventSink(
  logger: AuditLogger,
  options: { now?: () => number; ids?: () => string } = {},
): CredentialEventSink {
  const now = options.now ?? Date.now;
  const ids = options.ids ?? randomUUID;
  return async (event) => {
    await logger.log({
      recordType: "credential_event",
      recordId: ids(),
      timestamp: new Date(now()).toISOString(),
      userId: event.userId,
      event: event.event,
      sourceId: event.sourceId ?? null,
      method: event.method ?? null,
      outcome: event.outcome,
      reason: event.reason !== undefined ? toReasonCode(event.reason) : null,
      clientId: event.clientId ?? null,
    });
  };
}

/** 記録先のない構成・テスト用。 */
export const discardCredentialEvents: CredentialEventSink = async () => undefined;
