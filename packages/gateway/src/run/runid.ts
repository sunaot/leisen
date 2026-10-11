/**
 * runId の発行と検証(ADR-019 決定4、T-023 段階 1)。
 *
 * runId は Gateway が発行する HMAC 署名付きの不透明な値で、形式は
 * `r1.<kid>.<payload>.<sig>`。
 * - kid: 署名鍵の識別子 `[a-z0-9]{1,8}`。現行と 1 つ前の鍵を同時に受ける(鍵の入れ替え)
 * - payload: 固定長 28 バイト(乱数 16・発行時刻 uint64 秒・有効期間 uint32 秒)の
 *   パディングなし base64url(38 文字)
 * - sig: HMAC-SHA256(32 バイト、43 文字)。入力は `leisen-runid-v1`・`r1.<kid>.<payload>`
 *   (ASCII)・userId(UTF-8)・actor の正規化表現(キーを辞書順に並べ空白を含まない JSON)
 *   の 4 つを、それぞれ 4 バイト big-endian の長さを前に付けて連結したもの。版・鍵・用途を
 *   入力に含め、値の境界は長さで分ける(区切り文字に頼らない)
 * - **userId は runId に平文で入れない**(runId は UI の structuredContent・ログにも出る)。
 *   署名の入力として束縛するだけにし、検証時は Gateway が認証した userId で再計算する。
 *   actor も束縛するので、委任エージェント(ADR-015)の呼び出しは人間の run に混ざらない
 *
 * 検証は署名だけで完結し、索引を持たない(Gateway はステートレスのまま):
 * 1. 形式(正規表現)
 * 2. payload を復号して再符号化した文字列が元と一致すること(base64url の未使用ビットを
 *    使った別表記を拒否する。TM-I5 (h))
 * 3. kid が鍵束にあること
 * 4. 計算した sig(base64url 文字列)と runId の sig 部分を文字列どうしで定数時間比較する
 *    (sig 側の別表記も一致しないので拒否される)
 * 5. 期限(tools/call・finish は有効期間内、feedback は発行時刻からフィードバックの期間内)
 *
 * 拒否の理由は固定の分類だけを返し、申告値はどこにも含めない(呼び出し側も固定文言で
 * 拒否し、`invalid_run_id` として記録する)。鍵の値をメッセージ・例外に出さない(不変条件6)。
 *
 * このモジュールは MCP・コネクタ IF・認証・設定に依存しない(ADR-019 決定10。
 * scripts/lint-imports.mjs が検査する)。認証済みの主体(userId・actor)と値だけを受け取る。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Actor } from "@kp/audit";

/** runId の版(符号化の規則を変えるときに上げる)。 */
export const RUN_ID_VERSION = "r1";

/** 署名の入力に含める用途の識別子(版を含む)。 */
const SIGNATURE_DOMAIN = "leisen-runid-v1";

/** 鍵の識別子の形。 */
const KID_PATTERN = /^[a-z0-9]{1,8}$/;

/** payload: 乱数 16 + 発行時刻 8 + 有効期間 4 バイト。 */
const RANDOM_BYTES = 16;
const PAYLOAD_BYTES = 28;
/** 28 バイトの base64url(パディングなし)は 38 文字、32 バイト(HMAC-SHA256)は 43 文字。 */
const PAYLOAD_CHARS = 38;
const SIGNATURE_CHARS = 43;

/** 署名鍵の最小長(バイト)。短い鍵は構成の段階で拒否する(ADR-019 決定4)。 */
export const MIN_RUN_ID_KEY_BYTES = 32;

/** 署名付き runId の全体の最大長(`r1.` + kid 8 + `.` + 38 + `.` + 43)。 */
export const SIGNED_RUN_ID_MAX_CHARS = 3 + 8 + 1 + PAYLOAD_CHARS + 1 + SIGNATURE_CHARS;

const SIGNED_RUN_ID_PATTERN = new RegExp(
  `^${RUN_ID_VERSION}\\.([a-z0-9]{1,8})\\.([A-Za-z0-9_-]{${PAYLOAD_CHARS}})\\.([A-Za-z0-9_-]{${SIGNATURE_CHARS}})$`,
);

/**
 * 申告された runId として受け付ける形(文字種と長さの上限)。署名付き runId
 * (94 文字以内、`[A-Za-z0-9._-]`)も、移行期間の旧キーで申告される UUID や "run-42" も
 * 通る。監査レコードの runId の欄はこの形を前提にしている(スキーマは変えない)。
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** 申告 runId の形の検証(文字種 [A-Za-z0-9._:-]、1〜128文字)。 */
export function isValidRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID_PATTERN.test(value);
}

/** 署名付き runId の形か(署名・期限は見ない。verifyRunId が検証する)。 */
export function isSignedRunIdFormat(value: unknown): value is string {
  return typeof value === "string" && SIGNED_RUN_ID_PATTERN.test(value);
}

