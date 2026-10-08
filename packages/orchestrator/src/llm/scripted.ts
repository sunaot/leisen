/**
 * 脚本で応答を返す LlmClient(テスト・評価用、T-007)。ネットワークに出ない。
 *
 * 脚本は「直前のツール結果を見て次の応答を決める」関数の配列、または全ターン共通の
 * 関数で与える。各ステップは受け取った要求(system / messages / tools)と、直前の
 * user ターンのツール結果(パース済み)を見て LlmTurn を返す。シナリオテストの
 * 再現性のため、応答の ID は連番で決定的に振る。
 *
 * 中断(LlmCallOptions.signal)に従う: ステップが返す Promise の完了より先に
 * シグナルが中断されれば LlmError("llm_aborted") で失敗する(run の時間上限の再現用)。
 *
 * provider / capabilities は既定で Anthropic と同じ。オプションで差し替えると、能力の
 * 違うバックエンド(OpenAI 互換など)に対する Orchestrator の要求の組み方・価格表の
 * 引き当てを、ネットワークなしで検証できる。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { LlmError } from "../errors.js";
import { ANTHROPIC_CAPABILITIES } from "./capabilities.js";
import type {
  LlmCallOptions,
  LlmCapabilities,
  LlmClient,
  LlmProvider,
  LlmRequest,
  LlmTurn,
} from "./types.js";

/** 直前の user ターンに含まれていたツール結果1件。 */
export interface ScriptToolResult {
  readonly toolUseId: string;
  /** 対応する tool_use のツール名(履歴から引けない場合は undefined) */
  readonly toolName: string | undefined;
  /** 対応する tool_use の入力 */
  readonly toolInput: unknown;
  readonly isError: boolean;
  /** 本文(最後のテキストブロック。成功時はデータ本体の JSON) */
  readonly text: string;
  /** text を JSON として読めた場合の値 */
  readonly json: unknown;
}

export interface ScriptContext {
  readonly request: LlmRequest;
  /** 0始まりの呼び出し番号 */
  readonly turnIndex: number;
  /** 直前の user ターンのツール結果(ツール結果がなければ空) */
  readonly lastToolResults: readonly ScriptToolResult[];
  /** 直前の user ターンのテキストブロック(オーケストレーターの制御メッセージ等) */
  readonly lastUserTexts: readonly string[];
  readonly signal: AbortSignal | undefined;
}

export type ScriptStep = (context: ScriptContext) => LlmTurn | Promise<LlmTurn>;

export interface ScriptedLlmClientOptions {
  /** 名乗るバックエンドの種類(価格表の引き当てに使われる)。既定 anthropic */
  readonly provider?: LlmProvider;
  /** 能力フラグの上書き(既定は ANTHROPIC_CAPABILITIES) */
  readonly capabilities?: Partial<LlmCapabilities>;
}

export class ScriptedLlmClient implements LlmClient {
  readonly provider: LlmProvider;
  readonly capabilities: LlmCapabilities;
  /** 受け取った要求の記録(アサーション用) */
  readonly requests: LlmRequest[] = [];
  private readonly steps: readonly ScriptStep[] | ScriptStep;

  constructor(
    script: readonly ScriptStep[] | ScriptStep,
    options: ScriptedLlmClientOptions = {},
  ) {
    this.steps = script;
    this.provider = options.provider ?? "anthropic";
    this.capabilities = Object.freeze({
      ...ANTHROPIC_CAPABILITIES,
      ...options.capabilities,
    });
  }

