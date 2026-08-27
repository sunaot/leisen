# findings-a: 直接競合LPの説得構造(エンタープライズAI検索 / 社内ナレッジAI)

調査日: 2026-08-27。対象: source-register-a.csv の src-a01〜a10(到達9件、到達不能1件)。
本ドキュメントは観察の統合と解釈であり、いずれの表現も「成果が出る証拠」ではない(performance_support: none)。

## 0. 到達状況の要約

- 到達・観察済み: Glean(en)、Microsoft 365 Copilot(ja)、Google Gemini Enterprise(ja)、Slack AI(ja)、Atlassian Rovo(ja)、Coveo(en)、Dashworks(en)、Elastic(ja)、Sana(en, sanalabs.com)
- 到達不能: Qatalog(ClickUpに買収、301リダイレクトのみ)。sana.ai本体はJSレンダリングで内容取得不能(sanalabs.comで代替)
- カテゴリ自体が流動的: Qatalog消滅、SanaはWorkday傘下、ElasticはWorkplace Search訴求を捨てて開発者向け「Search AIプラットフォーム」に再ポジショニング、AgentspaceはGemini Enterpriseに統合。「独立系エンタープライズ検索」の生存者はGlean/Coveo/Dashworks系のみで、他はスイート内蔵型(Microsoft/Google/Slack/Atlassian)

## 1. 共通する説得の骨格

観察された典型的セクション順(9件中ほぼ共通):

1. Hero(約束+単一または二択CTA)
2. 顧客ロゴ帯(ヒーロー直下が最頻。Glean/Rovo/Slack/Coveo/Dashworks/Sana)
3. 機構の説明(3〜4項目のフレームワーク化が定番: Gleanの Connect/Understand/Act、Sanaの Find/Act/Build/Automate、Rovoの Teamwork Graph)
4. 数値クレームまたは部門別ユースケース
5. セキュリティ/ガバナンス(位置はまちまち。後述)
6. 顧客の声・事例
7. FAQ(M365/Gemini/Slack/Elastic — 大手ほどFAQで反論処理)
8. 最終CTA

ヘッドラインの型は2系統:
- **「自社を理解するAI」型**: Glean "Enterprise AI that understands your company" / Rovo「チームの仕事を知り尽くした AI」— 汎用AIとの対比が暗黙の問題枠組み
- **「その場で/1か所で」型**: Slack「仕事をしているその場所で AI がサポート」/ Gemini「1 つのプロンプトでビジネスデータ全体を検索」/ Dashworks "searches all your team's knowledge and apps at once" — 分断・散在が問題枠組み

問題提起を明示的に書くLPは少なく(Slackの「AI の登場でかえって悩みが増えた？」が例外的に明示)、多くは問題を含意にとどめ約束から始める。

## 2. 権限・アクセス制御の語られ方(重点)— 4つの型

| 型 | 採用例 | 典型文言 |
|---|---|---|
| A. 権限透過の言い切り型 | Glean | "Users only see what they're allowed to see" / "permission-aware access built in from day one"。permission-awareをカテゴリ成立条件として定義("AI only works in the enterprise when answers are secure, explainable, and permission-aware") |
| B. アーキテクチャ差別化型 | Dashworks | "Instant permission updates ensure ACLs respected at all times" / 非インデックス・ゼロデータ保持。比較表で従来型の「ACL反映1時間遅延」を仮想敵に |
| C. 管理者ガバナンス型 | Gemini Enterprise、Rovo | 「すべてのコネクタ、ユーザー権限、ポリシーを一元的に可視化して制御」「管理者が AI のアクセス範囲を明確にコントロール」— 主語がエンドユーザーでなく管理者 |
| D. 委譲・沈黙型 | Coveo(Trust Centerへリンク)、Sana(Securityページへリンクのみ)、Slack(権限でなくデータ所在で処理) | LP本文では権限に触れない |

