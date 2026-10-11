/**
 * e2e(OpenAI 互換経路): 実 Gateway(port 0、モック IdP、コーパス型コネクタ)+ 実 LLM
 * クライアント(createLlmClient → OpenAiCompatibleLlmClient、グローバル fetch)+ モック
 * Chat Completions サーバー(LM Studio 等と同じ `{baseUrl}/chat/completions`)。
 *
 * ネットワークは 127.0.0.1 のみ。既存のシナリオ(1発ヒット / 再検索 / 未解決 / 未接続
 * ソース)に加え、tool_calls の arguments が壊れた JSON のケース、finish_reason: length、
 * 429 の再試行、資格情報・reasoning_effort の送り方、kp-ask からの実行を通す。
 * 実モデル(LM Studio + gpt-oss 等)での疎通は未検証(README「LM Studio で使う」)。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIDENCE_CAP_WITHOUT_CITATIONS,
  McpGatewayClient,
  NO_CITATION_NOTICE,
  Orchestrator,
  TOOL_RESULT_PREFACE,
  createLlmClient,
  loadExplorePrompt,
  type Answer,
  type LlmClientDependencies,
  type OpenAiCompatibleLlmSettingsInput,
} from "../src/index.js";
import {
  OPENAI_COMPATIBLE_CREDENTIALS_REQUIRED_MESSAGE,
  runCli,
  type CliDependencies,
} from "../src/bin/kp-ask.js";
import {
  ALICE_TOKEN,
  CorpusConnector,
  EXPENSE_POLICY,
  TRAVEL_GUIDE,
  startGateway,
  type GatewayHarness,
  type GatewayHarnessOptions,
} from "./helpers/harness.js";
import {
  openAiError,
  openAiSubmit,
  openAiText,
  openAiToolCalls,
  startMockOpenAiServer,
  type MockOpenAiServer,
  type OpenAiMockStep,
} from "./helpers/mock-openai-server.js";
import { fetchedDocuments, firstHit, searchHits } from "./helpers/script.js";

const MODEL = "openai/gpt-oss-20b";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

interface Setup {
  readonly harness: GatewayHarness;
  readonly mock: MockOpenAiServer;
  readonly orchestrator: Orchestrator;
}

async function startServers(
  options: GatewayHarnessOptions,
  script: readonly OpenAiMockStep[],
): Promise<{ harness: GatewayHarness; mock: MockOpenAiServer }> {
  const harness = await startGateway(options);
  cleanups.push(() => harness.close());
  const mock = await startMockOpenAiServer(script);
  cleanups.push(() => mock.close());
  return { harness, mock };
}

async function setup(
  options: GatewayHarnessOptions,
  script: readonly OpenAiMockStep[],
  config: Partial<OpenAiCompatibleLlmSettingsInput> = {},
  dependencies: LlmClientDependencies = {},
): Promise<Setup> {
  const { harness, mock } = await startServers(options, script);
  const llm = createLlmClient(
    { provider: "openai_compatible", baseUrl: mock.baseUrl, model: MODEL, maxRetries: 0, ...config },
    dependencies,
  );
  return {
    harness,
    mock,
    orchestrator: new Orchestrator({
      llm,
    }),
  };
}

/** 利用者 alice のセッションで1問を探索する(run の呼び出しはここに集める)。 */
function ask(context: Setup, question: string): Promise<Answer> {
  return context.orchestrator.run({
    question,
    userId: "alice",
    gateway: context.harness.client(),
  });
}

interface WireToolCall {
  readonly id: string;
  readonly type: string;
  readonly function: { readonly name: string; readonly arguments: string };
}
interface WireMessage {
  readonly role: string;
  readonly content: string | null;
  readonly tool_calls?: readonly WireToolCall[];
  readonly tool_call_id?: string;
}

function wireMessages(mock: MockOpenAiServer, index: number): WireMessage[] {
  return mock.requests[index]?.body["messages"] as WireMessage[];
}

function searchIterations(harness: GatewayHarness, runId: string): number[] {
  return harness
    .toolInvocations(runId)
    .map((record) => record.iteration)
    .sort((a, b) => a - b);
}

