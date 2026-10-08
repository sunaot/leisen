/**
 * connector-sdk v0.4: 全データソースコネクタが実装する共通インターフェース。
 * v0.2からの変更はADR-016(SearchOptions、listページング、snippet規約、redaction)。
 * v0.3からの変更はADR-016 追補2(プライベート領域の方針 SourcePolicy、結果ごとの
 * 領域分類 DocumentScope、能力 privateScopeHandling、エラー分類 private_scope_excluded)。
 *
 * 不変条件(CLAUDE.md参照):
 * - すべての操作は AuthContext(利用者本人の資格情報)を受け取る。
 *   コネクタが独自にサービスアカウントへフォールバックしてはならない(方式はADR-010)。
 * - このIFはPhase 2で内部実装(ネイティブ検索→検索層)を差し替えるための
 *   安定境界である。変更にはADRが必要。
 * - AuthContext / Credential を直接シリアライズしない。ログには redactAuthContext() を使う。
 */

/**
 * 資格情報。認可方式はソースにより異なる(ADR-007/010)。
 * OAuthベアラー以外の kind の追加にはADRが必要。
 * - oauth_bearer: OAuth系API(Drive, Slack等)
 * - delegated_identity: 本人としてのアクセス試行で認可されるソース
 *   (ファイル共有等)。semanticsはT-017のスパイクで確定するexperimental(ADR-007参照)。
 */
export type Credential =
  | {
      readonly kind: "oauth_bearer";
      /** ログ出力禁止(不変条件6)。redactAuthContext() を経由せずにシリアライズしない */
      readonly accessToken: string;
      /** トークン失効時刻(epoch ms) */
      readonly expiresAt: number;
    }
  | {
      readonly kind: "delegated_identity";
      /** ソース側の認可主体(例: ADアカウントUPN) */
      readonly principal: string;
    };

/** 利用者本人の認証コンテキスト。IdP Adapter(T-002)が発行する。 */
export interface AuthContext {
  /** IdP上の一意なユーザーID(監査ログの主体) */
  readonly userId: string;
  readonly credential: Credential;
}

/**
 * ログ・エラー出力用のredaction(ADR-016)。AuthContextを文字列化する経路は
 * 必ずこれを通す。秘密情報のフィールドを持たない構造を返す。
 */
export function redactAuthContext(auth: AuthContext): {
  userId: string;
  credential: { kind: Credential["kind"]; redacted: true };
} {
  return {
    userId: auth.userId,
    credential: { kind: auth.credential.kind, redacted: true },
  };
}

/**
 * 結果の領域(ADR-013 §1、ADR-016 追補2 決定2)。
 * - private: DM・プライベートチャンネル・個人スコープ等のプライベート領域
 * - shared: それ以外(組織の業務の領域)
 * 何を private とするかの対応表と判定の根拠は各コネクタの README に書き、契約テストで
 * 固定する。判定に迷うものは private とする。Gateway は "shared" 以外(欠落・未知の値)を
 * private とみなす(決定4)。
 */
export type DocumentScope = "private" | "shared";

/**
 * deployment.yaml 由来の、導入単位のソース方針(ADR-016 追補2 決定1)。
 * Gateway の起動コードが factory(ConnectorFactoryInit.policy)に渡す。
 * #22 の SourceProfile に吸収する予定(フィールド名 policy は保つ)。
 * - excluded: プライベート領域を検索対象外にする(既定、ADR-013 §1)
 * - included: プライベート領域を含める(確認フラグ付きでのみ起動できる)
 * consent は #42 の設計まで起動時に拒否するため渡らない(決定6)。
 */
export interface SourcePolicy {
  readonly privateScopes: "excluded" | "included";
}

/**
 * プライベート領域の扱いの能力(ADR-016 追補2 決定3)。
 * - enforced: excluded のとき private の結果を返さない(ソースへの要求の段階で除く。
 *   資格情報のスコープによる除外を含む)。全結果に scope を付ける
 * - classified: ソース側では除かない(除けない)。全結果に scope を付け、除外は
 *   Gateway に任せる
 * - unsupported: 分類できない。宣言がないもの(v0.3 のプラグイン)もこれとみなす。
 *   excluded の方針では起動を拒否される
 */
export type PrivateScopeHandling = "enforced" | "classified" | "unsupported";

