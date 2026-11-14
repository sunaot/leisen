/**
 * Token Vault(ADR-010 決定 2、ADR-022 決定 1・2)。コアの 1 実装で、差し替えない。
 *
 * - 封筒暗号化: 1 件ごとに DEK を生成し、トークン一式を AES-256-GCM で暗号化する。DEK は
 *   KeyProvider で包む。暗号化・包みの付加データに userId・sourceId を結び付ける(別の行への
 *   差し替えでは開けない。不変条件4)
 * - 更新の直列化: 同じ (userId, sourceId) への update はプロセス内で順に実行し、保管層の
 *   比較交換で他プロセスとの競合も検出して読み直す(更新トークンのローテーションで新しい
 *   トークンを失わない)
 * - 平文のトークンを返すのはプロセス内の呼び出し元(CredentialProvider)だけ。クライアントへ
 *   返す API は作らない(ADR-022 決定 7)
 */
import { randomBytes } from "node:crypto";
import { aesGcmOpen, aesGcmSeal, KeyProviderError, type KeyProvider } from "./keys.js";
import type { CredentialStore, SealedCredential, SourceTokenSet } from "./types.js";

export class VaultError extends Error {
  constructor(
    public readonly kind: "unavailable" | "corrupt" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

/** 付加データ(JSON 配列で区切りの曖昧さをなくす)。 */
function bindingContext(userId: string, sourceId: string): string {
  return JSON.stringify(["leisen-vault-v1", userId, sourceId]);
}

function parseTokenSet(json: string): SourceTokenSet {
  const value = JSON.parse(json) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { accessToken?: unknown }).accessToken !== "string" ||
    typeof (value as { obtainedAt?: unknown }).obtainedAt !== "number"
  ) {
    throw new Error("malformed token set");
  }
  return value as SourceTokenSet;
}

export interface VaultEntry {
  readonly tokens: SourceTokenSet;
  readonly connectedAt: number;
}

const MAX_CAS_RETRIES = 5;

export class TokenVault {
  readonly #store: CredentialStore;
  readonly #keys: KeyProvider;
  readonly #now: () => number;
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(store: CredentialStore, keys: KeyProvider, now: () => number = Date.now) {
    this.#store = store;
    this.#keys = keys;
    this.#now = now;
  }

  get description(): string {
    return `token vault: store ${this.#store.description}, keys ${this.#keys.description}`;
  }

  async #seal(
    userId: string,
    sourceId: string,
    tokens: SourceTokenSet,
    version: number,
    connectedAt: number,
  ): Promise<SealedCredential> {
    const context = bindingContext(userId, sourceId);
    const dek = randomBytes(32);
    try {
      const wrapped = await this.#keys.wrapKey(dek, context);
      const ciphertext = aesGcmSeal(dek, Buffer.from(JSON.stringify(tokens), "utf8"), context);
      return {
        userId,
        sourceId,
        kekId: wrapped.kekId,
        wrappedKey: wrapped.wrapped,
        ciphertext: ciphertext.toString("base64url"),
        version,
        connectedAt,
        updatedAt: this.#now(),
      };
    } catch (error) {
      throw new VaultError(
        "unavailable",
        error instanceof KeyProviderError ? error.message : "could not seal credential",
      );
    } finally {
      dek.fill(0);
    }
  }

  async #open(record: SealedCredential): Promise<SourceTokenSet> {
    const context = bindingContext(record.userId, record.sourceId);
    let dek: Buffer;
    try {
      dek = await this.#keys.unwrapKey({ kekId: record.kekId, wrapped: record.wrappedKey }, context);
    } catch (error) {
      if (error instanceof KeyProviderError && error.kind === "unavailable") {
        throw new VaultError("unavailable", error.message);
      }
      throw new VaultError("corrupt", "stored credential could not be unwrapped");
    }
    try {
      return parseTokenSet(aesGcmOpen(dek, Buffer.from(record.ciphertext, "base64url"), context).toString("utf8"));
    } catch {
      throw new VaultError("corrupt", "stored credential could not be decrypted");
    } finally {
      dek.fill(0);
    }
  }

  /** 同じキーの処理を順に実行する(プロセス内)。 */
  async #serialized<T>(userId: string, sourceId: string, task: () => Promise<T>): Promise<T> {
    const key = bindingContext(userId, sourceId);
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => undefined);
    this.#locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.#locks.get(key) === tail) {
        this.#locks.delete(key);
      }
    }
  }

  async get(userId: string, sourceId: string): Promise<VaultEntry | null> {
    const record = await this.#store.get(userId, sourceId);
    if (record === undefined) {
      return null;
    }
    return { tokens: await this.#open(record), connectedAt: record.connectedAt };
  }

  /** 接続(置き換え)。既存があれば新しい版で上書きする(接続時刻は保つ)。 */
  async put(userId: string, sourceId: string, tokens: SourceTokenSet): Promise<void> {
    await this.update(userId, sourceId, async () => tokens);
  }

  /**
   * 読んで書く(直列化)。mutate は現在値(なければ null)を受け、新しい値か、削除なら null、
   * 変更なしなら undefined を返す。mutate の中でソースの更新(リフレッシュ)を行う
   */
  async update(
    userId: string,
    sourceId: string,
    mutate: (current: SourceTokenSet | null) => Promise<SourceTokenSet | null | undefined>,
  ): Promise<SourceTokenSet | null> {
    return this.#serialized(userId, sourceId, async () => {
      for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
        const record = await this.#store.get(userId, sourceId);
        const current = record === undefined ? null : await this.#open(record);
        const next = await mutate(current);
        if (next === undefined) {
          return current;
        }
        if (next === null) {
          if (record !== undefined) {
            await this.#store.delete(userId, sourceId);
          }
          return null;
        }
        const sealed = await this.#seal(
          userId,
          sourceId,
          next,
          (record?.version ?? 0) + 1,
          record?.connectedAt ?? this.#now(),
        );
        if (await this.#store.put(sealed, record?.version ?? null)) {
          return next;
        }
        // 他プロセスが先に書いた。読み直して mutate をやり直す
      }
      throw new VaultError("conflict", "credential was updated concurrently; retry later");
    });
  }

  async delete(userId: string, sourceId: string): Promise<boolean> {
    return this.#serialized(userId, sourceId, () => this.#store.delete(userId, sourceId));
  }

  sourcesForUser(userId: string): Promise<string[]> {
    return this.#store.sourcesForUser(userId);
  }

  /**
   * 全件を現行の KEK で包み直す(鍵の入れ替え。leisen-gateway vault rewrap)。
   * 包み直した件数を返す
   */
  async rewrapAll(): Promise<number> {
    let count = 0;
    for (const { userId, sourceId } of await this.#store.allKeys()) {
      const result = await this.update(userId, sourceId, async (current) =>
        current === null ? undefined : current,
      );
      // update は値が同じでも新しい DEK・現行 KEK で書き直す(undefined 以外を返したとき)
      if (result !== null) {
        count += 1;
      }
    }
    return count;
  }
}
