/**
 * 検索の状況を返す制御メッセージの判定と集計(explore.v4 とともに使う。T-024)。
 *
 * 探索 LLM が送った search / fetch と、その結果として Gateway から返ってきた値(= LLM が
 * ツール結果として受け取った値)だけを材料に、次を判定する:
 * - 検索がヒットを返さなかった
 * - 同じソースに同じ query・filters(と cursor)を再度実行した
 * - ヒットがすべて既出の文書だった(既出 = この run の search ヒットまたは fetch で得た文書)
 * - 1件も fetch せずに回答を提出しようとした(ヒットはあった)
 * あわせて、ここまでに試した検索の一覧(ソース、query、新しく得た文書の数)を作る。
 *
 * ADR-012: 新しい文書の数は返却済みのヒットから数える。総件数・未認可候補の件数・権限で
 * 落ちたかどうかは扱わない(Orchestrator はそれを持たない)。ツールエラーは分類を問わず
 * 「エラー」とだけ書く(not_available の内訳 = 権限外か不在か、を推させない)。
 *
 * 不変条件7: ここで持つ query は run の間だけメモリにあり、制御メッセージ(探索 LLM への
 * 揮発の入力)にだけ出す。warnings・回答・run API の申告(監査)には渡さない。
 *
 * 語数の上限など、ソースの検索の仕様に基づく判定はしない(構造化された検索プロファイルは
 * コネクタの IF 変更 = ADR が要る。不変条件5)。
 */
import {
  duplicateSearchNotice,
  noHitsNotice,
  noNewDocumentsNotice,
  searchHistoryNotice,
  type SearchAttemptOutcome,
  type SearchAttemptView,
} from "./prompt.js";

/** run あたりの差し戻しの上限(1件も fetch せずに提出しようとしたとき)。 */
export const MAX_FETCH_PUSHBACKS = 1;

/** 1件のツール呼び出しの観測(応答内の順に渡す)。 */
export type ToolObservation =
  | {
      readonly tool: "search";
      readonly source: string;
      readonly args: Readonly<Record<string, unknown>>;
      /** ok: 結果を受け取った / error: ツールエラー・転送エラー */
      readonly ok: boolean;
      readonly result?: unknown;
    }
  | {
      readonly tool: "fetch";
      readonly source: string;
      readonly args: Readonly<Record<string, unknown>>;
      readonly ok: boolean;
      readonly result?: unknown;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function docKey(source: string, documentId: string): string {
  return `${source}\u0000${documentId}`;
}

/** 重複判定用の query の正規化(互換文字・空白の違い・大文字小文字を同一視する)。 */
export function normalizeQuery(query: string): string {
  return query.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** filters の正規形(値が空でない文字列の項目だけ、キー順)。 */
function canonicalFilters(filters: unknown): [string, string][] {
  if (!isRecord(filters)) {
    return [];
  }
  return Object.entries(filters)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "")
    .map(([key, value]): [string, string] => [key, value.trim()])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 返ったヒットの documentId(形が想定外の要素は無視)。 */
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

/** 1 run の検索の記録(Orchestrator の RunState が持つ。run を越えて共有しない)。 */
export class SearchLog {
  readonly #attempts: SearchAttemptView[] = [];
  readonly #searchKeys = new Set<string>();
  readonly #seen = new Set<string>();
  #hitsReceived = 0;
  #fetched = 0;

  /** ここまでに試した検索(応答内の順)。 */
  get attempts(): readonly SearchAttemptView[] {
    return this.#attempts;
  }

  /** fetch が成功した回数。 */
  get fetchedCount(): number {
    return this.#fetched;
  }

  /** 1件も fetch していないのにヒットを受け取っている(差し戻しの条件)。 */
  needsFetchBeforeSubmit(): boolean {
    return this.#fetched === 0 && this.#hitsReceived > 0;
  }

  /**
   * 1 ターン分の観測を応答内の順に記録し、そのターンの通知(ヒットなし・重複・既出のみ)を
   * 返す。同じターン内の同一の検索も、後のものを重複として扱う。
   */
  observeTurn(turn: number, observations: readonly (ToolObservation | undefined)[]): string[] {
    const notices: string[] = [];
    for (const observation of observations) {
      if (observation === undefined) {
        continue;
      }
      if (observation.tool === "fetch") {
        if (observation.ok) {
          this.#fetched += 1;
          const documentId = isRecord(observation.result)
            ? observation.result["documentId"]
            : undefined;
          if (typeof documentId === "string" && documentId !== "") {
            this.#seen.add(docKey(observation.source, documentId));
          }
        }
        continue;
      }
      const notice = this.#observeSearch(turn, observation);
      if (notice !== undefined) {
        notices.push(notice);
      }
    }
    return notices;
  }

  #observeSearch(
    turn: number,
    observation: Extract<ToolObservation, { tool: "search" }>,
  ): string | undefined {
    const rawQuery = observation.args["query"];
    const query = typeof rawQuery === "string" ? rawQuery : "";
    const filters = canonicalFilters(observation.args["filters"]);
    const cursor = observation.args["cursor"];
    const key = JSON.stringify([
      observation.source,
      normalizeQuery(query),
      filters,
      typeof cursor === "string" ? cursor : null,
    ]);
    const duplicate = this.#searchKeys.has(key);
    this.#searchKeys.add(key);

    let outcome: SearchAttemptOutcome;
    if (!observation.ok) {
      outcome = duplicate ? { kind: "duplicate" } : { kind: "error" };
    } else {
      const ids = hitDocumentIds(observation.result);
      this.#hitsReceived += ids.length;
      let fresh = 0;
      for (const id of ids) {
        const k = docKey(observation.source, id);
        if (!this.#seen.has(k)) {
          this.#seen.add(k);
          fresh += 1;
        }
      }
      outcome = duplicate
        ? { kind: "duplicate" }
        : ids.length === 0
          ? { kind: "no_hits" }
          : fresh === 0
            ? { kind: "no_new_documents" }
            : { kind: "new_documents", count: fresh };
    }
    const attempt: SearchAttemptView = {
      turn,
      source: observation.source,
      query,
      hasFilters: filters.length > 0,
      outcome,
    };
    this.#attempts.push(attempt);
    switch (outcome.kind) {
      case "duplicate":
        return duplicateSearchNotice(attempt);
      case "no_hits":
        return noHitsNotice(attempt);
      case "no_new_documents":
        return noNewDocumentsNotice(attempt);
      default:
        return undefined;
    }
  }

  /**
   * ツール結果の後ろに置く制御メッセージ(そのターンの通知 + ここまでの検索の一覧と残りの
   * ターン数)。検索をまだ1回もしていなければ undefined。
   */
  render(turnNotices: readonly string[], remainingTurns: number): string | undefined {
    if (this.#attempts.length === 0) {
      return undefined;
    }
    return [...turnNotices, searchHistoryNotice(this.#attempts, remainingTurns)].join("\n");
  }
}
