# 01b Research — Ring D: buyer's negative voice

> Sources used (site / article / community):
> - レビューサイト・口コミ: ITreview(QuickSolution プロフィール/レビュー)、ITトレンド(QuickSolution レビュー41件)、アスピック(ナレッジ共有ツール)
> - 比較記事・弱点段落: GoSearch「Glean Pricing Explained」(G2/TrustRadius/Gartner Peer Insights の不満集約)、Slite/Fritz の Glean レビュー、ITトレンド「エンタープライズサーチ導入時4つの失敗しないポイント」、FileBlog「エンタープライズサーチ導入の苦労」
> - 実務者の発信: ビジネス+IT/sbbit「Copilotで社内情報が丸見え?情シスを悩ます『権限地獄』の正体」、TechTargetジャパン「Copilotで『給与・機密が丸見え』の惨劇」、tcdigital「RAG導入の落とし穴は『社内情報の見えすぎ』」、note(情報散在の実務記事)、softcreate「情シス向け生成AI活用意識調査」、future.ad.jp「国内完結型AI基盤という選択肢」
> - コミュニティ: Hacker News(Onyx Launch HN)、MyWorkDrive(Copilot oversharing、ベンダー調査引用)

## Observations
| ID | complaint or wish (paraphrase) | source | whose voice (role) | first-hand / second-hand |
|---|---|---|---|---|
| D-1 | AI検索/Copilot を入れると、これまで見過ごされてきた権限設定の不備が「一気に表面化」する。問題はAIが権限を破ることではなく「権限がそもそも広すぎる」こと(「権限地獄」) | sbbit / TechTarget | 情シス(記事は情シス向け解説) | second-hand(情シスの悩みの媒体集約) |
| D-2 | 給与・人事・役員資料など「見えてはいけない情報が丸見え」になる過剰共有事故への恐怖。過去の共有リンクや継承フォルダ権限が自然文プロンプトで一気に検索可能になる | TechTarget / MyWorkDrive | 情シス・セキュリティ担当 | second-hand |
| D-3 | 重要データの平均16%が過剰共有状態、Copilot 導入テナントの約80%で人事・給与・取締役資料等の露出可能性(ベンダー調査) | MyWorkDrive(調査引用) | セキュリティベンダー調査 | second-hand(調査) |
| D-4 | RAG の PoC では「まずは動くものを」と権限管理が省略されがちで、テスト環境で機密が丸見えになりプロジェクトが凍結される、が定番の失敗 | tcdigital | AI導入担当/情シス | second-hand(失敗パターン集約) |
| D-5 | SaaS 型 AI は契約上「学習に使わない」とされていても「データがクラウドを経由する事実は変わらない」。社外秘の外部送信としてセキュリティ審査・稟議が通らない | taskhub / EQUES / future.ad.jp | 情シス・セキュリティ審査側 | second-hand |
| D-6 | Glean 等の見積もりは非公開・100席ミニマム・有償PoC。更新時に30〜50%の値上げ、TCO がライセンス費の2〜3倍で「更新時に壁に当たる」 | GoSearch(G2/TrustRadius/Gartner集約)、Cybernews、Slite | 購買担当・既存顧客レビュー | second-hand(レビュー集約) |
| D-7 | 検索範囲が広がること自体が漏洩リスク。全社検索のためには部署・役職ごとの権限設定を極めて細かくやる必要があり、その負荷が導入の壁 | ITトレンド / パナソニックIS | 情シス | second-hand |
| D-8 | 「どこに書いてあったっけ」「これ最新?」— Slack履歴をスクロールし、Driveを曖昧なキーワードで検索し、Notionを読み返して1件に30分以上かかる(情報迷子) | note 実務記事 | 現場の利用者(DX担当) | first-hand |
| D-9 | ナレッジ共有ツールは入れても定着しない。検索してもヒットしない。結局元のチャットやファイルサーバに戻る | アスピック / NotePMブログ | 導入担当 | second-hand |
| D-10 | (QuickSolution)初回利用にバッチ実行とレジストリ書き込みが必要で、PCが苦手な人には難しい。Webアプリのように動いてほしい | ITreview / ITトレンド | 利用部門ユーザー | first-hand(レビュー) |
| D-11 | データの保存場所・処理場所を明確にできる「国内完結」「プライベート環境」が安心材料。既存社内システムと同じセキュリティ基準で運用したい | future.ad.jp | 情シス | second-hand |
| D-12 | 中堅企業の情シスは平均2〜5名。SaaS標準搭載AIが急増し、方針を定めないと「シャドーAI」とデータガバナンスの空白が広がる | softcreate / josys | 情シス | second-hand(意識調査) |
| D-13 | 導入・運用後もチューニング・ログ分析・保守の継続負荷。データクレンジング等の事前準備の泥臭い作業が必要 | ITトレンド / bsearchtech | 情シス・運用担当 | second-hand |