  async complete(
    request: LlmRequest,
    options: LlmCallOptions = {},
  ): Promise<LlmTurn> {
    const turnIndex = this.requests.length;
    this.requests.push(request);
    const step =
      typeof this.steps === "function" ? this.steps : this.steps[turnIndex];
    if (step === undefined) {
      throw new Error(
        `ScriptedLlmClient: script exhausted at turn ${turnIndex} (the loop requested more turns than scripted)`,
      );
    }
    const signal = options.signal;
    if (signal?.aborted === true) {
      throw new LlmError("llm_aborted", "scripted turn aborted");
    }
    const context: ScriptContext = {
      request,
      turnIndex,
      ...lastUserTurn(request.messages),
      signal,
    };
    const work = Promise.resolve().then(() => step(context));
    if (signal === undefined) {
      return work;
    }
    return new Promise<LlmTurn>((resolve, reject) => {
      const onAbort = () =>
        reject(new LlmError("llm_aborted", "scripted turn aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      work.then(
        (turn) => {
          signal.removeEventListener("abort", onAbort);
          resolve(turn);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }
}

function lastUserTurn(messages: readonly Anthropic.MessageParam[]): {
  lastToolResults: ScriptToolResult[];
  lastUserTexts: string[];
} {
  const last = messages.at(-1);
  if (last === undefined || last.role !== "user") {
    return { lastToolResults: [], lastUserTexts: [] };
  }
  if (typeof last.content === "string") {
    return { lastToolResults: [], lastUserTexts: [last.content] };
  }
  // tool_use_id → tool_use(直前の assistant ターンから引く)
  const toolUses = new Map<string, Anthropic.ToolUseBlockParam>();
  for (const message of messages) {
    if (message.role === "assistant" && typeof message.content !== "string") {
      for (const block of message.content) {
        if (block.type === "tool_use") {
          toolUses.set(block.id, block);
        }
      }
    }
  }
  const lastToolResults: ScriptToolResult[] = [];
  const lastUserTexts: string[] = [];
  for (const block of last.content) {
    if (block.type === "text") {
      lastUserTexts.push(block.text);
    } else if (block.type === "tool_result") {
      const text = toolResultText(block);
      const use = toolUses.get(block.tool_use_id);
      lastToolResults.push({
        toolUseId: block.tool_use_id,
        toolName: use?.name,
        toolInput: use?.input,
        isError: block.is_error === true,
        text,
        json: parseJson(text),
      });
    }
  }
  return { lastToolResults, lastUserTexts };
}

function toolResultText(block: Anthropic.ToolResultBlockParam): string {
  const content = block.content;
  if (content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  const texts = content.flatMap((part) => (part.type === "text" ? [part.text] : []));
  return texts.at(-1) ?? "";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 応答の組み立てヘルパー(脚本を書くためのもの)
// ---------------------------------------------------------------------------

export interface ScriptedUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
}

export interface ScriptedTurnOptions {
  /** 応答の model(価格表の引き当てに使う)。既定 claude-opus-5 */
  readonly model?: string;
  readonly usage?: ScriptedUsage;
  /** 応答の先頭に付けるテキスト(ツール呼び出し前の一言など) */
  readonly preface?: string;
}

export interface ScriptedToolCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

let scriptedIdCounter = 0;
function nextId(prefix: string): string {
  scriptedIdCounter += 1;
  return `${prefix}_scripted_${String(scriptedIdCounter).padStart(4, "0")}`;
}

/** 任意の content・stop_reason で応答を作る。 */
export function scriptedMessage(
  content: Anthropic.ContentBlock[],
  stopReason: Anthropic.StopReason,
  options: ScriptedTurnOptions = {},
): LlmTurn {
  const usage = options.usage ?? {};
  return {
    message: {
      id: nextId("msg"),
      type: "message",
      role: "assistant",
      model: options.model ?? "claude-opus-5",
      content,
      container: null,
      stop_reason: stopReason,
      stop_sequence: null,
      stop_details: null,
      usage: {
        input_tokens: usage.inputTokens ?? 0,
        output_tokens: usage.outputTokens ?? 0,
        cache_creation_input_tokens: usage.cacheCreationInputTokens ?? 0,
        cache_read_input_tokens: usage.cacheReadInputTokens ?? 0,
        cache_creation: null,
        inference_geo: null,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: null,
      },
    },
  };
}

function prefaceBlocks(options: ScriptedTurnOptions): Anthropic.ContentBlock[] {
  return options.preface !== undefined
    ? [{ type: "text", text: options.preface, citations: null }]
    : [];
}

/** ツール呼び出し(1ターン内の並列呼び出しを含む)の応答。 */
export function scriptedToolUse(
  calls: readonly ScriptedToolCall[],
  options: ScriptedTurnOptions = {},
): LlmTurn {
  return scriptedMessage(
    [
      ...prefaceBlocks(options),
      ...calls.map(
        (call): Anthropic.ContentBlock => ({
          type: "tool_use",
          id: nextId("toolu"),
          name: call.name,
          input: call.input,
          caller: { type: "direct" },
        }),
      ),
    ],
    "tool_use",
    options,
  );
}

/** submit_answer の呼び出しの応答。 */
export function scriptedSubmit(
  input: Record<string, unknown>,
  options: ScriptedTurnOptions = {},
): LlmTurn {
  return scriptedToolUse([{ name: "submit_answer", input }], options);
}

/** ツールを呼ばずにテキストだけで終える応答(end_turn)。 */
export function scriptedText(
  text: string,
  options: ScriptedTurnOptions = {},
): LlmTurn {
  return scriptedMessage(
    [{ type: "text", text, citations: null }],
    "end_turn",
    options,
  );
}
