/**
 * runId の発行・検証(ADR-019 決定4、T-023)。認可分岐を先に固定する:
 * 他人の runId・actor の違う runId・改竄した署名・正規でない符号化(payload と sig の
 * 両方の base64url の未使用ビット)・未知の kid・期限切れが拒否され、鍵の入れ替えでは
 * 現行と 1 つ前の kid を受けてそれより古い kid は拒否する。拒否の理由に申告値を含めない。
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Actor } from "@leisen/audit";
import {
  MIN_RUN_ID_KEY_BYTES,
  SIGNED_RUN_ID_MAX_CHARS,
  canonicalActor,
  createRunIdKeyRing,
  decodeRunIdPayload,
  isSignedRunIdFormat,
  isValidRunId,
  issueRunId,
  verifyRunId,
  type RunIdKeyRing,
  type RunSubject,
} from "../src/run/index.js";

const KEY_A = Buffer.alloc(32, 1);
const KEY_B = Buffer.alloc(32, 2);
const KEY_C = Buffer.alloc(32, 3);
const HUMAN: Actor = { kind: "human" };
const alice: RunSubject = { userId: "alice", actor: HUMAN };
const bob: RunSubject = { userId: "bob", actor: HUMAN };
const NOW_MS = Date.UTC(2026, 9, 11, 12, 0, 0);
const TTL = 600;

function ring(): RunIdKeyRing {
  return createRunIdKeyRing({ current: { kid: "k2", key: KEY_B }, previous: { kid: "k1", key: KEY_A } });
}

function issue(keys: RunIdKeyRing, subject: RunSubject = alice, nowMs = NOW_MS) {
  return issueRunId(keys, { subject, ttlSeconds: TTL, nowMs });
}

function verifyCall(keys: RunIdKeyRing, runId: unknown, subject: RunSubject = alice, nowMs = NOW_MS) {
  return verifyRunId(keys, { runId, subject, purpose: "call", nowMs });
}

/** base64url の最後の文字の未使用ビットを立てた別表記(復号結果は同じバイト列)。 */
function nonCanonicalLastChar(encoded: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = encoded[encoded.length - 1] as string;
  const index = alphabet.indexOf(last);
  // 38 文字(28 バイト)・43 文字(32 バイト)の末尾の文字は上位 2〜4 ビットだけが使われる。
  // 最下位ビットを反転すると未使用ビットを使った別表記になる
  const altered = alphabet[index ^ 1] as string;
  return encoded.slice(0, -1) + altered;
}

describe("runId の形と発行", () => {
  it("r1.<kid>.<payload 38>.<sig 43> の形で、94 文字以内・既存の文字種に収まる", () => {
    const { runId, kid, issuedAt, expiresAt } = issue(ring());
    expect(runId).toMatch(/^r1\.k2\.[A-Za-z0-9_-]{38}\.[A-Za-z0-9_-]{43}$/);
    expect(runId.length).toBeLessThanOrEqual(SIGNED_RUN_ID_MAX_CHARS);
    expect(isValidRunId(runId)).toBe(true);
    expect(isSignedRunIdFormat(runId)).toBe(true);
    expect(kid).toBe("k2");
    expect(issuedAt).toBe(Math.floor(NOW_MS / 1000));
    expect(expiresAt).toBe(issuedAt + TTL);
    expect(runId).not.toContain("alice");
  });

  it("payload は署名なしで復号でき、発行時刻と有効期間を持つ(別表記は復号しない)", () => {
    const { runId, issuedAt } = issue(ring());
    expect(decodeRunIdPayload(runId)).toEqual({ issuedAt, ttlSeconds: TTL });
    const [v, kid, payload, sig] = runId.split(".") as [string, string, string, string];
    expect(decodeRunIdPayload(`${v}.${kid}.${nonCanonicalLastChar(payload)}.${sig}`)).toBeUndefined();
    expect(decodeRunIdPayload("8b3c7c1e-7e0d-4a4f-9d4e-0d7b3f1f3a2a")).toBeUndefined();
    expect(decodeRunIdPayload(42)).toBeUndefined();
  });

  it("同じ主体・同じ時刻でも乱数で毎回違う runId になる", () => {
    const keys = ring();
    expect(issue(keys).runId).not.toBe(issue(keys).runId);
  });

  it("有効期間は 1 以上 2^32-1 以下の整数", () => {
    const keys = ring();
    for (const ttlSeconds of [0, -1, 1.5, 2 ** 32, Number.NaN]) {
      expect(() => issueRunId(keys, { subject: alice, ttlSeconds, nowMs: NOW_MS })).toThrow(/ttlSeconds/);
    }
  });

  it("旧キー向けの isValidRunId は UUID・run-42 を通し、長大・不正な文字種を拒否する", () => {
    expect(isValidRunId("8b3c7c1e-7e0d-4a4f-9d4e-0d7b3f1f3a2a")).toBe(true);
    expect(isValidRunId("run-42")).toBe(true);
    expect(isValidRunId("a".repeat(129))).toBe(false);
    expect(isValidRunId("run 42")).toBe(false);
    expect(isValidRunId("")).toBe(false);
    expect(isValidRunId(undefined)).toBe(false);
  });
});

