# 比較実験(条件 1・2)の実測: 検索方式ごとの recall(2026-11-25)

T-027 の `dev-search-eval` による計測。合成コーパス 425 件(既存 7 件、正解文書 18 件、乱数の種 20261125 で生成した無関係な文書 400 件)、質問 23 問(`examples/eval/search-questions.json`)、limit 10。条件 1 は人が書いたキーワードを `search` に直接入力、条件 2 は利用者の発言をそのまま `search` に入力。条件 3・4(探索 LLM、UI 側 LLM を通す)は実 LLM が必要で未実施。各検索方式は開発用コネクタによる模擬で、実際の esa・Redmine・GitHub の挙動との一致は未確認(T-029)。

## dev-search-eval

- コーパス 425 件(合成)。試行 230 件
- recall@k は正解の文書のうち試行中のいずれかの search で k 位以内に返った割合の平均、順位は最初の正解の順位の中央値(返った試行のみ)、fetch / 引用は正解の文書のうち fetch / 引用した割合の平均

| 方式 | 条件 | 種類 | 試行 | recall@1 | recall@5 | recall@10 | 正解が返った | 順位(中央値) | fetch | 引用 | 棄権 | search/試行 | 0件の search | エラー |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| default | 1 キーワード直接 | known-item | 10 | 80% | 90% | 100% | 10 / 10 | 1 | — | — | — | 1.0 | 0% | 0 |
| default | 1 キーワード直接 | multi-doc | 7 | 57% | 100% | 100% | 7 / 7 | 1 | — | — | — | 2.0 | 0% | 0 |
| default | 1 キーワード直接 | all-answerable | 17 | 71% | 94% | 100% | 17 / 17 | 1 | — | — | — | 1.4 | 0% | 0 |
| default | 1 キーワード直接 | unanswerable | 6 | — | — | — | — | — | — | — | — | 1.0 | 100% | 0 |
| default | 2 発言を直接 | known-item | 10 | 0% | 0% | 0% | 0 / 10 | — | — | — | — | 1.0 | 100% | 0 |
| default | 2 発言を直接 | multi-doc | 7 | 0% | 0% | 0% | 0 / 7 | — | — | — | — | 1.0 | 100% | 0 |
| default | 2 発言を直接 | all-answerable | 17 | 0% | 0% | 0% | 0 / 17 | — | — | — | — | 1.0 | 100% | 0 |
| default | 2 発言を直接 | unanswerable | 6 | — | — | — | — | — | — | — | — | 1.0 | 100% | 0 |
| esa | 1 キーワード直接 | known-item | 10 | 80% | 90% | 100% | 10 / 10 | 1 | — | — | — | 1.0 | 0% | 0 |
| esa | 1 キーワード直接 | multi-doc | 7 | 57% | 100% | 100% | 7 / 7 | 1 | — | — | — | 2.0 | 0% | 0 |
| esa | 1 キーワード直接 | all-answerable | 17 | 71% | 94% | 100% | 17 / 17 | 1 | — | — | — | 1.4 | 0% | 0 |
| esa | 1 キーワード直接 | unanswerable | 6 | — | — | — | — | — | — | — | — | 1.0 | 100% | 0 |
| esa | 2 発言を直接 | known-item | 10 | 0% | 0% | 0% | 0 / 10 | — | — | — | — | 1.0 | 100% | 0 |
| esa | 2 発言を直接 | multi-doc | 7 | 0% | 0% | 0% | 0 / 7 | — | — | — | — | 1.0 | 100% | 0 |
| esa | 2 発言を直接 | all-answerable | 17 | 0% | 0% | 0% | 0 / 17 | — | — | — | — | 1.0 | 100% | 0 |
| esa | 2 発言を直接 | unanswerable | 6 | — | — | — | — | — | — | — | — | 1.0 | 100% | 0 |
| redmine-or | 1 キーワード直接 | known-item | 10 | 60% | 70% | 70% | 7 / 10 | 1 | — | — | — | 1.0 | 0% | 0 |
| redmine-or | 1 キーワード直接 | multi-doc | 7 | 14% | 14% | 50% | 5 / 7 | 8 | — | — | — | 2.0 | 0% | 0 |
| redmine-or | 1 キーワード直接 | all-answerable | 17 | 41% | 47% | 62% | 12 / 17 | 1 | — | — | — | 1.4 | 0% | 0 |
| redmine-or | 1 キーワード直接 | unanswerable | 6 | — | — | — | — | — | — | — | — | 1.0 | 83% | 0 |
| redmine-or | 2 発言を直接 | known-item | 10 | 30% | 50% | 50% | 5 / 10 | 1 | — | — | — | 1.0 | 50% | 0 |
| redmine-or | 2 発言を直接 | multi-doc | 7 | 0% | 0% | 14% | 1 / 7 | 9 | — | — | — | 1.0 | 71% | 0 |
| redmine-or | 2 発言を直接 | all-answerable | 17 | 18% | 29% | 35% | 6 / 17 | 2.5 | — | — | — | 1.0 | 59% | 0 |
| redmine-or | 2 発言を直接 | unanswerable | 6 | — | — | — | — | — | — | — | — | 1.0 | 83% | 0 |
| redmine-and | 1 キーワード直接 | known-item | 10 | 80% | 80% | 80% | 8 / 10 | 1 | — | — | — | 1.0 | 0% | 0 |
| redmine-and | 1 キーワード直接 | multi-doc | 7 | 57% | 57% | 100% | 7 / 7 | 1 | — | — | — | 2.0 | 0% | 0 |
| redmine-and | 1 キーワード直接 | all-answerable | 17 | 71% | 71% | 88% | 15 / 17 | 1 | — | — | — | 1.4 | 0% | 0 |
| redmine-and | 1 キーワード直接 | unanswerable | 6 | — | — | — | — | — | — | — | — | 1.0 | 100% | 0 |
| redmine-and | 2 発言を直接 | known-item | 10 | 0% | 0% | 0% | 0 / 10 | — | — | — | — | 1.0 | 100% | 0 |
| redmine-and | 2 発言を直接 | multi-doc | 7 | 0% | 0% | 0% | 0 / 7 | — | — | — | — | 1.0 | 100% | 0 |
| redmine-and | 2 発言を直接 | all-answerable | 17 | 0% | 0% | 0% | 0 / 17 | — | — | — | — | 1.0 | 100% | 0 |
| redmine-and | 2 発言を直接 | unanswerable | 6 | — | — | — | — | — | — | — | — | 1.0 | 100% | 0 |
| github | 1 キーワード直接 | known-item | 10 | 80% | 80% | 90% | 9 / 10 | 1 | — | — | — | 1.0 | 0% | 0 |
| github | 1 キーワード直接 | multi-doc | 7 | 64% | 71% | 100% | 7 / 7 | 1 | — | — | — | 2.0 | 0% | 0 |
| github | 1 キーワード直接 | all-answerable | 17 | 74% | 76% | 94% | 16 / 17 | 1 | — | — | — | 1.4 | 0% | 0 |
| github | 1 キーワード直接 | unanswerable | 6 | — | — | — | — | — | — | — | — | 1.0 | 100% | 0 |
| github | 2 発言を直接 | known-item | 10 | 0% | 0% | 0% | 0 / 10 | — | — | — | — | 1.0 | 100% | 0 |
| github | 2 発言を直接 | multi-doc | 7 | 0% | 0% | 0% | 0 / 7 | — | — | — | — | 1.0 | 100% | 0 |
| github | 2 発言を直接 | all-answerable | 17 | 0% | 0% | 0% | 0 / 17 | — | — | — | — | 1.0 | 100% | 0 |
| github | 2 発言を直接 | unanswerable | 6 | — | — | — | — | — | — | — | — | 1.0 | 100% | 0 |

