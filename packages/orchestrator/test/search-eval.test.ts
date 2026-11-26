/**
 * 検索方式の比較実験(src/search-eval/、bin/dev-search-eval.ts)のテスト。
 * LLM はすべて脚本(ScriptedLlmClient)。Gateway はプロセス内の実 Gateway(startEvalGateway)。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Orchestrator,
  SEARCH_SPEC_HEADING,
  ScriptedLlmClient,
  scriptedSubmit,
  scriptedText,
  scriptedToolUse,
  type GatewayCallOutcome,
  type GatewayClient,
  type ScriptContext,
} from "../src/index.js";
import {
  MemoryTraceSink,
  TracingGatewayClient,
  caseMetrics,
  checkQuestionsAgainstCorpus,
  formatMetricsReport,
  loadSearchEvalCorpus,
  reproduceUiQuestion,
  runSearchEval,
  searchEvalQuestionSetSchema,
  startEvalGateway,
  summarizeMetrics,
  uiQuestionRequest,
  type EvalGateway,
  type SearchEvalQuestion,
  type SearchEvalQuestionSet,
  type TraceEvent,
} from "../src/search-eval/index.js";
import { runDevSearchEval } from "../src/bin/dev-search-eval.js";

const QUESTIONS_PATH = fileURLToPath(new URL("../../../examples/eval/search-questions.json", import.meta.url));

async function loadSet(): Promise<SearchEvalQuestionSet> {
  return searchEvalQuestionSetSchema.parse(JSON.parse(await readFile(QUESTIONS_PATH, "utf8")));
}

function question(overrides: Partial<SearchEvalQuestion> = {}): SearchEvalQuestion {
  return {
    id: "q1",
    category: "multi-doc",
    utterance: "質問",
    keywords: ["語"],
    relevant: ["dev-docs:a", "dev-docs:b"],
    ...overrides,
  };
}

const CTX = { mode: "default", condition: "orchestrator-utterance", questionId: "q1", attempt: 1 } as const;

function search(hits: string[], extra: Partial<Extract<TraceEvent, { type: "search" }>> = {}): TraceEvent {
  return {
    ...CTX,
    type: "search",
    source: "dev-docs",
    query: "語",
    hits: hits.map((documentId, i) => ({ rank: i + 1, documentId, title: documentId })),
    hasMore: false,
    ...extra,
  };
}

describe("質問セット(examples/eval/search-questions.json)", () => {
  it("スキーマに合い、コーパスと整合し、3 種の質問がそろっている", async () => {
    const set = await loadSet();
    const documents = await loadSearchEvalCorpus(QUESTIONS_PATH, set);
    expect(documents.length).toBeGreaterThanOrEqual(300);
    expect(checkQuestionsAgainstCorpus(set, documents)).toEqual([]);
    const of = (category: string) => set.questions.filter((q) => q.category === category);
    expect(of("known-item").length).toBeGreaterThanOrEqual(5);
    expect(of("multi-doc").filter((q) => q.secondExplicit === true).length).toBeGreaterThanOrEqual(2);
    expect(of("multi-doc").filter((q) => q.secondExplicit === false).length).toBeGreaterThanOrEqual(2);
    expect(of("unanswerable").length).toBeGreaterThanOrEqual(2);
    expect(of("unanswerable").every((q) => (q.mustNotAppear ?? []).length > 0)).toBe(true);
  });

  it("整合の検査は、ない正解文書と、答えられない質問の語の組を含む文書を報告する", async () => {
    const set: SearchEvalQuestionSet = {
      version: 1,
      source: "dev-docs",
      corpus: { files: ["x.yaml"] },
      questions: [
        question({ id: "missing", category: "known-item", relevant: ["dev-docs:nope"] }),
        question({ id: "leak", category: "unanswerable", relevant: [], mustNotAppear: ["駐車場 申し込み"] }),
      ],
    };
    const issues = checkQuestionsAgainstCorpus(set, [
      { id: "d1", title: "駐車場", content: "申し込みは総務へ" },
    ]);
    expect(issues.map((i) => i.questionId)).toEqual(["missing", "leak"]);
  });

  it("不正な質問(unanswerable に正解・multi-doc に 1 件・別ソースの正解)を拒否する", () => {
    const base = { version: 1, source: "dev-docs", corpus: { files: ["x.yaml"] } };
    for (const q of [
      question({ category: "unanswerable" }),
      question({ relevant: ["dev-docs:a"] }),
      question({ relevant: ["other:a", "dev-docs:b"] }),
      question({ category: "known-item", relevant: ["dev-docs:a"], mustNotAppear: ["x"] }),
    ]) {
      expect(searchEvalQuestionSetSchema.safeParse({ ...base, questions: [q] }).success).toBe(false);
    }
  });
});

describe("指標", () => {
  it("search を複数回呼んだら文書ごとに最もよい順位で recall@k を数える", () => {
    const m = caseMetrics(
      question(),
      CTX,
      [
        search(["x", "y", "a"]),
        search(["a", "z"]),
        search([]),
        search(["b"]),
        { ...CTX, type: "fetch", source: "dev-docs", documentId: "a" },
        { ...CTX, type: "fetch", source: "dev-docs", documentId: "b", errorClass: "not_available" },
        { ...CTX, type: "answer", outcome: "resolved", citations: [{ sourceId: "dev-docs", documentId: "a" }] },
      ],
      [1, 5],
    );
    expect(m.recallAt).toEqual({ 1: 1, 5: 1 });
    expect(m.firstRelevantRank).toBe(1);
    expect(m.searches).toBe(4);
    expect(m.zeroHitSearches).toBe(1);
    expect(m.fetchedRate).toBe(0.5);
    expect(m.citedRate).toBe(0.5);
    expect(m.outcome).toBe("resolved");
  });

  it("条件 1・2 は fetch / 引用 / 棄権を数えない。答えられない質問は棄権を数える", () => {
    const direct = caseMetrics(question(), { ...CTX, condition: "keywords" }, [search(["x", "b"])], [1, 5]);
    expect(direct.recallAt).toEqual({ 1: 0, 5: 0.5 });
    expect(direct.fetchedRate).toBeUndefined();
    expect(direct.abstained).toBeUndefined();
    const un = question({ category: "unanswerable", relevant: [] });
    const abstained = caseMetrics(un, CTX, [{ ...CTX, type: "answer", outcome: "unresolved", citations: [] }]);
    expect(abstained.recallAt).toBeUndefined();
    expect(abstained.abstained).toBe(true);
    const answered = caseMetrics(un, CTX, [{ ...CTX, type: "answer", outcome: "resolved", citations: [] }]);
    expect(answered.abstained).toBe(false);
    const failed = caseMetrics(un, CTX, [{ ...CTX, type: "case_error", errorClass: "ui_did_not_call_ask" }]);
    expect(failed.abstained).toBe(false);
    expect(failed.errorClass).toBe("ui_did_not_call_ask");
  });

  it("集計は方式 × 条件 × 種類で、表に質問文・クエリを出さない", () => {
    const q = question({ utterance: "秘密ではないが表に出さない発言" });
    const rows = [
      caseMetrics(q, { ...CTX, condition: "keywords" }, [search(["a", "b"])], [1]),
      caseMetrics(q, { ...CTX, condition: "keywords", mode: "esa" }, [search([])], [1]),
    ];
    const summary = summarizeMetrics(rows, [1]);
    expect(summary.map((r) => [r.mode, r.condition, r.category, r.meanRecallAt?.[1]])).toEqual([
      ["default", "keywords", "multi-doc", 0.5],
      ["default", "keywords", "all-answerable", 0.5],
      ["esa", "keywords", "multi-doc", 0],
      ["esa", "keywords", "all-answerable", 0],
    ]);
    const report = formatMetricsReport(rows, { corpusSize: 10, ks: [1] });
    expect(report).toContain("| default | 1 キーワード直接 | multi-doc | 1 | 50% |");
    expect(report).not.toContain("表に出さない発言");
    expect(report).not.toContain("| 語 |");
  });
});

describe("トレース(TracingGatewayClient)", () => {
  it("search のクエリ・filters・順位付きのヒットと、fetch の documentId を書き、結果は変えない", async () => {
    const results: Record<string, GatewayCallOutcome> = {
      search: { ok: true, result: { hits: [{ documentId: "a", title: "A", snippet: "s" }], nextCursor: "c" } },
      fetch: { ok: false, error: { errorClass: "not_available", message: "この対象は利用できません。" } },
    };
    const inner = {
      callTool: async (name: string) => results[name] as GatewayCallOutcome,
    } as unknown as GatewayClient;
    const sink = new MemoryTraceSink();
    const traced = new TracingGatewayClient(inner, sink, CTX);
    const out = await traced.callTool(
      "search",
      { source: "dev-docs", query: "経費", filters: { container: "総務" }, limit: 5 },
      {},
    );
    expect(out).toBe(results["search"]);
    await traced.callTool("fetch", { source: "dev-docs", documentId: "a" }, {});
    await traced.callTool("describe", { source: "dev-docs" }, {});
    expect(sink.events).toEqual([
      {
        ...CTX,
        type: "search",
        source: "dev-docs",
        query: "経費",
        filters: { container: "総務" },
        limit: 5,
        hits: [{ rank: 1, documentId: "a", title: "A" }],
        hasMore: true,
      },
      { ...CTX, type: "fetch", source: "dev-docs", documentId: "a", errorClass: "not_available" },
    ]);
  });

  it("search の通知(connector-sdk v0.6、廃止)はトレースに書かない", async () => {
    const inner = {
      callTool: async () => ({
        ok: true,
        result: {
          hits: [],
          notices: [{ kind: "terms_dropped", keptTerms: 5, text: "自由文" }, { kind: "unknown_kind" }],
        },
      }),
    } as unknown as GatewayClient;
    const sink = new MemoryTraceSink();
    await new TracingGatewayClient(inner, sink, CTX).callTool("search", { source: "dev-docs", query: "a" }, {});
    expect(sink.events[0]).toMatchObject({ type: "search", hits: [] });
    expect(sink.events[0]).not.toHaveProperty("notices");
    expect(JSON.stringify(sink.events)).not.toContain("自由文");
  });
});

describe("UI 側 LLM の再現(条件 4)", () => {
  it("ask のツール定義と instructions を与え、ask の question を取り出す", async () => {
    const llm = new ScriptedLlmClient([
      () => scriptedToolUse([{ name: "ask", input: { question: "経費精算の締め日" } }]),
    ]);
    expect(await reproduceUiQuestion(llm, "経費精算っていつまで?")).toEqual({
      ok: true,
      question: "経費精算の締め日",
    });
    const request = llm.requests[0];
    expect(request?.tools.map((t) => t.name)).toEqual(["ask", "feedback"]);
    expect(request?.system[0]?.text).toContain("ask ツールに渡してください");
    expect(request?.messages).toEqual(uiQuestionRequest("経費精算っていつまで?").messages);
  });

  it("ask を呼ばない・question が空・LLM の失敗はそれぞれの分類で返す", async () => {
    const cases: [ScriptedLlmClient, string][] = [
      [new ScriptedLlmClient([() => scriptedText("こんにちは")]), "ui_did_not_call_ask"],
      [new ScriptedLlmClient([() => scriptedToolUse([{ name: "ask", input: { question: " " } }])]), "ui_invalid_question"],
      [new ScriptedLlmClient([]), "ui_llm_error"],
    ];
    for (const [llm, errorClass] of cases) {
      expect(await reproduceUiQuestion(llm, "発言")).toEqual({ ok: false, errorClass });
    }
  });
});

/** 探索 LLM の脚本: 発言・質問に含まれる語で search → 最初のヒットを fetch → 引用して提出。 */
function exploreScript(queryOf: (question: string) => string) {
  return (context: ScriptContext) => {
    const first = context.request.messages[0];
    const text = JSON.stringify(first?.content ?? "");
    const last = context.lastToolResults[0];
    // 脚本のクライアントは run をまたいで使うので、最初のターンは履歴の長さで判定する
    if (context.request.messages.length === 1) {
      return scriptedToolUse([{ name: "search", input: { source: "dev-docs", query: queryOf(text) } }]);
    }
    const json = last?.json as { tool?: string; result?: { hits?: { documentId: string }[]; documentId?: string } };
    if (json?.tool === "search") {
      const hit = json.result?.hits?.[0];
      if (hit === undefined) {
        return scriptedSubmit({ answer: "見つけられなかった。", citations: [], confidence: 0.1, unresolvedReason: "該当なし" });
      }
      return scriptedToolUse([{ name: "fetch", input: { source: "dev-docs", documentId: hit.documentId } }]);
    }
    const documentId = json?.result?.documentId ?? "";
    return scriptedSubmit({
      answer: "文書に書かれている。",
      citations: [{ documentId, sourceId: "dev-docs" }],
      confidence: 0.9,
    });
  };
}

