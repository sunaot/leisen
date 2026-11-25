/**
 * 検索語の取り出しが入力長に対して線形に近い時間で終わること(セキュリティレビュー M1、
 * 2026-11-25)。旧実装は `)))…)x`(`/\)+$/`)と多数の異なる語(`terms.includes`)で入力長の
 * 二乗の時間がかかった(20 万文字の `)` の連続で約 30 秒)。esa も同じ実装だった。
 *
 * 絶対時間の上限は、並列実行の負荷でぶれても通るよう十分に余裕のある値にする(修正後は
 * 数十ミリ秒、修正前は数秒〜数十秒)。
 */
import { describe, expect, it } from "vitest";
import { MAX_SNIPPET_TERMS, MAX_SNIPPET_TERM_CHARS, snippetTerms } from "../src/query.js";
import { matchWindowStart } from "../src/snippet.js";

const LIMIT_MS = 2_000;

function elapsedMs(run: () => unknown): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

describe("検索語の取り出しの計算量(M1)", () => {
  it("20 万文字の ) の連続のあとに語がある query", () => {
    const query = `${")".repeat(200_000)}x`;
    let terms: string[] = [];
    expect(elapsedMs(() => (terms = snippetTerms(query)))).toBeLessThan(LIMIT_MS);
    // 末尾の ) を除いた語は 20 万文字で、1 語の長さの上限を超えるため使わない
    expect(terms).toEqual([]);
  });

  it("20 万文字の ( の連続と ) の連続に挟まれた語", () => {
    const query = `${"(".repeat(100_000)}障害${")".repeat(100_000)}`;
    let terms: string[] = [];
    expect(elapsedMs(() => (terms = snippetTerms(query)))).toBeLessThan(LIMIT_MS);
    expect(terms).toEqual(["障害"]);
  });

  it("20 万文字の引用符内の空白", () => {
    const query = `"a${" ".repeat(200_000)}b"`;
    expect(elapsedMs(() => snippetTerms(query))).toBeLessThan(LIMIT_MS);
  });

  it("数万個の異なる語でも、語数の上限で切って短い時間で終わる", () => {
    const words = Array.from({ length: 50_000 }, (_, i) => `w${i.toString(36)}x`);
    let terms: string[] = [];
    expect(elapsedMs(() => (terms = snippetTerms(words.join(" "))))).toBeLessThan(LIMIT_MS);
    expect(terms).toEqual(words.slice(0, MAX_SNIPPET_TERMS));
  });

  it("多数の語をスニペットの位置の計算に渡しても短い時間で終わる", () => {
    const words = Array.from({ length: 5_000 }, (_, i) => `w${i.toString(36)}x`);
    const text = words.join(" ").repeat(4);
    expect(elapsedMs(() => matchWindowStart(text, words, 200))).toBeLessThan(LIMIT_MS);
  });
});

describe("語数・1 語の長さの上限と重複の除去(M1)", () => {
  it("重複を除き、先頭から上限の語数まで", () => {
    const words = Array.from({ length: MAX_SNIPPET_TERMS + 10 }, (_, i) => `語${i}`);
    expect(snippetTerms(["語0", "語0", ...words].join(" "))).toEqual(words.slice(0, MAX_SNIPPET_TERMS));
  });

  it("1 語の長さの上限を超える語は使わず、上限ちょうどの語は使う", () => {
    const exact = "あ".repeat(MAX_SNIPPET_TERM_CHARS);
    const over = "い".repeat(MAX_SNIPPET_TERM_CHARS + 1);
    expect(snippetTerms(`${over} ${exact} 障害`)).toEqual([exact, "障害"]);
  });

  it("通常の query の取り出しは変わらない(括弧・演算子・否定・タグ・人・修飾子)", () => {
    expect(snippetTerms("((認証 OR 認可)) -旧版 #tag @alice category:dev title:\"エラー 500\")")).toEqual([
      "認証",
      "認可",
      "エラー 500",
    ]);
  });
});
