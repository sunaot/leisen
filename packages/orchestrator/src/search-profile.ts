/**
 * 検索プロファイル(connector-sdk v0.6、ADR-025)と検索の通知(SearchResult.notices)から、探索 LLM に
 * 渡す制御メッセージの文をテンプレートで作る(T-030)。
 *
 * - 信頼区分(ADR-025 決定2): ここで作る文は Orchestrator 自身が書いた文として、`[オーケストレーター]`
 *   で始まる制御メッセージと同じ扱いで最初の user ターン・ツール結果の後ろに置く(system prompt には
 *   入れない)。そのため文の材料は、SDK の値域で検証した列挙値・数値・形式を制限した修飾子の名前
 *   (/^[a-z][a-z_]{0,15}$/)と、Gateway のツール定義(deployment.yaml)由来の sourceId だけにする。
 *   コネクタが書いた自由な文字列(summary・displayName・区画名など)を入れない(TM-D4)。列挙値ごとの
 *   文は下の固定の表から選ぶ
 * - 根拠(basis)が documented の項目には「公式の文書・ソースコードによる。実機では未確認」を添える。
 *   値が unknown の項目は「不明」と書く(確認事項3)
 * - 判定(検索の仕様に照らした語数の上限の超過・空白のない文のままのクエリ・非対応のフィルタ)は、
 *   探索 LLM が送った query・filters と、describe で得た仕様だけから行う。通知(notices)の文は
 *   Gateway が値域で検証した列挙値から作る。どちらも未認可の候補の有無・件数を扱わない(ADR-012。
 *   Orchestrator はそれを持たない)
 * - 文言はプロンプトの一部(prompt.ts の運用規則)。explore.v4 と同じく評価未実施で、既定の v3 では
 *   使わない(検索プロファイルの文は explore.v4 のとき、判定と通知は searchFeedback が有効なとき)
 */
import {
  MAX_SEARCH_LIMIT_VALUE,
  type SearchFilters,
  type SearchLimit,
  type SearchNotice,
  type SearchOperator,
  type SearchProfile,
  type SearchProfileBasis,
  type SearchProfileEnumKey,
  type SearchProfileItem,
  type SearchQualifierTarget,
} from "@leisen/connector-sdk";

/** documented の項目に添える句(ADR-025 決定2・確認事項3)。 */
export const DOCUMENTED_SUFFIX = "(公式の文書・ソースコードによる。実機では未確認)";

/** 検索の仕様の制御メッセージの見出し。 */
export const SEARCH_PROFILE_HEADING =
  "[オーケストレーター] 各ソースの検索の仕様(オーケストレーターがソースの検索プロファイルから作った文。ソース一覧の summary の記述と食い違う場合はこちらを優先する):";

type EnumText<K extends SearchProfileEnumKey> = Readonly<
  Record<NonNullable<SearchProfile[K]>["value"], string>
>;

const TERM_JOIN_TEXT: EnumText<"termJoin"> = {
  and: "空白で区切った語は、すべてを含む文書だけが返る(AND)",
  or: "空白で区切った語は、いずれかを含む文書が返る(OR)",
  unknown: "語の結合(すべて含む / いずれかを含む)は不明",
};

const MATCH_UNIT_TEXT: EnumText<"matchUnit"> = {
  substring: "語は部分文字列として照合し、空白のない文は全体が 1 語になる",
  token: "語は検索エンジンが分割した単語の単位で照合する",
  unknown: "照合の単位(部分一致 / 単語)は不明",
};

const NATURAL_LANGUAGE_TEXT: EnumText<"naturalLanguage"> = {
  supported: "自然文の質問をそのまま渡すと、意味の近い文書が返る",
  unsupported: "自然文の質問をそのまま渡しても意味では検索せず、語の照合だけを行う",
  unknown: "自然文の質問での意味検索の可否は不明",
};

const PHRASE_QUOTE_TEXT: EnumText<"phraseQuote"> = {
  supported: "\"…\" で囲んだ語句は、その並びのまま照合する",
  unsupported: "\"…\" による語句の照合はない(引用符も文字として扱われうる)",
  unknown: "\"…\" による語句の照合の可否は不明",
};

