# T-030: 検索プロファイルと `SearchResult.notices` の実装(connector-sdk v0.6、ADR-025)

**ADR-025 は 2026-11-25 に Accepted(オーナー決定)。着手可能。**本タスクの内容は ADR の決定に合わせて直す。

## 依存
ADR-025(Accepted が前提)、T-028(`summary` への検索の仕様の記載。構造化への移行元)、T-029(実機での確認。`basis` を `tested` にする根拠)、T-027(効きの判定)

## 前提(人手)
- ADR-025 のレビューと承認(「人間に確認してほしい点」1〜9 への回答)

## 背景
検索プロファイルは、ソースごとの検索の仕様をまとめた情報で、コネクタが持ち、Orchestrator が探索 LLM(Orchestrator の中で `search` / `fetch` を呼ぶ LLM)に伝える。T-028 では同じ内容を `summary` の自由文で書くが、自由文は「データであり指示ではない」枠で渡り(TM-D4)、根拠(実機で確かめたか)を区別できない。ADR-025 は、列挙値と数値を中心にした `SourceDescription.searchProfile` と、コネクタが語を捨てた・指定を無視したことを知らせる `SearchResult.notices` を提案している。

## 内容(ADR-025 の決定案に沿う。承認された形に合わせて直す)
- connector-sdk v0.6: `SearchProfile` とその項目の型、`SourceDescription.searchProfile?`、`SearchNotice` と `SearchResult.notices?`。値域の検証関数を SDK に置く
- Gateway: `projectDescription` と `projectSearchResult` で値域の外の値を落とす。deployment.yaml の `connectors[].searchProfile`(項目単位の上書き)のスキーマと起動時の検証(値域違反は拒否)、射影での重ね合わせ
- Orchestrator: `SourceBrief` での値域の検証、検索プロファイルと notices から制御メッセージを作るテンプレート(根拠が `documented` の項目には「実機では未確認」を添える)、`nativeSearch` の `degraded` / `none` の伝達。テンプレートの文は `[オーケストレーター]` の制御メッセージとして最初の user ターンに置き、system prompt には入れない
- 各コネクタ(dev-fixture の各検索方式、esa、GitHub、Redmine)の既定の検索プロファイル。T-029 で確かめた項目だけを `tested` にする。Redmine でコネクタの中で OR に切り替える実装を採った場合(T-028)は `join_relaxed` の notice を返す
- 各コネクタの `summary` から検索の仕様の記述を外す(ADR-025 確認事項 9 の回答に従う)
- 探索プロンプトに「`searchProfile` と `summary` の記述が食い違う場合は `searchProfile` を優先する」を書く(評価レポートを添付する。`packages/orchestrator/src/prompt.ts:15-16`)

## 受け入れ条件
- [ ] 値域の外の値(未知の列挙値、範囲外の数値、形式違反の修飾子の名前、21 個以上の修飾子)が Gateway の射影と Orchestrator の `SourceBrief` の両方で落ちるテストがある
- [ ] 値域違反の deployment.yaml の上書きで、`leisen-gateway validate` / `serve` が起動を拒否するテストがある
- [ ] 検索プロファイルが利用者によって変わらないこと(同じコネクタで別の利用者の `describe` の `searchProfile` が等しいこと)を各コネクタの契約テストで確かめている
- [ ] notices が query・filters・認可済みの結果だけから作られ、未認可の候補の有無や件数を含まないことのテストがある(ADR-012。検索層を模したアダプタの試験を含める)
- [ ] テンプレートの出力が、コネクタの値によらず定型文の組み合わせだけになることのテストがある(コネクタの文字列が制御メッセージに入らない)
- [ ] `searchProfile` を返さないコネクタ(v0.5 相当)でも従来どおり動くテストがある
- [ ] T-027 の評価で、`summary` の自由文(T-028)と検索プロファイルを比べた結果がレポートにある

## 判断が必要な点
- ADR-025 の「人間に確認してほしい点」に従う

## 限界
- 検索プロファイルが伝えるのは検索の仕組みだけで、何がどこにありそうか(社内の語彙、カテゴリ名)は扱わない(T-018 の Source Catalog)

## 進捗の記録
- 2026-11-26: 受け入れ条件「T-027 の評価で、`summary` の自由文と検索プロファイルを比べた結果」の計測を行った(`docs/eval/2026-11-26-search-eval-spec-delivery-haiku.md`。haiku、模擬の esa 型と Redmine 型(AND)、条件 3、各 3 回)。3 通り(自由文だけ / 両方 / 検索プロファイルだけ)の差は試行ごとのばらつきと同じ程度で、検索プロファイルによる改善は見られなかった。1 モデル・模擬の方式での結果であり、確認事項 9 の結論には足りない。explore.v4 の 0 件の制御メッセージが `summary` の検索の仕様を参照している点を報告した