describe("e2e(OpenAI 互換経路・モック Chat Completions)", () => {
  it("(a) 1発ヒット: 要求の形(messages・tools・tool_choice・stream・strict なし)と tool_calls / tool の対応", async () => {
    const alpha = new CorpusConnector("alpha", [EXPENSE_POLICY]);
    const context = await setup(
      { connectors: [alpha, new CorpusConnector("beta", [TRAVEL_GUIDE])] },
      [
        () => openAiToolCalls([{ name: "search", input: { source: "alpha", query: "経費精算 締め日" } }]),
        (script) => {
          const hit = firstHit(script);
          return openAiToolCalls([
            { name: "fetch", input: { source: hit.source, documentId: hit.documentId } },
          ]);
        },
        (script) => {
          const document = fetchedDocuments(script)[0];
          return openAiSubmit({
            answer: "経費精算の締め日は毎月25日です。",
            citations: [{ documentId: document?.documentId, sourceId: document?.source }],
            confidence: 0.9,
          });
        },
      ],
    );

    const answer = await ask(context, "経費精算の締め日はいつ?");

    const { mock } = context;
    expect(mock.scriptErrors).toEqual([]);
    expect(answer.outcome).toBe("resolved");
    expect(answer.citations).toEqual([
      {
        documentId: "doc-expense-policy",
        sourceId: "alpha",
        title: "経費精算規程",
        url: "https://alpha.example.test/docs/doc-expense-policy",
      },
    ]);
    // usage は記録する(1ターン prompt 1200 / completion 80)。価格表がないので費用は不明のまま
    expect(answer.usage).toMatchObject({
      llmTurns: 3,
      toolCalls: 4,
      inputTokens: 3_600,
      outputTokens: 240,
    });
    expect(answer.usage.estimatedCost).toBeUndefined();
    expect(answer.warnings.some((warning) => warning.startsWith("価格表にないモデル"))).toBe(true);

    // 要求の形(1回目)
    const first = mock.requests[0];
    expect(first?.path).toBe("/v1/chat/completions");
    expect(first?.hasAuthorization).toBe(false); // apiKeyEnv 未指定(LM Studio 等)
    expect(first?.body).toMatchObject({
      model: MODEL,
      tool_choice: "auto",
      max_tokens: 16_000,
      stream: false,
    });
    for (const key of ["reasoning_effort", "thinking", "output_config", "cache_control", "system"]) {
      expect(first?.body).not.toHaveProperty(key);
    }
    const serialized = JSON.stringify(first?.body);
    expect(serialized).not.toContain('"strict"');
    expect(serialized).not.toContain('"cache_control"');
    const tools = first?.body["tools"] as {
      type: string;
      function: {
        name: string;
        description?: string;
        parameters: { type: string; additionalProperties?: boolean; properties?: { source?: { enum?: string[] } } };
      };
    }[];
    expect(tools.map((tool) => tool.type)).toEqual(Array(5).fill("function"));
    expect(tools.map((tool) => tool.function.name)).toEqual([
      "describe",
      "fetch",
      "list",
      "search",
      "submit_answer",
    ]);
    const search = tools.find((tool) => tool.function.name === "search");
    expect(search?.function.parameters).toMatchObject({ type: "object", additionalProperties: false });
    expect(search?.function.parameters.properties?.source?.enum).toEqual(["alpha", "beta"]);
    expect(search?.function.description).toContain("類義語");
    // system メッセージ1件(固定部が先頭)→ user(質問)
    const messages = wireMessages(mock, 0);
    expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(messages[0]?.content?.startsWith(await loadExplorePrompt())).toBe(true);
    expect(messages[1]?.content).toContain("経費精算の締め日はいつ?");

    // 2回目: assistant の tool_calls(arguments は JSON 文字列)→ tool メッセージ(tool_call_id)
    const second = wireMessages(mock, 1);
    expect(second.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool"]);
    const call = second[2]?.tool_calls?.[0];
    expect(second[2]?.content).toBeNull();
    expect(call?.type).toBe("function");
    expect(call?.function.name).toBe("search");
    expect(JSON.parse(call?.function.arguments ?? "")).toEqual({
      source: "alpha",
      query: "経費精算 締め日",
    });
    expect(second[3]?.tool_call_id).toBe(call?.id);
    expect(second[3]?.content?.startsWith(TOOL_RESULT_PREFACE)).toBe(true);

    expect(alpha.calls.map((c) => c.tool)).toEqual(["describe", "search", "fetch"]);
  });

  it("(b) 再検索で到達: 初回 search が0件 → 英日変換で再検索 → resolved", async () => {
    const context = await setup({ connectors: [new CorpusConnector("alpha", [TRAVEL_GUIDE])] }, [
      () => openAiToolCalls([{ name: "search", input: { source: "alpha", query: "出張費の払い戻し期限" } }]),
      (script) => {
        if (searchHits(script).length !== 0) {
          throw new Error("the first search was expected to return no hits");
        }
        return openAiToolCalls([
          { name: "search", input: { source: "alpha", query: "expense reimbursement deadline" } },
        ]);
      },
      (script) => {
        const hit = firstHit(script);
        return openAiSubmit({
          answer: "出張経費の精算は30日以内に申請します。",
          citations: [{ documentId: hit.documentId, sourceId: hit.source }],
          confidence: 0.8,
        });
      },
    ]);

    const answer = await ask(context, "出張費の払い戻しの期限は?");

    expect(context.mock.scriptErrors).toEqual([]);
    expect(answer.outcome).toBe("resolved");
    expect(answer.citations.map((citation) => citation.documentId)).toEqual(["doc-travel-guide"]);
    const searches = context.harness
      .toolInvocations(answer.runId)
      .filter((record) => record.tool === "search")
      .sort((a, b) => a.iteration - b.iteration);
    expect(searches.map((record) => record.returnedHitCount)).toEqual([0, 1]);
  });

  it("(c) 未解決: 並列の search が0件 → 出典なしで提出 → unresolved、注意書き、confidence ≤ 0.3", async () => {
    const context = await setup(
      {
        connectors: [
          new CorpusConnector("alpha", [EXPENSE_POLICY]),
          new CorpusConnector("beta", [TRAVEL_GUIDE]),
        ],
      },
      [
        () =>
          openAiToolCalls([
            { name: "search", input: { source: "alpha", query: "来期の組織変更" } },
            { name: "search", input: { source: "beta", query: "来期の組織変更" } },
          ]),
        (script) => {
          if (script.lastToolResults.length !== 2) {
            throw new Error("each parallel call must get its own tool message");
          }
          return openAiSubmit({
            answer: "来期の組織変更について書かれた文書は見つかりませんでした。",
            citations: [],
            confidence: 0.7,
            unresolvedReason: "該当する文書が見つからなかった",
          });
        },
      ],
    );

    const answer = await ask(context, "来期の組織変更は決まっている?");

    expect(context.mock.scriptErrors).toEqual([]);
    expect(answer.outcome).toBe("unresolved");
    expect(answer.answer.startsWith(NO_CITATION_NOTICE)).toBe(true);
    expect(answer.confidence).toBeLessThanOrEqual(CONFIDENCE_CAP_WITHOUT_CITATIONS);
    expect(answer.searchedSources).toEqual(["alpha", "beta"]);
    expect(context.harness.answerRuns().at(-1)?.failureReason).toBe("no_citations");
  });

  it("(d) 一部ソース未接続: ツール定義の source から外れ、要求されても Gateway に送らない", async () => {
    const beta = new CorpusConnector("beta", [TRAVEL_GUIDE]);
    const context = await setup(
      { connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY]), beta], notConnected: ["beta"] },
      [
        () =>
          openAiToolCalls([
            { name: "search", input: { source: "alpha", query: "経費精算" } },
            { name: "search", input: { source: "beta", query: "経費精算" } },
          ]),
        (script) => {
          const rejected = script.lastToolResults.find(
            (result) => (result.toolInput as { source?: string }).source === "beta",
          );
          if (rejected?.isError !== true) {
            throw new Error("the call to the unconnected source must be rejected");
          }
          const hit = firstHit(script);
          return openAiSubmit({
            answer: "経費精算の締め日は毎月25日です。",
            citations: [{ documentId: hit.documentId, sourceId: "alpha" }],
            confidence: 0.85,
          });
        },
      ],
    );

    const answer = await ask(context, "経費精算の締め日は?");

    expect(context.mock.scriptErrors).toEqual([]);
    const tools = context.mock.requests[0]?.body["tools"] as {
      function: { name: string; parameters: { properties?: { source?: { enum?: string[] } } } };
    }[];
    const search = tools.find((tool) => tool.function.name === "search");
    expect(search?.function.parameters.properties?.source?.enum).toEqual(["alpha"]);
    expect(answer.outcome).toBe("resolved");
    expect(answer.skippedSources).toEqual([{ sourceId: "beta", reason: "source_not_connected" }]);
    expect(answer.answer).toContain("未接続のため検索していないソース: beta");
    expect(beta.calls).toEqual([]);
  });

  it("arguments が壊れた JSON: Gateway に送らず is_error の結果を返し、履歴には {} で戻して続行する", async () => {
    const context = await setup({ connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])] }, [
      // 途中で切れた JSON(finish_reason は tool_calls)
      () => openAiToolCalls([{ name: "search", rawArguments: '{"source": "alpha", "query": "経費' }]),
      (script) => {
        const result = script.lastToolResults[0];
        if (result?.isError !== true || (result.json as { errorClass?: string }).errorClass !== "invalid_request") {
          throw new Error("the malformed call must come back as an invalid_request error");
        }
        return openAiToolCalls([{ name: "search", input: { source: "alpha", query: "経費精算" } }]);
      },
      (script) => {
        const hit = firstHit(script);
        return openAiSubmit({
          answer: "経費精算の締め日は毎月25日です。",
          citations: [{ documentId: hit.documentId, sourceId: hit.source }],
          confidence: 0.8,
        });
      },
    ]);

    const answer = await ask(context, "経費精算の締め日は?");

    expect(context.mock.scriptErrors).toEqual([]);
    expect(answer.outcome).toBe("resolved");
    // 壊れた arguments は送り返さない(引数を JSON として読むサーバーで次の要求が失敗するため)
    const echoed = wireMessages(context.mock, 1).find((message) => message.role === "assistant");
    expect(echoed?.tool_calls?.[0]?.function.arguments).toBe("{}");
    // Gateway には有効な search だけが届き、壊れた呼び出しは iteration を消費しない
    const records = context.harness.toolInvocations(answer.runId);
    expect(records.filter((record) => record.tool === "search")).toHaveLength(1);
    expect(searchIterations(context.harness, answer.runId)).toEqual([0, 1]);
  });

  it("submit_answer の arguments が壊れた JSON: 落ちずに unresolved(invalid_answer_submission)で終える", async () => {
    const context = await setup({ connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])] }, [
      () => openAiToolCalls([{ name: "submit_answer", rawArguments: '{"answer": "締め日は' }]),
    ]);

    const answer = await ask(context, "経費精算の締め日は?");

    expect(answer.outcome).toBe("unresolved");
    expect(answer.answer.startsWith(NO_CITATION_NOTICE)).toBe(true);
    expect(context.harness.answerRuns().at(-1)?.failureReason).toBe("invalid_answer_submission");
  });

  it("finish_reason: length は切れたツール入力を実行せず error(llm_max_tokens)", async () => {
    const context = await setup({ connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])] }, [
      () =>
        openAiToolCalls([{ name: "search", rawArguments: '{"source":"al' }], {
          finishReason: "length",
        }),
    ]);

    const answer = await ask(context, "経費精算の締め日は?");

    expect(answer.outcome).toBe("error");
    expect(context.harness.answerRuns().at(-1)?.failureReason).toBe("llm_max_tokens");
    expect(
      context.harness.toolInvocations(answer.runId).filter((record) => record.tool === "search"),
    ).toEqual([]);
  });

  it("テキストだけで終えたら1回だけ催促し(user メッセージ)、提出されれば回答にする", async () => {
    const context = await setup({ connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])] }, [
      () => openAiText("締め日は25日だと思います。"),
      (script) => {
        if (!script.lastUserTexts.some((text) => text.startsWith("[オーケストレーター]"))) {
          throw new Error("the nudge must arrive as a user message");
        }
        return openAiSubmit({ answer: "不明です。", citations: [], confidence: 0.1 });
      },
    ]);

    const answer = await ask(context, "経費精算の締め日は?");

    expect(context.mock.scriptErrors).toEqual([]);
    expect(answer.outcome).toBe("unresolved");
    const roles = wireMessages(context.mock, 1).map((message) => message.role);
    expect(roles).toEqual(["system", "user", "assistant", "user"]);
  });

  it("429 は Retry-After に従って再試行し、続けて成功すれば回答する", async () => {
    const context = await setup(
      { connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])] },
      [
        () => openAiError(429, { headers: { "retry-after": "0" } }),
        () => openAiSubmit({ answer: "不明です。", citations: [], confidence: 0 }),
      ],
      { maxRetries: 1 },
    );

    const answer = await ask(context, "経費精算の締め日は?");

    expect(context.mock.scriptErrors).toEqual([]);
    expect(context.mock.requests).toHaveLength(2);
    expect(answer.outcome).toBe("unresolved");
    expect(answer.usage.llmTurns).toBe(1);
  });

  it("apiKeyEnv 指定時だけ Authorization: Bearer を送り、reasoning_effort・追加ヘッダを付ける", async () => {
    const context = await setup(
      { connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])] },
      [() => openAiSubmit({ answer: "不明です。", citations: [], confidence: 0 })],
      {
        apiKeyEnv: "KP_TEST_LLM_API_KEY",
        reasoningEffort: "low",
        extraHeaders: { "x-kp-route": "dev-only-route" },
      },
      { env: { KP_TEST_LLM_API_KEY: "dev-only-key" } },
    );

    await ask(context, "経費精算の締め日は?");

    const request = context.mock.requests[0];
    expect(request?.hasAuthorization).toBe(true);
    expect(request?.authorizationScheme).toBe("Bearer");
    expect(request?.headerNames).toContain("x-kp-route");
    expect(request?.body["reasoning_effort"]).toBe("low");
  });

  it("キー不要のつもりで接続したサーバーが 401 を返したら error(llm_credentials_missing)", async () => {
    const context = await setup({ connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])] }, [
      () => openAiError(401),
    ]);

    const answer = await ask(context, "経費精算の締め日は?");

    expect(answer.outcome).toBe("error");
    expect(context.harness.answerRuns().at(-1)?.failureReason).toBe("llm_credentials_missing");
  });
});