export interface RunIdSigningKey {
  /** 鍵の識別子 `[a-z0-9]{1,8}` */
  readonly kid: string;
  /** 32 バイト以上のデプロイ固有の秘密。ログ・監査・エラー・設定の出力に出さない */
  readonly key: Uint8Array;
}

/** 現行と 1 つ前の鍵(鍵の入れ替え)。それより古い鍵は受けない。 */
export interface RunIdKeyRing {
  readonly current: RunIdSigningKey;
  readonly previous?: RunIdSigningKey;
}

function assertSigningKey(key: RunIdSigningKey, what: string): void {
  if (!KID_PATTERN.test(key.kid)) {
    throw new Error(`${what} kid must match [a-z0-9]{1,8}`);
  }
  if (!(key.key instanceof Uint8Array) || key.key.byteLength < MIN_RUN_ID_KEY_BYTES) {
    // 鍵の値・長さの具体値は出さない
    throw new Error(`${what} key must be at least ${MIN_RUN_ID_KEY_BYTES} random bytes`);
  }
}

/**
 * 鍵束を検証して作る。kid の形、鍵の長さ(32 バイト以上)、kid の重複を拒否する。
 * 鍵の値は例外メッセージに含めない。
 */
export function createRunIdKeyRing(input: {
  readonly current: RunIdSigningKey;
  readonly previous?: RunIdSigningKey | undefined;
}): RunIdKeyRing {
  assertSigningKey(input.current, "current runId signing");
  if (input.previous !== undefined) {
    assertSigningKey(input.previous, "previous runId signing");
    if (input.previous.kid === input.current.kid) {
      throw new Error("current and previous runId signing keys must have distinct kids");
    }
    return { current: input.current, previous: input.previous };
  }
  return { current: input.current };
}

/** 署名で束縛する主体(Gateway が認証した userId と、検証済みの actor)。 */
export interface RunSubject {
  readonly userId: string;
  readonly actor: Actor;
}

/**
 * actor の正規化表現: キーを辞書順に並べ、空白を含まない JSON。配列(on-behalf-of の
 * 連鎖)は申告の順のまま。同じ actor なら同じ文字列になる。
 */
export function canonicalActor(actor: Actor): string {
  return canonicalJson(actor);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 4 バイト big-endian の長さを前に付ける。 */
function lengthPrefixed(bytes: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.byteLength, 0);
  return Buffer.concat([length, bytes]);
}

function signatureOf(key: Uint8Array, head: string, subject: RunSubject): string {
  const input = Buffer.concat([
    lengthPrefixed(Buffer.from(SIGNATURE_DOMAIN, "ascii")),
    lengthPrefixed(Buffer.from(head, "ascii")),
    lengthPrefixed(Buffer.from(subject.userId, "utf8")),
    lengthPrefixed(Buffer.from(canonicalActor(subject.actor), "utf8")),
  ]);
  return createHmac("sha256", key).update(input).digest("base64url");
}

export interface RunIdPayload {
  /** 発行時刻(UNIX 秒) */
  readonly issuedAt: number;
  /** 有効期間(秒)。tools/call・finish はこの間だけ受ける */
  readonly ttlSeconds: number;
}

function encodePayload(random: Uint8Array, payload: RunIdPayload): string {
  const bytes = Buffer.alloc(PAYLOAD_BYTES);
  Buffer.from(random).copy(bytes, 0, 0, RANDOM_BYTES);
  bytes.writeBigUInt64BE(BigInt(payload.issuedAt), RANDOM_BYTES);
  bytes.writeUInt32BE(payload.ttlSeconds, RANDOM_BYTES + 8);
  return bytes.toString("base64url");
}

/**
 * payload を復号する。再符号化が元と一致しない(別表記)・長さが違うものは undefined。
 * 署名は見ないので、この結果だけで runId を信用してはならない(昇格判定レポートが
 * 期限を読む用途と、verifyRunId の内部用)。
 */
export function decodeRunIdPayload(runId: unknown): RunIdPayload | undefined {
  const match = typeof runId === "string" ? SIGNED_RUN_ID_PATTERN.exec(runId) : null;
  if (!match) {
    return undefined;
  }
  const encoded = match[2] as string;
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.byteLength !== PAYLOAD_BYTES || bytes.toString("base64url") !== encoded) {
    return undefined;
  }
  const issuedAt = bytes.readBigUInt64BE(RANDOM_BYTES);
  const ttlSeconds = bytes.readUInt32BE(RANDOM_BYTES + 8);
  if (issuedAt > BigInt(Number.MAX_SAFE_INTEGER) || ttlSeconds === 0) {
    return undefined;
  }
  return { issuedAt: Number(issuedAt), ttlSeconds };
}