describe("実行(プロセス内の Gateway、条件 1〜4)", () => {
  let set: SearchEvalQuestionSet;
  let gateway: EvalGateway;
  beforeAll(async () => {
    set = await loadSet();
    gateway = await startEvalGateway({
      sourceId: set.source,
      documents: await loadSearchEvalCorpus(QUESTIONS_PATH, set),
      mode: "esa",
    });
  });
  afterAll(async () => {
    await gateway.close();
  });

  it("4 条件を実行し、トレースに search・fetch・出典・UI の question を残す", async () => {
    const questions = set.questions.filter((q) => q.id === "ki-expense-rules" || q.id === "un-parking");
    const orchestrator = new Orchestrator({
      // 質問に「駐車場」があればその語で、なければ「経費精算ルール」で検索する
      llm: new ScriptedLlmClient(exploreScript((text) => (text.includes("駐車場") ? "駐車場" : "経費精算ルール"))),
    });
    const uiLlm = new ScriptedLlmClient((context) => {
      const utterance = String(context.request.messages[0]?.content ?? "");
      return scriptedToolUse([{ name: "ask", input: { question: `言い換え: ${utterance}` } }]);
    });
    const sink = new MemoryTraceSink();
    const rows = await runSearchEval({
      mode: "esa",
      source: set.source,
      questions,
      conditions: ["keywords", "utterance", "orchestrator-utterance", "orchestrator-ui"],
      gateway: gateway.client,
      sink,
      orchestrator,
      uiLlm,
    });
    const byKey = (condition: string, id: string) =>
      rows.find((r) => r.condition === condition && r.questionId === id);
    expect(byKey("keywords", "ki-expense-rules")?.firstRelevantRank).toBe(1);
    expect(byKey("utterance", "ki-expense-rules")?.firstRelevantRank).toBeUndefined();
    const explored = byKey("orchestrator-utterance", "ki-expense-rules");
    expect(explored?.firstRelevantRank).toBe(1);
    expect(explored?.fetchedRate).toBe(1);
    expect(explored?.citedRate).toBe(1);
    expect(byKey("orchestrator-utterance", "un-parking")?.abstained).toBe(true);
    expect(byKey("orchestrator-ui", "un-parking")?.abstained).toBe(true);
    expect(byKey("orchestrator-ui", "ki-expense-rules")?.citedRate).toBe(1);

    const searches = sink.events.filter((e) => e.type === "search" && e.condition === "orchestrator-utterance");
    expect(searches.map((e) => (e.type === "search" ? e.query : ""))).toEqual(["経費精算ルール", "駐車場"]);
    const ui = sink.events.find((e) => e.type === "ui_question" && e.questionId === "ki-expense-rules");
    expect(ui).toMatchObject({ question: "言い換え: 「経費精算ルール(2026年度版)」のページを開きたい" });
    const answer = sink.events.find(
      (e) => e.type === "answer" && e.condition === "orchestrator-utterance" && e.questionId === "ki-expense-rules",
    );
    expect(answer).toMatchObject({ outcome: "resolved", citations: [{ sourceId: "dev-docs", documentId: "expense-rules" }] });
    // トレースに資格情報(開発用のダミーを含む)を書かない
    expect(JSON.stringify(sink.events)).not.toContain("dev-only");
  });

  it("UI 側 LLM が ask を呼ばなければ、その試行は case_error で、探索 LLM を呼ばない", async () => {
    const llm = new ScriptedLlmClient([]);
    const rows = await runSearchEval({
      mode: "esa",
      source: set.source,
      questions: set.questions.slice(0, 1),
      conditions: ["orchestrator-ui"],
      gateway: gateway.client,
      sink: new MemoryTraceSink(),
      orchestrator: new Orchestrator({ llm }),
      uiLlm: new ScriptedLlmClient([() => scriptedText("ask は使いません")]),
    });
    expect(rows[0]?.errorClass).toBe("ui_did_not_call_ask");
    expect(llm.requests).toHaveLength(0);
  });
});

