#!/usr/bin/env node
/**
 * dev-search-eval — 検索方式の比較実験(dev-eval の検索方式モード。合成コーパス専用の開発用の道具)。
 *
 *   node packages/orchestrator/dist/bin/dev-search-eval.js \
 *     [--questions examples/eval/search-questions.json] [--modes default,esa,redmine-or,redmine-and,github] \
 *     [--conditions keywords,utterance] [--k 1,5,10] [--repeat N] [--only id1,id2] \
 *     [--trace trace.jsonl] [--label <見出し>] \
 *     [--llm ... --model ... --llm-base-url ...] [--ui-model <モデル>] [--max-iterations N] [--run-timeout-sec N]
 *
 * - 検索方式ごとにプロセス内の Gateway(開発用コネクタ dev-fixture、モック IdP、監査はメモリ)を
 *   起動し、質問 × 条件を実行して recall@k・最初の正解の順位・fetch / 引用の割合を Markdown の表に
 *   する(stdout)。進捗は stderr
 * - 条件: keywords(1: 人が書いたキーワードを search に直接)/ utterance(2: 発言をそのまま search に)/
 *   orchestrator-utterance(3: 発言を探索 LLM に)/ orchestrator-ui(4: UI 側 LLM が作った question を
 *   探索 LLM に)。1・2 は LLM なしで動く。3・4 は LLM の指定(leisen-ask と同じフラグ・環境変数)が要る
 * - --trace: 試行ごとの search のクエリ・ヒット・fetch・出典を JSONL に書く(合成コーパスだけが対象)
 * - --llm claude-cli: 条件 3・4 の LLM に `claude -p`(Claude Code の CLI の非対話モード)を使う
 *   (search-eval/claude-cli-llm.ts。構造化出力によるツール呼び出しの模擬で、ネイティブのツール
 *   呼び出しではない。dev-search-eval の中だけで選べ、NODE_ENV=production では拒否する)。
 *   --model は必須。費用と所要時間の合計を表の注記と stderr に出す
 * - --explore-prompt / --search-feedback: 探索プロンプトの版と検索の状況の制御メッセージ
 *   (leisen-ask と同じ。NODE_ENV=production では拒否する)。--limit N: 質問を先頭の N 問に絞る
 * - 外部の Gateway・実ソースには接続しない(接続先を指定する引数がない)
 * - 終了コード: 0 実行できた、1 実行中の失敗、2 引数・質問セットの不備
 */
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { LlmBackendConfigInput } from "../config.js";
import { createLlmClient } from "../llm/factory.js";
import type { LlmClient } from "../llm/types.js";
import { Orchestrator } from "../orchestrator.js";
import {
  EXPLORE_PROMPT_VERSIONS,
  isExplorePromptVersion,
  type ExplorePromptVersion,
} from "../prompt.js";
import {
  ClaudeCliLlmClient,
  type ClaudeCliLlmClientOptions,
} from "../search-eval/claude-cli-llm.js";
import {
  DEFAULT_RECALL_KS,
  JsonlTraceSink,
  SEARCH_EVAL_CONDITIONS,
  SEARCH_EVAL_MODES,
  checkQuestionsAgainstCorpus,
  formatMetricsReport,
  loadSearchEvalCorpus,
  runSearchEval,
  searchEvalQuestionSetSchema,
  startEvalGateway,
  type CaseMetrics,
  type SearchEvalCondition,
  type SearchEvalMode,
  type TraceSink,
} from "../search-eval/index.js";
import { LLM_USAGE_LINES, parseLlmCliOptions } from "./llm-options.js";

const DEFAULT_QUESTIONS = fileURLToPath(
  new URL("../../../../examples/eval/search-questions.json", import.meta.url),
);

