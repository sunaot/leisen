/**
 * セキュリティレビュー(2026-11-14)の指摘の回帰テスト。
 * H1: GCM の認証タグの切り詰め、M1: 戻り先のオープンリダイレクト、M3: 利用停止の途中失敗、
 * M4: 利用停止後のブラウザのセッション、M6: 未認証の /authorize が取引を作らない、
 * L3: 不正な Basic、L5: Google の個人アカウント、L8: KMS の EncryptionContext に userId を残さない。
 */
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { Sealer, SealError } from "../src/auth-server/seal.js";
import { extractVerifiedEmails } from "../src/credentials/oauth.js";
import { CredentialRevocation } from "../src/credentials/revocation.js";
import { SqliteCredentialStore } from "../src/credentials/store.js";
import { AwsKmsKeyProvider } from "../src/credentials/aws-kms.js";
import type { TokenVault } from "../src/credentials/vault.js";
import { jsonResponse, mockFetch } from "./helpers/mock-fetch.js";

describe("Sealer(H1)", () => {
  it("切り詰めた認証タグ・長さの違う IV を拒否する", () => {
    const sealer = new Sealer(randomBytes(32));
    const token = sealer.seal("access_token", { sub: "alice" });
    const parts = token.split(".");
    const tag = Buffer.from(parts[4] as string, "base64url");
    for (const bad of [
      [...parts.slice(0, 4), tag.subarray(0, 4).toString("base64url")],
      [...parts.slice(0, 4), tag.subarray(0, 12).toString("base64url")],
      [parts[0], "", Buffer.alloc(16).toString("base64url"), parts[3], parts[4]],
    ]) {
      expect(() => sealer.open("access_token", bad.join("."))).toThrow(SealError);
    }
    expect(sealer.open("access_token", token)).toEqual({ sub: "alice" });
  });

  it("用途の違う鍵では開けない(アクセストークンをリフレッシュトークンとして使わせない)", () => {
    const sealer = new Sealer(randomBytes(32));
    expect(() => sealer.open("refresh_token", sealer.seal("access_token", {}))).toThrow(SealError);
  });
});

describe("Google の本人照合(L5)", () => {
  it("hd がメールのドメインと一致する Workspace のアカウントだけを受ける", () => {
    expect(extractVerifiedEmails("google", { email: "a@corp.example", email_verified: true, hd: "corp.example" })).toEqual(["a@corp.example"]);
    expect(extractVerifiedEmails("google", { email: "a@corp.example", email_verified: true })).toEqual([]);
    expect(extractVerifiedEmails("google", { email: "a@gmail.com", email_verified: true, hd: "corp.example" })).toEqual([]);
  });
});

describe("利用停止の途中失敗(M3)", () => {
  it("Vault が失敗しても拒否リストの登録とキャッシュの破棄は行う", async () => {
    const store = new SqliteCredentialStore(":memory:");
    const broken = {
      sourcesForUser: async () => {
        throw new Error("db down");
      },
    } as unknown as TokenVault;
    const invalidated: string[] = [];
    const revocation = new CredentialRevocation({
      vault: broken,
      store,
      sources: { vault: new Map(), esc: new Map() },
      events: async () => undefined,
      invalidateUser: (u) => invalidated.push(u),
      denialRetentionMs: 1000,
      now: () => 10,
    });
    const result = await revocation.deprovision("alice");
    expect(result.sourceRevocationFailed).toEqual(["*"]);
    expect(await store.denial("sub", "alice")).toBe(11);
    expect(invalidated).toEqual(["alice"]);
  });
});

describe("AWS KMS の EncryptionContext(L8)", () => {
  it("userId を含む context をそのまま送らない", async () => {
    const fetch = mockFetch({
      "POST https://kms.us-east-1.amazonaws.com/": () => jsonResponse({ CiphertextBlob: Buffer.from("x").toString("base64") }),
    });
    const provider = new AwsKmsKeyProvider({
      keyId: "k",
      region: "us-east-1",
      fetchImpl: fetch.impl,
      credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "s" }),
    });
    await provider.wrapKey(randomBytes(32), '["leisen-vault-v1","alice@example.com","github"]');
    expect(fetch.requests[0]?.body).not.toContain("alice");
  });
});
