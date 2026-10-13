# ADR-014: Slackの取り扱い — RTS/公式MCP第一候補と中央インデックス化の原則不可

Status: Accepted(導入形態は 2026-10-13 に類型(a)で確定。issue #59) / Date: 2026-07-05

## 文脈(検証済みの外部事実)
- 2026-02-17にSlack公式MCPサーバーとReal-time Search(RTS)APIが正式リリース(2025-05に構想とToS更新、2025-10にRTS limited release)。RTSは旧Data Access APIの発展形
- RTS公式ドキュメントは取得データの**保存・コピー禁止**、**学習利用禁止**、クエリと無関係なスクレイピング禁止を明記
- API ToSは第三者アプリ提供者による他組織APIデータの**永続コピー・アーカイブ・インデックス・長期データストアの作成を禁止**。一時的キャッシュは即時動作に必須な範囲+速やかな削除に限定
- Commercial Distributionの制約は**テンプレート化されたcustom appにも適用**され、適用除外は「単一の第三者専用に作られたアプリ」のみ。MCP利用はMarketplace掲載アプリまたはinternal appに限定
- RTSは権限透過検索・フェデレーテッド検索をユースケースとして掲げる(本プロジェクトのPhase 1要件と一致)

## 決定
1. Slackは**オンデマンド検索ソース**として扱う。中央インデックス化(Phase 2 ingest)は契約・利用条件・導入形態が確認できた場合のみ検討する。product-design.md 5.1の「Slackは昇格の典型例」は本ADRで無効化する
2. T-006は**公式Slack MCPサーバー/RTS APIを第一候補**として評価する。legacyなsearch系メソッド前提の実装は行わない(fallbackとして採用する場合はADR必須)
3. RTS/公式MCP経由で取得した**データを永続化しない**: 対象は本文・スニペットに限らず、permalink・channel名/ID・user名/ID・file名・timestamp(thread_ts含む)等のSlack由来メタデータを含む(Slack ToSは「このAPIで取得したデータ」を保存・コピー禁止としており本文に限定していない)。監査ログ・評価ログ・キャッシュ・Source Catalog/マップ生成の入力・最終回答の永続履歴のいずれにも含めない(CLAUDE.md不変条件7)。documentId等がSlackメタデータ由来(channel:ts、permalink)の場合は不可逆化する。SDK上の表現(例: dataPersistence capability)はfitting検証を通してから判断する
4. private/DM/MPDMスコープの扱いはADR-013に従う(既定excluded)

4. Slack由来コンテンツを含む**最終回答・チャット履歴・評価成果物**の保持方針はT-009/T-008/ADR-013に従い、非永続化またはredaction/不可逆化・短期保持のいずれかを選ぶ(回答にはSlackの固有名詞・要約・permalinkが混入しうる)

## 未決事項(人間タスク) — 2026-10-13 に決着(下の追記)
導入形態3類型 — (a) customer-owned self-hosted internal app、(b) vendor-managed single-tenant、(c) Marketplace app — のAPI Terms適合性の法務/Slack確認。OSSを各社が自社で登録・運用する(a)が最有力だが、ベンダーが同一テンプレートで複数社に展開する場合、商用配布と見なされMarketplace経由またはパートナー契約が必要になる可能性がある。確認結果を本ADRに追記し、導入プレイブックに反映する。

## 追記(2026-10-13): 導入形態の決定(オーナー決定、issue #59)
- 導入形態は **類型(a) customer-owned self-hosted internal app** とする。各導入企業が自社のワークスペースで Slack アプリを自分で登録・運用し、OSS のコードを自社内で動かす。Slack から見たアプリの提供者は導入企業で、利用は自社内に閉じるため、API Terms の Commercial Distribution に当たらないと判断した
- 前提: **アプリの登録と運用は導入企業自身が行い、ベンダーは Slack アプリやそのテンプレートを顧客に渡さない**。導入手順(docs/install.md)もこの形で書く
- 残る論点(#59 に記録): (1) 有償の導入支援・運用につながる場合、Commercial Distribution の定義にある「有償の製品・サービスにつながる無償アプリ」に当たりうる。(2) ベンダーがアプリを用意して顧客に渡す形(類型(b))は「顧客へのカスタムアプリ・テンプレートの提供」に当たりうる。有償の導入支援を始めるとき、またはベンダー側でアプリを登録・運用する形を検討するときに法務 / Slack に確認する
- 決定 3(取得データの非永続、不変条件7)は商用配布の制約とは別の条項に基づくため、本決定で変わらない。汎用 UI の履歴と不変条件7 の関係(ADR-018 決定5 の解除条件、docs/ui-librechat.md)も別の確認として残る
