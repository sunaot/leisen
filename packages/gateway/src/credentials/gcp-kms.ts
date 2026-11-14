/**
 * Google Cloud KMS の KeyProvider(ADR-022 決定 3)。SDK に依存せず REST
 * (`{keyName}:encrypt` / `:decrypt`)を直接呼ぶ。
 *
 * - context は additionalAuthenticatedData に入れる(復号に同じ値を要する)
 * - KMS を呼ぶアクセストークンは、サービスアカウント鍵のファイル
 *   (GOOGLE_APPLICATION_CREDENTIALS、JWT bearer)またはメタデータサーバー
 *   (GCE / Cloud Run / GKE Workload Identity)から得る。基盤の資格情報であり、
 *   ソースへのアクセスには使わない(不変条件1の対象外)
 * - 鍵ファイルの内容・アクセストークン・平文の DEK をログ・エラーに出さない(不変条件6)
 */
import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { HttpCallError, HttpClient, isRecord, readJson, type HttpClientOptions } from "./http.js";
import { KeyProviderError, type KeyProvider, type WrappedKey } from "./keys.js";

export const GCP_KMS_SCOPE = "https://www.googleapis.com/auth/cloudkms";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

export interface GcpAccessToken {
  readonly token: string;
  readonly expiresAt: number;
}

export type GcpTokenSource = () => Promise<GcpAccessToken>;

export interface GcpKmsKeyProviderOptions extends HttpClientOptions {
  /** projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k> */
  readonly keyName: string;
  /** エンドポイントの上書き(テスト・Private Service Connect)。既定 https://cloudkms.googleapis.com */
  readonly endpoint?: string;
  readonly tokenSource?: GcpTokenSource;
  readonly now?: () => number;
}

export const GCP_KEY_NAME_PATTERN =
  /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/;

function base64url(data: string | Buffer): string {
  return Buffer.from(data).toString("base64url");
}

/** サービスアカウント鍵(JSON)の JWT bearer でアクセストークンを得る。 */
async function tokenFromServiceAccount(
  file: string,
  http: HttpClient,
  now: () => number,
): Promise<GcpAccessToken> {
  let key: unknown;
  try {
    key = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    throw new KeyProviderError("unavailable", "gcp_kms: service account key file could not be read");
  }
  if (!isRecord(key) || typeof key["client_email"] !== "string" || typeof key["private_key"] !== "string") {
    throw new KeyProviderError("unavailable", "gcp_kms: service account key file is not a service account key");
  }
  const tokenUri = typeof key["token_uri"] === "string" ? key["token_uri"] : "https://oauth2.googleapis.com/token";
  const iat = Math.floor(now() / 1000);
  const unsigned =
    `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.` +
    base64url(
      JSON.stringify({ iss: key["client_email"], scope: GCP_KMS_SCOPE, aud: tokenUri, iat, exp: iat + 3600 }),
    );
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key["private_key"]);
  const response = await http.postForm(tokenUri, {
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: `${unsigned}.${base64url(signature)}`,
  });
  return parseTokenResponse(response, now);
}

async function parseTokenResponse(response: Response, now: () => number): Promise<GcpAccessToken> {
  const body = await readJson(response);
  if (!response.ok || !isRecord(body) || typeof body["access_token"] !== "string") {
    throw new KeyProviderError("unavailable", `gcp_kms: could not obtain an access token (HTTP ${response.status})`);
  }
  const expiresIn = typeof body["expires_in"] === "number" ? body["expires_in"] : 300;
  return { token: body["access_token"], expiresAt: now() + expiresIn * 1000 };
}