describe("runId の検証(認可分岐)", () => {
  it("発行した本人・同じ actor・期限内なら受ける", () => {
    const keys = ring();
    const { runId, issuedAt } = issue(keys);
    expect(verifyCall(keys, runId)).toEqual({ ok: true, kid: "k2", issuedAt, ttlSeconds: TTL });
    expect(verifyRunId(keys, { runId, subject: alice, purpose: "finish", nowMs: NOW_MS + (TTL - 1) * 1000 })).toMatchObject({ ok: true });
  });

  it("他人の runId は署名の不一致として拒否する(本人の違いと署名の改竄を区別しない)", () => {
    const keys = ring();
    const { runId } = issue(keys, alice);
    expect(verifyCall(keys, runId, bob)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("actor の違う runId は拒否する(委任エージェントの呼び出しを人間の run に混ぜない)", () => {
    const keys = ring();
    const agent: Actor = { kind: "agent", agentId: "bot-1", onBehalfOfChain: ["alice"] };
    const { runId } = issue(keys, { userId: "alice", actor: agent });
    expect(verifyCall(keys, runId, alice)).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(verifyCall(keys, runId, { userId: "alice", actor: agent })).toMatchObject({ ok: true });
    // 連鎖の順が違えば別の actor
    const reordered: Actor = { kind: "agent", agentId: "bot-1", onBehalfOfChain: ["alice", "carol"] };
    const chained = issue(keys, { userId: "alice", actor: reordered });
    expect(
      verifyCall(keys, chained.runId, {
        userId: "alice",
        actor: { kind: "agent", agentId: "bot-1", onBehalfOfChain: ["carol", "alice"] },
      }),
    ).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("actor の正規化表現はキーの順に依らず、空白を含まない", () => {
    const a = canonicalActor({ kind: "agent", agentId: "bot-1", onBehalfOfChain: ["alice"] });
    const b = canonicalActor(
      JSON.parse('{"onBehalfOfChain":["alice"],"kind":"agent","agentId":"bot-1"}') as Actor,
    );
    expect(a).toBe(b);
    expect(a).toBe('{"agentId":"bot-1","kind":"agent","onBehalfOfChain":["alice"]}');
    expect(canonicalActor(HUMAN)).toBe('{"kind":"human"}');
  });

  it("署名を改竄した runId を拒否する", () => {
    const keys = ring();
    const { runId } = issue(keys);
    const [v, kid, payload, sig] = runId.split(".") as [string, string, string, string];
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(verifyCall(keys, `${v}.${kid}.${payload}.${flipped}`)).toEqual({ ok: false, reason: "signature_mismatch" });
    // 他の鍵で署名した値も拒否
    const forged = issueRunId(createRunIdKeyRing({ current: { kid: "k2", key: KEY_C } }), { subject: alice, ttlSeconds: TTL, nowMs: NOW_MS });
    expect(verifyCall(keys, forged.runId)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("payload を改竄した runId(期限の延長)を拒否する", () => {
    const keys = ring();
    const { runId } = issue(keys);
    const [v, kid, payload, sig] = runId.split(".") as [string, string, string, string];
    const bytes = Buffer.from(payload, "base64url");
    bytes.writeUInt32BE(0xffff_ffff, 24);
    const extended = `${v}.${kid}.${bytes.toString("base64url")}.${sig}`;
    expect(decodeRunIdPayload(extended)?.ttlSeconds).toBe(0xffff_ffff);
    expect(verifyCall(keys, extended)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("正規でない符号化を拒否する(payload の別表記は malformed、sig の別表記は不一致)", () => {
    const keys = ring();
    const { runId } = issue(keys);
    const [v, kid, payload, sig] = runId.split(".") as [string, string, string, string];
    const alteredPayload = nonCanonicalLastChar(payload);
    expect(Buffer.from(alteredPayload, "base64url").equals(Buffer.from(payload, "base64url"))).toBe(true);
    expect(verifyCall(keys, `${v}.${kid}.${alteredPayload}.${sig}`)).toEqual({ ok: false, reason: "malformed" });
    const alteredSig = nonCanonicalLastChar(sig);
    expect(Buffer.from(alteredSig, "base64url").equals(Buffer.from(sig, "base64url"))).toBe(true);
    expect(verifyCall(keys, `${v}.${kid}.${payload}.${alteredSig}`)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("形が違う値は malformed(旧形式の UUID、版違い、長さ違い、文字列以外)", () => {
    const keys = ring();
    const { runId } = issue(keys);
    for (const value of [
      "8b3c7c1e-7e0d-4a4f-9d4e-0d7b3f1f3a2a",
      "run-42",
      runId.replace(/^r1\./, "r2."),
      runId.slice(0, -1),
      `${runId}A`,
      runId.replace(/\.k2\./, ".K2."),
      runId.replace(/\.k2\./, ".toolongkid."),
      "",
      undefined,
      null,
      42,
      { runId },
    ]) {
      expect(verifyCall(keys, value)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("鍵の入れ替え: 現行と 1 つ前の kid を受け、それより古い kid は拒否する", () => {
    const gen1 = createRunIdKeyRing({ current: { kid: "k1", key: KEY_A } });
    const gen2 = createRunIdKeyRing({ current: { kid: "k2", key: KEY_B }, previous: { kid: "k1", key: KEY_A } });
    const gen3 = createRunIdKeyRing({ current: { kid: "k3", key: KEY_C }, previous: { kid: "k2", key: KEY_B } });
    const fromGen1 = issue(gen1).runId;
    const fromGen2 = issue(gen2).runId;
    expect(verifyCall(gen2, fromGen1)).toMatchObject({ ok: true, kid: "k1" });
    expect(verifyCall(gen2, fromGen2)).toMatchObject({ ok: true, kid: "k2" });
    expect(verifyCall(gen3, fromGen2)).toMatchObject({ ok: true, kid: "k2" });
    expect(verifyCall(gen3, fromGen1)).toEqual({ ok: false, reason: "unknown_kid" });
    // kid が同じでも鍵が違えば署名の不一致
    const replaced = createRunIdKeyRing({ current: { kid: "k1", key: KEY_C } });
    expect(verifyCall(replaced, fromGen1)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("期限: tools/call・finish は有効期間内、feedback は発行時刻からフィードバックの期間内", () => {
    const keys = ring();
    const { runId } = issue(keys);
    const expiry = NOW_MS + TTL * 1000;
    expect(verifyCall(keys, runId, alice, expiry - 1000)).toMatchObject({ ok: true });
    expect(verifyCall(keys, runId, alice, expiry)).toEqual({ ok: false, reason: "expired" });
    expect(verifyRunId(keys, { runId, subject: alice, purpose: "finish", nowMs: expiry })).toEqual({ ok: false, reason: "expired" });
    const feedbackWindowSeconds = 7 * 24 * 3600;
    const feedbackExpiry = NOW_MS + feedbackWindowSeconds * 1000;
    expect(
      verifyRunId(keys, { runId, subject: alice, purpose: "feedback", nowMs: expiry + 3600_000, feedbackWindowSeconds }),
    ).toMatchObject({ ok: true });
    expect(
      verifyRunId(keys, { runId, subject: alice, purpose: "feedback", nowMs: feedbackExpiry, feedbackWindowSeconds }),
    ).toEqual({ ok: false, reason: "expired" });
    // feedback の期間なしでは検証できない(既定で受けない)
    expect(() => verifyRunId(keys, { runId, subject: alice, purpose: "feedback", nowMs: NOW_MS })).toThrow(/feedbackWindowSeconds/);
    // 期限切れでも他人なら署名の不一致が先(存在の推定を許さない)
    expect(verifyCall(keys, runId, bob, expiry)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("拒否の分類は固定で、申告値・鍵の値を含まない", () => {
    const keys = ring();
    const [v, kid, payload] = issue(keys).runId.split(".") as [string, string, string];
    const result = verifyCall(keys, `${v}.${kid}.${payload}.${"A".repeat(43)}`);
    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(JSON.stringify(result)).not.toContain("AAAA");
    // 有効期間 0 の payload は形として受けない(発行時に拒否される値)
    expect(verifyCall(keys, `${v}.${kid}.${"A".repeat(38)}.${"A".repeat(43)}`)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("鍵束", () => {
  it("32 バイト未満の鍵・不正な kid・重複する kid を拒否し、鍵の値をメッセージに出さない", () => {
    const short = randomBytes(MIN_RUN_ID_KEY_BYTES - 1);
    expect(() => createRunIdKeyRing({ current: { kid: "k1", key: short } })).toThrow(/at least 32/);
    expect(() => createRunIdKeyRing({ current: { kid: "K1", key: KEY_A } })).toThrow(/kid/);
    expect(() => createRunIdKeyRing({ current: { kid: "", key: KEY_A } })).toThrow(/kid/);
    expect(() => createRunIdKeyRing({ current: { kid: "k1", key: KEY_A }, previous: { kid: "k1", key: KEY_B } })).toThrow(/distinct/);
    try {
      createRunIdKeyRing({ current: { kid: "k1", key: short } });
    } catch (error) {
      expect(String(error)).not.toContain(short.toString("hex"));
      expect(String(error)).not.toContain(short.toString("base64"));
    }
  });

  it("previous を省いた鍵束は現行だけを受ける", () => {
    const keys = createRunIdKeyRing({ current: { kid: "k1", key: KEY_A }, previous: undefined });
    expect(keys.previous).toBeUndefined();
    expect(verifyCall(keys, issue(keys).runId)).toMatchObject({ ok: true });
  });
});
