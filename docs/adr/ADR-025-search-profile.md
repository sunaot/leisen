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

## 追補 1(2026-11-25、セキュリティレビューの指摘。人間のレビュー待ち)

`join_relaxed` を出すかどうか(緩めた再検索をするかどうか)は、SourcePolicy をかけた後の shared のヒットだけで判断する。private を分類するコネクタ(`privateScopeHandling: classified`)は、`privateScopes` が `included` でない限り、コネクタの中で緩めた再検索をしない。private を含む AND の結果の有無で緩めるかを決めると、「private の文書だけが AND に一致した」ことが通知の有無と結果の中身(いずれかの語だけを含むヒット)から分かりうるためである(ADR-012、ADR-016 追補 2)。防御として、Gateway は `privateScopes` が `included` でないコネクタの `join_relaxed` を落とす(実装済み。`packages/gateway/src/proxy/gateway.ts` の `enforcePrivateScopes`)。ただし、再検索の有無は結果の中身に出るため、通知を落とすだけでは防げない。本規則はコネクタの責務である。2026-11-25 時点で `join_relaxed` を返すコネクタはない。通知の種類から `join_relaxed` を外す案もあり、どちらにするかは人間の判断を待つ。

## 実装の記録(T-030、2026-11-25)

- 確認事項 9(`summary` から検索の仕様の記述を消す)は実施していない。消すと既定の探索プロンプト v3 の探索 LLM への入力が変わり、T-027 での `summary` の自由文と検索プロファイルの比較もできなくなるため、評価の後に行う(`docs/eval/2026-11-25-explore-v4-unevaluated.md` §6)
- `nativeSearch` の degraded / none の伝達は実装していない。`describe` に載せるフィールドを本 ADR が定めておらず、追補が要る
- 検索プロファイルの文は探索プロンプト v4 を選んだときだけ探索 LLM に渡る。既定は v3 のまま(評価未実施)
- 実ソースのコネクタの各項目の根拠はすべて `documented`(文書・ソースコードでの確認)で、実機での確認(T-029)は済んでいない。Redmine の語の結合は `unknown`(Redmine 本体のソースコードでは `all_words=0` でも AND と読めるが、実機未確認)

## 参照

注: 下のレポートと調査ノートは 2026-11-25 時点で main に未収録(作業ツリーの外にある)。収録先が決まったらパスを直す。

- `reports/エージェント検索ハーネス設計調査.md`(「検索プロファイルはコネクタが持ち、Orchestrator が文章にして渡す」「0 件、重複、切り捨ては、Orchestrator が制御メッセージで知らせる」「不変条件と ADR は、変更の置き場所を決めている」「根拠の弱い点」)
- `research_notes/エージェント検索ハーネス設計調査/leisen_current_implementation.md` §3〜§5、§7
- ADR-005、ADR-007、ADR-012、ADR-014、ADR-016(追補 1・2)、ADR-017 決定 4、ADR-021、ADR-023、ADR-024、ADR-026
- `docs/threat-model.md` TM-D4、TM-B2

## 追補 2(2026-11-26): 検索プロファイルの廃止(connector-sdk v0.7 案)

Status: Proposed(人間のレビュー待ち)/ Date: 2026-11-26 / 起点: オーナーの指示(2026-11-26。「検索プロファイルはノイズになるので削除する」)

本追補は、本 ADR の決定 1〜3 で加えた検索プロファイルを取り除く提案である。コネクタのツール IF(`describe` の戻り値 `SourceDescription`)を変えるため、不変条件 5 が求める ADR を兼ねる。検索の仕様を探索 LLM にどう渡すか(「データであり指示ではない」枠の中か外か)は ADR-017 追補 1 で扱い、本追補はその方式を前提にする。実装は T-032 で、本追補と ADR-017 追補 1 が Accepted になってから行う。本 ADR の本文・追補 1・実装の記録は書き換えない。

### 文脈

#### 計測の結果(事実)

