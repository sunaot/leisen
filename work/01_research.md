# 01 Research

## Reference set
| slug | name | ring | selection evidence | captured | notes |
|---|---|---|---|---|---|
| glean.com | Glean | A | 資金調達累計$260M超・alternatives記事群の比較基準・docs Buy比較表に登場 | 2026-08-28 | カテゴリの王者(ja版LP) |
| onyx.app | Onyx(旧Danswer) | A | YC W24・GitHub 31k stars・"open-source Glean alternative"リスト筆頭 | 2026-08-28 | 最近接競合(OSS・セルフホスト) |
| gosearch.ai | GoSearch | A | 独立系alternativesリスト複数掲載 | 2026-08-28 | 挑戦者。連合検索訴求 |
| coveo.com_en | Coveo | A | 上場企業(TSX:CVO)・Gartner MQ Leader | 2026-08-28 | 老舗。アナリスト権威型 |
| dashworks.ai | Dashworks | A/diversity | YC・alternativesリスト複数・HubSpotが買収 | 2026-08-28 | diversity: 「複製vs live」対比訴求 |
| aws.amazon.com_q_business | Amazon Q Business | A | AWS本体 | 2026-08-28 | メガクラウド型 |
| microsoft.com_en-us_microsoft-365-copilot | Microsoft 365 Copilot | A | docs Buy比較表・市場プレゼンス自明 | 2026-08-28 | Ring D「権限地獄」の当事者 |
| cloud.google.com_gemini-enterprise | Gemini Enterprise | A | docs Buy比較表 | 2026-08-28 | データ所有宣言をファーストビューに |
| sei-info.co.jp_quicksolution | QuickSolution | A | 富士キメラ調査シェアNo.1 10年連続・導入5,700サーバ・25周年 | 2026-08-28 | 国内実績駆動型の典型 |
| brains-tech.co.jp_neuron | Neuron ES | A | ITトレンド年間ランキング9年連続1位・事例公開80社以上 | 2026-08-28 | 「閲覧権限継承」をファーストビューに |
| qast.jp | Qast | B | 利用ユーザー98,000人超・大手ロゴ多数 | 2026-08-28 | 隣接: ナレッジ蓄積SaaSの国内型 |
| helpfeel.com | Helpfeel | B | 900サイト以上・ITトレンド4部門1位 | 2026-08-28 | 隣接: 伴走支援を製品と同格に訴求 |
| mattermost.com | Mattermost | B | 政府・軍・重要インフラ顧客で長期生存するself-host OSS | 2026-08-28 | 事業モデルの先行例。「主権」一点突破 |
| about.gitlab.com | GitLab | B | 上場・5,000万ユーザーのOSS企業 | 2026-08-28 | OSS→エンタープライズの成熟形 |
| n8n.io | n8n | B/diversity | GitHub star 20万超・急成長OSS | 2026-08-28 | diversity: 開発者直行型 |
| dust.tt | Dust | A/diversity | Series B・3,000+組織 | 2026-08-28 | diversity: エージェント角度 |
| credal.ai | Credal | A/diversity | エンタープライズAIガバナンス文脈の新興 | 2026-08-28 | diversity: 「ソースで権限継承」明文型 |
| (脱落) hennge.jp / saisearch.sciseed.jp | HENNGE / sAI Search | C / A | — | 取得失敗 | セッションのegressから到達不可(TUNNEL失敗)。N=17で基準(8)超のため続行 |

N = 17(evidence選定13 + diversity 4)

