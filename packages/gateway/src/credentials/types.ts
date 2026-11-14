/**
 * Token Store 層の型(ADR-022 決定 2: Auth Adapter の内側に置く 3 層)。
 *
 * - TokenVault(vault.ts): 封筒暗号化・更新の直列化。コアの 1 実装
 * - KeyProvider(keys.ts): DEK の包み・解き。local / aws_kms / gcp_kms を enum で選ぶ
 * - CredentialStore(store.ts): 暗号文・拒否リスト・使用済みの記録の保管先。暗号文しか
 *   見ない。sqlite を enum で選ぶ
 * ソースへの失効依頼は oauth.ts(ソースの API を知る層)が行い、保管層は関与しない。
 */

/** ソースの本人トークン一式。秘密情報(不変条件6): ログ・エラー・監査に出さない。 */
export interface SourceTokenSet {
  readonly accessToken: string;
  /** アクセストークンの失効時刻(epoch ms)。不明なら undefined */
  readonly accessExpiresAt?: number;
  readonly refreshToken?: string;
  /** 更新トークンの失効時刻(epoch ms)。不明なら undefined */
  readonly refreshExpiresAt?: number;
  /** 同意したスコープ(秘密ではない) */
  readonly scopes?: readonly string[];
  /** 取得(接続・更新)時刻(epoch ms)。ESC の拒否リスト(sub_source)の判定に使う */
  readonly obtainedAt: number;
}

/** 暗号化済みの 1 行(保管層が見るのはこれだけ)。 */
export interface SealedCredential {
  readonly userId: string;
  readonly sourceId: string;
  /** DEK を包んだ KEK の識別子 */
  readonly kekId: string;
  /** 包んだ DEK(base64url) */
  readonly wrappedKey: string;
  /** AES-256-GCM の暗号文(iv | tag | ct の base64url) */
  readonly ciphertext: string;
  /** 楽観的排他の版(1 始まり) */
  readonly version: number;
  /** 最初の接続時刻(epoch ms) */
  readonly connectedAt: number;
  /** 最終更新時刻(epoch ms) */
  readonly updatedAt: number;
}

/** 拒否リストの種別(ESC・認可サーバーのトークン。ADR-022 決定 5・6)。 */
export type DenialKind =
  /** 利用者単位: revokedBefore より前に発行したトークンを拒否(利用停止) */
  | "sub"
  /** ログインの系列(sid)単位: すべて拒否(/revoke、リフレッシュトークンの再利用検知) */
  | "sid"
  /** 利用者 × ソース単位: revokedBefore より前に取得したソースのトークンを拒否(解除) */
  | "sub_source";

export interface CredentialStore {
  readonly description: string;
  get(userId: string, sourceId: string): Promise<SealedCredential | undefined>;
  /**
   * 書き込み(比較交換)。expectedVersion が null なら「行がないこと」、数値なら「その版で
   * あること」を条件にする。条件を満たさなければ false(呼び出し側が読み直す)
   */
  put(record: SealedCredential, expectedVersion: number | null): Promise<boolean>;
  delete(userId: string, sourceId: string): Promise<boolean>;
  /** 利用者が接続済みのソース(一括失効・接続ページの表示用) */
  sourcesForUser(userId: string): Promise<string[]>;
  /** 全行の (userId, sourceId)(鍵の入れ替え用) */
  allKeys(): Promise<Array<{ userId: string; sourceId: string }>>;

  /**
   * 拒否の追加。revokedBefore は「この時刻より前の発行・取得を拒否」(sid は無条件のため
   * Number.MAX_SAFE_INTEGER)。既存より新しい revokedBefore だけを残す。expiresAt を過ぎた
   * 拒否は消してよい(対象のトークンがすべて失効している時刻)
   */
  addDenial(kind: DenialKind, key: string, revokedBefore: number, expiresAt: number): Promise<void>;
  /** 拒否の revokedBefore(なければ undefined) */
  denial(kind: DenialKind, key: string): Promise<number | undefined>;
  /** 使い捨ての印(認可コード・リフレッシュトークンの jti)。既に使われていれば false */
  markUsed(id: string, expiresAt: number): Promise<boolean>;
  /** 期限切れの拒否・使用済みの印を消す(件数を返す) */
  purgeExpired(now: number): Promise<number>;
  close(): void;
}