const USAGE = [
  "usage: dev-search-eval [--questions <file>] [--modes default,esa,redmine-or,redmine-and,github]",
  "                       [--conditions keywords,utterance,orchestrator-utterance,orchestrator-ui]",
  "                       [--k 1,5,10] [--repeat N] [--only id1,id2] [--trace <file.jsonl>] [--label <見出し>]",
  "                       [--limit N] [--explore-prompt explore.v3|explore.v4] [--search-feedback on|off]",
  "                       [--ui-model <モデル>] [--max-iterations N] [--run-timeout-sec N] [LLM の指定]",
  "  --llm claude-cli --model <モデル> は条件 3・4 の LLM に `claude -p` を使う(開発・評価専用。構造化出力による",
  "  ツール呼び出しの模擬)。[--claude-cli-command <コマンド>] [--claude-cli-timeout-sec N] [--claude-cli-max-total-usd X]",
  "  条件 3・4(orchestrator-*)には LLM の指定が要る(leisen-ask と同じ)。--ui-model は条件 4 の UI 側の",
  "  モデル(省略時は探索 LLM と同じ)。",
  ...LLM_USAGE_LINES,
].join("\n");

export interface DevSearchEvalIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export interface DevSearchEvalDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly createLlmClient: (config: LlmBackendConfigInput) => LlmClient;
  /** --llm claude-cli のクライアント(テストで差し替える) */
  readonly createClaudeCliClient?: (options: ClaudeCliLlmClientOptions) => ClaudeCliLlmClient;
}

const defaultDependencies: DevSearchEvalDependencies = {
  env: process.env,
  createLlmClient: (config) => createLlmClient(config),
};

