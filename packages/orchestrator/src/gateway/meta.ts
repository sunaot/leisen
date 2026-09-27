/**
 * Gateway への tools/call に載せる `_meta` の組み立て(T-007。ADR-001 追補3 決定4、
 * ADR-011 追記、ADR-015)。
 *
 * Orchestrator が Gateway に送る `_meta` は buildGatewayMeta だけで組み立て、他の箇所に
 * キー文字列を書かない(`test/gateway-meta.test.ts` で固定)。キーは @kp/gateway の
 * GATEWAY_META_KEYS(prefix 付きの4キー)からのみ作り、裸キー(runId / iteration の
 * 移行期間の後方互換)は使わない。Gateway は名前空間内の未知キーや見た目違いの
 * 申告キーを誤記として invalid_request で拒否する(T-003 M2 / 再レビュー S1)。
 *
 * - runId / iteration: 探索ループが採番する監査の束ね(orchestrator.ts)
 * - 実行区分 / actor: Phase 1 は human_in_the_loop / human 固定(ADR-015、ADR-017 決定5)。
 *   Orchestrator は常に既定値を使う(scheduled / autonomous は実装しない)。差し替えの
 *   引数は、区分の申告が Gateway に届いて拒否される(execution_class_rejected、監査
 *   1件)ことを Orchestrator の MCP クライアント経由で確かめるテストのためだけにある
 *
 * 結果側の `_meta`(Gateway → Orchestrator)の読み取りもここに集約する
 * (gatewayUserIdFromResultMeta。キーは @kp/gateway の GATEWAY_RESULT_META_KEYS)。
 * Gateway が認証した userId で、AnswerRun の主体をこれに束縛する(セキュリティ
 * レビュー 2026-09-27 H1、orchestrator.ts)。
 */
import {
  GATEWAY_META_KEYS,
  GATEWAY_RESULT_META_KEYS,
  type Actor,
  type ExecutionClass,
} from "@kp/gateway";
import { HUMAN_ACTOR } from "../audit.js";

/** Phase 1 の実行区分(ADR-015。scheduled / autonomous は Gateway が既定拒否する)。 */
const PHASE1_EXECUTION_CLASS: ExecutionClass = "human_in_the_loop";

export interface GatewayMetaInput {
  /** 探索ループの runId(Gateway が受けるのは [A-Za-z0-9._:-] の1〜128文字) */
  readonly runId: string;
  /** run 内のツール呼び出しの通し番号(0 から単調増加) */
  readonly iteration: number;
  /** 既定 human_in_the_loop。Orchestrator は指定しない(区分拒否の検証用) */
  readonly executionClass?: ExecutionClass;
  /** 既定 human。Orchestrator は指定しない(区分拒否の検証用) */
  readonly actor?: Actor;
}

/** Gateway へ送る `_meta`(GATEWAY_META_KEYS の4キーちょうど)を組み立てる。 */
export function buildGatewayMeta(
  input: GatewayMetaInput,
): Readonly<Record<string, unknown>> {
  return {
    [GATEWAY_META_KEYS.runId]: input.runId,
    [GATEWAY_META_KEYS.iteration]: input.iteration,
    [GATEWAY_META_KEYS.executionClass]:
      input.executionClass ?? PHASE1_EXECUTION_CLASS,
    [GATEWAY_META_KEYS.actor]: input.actor ?? HUMAN_ACTOR,
  };
}

/** Gateway が報告する userId として受け付ける最大長(監査レコードの主体に使う)。 */
const MAX_REPORTED_USER_ID_CHARS = 256;
/** 制御文字・不可視の書式文字を含む値は userId として扱わない。 */
const UNSAFE_USER_ID_CHARS = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/u;

/**
 * tools/call の結果の `_meta` から、Gateway が認証した userId を読む(H1)。
 * 無い・形が不正(空文字・非文字列・過長・制御文字入り)なら undefined
 * (呼び出し側は「Gateway が利用者を確認していない」として扱う)。
 */
export function gatewayUserIdFromResultMeta(meta: unknown): string | undefined {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return undefined;
  }
  const key = GATEWAY_RESULT_META_KEYS.userId;
  if (!Object.hasOwn(meta, key)) {
    return undefined;
  }
  const value = (meta as Readonly<Record<string, unknown>>)[key];
  if (
    typeof value !== "string" ||
    value === "" ||
    value.length > MAX_REPORTED_USER_ID_CHARS ||
    UNSAFE_USER_ID_CHARS.test(value)
  ) {
    return undefined;
  }
  return value;
}
