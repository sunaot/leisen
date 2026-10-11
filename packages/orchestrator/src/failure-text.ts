/**
 * run が outcome: error で終わったときの回答文(issue #38、UX レビュー R9)。
 *
 * 失敗の正規化コード(AnswerRun の failureReason。GatewayClientError / LlmError の分類と
 * run の理由)を分類に写し、利用者が次に何をすべきかが分かる日本語にする。以前は分類の
 * ない失敗が一律「時間をおいて再度お試しください」だったため、接続先の誤り(待っても直らない)
 * と一時的な障害の区別がつかなかった。
 *
 * - 分類は既存のエラー型の分類コードから決める(新しい判定はしない):
 *   - configuration(設定・接続先の誤り): 接続先が MCP エンドポイントでない・400/404/405/406/415
 *     (gateway_protocol_error)、その他の拒否(gateway_rejected)、ソースがない、Gateway が
 *     利用者を報告しない(対応していない版)、LLM が要求を受け付けない(llm_invalid_request)
 *   - credentials(資格情報の無効・期限切れ): 401 / 403(gateway_unauthenticated /
 *     gateway_forbidden、LLM の llm_credentials_missing / llm_authentication_failed /
 *     llm_permission_denied)、利用者の不一致(user_mismatch)
 *   - transient(一時的な障害): 408 / 429 / 5xx・接続失敗(gateway_unavailable)、タイムアウト、
 *     LLM の混雑・停止(llm_rate_limited / llm_overloaded / llm_unavailable / llm_timeout)
 *   - content(質問・応答の内容や長さ): llm_refusal / llm_max_tokens / llm_context_window_exceeded
 *   - unknown(不明): 上記以外(llm_client_error / llm_unexpected_response / internal_error 等)
 * - 文言には正規化コードを括弧で添える(問い合わせ・監査の failureReason と突き合わせるため)。
 *   URL・ホスト名・トークン・上流の生のメッセージは含めない(RS-4、不変条件6)。分類コードは
 *   実装内の固定値で、外部の入力をそのまま埋め込まない
 * - 文言は kp-ask(CLI)とチャット UI(kp-ask serve)の両方に出る。管理者の作業が要るものは
 *   「利用者の方は管理者に連絡してください」を添える
 */

/** 失敗の分類。 */
export type FailureCategory =
  /** 設定・接続先の誤り(待っても直らない。設定を直す) */
  | "configuration"
  /** 資格情報の無効・期限切れ(サインインし直す、または資格情報を設定し直す) */
  | "credentials"
  /** 一時的な障害(時間をおいて再度試す) */
  | "transient"
  /** 質問・応答の内容や長さ(質問を変える・絞る) */
  | "content"
  /** 分類できない */
  | "unknown";

const CATEGORY_OF: Readonly<Record<string, FailureCategory>> = {
  gateway_protocol_error: "configuration",
  gateway_rejected: "configuration",
  no_searchable_sources: "configuration",
  user_unverified: "configuration",
  llm_invalid_request: "configuration",

  gateway_unauthenticated: "credentials",
  gateway_forbidden: "credentials",
  user_mismatch: "credentials",
  llm_credentials_missing: "credentials",
  llm_authentication_failed: "credentials",
  llm_permission_denied: "credentials",

  gateway_unavailable: "transient",
  gateway_timeout: "transient",
  run_timeout: "transient",
  run_not_accepted: "transient",
  rate_limited: "transient",
  audit_write_failed: "transient",
  orchestrator_credential_rejected: "configuration",
  llm_rate_limited: "transient",
  llm_overloaded: "transient",
  llm_unavailable: "transient",
  llm_timeout: "transient",

  llm_refusal: "content",
  llm_max_tokens: "content",
  llm_context_window_exceeded: "content",
};

/** 失敗の正規化コードの分類(表にないものは unknown)。 */
export function failureCategoryOf(errorClass: string): FailureCategory {
  return Object.hasOwn(CATEGORY_OF, errorClass) ? (CATEGORY_OF[errorClass] ?? "unknown") : "unknown";
}

const CONTACT_ADMIN = "利用者の方は管理者に連絡してください。";

