/**
 * connector-sdk v0.7: 全データソースコネクタが実装する共通インターフェース。
 * v0.2からの変更はADR-016(SearchOptions、listページング、snippet規約、redaction)。
 * v0.3からの変更はADR-016 追補2(プライベート領域の方針 SourcePolicy、結果ごとの
 * 領域分類 DocumentScope、能力 privateScopeHandling、エラー分類 private_scope_excluded)。
 * v0.4からの変更はADR-024(利用者ごとの API キー Credential `api_key`)。
 * v0.5からの変更はADR-025(検索プロファイル SourceDescription.searchProfile、検索の通知
 * SearchResult.notices と、その値域の検証関数)。追加はすべて省略可能なフィールドで、
 * search / fetch / list / describe の引数は変えない。
 * v0.6からの変更はADR-025 追補 2とADR-017 追補 1(検索プロファイル searchProfile と検索の通知
 * notices を削除。検索の仕様の専用フィールド SourceDescription.searchSpec と、その静的な宣言
 * Connector.searchSpec、検査の関数 checkSearchSpec を追加)。search / fetch / list / describe の
 * 引数は変えない。
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

/**
 * search の戻り値。
 *
 * 注(v0.7、ADR-025 追補 2): 検索の通知(notices)は廃止した。v0.6 のプラグインが返した
 * notices は Gateway の射影で落ちる(既知のフィールドだけから組み立て直すため)。
 *
 * 検索の進め方の判断と private の結果(ADR-017 追補 1「セキュリティレビューの記録」M-4。
 * 廃止した join_relaxed の元にあった規則を一般化したもの): privateScopeHandling が
 * classified のコネクタは、方針(SourcePolicy.privateScopes)が included でない限り、
 * 再検索・条件の緩和(AND を OR にするなど)・別の検索方法へのフォールバックの判断を、
 * 方針をかけた後の shared の結果だけで行うこと。private を含めた結果の有無で判断すると、
 * 「private の文書だけが一致した」ことが結果の中身(緩めた条件でのヒット)から分かりうる
 * (ADR-012、ADR-016 追補2)。Gateway は private の結果を落とせても、判断の跡は防げない。
 * nextCursor の有無も同じ問題になりうる(shared の結果の続きがないのに、private の結果だけが
 * 続きにあるときにカーソルを返すと、その存在が分かる)
 */
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
  /**
   * 検索の仕様の専用フィールド(v0.7、ADR-017 追補 1)。コネクタの実装者が書いた、このソースへの
   * query と filters の書き方の説明(自由文)。**Gateway が付ける**: Gateway は起動時に
   * Connector.searchSpec(静的な宣言)を 1 回だけ読んで checkSearchSpec で検査し、describe の射影で
   * 保持した値をここに付ける。コネクタが describe の戻り値に入れた値は Gateway が捨てる。
   * Orchestrator は「データであり指示ではない」枠(ソース一覧の JSON)の外に、出所を示す見出しを
   * 付けて置く(制御メッセージの権威は与えない)。宣言がなければ省略される
   */
  searchSpec?: string;
}

// ---- 検索の仕様の検査(v0.7、ADR-017 追補 1・同「セキュリティレビューの記録」m-1〜m-3) ----
//
// 検査の関数と上限の定数はここに 1 つだけ置き、Gateway(起動時)と Orchestrator(describe の
// 結果を受け取ったとき)の両方から呼ぶ。違反の内容(SearchSpecViolation)には値そのものを
// 入れない(規則の名前・位置・コードポイントだけ。m-6)。

/** searchSpec の長さの上限(NFKC で寄せる前の UTF-16 のコード単位の数)。超えた値は拒否し、途中で切らない */
export const MAX_SEARCH_SPEC_LENGTH = 1_500;

