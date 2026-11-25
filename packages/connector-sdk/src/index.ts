/**
 * connector-sdk v0.6: 全データソースコネクタが実装する共通インターフェース。
 * v0.2からの変更はADR-016(SearchOptions、listページング、snippet規約、redaction)。
 * v0.3からの変更はADR-016 追補2(プライベート領域の方針 SourcePolicy、結果ごとの
 * 領域分類 DocumentScope、能力 privateScopeHandling、エラー分類 private_scope_excluded)。
 * v0.4からの変更はADR-024(利用者ごとの API キー Credential `api_key`)。
 * v0.5からの変更はADR-025(検索プロファイル SourceDescription.searchProfile、検索の通知
 * SearchResult.notices と、その値域の検証関数)。追加はすべて省略可能なフィールドで、
 * search / fetch / list / describe の引数は変えない。
 *
 * 不変条件(CLAUDE.md参照):
 * - すべての操作は AuthContext(利用者本人の資格情報)を受け取る。
 *   コネクタが独自にサービスアカウントへフォールバックしてはならない(方式はADR-010)。
 * - このIFはPhase 2で内部実装(ネイティブ検索→検索層)を差し替えるための
 *   安定境界である。変更にはADRが必要。
 * - AuthContext / Credential を直接シリアライズしない。ログには redactAuthContext() を使う。
 */

/**
 * 資格情報。認可方式はソースにより異なる(ADR-007/010)。新しい kind の追加にはADRが必要。
 * - oauth_bearer: OAuth系API(Drive, Slack等)
 * - api_key: 個人 API キーをヘッダー等で受け付けるソース(Redmine 等)
 * - delegated_identity: 本人としてのアクセス試行で認可されるソース
 *   (ファイル共有等)。semanticsはT-017のスパイクで確定するexperimental(ADR-007参照)。
 */
export type Credential =
  | {
      readonly kind: "oauth_bearer";
      /** ログ出力禁止(不変条件6)。redactAuthContext() を経由せずにシリアライズしない */
      readonly accessToken: string;
      /**
       * トークン失効時刻(epoch ms)。0 以下は「失効時刻不明」で、コネクタはこの値で失効を
       * 判定せずソースの 401 等に委ねる(ADR-016 追補3)
       */
      readonly expiresAt: number;
    }
  | {
      readonly kind: "api_key";
      /** ソース固有の個人 API キー(ADR-024)。ログ出力禁止(不変条件6) */
      readonly apiKey: string;
      /**
       * キーの失効時刻(epoch ms)。oauth_bearer と同じく 0 以下は「失効時刻不明」で、
       * 期限のない固定キーは 0 を入れる(ADR-016 追補3、ADR-024)
       */
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

/** SearchFilters のキーの値域(v0.6。値域の検証に使う)。 */
export const SEARCH_FILTER_KEYS = [
  "updatedAfter",
  "updatedBefore",
  "container",
  "author",
] as const satisfies readonly (keyof SearchFilters)[];
type AssertNever<T extends never> = T;
/** SEARCH_FILTER_KEYS が SearchFilters のキーを網羅することのコンパイル時の検査 */
export type SearchFilterKeysCoverFilters = AssertNever<
  Exclude<keyof SearchFilters, (typeof SEARCH_FILTER_KEYS)[number]>
>;

/** SearchFilters のキーか(実行時の値域の検証)。 */
export function isSearchFilterKey(value: unknown): value is keyof SearchFilters {
  return (SEARCH_FILTER_KEYS as readonly unknown[]).includes(value);
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
  /**
   * コネクタが語を捨てた・指定を無視したことの通知(v0.6、ADR-025 決定4)。列挙値だけで
   * 自由文を持たない。query と filters の形、および本人の資格情報でソースが返した(認可済みの)
   * 結果からだけ作る。認可前の候補の有無・件数から作らない。「権限がないため 0 件」と
   * 「本当に 0 件」を区別する情報を含めない(ADR-012)。Gateway は値域の外の値を落とす
   * (sanitizeSearchNotices)。監査(ToolInvocation)には記録しない(ADR-025 確認事項5)
   */
  notices?: SearchNotice[];
}

/** 検索の通知の種類(ADR-025 決定4)。 */
export const SEARCH_NOTICE_KINDS = [
  /** 語数の上限を超えた語を捨てた */
  "terms_dropped",
  /** 文字数の上限で query を切った */
  "query_truncated",
  /** 演算子・修飾子を解釈しなかった */
  "operator_ignored",
  /** filters の指定を使わなかった */
  "filter_ignored",
  /** AND で結果がなく、コネクタの中で OR に切り替えて再検索した */
  "join_relaxed",
] as const;
export type SearchNoticeKind = (typeof SEARCH_NOTICE_KINDS)[number];

export interface SearchNotice {
  readonly kind: SearchNoticeKind;
  /** terms_dropped のとき、使った語の数(query から数えられる値に限る。0〜MAX_SEARCH_LIMIT_VALUE) */
  readonly keptTerms?: number;
  /** filter_ignored のとき、使わなかったフィルタのキー */
  readonly filter?: keyof SearchFilters;
}

/** 1回の search で返せる通知の数の上限(種類とフィルタのキーの組み合わせの数より大きい) */
export const MAX_SEARCH_NOTICES = 10;

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
  /**
   * 検索の仕様(v0.6、ADR-025 決定1)。列挙値と数値だけで自由文を持たない。利用者の資格情報や
   * 検索の結果で値を変えない(決定3。コードの既定値と ConnectorFactoryInit.settings から作る)。
   * 省略時は全項目が不明として扱われる。Gateway と Orchestrator は sanitizeSearchProfile で
   * 値域の外の項目を落とす。導入先は deployment.yaml の connectors[].searchProfile で項目単位に
   * 上書きできる(Gateway が describe の射影で重ねる)
   */
  searchProfile?: SearchProfile;
}

