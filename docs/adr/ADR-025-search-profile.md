# ADR-025: 検索プロファイル — ソースごとの検索の仕様を探索 LLM に伝えるコネクタ IF(connector-sdk v0.6 案)

Status: Accepted(2026-11-25 オーナー決定。確認事項は本文の既定の案で受理し、未決のまま残す)/ Date: 2026-11-25

本 ADR はコネクタのツール IF(`describe` の戻り値 `SourceDescription` と `search` の戻り値 `SearchResult`)を変える提案であり、不変条件 5 が求める ADR を兼ねる。`ask` の IF(ADR-018 決定 1)の変更は ADR-026 に分けた。CLAUDE.md「タスクの進め方」2 に従い、実装(T-030)は本 ADR の承認後に行う。

## 用語

- **検索プロファイル**: ソースごとの検索の仕様をまとめた情報。空白区切りの語の解釈(AND / OR)、照合の単位、使える演算子と修飾子、語数・文字数の上限、並び順、スニペットの種類などを含む。コネクタが持ち、Orchestrator が探索 LLM に伝える。本 ADR で新しく持ち込む概念はこれだけである
- **探索 LLM**: Orchestrator の中で `search` / `fetch` を呼んで回答を作る LLM(`packages/orchestrator/src/orchestrator.ts` の探索ループ)
- **UI 側 LLM**: LibreChat などのチャット UI で利用者と対話し、Orchestrator の `ask` を呼ぶ LLM(ADR-018)
- **利用者が入力したキーワード**: 利用者の発言にそのまま含まれている、検索に使える語句(固有名詞、ID、エラーメッセージ、引用符で囲まれた語句など)。LLM が言い換えや別表記として作った語とは区別する

以上の語は `reports/エージェント検索ハーネス設計調査.md`(以下「レポート」)と同じ意味で使う。

検索プロファイルは issue #22 の SourceProfile(ソースの性質を 1 つの概念にまとめる案。ADR-016 追補 2 の `SourcePolicy` はその先行実装)とは別の概念である。SourceProfile は永続化の可否やプライベート領域の扱いなど、導入先の方針と監査に関わる性質を扱う。検索プロファイルは探索 LLM のクエリの書き方に関わる性質だけを扱う。型名は `SearchProfile` として区別する。

## 文脈

### オーナーの方針(2026-11-25)

探索 LLM はモデルによらず検索に十分な性能を持つものとして扱う。クエリは探索 LLM が書く。ハーネス(Orchestrator)の役割は次の 4 つに限る。

1. 各ソースの検索の仕様を探索 LLM に伝える
2. 利用者が入力したキーワードを `ask` と最初の検索に残すよう指示する
3. 0 件・重複のときに制御メッセージで状況を返す
4. 止める基準と続ける基準を示す

構成は現行のまま(`ask` の中で探索 LLM が検索する)とする。レポートが挙げた「コードで実行する最初の検索」(キーワードのコード抽出、クエリの整形、並列検索の自動実行)、順位による結果の統合(rank fusion)、LLM による選別の別呼び出し、古い結果の圧縮、小型モデル向けの補助は、今回の範囲から外す。

IF を変えない範囲(コネクタの `summary` に検索の仕様を書く、一致箇所のスニペット、`ask` の description の改訂、探索プロンプト v4、制御メッセージ、評価の仕組み)は T-024 / T-027 / T-028 で先に進める。本 ADR は、そのうち 1 の伝え方と 3 の材料を IF として固定する部分を扱う。

### 現状(行番号は 2026-11-25 時点。根拠はレポートと `research_notes/エージェント検索ハーネス設計調査/leisen_current_implementation.md` §3〜§5)