`dev-search-eval`(T-027)による 2 回の計測。条件は共通で、haiku(`claude -p` の構造化出力によるツール呼び出しの模擬。Anthropic API のネイティブのツール呼び出しではない)、開発用コネクタの模擬の esa 型と Redmine 型(AND)、合成コーパス 425 件、23 問、条件 3、各 3 回。検索プロファイルの根拠はすべて `tested`(模擬の実装そのものが仕様のため)。

- `docs/eval/2026-11-26-search-eval-spec-delivery-haiku.md`(1 回目): 伝え方 `summary`(自由文だけ)/ `both`(自由文 + 検索プロファイル + 通知)/ `profile`(検索プロファイル + 通知だけ)
- `docs/eval/2026-11-26-search-eval-spec-delivery-split-haiku.md`(2 回目): `summary` を同じコードで流し直したものと、`split`(検索プロファイル + 通知 + 検索プロファイルで表せない補足だけの自由文)

正解のある 17 問 × 3 回の値(recall@1 / recall@5 / 正解文書を引用した割合):

| 伝え方 | esa 型 | Redmine 型(AND) |
|---|---|---|
| `summary`(1 回目) | 81% / 98% / 98% | 82% / 87% / 94% |
| `both`(1 回目) | 76% / 90% / 90% | 77% / 83% / 89% |
| `profile`(1 回目) | 76% / 90% / 92% | 81% / 89% / 98% |
| `summary`(2 回目) | 78% / 91% / 92% | 83% / 89% / 98% |
| `split`(2 回目) | 86% / 92% / 93% | 81% / 93% / 92% |

- 同じ条件の `summary` が、1 回目と 2 回目の間で、esa 型の recall@1 で 3 ポイント、recall@5 で 7 ポイント、引用で 6 ポイント動いた。同じ組の 3 回の中の recall@1 の幅は、1 回目で 3〜14 ポイント、2 回目で 6〜12 ポイントだった。伝え方の間の差はこれと同じ程度で、検索プロファイルを足した構成(`both`)・自由文を消した構成(`profile`)・重複分だけ消した構成(`split`)のいずれも、自由文だけの構成(`summary`)を明確に上回らなかった
- search の総数は 2 回の計測で 4,372 回(1 回目 2,594 回、2 回目 1,778 回)。うち、検索プロファイルと通知を返した組(`both` / `profile` / `split`)の search は 2,631 回、Redmine 型の search は 2,196 回
  - Orchestrator の検索プロファイルに照らした判定: Redmine 型で語数の上限(5 語)を超えた search は 0 回(探索 LLM が書いたクエリは最大 4 語)。空白のない文のまま 0 件だった search は全組で 0 回
  - 通知: `terms_dropped` は 0 回。`operator_ignored` は 1 回目に 6 回出たが、すべて 1 つの質問(`ki-expense-rules`)の最初の search で、模擬の esa 型の判定の条件が広すぎたためだった(正解の順位は変わらず、search が 1 回増えた)。条件を直した 2 回目は 0 回
- 演算子と修飾子の使用(esa 型): `OR` を含む search は `summary` 33 回(1 回目)・32 回(2 回目)、`both` 48 回、`profile` 12 回、`split` 23 回。`title:` を含む search は `summary` 27 回・21 回、`both` 29 回、`profile` 24 回、`split` 26 回。自由文の検索の仕様は「データであり指示ではない」枠の中にあるが、探索 LLM はその記法を使ってクエリを書いた。`OR` は自由文を含む構成(`summary`・`both`)で多く、自由文を消した `profile` で少なかった
- 検索プロファイルの列挙値で表せない情報があった: `OR` と AND の結び付きの順と例、フィルタの値の形(esa のカテゴリのパス、GitHub の `owner/repo`)、返る結果の種類(GitHub の issue・PR・コードの混合)。`profile` で esa 型の `OR` の使用が減ったことはこれと合うが、`OR` の回数と recall の関係は確かめていない