// ---- 検索プロファイル(v0.6、ADR-025) ----
//
// 値域は下の定数で定義し、型はそこから導く。値域の検証(sanitizeSearchProfile /
// sanitizeSearchNotices)もこの定数を使う。Gateway の deployment.yaml のスキーマ
// (connectors[].searchProfile)も同じ定数から作る。列挙値の追加は SDK の版上げとして扱い、
// ADR-025 の追補に記録する(決定1)。

/** 値の根拠。tested = 実機で確かめた / documented = 公式文書・ソースコードで確かめた(実機では未確認) */
export const SEARCH_PROFILE_BASES = ["tested", "documented"] as const;
export type SearchProfileBasis = (typeof SEARCH_PROFILE_BASES)[number];

export interface SearchProfileItem<T> {
  readonly value: T;
  readonly basis: SearchProfileBasis;
}

/** OR 演算子 / NOT 演算子 / 語の前の - による除外 / 括弧によるまとまり */
export const SEARCH_OPERATORS = ["or", "not", "minus", "parentheses"] as const;
export type SearchOperator = (typeof SEARCH_OPERATORS)[number];

/** 修飾子が絞り込む対象 */
export const SEARCH_QUALIFIER_TARGETS = [
  "title",
  "body",
  "category",
  "tag",
  "author",
  "date",
  "state",
  "type",
] as const;
export type SearchQualifierTarget = (typeof SEARCH_QUALIFIER_TARGETS)[number];

/** 修飾子の名前の形式(ADR-025 決定1・確認事項4) */
export const SEARCH_QUALIFIER_NAME_PATTERN = /^[a-z][a-z_]{0,15}$/;
/** 1ソースの修飾子の数の上限(ADR-025 決定2) */
export const MAX_SEARCH_QUALIFIERS = 20;

export interface SearchQualifier {
  /** 修飾子の名前(例: "title")。SEARCH_QUALIFIER_NAME_PATTERN に限る。query には "<name>:" として書く */
  readonly name: string;
  /** 絞り込む対象 */
  readonly target: SearchQualifierTarget;
}

/** 上限の数値の範囲(ADR-025 決定1・2) */
export const MIN_SEARCH_LIMIT_VALUE = 1;
export const MAX_SEARCH_LIMIT_VALUE = 1_000;

/** 超過時の挙動。dropped = 超えた分を黙って捨てる / truncated = 途中で切る / error = エラーを返す */
export const SEARCH_LIMIT_OVERFLOWS = ["dropped", "truncated", "error", "unknown"] as const;
export type SearchLimitOverflow = (typeof SEARCH_LIMIT_OVERFLOWS)[number];

export interface SearchLimit {
  /** MIN_SEARCH_LIMIT_VALUE 以上 MAX_SEARCH_LIMIT_VALUE 以下の整数 */
  readonly limit: number;
  readonly overflow: SearchLimitOverflow;
}

