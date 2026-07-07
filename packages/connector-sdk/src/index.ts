/**
 * connector-sdk v0.3: 全データソースコネクタが実装する共通インターフェース。
 * v0.2からの変更はADR-016(SearchOptions、listページング、snippet規約、redaction)。
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
}

export interface ContainerEntry {
  id: string;
  name: string;
  kind: "folder" | "channel" | "repository" | "space" | "other";
  childCount?: number;
}

/** listの戻り値(ADR-016でページング対応)。 */
export interface ListResult {
  entries: ContainerEntry[];
  /** 続きがある場合のカーソル */
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
  | "invalid_request";

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
 */
export interface ConnectorCapabilities {
  readonly nativeSearch: "full" | "degraded" | "none";
  /** ingest(全件/差分クロール)を実装しているか。IFはQ3に確定(ADR-006) */
  readonly ingest: boolean;
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