const RANKING_TEXT: EnumText<"ranking"> = {
  relevance: "並び順は関連度の高い順",
  recency: "並び順は関連度ではなく更新の新しい順",
  unknown: "並び順は不明",
};

const SNIPPET_TEXT: EnumText<"snippet"> = {
  match_context: "スニペットは一致箇所の周辺",
  leading_text: "スニペットは本文の先頭で、一致箇所とは限らない",
  mixed: "スニペットの種類は結果の種別によって異なる",
  none: "スニペットはない",
};

const OPERATOR_TEXT: Readonly<Record<SearchOperator, string>> = {
  or: "OR(いずれかを含む)",
  not: "NOT(除外)",
  minus: "語の前の -(除外)",
  parentheses: "( ) によるまとまり",
};

const QUALIFIER_TARGET_TEXT: Readonly<Record<SearchQualifierTarget, string>> = {
  title: "タイトル",
  body: "本文",
  category: "カテゴリ",
  tag: "タグ・ラベル",
  author: "作成者",
  date: "日付",
  state: "状態",
  type: "種別",
};

const OVERFLOW_TEXT: Readonly<Record<SearchLimit["overflow"], string>> = {
  dropped: "超えた分は黙って捨てられる",
  truncated: "超えた分は切られる",
  error: "超えるとエラーになる",
  unknown: "超えたときの挙動は不明",
};

const FILTER_TEXT: Readonly<Record<keyof SearchFilters, string>> = {
  updatedAfter: "updatedAfter",
  updatedBefore: "updatedBefore",
  container: "container",
  author: "author",
};

function withBasis(text: string, basis: SearchProfileBasis): string {
  return basis === "documented" ? `${text}${DOCUMENTED_SUFFIX}` : text;
}

/** 列挙値の項目の文。値が unknown のときは根拠を添えない(不明と書くだけ)。 */
function enumSentence<K extends SearchProfileEnumKey>(
  item: SearchProfileItem<NonNullable<SearchProfile[K]>["value"]> | undefined,
  table: EnumText<K>,
): string | undefined {
  if (item === undefined) {
    return undefined;
  }
  const value = item.value as keyof EnumText<K>;
  const text = table[value];
  return value === "unknown" ? text : withBasis(text, item.basis);
}

function limitSentence(
  item: SearchProfileItem<SearchLimit> | undefined,
  head: (limit: number) => string,
): string | undefined {
  if (item === undefined) {
    return undefined;
  }
  // 値域の検証済みだが、文の材料にする数値は念のため整数の範囲に限る
  const limit = Math.min(Math.max(1, Math.trunc(item.value.limit)), MAX_SEARCH_LIMIT_VALUE);
  return withBasis(`${head(limit)}(${OVERFLOW_TEXT[item.value.overflow]})`, item.basis);
}

/** 修飾子の名前を文に入れる前の再検査(値域の外なら文に入れない)。 */
const QUALIFIER_NAME = /^[a-z][a-z_]{0,15}$/;

/**
 * 1ソースの検索プロファイルを定型文の組み合わせにする。プロファイルがない(v0.5 以前の
 * コネクタ)・有効な項目がないときは undefined(従来どおり summary だけを使う)。
 * termJoin と matchUnit は項目がなくても「不明」と書く(空白の解釈が最も効くため)。
 */
