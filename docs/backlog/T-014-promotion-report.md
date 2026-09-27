# T-014: 昇格判定レポート

## 目的
ADR-006の「有効化は証拠駆動」を製品機能にする。導入各社の管理者と導入支援エンジニアが検索層有効化を判断する材料を出す。

## 内容
- 監査ログ(T-001の2層モデル)から、ソース別の未解決率(AnswerRun単位)・再検索回数分布(runIdで束ねたToolInvocation)・失敗クエリを集計するCLIレポート
- **失敗クエリの原文表示**: rawQueryテーブル(短期保持)をqueryDigestで結合して表示する。digestのみの出力は判定材料にならない
- **post-filtering前の候補件数は扱わない**(ADR-011/012。分離テレメトリは本レポートの対象外)
- 出力に判定ガイド(product-design.md 5.1の昇格基準)を含める。ただし**Slackは昇格判定の対象外**(ADR-014: 中央インデックス化は原則不可)であり、その旨をガイドに明記
- nativeSearch: "none" のソースは証拠駆動ゲートの適用外(ADR-007)
- 将来の管理画面化を見据え、集計ロジックはUIから分離

## 受け入れ条件
- [ ] 合成ログデータ(2層モデル)でのゴールデンテストがある
- [ ] rawQuery保持期間切れの場合の表示(digestのみ+期限切れ表示)がテストされている
- [ ] レポートが導入プレイブックの「有効化判定」工程から参照されている

## 更新(2026-09-27): 再検索回数の定義変更と (runId, userId) 結合

ADR-011 追記(2026-09-17)と T-007 の実装により、`ToolInvocation.iteration` は「run 内のツール呼び出しの通番」(0 始まり。describe / search / fetch / list をすべて含み、並列呼び出しも個別に採番)になった。T-007 の Orchestrator は run の冒頭で全ソースに describe を呼ぶ。従来の「search の max(iteration)+1」は describe や fetch の呼び出しまで再検索回数に数えていた(ADR-017 確認事項4)。また AnswerRun と ToolInvocation の結合は (runId, userId) で行い、不一致を警告として扱う方針になった(docs/audit-queries.md §0、T-007 セキュリティレビュー H1)。これに合わせて `packages/promotion-report` の集計を直した。

- **再検索回数** = 結果確定済み(resolved / unresolved)run 内の search の ToolInvocation の件数(冪等キー requestId で重複行を除き、(runId, userId) で束ねたもの)。**0回 = 検索なし、1回 = 1発、2回以上 = 再検索**。describe / fetch / list は数えない。iteration は run 内の順序付けにだけ使い、回数には使わない。結果確定済み run はすべていずれかの区分に入る(search のない run は 0回。従来は search のない run は分布に現れなかった)
- JSON 出力のフィールド名を変えた(定義が変わったため、同じ名前で意味を変えない): `iterationDistribution[].searchIterations` → `searchCountDistribution[].searchCount`(型 `IterationBucket` → `SearchCountBucket`)。テキスト出力の見出しは「再検索回数分布(run内のsearch呼び出し件数: 0回=検索なし、1回=1発、2回以上=再検索)」、各区分に「検索なし / 1発 / 再検索」の区分名を付けた
- **(runId, userId) 結合**: 同じ runId の AnswerRun があるのに userId が一致しない ToolInvocation は、ソース別未解決率・再検索回数分布の集計から除外し、run ごとの件数を警告として出す(JSON `userMismatchWarnings: [{ runId, invocations }]`、テキストはレポート冒頭の「警告」節。不一致がなければ節ごと出さない)。出すのは runId と件数だけで、userId・文書ID・クエリは出さない。AnswerRun のない runId の呼び出し(runId 未申告の単発呼び出し等)は不一致ではなく、ソース別の呼び出し数(invocations)にだけ数える
- **ソース別未解決率**: run の所属(runs / unresolvedRuns / share)に describe を数えない(run の冒頭の全ソースへの describe で、全ソースが全 run に現れるのを防ぐ)。invocations(呼び出し数)は describe を含む全呼び出し数のまま
- テスト(`packages/promotion-report/test/`): `fixture.ts` を T-007 の実際の形(run の冒頭の全ソースへの describe、ツール呼び出しの通番、search 0回の run)に更新。describe / fetch / list を含む run で再検索回数が search 件数になること(iteration の採番・記録順に依存しない)、重複行を除いて数えること、userId 不一致が除外されて警告に runId と件数だけが出ること、AnswerRun のない runId は警告にしないこと、describe だけのソースを run に数えないこと、テキスト表示の区分名と警告節
- 文書: docs/audit-queries.md §0(レポートの追随、件数は `COUNT(DISTINCT requestId)`)・§1(describe を除く)・§2(search 件数ベースのクエリ)、docs/playbook.md(有効化判定の手順2)、ADR-017 確認事項4 に対応を追記
