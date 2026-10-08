/**
 * Gateway のツール定義(MCP tools/list)を Claude のツール定義へ変換する(T-007)。
 *
 * - strict: true。全 object に additionalProperties: false と required を付け、
 *   strict のツール定義で使えない制約キーワード(数値・文字列長・配列長)を落とす
 *   (Gateway 側の zod が引数を再検証するので、制約の実効性は失われない)
 * - `source` は run の有効ソース(未接続を除いたもの)の enum に絞る
 *   (未接続ソースを以降の検索対象から外す、ADR-010 決定3)
 * - 並び順を名前順に固定する(ツール定義はプロンプトの先頭に来るため、
 *   順序の揺れはキャッシュを無効化する)
 * - Orchestrator が解釈できる4ツールだけを公開する
 */
import type Anthropic from "@anthropic-ai/sdk";
import { submitAnswerTool } from "./answer.js";
import type { GatewayToolSchema } from "./gateway/types.js";

export const GATEWAY_TOOL_NAMES = ["search", "fetch", "list", "describe"] as const;
export type GatewayToolName = (typeof GATEWAY_TOOL_NAMES)[number];

export function isGatewayToolName(name: string): name is GatewayToolName {
  return (GATEWAY_TOOL_NAMES as readonly string[]).includes(name);
}

/** いつ呼ぶかの指針(Gateway の説明文に足す。探索方針の本体は system prompt)。 */
const USAGE_HINTS: Readonly<Record<GatewayToolName, string>> = {
  search:
    "質問に関係しそうな文書を探すときに使う。ヒットが薄ければ類義語・言い換え・英日変換・フィルタを変えて再検索する。",
  fetch:
    "有望なヒットの本文を読むときに使う。documentId と source は search の結果の値をそのまま使う。",
  list: "検索で見つけにくいとき、区画(フォルダ・リポジトリ等)を辿るのに使う。",
  describe:
    "ソースの説明を得る。各ソースの説明は最初のメッセージのソース一覧に載っているので通常は呼ばなくてよい。",
};

/** strict のツール定義で使えないキーワード(スキル「JSON Schema Limitations」)。 */
const UNSUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON Schema を strict 向けに正規化した複製を返す(入力は変更しない)。 */
export function normalizeStrictSchema(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(normalizeStrictSchema);
  }
  if (!isRecord(node)) {
    return node;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) {
      continue;
    }
    if (key === "properties" && isRecord(value)) {
      // プロパティ名 → スキーマ。名前自体はキーワード扱いしない
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [
          name,
          normalizeStrictSchema(schema),
        ]),
      );
      continue;
    }
    out[key] = normalizeStrictSchema(value);
  }
  if (out["type"] === "object") {
    if (!isRecord(out["properties"])) {
      out["properties"] = {};
    }
    if (!Array.isArray(out["required"])) {
      out["required"] = [];
    }
    out["additionalProperties"] = false;
  }
  return out;
}

/** search ツールの source enum(deployment.yaml 由来の有効ソース)を読む。 */
export function sourcesFromTools(tools: readonly GatewayToolSchema[]): string[] {
  const search = tools.find((tool) => tool.name === "search");
  const properties = search?.inputSchema["properties"];
  const source = isRecord(properties) ? properties["source"] : undefined;
  const values = isRecord(source) ? source["enum"] : undefined;
  if (!Array.isArray(values)) {
    return [];
  }
  return [
    ...new Set(values.filter((v): v is string => typeof v === "string" && v !== "")),
  ];
}

function toInputSchema(
  schema: Readonly<Record<string, unknown>>,
  activeSources: readonly string[],
): Anthropic.Tool.InputSchema | undefined {
  const normalized = normalizeStrictSchema(schema);
  if (!isRecord(normalized) || normalized["type"] !== "object") {
    return undefined;
  }
  const properties = normalized["properties"];
  if (isRecord(properties) && isRecord(properties["source"])) {
    const current = properties["source"];
    properties["source"] = {
      ...(typeof current["description"] === "string"
        ? { description: current["description"] }
        : {}),
      type: "string",
      enum: [...activeSources],
    };
  }
  return { ...normalized, type: "object" };
}

/**
 * LLM に渡すツール定義一式(Gateway の4ツール+submit_answer、名前順)。
 * 変換できないツール(object でないスキーマ)は公開しない。
 */
export function buildClaudeTools(
  gatewayTools: readonly GatewayToolSchema[],
  activeSources: readonly string[],
): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [];
  for (const tool of gatewayTools) {
    if (!isGatewayToolName(tool.name)) {
      continue;
    }
    const inputSchema = toInputSchema(tool.inputSchema, activeSources);
    if (inputSchema === undefined) {
      continue;
    }
    tools.push({
      name: tool.name,
      description: [tool.description, USAGE_HINTS[tool.name]]
        .filter((part): part is string => typeof part === "string" && part !== "")
        .join(" "),
      strict: true,
      input_schema: inputSchema,
    });
  }
  tools.push(submitAnswerTool(activeSources));
  return tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