/**
 * 能力の宣言からプライベート領域の扱いを読む。宣言がない・未知の値(v0.3 の
 * プラグイン、実行時の不正値)は "unsupported" とみなす(fail-closed、決定3)。
 */
export function privateScopeHandlingOf(
  capabilities: Partial<Pick<ConnectorCapabilities, "privateScopeHandling">> | undefined,
): PrivateScopeHandling {
  const declared: unknown = capabilities?.privateScopeHandling;
  return declared === "enforced" || declared === "classified" ? declared : "unsupported";
}

/**
 * 結果の scope を正規化する。"shared" 以外(欠落・未知の値)は "private"
 * (ADR-016 追補2 決定4・5: 判定できないものは private 側に倒す)。
 */
export function normalizeDocumentScope(value: unknown): DocumentScope {
  return value === "shared" ? "shared" : "private";
}

export interface SearchFilters {
  /** ISO 8601。指定期間内に更新された文書に限定 */
  updatedAfter?: string;
  updatedBefore?: string;
  /** ソース固有の区画(Driveのフォルダ、Slackのチャンネル等) */
  container?: string;
  author?: string;
}

/** 検索オプション(ADR-016)。 */
export interface SearchOptions {
  /** 続きを取得するカーソル */
  cursor?: string;
  /** 返却件数の上限。未指定時はコネクタ既定 */
  limit?: number;
}

/**
 * snippetの最大文字数。Gatewayはこの長さで強制truncateする(ADR-016)。
 * snippetに本文全体を入れてはならない。
 */
export const MAX_SNIPPET_CHARS = 500;

/**
 * 文書内位置。長大文書(PDF/Office)でLLMが原典の該当箇所へ
 * 直接降りるために必要(ADR-007)。
 */
export interface HitAnchor {
  kind: "page" | "section" | "message" | "row";
  /** ページ番号、見出しID、メッセージts等 */
  value: string;
  /** 人間可読ラベル(例: "p.34", "3.2節") */
  label?: string;
}

export interface SearchHit {
  /**
   * コネクタスコープで不透明なID。複合キー(例: Slackの
   * channel:thread_ts)はコネクタ内でこの文字列に符号化する。
   */
  documentId: string;
  title: string;
  /**
   * スニペット。degradedなソースでは空文字を許容。本文全体は禁止。
   * MAX_SNIPPET_CHARS を超えた分はGatewayがtruncateする。
   * Slack(RTS)由来のスニペットは永続化禁止(ADR-014、不変条件7)。
   */
  snippet: string;
  /** URI。https:// のほか file:// 等ソース固有スキームを許容 */
  url: string;
  /** 文書内位置(該当する場合) */
  anchor?: HitAnchor;
  updatedAt?: string;
  /** ソース固有の追加メタ情報 */
  meta?: Record<string, string>;
  /**
   * 結果の領域(v0.4、ADR-016 追補2 決定2)。判定できないものは "private" を付ける。
   * enforced のコネクタは excluded の方針で "private" の結果を返さない
   */
  scope: DocumentScope;
}

export interface SearchResult {
  hits: SearchHit[];
  /**
   * 続きがある場合のカーソル。
   *
   * 注: 「総件数(totalCount)」フィールドは意図的に持たない(ADR-012/016)。
   * ネイティブ検索が返す総hit数や、検索層のpost-filtering前候補数をここに
   * 入れると、返却hitとの差分から未認可文書の存在が漏れる(existence leak、
   * 監査ログでhitCountを禁止したのと同じ理由)。件数の提示が必要になった場合は
   * 「認可済み返却可能件数のみ」を意味する専用フィールドをADRで定義してから追加する。
   */
  /**
   * 続きのページの不透明なカーソル。結果の識別子・本文の断片・private の情報を符号化しない
   * (Gateway は中身を検査せずに LLM へ渡す。ADR-016 追補2 決定4)
   */
  nextCursor?: string;
}

export interface FetchResult {
  documentId: string;
  title: string;
  /** プレーンテキスト化した本文(1ページ分) */
  content: string;
  url: string;
  /** 長文のページング用 */
  nextPageCursor?: string;
  /**
   * 文書の領域(v0.4、ADR-016 追補2 決定2)。LLM は任意の documentId で fetch を
   * 呼べるため、search を絞るだけでは方針を守れない。判定できないものは "private"
   */
  scope: DocumentScope;
}

