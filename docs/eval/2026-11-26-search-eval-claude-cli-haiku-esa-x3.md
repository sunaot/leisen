# 比較実験(条件 3・4)の実測: haiku、esa 型、v3 と v4、各 3 回(2026-11-26)

T-027 の `dev-search-eval` による計測。T-030(検索プロファイル)、T-031(`ask` の引数)、セキュリティレビューの指摘の修正を統合した後のコード(コミット 264fa38)で実行した。前回の各 1 回の計測は `docs/eval/2026-11-25-search-eval-claude-cli-haiku-esa.md`。

## 実行条件

- LLM: `claude -p --model haiku`(探索 LLM と UI 側 LLM の両方)。構造化出力によるツール呼び出しの模擬で、ネイティブのツール呼び出しではない。Anthropic API のバックエンドでの結果とはみなせない
- 検索方式: 開発用コネクタの esa 型(模擬)。実際の esa の挙動との一致は未確認(T-029)。esa 型は検索プロファイルを返さないので、v4 が受け取る検索の仕様は `summary` の自由文だけである。検索プロファイルの文の効果はこの計測に含まれない
- コーパス: 合成 425 件。質問: 23 問(既知項目検索 10、複数文書 7、答えられない 6)
- 条件 3: 利用者の発言を探索 LLM に渡す。条件 4: UI 側 LLM が作った `question` を探索 LLM に渡す
- v3: 既定の設定。v4: `--explore-prompt explore.v4 --search-feedback on`
- 各 3 回(`--repeat 3`)。v3 と v4 は別のプロセスで同時に実行した

## 要約(正解のある 17 問 × 3 回 = 51 試行)

| | v3 条件 3 | v3 条件 4 | v4 条件 3 | v4 条件 4 |
|---|---|---|---|---|
| recall@1 | 40% | 42% | 81% | 79% |
| recall@5 | 70% | 69% | 95% | 92% |
| recall@10 | 94% | 94% | 99% | 99% |
| 正解文書を fetch した割合 | 64% | 49% | 97% | 97% |
| 正解文書を引用した割合 | 92% | 91% | 97% | 95% |
| search / 試行 | 1.7 | 1.7 | 3.5 | 3.5 |
| LLM ターン / 試行 | 2.9 | 2.6 | 3.2 | 3.2 |
| 答えられない質問の棄権 | 18 / 18 | 18 / 18 | 18 / 18 | 18 / 18 |
| 答えられない質問の search / 試行 | 9.4 | 9.7 | 14.4 | 12.9 |

費用と時間: v3 は $0.88、`claude -p` の呼び出し 567 回(構造化出力が読めなかった失敗 6 回)。v4 は $1.12、603 回(同 3 回)。合計 $2.00。

## 読み取れること(事実)

- v4 は、既知項目検索の 10 問すべてで、3 回とも正解が 1 位に返った。v3 は 10 問中 4 問で、3 回とも 2 位以下(5〜6 位が 3 問)だった
- 複数文書の質問では、v4 の recall@1 は 50〜55%、v3 は 21% だった。`md-expense-howto` は v4 でも 6 回中 5 回が 6 位で、改善していない
- 条件 3 と条件 4 の差は、v3・v4 とも recall で 3 ポイント以内だった。fetch の割合は v3 で 64% と 49% の差があった
- 答えられない質問は、どの条件でも 18 試行すべてで棄権した。v4 は v3 より多く検索してから棄権した(14.4 回と 9.4 回)
- CLI の内部で 3 ターン以上かかった呼び出しは、v3 で 567 回中 427 回、v4 で 603 回中 293 回だった(モデルが CLI の中でツールを直接呼ぼうとした目安)

## 限界

- 1 つのモデル(haiku)、1 つの検索方式(esa 型の模擬)、合成コーパスでの結果である
- ツール呼び出しの模擬の影響を受けている。上の「3 ターン以上」の割合が v3 と v4 で違うため、模擬とのずれが両者に同じだけ効いているとは言えない
- 質問セットのコミット(`ec0f148`)は v4 のプロンプトのコミット(`44667e2`)より 9 分前だが、同じ日に並行して作られた。T-024 の「質問を事前に固定する」条件を満たすかは人間の判断が要る
- 回答の正しさ(内容の採点)は測っていない。測ったのは、正解文書が検索で返ったか、fetch したか、引用したかである

## v3 の全表


