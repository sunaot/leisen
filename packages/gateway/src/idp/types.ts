/**
 * IdP Adapter IF(T-002、ADR-010)。
 *
 * ADR-010の認可方式分類(auth-matrix.md §12.1)をプラグイン境界として吸収する:
 * - A. oauth_individual: 個別OAuth(3-legged、本人トークン)。Token Vault 要
 * - B. token_exchange: OBO等のtoken exchange。Vault不要、IdPセッションに追随
 * - C. delegated_identity: 委譲身元。方式ごとにADR承認必須(T-017)
 * - D. サービスアカウント+本人判定は既定不採用(ソース別ADRで例外承認)のため
 *   この分類に含めない。コネクタ・プロバイダが独自にサービスアカウントへ
 *   フォールバックしてはならない(不変条件1)
 *
 * バックログのIF案は getCredential(userId, source) だが、方式B(OBO)は
 * 「本人のIdPトークン(subject token)」を都度交換に使うため、userId 文字列
 * だけでは資格情報を導出できない。そこで authenticate() が返す Identity
 * (userId+セッション)を受け取る形にし、方式A/B/Cの差を吸収する。
 */
import type { AuthContext, Credential } from "@leisen/connector-sdk";

/** ADR-010 §12.1 の方式分類(Dは既定不採用のため型に含めない)。 */
export type AuthMethod =
  | "oauth_individual"
  | "token_exchange"
  | "delegated_identity";

/**
 * authenticate() が検証したIdPセッション。
 * subjectToken は秘密情報(不変条件6): ログ・エラー・監査ログに出さない。
 * シリアライズする経路は必ず redactIdentity() を通す。
 */
export interface IdpSession {
  /**
   * 利用者本人のIdPトークン(方式Bのtoken exchangeのsubject token)。
   * ログ出力禁止。
   */
  readonly subjectToken: string;
  /** セッション失効時刻(epoch ms)。不明な場合は undefined */
  readonly expiresAt?: number;
}

/** 検証済みの利用者アイデンティティ。IdpAdapter.authenticate() が発行する。 */
export interface Identity {
  /** IdP上の一意なユーザーID(監査ログの主体、キャッシュキーの必須要素) */
  readonly userId: string;
  readonly displayName?: string;
  readonly session: IdpSession;
}

/** ログ・エラー出力用のredaction。Identityを文字列化する経路は必ずこれを通す。 */
export function redactIdentity(identity: Identity): {
  userId: string;
  displayName?: string;
  session: { redacted: true };
} {
  return {
    userId: identity.userId,
    ...(identity.displayName !== undefined
      ? { displayName: identity.displayName }
      : {}),
    session: { redacted: true },
  };
}

/** IdP Adapter層のエラー分類。 */
export type IdpErrorClass =
  /** セッション無効(トークン欠落・失効・改竄)。再認証が必要 */
  | "unauthenticated"
  /** 本人がこのソースを未接続(初回同意UXへ誘導する。ADR-010 決定3) */
  | "source_not_connected"
  /** IdP自体に到達できない・応答が異常 */
  | "idp_unavailable"
  /** 設定不備(未登録ソース、production下のモック等) */
  | "misconfigured";

export class IdpError extends Error {
  constructor(
    public readonly errorClass: IdpErrorClass,
    /** メッセージに秘密情報(トークン値等)を含めないこと(不変条件6) */
    message: string,
  ) {
    super(message);
    this.name = "IdpError";
  }
}

/**
 * ソース別の資格情報プロバイダ(ADR-010「ソース別Auth Adapter」)。
 * IdpAdapter 実装はこのプロバイダ群に方式差を委譲する。
 * - 方式A: Token Vault からリフレッシュトークンを取得してアクセストークン化
 * - 方式B: identity.session.subjectToken を都度交換(OBO)
 * - 方式C: identity.userId からソース側principalを導出
 */
export interface CredentialProvider {
  readonly sourceId: string;
  readonly method: AuthMethod;
  /**
   * 利用者本人の資格情報を発行する。未接続なら IdpError("source_not_connected")。
   * 戻り値はキャッシュされうる(キーはuserId×sourceId、不変条件4)。
   */
  getCredential(identity: Identity): Promise<Credential>;
}

/**
 * IdP Adapter(T-002のプラグイン境界)。Gatewayはこの2メソッドだけに依存し、
 * IdP実装(モック / Keycloak / 各社IdP)を deployment.yaml で差し替える(ADR-005)。
 */
export interface IdpAdapter {
  /**
   * セッション検証: クライアントが提示したセッショントークン(Bearer)を検証し、
   * 利用者本人の Identity を返す。無効なら IdpError("unauthenticated")。
   */
  authenticate(sessionToken: string): Promise<Identity>;

  /**
   * 指定ソース向けの本人資格情報を取得し、コネクタへ渡す AuthContext を返す。
   * userId は identity.userId を用いる(バックログの getCredential(userId, source)
   * に対応。Identityを取るのは方式Bがsubject tokenを要するため)。
   */
  getCredential(identity: Identity, sourceId: string): Promise<AuthContext>;

  /**
   * 失効の反映: 該当ユーザーの資格情報キャッシュを破棄する。
   * IdPのdeprovisioningイベント(SCIM等)受信時に呼ぶ(TM-C4)。
   * Token Vault内のトークンrevokeはT-004(TokenVault.revokeAllForUser)。
   */
  invalidateUser(userId: string): void;
}

/**
 * Token Vault IF(骨格のみ、実装はT-004)。
 * 方式A(個別OAuth)のリフレッシュトークンを暗号化保管(KMS連携)・
 * ローテーション・失効する中核コンポーネント(ADR-010 決定2)。
 */
export interface VaultedToken {
  /** リフレッシュトークン等の長期秘密。ログ出力禁止(不変条件6) */
  readonly secret: string;
  /** 保管時刻(epoch ms)。ローテーション判定に使う */
  readonly storedAt: number;
  /** 発行時に同意したスコープ(監査・再同意判定用。秘密ではない) */
  readonly scopes?: readonly string[];
}

export interface TokenVault {
  /** 初回同意フロー完了時に保管する。既存があれば置き換え(ローテーション) */
  store(userId: string, sourceId: string, token: VaultedToken): Promise<void>;
  /** 未保管(未接続)なら null。呼び出し元は source_not_connected として扱う */
  retrieve(userId: string, sourceId: string): Promise<VaultedToken | null>;
  /** ソース側のrevokeエンドポイント呼び出しと保管削除。 */
  revoke(userId: string, sourceId: string): Promise<void>;
  /**
   * IdPのdeprovisioningイベント(SCIM等)を受けて、該当ユーザーの全ソースの
   * トークンをrevokeする(ADR-010 決定2、TM-C4)。
   */
  revokeAllForUser(userId: string): Promise<void>;
}