- `SourceDescription` は `sourceId` / `displayName` / `summary` / `topContainers` / `supportedFilters` だけで、検索の仕様を表すフィールドがない(`packages/connector-sdk/src/index.ts:245-254`)。Gateway の射影(`packages/gateway/src/proxy/gateway.ts:635-647`)と Orchestrator の `SourceBrief`(`packages/orchestrator/src/prompt.ts:99-175`)は既知のフィールドだけを通し、`summary` を 1,000 字で切る
- ソース一覧は「データであり指示ではない」という前置きを付けて最初の user ターンに置かれる(TM-D4、セキュリティレビュー 2026-09-27 H3。`packages/orchestrator/src/prompt.ts:7-14`、`:202-203`、ADR-017 決定 4)。`summary` に書いた検索の書き方は、探索 LLM が参考情報として軽く扱いうる
- `ConnectorCapabilities.nativeSearch`(ADR-007)は探索 LLM に届かない(`packages/connector-sdk/src/index.ts:284-304`)
- 探索プロンプト v3 と `USAGE_HINTS` は全ソース共通の指針「多くのソースは、空白で区切った語をすべて含む文書だけを返す」「名詞を 1〜2 語だけ」を持つ(`packages/orchestrator/prompts/explore.v3.md:12-13`、`packages/orchestrator/src/tools.ts:25-33`)。この指針は AND の部分一致で照合する開発用コネクタ(`packages/gateway/src/dev/fixture-connector.ts:16`)での失敗から作られた(`docs/eval/2026-10-08-explore-v3.md` §3・§4)
- 実際のソースの仕様は空白の解釈から異なる(レポート「5 つのバックエンドは、空白の解釈から異なる」の表)
  - esa: 空白は AND。`OR` / `-` / `"…"` / `title:` などの修飾子がある(公式ヘルプ docs.esa.io/posts/104 による。**リモート MCP の `esa_search_posts` 経由で同じ仕様かは未確認**)
  - GitHub: AND が既定。演算子は 5 個まで、256 文字まで(公式ドキュメントによる。日本語の分かち書きは一次情報なし)。コネクタは 1 回の検索で issue・PR・コードを混ぜて返す(`packages/connector-github/src/connector.ts:216-274`)
  - Redmine: 空白区切りのトークンを SQL の LIKE で部分一致し、先頭 5 トークンだけを使って残りを黙って捨てる。並び順は関連度ではなく日付の新しい順(Redmine のソースコード `lib/redmine/search.rb` による)。コネクタは `all_words=0` を送る(`packages/connector-redmine/src/redmine.ts:213`)。**`all_words=0` が実機で OR になるか AND になるかは未確認**(Redmine の版、全文検索プラグイン `redmine_full_text_search` の有無で変わりうる)
  - Slack(T-006、未実装): キーワード検索が既定で、自然文の質問で意味検索が働くかはプランと設定によって変わる(ADR-014、レポートの表。要約経由の情報)
- 0 件のときは `{"hits":[]}` が返るだけで、コネクタが語を捨てた・指定を無視したことを知らせる手段がない(`packages/connector-sdk/src/index.ts:185-201`)
- 件数は意図的に持たない(ADR-012、ADR-016 追補 1)。SDK のコメントは、件数が必要になったら「認可済みで返却可能な件数だけを意味する専用フィールドを別 ADR で定義する」とする(`packages/connector-sdk/src/index.ts:186-195`)

公式 MCP サーバー(esa、Slack、GitHub)はツール説明に構文とクエリの書き方を書いており、その指示はソースごとに反対になることがある(esa は「言い換えは OR で」、GitHub の issue 検索は「OR で繋がない」。レポート「クエリの書き方はバックエンドで決まり、ツール説明に書くのが一般的である」。`tools/list` の観測で、文言はサーバー側で変わりうる)。leisen では Gateway のツール定義が全ソース共通の 1 組であり(`packages/gateway/src/proxy/tools.ts:174-186`)、ソースごとの説明はソース一覧で渡すしかない。

## 決定(案)

