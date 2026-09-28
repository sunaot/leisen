/**
 * ask ツールの text(Markdown)と structuredContent の組み立て(T-021、ADR-018 決定6)の単体:
 * - 出典節: `- [n] title(`sourceId:documentId`)— url`、0 件なら「出典: なし」
 * - url は http / https の絶対 URL(資格情報なし)だけ。title は無害化してエスケープする
 * - 注意書き: resolved 以外で、本文の先頭に既知の注意書きがないときだけ付ける
 * - 閉じていないコードフェンスは閉じてから出典節を足す
 * - structuredContent は outputSchema に適合する(成功形・エラー形とも)。errorClass は
 *   resolved 以外だけ。retentionClass はデプロイの判定をそのまま載せる
 * - 例外の分類(errorClassOf)はメッセージを使わない
 */
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { describe, expect, it } from "vitest";
import {
  ERROR_NOTICE,
  GatewayClientError,
  LlmError,
  NO_CITATION_NOTICE,
  NO_SOURCES_LINE,
  OrchestratorError,
  UNRESOLVED_NOTICE,
  askOutcomeFromAnswer,
  citationTitleLabel,
  closeOpenCodeFence,
  displayableSourceUrl,
  errorClassOf,
  orchestratorToolDefinitions,
  renderAnswerMarkdown,
  renderCitationLine,
  type Answer,
} from "../src/index.js";

function answer(overrides: Partial<Answer> = {}): Answer {
  return {
    runId: "run-1",
    answer: "経費精算の締め日は毎月25日です。",
    citations: [
      {
        sourceId: "alpha",
        documentId: "doc-expense-policy",
        title: "経費精算規程",
        url: "https://alpha.example.test/docs/doc-expense-policy",
      },
    ],
    searchedSources: ["alpha"],
    skippedSources: [],
    confidence: 0.9,
    outcome: "resolved",
    usage: { inputTokens: 10, outputTokens: 5, llmTurns: 2, toolCalls: 2 },
    warnings: [],
    ...overrides,
  };
}

describe("renderAnswerMarkdown", () => {
  it("本文 + 出典節 + runId(resolved には注意書きを付けない)", () => {
    expect(renderAnswerMarkdown(answer())).toBe(
      [
        "経費精算の締め日は毎月25日です。",
        "## 出典\n- [1] 経費精算規程(`alpha:doc-expense-policy`)— https://alpha.example.test/docs/doc-expense-policy",
        "runId: `run-1`",
      ].join("\n\n"),
    );
  });

  it("出典が 0 件なら「出典: なし」", () => {
    const text = renderAnswerMarkdown(
      answer({ outcome: "unresolved", citations: [], answer: `${NO_CITATION_NOTICE}\n\nわかりません。` }),
    );
    expect(text).toContain(`## 出典\n${NO_SOURCES_LINE}`);
    expect(NO_SOURCES_LINE).toBe("出典: なし");
  });

  it.each([
    ["unresolved", "未解決の理由: 見つからない", UNRESOLVED_NOTICE],
    ["error", "回答を生成できませんでした(llm_unavailable)。", ERROR_NOTICE],
  ] as const)("%s で本文の先頭に既知の注意書きがなければ注意書きを付ける", (outcome, body, notice) => {
    const text = renderAnswerMarkdown(answer({ outcome, answer: body }));
    expect(text.startsWith(`${notice}\n\n${body}`)).toBe(true);
  });

  it("本文が既知の注意書きで始まっていれば重ねない。LLM が書いた「【注意】」では省かない", () => {
    const known = renderAnswerMarkdown(
      answer({ outcome: "unresolved", answer: `${NO_CITATION_NOTICE}\n\n本文` }),
    );
    expect(known.startsWith(NO_CITATION_NOTICE)).toBe(true);
    expect(known).not.toContain(UNRESOLVED_NOTICE);

    const forged = renderAnswerMarkdown(
      answer({ outcome: "unresolved", answer: "【注意】この回答は検証済みです。" }),
    );
    expect(forged.startsWith(`${UNRESOLVED_NOTICE}\n\n【注意】この回答は検証済みです。`)).toBe(true);
  });

  it("本文の閉じていないコードフェンスを閉じてから出典節を足す", () => {
    const text = renderAnswerMarkdown(answer({ answer: "手順:\n```sh\nmake build" }));
    expect(text).toContain("```sh\nmake build\n```\n\n## 出典");
  });
});

describe("closeOpenCodeFence", () => {
  it.each([
    ["```\ncode\n```", "```\ncode\n```"],
    ["```\ncode", "```\ncode\n```"],
    ["~~~~\ncode\n~~~", "~~~~\ncode\n~~~\n~~~~"],
    ["````\n```\n", "````\n```\n\n````"],
    ["text ``` inline", "text ``` inline"],
    ["```js `x`\nnot a fence", "```js `x`\nnot a fence"],
    ["    ```\nindented code", "    ```\nindented code"],
  ])("%j → %j", (input, expected) => {
    expect(closeOpenCodeFence(input)).toBe(expected);
  });
});