計測の限界: 1 つのモデル、ツール呼び出しの模擬、模擬の検索方式、合成コーパス。実ソースのコネクタ(根拠が `documented` の検索プロファイルと「実機では未確認」の句)では計測していない。語数の上限と通知が効く場面は出なかったため、それらの効果は「なかった」ではなく「測れていない」。

#### コードの現状(2026-11-26、ブランチ `claude/relaxed-albattani-dzzqvy`)

- connector-sdk(パッケージの版は 0.6.0): `SourceDescription.searchProfile`(`packages/connector-sdk/src/index.ts:306-323`)、型と値域の定数・`sanitizeSearchProfile`・`mergeSearchProfile`(`:325-569`)、`SearchResult.notices` と `SearchNotice`(`:222-262`)、`sanitizeSearchNotices`(`:577-613`)
- Gateway: `projectDescription` がコネクタの値を検証し、`connectors[].searchProfile` の上書きを重ねる(`packages/gateway/src/proxy/gateway.ts:656-678`)。上書きのスキーマ(`packages/gateway/src/config/schema.ts:64-110`、`:345-350`)。`connectorSchema` は `z.strictObject` なので、項目を消すと `searchProfile` を書いた deployment.yaml は起動時に拒否される。`examples/`・`deploy/` に `searchProfile` を書いた設定はない。`enforcePrivateScopes` は `privateScopes` が `included` でないとき `join_relaxed` を落とす(`gateway.ts:727-746`)
- Orchestrator: `SourceBrief.searchProfile` の検証(`packages/orchestrator/src/prompt.ts:187-229`)、「各ソースの検索の仕様」の制御メッセージ(`packages/orchestrator/src/search-profile.ts:37-38`、`:150-222`。explore.v4 のときだけ)、検索プロファイルに照らした判定(語数の上限・空白のない文。`search-profile.ts:248-312`、`packages/orchestrator/src/search-feedback.ts:298-317`)。非対応のフィルタの判定(`search-feedback.ts:287-297`)は `supportedFilters` だけを使い、検索プロファイルに依存しない。通知はツール結果のデータから外し(`packages/orchestrator/src/orchestrator.ts:1448-1456`)、定型文の制御メッセージにする(`search-profile.ts:229-246`)
- 実ソースのコネクタ: esa・GitHub・Redmine は、`summary` の自由文の検索の仕様(T-028)と検索プロファイル(T-030)の両方を返す(`packages/connector-esa/src/connector.ts:147`、`:373`、`:385-428`、`packages/connector-github/src/connector.ts:760-797`、`:1099-1118`、`packages/connector-redmine/src/redmine.ts:173-208`、`:241-249`)。既定の探索プロンプト v4 では、実ソースは計測の `both` に当たる構成で探索 LLM に渡っている
- 通知を返すコネクタ: connector-redmine の `terms_dropped`(`packages/connector-redmine/src/query.ts:98-102`、`redmine.ts:330-336`)と、開発用コネクタ(`packages/gateway/src/dev/search-modes.ts:444-460`。伝え方が `summary` 以外のとき)。`join_relaxed` を返すコネクタはない
- 開発用コネクタの既定の検索方式(`default`)は `summary` に検索の仕様の文がなく、検索の仕様を検索プロファイルだけで伝えている(`search-modes.ts:303-305`、`:465-468`、`packages/gateway/src/dev/fixture-connector.ts:387-404`)。検索プロファイルを消すと、このままでは既定の方式の検索の仕様が探索 LLM に何も届かない

### 決定(案)

