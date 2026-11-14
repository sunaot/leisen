import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalKeyProvider, KeyProviderError } from "../src/credentials/keys.js";
import { SqliteCredentialStore } from "../src/credentials/store.js";
import { TokenVault, VaultError } from "../src/credentials/vault.js";
import type { SourceTokenSet } from "../src/credentials/types.js";

const tokens = (access: string, extra: Partial<SourceTokenSet> = {}): SourceTokenSet => ({
  accessToken: access,
  refreshToken: `${access}-refresh`,
  obtainedAt: 1000,
  ...extra,
});

function setup() {
  const store = new SqliteCredentialStore(":memory:");
  const keys = new LocalKeyProvider(randomBytes(32));
  return { store, keys, vault: new TokenVault(store, keys, () => 5000) };
}

describe("LocalKeyProvider", () => {
  it("32 バイト以外の鍵を拒否する", () => {
    expect(() => new LocalKeyProvider(randomBytes(16))).toThrow(KeyProviderError);
  });

  it("付加データ(userId・sourceId)が違えば解けない", async () => {
    const keys = new LocalKeyProvider(randomBytes(32));
    const wrapped = await keys.wrapKey(randomBytes(32), "alice|github");
    await expect(keys.unwrapKey(wrapped, "bob|github")).rejects.toThrow(KeyProviderError);
  });

  it("旧鍵で包んだものは previous に置けば解け、なければ unknown_key", async () => {
    const oldKey = randomBytes(32);
    const dek = randomBytes(32);
    const wrapped = await new LocalKeyProvider(oldKey).wrapKey(dek, "ctx");
    const rotated = new LocalKeyProvider(randomBytes(32), [oldKey]);
    expect((await rotated.unwrapKey(wrapped, "ctx")).equals(dek)).toBe(true);
    await expect(new LocalKeyProvider(randomBytes(32)).unwrapKey(wrapped, "ctx")).rejects.toMatchObject({
      kind: "unknown_key",
    });
  });

  it("説明に鍵の値を含めない", () => {
    const key = randomBytes(32);
    const provider = new LocalKeyProvider(key);
    expect(provider.description).not.toContain(key.toString("base64"));
    expect(provider.description).not.toContain(key.toString("hex"));
  });
});

describe("TokenVault", () => {
  it("保管したトークンを取り出せ、保管層には平文が残らない", async () => {
    const { vault, store } = setup();
    await vault.put("alice", "github", tokens("ghu_secret_value"));
    const entry = await vault.get("alice", "github");
    expect(entry?.tokens.accessToken).toBe("ghu_secret_value");
    const sealed = await store.get("alice", "github");
    expect(JSON.stringify(sealed)).not.toContain("ghu_secret_value");
    expect(JSON.stringify(sealed)).not.toContain("refresh");
  });

  it("未接続は null(呼び出し側が source_not_connected にする)", async () => {
    const { vault } = setup();
    expect(await vault.get("alice", "github")).toBeNull();
  });

  it("ユーザー間で取り違えない: 行を別ユーザーへ差し替えても開けない(不変条件4)", async () => {
    const { vault, store } = setup();
    await vault.put("alice", "github", tokens("alice-token"));
    const sealed = await store.get("alice", "github");
    if (sealed === undefined) throw new Error("missing");
    await store.put({ ...sealed, userId: "mallory" }, null);
    await expect(vault.get("mallory", "github")).rejects.toBeInstanceOf(VaultError);
  });

  it("改竄した暗号文は corrupt", async () => {
    const { vault, store } = setup();
    await vault.put("alice", "github", tokens("t"));
    const sealed = await store.get("alice", "github");
    if (sealed === undefined) throw new Error("missing");
    const flipped = Buffer.from(sealed.ciphertext, "base64url");
    flipped[flipped.length - 1] ^= 1;
    await store.put({ ...sealed, ciphertext: flipped.toString("base64url"), version: sealed.version + 1 }, sealed.version);
    await expect(vault.get("alice", "github")).rejects.toMatchObject({ kind: "corrupt" });
  });

  it("並行の update は直列化され、どの更新も失われない", async () => {
    const { vault } = setup();
    await vault.put("alice", "github", tokens("v0"));
    let running = 0;
    let maxRunning = 0;
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        vault.update("alice", "github", async (current) => {
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          await new Promise((r) => setTimeout(r, 5));
          running -= 1;
          return tokens(`${current?.accessToken}+${i}`);
        }),
      ),
    );
    expect(maxRunning).toBe(1);
    const entry = await vault.get("alice", "github");
    expect(entry?.tokens.accessToken.split("+")).toHaveLength(6);
  });

  it("他プロセスの書き込み(版の不一致)を検出して読み直す", async () => {
    const { vault, store, keys } = setup();
    await vault.put("alice", "github", tokens("v1"));
    const other = new TokenVault(store, keys);
    let first = true;
    const result = await vault.update("alice", "github", async (current) => {
      if (first) {
        first = false;
        await other.put("alice", "github", tokens("written-by-other"));
      }
      return tokens(`${current?.accessToken}-next`);
    });
    expect(result?.accessToken).toBe("written-by-other-next");
  });

  it("mutate が null を返すと行を消す", async () => {
    const { vault } = setup();
    await vault.put("alice", "github", tokens("t"));
    await vault.update("alice", "github", async () => null);
    expect(await vault.get("alice", "github")).toBeNull();
    expect(await vault.sourcesForUser("alice")).toEqual([]);
  });

  it("rewrapAll は現行の KEK で包み直す(旧鍵を外しても開ける)", async () => {
    const store = new SqliteCredentialStore(":memory:");
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    await new TokenVault(store, new LocalKeyProvider(oldKey)).put("alice", "github", tokens("t"));
    const rotating = new TokenVault(store, new LocalKeyProvider(newKey, [oldKey]));
    expect(await rotating.rewrapAll()).toBe(1);
    const fresh = new TokenVault(store, new LocalKeyProvider(newKey));
    expect((await fresh.get("alice", "github"))?.tokens.accessToken).toBe("t");
  });
});

describe("SqliteCredentialStore", () => {
  it("ファイルを 0600 で作る", () => {
    const dir = mkdtempSync(join(tmpdir(), "leisen-store-"));
    const path = join(dir, "state", "credentials.db");
    const store = new SqliteCredentialStore(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    store.close();
  });

  it("拒否リストは新しい revokedBefore を残し、期限で消える", async () => {
    const store = new SqliteCredentialStore(":memory:");
    await store.addDenial("sub", "alice", 100, 1000);
    await store.addDenial("sub", "alice", 50, 1000);
    expect(await store.denial("sub", "alice")).toBe(100);
    expect(await store.denial("sid", "alice")).toBeUndefined();
    expect(await store.purgeExpired(2000)).toBe(1);
    expect(await store.denial("sub", "alice")).toBeUndefined();
  });

  it("markUsed は 2 回目に false(使い捨て)", async () => {
    const store = new SqliteCredentialStore(":memory:");
    expect(await store.markUsed("code-1", 1000)).toBe(true);
    expect(await store.markUsed("code-1", 1000)).toBe(false);
  });
});
