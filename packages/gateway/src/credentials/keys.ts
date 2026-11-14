/**
 * 鍵管理の層(ADR-022 決定 2・3 の KeyProvider)。
 *
 * Token Vault は資格情報 1 件ごとにデータ鍵(DEK、32 バイト)を生成して暗号化し、DEK を
 * この層で包んで(wrap)保管する。包む鍵(KEK)は KeyProvider の実装が持つ:
 * - local: 環境変数のマスター鍵(AES-256-GCM で包む。旧鍵を並べて入れ替えられる)
 * - aws_kms / gcp_kms: KMS の Encrypt / Decrypt(aws-kms.ts / gcp-kms.ts)
 *
 * context(userId・sourceId を含む文字列)は包みの付加データに結び付ける。別の行の
 * 包みを差し替えても解けない(行の入れ替えによる取り違えの防止。不変条件4)。
 * 鍵の値・DEK をログ・エラーに出さない(不変条件6)。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface WrappedKey {
  /** 包んだ KEK の識別子(local は鍵の指紋、KMS は鍵の名前) */
  readonly kekId: string;
  /** 包んだ DEK(base64url) */
  readonly wrapped: string;
}

export interface KeyProvider {
  /** 起動ログ用の説明(秘密情報なし) */
  readonly description: string;
  wrapKey(dek: Uint8Array, context: string): Promise<WrappedKey>;
  unwrapKey(wrapped: WrappedKey, context: string): Promise<Buffer>;
}

export class KeyProviderError extends Error {
  constructor(
    public readonly kind: "unavailable" | "invalid" | "unknown_key",
    message: string,
  ) {
    super(message);
    this.name = "KeyProviderError";
  }
}

export const MIN_MASTER_KEY_BYTES = 32;

/** hex / base64 / base64url の鍵素材を復号する(形が合わなければ undefined)。 */
export function decodeKeyBytes(value: string): Buffer | undefined {
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    return Buffer.from(trimmed, "hex");
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    return Buffer.from(trimmed, "base64");
  }
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return Buffer.from(trimmed, "base64url");
  }
  return undefined;
}

/** 鍵の指紋(SHA-256 の先頭 8 文字)。鍵そのものは出さない。 */
export function keyFingerprint(key: Uint8Array): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/** AES-256-GCM で包む(iv 12 | tag 16 | ct)。 */
export function aesGcmSeal(key: Uint8Array, plaintext: Uint8Array, aad: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

/** aesGcmSeal の逆。改竄・鍵違い・付加データ違いは例外(呼び出し側で分類する)。 */
export function aesGcmOpen(key: Uint8Array, sealed: Uint8Array, aad: string): Buffer {
  if (sealed.byteLength < 28) {
    throw new Error("sealed value is too short");
  }
  const buf = Buffer.from(sealed);
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
}

/**
 * 環境変数のマスター鍵で DEK を包む KeyProvider。現行鍵で包み、解くときは kekId
 * (鍵の指紋)で現行・旧鍵を引き分ける。鍵の入れ替えは「新鍵を現行・旧鍵を previous に
 * 置いて起動 → rewrapAll(vault.ts)→ previous を外す」の順で行う。
 */
export class LocalKeyProvider implements KeyProvider {
  readonly #keys = new Map<string, Buffer>();
  readonly #currentId: string;

  constructor(current: Uint8Array, previous: readonly Uint8Array[] = []) {
    for (const key of [current, ...previous]) {
      if (key.byteLength !== MIN_MASTER_KEY_BYTES) {
        throw new KeyProviderError(
          "invalid",
          `local master key must be exactly ${MIN_MASTER_KEY_BYTES} bytes`,
        );
      }
    }
    this.#currentId = `local:${keyFingerprint(current)}`;
    this.#keys.set(this.#currentId, Buffer.from(current));
    for (const key of previous) {
      this.#keys.set(`local:${keyFingerprint(key)}`, Buffer.from(key));
    }
  }

  get description(): string {
    return `local master key (kek ${this.#currentId}, ${this.#keys.size - 1} previous)`;
  }

  get currentKekId(): string {
    return this.#currentId;
  }

  async wrapKey(dek: Uint8Array, context: string): Promise<WrappedKey> {
    const key = this.#keys.get(this.#currentId) as Buffer;
    return {
      kekId: this.#currentId,
      wrapped: aesGcmSeal(key, dek, `leisen-kek|${context}`).toString("base64url"),
    };
  }

  async unwrapKey(wrapped: WrappedKey, context: string): Promise<Buffer> {
    const key = this.#keys.get(wrapped.kekId);
    if (key === undefined) {
      throw new KeyProviderError("unknown_key", `unknown key encryption key: ${wrapped.kekId}`);
    }
    try {
      return aesGcmOpen(key, Buffer.from(wrapped.wrapped, "base64url"), `leisen-kek|${context}`);
    } catch {
      throw new KeyProviderError("invalid", "wrapped key could not be unwrapped");
    }
  }
}