describe("dev-search-eval(CLI)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "dev-search-eval-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) } };
  }

  it("条件 1・2 を LLM なしで実行し、表を stdout、トレースを JSONL に書く", async () => {
    const { out, io: cli } = io();
    const trace = join(dir, "trace.jsonl");
    const code = await runDevSearchEval(
      ["--modes", "default,redmine-or", "--only", "ki-inc-0412,un-gym", "--k", "1,3", "--trace", trace],
      cli,
    );
    expect(code).toBe(0);
    const report = out.join("\n");
    expect(report).toContain("recall@3");
    expect(report).toContain("| redmine-or | 2 発言を直接 |");
    const events = (await readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TraceEvent);
    const keywordSearch = events.find(
      (e) => e.type === "search" && e.mode === "default" && e.condition === "keywords" && e.questionId === "ki-inc-0412",
    );
    expect(keywordSearch).toMatchObject({ query: "INC-2026-0412", limit: 3 });
    expect(keywordSearch?.type === "search" ? keywordSearch.hits[0]?.documentId : undefined).toBe(
      "incident-report-0412",
    );
  });

  it("条件 3 は LLM の指定を使い、LLM の指定がなければ引数の不備", async () => {
    const created: string[] = [];
    const deps = {
      env: {},
      createLlmClient: (config: { model?: string }) => {
        created.push(String(config.model));
        return new ScriptedLlmClient(exploreScript(() => "INC-2026-0412"));
      },
    };
    const ok = io();
    const code = await runDevSearchEval(
      [
        "--modes", "default", "--conditions", "orchestrator-utterance", "--only", "ki-inc-0412",
        "--llm", "openai-compatible", "--llm-base-url", "http://127.0.0.1:9/v1", "--model", "m1",
      ],
      ok.io,
      deps,
    );
    expect(code).toBe(0);
    expect(created).toEqual(["m1"]);
    expect(ok.out.join("\n")).toContain("| default | 3 発言→探索LLM | known-item | 1 | 100% |");

    const missing = io();
    expect(
      await runDevSearchEval(["--conditions", "orchestrator-utterance", "--llm", "openai-compatible"], missing.io, deps),
    ).toBe(2);
  });

  it("検索の仕様は枠の外のブロックで探索 LLM に渡り、ソース一覧の summary には入らない(T-032)", async () => {
    const llm = new ScriptedLlmClient(exploreScript(() => "存在しない語ZQX"));
    const deps = { env: {}, createLlmClient: () => llm };
    const ok = io();
    const trace = join(dir, "trace-spec.jsonl");
    const code = await runDevSearchEval(
      [
        "--modes", "esa,redmine-and", "--conditions", "orchestrator-utterance", "--only", "ki-inc-0412",
        "--trace", trace,
        "--llm", "openai-compatible", "--llm-base-url", "http://127.0.0.1:9/v1", "--model", "m1",
      ],
      ok.io,
      deps,
    );
    expect(code).toBe(0);
    const report = ok.out.join("\n");
    expect(report).toContain("| esa | 3 発言→探索LLM |");
    expect(report).toContain("| redmine-and | 3 発言→探索LLM |");
    const firstTurns = llm.requests
      .filter((r) => r.messages.length === 1)
      .map((r) => (r.messages[0]?.content as { type: string; text?: string }[]).map((b) => b.text ?? ""));
    expect(firstTurns).toHaveLength(2);
    const [esaTurn, redmineTurn] = firstTurns;
    // ソース一覧の JSON(2 つ目のブロック)に検索の仕様はない。3 つ目のブロックが検索の仕様
    expect(esaTurn?.[1]).not.toContain("検索の仕様(esa 型を模した");
    expect(esaTurn?.[2]?.startsWith(SEARCH_SPEC_HEADING)).toBe(true);
    expect(esaTurn?.[2]).toContain("検索の仕様(esa 型を模した開発用の方式)");
    expect(redmineTurn?.[2]).toContain("すべての語を含む文書だけを返す(AND)");
    // 検索プロファイルの文・通知は入らない
    const sent = JSON.stringify(llm.requests.map((r) => r.messages));
    expect(sent).not.toContain("各ソースの検索の仕様(オーケストレーター");
    expect(sent).not.toContain("語数の上限を超えたため");
    // 0 件の制御メッセージは新しい置き場所を指す
    expect(sent).toContain("「各ソースの検索の仕様」の dev-docs の行を読み直し");
    const events = (await readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TraceEvent);
    expect(events.filter((e) => e.type === "search").every((e) => !("notices" in e))).toBe(true);
  });

  it("不正な引数は 2", async () => {
    for (const argv of [
      ["--modes", "solr"],
      ["--spec-delivery", "free_text"],
      ["--spec-delivery", "summary"],
      ["--conditions", "x"],
      ["--k", "0"],
      ["--repeat", "99"],
      ["--ui-model", "m"],
      ["--only", "nope"],
      ["--questions", join(dir, "missing.json")],
    ]) {
      expect(await runDevSearchEval(argv, io().io)).toBe(2);
    }
  });
});
