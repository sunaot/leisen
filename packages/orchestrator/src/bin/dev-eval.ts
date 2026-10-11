#!/usr/bin/env node
/**
 * dev-eval — 合成コーパスに対する質問セットを kp-ask で流し、判定と計測値を Markdown の表にする
 * (開発用の簡易評価。T-008 の前段。判定・集計は src/dev-eval.ts)。
 *
 *   node packages/orchestrator/dist/bin/dev-eval.js \
 *     [--questions examples/eval/dev-questions.json] [--repeat N] [--only id1,id2] \
 *     [--label <表の見出し>] [--timeout-sec 300] -- <kp-ask に渡す引数...>
 *
 * - `--` 以降はそのまま kp-ask に渡す(--gateway / --config / --llm / --model 等)。dev-eval は
 *   `--json` と質問文を足す。トークン・LLM の設定は kp-ask と同じく環境変数で渡す
 *   (KP_SESSION_TOKEN、KP_LLM_*、KP_ORCHESTRATOR_CREDENTIAL 等。dev-eval は値を読まない・表示しない)
 * - 質問は1問ずつ順に流す(ローカル推論を並行に叩かない)。進捗は stderr、表は stdout
 * - kp-ask の stderr(AnswerRun の監査レコードと案内)は、kp-ask が回答を返せなかったときだけ
 *   そのまま stderr に流す。run の記録(AnswerRun)は Gateway の監査ログに残る(ADR-019)
 * - 終了コード: 0 全問合格、1 不合格・エラーあり、2 引数・質問セットの不備
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  devEvalQuestionSetSchema,
  formatReport,
  judgeRun,
  type DevEvalQuestion,
  type DevEvalRawRun,
  type DevEvalResult,
} from "../dev-eval.js";
import { EXPLORE_PROMPT_VERSION } from "../prompt.js";

const DEFAULT_QUESTIONS = fileURLToPath(
  new URL("../../../../examples/eval/dev-questions.json", import.meta.url),
);
const DEFAULT_KP_ASK = fileURLToPath(new URL("./kp-ask.js", import.meta.url));
const DEFAULT_TIMEOUT_SEC = 300;

const USAGE = `usage: dev-eval [--questions <file>] [--repeat N] [--only id1,id2] [--label <見出し>]
                [--timeout-sec N] -- <kp-ask に渡す引数...>
  例: dev-eval -- --gateway http://127.0.0.1:8787/mcp --config examples/deployment.dev.yaml \\
                 --llm openai-compatible --llm-base-url http://localhost:1234/v1 --model <モデル名>
  トークン・LLM の設定は kp-ask と同じ環境変数で渡す(KP_SESSION_TOKEN、KP_LLM_* 等)。`;

export interface DevEvalIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

/** kp-ask を1回起動して結果を集める(テストでは差し替える)。 */
export type KpAskRunner = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>;

export function spawnKpAsk(kpAskPath: string): KpAskRunner {
  return (args, timeoutMs) =>
    new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [kpAskPath, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      let killTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        // SIGTERM で止まらなければ強制終了する
        killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      }, timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        reject(error);
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        resolvePromise({ exitCode, stdout, stderr, timedOut });
      });
    });
}

interface ParsedArgs {
  readonly questionsPath: string;
  readonly repeat: number;
  readonly only?: ReadonlySet<string>;
  readonly label?: string;
  readonly timeoutMs: number;
  readonly kpAskArgs: readonly string[];
}

