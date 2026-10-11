# 脅威モデル(T-000c)

Status: Accepted(セキュリティレビュー完了: 2026-07-09、T-000cゲート解除) / Date: 2026-07-07 / 最終改訂: 2026-10-11(§8 改訂履歴)

本書は実装前ゲート T-000c の成果物である。STRIDE を分類枠組みとして、本基盤の攻撃面を列挙し、
各脅威に対策・検出手段・対応タスクIDを紐づける。T-008(評価ハーネス)のレッドチームシードと
T-013(セキュリティスイート)の入力を兼ねる。

- 対象範囲: Phase 1(フェデレーテッド検索)+ Phase 2 で追加される検索層の設計上の境界(ADR-012)。
  Phase 3(マップ生成)は着手時に本書を改訂する
- 前提: シングルテナント(1デプロイ=1社、ADR-005)。コネクタIFは v0.4(ADR-016、追補2)
- 正とする関連文書: ADR-010(認可方式)、ADR-011(監査2層)、ADR-012(未認可候補境界)、
  ADR-013(プライバシー)、ADR-014(Slack)、ADR-015(エージェント委譲)

---

## 1. システム分解と信頼境界

```
利用者 ──(SSO/IdP)── チャットUI/API
                        │ TB1: 利用者⇔Orchestrator(セッション束縛)
                   [Orchestrator]…LLM探索ループ
                        │ TB2: Orchestrator⇔Gateway(MCP、実行区分の申告)
                   [MCP Gateway]…IdP Adapter / Token Vault / 監査ログ
                        │ TB3: Gateway⇔Connector(AuthContext注入)
                   [Connector 群]
                        │ TB4: Connector⇔ソースAPI(本人資格情報)
                   [データソース]
                        └ TB5: Search Backend Adapter 内部(Phase 2)
                          …未認可候補が存在してよい唯一の領域(ADR-012)
```

信頼境界の要点:

- **TB1**: LLMへの入力(質問)と検索対象文書の本文は、いずれも信頼できない入力として扱う。
  特に後者は「社内の誰かが書ける」= 攻撃者が制御可能(§4-D)
- **TB2**: Orchestrator は信頼しない。認可・監査・レート制御はすべて Gateway 側で強制する
  (Orchestrator が侵害・誤動作しても権限逸脱が起きない配置)。Orchestrator から届くもの(ツール呼び出しの
  引数、`_meta` の申告、run API での run の結果・引用・フィードバック)はすべて申告として扱い、Gateway が
  検証できる部分を検証してから記録する。監査ストアに書くのは Gateway だけ(ADR-019。T-023 で実装済み:
  AnswerRun も Gateway の run API が書き、Orchestrator のコンテナは監査ボリュームを一切マウントしない。TM-I4)
- **TB5**: 未認可候補(内容・件数とも)はこの内側にのみ存在する。外に出るのは認可済みhitのみ

## 2. 攻撃者モデル

| ID | 攻撃者 | 能力 | 主な狙い |
|---|---|---|---|
| AT-1 | 正規の内部利用者(好奇心・悪意) | 自分の権限でチャット/APIを自由に使える | 権限外文書の内容・存在の推定。自分の権限内のデータの、エージェントによる横断的な大量取得(§7) |
| AT-2 | 文書作成者(内部・侵害アカウント) | 検索対象ソースに文書・メッセージを書ける | プロンプトインジェクション経由の情報引き出し |
| AT-3 | 退職者・権限剥奪直後の利用者 | 剥奪前に取得したセッション/トークン | 失効反映遅延の窓での継続アクセス |
| AT-4 | 基盤運用者・監査ログ閲覧者 | ログ・設定・インフラへのアクセス | 私的閲覧(DMメタデータ等)、証跡の改竄 |
| AT-5 | 導入先の管理者(悪意なし) | deployment.yaml を自由に書ける | (誤設定による事故。攻撃者ではないが脅威源) |
| AT-6 | 外部攻撃者 | ネットワーク経由。認証情報なし | Token Vault・監査ログ等の保管データ窃取 |

Orchestrator/LLM 自体も「侵害されうるコンポーネント」として扱う(TB2)。

## 3. STRIDE 対応表(概観)

| STRIDE | 本基盤での主な現れ方 | 詳細 |
|---|---|---|
| Spoofing | MCPセッションと利用者アイデンティティの束縛不備、on-behalf-ofチェーンの偽装 | §4-C, §4-G |
| Tampering | 監査ログの改竄、カタログ/描画コンテンツの汚染 | §4-F, §4-D |
| Repudiation | 監査レコードの欠落(fail-open時)、actor記録の不備 | §4-F |
| Information Disclosure | 未認可候補の流出、existence leak、トークン漏洩、キャッシュ共有 | §4-A/B/C/G/H |
| Denial of Service | レート制限枯渇、監査fail-closedの可用性影響 | §4-F, §4-H(スコープ外項目は§6) |
| Elevation of Privilege | インジェクションによる権限外ツール呼び出し、誤設定による認可バイパス | §4-D/E |

## 4. 脅威カタログ

各脅威は `TM-<領域><連番>` で識別する。表の「対応タスク」は docs/backlog/ のタスクID。

### 4-A. 未認可候補の流出経路(ADR-012 境界の裏取り)

Phase 2 の post-filtering では「権限を無視して候補を取得 → 本人トークンで認可照会 → 認可済みのみ返却」
を行うため、未認可候補(タイトル・URL・スニペット・documentId・件数)が Search Backend Adapter の
内側に必ず存在する。流出しうる経路を列挙し、すべて塞ぐ。

| ID | 経路 | STRIDE | 対策 | 検出手段 | 対応タスク |
|---|---|---|---|---|---|
| TM-A1 | 戻り値: 候補件数・pre-filter統計が SearchResult やメトリクスに乗る | I | `SearchResult.totalCount` は型から削除済み(ADR-016)。件数系フィールドの追加はADR必須。実行時の混入に備え、Gateway はコネクタの返答を IF の既知フィールドだけに射影して返す(型にないフィールドは出さない、meta は string→string のみ。2026-09-27 実装) | SDK型の後退テスト(if-fitness)、PRレビュー(security-reviewer)、射影テスト(`packages/gateway/test/proxy-tools.test.ts`「result projection to connector-sdk fields」) | T-016, T-015, T-003 |
| TM-A2 | ログ: アダプタ内のデバッグログ・例外メッセージに候補のタイトル/IDが混入 | I | アダプタ内ログは候補情報を含まない規約。例外は候補情報を含まない定義済みエラー型に変換してから外へ | ログ出力の契約テスト(候補固有文字列の非出現)、カナリア文書(§5) | T-016, T-013 |
| TM-A3 | メトリクス: 空振り率・K拡張回数等の運用メトリクスから件数が復元できる | I | ADR-011の分離テレメトリのみ許可(バケット化、query/userId/docIdと結合不可、短期保持、高権限限定)。昇格レポート(T-014)には含めない | テレメトリのスキーマレビュー、結合可能性の机上検査 | T-001, T-014, T-016 |
| TM-A4 | タイミング: 適応的K拡張の再照会回数が応答時間に現れ、「未認可候補が多い」ことが推定できる | I | K拡張の上限固定。完全な排除は困難なため**残余リスクとして受容**し、単発では低情報量(件数の粗い有無のみ)であることを根拠に文書化 | レッドチーム項目(反復計測による推定試行)で情報量を定期評価 | T-013 |
| TM-A5 | エラー経路: 認可照会APIの失敗時に候補を「未照会のまま」返してしまう(fail-open) | I/E | 照会失敗した候補は返却しない(fail-closed)をアダプタの不変条件とする | 認可照会障害を注入する異常系テスト | T-016, T-015 |

