# T-031: `ask` の引数の追加と返り値の「試した検索」(ADR-026)

**ADR-026 は 2026-11-25 に Accepted(オーナー決定)。着手可能。**本タスクの内容は ADR の決定に合わせて直す。Slack 有効時の生クエリ表の扱い(ADR-026 決定 5、確認事項 8)は T-006 の前に決める必要があるため、その部分だけを先に決めて実装してもよい。

## 依存
ADR-026(Accepted が前提)、T-021(`leisen-ask serve`)、T-023(run API)、T-024(`ask` の description と `instructions` の改訂。引数を変えない段階)、T-027(キーワードの保持率の計測)

## 前提(人手)
- ADR-026 のレビューと承認(「人間に確認してほしい点」1〜9 への回答)
- LibreChat での通し確認(ブラウザでの ask → 回答の確認)は人手

## 背景
`ask` の引数は自然文の `question` 1 つで(ADR-018 決定 1)、利用者が入力したキーワード(利用者の発言にそのまま含まれる固有名詞・ID・エラーメッセージ・引用符で囲まれた語句など)が UI 側 LLM(LibreChat で `ask` を呼ぶ LLM)の書き直しで失われても、Orchestrator には区別できない。また、探索の中で試した検索と 0 件だったソースは、探索 LLM が回答に書かない限り UI 側に返らない。ADR-026 は、省略可能な引数(`userMessage` / `context` / `keepTerms` / `sources` / `period` / `depth`)と、返り値の `searchesTried` を提案している。

## 内容(ADR-026 の決定案に沿う。承認された形に合わせて直す)
- `packages/orchestrator/src/server/tools.ts`: 入力のスキーマ(`z.strictObject`)、各引数の description、`instructions`
- `packages/orchestrator/src/prompt.ts`: 最初の user ターンの区分(利用者の発言そのまま / UI 側 LLM による補足 / 利用者が入力したキーワード / 対象のソース・期間)。どれも利用者ターンの入力として置き、制御メッセージにしない
- `sources` による run の有効ソースの絞り込み、`depth` による `maxIterations` の選択(設定値を超えない)
- `searchesTried` の組み立て(`newDocuments` は認可済みで返ったヒットから数える)と、outcome が resolved 以外のときの「探した範囲」の表示(`render.ts`)
- run API(ADR-019 の追補): `POST /runs` で申告する質問の形(ADR-026 決定 4)と、生クエリ表の記録
- Slack(永続化できないソース)が有効な構成での扱い(ADR-026 決定 5): `search` のクエリ原文を生クエリ表に書かない、`searchesTried` から query を除く
- `docs/ui-librechat.md` の更新

## 受け入れ条件
- [ ] 追加の引数を省いた呼び出し(従来の `ask({ question })`)が従来どおり動くテストがある
- [ ] 上限を超えた引数・有効でない sourceId・未知の引数を固定文言で拒否し、値をエラー文にエコーしないテストがある
- [ ] 追加の引数が最初の user ターンの利用者の入力の区分に入り、`[オーケストレーター]` の制御メッセージとして扱われないことのテストがある
- [ ] `sources` で絞ったとき、それ以外のソースへのツール呼び出しが実行されないテストがある。`depth` が設定値の `maxIterations` を超えないテストがある
- [ ] `searchesTried` の `newDocuments` が認可済みで返ったヒットだけから数えられ、権限外と不在を区別する情報を含まないテストがある(ADR-012)
- [ ] Slack(永続化できないソース)が有効な構成で、生クエリ表に検索のクエリ原文が書かれず、`searchesTried` に query が載らないテストがある(不変条件 7)
- [ ] run API で申告する質問の形と digest の計算が、昇格判定レポート(T-014)で読めることをゴールデンテストで確かめている
- [ ] T-027 の条件 3 と 4 で、引数の追加の前後のキーワードの保持率と、正解文書の recall@k を比べた結果がレポートにある

## 判断が必要な点
- ADR-026 の「人間に確認してほしい点」に従う

## 限界
- UI 側 LLM が追加の引数を埋めるかはモデルと UI の実装に依存する。LibreChat が UI 側 LLM に渡すシステムプロンプトの全体はリポジトリになく、v0.8.7 の実装に依存する
