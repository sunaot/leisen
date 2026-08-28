# 01 Research

収集日: 2026-08-28。キャプチャ: Playwright(desktop 1440px / mobile 390px)。per-LP詳細は `work/research/<slug>/observations.md`。

## Reference set
| slug | name | ring | selection evidence | captured | notes |
|---|---|---|---|---|---|
| glean.com | Glean | A | カテゴリリーダー(評価額~$7B)、ITreviewエンタープライズサーチ部門満足度1位、国内約20社導入(アシスト経由) | ✔ | /jaは404のため英語トップを採用 |
| gosearch.ai | GoSearch | A | 独立した"Glean alternatives"比較記事3本以上に掲載 | ✔ | |
| coveo.com_en | Coveo | A | 上場企業(TSX:CVO)、Gartner MQ Leader、大手顧客ロゴ | ✔ | |
| getguru.com | Guru | A/B | 複数のalternatives記事に掲載、2013年創業の長寿製品 | ✔ | |
| onyx.app | Onyx | A | YC W24、OSS(GitHub 31k stars)、Netflix/Ramp/Thales本番利用、"open-source Glean alternatives"1位 | ✔ | **diversity**(OSS新興。当製品に最も近いモデル) |
| aws.amazon.com_jp_q_business | Amazon Q Business | A | AWSスケール、比較記事掲載、$3/user/月の価格破壊 | ✔ | **diversity**(ハイパースケーラー・別価格帯) |
| sei-info.co.jp_quicksol… | QuickSolution | A | 導入実績5,700サーバ以上・発売25周年、富士キメラ総研シェア10年連続No.1、ITトレンドレビュー41件 | ✔ | www.qs.sei-info.co.jpは疎通不可、公式製品ページで代替 |
| brains-tech.co.jp_neuron | Neuron ES | A | 事例公開80社以上、ITトレンド年間ランキング9年連続1位 | ✔ | |
| helpfeel.com | Helpfeel | A/B | 導入900サイト超、シェア成長率No.1(富士キメラ総研)、ITreview Grid Award 6期連続Leader | ✔ | |
| qast.jp | Qast | B | 利用ユーザー98,000人超、国内比較記事に頻出 | ✔ | |
| narekan.info | ナレカン | B | 国内比較記事に頻出 | ✔ | **diversity**(「非IT企業向け」の絞り込み訴求・別価格帯) |
| notepm.jp | NotePM | B | 登録企業12,000社超、国内比較記事の定番 | ✔ | |
| hennge.com_jp_service_one | HENNGE One | C | 上場、導入3,800社以上、ITR調査5年連続シェア1位 | ✔ | 情シスの視覚リテラシー較正用 |
| lanscope.jp | LANSCOPE | C | 累計導入40,000社以上、市場シェアNo.1バッジ×2、ITreview 6部門LEADER | ✔ | 同上 |

N=14(Ring A系9、B系3、C系2。うちdiversity 3)。

