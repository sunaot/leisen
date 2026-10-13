# 導入プレイブック(v0 骨子)

導入1件を進める標準工程(product-design-v2 §1.1)。導入支援エンジニアと導入先管理者が
共同で進める。各工程の完了条件(ゲート)は当該社のKPI達成であり、コア機能のGA条件
(2社以上での本番実績)とは区別する(v2 §3)。

本書はv0の骨子であり、各工程の詳細手順は該当タスクの完了に合わせて拡充する
(アセスメント/PoC詳細はT-012・T-013、カナリア文書スイートはT-013)。

## 工程一覧

| # | 工程 | 概要 | 主な参照 |
|---|---|---|---|
| 1 | アセスメント | 対象ソースの棚卸し、認可実現性の確認(auth-matrix)、privateScopes方針の決定 | docs/auth-matrix.md、ADR-013、docs/usage-policy-template.md |
| 2 | PoC | 限定ユーザー・限定ソースで deployment.yaml を構成し評価セットで検証 | T-008、T-012(リファレンスデプロイ、docs/install.md) |
| 3 | 全社展開 | IdP連携・全対象ソース接続・利用規程の発効・カナリア文書の常設 | T-012(docs/install.md の導入チェックリスト)、T-013、threat-model §カナリア |
| 4 | **検索層有効化判定** | 監査ログの実測に基づき、ソース単位で検索層の有効化(昇格)を判断 | **本書 §有効化判定(T-014)** |
| 5 | ナレッジレイヤー | Phase 3(マップ生成)。v1.0スコープ外 | ADR-008 |

**全導入は検索層OFFで開始する**(v2 §2.3)。工程4より前に searchLayer.enabled を
trueにしない。唯一の例外は nativeSearch "none"(index-required)のソースで、これは
検索層とセットでのみ導入可能(ADR-007、T-010の起動時検証)。

## 有効化判定(工程4)

有効化は証拠駆動(ADR-006)。判断材料は**昇格判定レポート(T-014)**で出す。

### 手順

1. 全社展開から一定期間(目安1〜3ヶ月)の監査ログを対象に、監査閲覧担当が
   レポートを実行する:

   ```
   leisen-promotion-report \
     --audit audit-records.jsonl \
     --sources sources.json \
     --raw-queries raw-queries.jsonl \
     --accessor <監査閲覧担当のuserId> \
     --meta-audit-out meta-audit.jsonl
   ```

   - `--audit` は Gateway の監査ログ 1 つでよい。ToolInvocation も、Orchestrator の run(AnswerRun の
     pending と部分レコード `answer_run_finish` / `answer_run_feedback`)も Gateway が同じファイルに書く
     (ADR-019。leisen-ask / leisen-ask serve は監査ストアに書かない)。複数回の指定は、ADR-019 より前の構成
     (ADR-018 決定4)で Orchestrator が別ファイルに書いた AnswerRun(`answer-runs.jsonl`)を含めて
     集計するために残している。開発用の `audit.sink: stdout` の標準出力も同じ形で読める。標準出力を
     保存したファイルは `umask 077` で作り、監査ログと同じ保持・閲覧の規程(ADR-013 §3)に従う
   - `audit.failureMode` は run API の 3 経路(開始・finish・feedback)にも及ぶ。既定の fail-closed では
     監査を書けない run は始まらず(回答が返らない)、集計から欠けない。`fail-open` にすると ToolInvocation
     だけでなく run の記録も欠けうるため、レポートの母数が実際の利用より少なくなる(docs/install.md §10)
   - 使い方は `leisen-promotion-report --help`。入力の不備はファイル名・行番号(sources.json は
     `sources.json(<パス>): <場所>: <説明>`)で示す。監査レコードでない行は、渡すべき形式の案内付きで拒否する
   - 冒頭の「入力レコード数」には、除いた重複(同じ内容の再送)と、後の状態にまとめた更新
     (finish / feedback の再送で置き換えた古い部分レコード、旧構成の AnswerRun の書き直し。重複では
     ない)を分けて添える。「run数」には放棄(runId の有効期間を過ぎても finish のない pending の run。
     Orchestrator の停止・障害か、終了を申告せずに unresolved を隠した可能性。ADR-019)を添える。
     統合できない部分レコード(孤立 = pending のない finish / feedback、不一致 = userId が違う)が
     あれば件数だけを警告に出す。放棄・孤立・不一致が多ければ判定の前に原因を調べる
   - 失敗クエリの原文がない理由は 2 つに分けて表示する: 保持期間切れ(run の開始が
     `--raw-query-retention-days`、既定 30 日より前。定期実行が遅れた)と未記録(期間内なのに原文がない。
     永続化不可のソースが有効な構成では質問原文を書かない — ADR-019 決定7。それ以外なら書き込み失敗)
   - `--run-ttl-sec`(既定 900)は署名のない旧形式の runId の pending を放棄と判定する有効期間。署名付きの
     runId は payload の有効期間で判定する。Gateway の `gateway.runs.ttlSec` と `audit.rawQueryRetentionDays`
     を変えているなら、同じ値を渡す
   - `sources.json` は sourceId → `{ nativeSearch, slack }` の分類メタ。コネクタ実装の
     ConnectorCapabilities と一致させる
   - 監査ログの閲覧はメタ監査の対象(ADR-013 §3)。`--meta-audit-out` に出力される
     audit_access レコードを必ず監査ストアへ取り込む
   - **rawQueryテーブルの保持期間(既定30日)内に定期実行する**こと。期限切れの
     失敗クエリはdigestのみとなり判定材料にならない
   - レポート本文には失敗クエリの原文(機密を含みうる)が表示される。stdoutを
     監査統制外のファイル・チャット等へリダイレクト・転記して永続化しないこと
     (ADR-013 §3の目的限定。閲覧はその場の判定作業に限る)
2. レポートのソース別未解決率・再検索回数分布・失敗クエリ原文を、レポート同梱の
   判定ガイド(product-design.md 5.1 の昇格基準)に照らして評価する。
   失敗原因のサンプリング調査(「文書は存在するのにネイティブ検索で到達できない」の
   確認)は人手で行う
   - 再検索回数は run 内の search 呼び出しの件数(0回=検索なし、1回=1発、2回以上=再検索)。
     describe / fetch / list は数えない(docs/audit-queries.md §2)
   - レポート冒頭に「警告」(userId が AnswerRun と一致しない ToolInvocation)が出た場合、
     その呼び出しは集計から除外されている。判定の前に docs/audit-queries.md §0 のクエリで
     原因(実装の不具合・runId の申告の偽装)を調べる
3. 昇格を決めたソースについて deployment.yaml の `connectors[].searchLayer.enabled` を
   true にし、Ingest開始・初期インデックス構築・post-filtering稼働の標準手順
   (T-012/T-016以降で確定)を実施する

### 判定上の固定ルール

- **Slackは昇格判定の対象外**(ADR-014)。オンデマンド検索ソースとして扱う
- nativeSearch "none" のソースは証拠駆動ゲートの適用外(ADR-007)
- post-filtering前の候補件数・分離テレメトリは判定材料に使わない(ADR-011/012)
- 昇格は常に最小限(product-design §5.4)。「上位2ソースに集中」しない場合は
  探索戦略の調整(T-007)を先に検討する
