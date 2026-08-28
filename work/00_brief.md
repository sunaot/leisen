# 00 Brief

- Product: leisen(霊泉)— 社内ナレッジをLLMが権限透過で検索できるようにするOSS基盤(MCP Gateway + コネクタ群 + Orchestrator + 汎用検索層)。開発元はSaaS運営を行わず、導入支援・運用サポートを事業とする
- What it does (3 lines, product's own words):
  1. 社内のGoogle Drive / Slack / GitHub / wiki等を、LLM(チャット/エージェント)が本人権限のまま横断検索し、出典リンク付きで回答する
  2. 認可は常にデータソースに委譲する(独自の権限モデル・ACL複製を持たない)。全ツール呼び出しを監査ログに全件記録する
  3. OSSとして各社が自社環境にシングルテナント導入する。個社差分は deployment.yaml と3つのプラグイン境界(Connector / IdP Adapter / Search Backend)で吸収し、コード変更なしで導入が完結する
- Target action (conversion): 導入相談(アセスメント申込)を主CTA、GitHubリポジトリ閲覧/スターを副CTA (assumed)
- Primary audience (role / company size / situation): 従業員数百〜数千人の企業の情報システム部門・CTO・セキュリティ責任者。全社でのLLM活用を進めたいが、社内データを外部SaaSに預けること・権限逸脱による情報漏洩を懸念して、エンタープライズサーチ/RAG基盤の選定をしている (assumed)
- Secondary audience: ナレッジが散在して検索に時間を浪費している現場のナレッジワーカー(情シスへの起案者) (assumed)
- Traffic source the LP is built for: 検索(「エンタープライズサーチ」「社内 RAG」「ナレッジ検索 AI」等)+ GitHub/技術記事からの参照 (assumed)
- Known competitors / adjacent products: Glean、Onyx(旧Danswer、OSS)、Guru、Coveo、Amazon Q Business、Microsoft 365 Copilot、国産エンタープライズサーチ(QuickSolution、Neuron ES)、ナレッジ管理ツール(Qast、NotePM、ナレカン、Helpfeel) (assumed)
- Real differences vs competitors (claimed by user, from repo docs):
  - 権限透過が設計の第一原則: アクセス可否の最終判断を必ず元のデータソースが検索者本人の資格情報に対して下す。権限の複製・翻訳・同期をしない
  - 全検索行為の監査ログが標準(誰の権限で・どのソースに・何を問い合わせ・何が返ったか)
  - OSS + シングルテナント自社環境導入: データを外部SaaSに預けない。マルチテナント機構なし(1デプロイ=1社)
  - 中央インデックスを既定で持たない(フェデレーテッド検索から開始、検索層は証拠駆動で有効化)。Slackデータは永続化しない
  - MCP標準準拠: コネクタ群が将来別のLLM製品からもそのまま使える
- Constraints (brand, language, region, legal, assets available): 日本語LP・日本市場向け (assumed)。プロダクト名「leisen(霊泉)」は仮(商標確保は人間タスク、v2 §3.3)。導入実績・顧客ロゴ・数値実績はまだ存在しない(実装前フェーズ)→ 実績系の証拠はプレースホルダ不可、アーキテクチャ・設計原則を証拠とする。ライセンスはApache-2.0推奨(ADR-004、最終決定は人間)
- Success metric: 導入相談の申込数、GitHubスター/クローン数 (assumed)
- Items marked (assumed) are inferred, not stated by the user.