export interface ContainerEntry {
  id: string;
  name: string;
  kind: "folder" | "channel" | "repository" | "space" | "other";
  /**
   * 区画内の子の数。`privateScopes: excluded` では private の子を数えない(数えられないなら付けない)。
   * Gateway は childCount を補正しないため、private の件数が漏れる経路になる(ADR-016 追補2 決定4)
   */
  childCount?: number;
  /**
   * 区画の領域(v0.4、ADR-016 追補2 決定2。DM・プライベートチャンネル・個人の
   * フォルダ等は "private")。list と describe の topContainers の両方に付ける
   */
  scope: DocumentScope;
}

/** listの戻り値(ADR-016でページング対応)。 */
export interface ListResult {
  entries: ContainerEntry[];
  /** 続きがある場合のカーソル */
  /**
   * 続きのページの不透明なカーソル。結果の識別子・本文の断片・private の情報を符号化しない
   * (Gateway は中身を検査せずに LLM へ渡す。ADR-016 追補2 決定4)
   */
  nextCursor?: string;
}

export interface SourceDescription {
  sourceId: string;
  displayName: string;
  /** エージェントの初手選択を助ける、このソースの内容の説明 */
  summary: string;
  /** 主要な区画(共有ドライブ、スペース等)の一覧 */
  topContainers: ContainerEntry[];
  /** search が対応するフィルタ */
  supportedFilters: (keyof SearchFilters)[];
}

/** エラー分類。Gatewayのリトライ・監査ログの errorClass に対応する。 */
export type ConnectorErrorClass =
  | "auth_expired"
  | "permission_denied"
  | "rate_limited"
  | "not_found"
  | "source_unavailable"
  | "invalid_request"
  /**
   * 方針(excluded)によるプライベート領域の拒否(v0.4、ADR-016 追補2 決定4)。
   * Gateway は fetch の private の結果をこの分類で失敗させる。enforced のコネクタは
   * 自ら同じ分類で拒否してよい。本人が取得できない文書には従来どおり not_found /
   * permission_denied を返す(この分類を存在の推定に使わせない)
   */
  | "private_scope_excluded";

export class ConnectorError extends Error {
  constructor(
    public readonly errorClass: ConnectorErrorClass,
    message: string,
    /** rate_limited 時の再試行待機ms(Retry-After由来) */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

/**
 * コネクタの静的能力。deployment.yaml の検証(T-010)と
 * Orchestratorのソース選択が消費する(ADR-007)。
 * - nativeSearch "none" のソースは検索層が必須(index-required)であり、
 *   「全導入は検索層OFFで開始」の原則の適用外(ADR-007)。
 * - authzCheck / contentPersistence の追加はfitting検証を通してから
 *   判断する(ADR-012/014/016)。先回りで追加しない。
 * - privateScopeHandling(v0.4)は validate / 起動時に方針(SourcePolicy)と照合する
 *   (ADR-016 追補2 決定3)。describe(auth) は利用者の資格情報がないと呼べないため、
 *   静的な宣言としてここに置く。
 */
export interface ConnectorCapabilities {
  readonly nativeSearch: "full" | "degraded" | "none";
  /** ingest(全件/差分クロール)を実装しているか。IFはQ3に確定(ADR-006) */
  readonly ingest: boolean;
  /**
   * プライベート領域の扱い(v0.4)。宣言がないもの(v0.3)は "unsupported" と
   * みなす(privateScopeHandlingOf)
   */
  readonly privateScopeHandling: PrivateScopeHandling;
}

/** 全コネクタが実装する契約。 */
export interface Connector {
  readonly sourceId: string;
  readonly capabilities: ConnectorCapabilities;
  describe(auth: AuthContext): Promise<SourceDescription>;
  search(
    auth: AuthContext,
    query: string,
    filters?: SearchFilters,
    options?: SearchOptions,
  ): Promise<SearchResult>;
  fetch(
    auth: AuthContext,
    documentId: string,
    pageCursor?: string,
  ): Promise<FetchResult>;
  list(
    auth: AuthContext,
    containerId?: string,
    cursor?: string,
  ): Promise<ListResult>;
}