## Frequency table (N = 14)
| variable | value | count | exemplars |
|---|---|---|---|
| headline type | outcome(結果提示) | 7 | R-quicksol-1「欲しい情報がすぐに見つかる」, R-notepm-1「社内の知りたい、すぐ見つかる。」, R-helpfeel-1, R-coveo-1, R-onyx-1, R-qast-1, R-narekan-1 |
| headline type | capability(能力提示) | 3 | R-glean-1, R-gosearch-1, R-neuron-1 |
| headline type | other(ブランド名/スローガン/実績) | 3 | R-awsq-1, R-hennge-1, R-lanscope-1 |
| headline type | contrarian | 1 | R-guru-1 |
| (補足) 見出しが抽象でもサブ/直下の数値・具体で即回収する構成 | — | 5 | R-qast-40, R-narekan-45, R-onyx-40, R-lanscope-40, R-awsq-44(いずれもabstract見出し+直下に具体証拠) |
| first-view visual | 製品UIモック/スクリーンショット | 9 | R-glean-5, R-gosearch-5, R-onyx-5, R-quicksol-5, R-qast-5, R-narekan-5, R-notepm-5(複合), R-lanscope-5(カルーセル内), R-awsq-5(写真+チャットUI合成) |
| first-view visual | 実写人物写真主体 | 2 | R-helpfeel-5, R-notepm-5 |
| first-view visual | ライブ風チャットウィジェット(LP自体がデモ) | 2 | R-coveo-5, R-guru-5 |
| first-view visual | イラスト/マスコット | 2 | R-neuron-5(ワトソンくん), R-hennge-5(戦隊風キャラ) |
| first-view proof | ロゴ帯(fold内〜直下) | 9 | R-quicksol-6, R-qast-6, R-narekan-6, R-notepm-6, R-helpfeel-6, R-onyx-6, R-neuron-6, R-lanscope-6, R-glean-6(mobileのみfold内) |
| first-view proof | 数値実績(導入社数/サーバ数/指標) | 8 | R-quicksol-6, R-helpfeel-6, R-qast-6, R-lanscope-6, R-hennge-6, R-onyx-6, R-neuron-6, R-narekan-6(見出しのみ) |
| first-view proof | 評価バッジ(G2/ITreview/シェアNo.1) | 5 | R-gosearch-6, R-lanscope-6, R-hennge-6, R-quicksol-6, R-neuron-6 |
| first-view proof | なし | 2 | R-glean-6(desktop), R-awsq-6 |
| **(決定的)国産8LPは8/8がファーストビュー圏に数値実績かロゴを置く** | — | 8/8 | quicksol/neuron/helpfeel/qast/narekan/notepm/hennge/lanscope |
| primary CTA type | 資料請求/資料ダウンロード(国産の主CTA) | 8 | R-quicksol-4, R-neuron-4, R-helpfeel-4, R-qast-4, R-narekan-4, R-notepm-4(副), R-hennge-4, R-lanscope-4 |
| primary CTA type | デモ依頼/Talk to sales単独 | 3 | R-glean-4, R-coveo-4, R-guru-4 |
| primary CTA type | 無料トライアル/self-serve併記 | 6 | R-gosearch-4, R-onyx-4, R-quicksol-4(副), R-narekan-4, R-notepm-4, R-lanscope-4 |
| conversion ask | ページ内埋込フォームなし(全CTAが別ページ遷移) | 14 | 全LP(structure.json forms:[]) |
| conversion ask | CTAペアをページ内で3回以上反復 | 10 | R-neuron-12(4回), R-notepm-12(5回), R-narekan-12(6回), R-qast-12(3回), R-onyx-12(3回), R-glean-12(3回)ほか |
| section: 課題提起(こんなお悩み) | あり | 4 | R-notepm-10, R-narekan-10, R-lanscope-10(課題から探す), R-glean-10(AIコスト問題) |
| section: 導入事例(実名) | あり | 11 | 国産8/8 + glean/coveo/awsq |
| section: セキュリティ/コンプライアンス | あり | 8 | R-glean-10(バッジ6種), R-gosearch-10, R-onyx-10, R-awsq-10, R-narekan-22(FAQ内), R-notepm-22(銀行・大学も導入), R-guru-10, R-helpfeel-10 |
| section: 料金 | ページ内に記載/リンク | 7 | R-quicksol-10(5段階表), R-neuron-10, R-notepm-10, R-awsq-10($3/月), R-narekan-10(試算), gosearch/onyx(navにPricing) |
| section: FAQ | あり | 6 | R-quicksol-10, R-neuron-10, R-narekan-10, R-awsq-10, R-helpfeel-10(全編Q&A構成), R-hennge-10(なし)を除く国産中心 |
| section: セミナー/お知らせ(ハブ化) | あり | 5 | R-quicksol-10, R-neuron-10, R-qast-10, R-lanscope-10, R-notepm-10(サポートコンテンツ) |
| proof type | 定量化された顧客事例(社名+数値) | 10 | R-neuron-23(86.8%削減), R-quicksol-42(月1,000万円), R-notepm-23(検索時間4割削減), R-narekan-43(1/10), R-hennge-41(10分の1), R-glean-43, R-gosearch-43, R-awsq-40(45%), R-coveo-42, R-qast-43(半減) |
| proof type | 第三者認証/コンプラバッジ(ISO/SOC2等) | 6 | R-glean-23, R-gosearch-23, R-onyx-23, R-narekan-22, R-helpfeel-23, R-guru-22 |
| proof type | ベンチマーク/調査出典の脚注明記 | 5 | R-onyx-42, R-helpfeel-6(※出典), R-lanscope-23(※1〜4), R-narekan-23(自社調査注記), R-hennge-2(ITR) |
| heading font class | サンセリフのみ(セリフ不使用) | 14 | 全LP。国産はNoto Sans JP/ヒラギノ系、海外はカスタムグロテスク(Polysans/KH Teka/Gibson/Manrope/Poppins) |
| colour approach | 白/オフホワイト基調+濃色バンド挿入 | 12 | guru(ダーク基調)以外。glean/onyx/hennge/helpfeelは黒セクションを効果的に挿入 |
| colour approach | CTAアクセントに暖色(オレンジ/赤) | 6 | R-quicksol-31, R-neuron-31, R-helpfeel-31, R-narekan-31, R-lanscope-31, R-notepm-31(橙は強調のみ) |
| colour approach | 装飾グラデーション使用 | 7 | R-gosearch-31(グレイン), R-glean-31(3Dクローム), R-qast-31(パステル), R-notepm-31(青), R-coveo-31(紫), R-helpfeel-31(橙紫), R-awsq-31 |
| density | ロングスクロール(10画面超) | 11 | 5.7画面(guru)と7.3画面(onyx)と8.2画面(hennge)以外は10.3〜14.9画面 |

