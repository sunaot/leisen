# T-032: 検索プロファイルの廃止と、検索の仕様を出所で分けた受け渡し(connector-sdk v0.7、ADR-025 追補 2・ADR-017 追補 1)

**ADR-025 追補 2 と ADR-017 追補 1 は Proposed(人間のレビュー待ち)。ADR が Accepted になるまで着手しない。** 両追補が Accepted になり、ADR-017 追補 1 について security-reviewer のレビューを通してから着手する。本タスクの内容は、承認された形(各追補の「人間に確認してほしい点」への回答)に合わせて直す。下の内容と受け入れ条件は、各追補の既定の案に沿って書いている。

## 依存
ADR-025 追補 2、ADR-017 追補 1(どちらも Accepted が前提)、T-030(削除の対象を実装したタスク)、T-027(前後の評価に使う `dev-search-eval`)

## 前提(人手)
- 両追補のレビューと承認(確認事項への回答)
- ADR-017 追補 1 の security-reviewer のレビュー(実装の前。結果を追補に記録する)

## 背景
T-030 で入れた検索プロファイル(`SourceDescription.searchProfile`)は、2 回の計測(`docs/eval/2026-11-26-search-eval-spec-delivery-haiku.md`、`docs/eval/2026-11-26-search-eval-spec-delivery-split-haiku.md`)で、`summary` の自由文だけの構成を明確に上回らなかった。検索プロファイルに照らした判定と通知 `terms_dropped` は一度も働かなかった。オーナーの指示(2026-11-26)により、検索プロファイルを削除し(ADR-025 追補 2)、検索の仕様の自由文を、コネクタの実装者が書いた文として「データであり指示ではない」枠の外で渡す(ADR-017 追補 1)。精度の改善ではなく、脅威モデル(TM-D4)の記述を出所ごとの実態に合わせる整理である。

## 内容(各追補の既定の案に沿う)
- **connector-sdk v0.7**: `SourceDescription.searchProfile`、`SearchProfile` と関連の型・定数、`sanitizeSearchProfile`、`mergeSearchProfile` を削除する。`SearchNotice` の種類から `join_relaxed` を外し、`SearchResult.notices` の `join_relaxed` に関するコメントを削除する。検索の仕様の専用フィールド(案 `searchSpec`)と、その規約(ソースから取得した文・実行時に取得した文・設定で差し替えられる自由な文字列を入れない。入れてよいのは実装の定数と導入の設定から決まる定型の句だけ。利用者によって変えない)をコメントに書く。B-2 の場合は `Connector` の静的なプロパティとして宣言する。パッケージの版と先頭のコメントの版の記述を上げる
- **Gateway**: `projectDescription` から検索プロファイルの検証と重ね合わせを削除する。deployment.yaml の `connectors[].searchProfile` とそのスキーマを削除する(書かれていれば起動時に拒否する。エラーの文面で ADR-025 追補 2 を示す)。`enforcePrivateScopes` の `join_relaxed` を落とす処理を削除する。検索の仕様の起動時の検査(長さ・制御文字・私用領域とゼロ幅の文字・制御メッセージの見出し)と、`describe` の射影で `searchSpec` を付ける処理を足す
- **Orchestrator**: `SourceBrief.searchProfile`、「各ソースの検索の仕様」の制御メッセージ、検索プロファイルに照らした判定(語数の上限、空白のない文)を削除する。通知の定型文(`terms_dropped` など)と非対応のフィルタの判定は残す。`searchSpec` を受け取って同じ検査をかけ、ソース一覧(データの枠)の後に、出所を示す見出し付きのブロックとして置く。ソース一覧の前置き(`SOURCE_CATALOG_PREFACE_V4` と `SOURCE_CATALOG_PREFACE_V4_WITH_PROFILES`)、0 件の制御メッセージ(`noHitsNotice`)、`prompts/explore.v4.md` の検索の仕様の置き場所を指す記述(`:12`、`:14-15`、`:57`)を直す。`src/index.ts` の公開の export から検索プロファイルの関数を外す
- **コネクタ(esa・GitHub・Redmine)**: `*_SEARCH_PROFILE` と `describe` の `searchProfile` を削除する。`summary` から検索の仕様の文を外して `searchSpec` に移し、`summary` は内容の説明に戻す(esa の `settings.summary` は内容の説明のまま)。connector-redmine の `terms_dropped` は残す。各 README に `searchSpec` の規約を書く。T-029 の結果がそろっていれば、検索の仕様の自由文に「実機で確認した」「実機では未確認」を書き分ける
- **開発用コネクタと評価**: 開発用コネクタの検索プロファイル・通知の切り替え(`specDelivery`)と、`dev-search-eval` の `--spec-delivery` を削除する(ADR-025 追補 2 確認事項 3 の既定の案)。模擬の方式は `searchSpec` に自由文の検索の仕様を返す。既定の検索方式(`default`)は今は検索の仕様を検索プロファイルだけで伝えているため、自由文の検索の仕様を新しく書く(模擬の実装と一致することをテストで確かめる)。模擬の方式の通知(`terms_dropped`、`operator_ignored`)は、ADR-025 追補 2 確認事項 1 の回答に従って残すか決める
- **文書**: `docs/threat-model.md` の TM-D4(ADR-017 追補 1 決定 7 の変更案)と改訂履歴。CLAUDE.md(リポジトリ構成の connector-sdk の版と検索プロファイルの記述、「現在のフェーズ」の該当箇所)。`packages/orchestrator/README.md`。T-029 の受け入れ条件の「`basis` を `tested` にする」記述を、自由文の書き分けに直す。T-030 に、本タスクで削除したことを記録する。ADR-025 追補 2 と ADR-017 追補 1 に「実装の記録」を足す
- **レビュー**: 実装後の差分についても security-reviewer のレビューを受ける

