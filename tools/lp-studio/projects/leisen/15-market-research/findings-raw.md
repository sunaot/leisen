# findings-raw — 市場・競合調査(生データ段階)

作成日: 2026-08-28 / 担当: Market Researcher
このファイルは結論・推奨を書かない。ソース一覧、反例、カバレッジの偏りのみ記録する。
観察の詳細は `observations.jsonl`(58件)、原文引用は `captures/notes.md` を参照。

## 1. ソース一覧(17件)

| source_id | class | 名称 | 市場 | 取得状態 |
|---|---|---|---|---|
| src-m01 | direct_competitor | Glean | en-US | 完全取得 |
| src-m02 | direct_competitor | Onyx (旧Danswer, OSS) | en-US | 完全取得 |
| src-m03 | direct_competitor | Amazon Q Business | en-US | 完全取得(EOS告知中) |
| src-m04 | direct_competitor | Microsoft 365 Copilot | ja-JP | 完全取得 |
| src-m05 | direct_competitor | Dust | en-US | **部分**(JS描画。検索スニペット+securityページ検索結果で補完) |
| src-m06 | direct_competitor | Coveo | en-US | 完全取得 |
| src-m07 | adjacent_jp | Helpfeel | ja-JP | 完全取得 |
| src-m08 | adjacent_jp | Qast | ja-JP | 完全取得 |
| src-m09 | adjacent_jp | ナレカン | ja-JP | 完全取得 |
| src-m10 | adjacent_jp | Notion AI | ja-JP | 完全取得 |
| src-m11 | adjacent_jp | exaBase 生成AI | ja-JP | 完全取得 |
| src-m12 | substitute | PKSHA AI ヘルプデスク | ja-JP | 完全取得 |
| src-m13 | substitute | Slack AI | ja-JP | 完全取得 |
| src-m14 | analogous_oss | Elasticsearch (Elastic) | en-US | 完全取得 |
| src-m15 | analogous_oss | Supabase | en-US | 部分(一部コンテンツのみ) |
| src-m16 | analogous_oss | HashiCorp Vault | en-US | 完全取得 |
| src-m17 | counterexample | Keycloak | en-US | 完全取得 |

- 直接競合比率: 6/17 = 35%(指針の50%以下を満たす)
- ja-JP: 7件 / en: 10件
- 観察数: 58件(1ソースあたり2〜5件)

## 2. 反例・カテゴリ慣習を破る例(観察ベース。良し悪しの判断はしない)

1. **Keycloak(src-m17)**: 商用LPの説得構造(問題提起→解決→ロゴ→数値→デモCTA)を完全に欠く。証明はCNCFバッジ・GitHub stars・標準プロトコル準拠のみ。CTAは"Get Started"/"Download"。純OSSプロジェクトサイトはLPと目的が異なることの参照点。
2. **Amazon Q Business(src-m03)**: 直接競合LPで唯一、顧客ロゴ・数値証明・認証バッジが本文にない。かつ具体単価($3/user/month)をLPに明示する少数派。ページ先頭がEnd of Support告知であり、カテゴリの製品統廃合の速さを示す。
3. **Coveo(src-m06)**: 直接競合帯で唯一、トップページ本文にセキュリティ・権限の記述がほぼない(フッターのTrust Centerのみ)。社内検索専業でないことが理由と解釈できる。
4. **HashiCorp Vault(src-m16)**: 「OSS+エンタープライズ」出自だが、製品LPからOSS/Community版への言及が消えている(BSL移行後)。OSSの見せ方はライセンス戦略で反転しうる例。恐怖訴求("Avoid becoming the next data breach")はサンプル中で唯一の強い損失フレーム。
5. **Onyx(src-m02)**: 競合名指しの自社ベンチマーク勝率(vs ChatGPT/Claude/Notion AI)をLPに掲載。このカテゴリでは他に観察されなかった。
6. **ナレカン(src-m09)**: 「『非IT企業』向けの」とターゲット限定をヘッドライン先頭に置く。who絞り込み型ヒーローの明確な例。
7. **Slack AI(src-m13)**: ヒーロー直下で「AI の登場でかえって悩みが増えた？」とAIブームへの疲労を逆手に取る切り出し。カテゴリの新規性を売る他社と逆向き。