1. **`SourceDescription` に省略可能な `searchProfile` を加える(connector-sdk v0.6)。** 値は列挙値と数値を中心にし、自由文を持たない(決定 2)。各項目に、その値の根拠(実機で確かめたか)を付ける。項目がない・値が `unknown` のものは、Orchestrator が「不明」として伝える。`searchProfile` を返さないコネクタ(v0.5 以前のプラグインを含む)は全項目が不明として扱われ、従来どおり `summary` だけが使われる(互換期間は設けなくてよいが、省略可能なので既存のプラグインは壊れない)

   ```ts
   /** 値の根拠。tested = 実機で確かめた / documented = 公式文書・ソースコードで確かめた(実機では未確認) */
   export type SearchProfileBasis = "tested" | "documented";

   export interface SearchProfileItem<T> {
     readonly value: T;
     readonly basis: SearchProfileBasis;
   }

   export interface SearchProfile {
     /** 空白で区切った語の結合。and = すべて含む / or = いずれかを含む */
     readonly termJoin?: SearchProfileItem<"and" | "or" | "unknown">;
     /** 照合の単位。substring = 部分文字列 / token = 語(バックエンドの分割規則による) */
     readonly matchUnit?: SearchProfileItem<"substring" | "token" | "unknown">;
     /** 自然文の質問をそのまま渡したときに意味の近い文書を返すか(Slack の意味検索など) */
     readonly naturalLanguage?: SearchProfileItem<"supported" | "unsupported" | "unknown">;
     /** "…" による語句の完全一致 */
     readonly phraseQuote?: SearchProfileItem<"supported" | "unsupported" | "unknown">;
     /** query の中に書ける演算子 */
     readonly operators?: SearchProfileItem<readonly SearchOperator[]>;
     /** query の中に書ける修飾子(決定 2 の制約付きの名前と対象) */
     readonly qualifiers?: SearchProfileItem<readonly SearchQualifier[]>;
     /** 上限と超過時の挙動 */
     readonly maxTerms?: SearchProfileItem<SearchLimit>;
     readonly maxQueryChars?: SearchProfileItem<SearchLimit>;
     readonly maxOperators?: SearchProfileItem<SearchLimit>;
     /** 並び順。relevance = 関連度 / recency = 更新の新しい順 */
     readonly ranking?: SearchProfileItem<"relevance" | "recency" | "unknown">;
     /** タイトルに語を含む文書を上位にするか */
     readonly titleBoost?: SearchProfileItem<boolean>;
     /** スニペットの種類。match_context = 一致箇所の周辺 / leading_text = 本文の先頭 / mixed = 結果の種別による */
     readonly snippet?: SearchProfileItem<"match_context" | "leading_text" | "mixed" | "none">;
   }

   /** OR 演算子 / NOT 演算子 / 語の前の - による除外 / 括弧によるまとまり */
   export type SearchOperator = "or" | "not" | "minus" | "parentheses";

   export interface SearchQualifier {
     /** 修飾子の名前(例: "title")。/^[a-z][a-z_]{0,15}$/ に限る。query には "<name>:" として書く */
     readonly name: string;
     /** 絞り込む対象 */
     readonly target: "title" | "body" | "category" | "tag" | "author" | "date" | "state" | "type";
   }

   export interface SearchLimit {
     /** 1 以上 1,000 以下の整数 */
     readonly limit: number;
     /** 超過時の挙動。dropped = 超えた分を黙って捨てる / truncated = 途中で切る / error = エラーを返す */
     readonly overflow: "dropped" | "truncated" | "error" | "unknown";
   }
   ```

   - `SourceDescription` に `searchProfile?: SearchProfile` を足す。`SearchFilters` に入れる値の形(esa はカテゴリのパス、GitHub は `owner/repo` か組織名)と、返るヒットの種別(GitHub の issue・PR・コードの混合)は自由文でしか表せないため、従来どおり `summary` に書く(決定 2 の範囲外)
   - 列挙値に当てはまらない仕様(バックエンド固有の挙動)は列挙値を足して表す。足すのは SDK の版上げとして扱い、本 ADR の追補に記録する
   - `ConnectorCapabilities.nativeSearch` の `degraded` / `none` は、Orchestrator が同じテンプレートで「このソースの検索は限定的」と伝えてよい(ADR-007 のコメントにある「Orchestrator のソース選択が消費する」を実装する)