## Winning lines (state as options)
### Line 1 — 国産BtoB定番型(「実績が先、機能が後」)
- Composition: outcome型見出し(「欲しい情報がすぐに見つかる」系) + 製品UIスクショ + **ファーストビュー圏に数値実績+ロゴ帯** + 課題提起→番号付き特徴→導入効果(定量)→実名事例→サポート/FAQ→セミナー + 「資料ダウンロード(主)+トライアル/デモ(副)」のCTAペアを3〜6回反復。フォームは別ページ。
- Exemplars: quicksol, neuron, notepm, narekan, qast, helpfeel(6/14)。Ring C(hennge, lanscope)も同型 → 国産の買い手はこの型で製品を「認識」する
- Trade-off: 導入実績ゼロの新規プロダクトは数値実績バーをそのまま埋められない(別の証拠タイプでの代替が必要)。ページが長くなる。
### Line 2 — グローバルEnterprise sales-led型(「信頼と統制」)
- Composition: capability/contrarian見出し + 抽象ブランドビジュアル+小さめUIモック + 「デモ依頼」一本(self-serveなし・価格非公開) + コンプラバッジ列 + 顧客ロゴ/統計壁 + セキュリティ・可観測性セクション
- Exemplars: glean, coveo, guru(3/14)
- Trade-off: 価格非公開・営業接触前提はRing Dの不満(D-11)と正面衝突。無名の新規には模倣困難(ロゴ・統計壁が張れない)。
### Line 3 — OSS/self-host型(「透明性が信頼の根拠」)
- Composition: 短いoutcome見出し + ライブ風UIモック + **3並列CTA(無料で試す/デモ/`curl`ワンライナー self-host)** + GitHubスター数 + 手法明示のベンチマーク + 黒背景「Open Source」セクション(透明性=セキュリティ論法) + 競合比較ページ群
- Exemplars: onyx(1/14、gosearchが部分的に類似)
- Trade-off: OSS文脈が通じる技術者には強いが、非エンジニアの決裁者には「無料=サポート不安」に振れうる。国産の認識文法(実績バー)を欠く。