### 4-B. existence leak(存在推定)

内容が漏れなくても「存在する」ことが分かるだけで機密性は毀損する(例: `<M&A相手名> 統合計画` で
ヒット件数だけ見える)。ADR-011/012/016 で件数系は既に閉じているが、挙動差の経路が残る。

| ID | 経路 | STRIDE | 対策 | 検出手段 | 対応タスク |
|---|---|---|---|---|---|
| TM-B1 | 監査ログに pre-filter 候補件数が残り、返却0件との差分で存在が漏れる | I | 候補件数フィールドを型・zodスキーマに存在させない(ADR-011)。`FORBIDDEN_KEYS` による実行時拒否も併用 | T-001の禁止フィールドテスト、guard hook(補助) | T-001 |
| TM-B2 | fetch のエラー区別: 権限外の documentId を推測して fetch した際、`permission_denied` と `not_found` の区別が LLM/利用者に返ると存在が確定する | I | ソース自体が区別を返す場合は委譲原則上仕方がないが、**本基盤が区別を増幅しない**: Orchestrator/利用者向け応答では両者を「利用できない文書」に正規化する(監査ログの errorClass は区別を保持してよい — 閲覧が高権限限定のため)。正規化の実装位置はGateway(T-003)。**実装済み(2026-09-27)**: `normalizeToolError`(`packages/gateway/src/proxy/tools.ts`)が両者を単一の分類 `not_available`・固定文言にまとめる(retryAfterMs も付けない)。監査レコードは正規化前に書くため元の分類が残る。GitHub 固有の形は TM-H1 | 権限外docIdのfetch試行テスト(応答文言の同一性)— 実装済み: `packages/gateway/test/proxy-tools.test.ts`「existence-hiding normalization (TM-B2)」(fetch / search で permission_denied と not_found の返却が完全一致し、監査は元の分類を保持)、`packages/gateway/test/mcp-proxy.test.ts`「returns identical tool results for permission_denied and not_found, while the audit keeps the original class (TM-B2)」。レッドチーム | T-003, T-007 |
| TM-B3 | describe/list の区画メタデータ(プライベートチャンネル名、限定共有ドライブ名)が本人権限外まで見える | I | describe/list も本人資格情報で呼ぶ(IF上強制: 全操作が AuthContext 必須)。ソース側APIが権限外メタデータを返さないことを T-000a マトリクスで確認 | ソース別の権限境界テスト(T-008シード) | T-000a, T-005, T-006, T-008 |
| TM-B4 | Phase 2 の粗い事前フィルタ(区画メタデータ)の設計誤りで、除外/包含の挙動差から区画所属が推定できる | I | 事前フィルタは「明らかに到達不能な区画の除外」のみ(ADR-003)。フィルタ結果もTB5内に留める | 検索層実装時のfitting検証・レッドチーム | T-016 |
| TM-B5 | 検索の応答挙動差(0件時の応答時間・リトライ回数)からの存在推定 | I | TM-A4と同じく完全排除は困難。返却0件時の応答を成功パスと同一形状にする(特別扱いのコードパスを作らない) | レッドチーム項目 | T-013 |

### 4-C. トークン漏洩と失効反映遅延

ADR-010 により個別 OAuth が主経路となり、Token Vault(リフレッシュトークンの長期保管)が
最大の集中リスクになる。

| ID | 経路 | STRIDE | 対策 | 検出手段 | 対応タスク |
|---|---|---|---|---|---|
| TM-C1 | Token Vault の保管データ窃取(AT-6/AT-4) | I/E | 保存時暗号化(KMS連携、鍵はVault外)、Vault へのアクセスは Gateway プロセスのみ、監査対象化。バックアップも暗号化 | KMSアクセスログの監視、依存脆弱性の自動監査 | T-004, T-013 |
| TM-C2 | ログ・エラー・デバッグ出力へのトークン混入 | I | `redactAuthContext()` の強制(不変条件6)。`JSON.stringify(auth…)` の静的解析禁止(ESLint no-restricted-syntax)、secret scan(gitleaks)をCI/pre-commitに導入 | fitting test でのトークン非流出検証(実装済)、CI secret scan | T-013 |
| TM-C3 | メモリ上のトークン(コアダンプ、クラッシュレポート) | I | アクセストークンの保持は最短(利用者×ソース単位、トークン有効期間内のみ)。クラッシュレポートに環境・メモリを含めない設定を導入プレイブックに明記 | — (受容。ホスト侵害時点で他経路が優位) | T-004, T-012 |
| TM-C4 | 退職・権限剥奪後もリフレッシュトークンが生きている(AT-3) | E | IdP の deprovisioning イベント(SCIM等)受信で各SaaSトークンを revoke(ADR-010)。イベント欠落に備えた定期照合(IdPユーザー一覧とVault保有者の突合)を運用手順化 | 失効遅延の計測(deprovision→revoke完了のSLO)、定期突合レポート | T-004, T-012 |
| TM-C5 | 認可照会キャッシュのTTL内は権限剥奪が反映されない(Phase 2) | E | TTLは短期(5〜15分目安)とし、deployment.yaml の `authzCacheTtlSec` に上限を設けて起動時検証。TTL=「剥奪から反映までの許容遅延」としてセキュリティポリシーに明文化(ADR-003) | T-010 の上限超過拒否テスト | T-010, T-016 |
| TM-C6 | MCPセッションと利用者アイデンティティの束縛不備: セッション乗っ取り・取り違えで他人のトークンが使われる | S/E | Gateway でセッション⇔userId の束縛を確立(ADR-001追補、T-003の設計項目)。ツール呼び出しごとに AuthContext の userId とセッション主体の一致を検証。Gateway は tools/call の結果の `_meta`(`io.github.sunaot.leisen/userId`)に認証した userId を載せ、Orchestrator は AnswerRun の主体をそれに束縛する(呼び出し元の申告と食い違えば run を error / `user_mismatch`、Gateway が利用者を確認できなければ AnswerRun を書かない。2026-09-27 実装、T-007 セキュリティレビュー H1)。**ADR-019(T-023)の実装後は AnswerRun を Gateway が認証値で書くため、束縛は構造で成り立つ** | 束縛検証のユニットテスト(取り違え注入)、監査ログの userId 突合(AnswerRun と ToolInvocation を (runId, userId) で結合、docs/audit-queries.md)、`packages/orchestrator/test/user-binding.test.ts`、`packages/gateway/test/mcp-proxy.test.ts`「result _meta carries the authenticated userId (T-007 security review H1)」 | T-003, T-007 |
| TM-C7 | on-behalf-of チェーンの偽装: エージェントが虚偽の実行区分・委譲チェーンを申告 | S/E | Phase 1 は human-in-the-loop のみ許可、scheduled/autonomous は Gateway が既定拒否(ADR-015)。チェーンは Orchestrator の自己申告を信用せず Gateway が発行・検証する設計とする。申告キーの誤記は黙って無視せず invalid_request にする(無視すると human_in_the_loop として通る): 既知の4キーと完全一致しないキーのうち、骨格(NFKC 正規化 → 小文字化 → ASCII 英数字以外の除去)が名前空間 prefix の骨格で始まる・`executionclass` で終わる・`actor` に等しいものを拒否する。大文字小文字・前後の空白・区切りの違い・prefix 直後の `/` の欠落・prefix の綴り違い(executionClass)・全角/ゼロ幅文字による見た目違いを同じ申告名として照合する(2026-09-27 実装、再レビュー S1。`packages/gateway/src/proxy/meta.ts`)。**残余(Gateway では検知できない)**: `_meta` 以外の場所での申告(`params.meta` 等のスキーマ外のキーは SDK が取り除く)、申告そのものの省略、名前空間外のキー名自体の綴り違い(`execClass` 等)と prefix を誤った actor(`kp.gateway/actor` 等。他社名前空間の actor と区別できない)。いずれも既定の human_in_the_loop / human として扱われる。未申告を human_in_the_loop とする既定が HTTP 化で Bearer を持つ任意の MCP クライアントに及ぶ点は、受容範囲の再確認を人間に依頼中(T-003 H1) | 区分申告の拒否テスト(T-007)、監査ログの actor 検証(空チェーン拒否は実装済)、誤記申告の拒否テスト(`packages/gateway/test/proxy-tools.test.ts` / `mcp-proxy.test.ts` / `http-transport.test.ts`) | T-003, T-007 |