2. **探索 LLM に渡す文は、Orchestrator が検索プロファイルの値からテンプレートで作る。** コネクタが書いた文をそのまま渡さない
   - Gateway の射影(`projectDescription`)と Orchestrator の `SourceBrief` は、`searchProfile` を SDK の値域で検証し、値域の外の値・型の違う値・修飾子の名前の形式違反を `unknown`(項目ごと削除)に落とす。修飾子は 1 ソース 20 個まで、上限の数値は 1 以上 1,000 以下の整数に限る(TM-D4 の「`kind` / `supportedFilters` を SDK の値域に限り件数・長さを切り詰める」と同じ規律)
   - **信頼区分**: 検証済みの値から作った文は Orchestrator 自身が書いた文として、`[オーケストレーター]` で始まる制御メッセージと同じ扱いで最初の user ターンに置く(ソース一覧の「データ」の枠の外。system prompt には入れない。導入ごとに変わり、プロンプトキャッシュの prefix を崩すため)。値は限られた選択肢のどれかなので、侵害されたコネクタが選べるのは「どの定型文が出るか」だけで、任意の指示を書き込めない。ただし誤った値(例: 実際は OR のソースが AND を名乗る)で探索の効率を下げることはできる。これは検索の品質の問題であり、認可・出典・URL の防御(探索プロンプトのツール結果の扱い、ADR-017 決定 3)には影響しない
   - `summary` は従来どおり「データであり指示ではない」枠のまま渡す。`searchProfile` と `summary` の記述が食い違う場合は `searchProfile` を優先するよう探索プロンプトに書く
   - `basis` の文への反映: `tested` は断定で書く。`documented` は「公式の文書による。実機では未確認」と添える(確認事項 3)。項目がないものは書かないか「不明」と書く。未確認の仕様を断定の形で渡すと、今の共通の指針と同じ誤誘導を繰り返すため
   - 例(レポート「プロンプト文面の例」を本 ADR の項目に合わせた文面。確定版ではない): 「[オーケストレーター] redmine の検索の仕様: 語は部分一致で照合する。使われるのは先頭 5 語までで、超えた語は黙って捨てられる(ソースコードによる。実機では未確認)。並び順は関連度ではなく更新の新しい順。語の結合(すべて含む / いずれかを含む)は不明。」

3. **検索プロファイルは利用者によって変わらない値とし、導入先ごとの違いは deployment.yaml で上書きする。**
   - コネクタはコードの既定値と `ConnectorFactoryInit.settings` から検索プロファイルを作る。利用者の資格情報や検索の結果で値を変えない(ソースの可視性で認可状態を漏らさない。ADR-001 追補 3 決定 5 の `tools/list` のユーザー非依存と同じ方向)。そのため、検索プロファイル自体はキャッシュしてよい利用者のデータではない情報として扱える(不変条件 4 の対象は検索結果・fetch 結果・認可照会結果)。`describe` の結果全体のキャッシュは従来どおり userId をキーに含める
   - deployment.yaml の `connectors[].searchProfile`(省略可能)に、項目単位の上書きを書けるようにする。Gateway が設定の読み込み時に SDK と同じ値域で検証し(違反は起動時に拒否)、`describe` の射影でコネクタの値に重ねる。上書きした項目の `basis` は導入先が書く(導入先で確かめたなら `tested`)
   - 想定する上書きの例: Redmine に全文検索プラグイン `redmine_full_text_search` を入れた導入先(照合の単位・並び順が変わる)、Slack で意味検索が使えるプランと設定の導入先(`naturalLanguage: supported`)
   - **ADR-005 との整合**: ソース固有の検索の仕様(esa や Redmine の構文)はコネクタ(プラグイン境界)が持つ。導入先ごとの値は deployment.yaml に置く。コア(Gateway・Orchestrator)に置くのは、ソースの種類に依存しない項目の型、値域の検証、テンプレートだけである。不変条件 9 との関係では、検索プロファイルという仕組みは全ソースに共通の汎用の機構であり、特定の 1 社の要件ではない(レポート「不変条件と ADR は、変更の置き場所を決めている」)