/** 分類コードごとの文言(分類の既定の文言より優先する)。 */
const FAILURE_TEXTS: Readonly<Record<string, (code: string) => string>> = {
  // --- 設定・接続先の誤り ---
  gateway_protocol_error: (code) =>
    `Gateway が MCP の要求として受け付けなかったため、回答していません(${code})。` +
    `接続先が Gateway の MCP エンドポイントか(URL のパスなど)と、Gateway の設定を確認してください。${CONTACT_ADMIN}`,
  gateway_rejected: (code) =>
    `Gateway が要求を受け付けなかったため、回答していません(${code})。` +
    `接続先が Gateway の MCP エンドポイントか(URL のパスなど)と、Gateway の版・設定を確認してください。${CONTACT_ADMIN}`,
  no_searchable_sources: (code) =>
    `Gateway に検索できるソースがないため、回答していません(${code})。` +
    `Gateway の設定(有効なコネクタ)と接続先を確認してください。${CONTACT_ADMIN}`,
  user_unverified: (code) =>
    `Gateway が利用者の確認結果を返さなかったため、回答していません(${code})。` +
    `接続先がこの Orchestrator に対応する版の Gateway か確認してください。${CONTACT_ADMIN}`,
  llm_invalid_request: (code) =>
    `LLM が要求を受け付けなかったため、回答を生成できませんでした(${code})。` +
    `モデル名と LLM の接続先の設定を確認してください。${CONTACT_ADMIN}`,

  // --- 資格情報の無効・期限切れ ---
  gateway_unauthenticated: (code) =>
    `Gateway が利用者の認証を拒否したため、回答していません(${code})。サインインし直してから再度お試しください。`,
  gateway_forbidden: (code) =>
    `Gateway への要求が拒否されたため、回答していません(${code}、HTTP 403)。` +
    "サインインし直してから再度お試しください。解決しない場合は、利用権限を管理者に確認してください。",
  user_mismatch: (code) =>
    `利用者を確認できなかったため、回答していません(${code})。` +
    "サインインしている利用者を確認してから再度お試しください。続く場合は管理者に連絡してください。",
  llm_credentials_missing: (code) =>
    `LLM の資格情報(API キーなど)が設定されていないため、回答を生成できませんでした(${code})。` +
    `LLM の資格情報の設定を確認してください。${CONTACT_ADMIN}`,
  llm_authentication_failed: (code) =>
    `LLM が資格情報を拒否した(無効・期限切れ)ため、回答を生成できませんでした(${code})。` +
    `LLM の API キーなどの資格情報を確認してください。${CONTACT_ADMIN}`,
  llm_permission_denied: (code) =>
    `LLM の利用権限が足りないため、回答を生成できませんでした(${code})。` +
    `LLM のアカウント・ワークスペースの権限を確認してください。${CONTACT_ADMIN}`,

  // --- 一時的な障害 ---
  gateway_unavailable: (code) =>
    `Gateway に接続できないか、Gateway が一時的に応答できないため、回答していません(${code})。` +
    "時間をおいて再度お試しください。続く場合は管理者に連絡してください。",
  gateway_timeout: (code) =>
    `Gateway の応答が時間内に返らなかったため、回答していません(${code})。` +
    "時間をおいて再度お試しください。続く場合は管理者に連絡してください。",
  run_timeout: (code) =>
    `探索の時間上限までに Gateway の応答がそろわなかったため、回答していません(${code})。` +
    "時間をおいて再度お試しください。続く場合は管理者に連絡してください。",
  llm_rate_limited: (code) =>
    `LLM が混み合っているため、回答を生成できませんでした(${code})。時間をおいて再度お試しください。`,
  llm_overloaded: (code) =>
    `LLM が混み合っているため、回答を生成できませんでした(${code})。時間をおいて再度お試しください。`,
  llm_unavailable: (code) =>
    `LLM に接続できないか、LLM が一時的に応答できないため、回答を生成できませんでした(${code})。` +
    "時間をおいて再度お試しください。続く場合は管理者に連絡してください。",
  llm_timeout: (code) =>
    `LLM の応答が時間内に返らなかったため、回答を生成できませんでした(${code})。` +
    "時間をおいて再度お試しください。続く場合は管理者に連絡してください。",

  // --- 質問・応答の内容や長さ ---
  llm_refusal: (code) =>
    `LLM がこの質問への回答を辞退しました(${code})。質問の表現を変えて再度お試しください。`,
  llm_max_tokens: (code) =>
    `LLM の出力が長さの上限で途切れたため、回答を生成できませんでした(${code})。` +
    "質問の範囲を絞って再度お試しください。続く場合は管理者に連絡してください(1ターンの出力上限の設定)。",
  llm_context_window_exceeded: (code) =>
    `探索の途中で会話が LLM の扱える長さを超えたため、回答を生成できませんでした(${code})。` +
    "質問の範囲を絞って再度お試しください。続く場合は管理者に連絡してください(モデルのコンテキスト長の設定)。",
};

/** 分類ごとの既定の文言(分類コードごとの文言がないとき)。 */
const CATEGORY_TEXTS: Readonly<Record<FailureCategory, (code: string) => string>> = {
  configuration: (code) =>
    `設定または接続先に誤りがある可能性があるため、回答を生成できませんでした(${code})。` +
    `接続先と設定を確認してください。${CONTACT_ADMIN}`,
  credentials: (code) =>
    `資格情報がない・無効・期限切れ、または権限が足りないため、回答を生成できませんでした(${code})。` +
    `サインインし直すか、資格情報の設定を確認してください。${CONTACT_ADMIN}`,
  transient: (code) =>
    `一時的な障害のため、回答を生成できませんでした(${code})。` +
    "時間をおいて再度お試しください。続く場合は管理者に連絡してください。",
  content: (code) =>
    `質問または探索の内容のため、回答を生成できませんでした(${code})。質問を変えて再度お試しください。`,
  unknown: (code) =>
    `回答を生成できませんでした(${code})。原因を分類できない失敗です。` +
    "再度お試しいただき、続く場合は runId を添えて管理者に連絡してください。",
};

/**
 * 失敗の正規化コードに対する回答文(outcome: error の Answer.answer)。分類コードは
 * lower snake_case の正規化コードに限る(`.` も許さない。規約外は internal_error として扱い、
 * ドメイン名風の文字列など外部由来の文字列を埋め込まない)。
 */
export function failureTextFor(errorClass: string): string {
  const code = /^[a-z][a-z0-9_]{0,63}$/.test(errorClass) ? errorClass : "internal_error";
  const specific = Object.hasOwn(FAILURE_TEXTS, code) ? FAILURE_TEXTS[code] : undefined;
  return (specific ?? CATEGORY_TEXTS[failureCategoryOf(code)])(code);
}