1. **検索プロファイルを削除する。** 対象:
   - connector-sdk: `SourceDescription.searchProfile`、`SearchProfile` とその項目・値域の型と定数、`sanitizeSearchProfile`、`mergeSearchProfile`
   - Gateway: `projectDescription` の検索プロファイルの検証と重ね合わせ、deployment.yaml の `connectors[].searchProfile` とそのスキーマ
   - Orchestrator: `SourceBrief.searchProfile`、「各ソースの検索の仕様」の制御メッセージ(`renderSearchProfiles` と定型文の表)、検索プロファイルに照らした判定(語数の上限の超過、空白のない文のまま 0 件)、検索プロファイルの有無で分けたソース一覧の前置きと 0 件の制御メッセージの文言(`SOURCE_CATALOG_PREFACE_V4_WITH_PROFILES`、`noHitsNotice` の `profileShown`)。非対応のフィルタの判定は残す
   - コネクタ: esa・GitHub・Redmine の `*_SEARCH_PROFILE` と `describe` の `searchProfile`。開発用コネクタの検索プロファイル(確認事項 3 の回答に従う)
2. **検索の仕様は自由文で渡す。** 渡し方は ADR-017 追補 1 に従う(推奨の案では、`summary` から分けた検索の仕様の専用フィールドを、出所を示して枠の外に置く)。ADR-017 追補 1 が採られない場合は、現状どおり `summary` の自由文を枠の中で渡す。本 ADR の確認事項 9(`summary` から検索の仕様の記述を消すか)は「消さない(自由文を正とする)」で決着する。開発用コネクタの既定の検索方式には、検索プロファイルの代わりに自由文の検索の仕様を書く
3. **通知 `SearchResult.notices` は残し、種類から `join_relaxed` を外す**(確認事項 1 の既定の案)。`join_relaxed` を外すと、追補 1 の規則(緩めた再検索の判断を shared のヒットだけで行う)とその防御(Gateway の `enforcePrivateScopes` で `join_relaxed` を落とす処理、SDK のコメント)は対象がなくなるため、あわせて削除する。追補 1 はこれで決着する
4. **導入先ごとの検索の仕様の違いは、各コネクタの `settings` で表す。** deployment.yaml の `connectors[].searchProfile` のような、コネクタの種類によらない上書きは置かない。例: Redmine に全文検索プラグインを入れた導入先には、connector-redmine の設定で、実装者が用意した別の定型の句を選ばせる(設定の追加は必要になったときに connector-redmine の変更として行う。2026-11-26 時点で要望はない)。これは ADR-005(差分は deployment.yaml とプラグイン境界で吸収する)の範囲内である
5. **connector-sdk を v0.7 に上げる**(ADR-017 追補 1 の追加と同じ版にする。確認事項 2)。`describe` / `search` / `fetch` / `list` の引数は変えない。本 ADR の決定 5(件数の専用フィールドを追加しない)は変えない

### 削除で失うもの(本 ADR の「理由」ごと)

- **探索 LLM への効き方**(列挙値なら Orchestrator が自分の文として、制御メッセージと同じ扱いで渡せる): 計測では、検索プロファイルを足しても自由文だけの場合を明確に上回らず、枠の中の自由文にも探索 LLM は従った。失うものは計測の範囲では見えていない。ただし計測は 1 つのモデルだけで、枠の中の自由文に従いにくいモデルがあれば差が出うる(見直しの条件 2)。ADR-017 追補 1 を採れば、自由文は枠の外に置かれる
- **根拠 `tested` / `documented` の管理**: 項目ごとの根拠を持つ先がなくなる。実機での確認(T-029)の結果は、自由文の中に「実機で確認した」「実機では未確認」と書き分ける運用に戻る(T-028 の段階の `summary` はすでにそう書いている。例: `packages/connector-esa/src/connector.ts:415`、`packages/connector-redmine/src/redmine.ts:175`)。どの項目が確認済みかを機械的に一覧にする方法はなくなり、書き方のそろい方はコネクタごとのレビューに頼る。Orchestrator が一律に付けていた句(「公式の文書・ソースコードによる。実機では未確認」)もなくなる
- **機械的な判定**(語数の上限の超過、空白のない文のままの検索): Orchestrator の判定はなくなる。計測では 4,372 回の search で一度も働かなかった(効果は測れていない)。Redmine の語数の上限は、通知を残す場合、コネクタが自分の数え方で返す `terms_dropped` で知らせ続けられる。Orchestrator の数え方(1 文字の語も数える)とコネクタの数え方(1 文字の語を数えない)の違い(`docs/eval/2026-11-26-search-eval-spec-delivery-haiku.md`「この計測で見つけたこと」)は、Orchestrator の判定を消すことで解消する。空白のない文の判定は代わりがなくなり、探索プロンプト v4 の指示だけになる
- **評価で条件をそろえる**: 列挙値の項目単位で条件をそろえた比較はできなくなる。検索の仕様の自由文はコネクタのコードの定数なので、評価ではコミットと文面の差分で条件を記録する。`dev-search-eval` の `--spec-delivery` は意味を失う(確認事項 3)
- **導入先ごとの上書き**(決定 3): deployment.yaml で項目単位に上書きする仕組みはなくなり、決定 4 のとおりコネクタの設定で表す。上書きを使った設定は `examples/`・`deploy/` にない
- **Phase 2 の検索層への切り替え**(「帰結」): 切り替えたソースでは、検索プロファイルの値ではなく検索の仕様の自由文が変わる。IF は変わらない(不変条件 5 の前提は保たれる)
- **`nativeSearch` の `degraded` / `none` の伝達**: もともと実装していない(実装の記録)。本追補の影響を受けない