export interface IssueRunIdInput {
  readonly subject: RunSubject;
  /** 有効期間(秒、1 以上の整数。uint32) */
  readonly ttlSeconds: number;
  /** 発行時刻(ms)。既定 Date.now() */
  readonly nowMs?: number;
  /** 乱数(テスト注入用)。既定 crypto.randomBytes */
  readonly random?: (bytes: number) => Uint8Array;
}

export interface IssuedRunId {
  readonly runId: string;
  readonly kid: string;
  /** 発行時刻(UNIX 秒) */
  readonly issuedAt: number;
  /** tools/call・finish を受ける期限(UNIX 秒、この時刻以降は拒否) */
  readonly expiresAt: number;
}

/** 現行の鍵で runId を発行する。 */
export function issueRunId(keys: RunIdKeyRing, input: IssueRunIdInput): IssuedRunId {
  if (
    !Number.isSafeInteger(input.ttlSeconds) ||
    input.ttlSeconds < 1 ||
    input.ttlSeconds > 0xffff_ffff
  ) {
    throw new Error("runId ttlSeconds must be an integer between 1 and 2^32-1");
  }
  const issuedAt = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const random = (input.random ?? randomBytes)(RANDOM_BYTES);
  if (random.byteLength !== RANDOM_BYTES) {
    throw new Error("runId random source must return exactly 16 bytes");
  }
  const { kid, key } = keys.current;
  const head = `${RUN_ID_VERSION}.${kid}.${encodePayload(random, { issuedAt, ttlSeconds: input.ttlSeconds })}`;
  return {
    runId: `${head}.${signatureOf(key, head, input.subject)}`,
    kid,
    issuedAt,
    expiresAt: issuedAt + input.ttlSeconds,
  };
}

/** 検証の用途。期限の規則が違う。 */
export type RunIdPurpose = "call" | "finish" | "feedback";

/** 拒否の分類(固定。申告値を含めない)。 */
export type RunIdRejection =
  | "malformed"
  | "unknown_kid"
  | "signature_mismatch"
  | "expired";

export type RunIdVerification =
  | {
      readonly ok: true;
      readonly kid: string;
      readonly issuedAt: number;
      readonly ttlSeconds: number;
    }
  | { readonly ok: false; readonly reason: RunIdRejection };

export interface VerifyRunIdInput {
  readonly runId: unknown;
  /** Gateway が認証した利用者と、このリクエストで検証した actor */
  readonly subject: RunSubject;
  readonly purpose: RunIdPurpose;
  /** 現在時刻(ms)。既定 Date.now() */
  readonly nowMs?: number;
  /** purpose: feedback のとき必須。発行時刻からフィードバックを受ける期間(秒) */
  readonly feedbackWindowSeconds?: number;
}

function keyFor(keys: RunIdKeyRing, kid: string): RunIdSigningKey | undefined {
  if (keys.current.kid === kid) {
    return keys.current;
  }
  if (keys.previous !== undefined && keys.previous.kid === kid) {
    return keys.previous;
  }
  return undefined;
}

/**
 * runId を検証する(冒頭の 1〜5)。本人・actor の違いは署名の不一致として現れ、
 * 区別しない(区別して返すと他人の runId の存在が確定する)。
 */
export function verifyRunId(keys: RunIdKeyRing, input: VerifyRunIdInput): RunIdVerification {
  const match = typeof input.runId === "string" ? SIGNED_RUN_ID_PATTERN.exec(input.runId) : null;
  if (!match) {
    return { ok: false, reason: "malformed" };
  }
  const kid = match[1] as string;
  const encodedPayload = match[2] as string;
  const givenSignature = match[3] as string;
  const payload = decodeRunIdPayload(input.runId);
  if (payload === undefined) {
    return { ok: false, reason: "malformed" };
  }
  const key = keyFor(keys, kid);
  if (key === undefined) {
    return { ok: false, reason: "unknown_kid" };
  }
  const expected = signatureOf(key.key, `${RUN_ID_VERSION}.${kid}.${encodedPayload}`, input.subject);
  // 両方とも base64url の 43 文字(正規表現で保証)なので長さは常に一致する
  const expectedBytes = Buffer.from(expected, "ascii");
  const givenBytes = Buffer.from(givenSignature, "ascii");
  if (
    expectedBytes.byteLength !== givenBytes.byteLength ||
    !timingSafeEqual(expectedBytes, givenBytes)
  ) {
    return { ok: false, reason: "signature_mismatch" };
  }
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const windowSeconds =
    input.purpose === "feedback" ? input.feedbackWindowSeconds : payload.ttlSeconds;
  if (
    windowSeconds === undefined ||
    !Number.isSafeInteger(windowSeconds) ||
    windowSeconds < 1
  ) {
    throw new Error("feedbackWindowSeconds (a positive integer) is required to verify a runId for feedback");
  }
  if (nowSeconds >= payload.issuedAt + windowSeconds) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, kid, issuedAt: payload.issuedAt, ttlSeconds: payload.ttlSeconds };
}
