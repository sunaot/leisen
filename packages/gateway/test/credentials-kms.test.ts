import { describe, expect, it } from "vitest";
import { generateKeyPairSync, randomBytes, createVerify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AwsKmsKeyProvider, signAwsRequest } from "../src/credentials/aws-kms.js";
import { GcpKmsKeyProvider } from "../src/credentials/gcp-kms.js";
import { KeyProviderError } from "../src/credentials/keys.js";
import { jsonResponse, mockFetch } from "./helpers/mock-fetch.js";

const CREDS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };

/** 平文と付加データを覚えて返す偽の KMS。 */
function fakeAwsKms() {
  const blobs = new Map<string, { plaintext: string; context: unknown }>();
  return mockFetch({
    "POST https://kms.ap-northeast-1.amazonaws.com/": (req) => {
      const body = req.json() as Record<string, unknown>;
      if (req.headers["x-amz-target"] === "TrentService.Encrypt") {
        const blob = randomBytes(16).toString("base64");
        blobs.set(blob, { plaintext: body["Plaintext"] as string, context: body["EncryptionContext"] });
        return jsonResponse({ CiphertextBlob: blob, KeyId: body["KeyId"] });
      }
      const entry = blobs.get(body["CiphertextBlob"] as string);
      if (entry === undefined || JSON.stringify(entry.context) !== JSON.stringify(body["EncryptionContext"])) {
        return jsonResponse({ __type: "InvalidCiphertextException", message: "secret detail" }, 400);
      }
      return jsonResponse({ Plaintext: entry.plaintext });
    },
  });
}

describe("AwsKmsKeyProvider", () => {
  it("SigV4 で署名し、EncryptionContext に context を入れて往復できる", async () => {
    const kms = fakeAwsKms();
    const provider = new AwsKmsKeyProvider({
      keyId: "alias/leisen",
      region: "ap-northeast-1",
      fetchImpl: kms.impl,
      credentials: async () => CREDS,
    });
    const dek = randomBytes(32);
    const wrapped = await provider.wrapKey(dek, "alice|github");
    expect(wrapped.kekId).toBe("aws_kms:alias/leisen");
    expect((await provider.unwrapKey(wrapped, "alice|github")).equals(dek)).toBe(true);
    const auth = kms.requests[0]?.headers["authorization"] ?? "";
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/ap-northeast-1\/kms\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/);
    expect(auth).not.toContain(CREDS.secretAccessKey);
  });

  it("context が違えば復号を拒み、KMS のメッセージ本文をエラーに含めない", async () => {
    const kms = fakeAwsKms();
    const provider = new AwsKmsKeyProvider({ keyId: "k", region: "ap-northeast-1", fetchImpl: kms.impl, credentials: async () => CREDS });
    const wrapped = await provider.wrapKey(randomBytes(32), "alice|github");
    const error = await provider.unwrapKey(wrapped, "bob|github").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeyProviderError);
    expect(String((error as Error).message)).toContain("InvalidCiphertextException");
    expect(String((error as Error).message)).not.toContain("secret detail");
  });

  it("資格情報がなければ unavailable", async () => {
    const provider = new AwsKmsKeyProvider({ keyId: "k", region: "us-east-1" }, {});
    await expect(provider.wrapKey(randomBytes(32), "c")).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("署名は本文に依存する(同時刻・別本文で別の署名)", () => {
    const base = { host: "kms.us-east-1.amazonaws.com", region: "us-east-1", service: "kms", target: "TrentService.Encrypt", credentials: CREDS, epochMs: 0 };
    const a = signAwsRequest({ ...base, body: "{}" })["authorization"];
    const b = signAwsRequest({ ...base, body: "{\"x\":1}" })["authorization"];
    expect(a).not.toBe(b);
  });
});

describe("GcpKmsKeyProvider", () => {
  const keyName = "projects/p/locations/global/keyRings/r/cryptoKeys/k";

  function fakeGcpKms() {
    const blobs = new Map<string, { plaintext: string; aad: string }>();
    return mockFetch({
      [`POST https://cloudkms.googleapis.com/v1/${keyName}:encrypt`]: (req) => {
        const body = req.json() as Record<string, string>;
        const blob = randomBytes(16).toString("base64");
        blobs.set(blob, { plaintext: body["plaintext"] as string, aad: body["additionalAuthenticatedData"] as string });
        return jsonResponse({ ciphertext: blob });
      },
      [`POST https://cloudkms.googleapis.com/v1/${keyName}:decrypt`]: (req) => {
        const body = req.json() as Record<string, string>;
        const entry = blobs.get(body["ciphertext"] as string);
        if (entry === undefined || entry.aad !== body["additionalAuthenticatedData"]) {
          return jsonResponse({ error: { message: "bad" } }, 400);
        }
        return jsonResponse({ plaintext: entry.plaintext });
      },
      "POST https://oauth2.googleapis.com/token": () => jsonResponse({ access_token: "ya29.test", expires_in: 3600 }),
      "GET http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token": (req) =>
        req.headers["metadata-flavor"] === "Google"
          ? jsonResponse({ access_token: "ya29.metadata", expires_in: 3600 })
          : new Response("", { status: 403 }),
    });
  }

  it("メタデータサーバーのトークンで encrypt / decrypt を往復できる", async () => {
    const kms = fakeGcpKms();
    const provider = new GcpKmsKeyProvider({ keyName, fetchImpl: kms.impl }, {});
    const dek = randomBytes(32);
    const wrapped = await provider.wrapKey(dek, "alice|github");
    expect((await provider.unwrapKey(wrapped, "alice|github")).equals(dek)).toBe(true);
    await expect(provider.unwrapKey(wrapped, "bob|github")).rejects.toBeInstanceOf(KeyProviderError);
    const encrypt = kms.requests.find((r) => r.url.endsWith(":encrypt"));
    expect(encrypt?.headers["authorization"]).toBe("Bearer ya29.metadata");
    // トークンは再利用する(メタデータサーバーへの照会は 1 回)
    expect(kms.requests.filter((r) => r.url.includes("metadata")).length).toBe(1);
  });

  it("サービスアカウント鍵のファイルで JWT bearer を作る", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const dir = mkdtempSync(join(tmpdir(), "leisen-gcp-"));
    const file = join(dir, "sa.json");
    writeFileSync(file, JSON.stringify({
      client_email: "leisen@p.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      token_uri: "https://oauth2.googleapis.com/token",
    }));
    const kms = fakeGcpKms();
    const provider = new GcpKmsKeyProvider({ keyName, fetchImpl: kms.impl }, { GOOGLE_APPLICATION_CREDENTIALS: file });
    await provider.wrapKey(randomBytes(32), "c");
    const tokenRequest = kms.requests.find((r) => r.url === "https://oauth2.googleapis.com/token");
    const assertion = tokenRequest?.form().get("assertion") ?? "";
    const [h, p, s] = assertion.split(".") as [string, string, string];
    const payload = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
    expect(payload["scope"]).toBe("https://www.googleapis.com/auth/cloudkms");
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });

  it("鍵名の形式を検査する", () => {
    expect(() => new GcpKmsKeyProvider({ keyName: "bad" })).toThrow(KeyProviderError);
  });
});