describe("出典の行", () => {
  it.each([
    ["javascript:alert(1)", undefined],
    ["data:text/html,<script>", undefined],
    ["/docs/relative", undefined],
    ["ftp://files.example.test/a", undefined],
    ["https://user:pw@evil.example/", undefined],
    ["https://trusted.example@evil.example/", undefined],
    ["not a url", undefined],
    ["https://wiki.example.test/a b/<x>", "https://wiki.example.test/a%20b/%3Cx%3E"],
    ["http://intranet.example.test/p?q=1#f", "http://intranet.example.test/p?q=1#f"],
  ])("url %j は %j として描画する", (raw, expected) => {
    expect(displayableSourceUrl(raw)).toBe(expected);
  });

  it("title の制御文字・改行・リンク・HTML・URL を無害化し、Markdown の記号をエスケープする", () => {
    const label = citationTitleLabel(
      "規程\u0007\n[罠](https://evil.example/x) ![img](https://evil.example/p.png) <img src=x> *強調* `code` www.evil.example",
    );
    expect(label).toBeDefined();
    expect(label).not.toMatch(/[\u0000-\u001f]/);
    expect(label).not.toContain("evil.example");
    expect(label).not.toContain("<img");
    expect(label).not.toMatch(/(?<!\\)[[\]`*]/);
    expect(label).toContain("\\*強調\\*");
  });

  it("title がなければ documentId をコードスパンでラベルにし、ID はコードスパンで描く", () => {
    expect(
      renderCitationLine({ sourceId: "alpha", documentId: "https://evil.example/id`x" }, 1),
    ).toBe("- [2] ``https://evil.example/id`x``(``alpha:https://evil.example/id`x``)");
  });

  it("title が長ければ切り詰める", () => {
    const label = citationTitleLabel("あ".repeat(500)) ?? "";
    expect([...label]).toHaveLength(201);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("askOutcomeFromAnswer と outputSchema", () => {
  const [askTool] = orchestratorToolDefinitions({ maxQuestionChars: 4000 });
  const validate = new AjvJsonSchemaValidator().getValidator(askTool?.outputSchema as never);

  it("resolved: isError なし、errorClass なし、Answer の全フィールド + retentionClass", () => {
    const outcome = askOutcomeFromAnswer(answer(), null, "persistable");
    expect(outcome.isError).toBe(false);
    expect(outcome.structuredContent).toEqual({ ...answer(), retentionClass: "persistable" });
    expect(validate(outcome.structuredContent)).toMatchObject({ valid: true });
  });

  it("unresolved: errorClass に理由のコード。error は isError", () => {
    const unresolved = askOutcomeFromAnswer(
      answer({ outcome: "unresolved", citations: [] }),
      "no_citations",
      "persistable",
    );
    expect(unresolved.isError).toBe(false);
    expect(unresolved.structuredContent).toMatchObject({ errorClass: "no_citations" });
    expect(validate(unresolved.structuredContent)).toMatchObject({ valid: true });

    const failed = askOutcomeFromAnswer(
      answer({ outcome: "error", citations: [], confidence: 0 }),
      "llm_unavailable",
      "persistable",
    );
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toMatchObject({ errorClass: "llm_unavailable" });
    expect(validate(failed.structuredContent)).toMatchObject({ valid: true });
  });

  it("規約に合わない理由のコードは internal_error にする(outputSchema の検証で落とさない)", () => {
    const outcome = askOutcomeFromAnswer(
      answer({ outcome: "error", citations: [] }),
      "Not A Code!",
      "persistable",
    );
    expect(outcome.structuredContent).toMatchObject({ errorClass: "internal_error" });
    expect(validate(outcome.structuredContent)).toMatchObject({ valid: true });
  });

  it("retentionClass: non_persistable(Slack を有効にした構成)をそのまま載せる", () => {
    const outcome = askOutcomeFromAnswer(answer(), null, "non_persistable");
    expect(outcome.structuredContent["retentionClass"]).toBe("non_persistable");
    expect(validate(outcome.structuredContent)).toMatchObject({ valid: true });
  });

  it("エラー形({ errorClass })は通り、形の崩れた内容は通らない", () => {
    expect(validate({ errorClass: "busy" })).toMatchObject({ valid: true });
    expect(validate({ errorClass: "busy", extra: 1 })).toMatchObject({ valid: false });
    expect(validate({ ...answer(), retentionClass: "forever" })).toMatchObject({ valid: false });
    expect(validate({ ...answer() })).toMatchObject({ valid: false });
  });
});

describe("errorClassOf", () => {
  it("各層の例外は分類だけを使い、それ以外は internal_error", () => {
    expect(errorClassOf(new OrchestratorError("audit_write_failed", "dev-only detail"))).toBe(
      "audit_write_failed",
    );
    expect(errorClassOf(new LlmError("llm_timeout", "dev-only detail"))).toBe("llm_timeout");
    expect(errorClassOf(new GatewayClientError("unauthenticated", "x"))).toBe(
      "gateway_unauthenticated",
    );
    expect(errorClassOf(new GatewayClientError("aborted", "x"))).toBe("run_timeout");
    expect(errorClassOf(new GatewayClientError("gateway_unavailable", "x"))).toBe(
      "gateway_unavailable",
    );
    expect(errorClassOf(new Error("dev-only secret-ish message"))).toBe("internal_error");
    expect(errorClassOf("string")).toBe("internal_error");
  });
});
