/**
 * 検索語の取り出しが入力長に対して線形に近い時間で終わること(セキュリティレビュー M1、
 * 2026-11-25)。旧実装は引用符の中の長い空白の連続(`/^"\p{Zs}*|\p{Zs}*"$/gu`)で入力長の
 * 二乗の時間がかかった(20 万文字で約 54 秒)。
 *
 * 絶対時間の上限は、並列実行の負荷でぶれても通るよう十分に余裕のある値にする(修正後は
 * 数ミリ秒、修正前は数秒〜数十秒)。
 */
import { describe, expect, it } from "vitest";
import {
  MAX_SNIPPET_TERM_CHARS,
  REDMINE_MAX_TOKENS,
  searchNoticesFor,
  searchTokens,
  snippetTerms,
} from "../src/query.js";
import { matchWindowStart } from "../src/snippet.js";

const LIMIT_MS = 2_000;

function elapsedMs(run: () => unknown): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

/** 修正前の実装(短い入力で結果が同じことを確かめる比較用) */
function legacySearchTokens(query: string): string[] {
  const tokens = [...query.matchAll(/"[^"]+"|[^\p{Zs}]+/gu)].map((match) =>
    match[0].replace(/^"\p{Zs}*|\p{Zs}*"$/gu, ""),
  );
  return [...new Set(tokens)].filter(
    (token) => [...token].length > 1 || /\p{Script=Han}/u.test(token),
  );
}

describe("検索語の取り出しの計算量(M1)", () => {
  it("20 万文字の引用符内の空白", () => {
    const query = `"a${" ".repeat(200_000)}b"`;
    expect(elapsedMs(() => snippetTerms(query))).toBeLessThan(LIMIT_MS);
    expect(elapsedMs(() => searchNoticesFor(query))).toBeLessThan(LIMIT_MS);
    expect(searchTokens(query)).toEqual([`a${" ".repeat(200_000)}b`]);
  });

  it("20 万文字の全角空白(\\p{Zs})の引用符内の連続", () => {
    const query = `"障${"　".repeat(200_000)}害"`;
    expect(elapsedMs(() => snippetTerms(query))).toBeLessThan(LIMIT_MS);
  });

  it("20 万文字の ) の連続", () => {
    const query = `${")".repeat(200_000)}x`;
    expect(elapsedMs(() => snippetTerms(query))).toBeLessThan(LIMIT_MS);
  });

  it("数万個の異なる語", () => {
    const words = Array.from({ length: 50_000 }, (_, i) => `w${i.toString(36)}x`);
    const query = words.join(" ");
    let terms: string[] = [];
    expect(elapsedMs(() => (terms = snippetTerms(query)))).toBeLessThan(LIMIT_MS);
    expect(terms).toEqual(words.slice(0, REDMINE_MAX_TOKENS));
    expect(elapsedMs(() => searchNoticesFor(query))).toBeLessThan(LIMIT_MS);
    expect(searchNoticesFor(query)).toEqual([{ kind: "terms_dropped", keptTerms: REDMINE_MAX_TOKENS }]);
  });

  it("多数の語をスニペットの位置の計算に渡しても短い時間で終わる", () => {
    const words = Array.from({ length: 5_000 }, (_, i) => `w${i.toString(36)}x`);
    const text = words.join(" ").repeat(4);
    expect(elapsedMs(() => matchWindowStart(text, words, 200))).toBeLessThan(LIMIT_MS);
  });
});

describe("取り出しの結果は修正前と同じ(M1)", () => {
  it.each([
    "障害 対応",
    '"障害 対応" 手順',
    '"  障害 対応  " 手順',
    '"　障害　" a"',
    '"" " x "',
    '"',
    'abc" "def',
    '"未閉じ の 引用',
    "a b c d e f g a b",
    "字 漢 x y",
  ])("%j", (query) => {
    expect(searchTokens(query)).toEqual(legacySearchTokens(query));
  });

  it("Redmine が使う先頭 5 語のうち、1 語の長さの上限を超える語は一致箇所の検索に使わない", () => {
    const over = "あ".repeat(MAX_SNIPPET_TERM_CHARS + 1);
    const exact = "い".repeat(MAX_SNIPPET_TERM_CHARS);
    expect(snippetTerms(`${over} ${exact} 障害 対応 手順 六番目`)).toEqual([exact, "障害", "対応", "手順"]);
  });
});