function parseCliArgs(argv: readonly string[]): ParsedArgs | string {
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const kpAskArgs = separator === -1 ? [] : argv.slice(separator + 1);
  let values;
  try {
    ({ values } = parseArgs({
      args: [...own],
      options: {
        questions: { type: "string" },
        repeat: { type: "string" },
        only: { type: "string" },
        label: { type: "string" },
        "timeout-sec": { type: "string" },
        help: { type: "boolean" },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch {
    return "引数を解釈できません。";
  }
  if (values.help === true) {
    return "";
  }
  const positiveInt = (raw: string | undefined, fallback: number, max: number) => {
    if (raw === undefined) {
      return fallback;
    }
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= max ? n : undefined;
  };
  const repeat = positiveInt(values.repeat, 1, 20);
  if (repeat === undefined) {
    return "--repeat は 1〜20 の整数で指定してください。";
  }
  const timeoutSec = positiveInt(values["timeout-sec"], DEFAULT_TIMEOUT_SEC, 3600);
  if (timeoutSec === undefined) {
    return "--timeout-sec は 1〜3600 の整数で指定してください。";
  }
  if (kpAskArgs.length === 0) {
    return "`--` のあとに kp-ask に渡す引数(--gateway など)を指定してください。";
  }
  if (kpAskArgs.includes("--json")) {
    return "--json は dev-eval が付けるので、`--` 以降には指定しないでください。";
  }
  const only =
    values.only === undefined
      ? undefined
      : new Set(values.only.split(",").map((s) => s.trim()).filter((s) => s.length > 0));
  return {
    questionsPath: values.questions === undefined ? DEFAULT_QUESTIONS : resolve(values.questions),
    repeat,
    ...(only === undefined ? {} : { only }),
    ...(values.label === undefined ? {} : { label: values.label }),
    timeoutMs: timeoutSec * 1000,
    kpAskArgs,
  };
}

async function loadQuestions(path: string): Promise<readonly DevEvalQuestion[] | string> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return `質問セットを読めません: ${path}`;
  }
  const parsed = devEvalQuestionSetSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return `質問セットが不正です(${first?.path.join(".") ?? ""}: ${first?.message ?? ""}): ${path}`;
  }
  return parsed.data.questions;
}

export async function runDevEval(
  argv: readonly string[],
  io: DevEvalIo,
  runner: KpAskRunner = spawnKpAsk(DEFAULT_KP_ASK),
  now: () => number = () => performance.now(),
): Promise<number> {
  const args = parseCliArgs(argv);
  if (typeof args === "string") {
    if (args.length > 0) {
      io.stderr(args);
    }
    io.stderr(USAGE);
    return args.length > 0 ? 2 : 0;
  }
  const loaded = await loadQuestions(args.questionsPath);
  if (typeof loaded === "string") {
    io.stderr(loaded);
    return 2;
  }
  const questions =
    args.only === undefined ? loaded : loaded.filter((q) => args.only?.has(q.id) === true);
  if (questions.length === 0) {
    io.stderr("--only に一致する質問がありません。");
    return 2;
  }
  const results: DevEvalResult[] = [];
  const total = questions.length * args.repeat;
  let index = 0;
  for (let attempt = 1; attempt <= args.repeat; attempt += 1) {
    for (const question of questions) {
      index += 1;
      io.stderr(`[${index}/${total}] ${question.id}(${attempt} 回目)…`);
      const started = now();
      const run = await runner([...args.kpAskArgs, "--json", question.question], args.timeoutMs);
      const raw: DevEvalRawRun = {
        question,
        attempt,
        exitCode: run.exitCode,
        stdout: run.stdout,
        elapsedMs: now() - started,
        timedOut: run.timedOut,
      };
      const result = judgeRun(raw);
      results.push(result);
      io.stderr(
        `[${index}/${total}] ${question.id}: ${result.verdict}(${(result.elapsedMs / 1000).toFixed(1)} 秒)` +
          (result.reasons.length === 0 ? "" : ` — ${result.reasons.join("; ")}`),
      );
      if (result.verdict === "error" && run.stderr.length > 0) {
        io.stderr(run.stderr.trimEnd());
      }
    }
  }
  io.stdout(
    formatReport(results, {
      promptVersion: EXPLORE_PROMPT_VERSION,
      ...(args.label === undefined ? {} : { label: args.label }),
    }),
  );
  return results.every((r) => r.verdict === "pass") ? 0 : 1;
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
  process.exitCode = await runDevEval(process.argv.slice(2), {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  }).catch((error: unknown) => {
    process.stderr.write(
      `dev-eval: unexpected error (${error instanceof Error ? error.name : typeof error})\n`,
    );
    return 1;
  });
}

