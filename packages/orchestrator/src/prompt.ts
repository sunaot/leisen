/**
 * システムプロンプトのロード・レンダリング(T-007)。
 *
 * プロンプト本文は packages/orchestrator/prompts/ でバージョン管理する
 * (T-007要件)。コードへの埋め込みはせず、ビルド後も dist/../prompts を参照する。
 * 探索方針の変更はプロンプトファイルの新バージョン追加(system-v2.md等)で行い、
 * 過去バージョンを書き換えない。
 */
import { readFileSync } from "node:fs";
import type { SourceDescription } from "@kp/connector-sdk";

export const DEFAULT_PROMPT_VERSION = "v1";

const VERSION_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;

export function loadSystemPromptTemplate(
  version: string = DEFAULT_PROMPT_VERSION,
): string {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`invalid prompt version: ${version}`);
  }
  const url = new URL(`../prompts/system-${version}.md`, import.meta.url);
  return readFileSync(url, "utf8");
}

export interface SkippedSourceInfo {
  readonly sourceId: string;
  readonly reason: "not_connected";
}

export interface SystemPromptParams {
  readonly maxIterations: number;
  /** describeが取得できた接続済みソース */
  readonly connectedSources: readonly SourceDescription[];
  /** describeに失敗したが呼び出し自体は可能なソース(説明なしで提示) */
  readonly undescribedSourceIds?: readonly string[];
  readonly skippedSources: readonly SkippedSourceInfo[];
}

/**
 * describe結果をプロンプトへ整形する。ツール結果由来のテキストであるため、
 * データとして箇条書きに閉じ込める(指示文へ昇格させない)。
 */
function renderSource(description: SourceDescription): string {
  const containers = description.topContainers
    .map((entry) => `${entry.name}(${entry.kind})`)
    .join(", ");
  const filters = description.supportedFilters.join(", ");
  return [
    `- ${description.sourceId}: ${description.displayName}`,
    `  内容: ${description.summary}`,
    containers ? `  主要区画: ${containers}` : undefined,
    filters ? `  searchで使えるフィルタ: ${filters}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function renderSystemPrompt(
  template: string,
  params: SystemPromptParams,
): string {
  const connected = [
    ...params.connectedSources.map(renderSource),
    ...(params.undescribedSourceIds ?? []).map(
      (sourceId) => `- ${sourceId}(説明の取得に失敗。search/fetch/listは試行可能)`,
    ),
  ];
  const skipped = params.skippedSources.map(
    (source) => `- ${source.sourceId}(未接続)`,
  );
  return template
    .replaceAll("{{maxIterations}}", String(params.maxIterations))
    .replaceAll(
      "{{connectedSources}}",
      connected.length > 0 ? connected.join("\n") : "(利用可能なソースなし)",
    )
    .replaceAll(
      "{{skippedSources}}",
      skipped.length > 0 ? skipped.join("\n") : "(なし)",
    );
}