### 見直しの条件

次のいずれかが分かったときに、検索の仕様を構造化して渡す案(検索プロファイルの形に限らない)を改めて検討する。

1. 実ソースでの利用や評価のトレースで、語数・文字数の上限に当たる検索が繰り返し観測され、自由文の検索の仕様と通知では減らなかった
2. 別のモデル(Anthropic API のネイティブのツール呼び出し、LM Studio の手元のモデルなど)の評価で、自由文の検索の仕様に従わない(例: 演算子のないソースで演算子を書く、AND のソースで言い換えを 1 つのクエリに並べる)ことが示され、構造化した伝え方で改善した
3. コードで最初の検索を実行する方式(2026-11-25 のオーナー方針で範囲外)を採ることになり、Orchestrator がクエリを組み立てるために機械が読める検索の仕様が必要になった
4. ソースの数が増え、検索の仕様の自由文の合計が最初の user ターンを大きく占めるようになった

### 検討した代替案(却下した変更)

- **残して広げない**(省略可能のまま置き、列挙値を足さない): 実装はあるため追加の費用は小さい。ただし、実ソースのコネクタは自由文と検索プロファイルの両方を返す構成(計測の `both`)のままになり、2 つの記述の食い違いを防ぐ保守(本 ADR の「帰結」が挙げた「二重に書くと食い違う」)と、テンプレート・上書きのスキーマ・値域の検証の保守が残る。計測ではその構成が自由文だけの構成を上回らなかった。採らない
- **機械的な判定に使う数値だけに絞る**(`maxTerms` などの上限の項目だけを残す): 判定は計測で一度も働かず、Redmine の語数の上限はコネクタの `terms_dropped` で知らせられる。Orchestrator とコネクタで語の数え方が食い違う問題も残る。採らない
- **削除する**(本案)

### 人間に確認してほしい点