describe("kp-ask(OpenAI 互換、モック)", () => {
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) },
    };
  }

  function deps(env: Readonly<Record<string, string>>): CliDependencies {
    return {
      env,
      createLlmClient: (config) => createLlmClient(config),
      createGatewayClient: (options) => new McpGatewayClient(options),
    };
  }

  function resolvingScript(): OpenAiMockStep[] {
    return [
      () => openAiToolCalls([{ name: "search", input: { source: "alpha", query: "締め日" } }]),
      (script) => {
        const hit = firstHit(script);
        return openAiSubmit({
          answer: "経費精算の締め日は毎月25日です。",
          citations: [{ documentId: hit.documentId, sourceId: hit.source }],
          confidence: 0.9,
        });
      },
    ];
  }

  it("--llm openai-compatible --llm-base-url --model で回答する(README の LM Studio 手順と同じ形)", async () => {
    const { harness, mock } = await startServers(
      { connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])] },
      resolvingScript(),
    );
    const { out, io } = capture();

    const code = await runCli(
      [
        "--gateway", harness.url, "--user-id", "alice",
        "--llm", "openai-compatible", "--llm-base-url", mock.baseUrl, "--model", MODEL,
        "経費精算の締め日は?",
      ],
      io,
      deps({ KP_SESSION_TOKEN: ALICE_TOKEN }),
    );

    expect(mock.scriptErrors).toEqual([]);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("経費精算の締め日は毎月25日です。");
    expect(mock.requests[0]?.body["model"]).toBe(MODEL);
  });

  it("環境変数 KP_LLM_PROVIDER / KP_LLM_BASE_URL / KP_LLM_MODEL でも指定できる", async () => {
    const { harness, mock } = await startServers(
      { connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])] },
      resolvingScript(),
    );
    const { io } = capture();

    const code = await runCli(
      ["--gateway", harness.url, "--user-id", "alice", "--json", "経費精算の締め日は?"],
      io,
      deps({
        KP_SESSION_TOKEN: ALICE_TOKEN,
        KP_LLM_PROVIDER: "openai-compatible",
        KP_LLM_BASE_URL: mock.baseUrl,
        KP_LLM_MODEL: MODEL,
      }),
    );

    expect(code).toBe(0);
    expect(mock.requests).toHaveLength(2);
  });

  it("サーバーが資格情報を要求(401)したら OpenAI 互換向けの案内を出して終了コード 2", async () => {
    const { harness, mock } = await startServers(
      { connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])] },
      [() => openAiError(401)],
    );
    const { out, err, io } = capture();

    const code = await runCli(
      [
        "--gateway", harness.url, "--user-id", "alice",
        "--llm", "openai-compatible", "--llm-base-url", mock.baseUrl, "--model", MODEL,
        "経費精算の締め日は?",
      ],
      io,
      deps({ KP_SESSION_TOKEN: ALICE_TOKEN }),
    );

    expect(code).toBe(2);
    expect(err).toContain(OPENAI_COMPATIBLE_CREDENTIALS_REQUIRED_MESSAGE);
    expect(out).toEqual([]);
    expect([...out, ...err].join("\n")).not.toContain(ALICE_TOKEN);
  });
});