- コーパス 425 件(合成)。試行 138 件
- recall@k は正解の文書のうち試行中のいずれかの search で k 位以内に返った割合の平均、順位は最初の正解の順位の中央値(返った試行のみ)、fetch / 引用は正解の文書のうち fetch / 引用した割合の平均
- 探索プロンプト explore.v3、検索の状況の制御メッセージ 無効
- LLM は claude -p(--model haiku)。構造化出力(--json-schema)によるツール呼び出しの模擬で、ネイティブのツール呼び出しではない。Anthropic API のバックエンドとは挙動が違いうる
- claude -p の呼び出し 567 回(失敗 6: llm_unexpected_response(success) 6)、費用の合計 $0.8795(total_cost_usd の合計)、所要時間の合計 2963.0 秒(子プロセスの実時間の合計)、CLI の内部で 3 ターン以上かかった呼び出し 427 回

| 方式 | 条件 | 種類 | 試行 | recall@1 | recall@5 | recall@10 | 正解が返った | 順位(中央値) | fetch | 引用 | 棄権 | search/試行 | LLMターン/試行 | 0件の search | エラー |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| esa | 3 発言→探索LLM | known-item | 30 | 53% | 73% | 97% | 29 / 30 | 1 | 57% | 93% | — | 1.4 | 2.8 | 0% | 0 |
| esa | 3 発言→探索LLM | multi-doc | 21 | 21% | 64% | 90% | 21 / 21 | 3 | 74% | 90% | — | 2.2 | 3.1 | 4% | 0 |
| esa | 3 発言→探索LLM | all-answerable | 51 | 40% | 70% | 94% | 50 / 51 | 2 | 64% | 92% | — | 1.7 | 2.9 | 2% | 0 |
| esa | 3 発言→探索LLM | unanswerable | 18 | — | — | — | — | — | — | — | 18 / 18 | 9.4 | 5.7 | 77% | 0 |
| esa | 4 UI LLM→探索LLM | known-item | 30 | 57% | 77% | 100% | 30 / 30 | 1 | 40% | 100% | — | 1.4 | 2.5 | 0% | 0 |
| esa | 4 UI LLM→探索LLM | multi-doc | 21 | 21% | 57% | 86% | 21 / 21 | 4 | 62% | 79% | — | 2.0 | 2.9 | 0% | 0 |
| esa | 4 UI LLM→探索LLM | all-answerable | 51 | 42% | 69% | 94% | 51 / 51 | 2 | 49% | 91% | — | 1.7 | 2.6 | 0% | 0 |
| esa | 4 UI LLM→探索LLM | unanswerable | 18 | — | — | — | — | — | — | — | 18 / 18 | 9.7 | 5.9 | 76% | 0 |

質問ごとの最初の正解の順位(× = どの search でも返らなかった。--repeat のときは試行ごとに / で区切る。unanswerable は条件 3・4 の棄権を ○ / ×)

| 質問 | 種類 | esa 3 | esa 4 |
|---|---|---|---|
| ki-inc-0412 | known-item | 1/1/1 | 1/1/1 |
| ki-carryout-rule | known-item | 6/6/6 | 6/6/6 |
| ki-expense-rules | known-item | 6/6/6 | 6/6/6 |
| ki-cache-note | known-item | 1/1/1 | 1/1/1 |
| ki-pr-1287 | known-item | 1/1/1 | 1/1/1 |
| ki-minutes-0909 | known-item | 1/1/× | 1/1/1 |
| ki-eng-checklist | known-item | 5/5/5 | 5/5/5 |
| ki-mfp-3f | known-item | 1/8/1 | 8/1/1 |
| ki-retry-policy | known-item | 1/1/1 | 1/1/1 |
| ki-vpn-timeout | known-item | 2/2/2 | 2/2/2 |
| md-trip | multi-doc | 1/1/1 | 1/5/5 |
| md-pc-broken | multi-doc | 1/3/3 | 1/1/3 |
| md-telework-vpn | multi-doc | 4/4/4 | 4/4/4 |
| md-incident-report | multi-doc | 1/1/1 | 1/1/1 |
| md-leave-handover | multi-doc | 3/3/3 | 3/1/1 |
| md-new-member-setup | multi-doc | 6/1/3 | 6/6/6 |
| md-expense-howto | multi-doc | 6/6/6 | 6/6/6 |
| un-parking | unanswerable | ○/○/○ | ○/○/○ |
| un-daycare | unanswerable | ○/○/○ | ○/○/○ |
| un-inc-0999 | unanswerable | ○/○/○ | ○/○/○ |
| un-minutes-1014 | unanswerable | ○/○/○ | ○/○/○ |
| un-gym | unanswerable | ○/○/○ | ○/○/○ |
| un-book-subsidy | unanswerable | ○/○/○ | ○/○/○ |

## v4 の全表


