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
   kp-promotion-report \
     --audit audit-records.jsonl \
     --sources sources.json \
     --raw-queries raw-queries.jsonl \
     --accessor <監査閲覧担当のuserId> \
     --meta-audit-out meta-audit.jsonl
   ```

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