## Copy-structure table
| structure | count | exemplars (R-xx-4x) | concrete nouns/verbs that recur |
|---|---|---|---|
| operation→result(操作/導入→数値の結果。**定量つきが国産の主流**) | 14 | R-quicksol-41/42, R-neuron-42, R-narekan-41/43, R-hennge-41, R-glean-41, R-gosearch-41, R-guru-42/43, R-awsq-40/42/43, R-coveo-41, R-lanscope-42 | 横断検索, 削減, ○○%, ○○時間, SSO化, 連携, 導入 |
| situation→consequence(状況の名指し→帰結) | 9 | R-glean-40, R-guru-40, R-quicksol-43, R-narekan-40, R-notepm-41, R-helpfeel-41, R-coveo-40, R-gosearch-44, R-qast-41 | 散在, 属人化, 探す, 見つからない, ファイルサーバ, 権限 |
| result→effect(結果の宣言→効果) | 7 | R-quicksol-40, R-qast-42, R-narekan-42, R-lanscope-41, R-awsq-41, R-gosearch-43, R-coveo-42 | すぐに見つかる, 導入実績○○社, 月額$3 |
| contrast(〜だけでなく/〜で終わらせない) | 7 | R-neuron-41, R-notepm-40, R-helpfeel-44, R-quicksol-44, R-gosearch-42, R-coveo-43, R-lanscope-43 | ファイル名/中身, 属人化した情報/会社のナレッジ, リンクの一覧/答え |
| audience→offer(対象の名指し→提供) | 6 | R-narekan-44, R-hennge-42/44, R-gosearch-40, R-glean-43, R-qast-44 | 非IT企業, 情シス, 管理者, 利用者 |
| question(疑問形見出し) | 2 | R-notepm-44, R-helpfeel-34(全セクションQ&A形式) | お悩みありませんか, 〜とは？, どうやって？ |
| abstract (recorded, not licensed) | 8 | R-qast-40, R-narekan-45, R-onyx-40/44, R-coveo-44, R-glean-44, R-awsq-44, R-lanscope-40 | 未来をつくる, ポテンシャルを開放, superpowers, 力を解き放つ |

備考: abstractは主に**見出し1本のみ**に許容され、直後に数値・具体で回収するのがセットの共通運用。本文・セクション見出しでのabstractはほぼ観察されない。

## Objection map
| objection | seller: always / sometimes / never | buyer raises? (D-xx) | seller-only / buyer-only / both | how (R-xx) |
|---|---|---|---|---|
| 検索精度(欲しい情報が見つかるか) | always | D-1, D-2, D-3, D-6, D-13(最頻) | both | R-quicksol-40, R-notepm-41, R-neuron-41, R-onyx-42(ベンチマーク) |
| 権限・情報漏洩(AI検索で権限外が見えないか) | sometimes(**全LPが一行言及どまり。方式=複製か委譲かは誰も語らない**) | D-4, D-7, D-8(高頻度) | both(ただし深さのギャップ=差別化候補) | R-glean-22「許可された情報のみ閲覧可能」, R-gosearch-47, R-onyx-22(Granular Permissions), R-awsq-22 |
| 監査・統制(誰が何を検索したか追えるか) | ほぼnever(Glean一行のみ) | D-7(統制文脈) | buyer-only寄り | R-glean-22「完全な可観測性」 |
| 導入実績・信頼性 | always(国産は8/8) | 暗黙(選定理由) | both | R-quicksol-6, R-lanscope-6, R-hennge-6 |
| 価格の透明性・スモールスタート | sometimes(国産は料金表掲載が多い。Glean/Coveo/Guruは非公開) | D-11 | both(海外Enterprise勢が弱い点) | R-quicksol-22(5段階表), R-awsq-41($3), R-narekan-42(試算) |
| データ主権(外部SaaSに預けたくない/オンプレ) | sometimes(国産のオンプレ対応、OnyxのSelf-Host) | D-14 | both | R-neuron-40, R-quicksol-41, R-onyx-22(Self-Host Guide) |
| ロックイン(インデックス依存・乗り換えコスト) | never | D-12 | **buyer-only(差別化候補)** | — |
| 導入・運用の手間(コネクタ設定の不透明さ) | sometimes(サポート・伴走訴求で間接回答) | D-5, D-15 | both | R-helpfeel-44(伴走), R-quicksol-44(純国産サポート), R-narekan-22(移行代行) |
| AIの回答が信用できるか(出典・誤答) | sometimes | (Ring Dでは間接的) | both | R-guru-40(confidently wrong AI), R-awsq-43(引用), R-onyx-42 |
| ナレッジが書かれない・古い(運用が回るか) | sometimes(Ring Bの主戦場) | D-9, D-10 | both | R-qast-41, R-narekan-40, R-guru-42 |

## Observations index
Per-LP files: work/research/<slug>/observations.md (IDs R-<slug>-n)

## Open questions
- Glean日本語LP(/ja)は404のため英語トップで代替した。国内代理店(アシスト)のGlean紹介ページを国産文法の参照として追加すべきか
- QuickSolutionはqs.sei-info.co.jpが疎通不可のため公式製品ページ(sei-info.co.jp/quicksolution/)で代替(内容は同等のLP)
- Onyxのdesktopキャプチャはnetworkidleタイムアウトのためwait条件緩和で再取得(表示内容への影響なし)