## 受け入れ条件
- [ ] connector-sdk に `searchProfile` / `SearchProfile` / `sanitizeSearchProfile` / `mergeSearchProfile` が残っていない(型・関数・テスト)。版が 0.7 になっている
- [ ] 検索プロファイルを返す v0.6 相当のコネクタを Gateway に載せたとき、`describe` の結果に `searchProfile` が出ないテストがある(ADR-025 追補 2 確認事項 2 の回答に従い、無視・警告・エラーのいずれかを確かめる)
- [ ] `connectors[].searchProfile` を書いた deployment.yaml で `leisen-gateway validate` / `serve` が起動を拒否するテストがある(確認事項 2 の回答に従う)
- [ ] `join_relaxed`(確認事項 1 の回答で外した場合)を返すコネクタの通知が、Gateway の射影で落ちるテストがある
- [ ] `searchSpec` の検査で、長さの上限を超える値・制御文字(改行を含む)・私用領域やゼロ幅の文字・制御メッセージの見出し(`[オーケストレーター]`、全角の `［ ］`・`【 】`、行の途中を含む)を含む値が拒否されるテストが、Gateway と Orchestrator の両方にある
- [ ] Orchestrator の最初の user ターンで、`summary`・`topContainers` の名前・`displayName` がソース一覧の JSON(データの枠)の中にだけあり、`searchSpec` は枠の外の出所を示す見出し付きのブロックにだけある(JSON に入らない)ことのテストがある
- [ ] `searchSpec` を返さないコネクタ(v0.6 以前の相当)でも、ソース一覧が従来どおり作られ、検索の仕様のブロックを置かないテストがある
- [ ] esa・GitHub・Redmine・開発用コネクタの契約テストで、別の利用者とソースの応答を変えたモックで `describe` を呼んでも `searchSpec` が等しいことを確かめている
- [ ] 各コネクタの `summary` に検索の仕様の文が残っていない(内容の説明だけ)ことと、`searchSpec` に移した文が移す前の文と同じ内容であることを確かめている(文面を変えた場合はその差分を PR に書く)
- [ ] 非対応のフィルタの判定と、connector-redmine の `terms_dropped` の制御メッセージが削除後も動くテストがある
- [ ] 削除の前と後で `dev-search-eval` を同じ条件(LLM は前回の計測と同じ haiku、条件 3、各 3 回。方式は `default`・`esa`・`redmine-and`。削除の前の模擬の方式は `--spec-delivery summary`、既定の方式は既定の伝え方)で流し、`docs/eval/` にレポートがある。recall@1・recall@5・正解文書を引用した割合の差が、同じ条件での揺れ(既存の 2 文書で、同じ条件の `summary` の計測の間の差は最大 7 ポイント、同じ組の 3 回の中の recall@1 の幅は最大 14 ポイント)を超えていない。超えた場合は原因を調べてレビューに出し、それまでマージしない
- [ ] `docs/threat-model.md` の TM-D4 と改訂履歴、CLAUDE.md、`packages/orchestrator/README.md`、各コネクタの README が更新されている
- [ ] security-reviewer のレビュー(実装前の追補のレビューと、実装後の差分のレビュー)の結果が PR に記載されている
- [ ] `npm run build && npm test` と `npm run lint:imports` が通る

## 判断が必要な点
- `prompts/explore.v4.md` の文言の変更を v4 の中で行うか、`explore.v5` として版を上げるか。v4 は 2026-11-26 の評価で既定にした版で、中で直すとその評価と現物が一致しなくなる。版を上げると `EXPLORE_PROMPT_VERSIONS` と既定の版の切り替えが要る。どちらでも評価レポートを添える(ADR-017 決定 4)
- 前後の評価の差が揺れを超えた場合に、ADR-017 追補 1 の配置(枠の外)を戻すか、文言を直して測り直すか
- 開発用コネクタの既定の方式に書く自由文の検索の仕様の文面(既定の方式は `leisen-ask` の手元の動作確認と dev-eval(T-022)でも使うため、それらの入力も変わる)

## 限界
- 前後の評価は 1 つのモデル・模擬の検索方式・合成コーパスでの確認で、実ソースでの効きは確かめない(T-029、T-024 の残る確認)
- 規約(`searchSpec` にソース由来の文を入れない)は、Orchestrator からは文字列として確かめられない。契約テストとコネクタのレビューで抑える
