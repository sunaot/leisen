/**
 * Gateway が発行する自己完結型の暗号文(ESC。ADR-022 決定 4)の封緘。
 *
 * JWE Compact Serialization(RFC 7516)の `alg: dir` + `enc: A256GCM`。
 * - 鍵は ESC のマスター鍵(gateway.credentials.escKeyEnv、32 バイト)から用途(typ)ごとに
 *   HKDF-SHA256 で導く。アクセストークンの鍵でリフレッシュトークンを開けない
 * - 保護ヘッダ(kid・typ)は付加データとして認証される。本文は暗号化され、中継者
 *   (LibreChat・MCP クライアント・ログ)には中身が見えない
 * - 鍵の入れ替え: 新鍵を現行・旧鍵を previous に置いて起動し、旧鍵で封じたものの期限
 *   (リフレッシュトークンの最長期間)を過ぎてから旧鍵を外す
 * 鍵・平文をログ・エラーに出さない(不変条件6)。
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export type SealPurpose =
  | "access_token"
  | "refresh_token"
  | "authorization_code"
  | "client_id"
  | "state"
  | "browser_session";

const TYP: Record<SealPurpose, string> = {
  access_token: "at+leisen",
  refresh_token: "rt+leisen",
  authorization_code: "code+leisen",
  client_id: "client+leisen",
  state: "state+leisen",
  browser_session: "session+leisen",
};

interface DerivedKey {
  readonly kid: string;
  readonly keys: ReadonlyMap<SealPurpose, Buffer>;
}

function derive(master: Uint8Array): DerivedKey {
  const kid = createHash("sha256").update(master).digest("hex").slice(0, 8);
  const keys = new Map<SealPurpose, Buffer>();
  for (const purpose of Object.keys(TYP) as SealPurpose[]) {
    keys.set(purpose, Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), `leisen-esc-v1/${purpose}`, 32)));
  }
  return { kid, keys };
}

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealError";
  }
}

const b64 = (data: Buffer | string) => Buffer.from(data).toString("base64url");

export class Sealer {
  readonly #current: DerivedKey;
  readonly #byKid = new Map<string, DerivedKey>();

  constructor(current: Uint8Array, previous: readonly Uint8Array[] = []) {
    for (const key of [current, ...previous]) {
      if (key.byteLength !== 32) {
        throw new SealError("ESC key must be exactly 32 bytes");
      }
    }
    this.#current = derive(current);
    this.#byKid.set(this.#current.kid, this.#current);
    for (const key of previous) {
      const derived = derive(key);
      this.#byKid.set(derived.kid, derived);
    }
  }

  get kid(): string {
    return this.#current.kid;
  }

  seal(purpose: SealPurpose, payload: unknown): string {
    const header = b64(JSON.stringify({ alg: "dir", enc: "A256GCM", kid: this.#current.kid, typ: TYP[purpose] }));
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#current.keys.get(purpose) as Buffer, iv);
    cipher.setAAD(Buffer.from(header, "ascii"));
    const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    return `${header}..${b64(iv)}.${b64(ct)}.${b64(cipher.getAuthTag())}`;
  }

  /** 開く。形式・用途・鍵・改竄のどれかが合わなければ SealError(理由は区別しない)。 */
  open(purpose: SealPurpose, token: string): unknown {
    const parts = token.split(".");
    if (parts.length !== 5 || parts[1] !== "") {
      throw new SealError("not a sealed token");
    }
    const [headerB64, , ivB64, ctB64, tagB64] = parts as [string, string, string, string, string];
    let header: unknown;
    try {
      header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as unknown;
    } catch {
      throw new SealError("not a sealed token");
    }
    if (
      typeof header !== "object" ||
      header === null ||
      (header as { alg?: unknown }).alg !== "dir" ||
      (header as { enc?: unknown }).enc !== "A256GCM" ||
      (header as { typ?: unknown }).typ !== TYP[purpose]
    ) {
      throw new SealError("not a sealed token of the expected type");
    }
    const derived = this.#byKid.get(String((header as { kid?: unknown }).kid));
    if (derived === undefined) {
      throw new SealError("sealed with an unknown key");
    }
    const iv = Buffer.from(ivB64, "base64url");
    const tag = Buffer.from(tagB64, "base64url");
    // 認証タグは 16 バイト固定(切り詰めたタグを受けると偽造の試行が安くなる)、IV は 12 バイト
    if (iv.byteLength !== 12 || tag.byteLength !== 16) {
      throw new SealError("sealed token could not be opened");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", derived.keys.get(purpose) as Buffer, iv, { authTagLength: 16 });
      decipher.setAAD(Buffer.from(headerB64, "ascii"));
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]);
      return JSON.parse(plain.toString("utf8")) as unknown;
    } catch {
      throw new SealError("sealed token could not be opened");
    }
  }

  /** 用途の判定(ヘッダの typ だけを見る。中身は開かない)。 */
  static purposeOf(token: string): SealPurpose | undefined {
    const parts = token.split(".");
    if (parts.length !== 5) {
      return undefined;
    }
    try {
      const header = JSON.parse(Buffer.from(parts[0] as string, "base64url").toString("utf8")) as { typ?: unknown };
      return (Object.keys(TYP) as SealPurpose[]).find((p) => TYP[p] === header.typ);
    } catch {
      return undefined;
    }
  }
}

/** 推測できない識別子(jti・sid・tx)。 */
export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

/** PKCE S256(RFC 7636)。 */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** RFC 7636 §4.1 の code_verifier の形(43〜128 文字の unreserved)。 */
export function isValidCodeVerifier(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

/** 長さに依存しない比較。 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}
