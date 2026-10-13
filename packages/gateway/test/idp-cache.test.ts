import { describe, expect, it } from "vitest";
import type { Credential } from "@leisen/connector-sdk";
import { CredentialCache } from "../src/idp/index.js";

function bearer(token: string, expiresAt: number): Credential {
  return { kind: "oauth_bearer", accessToken: token, expiresAt };
}

/** 手動で進められるクロック。 */
function fakeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("CredentialCache", () => {
  it("TTL内は同じ資格情報を返し、loaderを再実行しない", async () => {
    const clock = fakeClock();
    const cache = new CredentialCache({ ttlMs: 1000, now: clock.now });
    let calls = 0;
    const loader = async () => {
      calls++;
      return bearer(`token-${calls}`, clock.now() + 60_000);
    };

    const first = await cache.getOrLoad("alice", "gdrive", loader);
    clock.advance(999);
    const second = await cache.getOrLoad("alice", "gdrive", loader);
    expect(calls).toBe(1);
    expect(second).toBe(first);
  });

  it("TTL経過後はloaderを再実行する", async () => {
    const clock = fakeClock();
    const cache = new CredentialCache({ ttlMs: 1000, now: clock.now });
    let calls = 0;
    const loader = async () => {
      calls++;
      return bearer(`token-${calls}`, clock.now() + 60_000);
    };

    await cache.getOrLoad("alice", "gdrive", loader);
    clock.advance(1001);
    const reloaded = await cache.getOrLoad("alice", "gdrive", loader);
    expect(calls).toBe(2);
    expect(reloaded).toEqual(bearer("token-2", 1001 + 60_000));
  });

  it("トークン自体の失効(expiresAt-マージン)がTTLより早ければそちらで失効する", async () => {
    const clock = fakeClock();
    const cache = new CredentialCache({
      ttlMs: 60_000,
      expirySafetyMarginMs: 100,
      now: clock.now,
    });
    let calls = 0;
    const loader = async () => {
      calls++;
      // 1秒で失効するトークン
      return bearer(`token-${calls}`, clock.now() + 1000);
    };

    await cache.getOrLoad("alice", "gdrive", loader);
    clock.advance(901); // expiresAt(1000) - margin(100) を経過
    await cache.getOrLoad("alice", "gdrive", loader);
    expect(calls).toBe(2);
  });

  it("並行呼び出しはsingle-flightで1回のloaderに合流する", async () => {
    const cache = new CredentialCache({ ttlMs: 1000 });
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loader = async () => {
      calls++;
      await gate;
      return bearer("token", Date.now() + 60_000);
    };

    const inflight = [
      cache.getOrLoad("alice", "gdrive", loader),
      cache.getOrLoad("alice", "gdrive", loader),
      cache.getOrLoad("alice", "gdrive", loader),
    ];
    release();
    const results = await Promise.all(inflight);
    expect(calls).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it("ユーザーが異なれば資格情報を共有しない(不変条件4)", async () => {
    const cache = new CredentialCache({ ttlMs: 60_000 });
    const forUser = (userId: string) => async () =>
      bearer(`token-for-${userId}`, Date.now() + 60_000);

    const alice = await cache.getOrLoad("alice", "gdrive", forUser("alice"));
    const bob = await cache.getOrLoad("bob", "gdrive", forUser("bob"));
    expect(alice).not.toEqual(bob);
    expect(bob).toEqual(
      expect.objectContaining({ accessToken: "token-for-bob" }),
    );
  });

  it("userId/sourceIdの連結が別ユーザーのキーと衝突しない", async () => {
    const cache = new CredentialCache({ ttlMs: 60_000 });
    let calls = 0;
    const loader = async () => {
      calls++;
      return bearer(`token-${calls}`, Date.now() + 60_000);
    };
    // 素朴な文字列連結だと "a" + "bc" === "ab" + "c" で衝突する
    await cache.getOrLoad("a", "bc", loader);
    await cache.getOrLoad("ab", "c", loader);
    expect(calls).toBe(2);
  });

  it("空のuserIdを拒否する(全ユーザー共有キーへの縮退防止)", async () => {
    const cache = new CredentialCache();
    await expect(
      cache.getOrLoad("", "gdrive", async () =>
        bearer("t", Date.now() + 60_000),
      ),
    ).rejects.toThrow(/userId/);
  });

  it("loaderの失敗はキャッシュせず、次回は再試行する", async () => {
    const cache = new CredentialCache({ ttlMs: 60_000 });
    let calls = 0;
    const loader = async () => {
      calls++;
      if (calls === 1) {
        throw new Error("idp down");
      }
      return bearer("token", Date.now() + 60_000);
    };

    await expect(cache.getOrLoad("alice", "gdrive", loader)).rejects.toThrow(
      "idp down",
    );
    const recovered = await cache.getOrLoad("alice", "gdrive", loader);
    expect(calls).toBe(2);
    expect(recovered).toEqual(
      expect.objectContaining({ accessToken: "token" }),
    );
  });

  it("invalidateUserは該当ユーザーの全ソースのみ破棄する", async () => {
    const cache = new CredentialCache({ ttlMs: 60_000 });
    let calls = 0;
    const loader = async () => {
      calls++;
      return bearer(`token-${calls}`, Date.now() + 60_000);
    };
    await cache.getOrLoad("alice", "gdrive", loader);
    await cache.getOrLoad("alice", "slack", loader);
    await cache.getOrLoad("bob", "gdrive", loader);
    expect(cache.size()).toBe(3);

    cache.invalidateUser("alice");
    expect(cache.size()).toBe(1);
    // aliceは再ロード、bobはキャッシュのまま
    await cache.getOrLoad("alice", "gdrive", loader);
    expect(calls).toBe(4);
    await cache.getOrLoad("bob", "gdrive", loader);
    expect(calls).toBe(4);
  });

  it("invalidateUserがprefix一致で他ユーザーを巻き込まない", async () => {
    const cache = new CredentialCache({ ttlMs: 60_000 });
    let calls = 0;
    const loader = async () => {
      calls++;
      return bearer(`token-${calls}`, Date.now() + 60_000);
    };
    await cache.getOrLoad("ali", "gdrive", loader);
    await cache.getOrLoad("alice", "gdrive", loader);

    cache.invalidateUser("ali");
    // "alice" のエントリは残る
    await cache.getOrLoad("alice", "gdrive", loader);
    expect(calls).toBe(2);
  });
});