質問ごとの最初の正解の順位(× = どの search でも返らなかった。--repeat のときは試行ごとに / で区切る。unanswerable は条件 3・4 の棄権を ○ / ×)

| 質問 | 種類 | default 1 | default 2 | esa 1 | esa 2 | redmine-or 1 | redmine-or 2 | redmine-and 1 | redmine-and 2 | github 1 | github 2 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ki-inc-0412 | known-item | 1 | × | 1 | × | 1 | 1 | 1 | × | 1 | × |
| ki-carryout-rule | known-item | 1 | × | 1 | × | × | × | 1 | × | 1 | × |
| ki-expense-rules | known-item | 1 | × | 1 | × | 1 | × | 1 | × | 1 | × |
| ki-cache-note | known-item | 1 | × | 1 | × | 1 | × | 1 | × | 1 | × |
| ki-pr-1287 | known-item | 1 | × | 1 | × | 1 | 5 | 1 | × | 1 | × |
| ki-minutes-0909 | known-item | 1 | × | 1 | × | 1 | 1 | 1 | × | 1 | × |
| ki-eng-checklist | known-item | 5 | × | 5 | × | × | × | × | × | 10 | × |
| ki-mfp-3f | known-item | 8 | × | 8 | × | × | × | × | × | × | × |
| ki-retry-policy | known-item | 1 | × | 1 | × | 1 | 1 | 1 | × | 1 | × |
| ki-vpn-timeout | known-item | 1 | × | 1 | × | 4 | 4 | 1 | × | 1 | × |
| md-trip | multi-doc | 2 | × | 2 | × | × | × | 8 | × | 4 | × |
| md-pc-broken | multi-doc | 1 | × | 1 | × | 1 | 9 | 1 | × | 1 | × |
| md-telework-vpn | multi-doc | 1 | × | 1 | × | × | × | 1 | × | 1 | × |
| md-incident-report | multi-doc | 1 | × | 1 | × | 8 | × | 1 | × | 1 | × |
| md-leave-handover | multi-doc | 1 | × | 1 | × | 9 | × | 1 | × | 1 | × |
| md-new-member-setup | multi-doc | 3 | × | 3 | × | 8 | × | 8 | × | 6 | × |
| md-expense-howto | multi-doc | 1 | × | 1 | × | 1 | × | 1 | × | 1 | × |
| un-parking | unanswerable | — | — | — | — | — | — | — | — | — | — |
| un-daycare | unanswerable | — | — | — | — | — | — | — | — | — | — |
| un-inc-0999 | unanswerable | — | — | — | — | — | — | — | — | — | — |
| un-minutes-1014 | unanswerable | — | — | — | — | — | — | — | — | — | — |
| un-gym | unanswerable | — | — | — | — | — | — | — | — | — | — |
| un-book-subsidy | unanswerable | — | — | — | — | — | — | — | — | — | — |