## Frequency table (N = 17)
| variable | value | count | exemplars |
|---|---|---|---|
| headline type | capability(何ができるか) | 6 | glean, gosearch, gemini, neuron, n8n, dust |
| headline type | outcome(結果) | 5 | coveo, dashworks, quicksolution, helpfeel, gitlab |
| headline type | abstract(直後のsubが説明を全負担) | 3 | onyx, qast, aws-q |
| headline type | audience-call | 1 | mattermost |
| first-view visual | 実UIスクショ/製品ビジュアル | 11 | glean, gosearch, dashworks, gemini, quicksolution, qast, n8n, onyx, ms, coveo, gitlab |
| first-view visual | イラスト/図版 | 4 | neuron, aws-q, dust, credal |
| first-view visual | 人物写真 | 2 | helpfeel, mattermost |
| first-view proof | 第三者調査/ランキング/シェア | 4 | gosearch(G2), coveo(Gartner), quicksolution(シェアNo.1), neuron(ITトレンド1位) |
| first-view proof | GitHubスター(ナビ常設) | 2 | onyx(31k), n8n(202k) |
| first-view proof | 数値実績(サブコピー/直下) | 3 | dashworks(87%), qast(98,000人), helpfeel(900サイト) |
| first-view proof | なし(直下にロゴ帯) | 6 | glean, ms, aws-q, gemini, mattermost, gitlab |
| primary CTA type | 資料請求/資料DL(国内型) | 4 | quicksolution, neuron, qast, helpfeel |
| primary CTA type | demo単独(エンタープライズ直行) | 3 | glean, credal, mattermost |
| primary CTA type | self-serve+demo両建て | 7 | gosearch, onyx, gitlab, n8n, dust, coveo, gemini |
| primary CTA type | self-serve主 | 2 | aws-q, ms |
| conversion ask | フォーム(資料/デモ) | 7 | 国内4社+glean+credal+mm |
| conversion ask | 無料開始(サインアップ/インストール) | 10 | onyx(curl!), n8n, gitlab, gosearch, dust, coveo, gemini, aws-q, ms |
| section: ロゴ帯/顧客ロゴ | あり | 14 | credal(互換ロゴ)以外ほぼ全て |
| section: セキュリティ/権限/ガバナンス専用 | あり | 10 | glean, gosearch, aws-q, ms, gemini, onyx, n8n, dust, credal(+neuronはFVバッジ) |
| section: 数値成果/事例数値 | あり | 9 | glean, dashworks, aws-q, quicksolution, neuron, qast, helpfeel, credal, coveo |
| section: コネクタ/統合グリッド | あり | 8 | glean, gosearch, credal, n8n, gemini, dust, onyx, quicksolution |
| section: 価格をLP内に明示 | あり | 5 | aws-q, gemini, quicksolution, neuron, gitlab |
| section: サポート/伴走 | あり | 4 | quicksolution, neuron, qast, helpfeel(国内勢のみ) |
| section: FAQ | あり | 3 | quicksolution, neuron, aws-q |
| proof type | 顧客ロゴ | 14 | 上記 |
| proof type | 数値事例 | 9 | 上記 |
| proof type | 第三者調査/アナリスト | 4 | coveo, quicksolution, neuron, helpfeel |
| heading font class | サンセリフ(カスタム/ジオメトリック大型45-100px) | 12 | glean(Polysans), coveo(gibson), onyx(KH Teka), mm(Trade Gothic), gitlab 他 |
| heading font class | セリフ見出し | 1 | dashworks(Victor Serif) |
| heading font class | 和文ゴシック36-56px | 4 | 国内4社 |
| colour approach | ライト基調 | 12 | glean(クリーム), gosearch, qast, helpfeel, 国内2, gemini, ms, dust, credal, onyx, coveo |
| colour approach | ダーク基調/混在 | 4 | aws-q, n8n, mattermost(hero), gitlab |
| colour approach | グラデーション使用 | 5 | coveo(紫), dashworks(紫), helpfeel(紫), qast(パステル), gosearch(パネル) |
| density | balanced | 11 | 多数 |
| density | text-heavy | 2 | quicksolution, neuron |
| density | sparse | 3 | dashworks, onyx, dust |

## Winning lines (state as options)
### Line 1 — グローバルSaaS型
- Composition: capability見出し + 実UIヒーロー(コネクタチップ) + 直下ロゴ帯 + コネクタグリッド + セキュリティ/権限専用セクション + demo(+self-serve)CTA
- Exemplars: glean, gosearch, dust(5-6/17)
- Trade-off: 洗練されるが英語圏文法。国内買い手の「実績・サポート・価格」欲求に答えない

### Line 2 — 国内実績駆動型
- Composition: outcome見出し + 実績バッジ(第三者調査/導入数)をファーストビューに + UIスクショ + 事例数値 + 価格・FAQ・サポートをLP内蔵 + 資料請求CTA
- Exemplars: quicksolution, neuron, qast, helpfeel(4/17)
- Trade-off: 信頼は積めるが、導入実績ゼロの新規OSSは同じ土俵に乗れない(実績の物量がない)