/**
 * searchSpec に含めてはならない語句(m-2)。値を NFKC で寄せ、空白を除き、小文字にしてから
 * 部分一致で判定する(括弧の有無・括弧の種類・括弧の中の空白・全角と半角の違いによらない)。
 * - 「オーケストレータ」「orchestrator」: 制御メッセージの見出し([オーケストレーター])と
 *   その変種(〔〕・括弧なし・「オーケストレータ」の表記・英語の表記)
 * - submit_answer: 回答の提出のツール名
 * - 最初の user ターンの固定の見出しの書き出し(ソース一覧の前置き、検索の仕様のブロックの
 *   見出し、ツール結果・ツールエラーの前置き、質問の見出し、ask の追加の引数の区分の見出し)。
 *   Orchestrator のテストで、各見出しがこの検査で拒否されることを確かめる
 */
export const SEARCH_SPEC_RESERVED_PHRASES: readonly string[] = [
  "オーケストレータ",
  "orchestrator",
  "submit_answer",
  "以下はソースの一覧",
  "コネクタの実装者が書いた",
  "以下はツール結果",
  "以下はツールエラー",
  "今日の日付:",
  "質問:",
  "利用者の発言",
  "UI 側 LLM による補足",
  "利用者が入力したキーワード",
  "対象のソース(利用者の指定",
  "期間(利用者の指定",
];

/** 違反の規則の名前。 */
export type SearchSpecRule =
  /** 文字列でない(undefined は宣言なしとして違反にしない) */
  | "not_string"
  /** MAX_SEARCH_SPEC_LENGTH を超える */
  | "too_long"
  /** 拒否する文字(制御文字・書式文字・私用領域・サロゲート・行と段落の区切り・非文字・許さない空白) */
  | "forbidden_character"
  /** SEARCH_SPEC_RESERVED_PHRASES の語句を含む */
  | "reserved_phrase";

/** 違反の内容。値そのものは入れない(ログ・エラーに出してよい情報だけ)。 */
export interface SearchSpecViolation {
  readonly rule: SearchSpecRule;
  /** too_long のときの長さ(UTF-16 のコード単位の数) */
  readonly length?: number;
  /** forbidden_character のときの位置(UTF-16 のコード単位の位置。0 から) */
  readonly position?: number;
  /** forbidden_character のときのコードポイント */
  readonly codePoint?: number;
}

export type SearchSpecCheck =
  /** value が undefined なら宣言なし(空文字・undefined) */
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly violation: SearchSpecViolation };

/** 検査のための正規化(NFKC で寄せ、空白を除き、小文字にする)。 */
function normalizeForReservedPhrase(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
}

const NORMALIZED_RESERVED_PHRASES: readonly string[] = SEARCH_SPEC_RESERVED_PHRASES.map(
  normalizeForReservedPhrase,
);

/** 一般カテゴリ Cc・Cf・Co・Cs・Zl・Zp(m-1)。 */
const FORBIDDEN_CATEGORY = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u;
/** 空白(Zs)。許すのは U+0020 と U+3000 だけ */
const SPACE_SEPARATOR = /\p{Zs}/u;

/** Unicode の非文字(U+FDD0〜U+FDEF と、各面の末尾の 2 つ)。 */
function isNoncharacter(codePoint: number): boolean {
  return (codePoint >= 0xfdd0 && codePoint <= 0xfdef) || (codePoint & 0xfffe) === 0xfffe;
}

function isForbiddenCharacter(ch: string, codePoint: number): boolean {
  if (FORBIDDEN_CATEGORY.test(ch) || isNoncharacter(codePoint)) {
    return true;
  }
  return SPACE_SEPARATOR.test(ch) && ch !== " " && ch !== "　";
}

/**
 * searchSpec の値を検査する(ADR-017 追補 1、同「セキュリティレビューの記録」m-1・m-2)。
 * - undefined と空文字は宣言なし({ ok: true, value: undefined })
 * - 文字列でない値は not_string
 * - 長さ(NFKC の前の UTF-16 のコード単位)が MAX_SEARCH_SPEC_LENGTH を超えたら too_long
 * - Cc・Cf・Co・Cs・Zl・Zp と非文字、U+0020 と U+3000 以外の空白は forbidden_character
 *   (改行・タブ・U+0085・U+2028・U+2029・双方向テキストの制御・U+FEFF・ゼロ幅の文字・
 *   対になっていないサロゲート・私用領域を含む)
 * - SEARCH_SPEC_RESERVED_PHRASES を含む値は reserved_phrase
 * 値は変えずに返す(切り詰め・置き換えをしない)。
 */