## Complaint frequency
| complaint | count (D-ids) | product value that answers it |
|---|---|---|
| 権限まわりの事故への恐怖(表面化・過剰共有・丸見え・PoC凍結) | 5 (D-1, D-2, D-3, D-4, D-7) | 認可をソースに委譲し本人資格情報でのみ検索(不変条件1)。権限の複製・同期をしない。カナリア文書の常時検証と全件監査ログ |
| データを SaaS/クラウドに出せない(審査・稟議・所在) | 2 (D-5, D-11) | OSS をシングルテナントで自社環境に導入。データ・インデックス・監査ログが自社から出ない |
| 価格の不透明・高額・値上げ(海外 SaaS) | 1 (D-6) | OSS(ライセンス費なし)+ 必要な分だけの導入支援 |
| 探す時間の浪費・情報迷子・ツールが定着しない | 2 (D-8, D-9) | LLM の反復探索による横断検索。既存ツールを置き換えず上に載る |
| 運用負荷(少人数情シス・チューニング・事前整備) | 3 (D-10, D-12, D-13) | 可動部品最小(インデックス既定OFF)。deployment.yaml 1枚。専任1〜2名で回る設計 |

## Target's own vocabulary
- for the artefact(探す対象): 「社内情報」「社内ナレッジ」「ドキュメント」「ファイル」「過去の資料・事例」— ベンダー語の「ナレッジベース」より「どこかにあるはずの資料」という言い方
- for the problem: 「丸見え」「見えてはいけない情報」「過剰共有」「権限地獄」「権限設定の不備が表面化」「情報迷子」「どこにあるかわからない」「散在」「データの所在」「国内完結」「稟議が通らない」「セキュリティ審査」「シャドーAI」「棚卸し」
- words the target does NOT use (category jargon): 「エンタープライズサーチ」(比較記事の見出し語であり本人の語彙ではない)、「RAG」「ベクトル検索」「フェデレーテッド」(実装者の語彙)、「ナレッジマネジメント」

## Seller / buyer gap
- Ring A never answers, buyers raise (differentiation candidates):
  - 「権限は守る」とは全社が言うが、**権限を守っていることを検証できるか**(監査・カナリア・ログ)はほぼ語られない(D-1〜D-4 の恐怖に対する答え)
  - 「学習に使わない」では足りず**データがそもそも社外に出ない**こと(D-5, D-11)。海外 SaaS 勢は構造的に答えられない
  - 価格の透明性(D-6)。OSS はここで構造的優位
- Ring A claims, no buyer mentions (cut candidates):
  - 「生産性◯%向上」系の抽象メトリクス訴求(買い手の不満はコスト・権限・定着であり生産性数値ではない)
  - AIエージェント/ワークフロー自動化の大型ビジョン訴求(買い手はまず検索と権限の確実性を求めている)

## Open questions
- 国内で「OSS を自社導入した」実務者の一次発信は少ない(Onyx/Danswer の日本語事例が薄い)。導入支援ビジネスの検証には別途ヒアリングが必要