- M365 Copilotは「既存テナントの権限・ポリシーをそのまま継承」というスイート特有の語り。ElasticはRBAC/ドキュメントレベルセキュリティを開発者向け機能名として提示
- **「ソース側の権限をそのまま尊重する」ことをエンドユーザー視点の一文で言い切るのはGleanとDashworksのみ。** スイート勢は管理者統制、データ主権の話にすり替わる傾向
- AI固有の反論処理として「顧客データをモデル学習に使わない」はSlack・Gemini・M365の3社が明文化(ほぼ定型文化している)。データ所在(VPC内ホスト、EUデータ境界、データレジデンシー)も大手共通

## 3. proof(証明)の型

- **認証バッジ羅列型**: Glean(ISO 42001/HIPAA/TX-RAMP/SOC 2/ISO 27001/GDPR)、Dashworks(SOC-2 Type 2/GDPR/HIPAA)。独立系ほど認証を前面に出す(スイート勢は親ブランドの信頼に依存し、バッジをLPに置かない)
- **アナリスト評価型**: Coveo(Gartner MQ Leader+G2バッジ)、Elastic(Gartner/Forrester/IDC、ただし検索以外の領域の評価を流用)
- **事例数値型**: M365(ROI 241%、年間$3M、月8時間節約)、Slack(週97分節約 — 出典を「社内分析」と注記)、Gemini(コンテンツ生成85-90%高速化)、Dashworks(87%自動化をヒーローに埋め込み)
- **ロゴ量型**: 全社共通。Glean 20+、Sana 24、Dashworks 20+。ロゴの知名度が独立系の信用を左右
- Gleanは「トークン節約額の巨大カウンタ」「93%採用率」などプラットフォーム利用規模を証明に転用する独自手法

## 4. CTAとオファーの型

- **デモ一本型(ハイタッチ)**: Glean("Get a demo"のみ)、Sana("Book an intro")。フォーム以外の摩擦なし、ただし価格非開示
- **トライアル+営業並列型**: Gemini(30日トライアル+お問い合わせ、料金$21/$30をLP上に開示、「IT 部門による設定は不要」)、Coveo(demo+free trial+chat)、Elastic(無料トライアル4箇所+サンドボックス、PLG型)
- **セルフサーブ/既存基盤アップセル型**: M365(価格開示、トライアル無しと明記、無償Copilot Chatを入口に)、Slack(無料プランあり)、Rovo(「Rovo を入手」でPremiumサインアップ)
- **情報開示型**: Dashworks(ファーストビューにデモ/トライアルボタンを置かず、価格・統合情報への導線が主)
- 傾向: スイート勢とGoogleは価格をLPに開示、独立系ハイタッチ勢(Glean/Sana/Coveo)は非開示

## 5. ビジュアルの役割

- 実プロダクトUI中心: M365(スクリーンショット多数)、Slack(アニメーションデモ動画)、Elastic(イラスト化UIモック)
- 抽象・ブランド中心: Glean(グラデーション+抽象モック)、Rovo(コンテキスト可視化アニメーション)、Coveo(アイコン+ロゴ)
- 解釈: 既に使われている製品(スイート勢)は実UIで「今のアプリの中にAIが入る」ことを見せ、新規導入を迫る独立系は抽象ビジュアルでビジョンとスケール感を演出する傾向

## 6. 広告→LPの対応関係

今回の観察では検索広告経由の専用LPは追跡できなかった(オーガニックで到達した製品トップ/機能ページのみ)。unknownとして記録。

## 7. 自社(権限透過検索基盤)への示唆 — interpretation

- 「権限をソースに委譲し本人資格情報で照会する」という当プロダクトの中核は、LP市場ではDashworksのB型(非インデックス・ACL即時)とGleanのA型(permission-aware言い切り)の間に空きがある。スイート勢がC型(管理者統制)とデータ所在の話に終始している分、**エンドユーザー視点の権限透過+監査可能性を一文で言い切る訴求は差別化余地がある**(ただしこれは観察に基づく仮説であり成果の証拠はない)
- 「学習に使わない」「データはあなたのもの」は既に定型文。書かないと減点になる水準まで一般化している
- FAQセクションによる反論処理(トライアル有無・データ所有・対象ユーザー)は大手共通の型で、セキュリティ敏感カテゴリでは有効な構造仮説