4. **`SearchResult` に省略可能な `notices` を加え、コネクタが「語を捨てた」「指定を無視した」ことを知らせられるようにする。**

   ```ts
   export interface SearchNotice {
     readonly kind:
       | "terms_dropped"      // 語数の上限を超えた語を捨てた
       | "query_truncated"    // 文字数の上限で query を切った
       | "operator_ignored"   // 演算子・修飾子を解釈しなかった
       | "filter_ignored"     // filters の指定を使わなかった
       | "join_relaxed";      // AND で結果がなく、コネクタの中で OR に切り替えて再検索した
     /** terms_dropped のとき、使った語の数(query から数えられる値に限る) */
     readonly keptTerms?: number;
     /** filter_ignored のとき、使わなかったフィルタのキー */
     readonly filter?: keyof SearchFilters;
   }
   ```

   - **ADR-012 との関係**: notices は、query と filters の形、およびソースが本人の資格情報で返した(認可済みの)結果からだけ作る。認可前の候補の有無や件数から作らない。「権限がないため 0 件」と「本当に 0 件」を区別する情報を含めない。Phase 2 で検索層(Search Backend Adapter)が内部実装に入った場合も、notices を作れるのはアダプタの外に出る認可済みの結果からだけである
   - 自由文を持たない。Orchestrator は決定 2 と同じくテンプレートで制御メッセージにする(例: 「[オーケストレーター] redmine は語数の上限を超えたため、先頭 5 語だけで検索した」)
   - Gateway の射影は値域の外の kind を落とす。監査(ToolInvocation)への記録は本 ADR では行わない(ADR-011 のスキーマを変えない。記録するかは確認事項 5)
   - `join_relaxed` は Redmine のように、コネクタの中で AND から OR に切り替える実装を選んだ場合のためのものである。Redmine でそうするかは ADR-024 への追記として T-028 / T-029 の結果で決める

5. **認可済みで返却可能な件数だけを表す専用フィールドは、今回は追加しない。** 下の選択肢を残す。追加する場合は本 ADR の追補か別の ADR で決める
   - (a) **追加しない【既定】**。探索 LLM が使える件数の情報は、返ったヒットの数と `nextCursor` の有無(続きがあるか)だけとする。0 件・少数・上限まで返った、の区別はこれで足りる
   - (b) 区間で表す専用フィールド(例: `authorizedCountBucket: "0" | "1-10" | "11-100" | "101+"`)。条件は、値がすべて認可を通った返却可能な文書だけから数えたものであること。esa の `total_count` はゲストのカテゴリ制限で本人に見えない投稿を数えうる(ADR-023 決定 5)ため使えない。GitHub の `total_count` も本人の権限で絞られた値かを確かめる必要がある。Phase 2 の検索層では、認可済みの件数を数えるには全候補の認可照会が要り、性能の面で現実的でない
   - (c) 正確な件数の専用フィールド。(b) の条件に加え、件数の差から文書の存在を推定させないこと(TM-B2)を、ソースごとに示す必要がある
   - (a) を既定とする理由: 「多すぎるので絞る / 少ないので広げる」の判断に件数が役立つことは認めるが、(b)(c) の条件を満たせると示せたソースがまだない。条件を満たすソースが現れたときに、そのソースでの検証を添えて提案する

6. **connector-sdk を v0.6 に上げる。** 追加はすべて省略可能なフィールドで、既存の IF(`search` / `fetch` / `list` / `describe` の引数)は変えない。`MAX_SNIPPET_CHARS` などの既存の規約も変えない。fitting test に「`searchProfile` と `notices` の値域外の値が Gateway の射影で落ちる」「値域外の deployment.yaml の上書きで起動を拒否する」を加える

## 理由