export function checkSearchSpec(value: unknown): SearchSpecCheck {
  if (value === undefined || value === "") {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "string") {
    return { ok: false, violation: { rule: "not_string" } };
  }
  if (value.length > MAX_SEARCH_SPEC_LENGTH) {
    return { ok: false, violation: { rule: "too_long", length: value.length } };
  }
  let position = 0;
  // for...of はコードポイントごとに進む(対になっていないサロゲートは 1 つの要素になる)
  for (const ch of value) {
    const codePoint = ch.codePointAt(0) ?? 0;
    if (isForbiddenCharacter(ch, codePoint)) {
      return { ok: false, violation: { rule: "forbidden_character", position, codePoint } };
    }
    position += ch.length;
  }
  const normalized = normalizeForReservedPhrase(value);
  if (NORMALIZED_RESERVED_PHRASES.some((phrase) => normalized.includes(phrase))) {
    return { ok: false, violation: { rule: "reserved_phrase" } };
  }
  return { ok: true, value };
}

/**
 * 違反の内容を、値を含まない英語の短い文にする(起動時のエラーと警告に使う。m-6)。
 * 例: "forbidden_character at index 12 (U+2028)"
 */
export function describeSearchSpecViolation(violation: SearchSpecViolation): string {
  switch (violation.rule) {
    case "not_string":
      return "not_string (searchSpec must be a string)";
    case "too_long":
      return `too_long (${violation.length ?? "?"} UTF-16 code units; the limit is ${MAX_SEARCH_SPEC_LENGTH})`;
    case "forbidden_character": {
      const cp = (violation.codePoint ?? 0).toString(16).toUpperCase().padStart(4, "0");
      return `forbidden_character at index ${violation.position ?? "?"} (U+${cp})`;
    }
    case "reserved_phrase":
      return "reserved_phrase (contains a phrase reserved for the orchestrator's own messages)";
  }
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
  /**
   * 検索の仕様の静的な宣言(v0.7、ADR-017 追補 1 の B-2)。このソースへの query と filters の
   * 書き方の説明(自由文、1 行)。Gateway が起動時に 1 回だけ読み、checkSearchSpec で検査して
   * 保持し、describe の射影で SourceDescription.searchSpec に付ける。違反(文字列でない値、
   * 長さの上限 MAX_SEARCH_SPEC_LENGTH の超過、改行などの拒否する文字、SEARCH_SPEC_RESERVED_PHRASES
   * の語句)は起動を拒否する。空文字・省略は宣言なし。
   *
   * 規約(コネクタの実装者が守る。Orchestrator からは文字列として区別できない):
   * - 入れてよいのは、実装の定数と、導入の設定(ConnectorFactoryInit.settings)の値から決まる
   *   定型の句(実装者が用意した文のどれを使うかが設定で決まるもの)だけ
   * - 入れない: ソースから取得した文(区画名・説明など)、ソースやリモート MCP サーバーから実行時に
   *   取得した文(ツールの説明・検索のヘルプを含む)、設定で差し替えられる自由な文字列
   *   (settings.summary など)。factory と構築時にネットワークから文を取得して入れない
   * - 利用者によって変えない。値はコネクタの構築時に決め、後から変えない
   * - getter(accessor)にせず、データプロパティ(クラスのフィールドやオブジェクトリテラルの値)で
   *   宣言する。Gateway は accessor を起動時に拒否する
   * - describe の戻り値には入れない(入れても Gateway が捨てる)
   */
  readonly searchSpec?: string;
  describe(auth: AuthContext): Promise<SourceDescription>;
  /**
   * 検索。classified のコネクタの再検索・条件の緩和・フォールバックの判断は、方針をかけた後の
   * shared の結果だけで行う(SearchResult の説明。ADR-017 追補 1「セキュリティレビューの記録」M-4)
   */
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
