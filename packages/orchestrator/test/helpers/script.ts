/**
 * 脚本(ScriptedLlmClient)を書くためのテストヘルパー。直前のツール結果から
 * ヒット・取得した文書を読み出す。モック API サーバー(mock-anthropic-server.ts /
 * mock-openai-server.ts)の脚本も、受けた要求から同じ形(ScriptView)を作って使う。
 */
import { scriptedToolUse, type LlmTurn, type ScriptContext } from "../../src/index.js";

/** 脚本が読む直前の user ターンの要約(ScriptedLlmClient とモックサーバーで共通)。 */
export type ScriptView = Pick<ScriptContext, "lastToolResults" | "lastUserTexts">;

export interface HitView {
  readonly source: string;
  readonly documentId: string;
  readonly title: string | undefined;
  readonly url: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 直前のターンの search 結果のヒット(成功した結果のみ)。 */
export function searchHits(context: ScriptView): HitView[] {
  const hits: HitView[] = [];
  for (const result of context.lastToolResults) {
    const json = result.json;
    if (result.isError || !isRecord(json) || json["tool"] !== "search") {
      continue;
    }
    const source = String(json["source"]);
    const payload = json["result"];
    const list = isRecord(payload) && Array.isArray(payload["hits"]) ? payload["hits"] : [];
    for (const hit of list) {
      if (isRecord(hit) && typeof hit["documentId"] === "string") {
        hits.push({
          source,
          documentId: hit["documentId"],
          title: typeof hit["title"] === "string" ? hit["title"] : undefined,
          url: typeof hit["url"] === "string" ? hit["url"] : undefined,
        });
      }
    }
  }
  return hits;
}

/** 直前のターンで fetch した文書。 */
export function fetchedDocuments(context: ScriptView): HitView[] {
  const documents: HitView[] = [];
  for (const result of context.lastToolResults) {
    const json = result.json;
    if (result.isError || !isRecord(json) || json["tool"] !== "fetch") {
      continue;
    }
    const payload = json["result"];
    if (isRecord(payload) && typeof payload["documentId"] === "string") {
      documents.push({
        source: String(json["source"]),
        documentId: payload["documentId"],
        title: typeof payload["title"] === "string" ? payload["title"] : undefined,
        url: typeof payload["url"] === "string" ? payload["url"] : undefined,
      });
    }
  }
  return documents;
}

/** 直前の user ターンにオーケストレーターの最終ターン指示が含まれるか。 */
export function isFinalInstruction(context: ScriptView): boolean {
  return context.lastUserTexts.some(
    (text) => text.startsWith("[オーケストレーター]") && text.includes("これ以上の検索・取得は行わず"),
  );
}

/** 最初に見つかったヒット(無ければテストを失敗させる)。 */
export function firstHit(context: ScriptView): HitView {
  const hit = searchHits(context)[0];
  if (hit === undefined) {
    throw new Error("script expected at least one search hit in the last tool results");
  }
  return hit;
}

/** 最初に見つかった fetch 済みの文書(無ければテストを失敗させる)。 */
export function firstFetched(context: ScriptView): HitView {
  const document = fetchedDocuments(context)[0];
  if (document === undefined) {
    throw new Error("script expected at least one fetched document in the last tool results");
  }
  return document;
}

/**
 * 直前のターンの最初のヒットを fetch する手順。既定の探索プロンプト(v4)では、ヒットを受け
 * 取ったのに1件も fetch せずに submit_answer を出すと1回差し戻される(search-feedback.ts)。
 * 版と関係のない挙動を確かめる脚本では、提出の前にこの手順を入れる
 */
export function fetchFirstHit(context: ScriptView): LlmTurn {
  const hit = firstHit(context);
  return scriptedToolUse([
    { name: "fetch", input: { source: hit.source, documentId: hit.documentId } },
  ]);
}
