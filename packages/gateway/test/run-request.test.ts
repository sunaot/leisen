/**
 * run API の本文の検証(ADR-019 決定3、T-023)。上限と未知キーの拒否、申告値をエコーしないこと。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_REQUEST_LIMITS,
  feedbackRunRequestSchema,
  finishRunRequestSchema,
  parseRunRequest,
  startRunRequestSchema,
} from "../src/run/index.js";

describe("POST /runs の本文", () => {
  it("question は必須で、上限の文字数を超えると拒否する(申告値をエコーしない)", () => {
    const schema = startRunRequestSchema({ ...DEFAULT_RUN_REQUEST_LIMITS, maxQuestionChars: 10 });
    expect(parseRunRequest(schema, { question: "短い質問" })).toEqual({ ok: true, value: { question: "短い質問" } });
    const long = parseRunRequest(schema, { question: "x".repeat(11) });
    expect(long).toMatchObject({ ok: false });
    expect(!long.ok && long.message).toMatch(/question/);
    expect(!long.ok && long.message).not.toContain("xxxxx");
    expect(parseRunRequest(schema, {})).toMatchObject({ ok: false });
    expect(parseRunRequest(schema, { question: "" })).toMatchObject({ ok: false });
    expect(parseRunRequest(schema, undefined)).toMatchObject({ ok: false });
  });

  it("executionClass・actor の申告は形だけ通し(意味の検証は呼び出し側)、未知キーは拒否する", () => {
    const schema = startRunRequestSchema();
    expect(
      parseRunRequest(schema, { question: "q", executionClass: "scheduled", actor: { kind: "human" } }),
    ).toMatchObject({ ok: true });
    expect(parseRunRequest(schema, { question: "q", userId: "bob" })).toMatchObject({ ok: false });
    expect(parseRunRequest(schema, { question: "q", runId: "r1.k1.x.y" })).toMatchObject({ ok: false });
  });
});

describe("POST /runs/{runId}/finish の本文", () => {
  it("outcome は resolved / unresolved / error(pending は不可)、省略値を補う", () => {
    const schema = finishRunRequestSchema();
    expect(parseRunRequest(schema, { outcome: "resolved" })).toEqual({
      ok: true,
      value: { outcome: "resolved", confidence: null, searchedSources: [], citations: [], failureReason: null },
    });
    expect(parseRunRequest(schema, { outcome: "pending" })).toMatchObject({ ok: false });
    expect(parseRunRequest(schema, {})).toMatchObject({ ok: false });
  });

  it("引用・ソースの件数、識別子の長さ、confidence の範囲、failureReason の形に上限がある", () => {
    const schema = finishRunRequestSchema({ ...DEFAULT_RUN_REQUEST_LIMITS, maxCitations: 2, maxSearchedSources: 2, maxIdChars: 8 });
    const cite = (n: number) => Array.from({ length: n }, (_, i) => ({ sourceId: "s", documentId: `d${i}` }));
    expect(parseRunRequest(schema, { outcome: "resolved", citations: cite(2) })).toMatchObject({ ok: true });
    expect(parseRunRequest(schema, { outcome: "resolved", citations: cite(3) })).toMatchObject({ ok: false });
    expect(parseRunRequest(schema, { outcome: "resolved", searchedSources: ["a", "b", "c"] })).toMatchObject({ ok: false });
    expect(parseRunRequest(schema, { outcome: "resolved", citations: [{ sourceId: "s", documentId: "123456789" }] })).toMatchObject({ ok: false });
    expect(parseRunRequest(schema, { outcome: "resolved", confidence: 1.5 })).toMatchObject({ ok: false });
    expect(parseRunRequest(schema, { outcome: "error", failureReason: "Timeout: upstream said no" })).toMatchObject({ ok: false });
    expect(parseRunRequest(schema, { outcome: "error", failureReason: "llm_timeout" })).toMatchObject({ ok: true });
    // 引用に本文・スニペット等の余計な欄を持ち込めない
    expect(
      parseRunRequest(schema, { outcome: "resolved", citations: [{ sourceId: "s", documentId: "d", snippet: "x" }] }),
    ).toMatchObject({ ok: false });
    expect(parseRunRequest(schema, { outcome: "resolved", userId: "bob" })).toMatchObject({ ok: false });
  });
});

describe("POST /runs/{runId}/feedback の本文", () => {
  it("outcome は resolved / unresolved だけ", () => {
    const schema = feedbackRunRequestSchema();
    expect(parseRunRequest(schema, { outcome: "resolved" })).toEqual({ ok: true, value: { outcome: "resolved" } });
    expect(parseRunRequest(schema, { outcome: "error" })).toMatchObject({ ok: false });
    expect(parseRunRequest(schema, { outcome: "resolved", comment: "..." })).toMatchObject({ ok: false });
  });
});
