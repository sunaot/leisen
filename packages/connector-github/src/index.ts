/**
 * @kp/connector-github — GitHub コネクタ(T-019)。
 *
 * connector-sdk v0.3 の Connector を GitHub REST API で実装する。全呼び出しを
 * 利用者本人の user access token で行う(不変条件1、ADR-010、auth-matrix §4)。
 * 使い方・前提・既知の限界は README.md を参照。
 *
 * 公開 API は factory(createGitHubConnector)と型のみに絞る。API クライアント
 * (GitHubApiClient)・残quota追跡(QuotaTracker)・documentId の符号化は内部実装で
 * あり公開しない: コネクタ(= Gateway に登録して呼ぶ経路)を経由せずに GitHub API を
 * 呼ぶ部品を配らない(不変条件2)。documentId はコネクタスコープの不透明な文字列
 * (ADR-007)。テストは相対 import で内部モジュールを参照する。
 */
export {
  createGitHubConnector,
  type GitHubConnector,
  type GitHubConnectorOptions,
} from "./connector.js";
export type { FetchLike, RateLimitOptions } from "./api.js";
