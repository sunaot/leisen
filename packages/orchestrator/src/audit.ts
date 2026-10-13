/**
 * 監査に関わる Orchestrator 側の定数(T-007、ADR-019)。
 *
 * AnswerRun の組み立てと書き込みは Gateway の run API に移った(ADR-019 決定3・10、T-023)。
 * Orchestrator は監査ストアに触れず、run の開始・終了・フィードバックを申告するだけで、
 * citedDocIds の分類(Slack・プライベートスコープ)も Gateway がかける。ここに残るのは
 * `_meta` の actor の既定値と、永続化不可のソースの判定(leisen-ask serve の起動拒否。ADR-018 決定5)。
 */
import type { Actor } from "@leisen/audit";

/** Phase 1 の実行区分は human-in-the-loop 固定(ADR-015、ADR-017 決定5)。 */
export const HUMAN_ACTOR: Actor = { kind: "human" };

/**
 * Slack と分類するコネクタの kind(`slack`、または `slack-` で始まるプラグイン名)。
 * Gateway と同じ規則(@leisen/gateway の isSlackKind)。leisen-ask serve が永続化不可のソース
 * (不変条件7、ADR-014)の有効化を判定するのに使う(ADR-018 決定5)。
 */
export { isSlackKind } from "@leisen/gateway";
