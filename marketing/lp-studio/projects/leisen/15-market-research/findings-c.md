# findings-c: OSS+商用サポート型B2B LPの説得構造 / 反例 / 広告調査

調査日: 2026-08-27。証拠の正は `source-register-c.csv` / `observations-c.jsonl`。
すべて competitor practice の観察であり、成果(CVR等)の証拠ではない(performance_support: none)。

## 取得上の注意(観察の限界)

- Airbyte はbot向けにagent-readable変種を返した可能性が高く、ビジュアル観察は不成立(obs-c10)。
- Infisical / Supabase も要約的・機械可読寄りの本文が返っており、視覚配置の確度は中程度。
- GitLab(about.gitlab.com)は403で直接観察不能。検索インデックスのタイトルからの間接観察のみ(confidence: low)。

## 1. OSS analogue の説得構造 — 共通点

観察7件(PostHog, n8n, Airbyte, Metabase, Keycloak, Infisical, Supabase)+間接1件(GitLab)から。

### 1.1 OSSの使われ方は3類型に分かれる

| 類型 | 事例 | 使い方 |
|---|---|---|
| **カテゴリ定義の一部**(見出し級) | Metabase「Open source AI analytics you can verify」、Airbyte「the open-source data integration platform」、Keycloak(見出しが「Open Source」) | OSS自体を第一語に置き、透明性・検証可能性の約束と直結させる |
| **提供形態の透明化**(副文級) | Infisical(ヒーロー副文で「MIT license」「self-hosted」「Cloud, US/EU regions」を1〜2文で言い切る)、n8n「Deploy on your infrastructure or ours」、Supabase(副文で「open source backend」) | ライセンス・デプロイ選択肢を最初に開示し、評価コストを下げる |
| **後退・卒業**(トップから消える) | PostHog(現行トップにOSS訴求を確認できず、500,000+ teamsの規模証明に置換)、GitLab(Gartner Leader等アナリスト証明が主) | 成熟後はOSSより規模・アナリスト評価が信頼装置になる |

解釈: OSSは獲得初期の**信頼装置**(コードを見られる・逃げられる・試せる)として最も強く機能し、規模が付くと社会的証明に席を譲る。当社(導入初期・信頼ゼロ地点)はMetabase/Infisical型が参照になる。

### 1.2 セルフホスト/データ主権の訴求は「論理」で語られる

- Infisical: 「self-hosting removes third-party transits of secrets」— セルフホスト=第三者にデータを通さない、という因果を明文化(最も明確な言語化例)。
- n8n: セルフホストを「データ保護の手段」として節を立て、Local AI / Self-host / Hosted の3択を図解。
- Supabase: 「self-hostable」+「fully portable, no vendor lock-in」— 主導線ではなく**退出権の保険**として提示。
- Metabase: `docker run` コマンドをLPに直接掲載 — 「自分の環境で5分で試せる」ことの実演的証明。

解釈: 単に「オンプレ対応」と書くのではなく、(a) データが第三者を経由しない、(b) いつでも出られる、(c) 今すぐ手元で確かめられる、のどれかの**具体的な論理**に落とすのが慣習。

### 1.3 無料(OSS)と有償の導線の分け方

- **2本立てCTAの並列**が最頻: Metabase「Try Metabase Cloud free」/「Deploy Metabase Open Source」を同格に並べ、読者に自己選別させる。
- n8n / Airbyte / PostHog は第一CTAをクラウド無料登録に置き、セルフホスト/GitHubは本文中・ナビに置く(収益導線を優先しつつOSS導線を消さない)。
- Infisical は無料の境界を数値で明示(「5 identities...」/ self-host core は「free forever」)。
- Keycloak は対照例: 商用導線ゼロ(Download/Get Startedのみ)。商用サポート(Red Hat)はサイト分離。

### 1.4 証明(proof)の積み方

- **エンタープライズロゴ+OSSコミュニティ指標の併置**: n8nはMicrosoft/NVIDIA等のロゴとGitHubスター202k・コミュニティ200k+を同じ帯に置く。2種の読者(決裁者/評価エンジニア)へ同時に張る。
- **配布規模の桁**: Metabase「100,000+ companies」、PostHog「500,000+ teams」、Infisical「10 billion secrets/day」。OSS配布があるから主張できる桁。
- **標準準拠という代替証明**: Keycloakは顧客ロゴが一切なく、プロトコル認証ロゴとCNCFで信頼を担保。エンジニアが評価者の場合はロゴ帯より標準準拠が効くという設計。
- **コンプラバッジは後段の反論処理**: SOC 2 / GDPR(n8n, Metabase, Infisical)は「使える」の後の「任せられる」パートに置かれる。