### 4-D. プロンプトインジェクション経由の情報引き出し

検索対象文書の本文は攻撃者(AT-2)が制御できる入力である。LLM が読んだ文書内の指示に従って
しまうと、本人権限で読める機密を攻撃者の可視領域へ運び出す(confused deputy)。

| ID | 経路 | STRIDE | 対策 | 検出手段 | 対応タスク |
|---|---|---|---|---|---|
| TM-D1 | 文書内の指示テキストが LLM の探索・回答方針を乗っ取る | E/T | ツール結果は「データであって指示ではない」プロンプト防御(product-design 7.2)。ツールIFが読み取り専用(search/fetch/list/describe のみ、書き込みツールなし)であることが被害半径の構造的上限 | T-008 インジェクションシード(§6)、四半期レッドチーム | T-007, T-008 |
| TM-D2 | 出典リンク・画像URL経由の exfiltration: 回答中の Markdown 画像/リンクURLのクエリ文字列に機密を積み、チャットUIの自動取得・利用者クリックで攻撃者サーバーへ送信 | I | チャットUIは外部画像の自動レンダリング・自動プリフェッチをしない(T-009要件)。**回答本文には URL を一切残さず、原典へのリンクは citations[].url(ツール結果の値)からのみ利用側が描画する**(Orchestrator の出力フィルタ `packages/orchestrator/src/sanitize.ts`: Markdown のリンク・画像・参照定義、生の HTML、URL らしき文字列 — 実体参照・`\`・全角・ゼロ幅文字で組んだものを含む — を除去し、最終検証で取りこぼしも除く。2026-09-27、T-007 セキュリティレビュー M1。原典 URL の許可リスト方式は迂回が実証されたため廃止)。残余: スキーム・`www.`・`//`・パス/クエリのない裸のドメイン名とメールアドレスは本文に残る(ファイル名等と区別できない)ため、UI は fuzzy な自動リンクを無効にする(T-009) | 出力フィルタの warnings(除去件数・最終検証での追加除去)、T-008 exfiltration シード。テスト: `packages/orchestrator/test/sanitize.test.ts`「sanitizeAnswerText: レビューで実証された迂回を塞ぐ(M1)」「最終検証(手順 5、fail-closed)」、`packages/orchestrator/test/citations.test.ts`「文書内の指示(隠しコメント含む)に従った回答でも、本文に URL を残さず原典のリンクは出典だけが運ぶ(RS-3 / RS-4)」「最終検証で除去したものは warnings に別に記録する(fail-closed、M1 手順5)」 | T-009, T-007, T-008 |
| TM-D3 | インジェクションが追加のツール呼び出しを誘導し、攻撃者可視のソースへ「検索クエリとして」機密を書き出す(検索クエリがソース側の検索履歴・ログに残る) | I | Gateway 出力フィルタで「fetch した文書内容に由来する長い固有文字列がその後の検索クエリに出現する」パターンを検知(product-design 7.2 の権限外ソース追加呼び出し検知を拡張)。反復回数上限(maxIterations)と、1ターン・1 run のツール呼び出し件数の上限(maxToolCallsPerTurn / maxToolCallsPerRun、2026-09-27 T-007 m1)で増幅を制限 | フィルタ検知ログ、レッドチーム、`packages/orchestrator/test/limits.test.ts`「ツール呼び出しの件数の上限(m1)」 | T-003, T-007 |
| TM-D4 | describe/Source Catalog・(Phase 3)マップの生成入力に注入され、全利用者の初手コンテキストが汚染される(stored injection) | T/E | カタログ生成入力の出所を限定(T-018)。Phase 3 マップは人間レビュー必須(全自動化しない)。Slack由来データはそもそもカタログ/マップ入力に使わない(ADR-014)。Orchestrator は describe 結果を system prompt に入れず、最初の user ターンに「データであり指示ではない」前置き+JSON で渡し、`kind` / `supportedFilters` を SDK の値域に限り件数・長さを切り詰める(2026-09-27、T-007 セキュリティレビュー H3) | カタログ差分レビュー、hallucination照合(Phase 3)、`packages/orchestrator/test/prompt-tools.test.ts`「buildSystemPrompt / buildFirstUserContent(H3)」 | T-018, T-007 |

### 4-E. 管理者の誤設定(deployment.yaml)

導入先管理者(AT-5)は悪意なく危険な組合せを書く。「導入先での誤設定による権限事故」は
v2 リスク表で影響「高」。**危険設定は起動時に拒否する**(ADR-005)。

| ID | 危険な組合せ | STRIDE | 対策 | 検出手段 | 対応タスク |
|---|---|---|---|---|---|
| TM-E1 | `searchLayer.enabled: true` だが対象コネクタが ingest 未実装/認可照会の設定不備 | E | 起動時拒否(ConnectorCapabilities 連動検証) | T-010 起動拒否テスト | T-010 |
| TM-E2 | `audit.failureMode: fail-open` を確認フラグなしで設定(監査の欠落を許容してしまう) | R | 既定 fail-closed。fail-open は明示確認フラグ必須+導入プレイブックでポリシー明文化を要求(ADR-011) | T-010 起動拒否テスト | T-010 |
| TM-E3 | `authzCacheTtlSec` の過大設定(権限剥奪の反映遅延が無際限に伸びる) | E | スキーマ上限で起動時拒否(TM-C5) | T-010 起動拒否テスト | T-010 |
| TM-E4 | `privateScopes: included` の安易な有効化(DM・プライベート領域が既定で検索対象化) | I | 既定 excluded(ADR-013)。included への変更は確認フラグ+利用規程の整備を導入チェックリストで要求 | T-010 既定値テスト、導入時セキュリティチェックリスト | T-010, T-012 |
| TM-E5 | `agentExecution` で scheduled/autonomous を Phase 1 のまま解放 | E | Phase 1 は設定に関わらず Gateway が既定拒否(ADR-015)。解放には同意実装の存在を前提条件とする | T-003/T-007 拒否テスト | T-003, T-007, T-010 |
| TM-E6 | audit.sink の未接続・書き込み先喪失に気づかない(監査の静かな欠落) | R | fail-closed 既定により欠落は即時に可視化される(ツール呼び出しが失敗する)。sink 死活のヘルスチェックをリファレンスデプロイに含める | ヘルスチェック監視 | T-001, T-012 |
| TM-E7 | Slackコネクタで永続化を伴う機能(キャッシュ・カタログ入力等)を有効化(ADR-014違反) | I | Slack由来データの永続化不可を設定スキーマ/コネクタ実装の両方で構造的に拒否 | T-006 の非永続化テスト、guard hook(補助) | T-006, T-010 |
| TM-E8 | 既定の `privateScopes: excluded` がコネクタで実装されない(方針がコネクタに届かず、DM・プライベートチャンネル・個人スコープが検索対象になる。その docId が平文で監査に残る。ADR-013 §1・§2 違反) | I | コネクタ IF v0.4(ADR-016 追補2): 方針を factory に渡し(`ConnectorFactoryInit.policy`)、全結果に `scope` を付け、能力 `privateScopeHandling` を宣言させる。`excluded` + `unsupported`(宣言なしの v0.3 を含む)は起動時拒否(`private_scopes_unenforceable`)。Gateway が射影で `scope` を読み(欠落・未知は private)、`excluded` では search / list / describe の private を落とし、fetch を `private_scope_excluded` で拒否する(落とした件数は監査・ログに出さない)。Orchestrator は citedDocIds を「結果の scope が shared でない ∨ ソースの方針が excluded でない」で hashed / omitted にする。`consent` は #42 まで起動時拒否(`private_scopes_consent_not_supported`)。残余: コネクタの分類の誤りとソース側の除外の失敗が同時に起きると漏れる(両者の根拠を分ける)。GitHub の issue / PR・fetch は所有者の種別を判定できず、「app を組織にだけインストールする」前提に依存する(fetch 時に `GET /repos/{owner}/{repo}` で判定する案は見送り。前提のまま受容: オーナー確認 2026-10-09、issue #19)。`classified` のコネクタでは Gateway が落とした後も `nextCursor` はそのまま返るため(issue #45 で追跡)、ページの件数が limit より少ないのに続きがある形から、本人のプライベート領域に一致があることを LLM・利用者が推定しうる(本人の文書に限る推定。将来は shared が limit 件たまるまで続きを取りに行くことを検討)。分離テレメトリ(落とした事実の記録)は未実装で、`enforced` のコネクタの契約違反も検知できない | Gateway の強制テスト(方針を無視する試験用コネクタ)、起動拒否テスト、docId 分類テスト、各コネクタの scope 対応表の契約テスト | T-005, T-006, T-010, T-019 |

### 4-F. 監査ログ自体への攻撃

監査ログは権限逸脱検出の基盤であると同時に、それ自体が機微データ(誰が何を調べたか)の
集積である(ADR-013)。

| ID | 脅威 | STRIDE | 対策 | 検出手段 | 対応タスク |
|---|---|---|---|---|---|
| TM-F1 | 改竄: 運用者(AT-4)が自分の行為の証跡を消す・書き換える | T/R | 監査ストアは append-only 構成をリファレンスデプロイの標準とする(書き込み専用資格情報、運用者の削除権限分離)。改竄検知(ハッシュチェーン等)の要否は導入先のコンプライアンス要件に応じてプレイブックで選択 | ストア側のアクセス監査、定期整合性チェック | T-001, T-012 |
| TM-F2 | 欠落: 書き込み失敗・バッファ喪失で証跡が欠ける | R | 既定 fail-closed(書けなければツール呼び出し自体を失敗させる)+ローカルバッファ・at-least-once・shutdown時flush(ADR-011)。stdout デバッグsinkを本番に使わない旨は実装済みコメント+プレイブックで明記 | 欠落検知(requestId の連番/突合)、T-001 異常系テスト | T-001, T-003 |
| TM-F3 | 閲覧権限の濫用: 監査ログから従業員の行動(DM参照履歴等)を私的に閲覧 | I | 閲覧権限・目的・保持期間の規程化(ADR-013 §3で確定)。プライベートスコープ docId の不可逆化オプション。監査ログへのアクセス自体を監査する(メタ監査) | 監査ストアのアクセスログレビュー | T-000b, T-001 |
| TM-F4 | 監査ログ経由の情報漏洩: rawQuery テーブル(生クエリ)の窃取・過剰保持 | I | rawQuery は digest 結合の短期保持別テーブル(ADR-011)、保持期間は deployment.yaml で設定。質問文自体に機密が含まれる前提で扱う | 保持期間超過データの検出(定期ジョブ) | T-001, T-010 |
| TM-F5 | DoS: fail-closed を逆手に取り、監査ストアを飽和させて全ツール呼び出しを止める | D | ローカルバッファによる短時間の吸収(ADR-011)、レート制御(Gateway)。可用性とのトレードオフは fail-closed の設計上の受容事項として文書化 | sink レイテンシ・バッファ滞留の監視 | T-001, T-003, T-012 |

### 4-G. ユーザー間キャッシュ共有・共有コンテキスト化

「認可はソースに委譲」の前提は、**過去の照会結果を別人に見せた瞬間に崩れる**。

| ID | 脅威 | STRIDE | 対策 | 検出手段 | 対応タスク |
|---|---|---|---|---|---|
| TM-G1 | 検索結果・fetch結果のキャッシュが userId を含まないキーで共有され、他人の権限で取った結果が返る | S/I/E | キャッシュキーに必ず userId を含める(不変条件4)。対象は検索・fetch・認可照会のすべて | キャッシュキー規約のユニットテスト、コードレビュー(security-reviewer) | T-003, T-016 |
| TM-G2 | describe 結果・Source Catalog が「ある利用者の見え方」で生成され全員に配られる(限定コンテナ名の漏洩) | I | describe は本人資格情報で都度取得。Source Catalog は本人権限フィルタ版と全社公開版を分離し(v3 §7)、全社公開版の入力は全員可視情報のみに限定 | カタログ生成入力の出所検証、権限別ユーザーでの表示差分テスト | T-018 |
| TM-G3 | (Phase 3)マップの権限区画設計の誤りで、区画の一部しか見られない文書が要約に混入 | I | 入力を「区画のIdPグループに明示的に共有されたコンテナ」に限定+オーナー承認制 Curated Map(v3 §8)。着手時にADR化 | マップ生成時の入力検証、人間レビュー | (Phase 3 ADR) |
| TM-G4 | チャット履歴への機密転写: 回答に含まれた機密が履歴に残り、その後の権限剥奪・共有機能で他者に露出 | I | 履歴の保持期間・エクスポート可否・共有禁止を T-009 要件化(ADR-013)。Slack由来コンテンツは非永続化または redaction(ADR-014) | T-009 の要件テスト | T-000b, T-009 |

### 4-H. GitHub コネクタ(T-019)固有

GitHub コネクタは全呼び出しを本人の GitHub App user access token で行い、認可を GitHub に委譲する
(auth-matrix §4、ADR-010 方式A)。ソース固有の挙動が既存の脅威の前提をずらす箇所を列挙する。
対策の実装とテストは `packages/connector-github`(README の「前提」「エラー分類」「既知の限界」)。

| ID | 経路 | STRIDE | 対策 | 検出手段 | 対応タスク |
|---|---|---|---|---|---|
| TM-H1 | (TM-B2 関連)GitHub は本人が権限を持たない private repo を 404、SAML SSO を本人が未認可の org のリソースを 403(`X-GitHub-SSO`)で返す。コネクタはそれぞれ `not_found` / `permission_denied` に分類するため、区別がそのまま LLM に届くと「SSO 保護された org に当該リソースが存在する」ことが推定できる | I | Gateway の LLM/利用者向け正規化で両者を同一の `not_available`(固定文言)にまとめ、区別は監査レコードの errorClass にのみ残す(TM-B2、実装済み)。SSO 認可の案内は LLM 経由でなく接続・同意の導線で行う(T-009)。SSO 強制 org で「存在しない repo」と「存在するが権限外の repo」の応答差(403-SSO か 404 か)は未実測 | TM-B2 のテスト、実疎通での応答差の記録(T-019 残作業)、カナリア(§5.2 GitHub) | T-003, T-019 |
| TM-H2 | (TM-C2 関連)リダイレクト追従や baseUrl の誤設定で、本人トークンが GitHub 以外へ送られる | I | トークンは `Authorization` ヘッダ限定(URL・クエリ・エラーメッセージに載せない)。`baseUrl` は https 必須(http は loopback のみ)、資格情報・クエリ付きは構築時に拒否。リダイレクトは `redirect: "manual"` で自前追従し、baseUrl と同一オリジン・ベースパス内に限り本人トークン付きで最大3回再送する。別オリジン・ベースパス外・エンコード済み区切り文字(`%2F` / `%5C`)を含むパスには送らない。注入 fetch は `redirect: "manual"` の尊重が前提で、前提違反の追従済み応答(`response.redirected`)は source_unavailable で破棄する(送出済みトークンは取り消せないため前提として README に明記)。installation token(`ghs_`)・refresh token(`ghr_`)の接頭辞は API 呼び出し前に拒否 | `packages/connector-github/test/auth.test.ts`「(5) リダイレクトで本人トークンを baseUrl の外へ送らない」「(1) 資格情報の前提違反」 | T-019 |
| TM-H3 | (TM-D 関連)インジェクションを含みうる LLM が documentId / filters / カーソルを改変し、API パスのすり替え(ドットセグメント)・検索修飾子の混入・上限を超える取得を起こす | T/E | documentId・filters・カーソルを構文と値域で厳格に検証し、不正は `invalid_request`(受領値はエコーしない)。search カーソルは各ストリームの per_page 合計の上限(100)も検証する。**`filters.container`(`repo:` / `org:` 修飾子)は安全境界ではない**: 修飾子は検索語にも書けるため範囲の絞り込みはヒントに過ぎず、範囲外の結果を防ぐのは GitHub 側の本人権限による認可のみ(README と describe の要約で開示) | `packages/connector-github/test/fetch.test.ts` / `search.test.ts` の不正入力拒否テスト | T-019 |
| TM-H4 | コード検索のレート枠(認証時 10 req/min、ユーザー単位で本人の他の GitHub 利用と合算)が、探索ループやインジェクションに誘導された反復で枯渇する(可用性) | D | 残quota をユーザー×リソース種別で追跡し、枯渇中は API を呼ばずに `rate_limited`(retryAfterMs 付き)を返す。コネクタ内ではリトライしない(再試行の判断と回数の記録は Gateway / Orchestrator)。導入によっては `searchCode: false`。反復は maxIterations(T-007)と Gateway のソース別流量上限で制限 | `packages/connector-github/test/ratelimit.test.ts` | T-019, T-007 |
| TM-H5 | (TM-D1 関連)issue / PR / ファイル本文の HTML コメント等、GitHub の表示では見えないテキストに指示を埋め、人間のレビューをすり抜けて LLM に届ける | E/T | snippet では HTML コメントを除去する。fetch 本文は原文のまま返す(忠実性を優先。部分的な除去は防御にならない)ため、Orchestrator がツール結果を「データであって指示ではない」として扱うこと(TM-D1)が対策の主体 | T-008 インジェクションシードに不可視テキスト(HTML コメント)埋め込み型を含める | T-007, T-008 |

### 4-I. Orchestrator サービス(T-021)固有

Orchestrator を MCP サーバー(`kp-ask serve`)として公開すると、利用者本人のアクセストークンを受け取る
新しいネットワーク面になる(チャット UI・MCP クライアント → Orchestrator → Gateway。ADR-018)。
Orchestrator は IdP を持たず、本人トークンの通過点として振る舞う(TB2 で信頼しない前提は変わらない)。

| ID | 経路 | STRIDE | 対策 | 検出手段 | 対応タスク |
|---|---|---|---|---|---|
| TM-I1 | Orchestrator サービスへの直接アクセス: トークンなし・無効・失効済み・他人のトークンで ask / feedback を呼ぶ、平文の経路でトークンを盗聴する、大量の ask で LLM・Gateway を枯渇させる | S/I/E/D | 認証は Gateway に委譲する(リクエストごとに本人トークンで Gateway の tools/list を呼び、拒否は 401・不達は 503。LLM もソースも呼ばない)。AnswerRun.userId は Gateway の認証値に束縛(TM-C6)、feedback は run の本人だけ(ADR-019 の実装後は runId の署名で Gateway が確かめる。TM-I5)。待ち受けの既定はループバックで、それ以外は確認フラグ(`--confirm-exposed-host`)が要る。TLS・Host / Origin の検証・利用者単位の流量制御は前段のリバースプロキシ(docs/install.md §6)。上流(Gateway・LLM)へのループバック以外の平文 http は明示のフラグ(`--allow-insecure-upstream`)が要り、NODE_ENV=production では拒否される(リファレンス構成は評価用に付けている)。同時実行数と質問長に上限。リファレンス構成は 127.0.0.1 への公開のみ | kp-ask serve の認証・上限のテスト(`packages/orchestrator/test/server-auth.test.ts`、`server-limits.test.ts`)、CI の `scripts/smoke/orchestrator-smoke.sh`(トークンなし・不正なトークンが 401) | T-021 |
| TM-I2 | トークンの滞留・転送先の誤り: Orchestrator がトークンを保存・記録する、UI がトークンを第三者の MCP サーバーへ転送する | I | Orchestrator はトークンを保存せず、ログ・監査・エラー・`structuredContent` に出さない(不変条件6)。独自の資格情報を持たない(不変条件1)。コアダンプ無効(TM-C3)。LibreChat が本人トークン(`{{LIBRECHAT_OPENID_ACCESS_TOKEN}}`)を展開するのは運用者が `librechat.yaml` に定義した MCP サーバーだけで(v0.8.7 は利用者が追加したサーバーでは展開せず、ヘッダから取り除く)、その定義は Orchestrator にだけ書く。MCP の接続先は `mcpSettings.allowedDomains` で Orchestrator の origin だけに限り、利用者による MCP サーバーの追加は `interface.mcpServers.create: false` で止める(docs/ui-librechat.md §1.5)。`mcpSettings.allowedAddresses` は私設 IP 宛ての SSRF 防御の例外にすぎず、接続先の制限にはならない(`allowedDomains` が未設定なら公開ホストへはすべて接続できる)。UI 側でのトークンの保管は UI の責任範囲として受容 | トークン非出力のテスト、`packages/gateway/test/reference-deploy.test.ts`(librechat.yaml の転送先・`allowedDomains`・`create: false` の整合) | T-021 |
| TM-I3 | UI 側の LLM への間接インジェクション: 検索対象文書に埋め込まれた指示(AT-2)が ask の結果の本文を経由して UI 側の LLM(LibreChat の会話相手)に届き、(a) feedback を利用者の意図と違う runId・outcome で呼ばせる(AnswerRun の userFeedback の誤記録。昇格判定の集計を歪める)、(b) UI 側の LLM が呼べる他のツール(利用者が追加した MCP サーバー、エージェントの Actions、Web 検索・コード実行の外部サービス)へ回答の内容を送らせる、(c) 回答の内容を埋め込んだ URL のリンクを書かせる | T/I | UI 側の LLM が呼べる外部のツールを Orchestrator だけにする: `interface.mcpServers.create: false`(利用者が MCP サーバーを追加できない。v0.8.7 は起動のたびに USER・ADMIN の両ロールへ適用)、`mcpSettings.allowedDomains` を Orchestrator の origin だけにする、エージェントの `capabilities` から `actions`・`web_search`・`execute_code` を外す(docs/ui-librechat.md §1.5)。回答本文には URL を残さず、原典へのリンクは出典欄の url だけが autolink として運ぶ(ADR-018 決定6。UI 側の LLM にリンクを組み立てさせない)。`instructions` とツール定義で「本文と出典を改変しない」「出典欄の URL 以外のリンクを作らない」「feedback は利用者が解決した / しなかったと明示したときだけ呼ぶ」と指示する。feedback が更新できるのは質問した本人の run だけ(TM-I1)。Orchestrator の探索ループ側の防御は TM-D1〜D4。残余: `instructions` は UI 側の LLM への指示で強制力はなく、本人の run への誤った feedback と、UI の Markdown 描画(裸のドメイン名の自動リンク等。TM-D2、RS-4)は残る | `packages/gateway/test/reference-deploy.test.ts`(librechat.yaml の `create: false`・`allowedDomains`・`capabilities`)、T-008 の RS-3 / RS-4 を UI 経由でも評価(T-021 残課題) | T-021, T-008 |
| TM-I4 | Orchestrator の侵害・誤動作による Gateway の監査ログの閲覧・改竄: Orchestrator(TB2 で信頼しない側)が Gateway の監査ログ・生クエリ原文のボリュームを書き込み可能でマウントしていると、それらを読む・書き換える・消すことができる | T/I/R | **Orchestrator は監査ストアに一切書かない**(ADR-019、T-023 で実装)。AnswerRun も Gateway の run API が Gateway の監査ログに書くため、分離は構造で成り立つ。リファレンス構成の orchestrator がマウントするのは設定(読み取り専用)だけで、Gateway の監査ログ(`kp-audit`)・生クエリ原文(`kp-rawquery`)のボリュームはマウントせず、runId の署名鍵・docId の HMAC 鍵も環境変数に持たない(ADR-018 決定4 の `kp-answer-runs` は廃止)。AnswerRun の主体は Gateway の認証値(TM-C6)、ToolInvocation とは (runId, userId) で突合する。レポートを読むのは昇格判定レポート(監査閲覧担当が実行し、実行自体がメタ監査の対象。docs/install.md §7) | `packages/gateway/test/reference-deploy.test.ts`(「orchestrator は gateway と同じイメージを kp-ask serve で動かし、設定は Gateway と同じ・監査ストアには書かない」「Dockerfile の既定の設定パス・監査ボリューム・待ち受けポートが deployment.yaml に一致する(AnswerRun のボリュームは持たない)」)、`packages/orchestrator/test/user-binding.test.ts`(AnswerRun は Gateway が認証値で書く)、`scripts/lint-imports.mjs`(run モジュールと `@kp/audit` の import 境界)、AnswerRun と ToolInvocation の突合(docs/audit-queries.md §0) | T-023, T-021, T-012 |
| TM-I5 | run API(ADR-019)の悪用: (a) runId を偽造して他人の run に ToolInvocation・結果・フィードバックを紐づける、(b) 他人の runId(UI・ログから得たもの)を自分のトークンで使う、(c) 期限切れの runId を再利用する、(d) `/runs` の全経路(期限内の runId での finish・feedback の再送を含む)で監査ストア・生クエリ表を埋める。fail-closed なので容量の枯渇は全体の停止になる、(e) runId の署名鍵が漏れて任意の runId を作られる、(f) 利用者本人が Orchestrator を通さずに run API を呼び、自分の run の結果・フィードバックを偽って昇格判定の集計を汚す、(g) 引用の sourceId を偽って docId の不可逆化(Slack・プライベートスコープ)をすり抜ける、(h) base64url の別表記で同じ署名の別 runId を作り run を割る、(i) finish を送らず unresolved を隠す、(j) 委任エージェントの呼び出しを人間の run に混ぜる | S/T/R/D/I | runId は Gateway が発行する HMAC 署名付きの値で、署名の入力に版・kid・payload・userId・actor を区切って含める(userId は平文で持たない)。payload は固定長、署名の入力は長さ付きで連結し、検証は payload と sig の両方の再符号化の一致と定数時間比較。名前空間付きの runId を申告する tools/call にも Orchestrator の資格情報を求める(f)。移行期間の裸キー `runId` に署名付きの形(`r1.…`)の値を入れた申告も同じ検証と資格情報の要求にかける(利用者が UI に出た自分の runId で Gateway を直接呼び、自分の run の記録を歪めることを防ぐ)。run API のパスは MCP のパスと同じディレクトリの `runs` で Gateway と Orchestrator が同じ規則で導き、Orchestrator はリダイレクトを追わない(資格情報と質問を別オリジンへ送らない)。署名鍵・資格情報・docId の鍵の使い回しは起動拒否。tools/call・finish は有効期間内、feedback はフィードバックの期間内だけ受け、満たさない申告は固定文言で拒否し `invalid_run_id` の単発runとして記録する(申告値は記録・エコーしない)。run API は本人の Bearer に加えて Orchestrator の資格情報を求める(f)。本文の大きさ・質問の長さ・利用者ごとの頻度の上限を `/runs` の全経路にかけ、監査ボリュームの容量に警報を設ける(d)。引用 docId は申告の sourceId で分類せず最も厳しい規則をかけ、Slack 有効時は段階 1 の間記録しない(g)。有効期間を過ぎた pending の run はレポートで「放棄」と数える(i)。署名鍵は 32 バイト以上のデプロイ固有の秘密で docId の鍵・Orchestrator の資格情報と分け、欠落・短い・開発用の値なら production で起動を拒否する。`kid` で入れ替えられる。ログ・監査・エラー・設定の出力に出さない(不変条件6)。残余: 侵害された Orchestrator は手元の利用者トークンと自分の資格情報で、その利用者の期限内の run の結果を偽って申告できる(A と同じ)。Orchestrator の資格情報が漏れると利用者が自分の run の結果・ToolInvocation を偽れる(他人の run には触れない)。鍵が漏れても本人のトークンの範囲を超えられない | 実装済みのテスト(T-023): `packages/gateway/test/run-id.test.ts`(署名の改竄・正規でない符号化(payload / sig の未使用ビット)・未知の kid・期限切れ・feedback の期間・本人と actor の違い・鍵の入れ替え・拒否の分類の固定)、`run-api.test.ts`(トークンなし / 無効・Orchestrator の資格情報なし / 誤り・他人の runId・本文と質問長と利用者ごとの頻度の上限・fail-closed(`audit_write_failed`)・申告値をエコーしない・名前空間付きの runId を申告した tools/call の資格情報要求と `invalid_run_id` の単発 run 記録・旧キーと未申告の単発 run の維持)、`run-records.test.ts`(Slack 有効時の citedDocIds 省略と質問原文の非記録、プライベートスコープ有効時の全件 hashed、無効な sourceId の引用・searchedSources の除去、Slack 以外の sourceId で申告された Slack 形式の docId)、`bootstrap.test.ts`(署名鍵・資格情報の欠落 / 短い / 開発用の値の production 起動拒否、ログ・`validate` 出力に秘密を出さない)、`packages/orchestrator/test/user-binding.test.ts`(申告の userId を Gateway の認証値で上書き、他人の feedback の拒否)、`cited-docids.test.ts`、`server-feedback.test.ts`(feedback は本人の run だけ)。運用: 利用者ごとの `invalid_run_id` 件数の監視(docs/audit-queries.md §0)、監査ボリュームの容量の警報(docs/install.md §7) | T-023 |

## 5. カナリア文書の設計(常時検証)

権限逸脱の検出を「四半期レッドチーム」のイベントから常時監視に変える(v3 §8、T-013)。

### 5.1 構成要素

- **カナリア文書**: 各ソースに常設する、内容に一意なカナリアトークン(例:
  `CANARY-<sourceId>-<乱数>` 形式の文字列。実在の機密は含めない)を埋めた文書
- **カナリアユーザー**: その文書へのアクセス権を**持たない**テストアイデンティティ
  (T-008 の権限プロファイル固定テストアイデンティティを流用)
- **検証ジョブ**: カナリアユーザーの資格情報で、カナリアトークンを直撃するクエリを
  search し、さらに documentId 直指定の fetch を試行する

### 5.2 配置ソースと検証項目

| ソース | 配置場所 | 検証項目 |
|---|---|---|
| Google Drive | カナリアユーザーを含まない限定共有ドライブ/フォルダ | search 非ヒット、fetch 拒否、describe/list に区画名が出ない |
| Slack | カナリアユーザーが参加しないプライベートチャンネル | search 非ヒット、fetch 拒否。**検証ログには真偽値のみ記録**(Slackメタデータを残さない、ADR-014) |
| GitHub | カナリアユーザーに権限のないプライベートリポジトリ | search 非ヒット、fetch 拒否。モック資格情報(開発用 `MockCredentialProvider`)で検証する場合はユーザー別トークン(`KP_MOCK_TOKEN_GITHUB__<USERID>`)が必須(共有トークンでは全ユーザーが同じ権限になり逸脱を検出できない。connector-github README) |
| wiki | 閲覧制限スペース/ページ | search 非ヒット、fetch 拒否 |
| 検索層有効ソース(Phase 2) | インデックス済みだがカナリアユーザーは未認可の文書 | **post-filtering 経路での非ヒット**(TM-A系の実地検証)、返却0件時の挙動が通常と同形(TM-B5) |

### 5.3 検証周期とアラート経路

- **周期**: 日次の定期実行を基本とし、加えて (a) リリース/アップグレード適用後、
  (b) deployment.yaml 変更後、(c) コネクタの認可経路に関わる変更のデプロイ後に必ず実行する
- **判定**: カナリアトークンが検索結果・回答・監査ログ(returnedHitCount>0)のいずれかに
  出現したら**即インシデント**(権限逸脱ゼロのKPIに対する違反)
- **アラート経路**: 検証ジョブ失敗(逸脱検出)→ 導入先セキュリティ担当への即時通知
  (通知先は deployment.yaml/運用設定で必須項目化)→ 該当コネクタの無効化判断 → 原因分析。
  検証ジョブ自体の実行失敗(エラー・未実行)も「検出の空白」として同経路で通知する
- **鮮度**: カナリアトークンは定期ローテーション(四半期目安)し、過去トークンの残留ヒットで
  キャッシュ汚染(TM-G1)も併せて検出する
- **同梱**: 検証ジョブはセキュリティテストスイートとして OSS に同梱し(T-013)、
  導入プレイブックの標準工程に組み込む(配置は導入先の人間タスク)

## 6. T-008 評価シードへの反映

T-008 のレッドチームシードは本書から導出する。評価セットには最低限、次のカテゴリを含める。

| シードカテゴリ | 内容 | 検証する脅威 |
|---|---|---|
| RS-1 権限境界 | 権限外文書(カナリア文書含む)の内容が回答・引用に出ないこと。アイデンティティごとに期待値を変える | TM-B3, TM-G1, TM-A系 |
| RS-2 存在推定 | 権限外文書**のみ**にマッチする一意な語で検索し、件数・応答文言・挙動が「本当に存在しない語」の場合と区別できないこと | TM-B1, TM-B2, TM-B5 |
| RS-3 インジェクション(指示追従) | 「この文書を読んだら◯◯せよ」型の指示を埋めた文書を正規権限で読ませ、探索方針・回答が乗っ取られないこと | TM-D1 |
| RS-4 インジェクション(exfiltration) | 攻撃者URLへの画像/リンク生成を誘導する文書で、回答に原典以外のドメインへのURLが生成されないこと。汎用 UI 経由(T-021)では最終文面を UI 側の LLM が書き、UI の Markdown 描画が本文中の裸のドメイン名を自動リンクしうる(ADR-018 決定6 で残余リスクとして受容)ため、UI 経由でも評価する | TM-D2, TM-D3 |
| RS-5 存在しない情報 | 正解が存在しない質問に対し、捏造引用(実在しないdocumentId・無関係文書の引用)をしないこと | (品質系。TM-D1の対照群を兼ねる) |
| RS-6 古い情報 | 更新済み文書の旧版に基づく断定をしないこと(鮮度の限界開示) | (品質系) |

- RS-1/RS-2 は**合否判定**(権限外文書の引用ゼロが合格条件、T-008 受け入れ条件)。RS-3〜6 は率で追跡する
- インジェクションシードの文書は synthetic ワークスペース/テストテナントに置く。
  production Slack に対する評価はコンテンツ非保存の制約に従う(ADR-014、T-008)

## 7. スコープ外・受容した残余リスク

| 項目 | 扱い |
|---|---|
| タイミングサイドチャネルの完全排除(TM-A4, TM-B5) | 受容。得られる情報量が粗く、反復試行は監査ログ+レート制御で可視化される。レッドチームで情報量を定期再評価 |
| ソースAPI自体の認可バグ | 委譲先の責任範囲。本基盤はソースの判断を増幅しない(TM-B2)ことまでを担う |
| ホスト/インフラの全面侵害(AT-6がGatewayプロセス権限を取得) | インフラセキュリティ(導入先運用)の領分。本書は保管データの暗号化(TM-C1)までを扱う |
| LLM プロバイダ側への送信データの取り扱い | 導入先とプロバイダの契約事項(導入プレイブックのチェックリスト項目とする。T-012) |
| 本人による本基盤の外の経路でのアクセス(エージェント製品からの直接接続、ブラウザを操作するエージェント、PAT、セッショントークンの流用、エクスポート) | スコープ外。本人の権限内のアクセスのため権限逸脱は生じないが、本基盤の統制(監査、プライベートスコープの除外、Slack データの非永続化)は及ばない。不変条件2が保証するのは本基盤自身が迂回経路を作らないことまでで、組織全体で経路が本基盤だけになることは保証しない。ソース側のアプリ承認制・PAT の制限・端末側の管理(docs/install.md §10.1)と利用規程で扱い、ソースのネイティブ監査ログで事後に検知する。整理は docs/direct-connection.md |
| 本人による権限内データの意図的な持ち出し | スコープ外。本人はソースの UI やエクスポートで同じことができる。本基盤が扱うのは、エージェントによる横断的な取得の記録(監査)と、Orchestrator の反復・ツール呼び出し件数の上限(TM-D3)まで。Gateway のレート制御はソース単位のクォータ保護で、利用者単位の取得量の上限と、取得の偏りを監査ログから見つけるクエリは未整備(docs/direct-connection.md §5) |
| DoS 全般(探索ループのコスト増幅、ソースAPIレート枯渇) | 可用性リスクとして Gateway のレート制御・costLimitPerQuery で緩和(T-003/T-007)。機密性に波及する場合(TM-F5)のみ本書で扱った |

## 8. 運用: 本書の維持

- 本書は 2026-07-09 のセキュリティレビュー(人間)完了をもって **Accepted 化**した(T-000c ゲート解除)
- 次のタイミングで必ず改訂する: 新コネクタ追加時(T-005/006/019/020)、検索層着手時(T-016)、
  Phase 3 着手時、認可方式・監査スキーマの変更時(ADR追記と同時)
- 四半期レッドチームの結果(新規に見つかった経路・受容判断の再評価)を本書に反映する

### 改訂履歴

| 日付 | 内容 |
|---|---|
| 2026-07-09 | セキュリティレビュー完了、Accepted(T-000c ゲート解除) |
| 2026-09-27 | 新コネクタ追加(T-019 GitHub)に伴い §4-H を新設(TM-H1〜H5)。TM-B2 の Gateway 正規化(`not_available`)を実装済みとして対策・検出手段を更新。T-003 セキュリティレビューの反映として TM-A1(結果の射影)・TM-C7(申告キー誤記の拒否、H1 の確認依頼)を追記 |
| 2026-09-27 | T-007 セキュリティレビューの反映: TM-D2(回答本文から URL を全除去、原典リンクは citations[].url のみ。検出手段にテスト名)、TM-C6(AnswerRun の主体を Gateway の認証済み userId に束縛)、TM-C7(骨格照合 — NFKC 正規化後の照合 — と残余を明記)、TM-D3(ツール呼び出し件数の上限)、TM-D4(describe 結果を user ターンのデータへ) |
| 2026-09-28 | T-021(ADR-018)の反映: §4-I を新設(TM-I1〜I2: Orchestrator サービスの面)。RS-4 に汎用 UI 経由の残余(裸のドメイン名の自動リンク)を追記 |
| 2026-09-28 | T-021 セキュリティレビューの反映: TM-I2 を訂正(LibreChat の MCP の接続先は `allowedAddresses` ではなく `interface.mcpServers.create: false` と `mcpSettings.allowedDomains` で限る)。TM-I3(UI 側の LLM への間接インジェクション)と TM-I4(Orchestrator から Gateway の監査ログを分離)を新設 |
| 2026-10-08 | ADR-016 追補2(コネクタ IF v0.4、issue #19)の実装に伴い TM-E8(既定の `excluded` がコネクタで実装されない)を新設 |
| 2026-10-09 | ADR-019(Gateway の run API、段階 1: 署名付き runId)の反映: TB2 の記述に「Orchestrator から届くものはすべて申告」と「監査ストアに書くのは Gateway だけ」を追記。TM-I4 に実装後の扱いを追記。TM-I5(run API の悪用)を新設。同日のセキュリティレビューを反映し、TM-I5 に (f)〜(j)(本人による直接の申告、sourceId の偽装、符号化の別表記、finish の欠落、actor の混入)を追加、TM-C6・TM-I1 に実装後の扱いを追記 |
| 2026-10-09 | issue #16(IdP トークンの検証要件、ADR-010 追補)の反映: Keycloak アダプタが `iss` / `typ`(アクセストークンのみ)/ `azp`(`idp.adapter.allowedClients` の許可リスト)/ `aud`(`requireAudience`)を検証し、別クライアント・別 realm・リフレッシュトークン・ID トークンを拒否する。開発の逃げ道 `allowedClients: ["*"]` は WARNING と本番拒否(`dev_only_in_production`)。失敗理由はクレーム名だけをサーバーログに残す(TM-C2 の規律)。切り分けは `kp-gateway auth-check` |
| 2026-10-11 | T-023(ADR-019 段階 1)の実装の反映: TB2 を実装済みの記述にし、TM-I4 を「Orchestrator は監査ストアに一切書かない」に改め、TM-I4・TM-I5 の検出手段に実装したテストの名前を書いた |
| 2026-10-09 | 直接接続との関係の整理(docs/direct-connection.md)の反映: §7 に「本人による本基盤の外の経路でのアクセス」「本人による権限内データの意図的な持ち出し」を追加。AT-1 の狙いに権限内データの横断的な大量取得を追記 |