### Line 3 — OSS/開発者直行型
- Composition: capability/統制見出し + GitHubスターをナビ常設 + curl/自己ホストの導線をヒーローに + 権限・デプロイのセキュリティ群 + free+demo両建て
- Exemplars: onyx, n8n(, gitlab)(3/17)
- Trade-off: 評価者(エンジニア)には最短だが、稟議を書く情シス/意思決定者への説明が薄くなる

### Line 4 — 主権・統制特化型
- Composition: audience-call/contrast見出し + 統制語彙(sovereignty / control / on your terms / inherited at the source) + 権限・デプロイの明文約束 + demo直行
- Exemplars: mattermost, credal(+dust, dashworksの対比セクション)(3-4/17)
- Trade-off: 刺さる層は深いが狭い。検索カテゴリだと認識されないリスク

## Copy-structure table
| structure | count | exemplars (R-xx-4x) | concrete nouns/verbs that recur |
|---|---|---|---|
| operation→result | 10+ | R-gosearch-40, R-neuron-40/41, R-qs-40/42, R-hf-41, R-n8n-40/41, R-credal-40/42/43, R-onyx-40/41, R-gem-41, R-mm-41 | 横断検索/接続する/見つかる/継承/control/deploy/UPするだけ/only see |
| result→effect | 7 | R-glean-41, R-qs-41, R-neuron-42, R-qast-40, R-hf-40, R-awsq-41 | ◯◯時間削減/◯%短縮/月◯円/半減/◯TB |
| situation→consequence | 6 | R-glean-40/42, R-qast-41, R-neuron-43, R-hf-42, R-gem-40 | 埋もれる/権限を考慮している場合にのみ/アップロード不要/お客様のもの |
| contrast | 6 | R-dashworks-40, R-gl-40/41, R-n8n-42, R-dust-40/41, R-credal-41 | duplicates vs live/fast×control/using vs running/後付けvsビルトイン |
| audience→offer | 2 | R-mm-40, R-qs-43 | sovereignty/純国産 |
| abstract (recorded, not licensed) | 5 | R-onyx-43, R-qast-42, R-msc-41, R-glean-43 | superpowers/未来をつくる/Work AI — いずれも直後のsubや実UIが即時に具体を補う位置でのみ使われている |

## Objection map
| objection | seller: always / sometimes / never | buyer raises? (D-xx) | seller-only / buyer-only / both | how (R-xx) |
|---|---|---|---|---|
| 権限・アクセス統制 | always(10/17が専用セクション or FVバッジ) | D-1,2,3,4,7(最頻) | both | R-glean-40, R-neuron-41(FVバッジ), R-credal-40, R-msc-40, R-awsq-40 |
| データの所在・複製・外部送信 | sometimes(海外新興+メガのみ。国内sellerはほぼ沈黙) | D-5, D-11 | both(国内では実質buyer-only) | R-dashworks-40(複製vs live), R-gem-40(お客様のもの), R-dust-40, R-mm-42 |
| 価格・透明性 | sometimes(国内+メガは明示、米SaaSは隠す) | D-6 | both | R-qs(価格セクション), R-neuron(2モデル), R-gem(エディション) |
| 導入後サポート・定着 | 国内always/海外rare | D-9, D-13 | both | R-hf-42(伴走), R-qast(浸透), R-qs-43(純国産) |
| 探しても見つからない(検索品質) | always(カテゴリ本体) | D-8, D-9 | both | R-qs-40, R-neuron-40 |
| 運用負荷・少人数情シシで回るか | never(明示なし) | D-12, D-13 | **buyer-only(差別化候補)** | — |
| 権限を守っていることの検証(監査・証明) | never(訴求するLPなし。credalのregistryが最近接) | D-1〜4の恐怖の裏面 | **buyer-only(差別化候補)** | — |
| モデル/ベンダーロックイン | sometimes | (弱) | seller寄り | R-glean(35+LLM), R-dust(Model flexibility) |

## Observations index
Per-LP files: work/research/<slug>/observations.md (IDs R-<slug>-n)

## Open questions
- HENNGE / sAI Search はこの環境のegress制限で到達不可。Ring C(国内情シス向けSaaSのトーン)は Qast/Helpfeel/国内ES 2社で代替した
- Glean は ja ロケールで日本語LPが返る(国内展開済み)。国内買い手が Glean 日本語LPを見る前提で比較される