- 検索の仕様を知っているのはコネクタだけである。コネクタは自分のバックエンドの構文を使ってクエリを組み立てている(esa は `in:` `user:` `updated:` を後置する。`packages/connector-esa/src/connector.ts:206-233`)のに、探索 LLM にはそれが伝わっていない。伝える経路をコネクタ IF に置けば、ソースが増えても Orchestrator のコアは変わらない
- 列挙値にする理由は 2 つある。1 つは信頼区分で、自由文をコネクタから受けると TM-D4 の対策(データの枠に置く)のために探索 LLM が従う力が弱まる。列挙値なら Orchestrator が自分の文として書けるので、制御メッセージと同じ扱いにできる。もう 1 つは比較と検証で、列挙値なら評価(T-027)でソースごとの条件をそろえられ、実機での確認(T-029)の結果を項目単位で `basis` に反映できる
- `basis` を持つ理由: 現行の共通の指針は、開発用コネクタでの観察を全ソースに当てはめた未確認の一般化だった。未確認の仕様と確認済みの仕様を探索 LLM が区別できないと、同じ誤りを繰り返す
- 利用者によって変えない理由: 検索プロファイルを利用者ごとに変えると、ソースの設定やプランの違いが利用者ごとに見え、ソースの可視性から認可状態が漏れる経路になりうる。また、利用者に依存しなければ起動時の検証と上書きで値が決まり、扱いが単純になる
- notices を列挙値にする理由: 0 件の原因のうち、コネクタだけが知っているもの(語を捨てた、フィルタを使わなかった、再検索した)を、ADR-012 に触れない形で探索 LLM に渡せる。Orchestrator が自分で判定できるもの(同じ query の繰り返し、ヒットがすべて既出、語数がプロファイルの上限を超えている)は IF に入れず、Orchestrator の制御メッセージで扱う(T-024)

## 帰結

- connector-sdk v0.6。Gateway の射影(`projectDescription`、`projectSearchResult`)、deployment.yaml のスキーマ(`connectors[].searchProfile`)、Orchestrator の `SourceBrief` とテンプレート、各コネクタ(dev-fixture、esa、GitHub、Redmine)の検索プロファイルの既定値に変更が及ぶ(T-030)
- 探索プロンプトの共通の指針(「多くのソースは AND」)は、ソースごとの検索の仕様を参照する指示に置き換わる。IF を変えない段階(T-024 / T-028)では、同じ内容を各コネクタの `summary` に自由文で書く。T-030 の後は、`summary` から検索の仕様の記述を外し、内容の説明に戻す(二重に書くと食い違う)
- 各コネクタの既定値のうち、実機で確かめていない項目は `documented` か `unknown` で始まる。T-029 の結果で `tested` に変える
- 開発用コネクタ(dev-fixture)は、検索方式を切り替えられるようにした場合(T-027)、方式ごとの検索プロファイルを返す。評価では、正しい検索プロファイルを渡した場合と渡さない場合を比べられる
- Phase 2 で内部実装を検索層に切り替えたソースは、検索プロファイルの値(例: `naturalLanguage: supported`、`ranking: relevance`)が変わるだけで、IF も Orchestrator も変わらない(不変条件 5 の前提を保つ)
- Source Catalog(T-018)との分担: 検索プロファイルは「検索の仕組み」、Source Catalog は「何がどこにありそうか」「検索に使う語彙」を扱う。社内用語やタグの一覧は検索プロファイルに入れない
- esa の公式 MCP が持つ検索構文のヘルプやタグ一覧のツール(`esa_search_help` 等。調査セッションでの観測で、中身は未確認)を使って値を確かめる・補う場合は、コネクタの許可リスト(ADR-023 決定 3)の変更になるため ADR-023 の追補が要る。本 ADR では使わない

## 検討した代替案