/** 列挙値の項目の値域 */
export const SEARCH_PROFILE_ENUM_VALUES = {
  /** 空白で区切った語の結合。and = すべて含む / or = いずれかを含む */
  termJoin: ["and", "or", "unknown"],
  /** 照合の単位。substring = 部分文字列 / token = 語(バックエンドの分割規則による) */
  matchUnit: ["substring", "token", "unknown"],
  /** 自然文の質問をそのまま渡したときに意味の近い文書を返すか(Slack の意味検索など) */
  naturalLanguage: ["supported", "unsupported", "unknown"],
  /** "…" による語句の完全一致 */
  phraseQuote: ["supported", "unsupported", "unknown"],
  /** 並び順。relevance = 関連度 / recency = 更新の新しい順 */
  ranking: ["relevance", "recency", "unknown"],
  /** スニペットの種類。match_context = 一致箇所の周辺 / leading_text = 本文の先頭 / mixed = 結果の種別による */
  snippet: ["match_context", "leading_text", "mixed", "none"],
} as const;
type EnumValues = typeof SEARCH_PROFILE_ENUM_VALUES;
export type SearchProfileEnumKey = keyof EnumValues;

/** 上限の項目 */
export const SEARCH_PROFILE_LIMIT_KEYS = ["maxTerms", "maxQueryChars", "maxOperators"] as const;
export type SearchProfileLimitKey = (typeof SEARCH_PROFILE_LIMIT_KEYS)[number];

export interface SearchProfile {
  readonly termJoin?: SearchProfileItem<EnumValues["termJoin"][number]>;
  readonly matchUnit?: SearchProfileItem<EnumValues["matchUnit"][number]>;
  readonly naturalLanguage?: SearchProfileItem<EnumValues["naturalLanguage"][number]>;
  readonly phraseQuote?: SearchProfileItem<EnumValues["phraseQuote"][number]>;
  /** query の中に書ける演算子 */
  readonly operators?: SearchProfileItem<readonly SearchOperator[]>;
  /** query の中に書ける修飾子(名前は制約付き、対象は列挙値) */
  readonly qualifiers?: SearchProfileItem<readonly SearchQualifier[]>;
  /** 上限と超過時の挙動 */
  readonly maxTerms?: SearchProfileItem<SearchLimit>;
  readonly maxQueryChars?: SearchProfileItem<SearchLimit>;
  readonly maxOperators?: SearchProfileItem<SearchLimit>;
  readonly ranking?: SearchProfileItem<EnumValues["ranking"][number]>;
  /** タイトルに語を含む文書を上位にするか */
  readonly titleBoost?: SearchProfileItem<boolean>;
  readonly snippet?: SearchProfileItem<EnumValues["snippet"][number]>;
}

/** 検索プロファイルの項目名(値域の検証と上書きの単位) */
export const SEARCH_PROFILE_KEYS = [
  "termJoin",
  "matchUnit",
  "naturalLanguage",
  "phraseQuote",
  "operators",
  "qualifiers",
  "maxTerms",
  "maxQueryChars",
  "maxOperators",
  "ranking",
  "titleBoost",
  "snippet",
] as const satisfies readonly (keyof SearchProfile)[];
export type SearchProfileKey = (typeof SEARCH_PROFILE_KEYS)[number];
/** SEARCH_PROFILE_KEYS が SearchProfile の項目を網羅することのコンパイル時の検査 */
export type SearchProfileKeysCoverProfile = AssertNever<
  Exclude<keyof SearchProfile, SearchProfileKey>
>;

type UnknownRecord = Readonly<Record<string, unknown>>;

function plainRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isLimitValue(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_SEARCH_LIMIT_VALUE &&
    value <= MAX_SEARCH_LIMIT_VALUE
  );
}

/** 修飾子の名前が形式に合うか(ADR-025 決定1)。 */
export function isSearchQualifierName(value: unknown): value is string {
  return typeof value === "string" && SEARCH_QUALIFIER_NAME_PATTERN.test(value);
}

/**
 * 1項目の値を値域で検証し、正規化した値を返す。値域の外・型の違い・形式違反は undefined
 * (呼び出し側が項目ごと落とす)。配列は重複を除き、要素に1つでも違反があれば項目ごと落とす。
 */
