/**
 * 返り値の「試した検索」(ADR-026 決定3、T-031)の集計。
 *
 * 探索 LLM が呼び、Gateway に送った search を応答内の順に記録する(Gateway に送らなかった
 * 呼び出し = 未接続ソース宛て・件数の上限超過などは載せない)。材料は Orchestrator が受け取った
 * 結果だけ:
 * - outcome: 結果を受け取りヒットが 1 件以上 → hits / 0 件 → no_hits / ツールエラー・転送エラー
 *   → error(分類は載せない。permission_denied と not_found の区別を UI 側に出さない)
 * - newDocuments: その run で初めて返った文書の数。認可済みで返ったヒット(と fetch で得た
 *   文書)から数える。総件数・未認可候補の件数は扱わない(ADR-012。Orchestrator は持たない)
 *
 * query と filters は探索 LLM が送った値の写し。永続化できないソース(Slack)が有効な構成では
 * 呼び出し側が withoutSearchQueries(answer.ts)で除く(ADR-026 決定5)。
 */
import type { SearchTried } from "./answer.js";
import type { ToolObservation } from "./search-feedback.js";

/** 1 run あたりに記録する件数の上限(maxToolCallsPerRun の設定上限と同じ)。 */
export const MAX_SEARCHES_TRIED = 1_000;

const FILTER_KEYS = ["updatedAfter", "updatedBefore", "container", "author"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function docKey(source: string, documentId: string): string {
  return `${source}\u0000${documentId}`;
}

function hitDocumentIds(result: unknown): string[] {
  if (!isRecord(result) || !Array.isArray(result["hits"])) {
    return [];
  }
  return result["hits"].flatMap((hit) =>
    isRecord(hit) && typeof hit["documentId"] === "string" && hit["documentId"] !== ""
      ? [hit["documentId"]]
      : [],
  );
}

function filtersOf(value: unknown): SearchTried["filters"] {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const key of FILTER_KEYS) {
    const v = value[key];
    if (typeof v === "string" && v !== "") {
      out[key] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 1 run の試した検索(RunState が持つ。run を越えて共有しない)。 */
export class SearchesTriedLog {
  readonly #entries: SearchTried[] = [];
  readonly #seen = new Set<string>();

  get entries(): readonly SearchTried[] {
    return this.#entries;
  }

  /** 1 ターン分の観測を応答内の順に記録する(search 以外は既出の文書の記録にだけ使う)。 */
  observeTurn(observations: readonly (ToolObservation | undefined)[]): void {
    for (const observation of observations) {
      if (observation === undefined) {
        continue;
      }
      if (observation.tool === "fetch") {
        const documentId = isRecord(observation.result)
          ? observation.result["documentId"]
          : undefined;
        if (observation.ok && typeof documentId === "string" && documentId !== "") {
          this.#seen.add(docKey(observation.source, documentId));
        }
        continue;
      }
      if (this.#entries.length >= MAX_SEARCHES_TRIED) {
        continue;
      }
      const query = observation.args["query"];
      const filters = filtersOf(observation.args["filters"]);
      let outcome: SearchTried["outcome"] = "error";
      let newDocuments = 0;
      if (observation.ok) {
        const ids = hitDocumentIds(observation.result);
        outcome = ids.length > 0 ? "hits" : "no_hits";
        for (const id of ids) {
          const key = docKey(observation.source, id);
          if (!this.#seen.has(key)) {
            this.#seen.add(key);
            newDocuments += 1;
          }
        }
      }
      this.#entries.push({
        sourceId: observation.source,
        ...(typeof query === "string" ? { query } : {}),
        ...(filters !== undefined ? { filters } : {}),
        outcome,
        newDocuments,
      });
    }
  }
}