1. **通知 `SearchResult.notices` を残すか。** 通知は検索プロファイルとは独立した仕組み(コネクタが実際に起きたことを返す)だが、計測では有用な場面が出ていない(`terms_dropped` 0 回、`operator_ignored` は模擬の判定条件の誤りによる 6 回だけ)
   - (a) **残す。種類から `join_relaxed` を外す【既定】**。理由: 語数の上限を超えた語を黙って捨てるソース(Redmine)では、探索 LLM はその検索で何が起きたかを結果から知ることができない。検索の仕様の自由文は規則を伝えるだけで、その検索で実際に語を捨てたかは伝えない。Orchestrator の判定を消すと、この情報の経路は通知だけになる。通知は実装済みで、自由文を持たず、Orchestrator は定型文にするだけなので、残す費用は小さい。一方 `join_relaxed` は、返すコネクタがなく、出すかどうかの判断を誤ると、private の文書の存在が通知の有無と結果の中身から分かりうる(追補 1)。Gateway は通知を落とせても、再検索の有無は結果の中身に出るため防げず、守れるのはコネクタの規律だけである。消費者のいない項目を危険を抱えたまま残さない(ADR-016 追補 1 の `totalCount` の削除と同じ考え方)。Redmine で緩めた再検索が必要だと T-029 で分かったら、その時点で ADR を書いて足す
   - (b) 種類を、実際に返すコネクタがあるもの(`terms_dropped`)だけに絞る。`query_truncated` / `operator_ignored` / `filter_ignored` を返す実ソースのコネクタはない(`operator_ignored` は開発用コネクタだけ)。(a) との違いは IF の小ささと、将来のコネクタ(GitHub の 256 文字の上限など)が使える種類が残るかどうか
   - (c) 通知ごと削除する。IF が最も小さくなる。語数の上限は検索の仕様の自由文(「先頭の 5 語まで」)だけで伝える。計測では探索 LLM が 5 語を超えるクエリを書かなかった
   - (d) `join_relaxed` を含めてすべて残す(追補 1 の規則と Gateway の防御も残す)
2. **connector-sdk の版の付け方と、検索プロファイルを返す既存のプラグインの扱い。**
   - 版: v0.7 とし、ADR-017 追補 1 の追加(推奨の案の専用フィールド)と同じ版にする【既定】。フィールドの削除は互換を壊す変更だが、0.x の版なので小数点以下を上げる
   - 既存のプラグイン(v0.6 の型で `searchProfile` を返すもの)の実行時の扱い: (a) **無視する【既定】**。Gateway の射影は既知のフィールドだけから組み立て直すため(TM-A1。`gateway.ts:656-678`)、削除後は追加の処理なしに落ちる。Orchestrator の `describeSchema`(zod の `z.object`)も未知のキーを捨てる。v0.7 の型で再ビルドしたプラグインは、戻り値のオブジェクトリテラルに `searchProfile` があれば型検査で気づける。(b) Gateway が `searchProfile` を見つけたら、フィールド名だけを WARNING に出す(値は出さない)。(c) エラーにする。エラーにすると、そのソースの `describe` が全利用者で失敗する
   - deployment.yaml の `connectors[].searchProfile`: **起動時に拒否する【既定】**(`connectorSchema` は `strictObject` のため、項目を消せば未知のキーとして拒否される。エラーの文面で本追補を示す)。黙って無視すると、導入先が上書きが効いていると誤解する
3. **開発用コネクタと `dev-search-eval` の `--spec-delivery`(`summary` / `both` / `profile` / `split`)を消すか。**
   - (a) **消す【既定】**。残すには SDK の型・値域の検証と Orchestrator のテンプレートを開発用に残すことになり、削除にならない。過去の計測の再現は、評価文書に記録したコミット(`7860c93`、`6fa7a69`)を取り出して行う。開発用コネクタの模擬の方式は、伝え方 `summary` の構成(自由文だけ)に固定し、既定の方式にも自由文の検索の仕様を書く
   - (b) 残す(開発用コネクタと評価の中だけで検索プロファイルを持つ)。本番の経路と評価の経路が分かれ、評価の結果が本番の構成を表さなくなる
4. **見直しの条件(上の 1〜4)はこれでよいか。**

### 参照

- `docs/eval/2026-11-26-search-eval-spec-delivery-haiku.md`、`docs/eval/2026-11-26-search-eval-spec-delivery-split-haiku.md`
- ADR-017 追補 1(describe の結果を出所で分けて渡す)
- ADR-005、ADR-007、ADR-012、ADR-016 追補 1・追補 2
- T-032(実装)、T-029(実機での確認。結果は検索の仕様の自由文に書く)、T-030(削除の対象を実装したタスク)