export function searchProfileSentences(profile: SearchProfile | undefined): string[] | undefined {
  if (profile === undefined || Object.keys(profile).length === 0) {
    return undefined;
  }
  const sentences: (string | undefined)[] = [
    enumSentence<"termJoin">(profile.termJoin, TERM_JOIN_TEXT) ?? TERM_JOIN_TEXT.unknown,
    enumSentence<"matchUnit">(profile.matchUnit, MATCH_UNIT_TEXT) ?? MATCH_UNIT_TEXT.unknown,
    enumSentence<"naturalLanguage">(profile.naturalLanguage, NATURAL_LANGUAGE_TEXT),
    enumSentence<"phraseQuote">(profile.phraseQuote, PHRASE_QUOTE_TEXT),
  ];
  if (profile.operators !== undefined) {
    const ops = profile.operators.value.filter((op) => Object.hasOwn(OPERATOR_TEXT, op));
    sentences.push(
      withBasis(
        ops.length === 0
          ? "query の中で使える演算子はない(OR・- などの記号も語として扱われる)"
          : `query の中で使える演算子は ${ops.map((op) => OPERATOR_TEXT[op]).join("、")}`,
        profile.operators.basis,
      ),
    );
  }
  if (profile.qualifiers !== undefined) {
    const qualifiers = profile.qualifiers.value.filter(
      (q) => QUALIFIER_NAME.test(q.name) && Object.hasOwn(QUALIFIER_TARGET_TEXT, q.target),
    );
    sentences.push(
      withBasis(
        qualifiers.length === 0
          ? "query に書ける修飾子はない"
          : `query に書ける修飾子は ${qualifiers
              .map((q) => `${q.name}:(${QUALIFIER_TARGET_TEXT[q.target]})`)
              .join("、")}`,
        profile.qualifiers.basis,
      ),
    );
  }
  sentences.push(
    limitSentence(profile.maxTerms, (n) => `使われるのは先頭 ${n} 語まで`),
    limitSentence(profile.maxQueryChars, (n) => `query は ${n} 文字まで`),
    limitSentence(profile.maxOperators, (n) => `演算子は ${n} 個まで`),
    enumSentence<"ranking">(profile.ranking, RANKING_TEXT),
  );
  if (profile.titleBoost !== undefined) {
    sentences.push(
      withBasis(
        profile.titleBoost.value
          ? "タイトルに語を含む文書が上位になる"
          : "タイトルに語を含むかは順位に影響しない",
        profile.titleBoost.basis,
      ),
    );
  }
  sentences.push(enumSentence<"snippet">(profile.snippet, SNIPPET_TEXT));
  return sentences.filter((s): s is string => s !== undefined);
}

/**
 * 最初の user ターンに置く「各ソースの検索の仕様」の制御メッセージ。検索プロファイルを持つ
 * ソースが1つもなければ undefined(ブロックを置かない)。sourceId は Gateway のツール定義
 * (deployment.yaml)由来の値。
 */
export function renderSearchProfiles(
  sources: readonly { readonly sourceId: string; readonly searchProfile?: SearchProfile }[],
): string | undefined {
  const lines: string[] = [];
  for (const source of sources) {
    const sentences = searchProfileSentences(source.searchProfile);
    if (sentences !== undefined) {
      lines.push(`- ${source.sourceId}: ${sentences.join("。")}。`);
    }
  }
  return lines.length > 0 ? [SEARCH_PROFILE_HEADING, ...lines].join("\n") : undefined;
}

// ---------------------------------------------------------------------------
// 検索の通知(SearchResult.notices)と、検索の仕様に照らした判定の文
// ---------------------------------------------------------------------------

/** コネクタからの通知の文(列挙値ごとの定型文。数値とフィルタのキーだけを差し込む)。 */
export function searchNoticeText(source: string, notice: SearchNotice): string {
  switch (notice.kind) {
    case "terms_dropped":
      return notice.keptTerms !== undefined
        ? `[オーケストレーター] ${source} は語数の上限を超えたため、先頭 ${Math.trunc(notice.keptTerms)} 語だけで検索した(残りの語は使われていない)。大事な語を前に置くか、語を減らして検索し直す。`
        : `[オーケストレーター] ${source} は語数の上限を超えたため、一部の語を使わずに検索した。大事な語を前に置くか、語を減らして検索し直す。`;
    case "query_truncated":
      return `[オーケストレーター] ${source} は文字数の上限で query を途中で切って検索した。短い query で検索し直す。`;
    case "operator_ignored":
      return `[オーケストレーター] ${source} は query の演算子・修飾子を解釈しなかった。演算子・修飾子を使わずに語だけで検索し直すか、言い換えを別の検索に分ける。`;
    case "filter_ignored":
      return notice.filter !== undefined
        ? `[オーケストレーター] ${source} は filters の ${FILTER_TEXT[notice.filter]} を使わずに検索した(結果はその条件で絞られていない)。`
        : `[オーケストレーター] ${source} は filters の指定の一部を使わずに検索した(結果はその条件で絞られていない)。`;
    case "join_relaxed":
      return `[オーケストレーター] ${source} は、すべての語を含む文書がなかったため、いずれかの語を含む文書を検索し直した結果を返した。結果がすべての語を含むとは限らない。`;
  }
}