function itemValueOf(key: SearchProfileKey, value: unknown): unknown {
  switch (key) {
    case "termJoin":
    case "matchUnit":
    case "naturalLanguage":
    case "phraseQuote":
    case "ranking":
    case "snippet":
      return isOneOf<string>(SEARCH_PROFILE_ENUM_VALUES[key], value) ? value : undefined;
    case "titleBoost":
      return typeof value === "boolean" ? value : undefined;
    case "operators":
      if (!Array.isArray(value) || !value.every((op) => isOneOf(SEARCH_OPERATORS, op))) {
        return undefined;
      }
      return [...new Set(value as SearchOperator[])];
    case "qualifiers": {
      if (!Array.isArray(value) || value.length > MAX_SEARCH_QUALIFIERS) {
        return undefined;
      }
      const qualifiers: SearchQualifier[] = [];
      for (const raw of value) {
        const record = plainRecord(raw);
        const name = record?.["name"];
        const target = record?.["target"];
        if (!isSearchQualifierName(name) || !isOneOf(SEARCH_QUALIFIER_TARGETS, target)) {
          return undefined;
        }
        if (!qualifiers.some((q) => q.name === name && q.target === target)) {
          qualifiers.push({ name, target });
        }
      }
      return qualifiers;
    }
    case "maxTerms":
    case "maxQueryChars":
    case "maxOperators": {
      const record = plainRecord(value);
      const limit = record?.["limit"];
      const overflow = record?.["overflow"];
      if (!isLimitValue(limit) || !isOneOf(SEARCH_LIMIT_OVERFLOWS, overflow)) {
        return undefined;
      }
      return { limit, overflow };
    }
  }
}

/**
 * 検索プロファイルを SDK の値域で検証し、既知の項目のうち値域を満たすものだけから組み立て
 * 直す(ADR-025 決定2)。未知の項目・項目の未知のフィールドは捨て、値域の外の値・型の違う値・
 * 修飾子の名前の形式違反・MAX_SEARCH_QUALIFIERS を超える修飾子・根拠(basis)の欠落や不正は
 * 項目ごと落とす(=不明)。プロファイルがオブジェクトでない・有効な項目が1つもないときは undefined。
 */
export function sanitizeSearchProfile(value: unknown): SearchProfile | undefined {
  const record = plainRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const out: Record<string, SearchProfileItem<unknown>> = {};
  for (const key of SEARCH_PROFILE_KEYS) {
    const item = plainRecord(record[key]);
    const basis = item?.["basis"];
    if (item === undefined || !isOneOf(SEARCH_PROFILE_BASES, basis)) {
      continue;
    }
    const itemValue = itemValueOf(key, item["value"]);
    if (itemValue !== undefined) {
      out[key] = { value: itemValue, basis };
    }
  }
  return Object.keys(out).length > 0 ? (out as SearchProfile) : undefined;
}

/**
 * 検索プロファイルに導入先の上書きを項目単位で重ねる(ADR-025 決定3)。上書きに書かれた項目は
 * コネクタの値を置き換え、書かれていない項目はコネクタの値のまま。どちらも検証済みの値を渡す。
 */
export function mergeSearchProfile(
  base: SearchProfile | undefined,
  override: SearchProfile | undefined,
): SearchProfile | undefined {
  if (override === undefined) {
    return base;
  }
  const merged: Record<string, unknown> = {};
  for (const key of SEARCH_PROFILE_KEYS) {
    const item = override[key] ?? base?.[key];
    if (item !== undefined) {
      merged[key] = item;
    }
  }
  return Object.keys(merged).length > 0 ? (merged as SearchProfile) : undefined;
}

/**
 * 検索の通知を値域で検証して組み立て直す(ADR-025 決定4)。未知の kind・型の違う要素は落とし、
 * keptTerms は terms_dropped のときの 0〜MAX_SEARCH_LIMIT_VALUE の整数だけ、filter は
 * filter_ignored のときの SearchFilters のキーだけを残す。それ以外のフィールドは捨てる。
 * 重複を除き、MAX_SEARCH_NOTICES 件までにする。有効な通知がなければ undefined。
 */
export function sanitizeSearchNotices(value: unknown): SearchNotice[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: SearchNotice[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const record = plainRecord(raw);
    const kind = record?.["kind"];
    if (record === undefined || !isOneOf(SEARCH_NOTICE_KINDS, kind)) {
      continue;
    }
    const keptTerms = record["keptTerms"];
    const filter = record["filter"];
    const notice: SearchNotice = {
      kind,
      ...(kind === "terms_dropped" &&
      typeof keptTerms === "number" &&
      Number.isInteger(keptTerms) &&
      keptTerms >= 0 &&
      keptTerms <= MAX_SEARCH_LIMIT_VALUE
        ? { keptTerms }
        : {}),
      ...(kind === "filter_ignored" && isSearchFilterKey(filter) ? { filter } : {}),
    };
    const key = `${notice.kind}:${notice.filter ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(notice);
    if (out.length >= MAX_SEARCH_NOTICES) {
      break;
    }
  }
  return out.length > 0 ? out : undefined;
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
