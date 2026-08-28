# 01b Research — Ring D: buyer's negative voice

> Sources used (site / article / community):
> - レビューサイト(一次情報): ITトレンド QuickSolutionレビュー(全41件ページ), ITreview Glean/QuickSolution/NotePMレビュー
> - 比較記事の弱点段落(二次集約): aipicks Gleanガイド2026, premai「12 Best Glean Alternatives」, ITトレンド「導入時4つの失敗しないポイント」
> - 情シス向け実務記事・コミュニティ: ビジネス+IT「Copilot権限地獄」, Beekle/Taskhub RAGセキュリティ記事, Zendesk/情シスマン 社内wiki失敗記事, Hacker News Onyxスレッド
> 収集日: 2026-08-28

## Observations
| ID | complaint or wish (paraphrase) | source | whose voice (role) | first-hand / second-hand |
|---|---|---|---|---|
| D-1 | 検索しても求めている情報が出てこないことがある(OR検索がうまく効かない) | ITトレンド QuickSolutionレビュー | 利用部門ユーザー | first-hand |
| D-2 | ヒット件数が多すぎて絞り込めない。簡単に絞り込める機能が欲しい | ITトレンド QuickSolutionレビュー / ITトレンド導入失敗記事 | 利用部門ユーザー | first-hand |
| D-3 | RAGの参照ソースをフォルダ・プロジェクト・文書種別で細かく絞りたい(精度向上のため) | ITreview Gleanレビュー | 専門職(ソフトウェア・SI) | first-hand |
| D-4 | 細かい権限コントロールと組織単位のコスト上限・機能有効/無効の管理がしたい | ITreview Gleanレビュー | IT管理者(ソフトウェア・SI) | first-hand |
| D-5 | ネイティブコネクタの設定情報が開示されず、標準機能でどこまで繋がるか導入前に把握しづらい | ITreview Gleanレビュー | 導入支援パートナー | first-hand |
| D-6 | 知りたい内容がなかなか出てこず、検索キーワードを何度も変える必要がある | ITreview Gleanレビュー | 利用部門ユーザー(1000人以上) | first-hand |
| D-7 | Copilot導入で「権限地獄」: SharePointの過剰共有(役員資料・人事資料・退職者フォルダ)が放置されたままAI検索すると丸見えになる。問題はAIでなく権限が最初から広すぎること | ビジネス+IT記事 | 情シス(記事の想定読者) | second-hand |
| D-8 | RAGが全社データを一括インデックスし利用者ごとの権限を持たないと、一般社員が見るべきでない経営資料が回答に混ざる。元文書のアクセス権を回答にも引き継ぐ設計が必要 | Beekle / Taskhub 情シス向け記事 | 情シス | second-hand |
| D-9 | 社内wikiの3大課題「書かれない・検索しても見つからない・情報が古い」で形骸化する | Zendesk / 情シスマン記事 | 導入担当・利用者(集約) | second-hand |
| D-10 | 社員は情報探しに1日平均1.6時間を浪費している(情報がメール・ファイルサーバ・個人PCに散在) | 情シスマン記事(調査引用) | 集約 | second-hand |
| D-11 | 価格が高い。Gleanは$50/ユーザー/月・最低契約$50-60k/年でPoCも有償。100名未満では始められない | aipicks / premai比較記事、ITreview QuickSolution(価格満足度3.6/5) | 検討担当(集約)+レビュアー | 混在 |
| D-12 | 中央インデックス(Enterprise Graph)への依存が深まるほど、将来の乗り換えコストが跳ね上がる | aipicks Gleanガイド | 検討担当(集約) | second-hand |
| D-13 | 検索機能はあるが深く検索できず使い勝手が悪い | 起業LOG NotePM口コミ | 利用部門ユーザー | first-hand |
| D-14 | 自社データを外部SaaSに預けたくない。自社環境/エアギャップで動き、ユーザーデータとチャット履歴を自社の管理下に置きたい(セルフホストなら100席超で経済性も逆転) | HN Onyxスレッド / premai比較記事 | 規制業種・セキュリティ意識の高い技術責任者 | second-hand |
| D-15 | インストール・初期導入プロセスが複雑で分かりづらい(バッチ実行やレジストリ書き込みが必要) | ITreview QuickSolutionレビュー | 利用部門ユーザー | first-hand |

