/**
 * AWS KMS の KeyProvider(ADR-022 決定 3)。SDK に依存せず、KMS の JSON API
 * (TrentService.Encrypt / Decrypt)を SigV4 で署名して直接呼ぶ。
 *
 * - DEK を KMS の Encrypt で包む。context は EncryptionContext(`leisen` キー)に入れ、
 *   Decrypt で同じ値を要求させる(行の差し替えでは解けない)。CloudTrail に平文で残るため、
 *   context そのものではなく SHA-256 を入れる(userId を残さない)
 * - 基盤の資格情報(KMS を呼ぶための IAM)は環境変数 AWS_ACCESS_KEY_ID /
 *   AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN、またはコンテナの資格情報
 *   (AWS_CONTAINER_CREDENTIALS_RELATIVE_URI / _FULL_URI。ECS・EKS Pod Identity)から得る。
 *   ソースへのアクセスには使わない(不変条件1の対象外)
 * - 資格情報・署名・平文の DEK をログ・エラーに出さない(不変条件6)
 */
import { createHash, createHmac } from "node:crypto";

/** EncryptionContext は CloudTrail に平文で残るため、context(userId を含む)のハッシュを入れる。 */
function contextDigest(context: string): string {
  return createHash("sha256").update(context, "utf8").digest("base64url");
}
import {
  HttpCallError,
  HttpClient,
  isRecord,
  readJson,
  type HttpClientOptions,
} from "./http.js";
import { KeyProviderError, type KeyProvider, type WrappedKey } from "./keys.js";

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  /** epoch ms。不明なら undefined(期限なしとして扱う) */
  readonly expiresAt?: number;
}

export type AwsCredentialSource = () => Promise<AwsCredentials>;