### 1.5 説得の順番(最頻パターン)

1. アウトカムの約束(統制感・検証可能性が頻出: 「you can see and control」「you can verify」「Speed with control」)
2. 規模の社会的証明(ロゴ+数値)
3. 体験導線(デモ/docker run/動画)
4. デプロイ柔軟性(OSS/self-host/cloud)
5. エンタープライズ統制(SSO・監査ログ・RBAC・SIEM・コンプラバッジ)
6. 事例・証言
7. 最終CTA

ビジュアルは全件で**抽象イラストより実UI/実物**(n8nのキャンバス実画面、Metabaseの実ダッシュボード、Keycloakの管理コンソールSS、Oxideの実機ラック)。「見える・検証できる」系の約束は画像自体が証明を兼ねる。

## 2. 反例LP — 破っている慣習とその機能

- **PostHog**(oss_analogueだが慣習破りとしても一級): 社会的証明セクションに「Social proof」とラベルを付け「Yes they actually use us, no it's not just some random engineer...」と注記。営業CTAを「Talk to a human」と呼び替え、ナビに「Trash」。→ 破っている慣習: ロゴ帯・営業導線の真面目さ。機能: 読者(開発者)のマーケ不信を先回りして言語化し、身内シグナルで信頼を得る。
- **Oxide Computer**: 抽象ヒーローの代わりに物理ラック実写+工業的デザイン、「The cloud you own」。比較表は自社vs競合ではなく「従来オンプレ vs パブリッククラウド」の既存二択に張り、第三の選択肢として自己定義。→ 機能: 実在感の証明と、比較軸ごと作り替えるポジショニング。
- **ONCE (37signals)**: LPがほぼテキストの製品リストのみ。ロゴ帯・機能グリッド・スクショ群を全放棄。「without a subscription. And you get the code, too.」→ 機能: 提供形態(買い切り+コード同梱)自体が唯一の説得材料。装飾の不在が反SaaS思想の証明。OSSでなくても「コードが手元にある」ことが退出権・所有権の訴求として機能する点は当社に示唆。
- **Basecamp**: ロゴ帯の代わりに実名テスティモニアル10件+1,000件参照、運用実績(84M accounts, 99.99% uptime, サポート平均在籍9年)、創業者の手紙、競合への名指し批判(「bloated, complicated, and confusing」)。→ 機能: 匿名の権威(ロゴ)を実名の当事者の声に置換。長文が買い手を選別する。

共通解釈: 反例はいずれも「慣習を破ること」自体がメッセージ(誠実さ・実在感・思想)になっており、破り方が製品の中心的約束(所有・単純さ・開発者本位)と一致している。慣習破りは装飾でなく約束の証明手段。

## 3. 広告→LP対応の調査結果(到達不能の記録)

- Google広告透明性センター(adstransparency.google.com, region=JP, domain=glean.com): JS必須SPAのため本環境のサーバーサイド取得ではクリエイティブ非表示。**広告の有無自体が判定不能**(obs-c33)。
- Meta広告ライブラリ(country=JP, q=Helpfeel): HTTP 403 Forbiddenで**到達不能**(obs-c34)。Notion/Gleanも同経路のため確認不能。
- 従って広告の約束とLPの続きの対応は今回**証拠化できず**。記録のみ(創作なし)。残タスク: 人手ブラウザでの両ライブラリ確認(Glean / Notion / Helpfeel、地域JP)。

## 4. 当社LP検討への持ち帰り(interpretation、性能証拠なし)

1. 信頼ゼロ地点のOSS製品は、OSSを「検証可能性・データ主権の論理」としてヒーロー近くで言語化するのが同型製品の慣習(Metabase/Infisical型)。
2. セルフホスト訴求は「データが第三者を経由しない」という因果文で書く(Infisicalの言語化が最良の参照)。
3. CTAはCloud/セルフホストの2本並列で自己選別させる型が確立している。`docker run`等の即時試行コマンドの掲載は体験デモの代替になり得る。
4. エンタープライズ統制(監査ログ・SSO・権限)は後段の専用節に集約するのが慣習。当社の場合、権限透過・監査ログは統制節ではなくヒーロー級の差別化に昇格させる余地がある(慣習からの意図的逸脱候補)。
5. 証明が無い初期は、Keycloak型(標準準拠・アーキテクチャの誠実な開示)とBasecamp型(実名の声・思想の表明)がロゴ帯の代替になる。