## 3. 繰り返し観察されたパターン(頻度メモのみ。「ベストプラクティス」とは呼ばない。性能証拠なし)

- 権限・permission-aware訴求: Glean("Users only see what they're allowed to see")、Amazon Q("respect your existing identities, roles, and permissions")、M365 Copilot(「Microsoft 365権限と秘密度ラベルを継承」)、Notion AI(「何を見て」「何ができるか」)、Onyx("Granular Permissions")、Elastic("doc-level controls")の6/17で明示。一方、日本の隣接ナレッジ系(Helpfeel/Qast/ナレカン/exaBase/PKSHA)では権限モデルへの言及がほぼなく、ISO認証・国内サーバー・学習不使用に置き換わっている。
- 「学習に使わない」宣言: ja-JPページ5/7で明示(M365, Notion, ナレカン, exaBase, Slack)。日本語LPの定型文化。
- 日本B2BのCTA: 「資料ダウンロード」ファースト(Helpfeel/ナレカン/exaBase/PKSHA/Qast)。「3分でわかる資料」という所要時間付き表現が2件(Helpfeel, ナレカン)。英語圏は"Get a demo"(sales-led)か"Try for free"(PLG/OSS)に二分。
- OSSの見せ方: GitHub stars数値掲載(Onyx 20k, Keycloakウィジェット)、ライセンス名明示(Elastic AGPL)、self-host×データ透明性の接続(Onyx, Supabase)、デプロイ選択肢の並列カード(Elastic)。
- ヒーローのカテゴリ語彙が「検索」から「AI/エージェント/コンテキスト」へ移動(Glean, Dust, Notion, Elastic "context engineering", Vault "AI agent identities")。
- 削減時間・件数の定量提示: Glean(110h/年), Slack(97分/週), ナレカン(1,882時間/月, 789万円), PKSHA(月2,000件撤廃), Helpfeel(70%削減)。単位はバラバラで検証可能性は一様に低い。

## 4. カバレッジの偏り・見られなかったもの(重要)

- **Google Gemini Enterprise / Agentspace**: 公式LP(cloud.google.com/gemini-enterprise)はコンテンツ過大で取得失敗(2回試行)。検索で得た三次情報(SIer解説記事)は登録対象にしない。→ 直接競合の重要な1社が未観察。
- **GitLab**: about.gitlab.com が403で取得不可。analogous_ossの代替としてHashiCorp Vaultを採用。
- **Dust**: JS描画で本文取得不可。ヒーロー相当文言とsecurityページ内容は検索スニペット由来(confidence: medium)。セクション構成・フォーム摩擦は未観察。
- **広告(ad)**: Google広告透明性センターはJS必須で広告クリエイティブを取得できず(glean.comで試行)。Meta広告ライブラリは未試行。**広告文言の観察は0件。source_class=adの登録なし。**
- **フォーム摩擦**: フォーム項目数はHTML取得では大半のページで確認できず、観察が薄い(CTAラベルまで)。実ブラウザでの追観察が必要。
- **モバイル表示**: 全件desktop相当のHTML取得。device差分は未観察。
- **未サンプル**: Kibela、esa、サイボウズ系、KARAKURI、Coveo日本語版、Glean日本語ページ(存在有無未確認)、Moveworks、Sana、Perplexity Enterprise。日本の「社内AI検索」専業スタートアップは検索で特定しきれていない。
- 英語圏LPのproof数値・ベンチマークは全て自社申告であり、本調査では一切検証していない(performance_support: none)。