export interface AwsKmsKeyProviderOptions extends HttpClientOptions {
  /** 鍵 ID・ARN・エイリアス(alias/...) */
  readonly keyId: string;
  readonly region: string;
  /** エンドポイントの上書き(VPC エンドポイント・テスト用)。既定 https://kms.<region>.amazonaws.com */
  readonly endpoint?: string;
  readonly credentials?: AwsCredentialSource;
  readonly now?: () => number;
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function amzDate(epochMs: number): { amzDate: string; dateStamp: string } {
  const iso = new Date(epochMs).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/**
 * SigV4 の Authorization ヘッダを作る(POST /、署名対象ヘッダは content-type・host・
 * x-amz-date・x-amz-target・(あれば)x-amz-security-token)。テストのために公開する。
 */
export function signAwsRequest(input: {
  readonly host: string;
  readonly region: string;
  readonly service: string;
  readonly target: string;
  readonly body: string;
  readonly credentials: AwsCredentials;
  readonly epochMs: number;
}): Record<string, string> {
  const { amzDate: date, dateStamp } = amzDate(input.epochMs);
  const headers: Record<string, string> = {
    "content-type": "application/x-amz-json-1.1",
    host: input.host,
    "x-amz-date": date,
    "x-amz-target": input.target,
  };
  if (input.credentials.sessionToken !== undefined) {
    headers["x-amz-security-token"] = input.credentials.sessionToken;
  }
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    sha256Hex(input.body),
  ].join("\n");
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** 環境変数・コンテナの資格情報から AWS の資格情報を得る(期限付きはキャッシュする)。 */
export function defaultAwsCredentialSource(
  env: Readonly<Record<string, string | undefined>>,
  http: HttpClient,
  now: () => number = Date.now,
): AwsCredentialSource {
  let cached: AwsCredentials | undefined;
  return async () => {
    const accessKeyId = env["AWS_ACCESS_KEY_ID"];
    const secretAccessKey = env["AWS_SECRET_ACCESS_KEY"];
    if (accessKeyId && secretAccessKey) {
      const sessionToken = env["AWS_SESSION_TOKEN"];
      return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
    }
    if (cached !== undefined && (cached.expiresAt ?? Infinity) - 60_000 > now()) {
      return cached;
    }
    const relative = env["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"];
    const full = env["AWS_CONTAINER_CREDENTIALS_FULL_URI"];
    const url = relative ? `http://169.254.170.2${relative}` : full;
    if (!url) {
      throw new KeyProviderError(
        "unavailable",
        "aws_kms: no AWS credentials (set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY or run with container credentials)",
      );
    }
    const token = env["AWS_CONTAINER_AUTHORIZATION_TOKEN"];
    let response: Response;
    try {
      response = await http.request(url, token ? { headers: { authorization: token } } : {});
    } catch {
      throw new KeyProviderError("unavailable", "aws_kms: container credentials endpoint is unreachable");
    }
    const body = await readJson(response);
    if (
      !response.ok ||
      !isRecord(body) ||
      typeof body["AccessKeyId"] !== "string" ||
      typeof body["SecretAccessKey"] !== "string"
    ) {
      throw new KeyProviderError("unavailable", "aws_kms: container credentials endpoint returned no credentials");
    }
    const expiration = typeof body["Expiration"] === "string" ? Date.parse(body["Expiration"]) : NaN;
    cached = {
      accessKeyId: body["AccessKeyId"],
      secretAccessKey: body["SecretAccessKey"],
      ...(typeof body["Token"] === "string" ? { sessionToken: body["Token"] } : {}),
      ...(Number.isFinite(expiration) ? { expiresAt: expiration } : {}),
    };
    return cached;
  };
}

export class AwsKmsKeyProvider implements KeyProvider {
  readonly #http: HttpClient;
  readonly #keyId: string;
  readonly #region: string;
  readonly #endpoint: string;
  readonly #credentials: AwsCredentialSource;
  readonly #now: () => number;

  constructor(options: AwsKmsKeyProviderOptions, env: Readonly<Record<string, string | undefined>> = {}) {
    this.#http = new HttpClient(options);
    this.#keyId = options.keyId;
    this.#region = options.region;
    this.#endpoint = (options.endpoint ?? `https://kms.${options.region}.amazonaws.com`).replace(/\/+$/, "");
    this.#now = options.now ?? Date.now;
    this.#credentials = options.credentials ?? defaultAwsCredentialSource(env, this.#http, this.#now);
  }

  get description(): string {
    return `aws_kms (key ${this.#keyId}, region ${this.#region})`;
  }

  async #call(target: "Encrypt" | "Decrypt", payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body = JSON.stringify(payload);
    const credentials = await this.#credentials();
    const headers = signAwsRequest({
      host: new URL(this.#endpoint).host,
      region: this.#region,
      service: "kms",
      target: `TrentService.${target}`,
      body,
      credentials,
      epochMs: this.#now(),
    });
    let response: Response;
    try {
      response = await this.#http.request(`${this.#endpoint}/`, { method: "POST", headers, body });
    } catch (error) {
      throw new KeyProviderError(
        "unavailable",
        error instanceof HttpCallError ? `aws_kms: ${error.message}` : "aws_kms: request failed",
      );
    }
    const json = await readJson(response);
    if (!response.ok || !isRecord(json)) {
      // 応答の __type だけを理由として残す(メッセージ本文は返さない)
      const type = isRecord(json) && typeof json["__type"] === "string" ? json["__type"].replace(/[^A-Za-z0-9#.:_-]/g, "") : "unknown";
      throw new KeyProviderError(
        response.status >= 500 ? "unavailable" : "invalid",
        `aws_kms: ${target} failed (HTTP ${response.status}, ${type})`,
      );
    }
    return json;
  }

  async wrapKey(dek: Uint8Array, context: string): Promise<WrappedKey> {
    const json = await this.#call("Encrypt", {
      KeyId: this.#keyId,
      Plaintext: Buffer.from(dek).toString("base64"),
      EncryptionContext: { leisen: contextDigest(context) },
    });
    if (typeof json["CiphertextBlob"] !== "string") {
      throw new KeyProviderError("invalid", "aws_kms: Encrypt returned no ciphertext");
    }
    return {
      kekId: `aws_kms:${this.#keyId}`,
      wrapped: Buffer.from(json["CiphertextBlob"], "base64").toString("base64url"),
    };
  }

  async unwrapKey(wrapped: WrappedKey, context: string): Promise<Buffer> {
    if (!wrapped.kekId.startsWith("aws_kms:")) {
      throw new KeyProviderError("unknown_key", `unknown key encryption key: ${wrapped.kekId}`);
    }
    const json = await this.#call("Decrypt", {
      // KMS は暗号文から鍵を特定する。KeyId を添えて別鍵での復号を拒ませる
      KeyId: wrapped.kekId.slice("aws_kms:".length),
      CiphertextBlob: Buffer.from(wrapped.wrapped, "base64url").toString("base64"),
      EncryptionContext: { leisen: contextDigest(context) },
    });
    if (typeof json["Plaintext"] !== "string") {
      throw new KeyProviderError("invalid", "aws_kms: Decrypt returned no plaintext");
    }
    return Buffer.from(json["Plaintext"], "base64");
  }
}
