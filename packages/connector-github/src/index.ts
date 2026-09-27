/**
 * @kp/connector-github — GitHub コネクタ(T-019)。
 *
 * connector-sdk v0.3 の Connector を GitHub REST API で実装する。全呼び出しを
 * 利用者本人の user access token で行う(不変条件1、ADR-010、auth-matrix §4)。
 * 使い方・前提・既知の限界は README.md を参照。
 */
export {
  DEFAULT_GITHUB_SOURCE_ID,
  DEFAULT_LIST_PAGE_SIZE,
  DEFAULT_MAX_COMMENTS,
  DEFAULT_MAX_TOP_CONTAINERS,
  DEFAULT_PAGE_CHARS,
  DEFAULT_SEARCH_LIMIT,
  GitHubConnector,
  MAX_SEARCH_LIMIT,
  createGitHubConnector,
  type GitHubConnectorOptions,
} from "./connector.js";
export {
  DEFAULT_GITHUB_API_BASE_URL,
  DEFAULT_GITHUB_TIMEOUT_MS,
  DEFAULT_GITHUB_USER_AGENT,
  GITHUB_API_VERSION,
  GitHubApiClient,
  type FetchLike,
  type GitHubApiClientOptions,
  type GitHubRequest,
  type GitHubResponse,
  type RateLimitOptions,
} from "./api.js";
export {
  DEFAULT_QUOTA_MAX_ENTRIES,
  DEFAULT_SECONDARY_BACKOFF_BASE_MS,
  DEFAULT_SECONDARY_BACKOFF_MAX_MS,
  QuotaTracker,
  type GitHubRateLimitResource,
  type QuotaDecision,
  type QuotaTrackerOptions,
  type RateLimitSignal,
  type RateLimitSnapshot,
} from "./quota.js";
export {
  decodeDocumentId,
  encodeDocumentId,
  type GitHubDocumentRef,
} from "./document-id.js";
