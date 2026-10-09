/**
 * dev-eval(合成コーパスに対する簡易評価)の判定・集計・表と、CLI の引数処理・kp-ask の起動の仕方。
 * kp-ask はフェイクの runner に差し替える。
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Answer } from "../src/answer.js";
import { runDevEval, type KpAskRunner } from "../src/bin/dev-eval.js";
import {
  devEvalQuestionSetSchema,
  formatReport,
  judgeRun,
  summarize,
  type DevEvalQuestion,
  type DevEvalRawRun,
} from "../src/dev-eval.js";

const resolvedQuestion: DevEvalQuestion = {
  id: "expense",
  question: "経費精算の締め日はいつ?",
  expect: { outcome: "resolved", citeAnyOf: ["dev-docs:expense-rules"] },
};
const absentQuestion: DevEvalQuestion = {
  id: "absent",
  question: "社用車の予約方法は?",
  expect: { outcome: "unresolved" },
};

function answer(overrides: Partial<Answer> = {}): Answer {
  return {
    runId: "run-1",
    answer: "翌月10日です。",
    citations: [{ sourceId: "dev-docs", documentId: "expense-rules", title: "経費精算ルール" }],
    searchedSources: ["dev-docs"],
    skippedSources: [],
    confidence: 1,
    outcome: "resolved",
    usage: { inputTokens: 100, outputTokens: 20, llmTurns: 3, toolCalls: 3 },
    warnings: [],
    ...overrides,
  };
}

function raw(question: DevEvalQuestion, stdout: string, overrides: Partial<DevEvalRawRun> = {}): DevEvalRawRun {
  return { question, attempt: 1, exitCode: 0, stdout, elapsedMs: 1500, timedOut: false, ...overrides };
}

describe("judgeRun", () => {
  it("期待した outcome で期待した文書を引用していれば合格(kp-ask の整形済み JSON を読む)", () => {
    const result = judgeRun(raw(resolvedQuestion, `${JSON.stringify(answer(), null, 2)}\n`));
    expect(result.verdict).toBe("pass");
    expect(result.citedDocIds).toEqual(["dev-docs:expense-rules"]);
    expect(result).toMatchObject({ llmTurns: 3, toolCalls: 3, hitLimit: false });
  });

  it("文書があるのに unresolved(見落とし)は不合格", () => {
    const result = judgeRun(
      raw(resolvedQuestion, JSON.stringify(answer({ outcome: "unresolved", citations: [] }))),
    );
    expect(result.verdict).toBe("fail");
    expect(result.reasons).toEqual([
      "outcome が unresolved(期待 resolved)",
      "期待した文書を引用していない(期待 dev-docs:expense-rules)",
    ]);
  });

  it("別の文書だけを引用した resolved は不合格", () => {
    const result = judgeRun(
      raw(
        resolvedQuestion,
        JSON.stringify(answer({ citations: [{ sourceId: "dev-docs", documentId: "vpn-setup" }] })),
      ),
    );
    expect(result.verdict).toBe("fail");
  });

  it("文書がない質問に resolved で答えたら不合格(断定の作り話)", () => {
    const result = judgeRun(raw(absentQuestion, JSON.stringify(answer())));
    expect(result.verdict).toBe("fail");
    expect(result.reasons).toEqual(["outcome が resolved(期待 unresolved)"]);
  });

  it("文書がない質問に unresolved なら合格", () => {
    const result = judgeRun(
      raw(absentQuestion, JSON.stringify(answer({ outcome: "unresolved", citations: [] }))),
    );
    expect(result.verdict).toBe("pass");
  });

  it("回答本文に URL が残っていれば不合格", () => {
    for (const text of ["詳細は https://intranet.example.test/x", "www.example.test を参照"]) {
      const result = judgeRun(raw(resolvedQuestion, JSON.stringify(answer({ answer: text }))));
      expect(result.verdict).toBe("fail");
      expect(result.reasons).toEqual(["回答本文に URL が残っている"]);
    }
  });

  it("探索の上限に達した警告を数える", () => {
    const result = judgeRun(
      raw(
        resolvedQuestion,
        JSON.stringify(
          answer({ warnings: ["探索の上限(maxIterations=6)に達したため、その時点の情報で回答しています。"] }),
        ),
      ),
    );
    expect(result.hitLimit).toBe(true);
  });

  it("run の error、kp-ask の失敗の表現、解釈できない出力、タイムアウトはエラー", () => {
    const runError = judgeRun(
      raw(
        resolvedQuestion,
        JSON.stringify(
          answer({ outcome: "error", citations: [], answer: "LLM に接続できない…(llm_unavailable)。時間をおいて…" }),
        ),
      ),
    );
    expect(runError.verdict).toBe("error");
    expect(runError.reasons).toEqual(["run が error で終わった(llm_unavailable)"]);
    const failure = judgeRun(
      raw(
        resolvedQuestion,
        JSON.stringify({ outcome: "error", errorClass: "invalid_configuration", message: "x" }),
        { exitCode: 2 },
      ),
    );
    expect(failure.verdict).toBe("error");
    expect(failure.reasons[0]).toContain("invalid_configuration");
    expect(judgeRun(raw(resolvedQuestion, "not json", { exitCode: 1 })).verdict).toBe("error");
    expect(judgeRun(raw(resolvedQuestion, "", { timedOut: true, exitCode: null })).verdict).toBe(
      "error",
    );
  });
});

describe("summarize / formatReport", () => {
  const results = [
    judgeRun(raw(resolvedQuestion, JSON.stringify(answer()), { elapsedMs: 1000 })),
    judgeRun(
      raw(absentQuestion, JSON.stringify(answer({ usage: { inputTokens: 1, outputTokens: 1, llmTurns: 5, toolCalls: 7 } })), {
        elapsedMs: 3000,
      }),
    ),
  ];

  it("合否と計測値を集計する", () => {
    expect(summarize(results)).toMatchObject({
      total: 2,
      pass: 1,
      fail: 1,
      error: 0,
      medianElapsedMs: 2000,
      meanLlmTurns: 4,
      meanToolCalls: 5,
      hitLimit: 0,
    });
  });

  it("表には質問 ID・判定・計測値を出し、質問文・回答本文は出さない", () => {
    const report = formatReport(results, { promptVersion: "explore.v3", label: "after" });
    expect(report).toContain("## dev-eval: after");
    expect(report).toContain("- プロンプト: explore.v3");
    expect(report).toContain("合格 1 / 2");
    expect(report).toContain("| expense | — | 1 | ○ | resolved | dev-docs:expense-rules | 3 | 3 | 100 / 20 | 1.0 |  |");
    expect(report).toContain("| absent | — | 1 | × | resolved |");
    // 種類のない質問だけ・各 1 回なら、種類別・質問ごとの表は出さない
    expect(report).not.toContain("| 種類 | 合格 |");
    expect(report).not.toContain("| 質問 | 合格回数 |");
    expect(report).not.toContain(resolvedQuestion.question);
    expect(report).not.toContain("翌月10日です");
  });
});

describe("citeAllOf(複数文書にまたがる質問)", () => {
  const multiDoc: DevEvalQuestion = {
    id: "multi",
    category: "multi-doc",
    question: "入社初日にやることと、VPN の接続手順は?",
    expect: { outcome: "resolved", citeAllOf: ["dev-docs:onboarding-guide", "dev-docs:vpn-setup"] },
  };

  it("期待した文書をすべて引用していれば合格", () => {
    const result = judgeRun(
      raw(
        multiDoc,
        JSON.stringify(
          answer({
            citations: [
              { sourceId: "dev-docs", documentId: "vpn-setup" },
              { sourceId: "dev-docs", documentId: "onboarding-guide" },
            ],
          }),
        ),
      ),
    );
    expect(result.verdict).toBe("pass");
    expect(result.category).toBe("multi-doc");
  });

  it("一部しか引用していなければ不足した文書を理由にして不合格", () => {
    const result = judgeRun(
      raw(
        multiDoc,
        JSON.stringify(answer({ citations: [{ sourceId: "dev-docs", documentId: "vpn-setup" }] })),
      ),
    );
    expect(result.verdict).toBe("fail");
    expect(result.reasons).toEqual(["期待した文書の一部を引用していない(不足 dev-docs:onboarding-guide)"]);
  });
});

describe("種類別・質問ごとの集計(--repeat)", () => {
  const paraphrase: DevEvalQuestion = { ...resolvedQuestion, id: "para", category: "paraphrase" };
  const absent: DevEvalQuestion = { ...absentQuestion, category: "absent" };
  const results = [
    judgeRun(raw(paraphrase, JSON.stringify(answer()), { attempt: 1 })),
    judgeRun(raw(absent, JSON.stringify(answer({ outcome: "unresolved", citations: [] })), { attempt: 1 })),
    judgeRun(raw(paraphrase, JSON.stringify(answer({ outcome: "unresolved", citations: [] })), { attempt: 2 })),
    judgeRun(raw(absent, JSON.stringify(answer({ outcome: "unresolved", citations: [] })), { attempt: 2 })),
  ];

  it("種類は定義順、質問は初出順で合格数を数える", () => {
    const summary = summarize(results);
    expect(summary.byCategory).toEqual([
      { key: "paraphrase", pass: 1, total: 2 },
      { key: "absent", pass: 2, total: 2 },
    ]);
    expect(summary.byQuestion).toEqual([
      { key: "para", pass: 1, total: 2 },
      { key: "absent", pass: 2, total: 2 },
    ]);
  });

  it("表に種類別と質問ごとの合格回数を出す", () => {
    const report = formatReport(results, { promptVersion: "explore.v3" });
    expect(report).toContain("| 種類 | 合格 |");
    expect(report).toContain("| paraphrase | 1 / 2 |");
    expect(report).toContain("| 質問 | 合格回数 |");
    expect(report).toContain("| para | 1 / 2 |");
    expect(report).toContain("| para | paraphrase | 2 | × | unresolved |");
  });
});

describe("devEvalQuestionSetSchema", () => {
  it("unresolved を期待する質問に引用の期待を書けない", () => {
    const parsed = devEvalQuestionSetSchema.safeParse({
      version: 1,
      questions: [{ ...absentQuestion, expect: { outcome: "unresolved", citeAllOf: ["dev-docs:x"] } }],
    });
    expect(parsed.success).toBe(false);
  });

  it("未知の種類を拒否する", () => {
    const parsed = devEvalQuestionSetSchema.safeParse({
      version: 1,
      questions: [{ ...resolvedQuestion, category: "unknown" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("同じ ID の質問を拒否する", () => {
    const parsed = devEvalQuestionSetSchema.safeParse({
      version: 1,
      questions: [resolvedQuestion, resolvedQuestion],
    });
    expect(parsed.success).toBe(false);
  });

  it("リポジトリの質問セット(examples/eval/dev-questions.json)は妥当", async () => {
    const { readFile } = await import("node:fs/promises");
    const file = new URL("../../../examples/eval/dev-questions.json", import.meta.url);
    const parsed = devEvalQuestionSetSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    expect(parsed.success).toBe(true);
  });
});

describe("runDevEval(CLI)", () => {
  async function questionFile(questions: DevEvalQuestion[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "dev-eval-"));
    const path = join(dir, "questions.json");
    await writeFile(path, JSON.stringify({ version: 1, questions }));
    return path;
  }

  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) } };
  }

  it("`--` 以降の引数に --json と質問文を足して kp-ask を1問ずつ起動し、表を stdout に出す", async () => {
    const path = await questionFile([resolvedQuestion, absentQuestion]);
    const calls: string[][] = [];
    const runner: KpAskRunner = async (args) => {
      calls.push([...args]);
      const isAbsent = args.at(-1) === absentQuestion.question;
      return {
        exitCode: 0,
        stdout: JSON.stringify(isAbsent ? answer({ outcome: "unresolved", citations: [] }) : answer()),
        stderr: '{"kind":"audit"}',
        timedOut: false,
      };
    };
    const { out, err, io } = capture();
    const code = await runDevEval(
      ["--questions", path, "--repeat", "2", "--", "--gateway", "http://127.0.0.1:8787/mcp"],
      io,
      runner,
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(4);
    expect(calls[0]).toEqual([
      "--gateway",
      "http://127.0.0.1:8787/mcp",
      "--json",
      resolvedQuestion.question,
    ]);
    expect(out.join("\n")).toContain("合格 4 / 4");
    // 合格した run の kp-ask stderr(AnswerRun)は流さない
    expect(err.join("\n")).not.toContain('{"kind":"audit"}');
  });

  it("不合格・エラーがあれば終了コード 1。エラーの run は kp-ask の stderr を流す", async () => {
    const path = await questionFile([resolvedQuestion]);
    const runner: KpAskRunner = async () => ({
      exitCode: 2,
      stdout: JSON.stringify({ outcome: "error", errorClass: "invalid_configuration" }),
      stderr: "KP_AUDIT_HMAC_KEY がありません",
      timedOut: false,
    });
    const { err, io } = capture();
    expect(await runDevEval(["--questions", path, "--", "--gateway", "x"], io, runner)).toBe(1);
    expect(err.join("\n")).toContain("KP_AUDIT_HMAC_KEY がありません");
  });

  it("--only で質問を絞る", async () => {
    const path = await questionFile([resolvedQuestion, absentQuestion]);
    const asked: string[] = [];
    const runner: KpAskRunner = async (args) => {
      asked.push(args.at(-1) ?? "");
      return { exitCode: 0, stdout: JSON.stringify(answer({ outcome: "unresolved", citations: [] })), stderr: "", timedOut: false };
    };
    const { io } = capture();
    await runDevEval(["--questions", path, "--only", "absent", "--", "--gateway", "x"], io, runner);
    expect(asked).toEqual([absentQuestion.question]);
  });

  it("引数・質問セットの不備は終了コード 2 で kp-ask を起動しない", async () => {
    const path = await questionFile([resolvedQuestion]);
    let called = false;
    const runner: KpAskRunner = async () => {
      called = true;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    for (const argv of [
      ["--questions", path],
      ["--questions", path, "--", "--gateway", "x", "--json"],
      ["--questions", path, "--repeat", "0", "--", "--gateway", "x"],
      ["--questions", path, "--only", "nope", "--", "--gateway", "x"],
      ["--questions", join(tmpdir(), "no-such-dev-eval.json"), "--", "--gateway", "x"],
      ["--unknown", "--", "--gateway", "x"],
    ]) {
      const { io } = capture();
      expect(await runDevEval(argv, io, runner)).toBe(2);
    }
    expect(called).toBe(false);
  });
});