/** 鍵ファイル → メタデータサーバーの順でアクセストークンを得る(期限の 1 分前まで再利用)。 */
export function defaultGcpTokenSource(
  env: Readonly<Record<string, string | undefined>>,
  http: HttpClient,
  now: () => number = Date.now,
): GcpTokenSource {
  let cached: GcpAccessToken | undefined;
  return async () => {
    if (cached !== undefined && cached.expiresAt - 60_000 > now()) {
      return cached;
    }
    const file = env["GOOGLE_APPLICATION_CREDENTIALS"];
    try {
      cached = file
        ? await tokenFromServiceAccount(file, http, now)
        : await parseTokenResponse(
            await http.request(`${METADATA_TOKEN_URL}?scopes=${encodeURIComponent(GCP_KMS_SCOPE)}`, {
              headers: { "metadata-flavor": "Google" },
            }),
            now,
          );
    } catch (error) {
      if (error instanceof KeyProviderError) {
        throw error;
      }
      throw new KeyProviderError(
        "unavailable",
        error instanceof HttpCallError ? `gcp_kms: ${error.message}` : "gcp_kms: token request failed",
      );
    }
    return cached;
  };
}

export class GcpKmsKeyProvider implements KeyProvider {
  readonly #http: HttpClient;
  readonly #keyName: string;
  readonly #endpoint: string;
  readonly #tokens: GcpTokenSource;

  constructor(options: GcpKmsKeyProviderOptions, env: Readonly<Record<string, string | undefined>> = {}) {
    if (!GCP_KEY_NAME_PATTERN.test(options.keyName)) {
      throw new KeyProviderError(
        "invalid",
        "gcp_kms: keyName must be projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>",
      );
    }
    this.#http = new HttpClient(options);
    this.#keyName = options.keyName;
    this.#endpoint = (options.endpoint ?? "https://cloudkms.googleapis.com").replace(/\/+$/, "");
    this.#tokens = options.tokenSource ?? defaultGcpTokenSource(env, this.#http, options.now);
  }

  get description(): string {
    return `gcp_kms (key ${this.#keyName})`;
  }

  async #call(keyName: string, op: "encrypt" | "decrypt", payload: Record<string, string>): Promise<Record<string, unknown>> {
    const { token } = await this.#tokens();
    let response: Response;
    try {
      response = await this.#http.request(`${this.#endpoint}/v1/${keyName}:${op}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw new KeyProviderError(
        "unavailable",
        error instanceof HttpCallError ? `gcp_kms: ${error.message}` : "gcp_kms: request failed",
      );
    }
    const json = await readJson(response);
    if (!response.ok || !isRecord(json)) {
      throw new KeyProviderError(
        response.status >= 500 ? "unavailable" : "invalid",
        `gcp_kms: ${op} failed (HTTP ${response.status})`,
      );
    }
    return json;
  }

  async wrapKey(dek: Uint8Array, context: string): Promise<WrappedKey> {
    const json = await this.#call(this.#keyName, "encrypt", {
      plaintext: Buffer.from(dek).toString("base64"),
      additionalAuthenticatedData: Buffer.from(context, "utf8").toString("base64"),
    });
    if (typeof json["ciphertext"] !== "string") {
      throw new KeyProviderError("invalid", "gcp_kms: encrypt returned no ciphertext");
    }
    return {
      kekId: `gcp_kms:${this.#keyName}`,
      wrapped: Buffer.from(json["ciphertext"], "base64").toString("base64url"),
    };
  }

  async unwrapKey(wrapped: WrappedKey, context: string): Promise<Buffer> {
    const keyName = wrapped.kekId.startsWith("gcp_kms:") ? wrapped.kekId.slice("gcp_kms:".length) : "";
    if (!GCP_KEY_NAME_PATTERN.test(keyName)) {
      throw new KeyProviderError("unknown_key", `unknown key encryption key: ${wrapped.kekId}`);
    }
    const json = await this.#call(keyName, "decrypt", {
      ciphertext: Buffer.from(wrapped.wrapped, "base64url").toString("base64"),
      additionalAuthenticatedData: Buffer.from(context, "utf8").toString("base64"),
    });
    if (typeof json["plaintext"] !== "string") {
      throw new KeyProviderError("invalid", "gcp_kms: decrypt returned no plaintext");
    }
    return Buffer.from(json["plaintext"], "base64");
  }
}