## Complaint frequency
| complaint | count (D-ids) | product value that answers it |
|---|---|---|
| 検索精度: 欲しい情報が出ない/キーワード試行錯誤/絞り込めない | 5 (D-1, D-2, D-3, D-6, D-13) | エージェントの反復検索(粗い検索を複数回試行し読み直す)+ 出典リンク必須 |
| 権限・情報漏洩: AI検索で権限外の情報が見える不安、権限管理の作り込み | 3 (D-4, D-7, D-8) | 認可をデータソースに委譲(本人資格情報でのみアクセス)、権限の複製・同期をしない、全件監査ログ |
| 価格・契約障壁: 高額、最低契約、有償PoC | 1 (D-11) | OSS(Apache-2.0予定)、ライセンス費ゼロで小さく始められる |
| データ主権: 外部SaaSに預けたくない/ロックイン回避 | 2 (D-12, D-14) | シングルテナント自社環境導入、中央インデックスを既定で持たない、Slackデータ非永続化 |
| 導入・運用の負担: コネクタ設定が不透明、導入が複雑 | 2 (D-5, D-15) | deployment.yaml 1枚で導入構成が完結、コネクタはMCP標準、導入プレイブック |
| ナレッジが散在・古い・見つからない(現状の痛み) | 2 (D-9, D-10) | ソースを移行せずその場で横断検索(書き直し・移し替え不要) |

## Target's own vocabulary
- for the artefact: 「社内の情報」「社内データ」「ファイルサーバ」「SharePoint」「Slackのやりとり」「ドキュメント」(×「ナレッジベース」「エンタープライズグラフ」)
- for the problem: 「どこにあるか分からない」「探す時間」「ヒットしない」「見つからない」「情報が古い」「散在」「権限」「丸見え」「漏洩」「野良RAG」
- words the target does NOT use (category jargon): 「エンタープライズサーチ」(検討時の検索語では使うが日常語ではない)、「RAG」(情シスは使う、現場は使わない)、「コグニティブサーチ」「ナレッジグラフ」

## Seller / buyer gap
- Ring A never answers, buyers raise (differentiation candidates):
  - 「権限が最初から広すぎる/AI検索で過剰共有が露呈する」問題への設計上の答え。Ring Aは「権限を尊重します」と一言書く程度で、どう尊重するのか(複製か委譲か)を語らない ← D-7/D-8
  - 中央インデックスへの依存とロックイン ← D-12。Ring Aはインデックスの深さをむしろ売りにする
  - 価格の透明性・スモールスタート ← D-11。Ring A(特に海外勢)は価格非公開・要問い合わせが多い
  - コネクタ設定の事前開示 ← D-5。OSSはコードと設定スキーマが公開されていること自体が答えになる
- Ring A claims, no buyer mentions (cut candidates):
  - 「AIアシスタント/エージェントが仕事を代行する」系の拡張機能(業務アプリ化)。買い手の不満は検索・権限・価格に集中しており、エージェント機能拡充を求める声は少数(D-3の絞り込み要望はあるが方向が逆=制御を求めている)
  - 「数十億ドキュメント対応」等の超大規模スケール自慢(対象組織規模では過剰)

## Open questions
- 国産勢(QuickSolution等)のオンプレ需要と、本製品のセルフホスト需要が同じ買い手かは要検証(レビューの声はオンプレ既存客のもの)
- 「野良RAG乱立」(AJTC記事)を統制したい情シスの声は伸びているが一次情報が薄い。導入相談の一次ヒアリングで確認したい