function positiveNumber(raw: string | undefined): number | undefined | null {
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function listOf<T extends string>(raw: string | undefined, allowed: readonly T[], fallback: readonly T[]): T[] | undefined {
  if (raw === undefined) {
    return [...fallback];
  }
  const items = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (items.length === 0 || !items.every((item) => (allowed as readonly string[]).includes(item))) {
    return undefined;
  }
  return [...new Set(items)] as T[];
}

function intIn(raw: string | undefined, min: number, max: number): number | undefined | null {
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

export async function runDevSearchEval(
  argv: readonly string[],
  io: DevSearchEvalIo,
  deps: DevSearchEvalDependencies = defaultDependencies,
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        questions: { type: "string" },
        modes: { type: "string" },
        conditions: { type: "string" },
        k: { type: "string" },
        repeat: { type: "string" },
        only: { type: "string" },
        trace: { type: "string" },
        label: { type: "string" },
        "ui-model": { type: "string" },
        "max-iterations": { type: "string" },
        "run-timeout-sec": { type: "string" },
        llm: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        "llm-base-url": { type: "string" },
        "llm-api-key-env": { type: "string" },
        "reasoning-effort": { type: "string" },
        limit: { type: "string" },
        "explore-prompt": { type: "string" },
        "search-feedback": { type: "string" },
        "claude-cli-command": { type: "string" },
        "claude-cli-timeout-sec": { type: "string" },
        "claude-cli-max-total-usd": { type: "string" },
        help: { type: "boolean" },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch {
    io.stderr("引数を解釈できません。");
    io.stderr(USAGE);
    return 2;
  }
  if (values.help === true) {
    io.stderr(USAGE);
    return 0;
  }
  const usage = (message: string) => {
    io.stderr(message);
    io.stderr(USAGE);
    return 2;
  };
  const modes = listOf<SearchEvalMode>(values.modes, SEARCH_EVAL_MODES, SEARCH_EVAL_MODES);
  if (modes === undefined) {
    return usage(`--modes は ${SEARCH_EVAL_MODES.join(" / ")} をカンマ区切りで指定してください。`);
  }
  const conditions = listOf<SearchEvalCondition>(values.conditions, SEARCH_EVAL_CONDITIONS, [
    "keywords",
    "utterance",
  ]);
  if (conditions === undefined) {
    return usage(`--conditions は ${SEARCH_EVAL_CONDITIONS.join(" / ")} をカンマ区切りで指定してください。`);
  }
  let ks: number[] = [...DEFAULT_RECALL_KS];
  if (values.k !== undefined) {
    const parsed = values.k.split(",").map((s) => Number(s.trim()));
    if (parsed.length === 0 || !parsed.every((n) => Number.isInteger(n) && n >= 1 && n <= 50)) {
      return usage("--k は 1〜50 の整数をカンマ区切りで指定してください。");
    }
    ks = [...new Set(parsed)].sort((a, b) => a - b);
  }
  const repeat = intIn(values.repeat, 1, 20);
  if (repeat === null) {
    return usage("--repeat は 1〜20 の整数で指定してください。");
  }
  const maxIterations = intIn(values["max-iterations"], 1, 20);
  if (maxIterations === null) {
    return usage("--max-iterations は 1〜20 の整数で指定してください。");
  }
  const runTimeoutSec = intIn(values["run-timeout-sec"], 1, 3_600);
  if (runTimeoutSec === null) {
    return usage("--run-timeout-sec は 1〜3600 の整数で指定してください。");
  }

  const limit = intIn(values.limit, 1, 10_000);
  if (limit === null) {
    return usage("--limit は 1 以上の整数で指定してください。");
  }
  const production = deps.env["NODE_ENV"] === "production";
  // 探索プロンプトの版と検索の状況の制御メッセージ(開発・評価用。leisen-ask と同じ規則)
  const promptOption = values["explore-prompt"];
  const feedbackOption = values["search-feedback"];
  if ((promptOption !== undefined || feedbackOption !== undefined) && production) {
    return usage("--explore-prompt / --search-feedback は開発・評価用のため、NODE_ENV=production では使えません。");
  }
  let explorePrompt: ExplorePromptVersion | undefined;
  if (promptOption !== undefined) {
    if (!isExplorePromptVersion(promptOption)) {
      return usage(`--explore-prompt は ${EXPLORE_PROMPT_VERSIONS.join(" / ")} のいずれかで指定してください。`);
    }
    explorePrompt = promptOption;
  }
  let searchFeedback: boolean | undefined;
  if (feedbackOption !== undefined) {
    if (feedbackOption !== "on" && feedbackOption !== "off") {
      return usage("--search-feedback は on / off で指定してください。");
    }
    searchFeedback = feedbackOption === "on";
  }
  const claudeCli = values.llm === "claude-cli";
  const claudeCliOnly = [
    values["claude-cli-command"],
    values["claude-cli-timeout-sec"],
    values["claude-cli-max-total-usd"],
  ].some((v) => v !== undefined);
  if (claudeCliOnly && !claudeCli) {
    return usage("--claude-cli-* は --llm claude-cli のときだけ指定できます。");
  }
  const cliTimeoutSec = intIn(values["claude-cli-timeout-sec"], 1, 3_600);
  if (cliTimeoutSec === null) {
    return usage("--claude-cli-timeout-sec は 1〜3600 の整数で指定してください。");
  }
  const cliMaxTotalUsd = positiveNumber(values["claude-cli-max-total-usd"]);
  if (cliMaxTotalUsd === null) {
    return usage("--claude-cli-max-total-usd は正の数で指定してください。");
  }

  // 条件 3・4 のときだけ LLM を組む
  const needsLlm = conditions.some((c) => c === "orchestrator-utterance" || c === "orchestrator-ui");
  let orchestrator: Orchestrator | undefined;
  let uiLlm: LlmClient | undefined;
  /** claude -p のクライアント(探索 LLM と、別モデルなら UI 側 LLM) */
  const cliClients: ClaudeCliLlmClient[] = [];
  if (needsLlm) {
    let explore: LlmClient;
    let makeUi: (model: string) => LlmClient;
    if (claudeCli) {
      // 開発・評価専用(本番の経路・LLM バックエンドの選択肢には入れない)
      if (production) {
        return usage("--llm claude-cli は開発・評価用のため、NODE_ENV=production では使えません。");
      }
      const model = values.model;
      if (model === undefined || model.trim() === "") {
        return usage("--llm claude-cli には --model(claude の --model に渡す値)の指定が必要です。");
      }
      if (
        values["llm-base-url"] !== undefined ||
        values["llm-api-key-env"] !== undefined ||
        values["reasoning-effort"] !== undefined ||
        values.effort !== undefined
      ) {
        return usage("--llm claude-cli では --llm-base-url / --llm-api-key-env / --reasoning-effort / --effort は使えません。");
      }
      const create = deps.createClaudeCliClient ?? ((options) => new ClaudeCliLlmClient(options));
      const cliOptions = (m: string): ClaudeCliLlmClientOptions => ({
        model: m,
        env: deps.env,
        ...(values["claude-cli-command"] !== undefined ? { command: values["claude-cli-command"] } : {}),
        ...(cliTimeoutSec !== undefined ? { timeoutMs: cliTimeoutSec * 1000 } : {}),
        ...(cliMaxTotalUsd !== undefined ? { maxTotalCostUsd: cliMaxTotalUsd } : {}),
      });
      try {
        const client = create(cliOptions(model));
        cliClients.push(client);
        explore = client;
        makeUi = (m) => {
          const ui = create(cliOptions(m));
          cliClients.push(ui);
          return ui;
        };
      } catch {
        return usage("claude -p のクライアントを用意できませんでした。");
      }
    } else {
      const llm = parseLlmCliOptions(values, deps.env);
      if (!llm.ok) {
        return usage(llm.message);
      }
      try {
        explore = deps.createLlmClient(llm.config);
      } catch {
        return usage("LLM の設定が不正です。");
      }
      const config = llm.config;
      makeUi = (m) => deps.createLlmClient({ ...config, model: m } as LlmBackendConfigInput);
    }
    try {
      orchestrator = new Orchestrator({
        llm: explore,
        settings: {
          ...(maxIterations !== undefined ? { maxIterations } : {}),
          ...(runTimeoutSec !== undefined ? { runTimeoutMs: runTimeoutSec * 1000 } : {}),
          ...(explorePrompt !== undefined ? { explorePrompt } : {}),
          ...(searchFeedback !== undefined ? { searchFeedback } : {}),
        },
      });
      const uiModel = values["ui-model"];
      uiLlm = uiModel === undefined ? explore : makeUi(uiModel);
    } catch {
      closeAll(cliClients);
      return usage("LLM の設定が不正です。");
    }
  } else if (values["ui-model"] !== undefined) {
    return usage("--ui-model は条件 orchestrator-ui を含めるときだけ指定できます。");
  } else if (claudeCli || promptOption !== undefined || feedbackOption !== undefined) {
    return usage("--llm claude-cli / --explore-prompt / --search-feedback は条件 3・4 を含めるときだけ指定できます。");
  }
  // 以下の早期の return を含め、終わったら claude -p の一時ディレクトリを消す
  try {
    const questionsPath = values.questions === undefined ? DEFAULT_QUESTIONS : resolve(values.questions);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(questionsPath, "utf8"));
    } catch {
      io.stderr(`質問セットを読めません: ${questionsPath}`);
      return 2;
    }
    const parsedSet = searchEvalQuestionSetSchema.safeParse(raw);
    if (!parsedSet.success) {
      const first = parsedSet.error.issues[0];
      io.stderr(`質問セットが不正です(${first?.path.join(".") ?? ""}: ${first?.message ?? ""}): ${questionsPath}`);
      return 2;
    }
    const set = parsedSet.data;
    let documents;
    try {
      documents = await loadSearchEvalCorpus(questionsPath, set);
    } catch {
      io.stderr(`質問セットのコーパスを読めません: ${questionsPath}`);
      return 2;
    }
    const issues = checkQuestionsAgainstCorpus(set, documents);
    if (issues.length > 0) {
      for (const issue of issues) {
        io.stderr(`質問セットとコーパスが合いません(${issue.questionId}): ${issue.message}`);
      }
      return 2;
    }
    const only =
      values.only === undefined
        ? undefined
        : new Set(values.only.split(",").map((s) => s.trim()).filter((s) => s !== ""));
    const matched = only === undefined ? set.questions : set.questions.filter((q) => only.has(q.id));
    if (matched.length === 0) {
      io.stderr("--only に一致する質問がありません。");
      return 2;
    }
    const questions = limit === undefined ? matched : matched.slice(0, limit);
    let sink: TraceSink = { write: () => {} };
    if (values.trace !== undefined) {
      try {
        sink = new JsonlTraceSink(resolve(values.trace));
      } catch {
        io.stderr(`トレースのファイルに書けません: ${values.trace}`);
        return 2;
      }
    }

    const results: CaseMetrics[] = [];
    for (const mode of modes) {
      let gateway;
      try {
        gateway = await startEvalGateway({ sourceId: set.source, documents, mode });
      } catch {
        io.stderr(`評価用の Gateway を起動できませんでした(${mode})。NODE_ENV=production では使えません。`);
        return 1;
      }
      try {
        results.push(
          ...(await runSearchEval({
            mode,
            source: set.source,
            questions,
            conditions,
            gateway: gateway.client,
            sink,
            ks,
            ...(repeat !== undefined ? { repeat } : {}),
            ...(orchestrator !== undefined ? { orchestrator } : {}),
            ...(uiLlm !== undefined ? { uiLlm } : {}),
            ...(cliClients.length > 0 ? { llmUsage: () => cliUsageSnapshot(cliClients) } : {}),
            onProgress: (message) => io.stderr(message),
          })),
        );
      } finally {
        await gateway.close();
      }
    }
    const notes: string[] = [];
    if (orchestrator !== undefined) {
      const profile = orchestrator.promptProfile;
      notes.push(`探索プロンプト ${profile.version}、検索の状況の制御メッセージ ${profile.searchFeedback ? "有効" : "無効"}`);
    }
    if (cliClients.length > 0) {
      const models = [...new Set(cliClients.map((c) => c.model))].join(", ");
      notes.push(
        `LLM は claude -p(--model ${models})。構造化出力(--json-schema)によるツール呼び出しの模擬で、ネイティブのツール呼び出しではない。Anthropic API のバックエンドとは挙動が違いうる`,
      );
      const summary = cliUsageSummary(cliClients);
      notes.push(summary);
      io.stderr(summary);
    }
    io.stdout(
      formatMetricsReport(results, {
        corpusSize: documents.length,
        ks,
        ...(values.label !== undefined ? { label: values.label } : {}),
        notes,
      }),
    );
    return 0;
  } finally {
    closeAll(cliClients);
  }
}