/** query の語(空白区切り。"…" の語句は 1 語)。 */
function queryTokens(query: string): string[] {
  return [...query.normalize("NFKC").matchAll(/"[^"]*"|[^\s"]+/gu)]
    .map((m) => m[0])
    .filter((token) => token.replace(/"/g, "").trim() !== "");
}

/**
 * 語数の上限と比べる語の数。重複を除き、プロファイルが演算子として認める語(OR・NOT)は数えない
 * (演算子のないソースでは OR も語として数える)。
 */
export function countQueryTerms(query: string, profile: SearchProfile | undefined): number {
  const operators = new Set(profile?.operators?.value ?? []);
  const words = queryTokens(query).filter(
    (token) =>
      !(operators.has("or") && (token === "OR" || token === "|")) &&
      !(operators.has("not") && token === "NOT"),
  );
  return new Set(words).size;
}

/** 文とみなすひらがなの数と長さの下限(名詞の複合語を文と誤らないため)。 */
const SENTENCE_MIN_CHARS = 12;
const SENTENCE_MIN_HIRAGANA = 3;

/**
 * 空白のない文のままの query か: 空白(引用符の外)がなく、12 文字以上で、ひらがなを 3 文字以上
 * 含む(助詞・活用語尾を含む日本語の文)。引用符で囲んだ語句は利用者の入力した語句でありうるため
 * 対象にしない。
 */
export function isUnspacedSentence(query: string): boolean {
  const text = query.normalize("NFKC").trim();
  if (text === "" || /\s/u.test(text) || text.includes('"')) {
    return false;
  }
  const chars = [...text];
  const hiragana = chars.filter((ch) => /\p{Script=Hiragana}/u.test(ch)).length;
  return chars.length >= SENTENCE_MIN_CHARS && hiragana >= SENTENCE_MIN_HIRAGANA;
}

/** 語数の上限の超過(コネクタが terms_dropped を返さなかったとき)。 */
export function termLimitNotice(
  source: string,
  quotedQuery: string,
  terms: number,
  item: SearchProfileItem<SearchLimit>,
): string {
  const limit = Math.min(Math.max(1, Math.trunc(item.value.limit)), MAX_SEARCH_LIMIT_VALUE);
  return `[オーケストレーター] ${source} への検索 ${quotedQuery} は語が ${terms} 個で、このソースの語数の上限 ${limit} 語を超えている(${OVERFLOW_TEXT[item.value.overflow]}${
    item.basis === "documented" ? "。公式の文書・ソースコードによる。実機では未確認" : ""
  })。大事な語を前に置くか、語を減らすか、検索を分ける。`;
}

/** 空白のない文のまま検索してヒットがなかったとき。 */
export function unspacedSentenceNotice(
  source: string,
  quotedQuery: string,
  profile: SearchProfile,
): string {
  const reason =
    profile.matchUnit?.value === "substring"
      ? "このソースは語を部分文字列として照合するため、文全体が 1 つの語として扱われる"
      : "このソースは自然文の質問で意味の検索をしない";
  return `[オーケストレーター] ${source} への検索 ${quotedQuery} は空白のない文のままだった。${reason}。文書に出てきそうな語(名詞など)を空白で区切って検索し直す。`;
}

/** ソースが対応していない filters を指定したとき。 */
export function unsupportedFilterNotice(
  source: string,
  filters: readonly (keyof SearchFilters)[],
): string {
  return `[オーケストレーター] ${source} は filters の ${filters
    .map((f) => FILTER_TEXT[f])
    .join("、")} に対応していない(ソース一覧の supportedFilters にない)。その filters を外し、query の語で絞る。`;
}