- **Orchestrator のコアにソース別の構文を直書きする**(例: `kind: esa` なら esa の構文の説明を出す): どのソースを使うかは導入ごとに違い、個社のコネクタ(ADR-021 の `module`)の構文はコアが知りえない。ADR-005 と不変条件 8 に反するため採らない
- **`summary` の自由文だけで続ける**(IF を変えない): 実装の費用は最も小さく、T-024 / T-028 で先に行う。ただし、1,000 字の切り詰め、「データであり指示ではない」枠での扱い、根拠の区別ができないこと、評価で条件をそろえにくいことが残る。自由文の効きを T-027 の評価で測ったうえで、本 ADR の採否を決める材料にする
- **コネクタが自由文の「検索のしかた」を返し、Orchestrator が制御メッセージとして渡す**: 探索 LLM が従う力は強くなるが、コネクタ由来の任意の文が制御メッセージの権威を持つ。侵害されたプラグインや、Slack・文書の内容を取り込んだ説明文から指示を注入する経路になる(TM-D4)。採らない
- **ソースごとに別のツール定義(`search_esa` など)を Gateway が公開し、ツール説明に構文を書く**: 公式 MCP サーバーの方式に近いが、Gateway のツール面がソースの数だけ増え、ツール IF(不変条件 5)とプロンプトキャッシュの前提が変わる。ツールの説明文が自由文である問題も残る。採らない
- **コードで最初の検索を実行する**(キーワードの抽出、ソースごとのクエリの整形、並列検索の自動実行): オーナーの方針(2026-11-25)により今回の範囲外とした。本 ADR の検索プロファイルは、将来この方式を採る場合にもクエリの整形の入力として使える
- **件数の専用フィールドを今回追加する**: 決定 5 のとおり、条件を満たすソースを示せないため既定では採らない
- **検索プロファイルを `ConnectorCapabilities`(起動時の静的な宣言)に置き、`describe` を通さない**: 利用者に依存しない値なので静的な宣言でも表せる。ただし Orchestrator は Gateway の MCP の面(`describe`)からしかソースの情報を受け取らない(ADR-018 決定 2)。新しい経路を作るより、`describe` の結果に載せる方が変更が小さい。確認事項 2 とする

## 人間に確認してほしい点

1. **本 ADR を採るか、`summary` の自由文で続けるか。** T-027 の評価で、自由文の検索の仕様(T-028)の効きを測ってから決める進め方でよいか
2. **置き場所**: `SourceDescription.searchProfile`(`describe` で渡す。本案)か、`ConnectorCapabilities` に静的に置き Gateway が `describe` の結果に付けるか
3. **`basis: documented` の扱い**: 公式の文書・ソースコードで確かめた値(実機では未確認)を、断定に近い文で渡すか、「不明」と同じく弱く渡すか。本案は「実機では未確認」と添えて渡す
4. **修飾子の名前を制約付きの文字列で許すか。** 本案は `/^[a-z][a-z_]{0,15}$/` の名前と列挙値の対象の組で許す。名前も列挙値に限る案は、ソースごとの修飾子を SDK に列挙することになり、ソース固有の知識が SDK に入る
5. **notices を監査(ToolInvocation)に記録するか。** 記録すれば 0 件の原因の集計(T-014 の昇格判定)に使えるが、ADR-011 のスキーマの変更になる。本案は記録しない
6. **件数の専用フィールド(決定 5)**: 既定の (a)「追加しない」でよいか
7. **Slack の意味検索の可否を、利用者ごとに変わりうる値として扱うか。** 公式 MCP は利用者ごとの可否を説明文に出しているとされる(レポート、要約経由)。本案は決定 3 により導入単位の値(deployment.yaml)に限る
8. **#22 の SourceProfile との関係**: 検索プロファイルを SourceProfile の一部にするか、別の概念のまま置くか。本案は別の概念とする
9. **自由文の段階(T-028)から構造化の段階(T-030)への移行で、`summary` の記述を消すか。** 本案は消す(二重の記述は食い違う)

## 参照

注: 下のレポートと調査ノートは 2026-11-25 時点で main に未収録(作業ツリーの外にある)。収録先が決まったらパスを直す。

- `reports/エージェント検索ハーネス設計調査.md`(「検索プロファイルはコネクタが持ち、Orchestrator が文章にして渡す」「0 件、重複、切り捨ては、Orchestrator が制御メッセージで知らせる」「不変条件と ADR は、変更の置き場所を決めている」「根拠の弱い点」)
- `research_notes/エージェント検索ハーネス設計調査/leisen_current_implementation.md` §3〜§5、§7
- ADR-005、ADR-007、ADR-012、ADR-014、ADR-016(追補 1・2)、ADR-017 決定 4、ADR-021、ADR-023、ADR-024、ADR-026
- `docs/threat-model.md` TM-D4、TM-B2