- コーパス 425 件(合成)。試行 138 件
- recall@k は正解の文書のうち試行中のいずれかの search で k 位以内に返った割合の平均、順位は最初の正解の順位の中央値(返った試行のみ)、fetch / 引用は正解の文書のうち fetch / 引用した割合の平均
- 探索プロンプト explore.v4、検索の状況の制御メッセージ 有効
- LLM は claude -p(--model haiku)。構造化出力(--json-schema)によるツール呼び出しの模擬で、ネイティブのツール呼び出しではない。Anthropic API のバックエンドとは挙動が違いうる
- claude -p の呼び出し 603 回(失敗 3: llm_unexpected_response(success) 3)、費用の合計 $1.1216(total_cost_usd の合計)、所要時間の合計 3182.9 秒(子プロセスの実時間の合計)、CLI の内部で 3 ターン以上かかった呼び出し 293 回

| 方式 | 条件 | 種類 | 試行 | recall@1 | recall@5 | recall@10 | 正解が返った | 順位(中央値) | fetch | 引用 | 棄権 | search/試行 | LLMターン/試行 | 0件の search | エラー |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| esa | 3 発言→探索LLM | known-item | 30 | 100% | 100% | 100% | 30 / 30 | 1 | 100% | 100% | — | 2.8 | 3.2 | 4% | 0 |
| esa | 3 発言→探索LLM | multi-doc | 21 | 55% | 88% | 98% | 21 / 21 | 1 | 93% | 93% | — | 4.4 | 3.3 | 18% | 0 |
| esa | 3 発言→探索LLM | all-answerable | 51 | 81% | 95% | 99% | 51 / 51 | 1 | 97% | 97% | — | 3.5 | 3.2 | 11% | 0 |
| esa | 3 発言→探索LLM | unanswerable | 18 | — | — | — | — | — | — | — | 18 / 18 | 14.4 | 5.8 | 83% | 0 |
| esa | 4 UI LLM→探索LLM | known-item | 30 | 100% | 100% | 100% | 30 / 30 | 1 | 100% | 97% | — | 2.8 | 3.1 | 6% | 0 |
| esa | 4 UI LLM→探索LLM | multi-doc | 21 | 50% | 81% | 98% | 21 / 21 | 1 | 93% | 93% | — | 4.5 | 3.3 | 23% | 0 |
| esa | 4 UI LLM→探索LLM | all-answerable | 51 | 79% | 92% | 99% | 51 / 51 | 1 | 97% | 95% | — | 3.5 | 3.2 | 15% | 0 |
| esa | 4 UI LLM→探索LLM | unanswerable | 18 | — | — | — | — | — | — | — | 18 / 18 | 12.9 | 5.4 | 83% | 0 |

質問ごとの最初の正解の順位(× = どの search でも返らなかった。--repeat のときは試行ごとに / で区切る。unanswerable は条件 3・4 の棄権を ○ / ×)

| 質問 | 種類 | esa 3 | esa 4 |
|---|---|---|---|
| ki-inc-0412 | known-item | 1/1/1 | 1/1/1 |
| ki-carryout-rule | known-item | 1/1/1 | 1/1/1 |
| ki-expense-rules | known-item | 1/1/1 | 1/1/1 |
| ki-cache-note | known-item | 1/1/1 | 1/1/1 |
| ki-pr-1287 | known-item | 1/1/1 | 1/1/1 |
| ki-minutes-0909 | known-item | 1/1/1 | 1/1/1 |
| ki-eng-checklist | known-item | 1/1/1 | 1/1/1 |
| ki-mfp-3f | known-item | 1/1/1 | 1/1/1 |
| ki-retry-policy | known-item | 1/1/1 | 1/1/1 |
| ki-vpn-timeout | known-item | 1/1/1 | 1/1/1 |
| md-trip | multi-doc | 1/1/1 | 1/1/1 |
| md-pc-broken | multi-doc | 1/1/1 | 1/3/1 |
| md-telework-vpn | multi-doc | 1/1/1 | 1/1/1 |
| md-incident-report | multi-doc | 1/1/1 | 1/1/1 |
| md-leave-handover | multi-doc | 1/1/3 | 4/1/4 |
| md-new-member-setup | multi-doc | 1/1/1 | 1/1/1 |
| md-expense-howto | multi-doc | 3/6/6 | 6/6/6 |
| un-parking | unanswerable | ○/○/○ | ○/○/○ |
| un-daycare | unanswerable | ○/○/○ | ○/○/○ |
| un-inc-0999 | unanswerable | ○/○/○ | ○/○/○ |
| un-minutes-1014 | unanswerable | ○/○/○ | ○/○/○ |
| un-gym | unanswerable | ○/○/○ | ○/○/○ |
| un-book-subsidy | unanswerable | ○/○/○ | ○/○/○ |