function closeAll(clients: readonly ClaudeCliLlmClient[]): void {
  for (const client of clients) {
    try {
      client.close();
    } catch {
      // 一時ディレクトリの削除の失敗は無視する
    }
  }
}

function cliUsageSnapshot(clients: readonly ClaudeCliLlmClient[]) {
  const totals = clients.map((c) => c.usageTotals());
  const failures: Record<string, number> = {};
  for (const t of totals) {
    for (const [k, v] of Object.entries(t.failures)) {
      failures[k] = (failures[k] ?? 0) + v;
    }
  }
  return {
    calls: totals.reduce((a, t) => a + t.calls, 0),
    costUsd: totals.reduce((a, t) => a + t.costUsd, 0),
    durationMs: totals.reduce((a, t) => a + t.durationMs, 0),
    failures,
  };
}

function cliUsageSummary(clients: readonly ClaudeCliLlmClient[]): string {
  const totals = clients.map((c) => c.usageTotals());
  const calls = totals.reduce((a, t) => a + t.calls, 0);
  const failed = totals.reduce((a, t) => a + t.failedCalls, 0);
  const unknown = totals.reduce((a, t) => a + t.costUnknownCalls, 0);
  const cost = totals.reduce((a, t) => a + t.costUsd, 0);
  const seconds = totals.reduce((a, t) => a + t.durationMs, 0) / 1000;
  const failures: Record<string, number> = {};
  for (const t of totals) {
    for (const [k, v] of Object.entries(t.failures)) {
      failures[k] = (failures[k] ?? 0) + v;
    }
  }
  const failureText = Object.entries(failures)
    .map(([k, v]) => `${k} ${String(v)}`)
    .join("、");
  return (
    `claude -p の呼び出し ${String(calls)} 回(失敗 ${String(failed)}${failureText === "" ? "" : `: ${failureText}`})、` +
    `費用の合計 $${cost.toFixed(4)}(total_cost_usd の合計${unknown > 0 ? `。読めなかった呼び出し ${String(unknown)} 回は含まない` : ""})、` +
    `所要時間の合計 ${seconds.toFixed(1)} 秒(子プロセスの実時間の合計)、` +
    `CLI の内部で 3 ターン以上かかった呼び出し ${String(totals.reduce((a, t) => a + t.extraTurnCalls, 0))} 回`
  );
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = await runDevSearchEval(process.argv.slice(2), {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  }).catch((error: unknown) => {
    process.stderr.write(
      `dev-search-eval: unexpected error (${error instanceof Error ? error.name : typeof error})\n`,
    );
    return 1;
  });
}
