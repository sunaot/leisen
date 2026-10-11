# 設計診断: leisen のアーキテクチャと拡張性・保守性の課題

Status: 診断メモ(設計判断ではない。決定は ADR を正とする)/ Date: 2026-10-11 / 対象: main `cca3584`

手順は design-diagnosis スキルに従った。材料は product-design v1〜v3、ADR-001〜019、threat-model、install、backlog、5 観点レビューの open issue(#15〜#45)、および `packages/*/src` の全ファイル(テストを除く約 22,000 行)。本文の行番号は `cca3584` 時点。

**観測と仮定の区別**: 「観測」は本セッションで実際に確かめたもの(ビルド・全テストの実行、grep、ファイルの読み取り)。「仮定」は §5 にまとめた。

---

## 1. 本来の姿

### 1.1 守るべき性質

product-design の 4 原則と CLAUDE.md の不変条件から、構造に効く性質として次の 6 つを置く。各性質の理由は「何が変わったときに、直す場所が小さくて済むか」の形で書く。

| # | 性質 | 何が変わったとき、どこだけ直せばよいか |
|---|---|---|
| P1 | 認可はソースに委譲し、資格情報は本人のもの(不変条件1、ADR-010) | ソースの認可方式が変わったとき、その Auth Adapter だけ |
| P2 | ソースアクセスと run の事象は Gateway だけが記録する(不変条件2、ADR-019) | 監査の形式・出力先が変わったとき、監査モジュールと sink だけ。書き手が増えない |
| P3 | 導入差分は deployment.yaml と差し替え口でのみ吸収し、コアに個社分岐を入れない(ADR-005、不変条件8・9) | 2 社目が別の IdP・ソース・監査先を使うとき、設定 1 枚と差し替え口の実装 1 つだけ |
| P4 | 境界の非流出: 未認可候補・Slack 由来データ・秘密情報は、それぞれの境界(TB5 / 永続化層 / ログ)を越えない(不変条件3・6・7) | 新しいソースや出力先を足したとき、境界の型と Gateway の強制だけが守る。各実装者の注意に頼らない |
| P5 | 可動部品は最小で、外部依存(MCP SDK、LLM SDK、チャット UI)は差し替え可能(原則2、ADR-001 追補2、ADR-017) | SDK の版や UI 製品が変わったとき、接合層のファイルだけ |
| P6 | スキーマ(設定・監査・コネクタ IF)は版を持ち、旧版から移行できる(v2 §2.5) | OSS の各社が別々の版で動いていても、アップグレードは移行関数の追加だけ |

評価しなかった特性のうち、この系で要るかどうかを材料から決められないものは §2 の「性質についての問い」に回した(複数レプリカ、配布単位の分離)。

### 1.2 部品ごとの責務と知識

意図(ADR-005、ADR-019 決定10、threat-model §1)から書く。現在の実装は脇に置く。

| 部品 | 責務(一文) | 知っていること | 知らなくてよいこと |
|---|---|---|---|
| Connector SDK | コネクタが実装する契約と、全コネクタが共有する部品を提供する | ツール IF(search / fetch / list / describe)、AuthContext、scope / policy、factory 契約、エラー分類 | Gateway の設定、MCP、監査 |
| Connector | ソース API を本人の資格情報で呼び、結果を IF に写す | 自ソースの API、自分の settings、導入単位の policy | deployment.yaml 全体、監査、MCP、Gateway の存在 |
| IdP Adapter | セッショントークンを検証し、ソース別の本人資格情報を得る | IdP のプロトコル、Token Vault | コネクタの中身、監査、MCP |
| 中核モデル | 複数の部品が共有する型と規約を定義する(監査スキーマ、deployment.yaml スキーマ、`_meta` の鍵、エラーコード、ツール名) | スキーマの版 | どの実装がどの鍵を読むか、MCP SDK、IdP |
| Gateway | 認証を委譲し、資格情報を注入し、結果を射影・強制し、全事象を記録する | 中核モデル、IdP Adapter IF、Connector IF、run API | LLM、プロンプト、UI、Orchestrator の内部 |
| Orchestrator | 探索ループを回し、出典を検証し、本文を無害化し、run を申告する | Gateway のツール面と run API、LLM IF、`_meta` の規約、自分が申告する監査事象の形 | 監査ストア、IdP、deployment.yaml の IdP・コネクタの詳細 |
| 昇格判定レポート | 監査レコードを集計する | 監査スキーマ、ソースの性質(SourceProfile) | Gateway の実装、MCP |
| 組み立て役(bootstrap) | 設定から部品を生成して配線する。**全部を知る唯一の場所** | 上の全部 | — |
| UI(LibreChat / MCP クライアント) | 利用者と Orchestrator の MCP 面をつなぐ | Orchestrator の `ask` / `feedback` | Gateway、ソース |

責務の文に「と」が入る部品は Gateway だけで、これは意図どおり(単一経路の要)。ただし「射影・強制」と「記録」は ADR-019 決定10 が別モジュールに分けると決めている。

---

## 2. 性質についての問い

答えによって §4 の案の形が変わるものだけ。

| # | 問い | 答えがこうなら案はこう変わる |
|---|---|---|
| Q1 | IdP Adapter・監査 sink・資格情報方式・LLM バックエンドを、Connector と同じ**動的ロード**にするか、**コア内の列挙**のままにするか(#23 の A / B / C) | 列挙のままなら、ADR-005 の文言修正と「追加箇所を 1 か所にする registry 化」で足りる。動的ロードなら、供給網の方針(#32)と任意コード実行の範囲をセットで決める必要がある |
| Q2 | Orchestrator を Gateway と**別の配布単位**(別イメージ・別 npm パッケージ)にするか。ADR-019 決定2 は別プロセス(α)まで決め、配布は未決 | 別にするなら中核モデルの切り出し(§4 S1)が必須で、T-023 より前。同じイメージを受け入れるなら ADR-019 決定10 の `@kp/audit` だけで当面足りる |
| Q3 | v1.0 で Gateway の**複数レプリカ**を要件にするか。ADR-001 追補3 は「ステートレス」を約束するが、docs/install.md は監査バッファ・JSONL・プロセス内レート制御のため単一レプリカを必須としている | 要件にするなら、監査 sink とレート制御の共有ストア化(ADR-019 決定9 の S2)が今の構造決定に入る。しないなら「単一レプリカ」を性質として MODEL に明記し、ステートレスの約束を「リクエスト間の利用者状態を持たない」に限定して書き直す |
| Q4 | deployment.yaml を **Orchestrator の設定の唯一の出所**にするか(LLM バックエンド、Gateway の URL、鍵の環境変数名まで)。ADR-017 帰結と #23 は「後続タスク」のまま | するなら設定スキーマを中核モデルに置き、`kp-ask` のフラグは上書きに限る。しないなら「導入支援エンジニアが触るのはこのファイルだけ」(v2 §2.1)の約束を Orchestrator について撤回する |
| Q5 | 探索ループの会話の内部表現を **Anthropic SDK の型**のままにするか(ADR-017 決定1) | 3 つ目のバックエンドを予定するなら中立の正準形に変える価値がある。2 つで止めるなら現状(875 行の翻訳層)を受け入れる |

---

## 3. 診断

### 3.1 判定

**構造の問題である。** 原因が一か所に閉じた不具合ではない。以下のずれは独立した 13 件に見えるが、§3.3 の 4 つの根に束ねられる。

### 3.2 ずれの一覧

各項目に、どの性質とのずれか、どの境界で起きているか、既知の issue との対応を付ける。

**D1. 依存の向きが逆: 中核モデルが Gateway の実装パッケージに埋まっている(P3・P5、#33)**
- 観測: `@kp/orchestrator` と `@kp/promotion-report` は `@kp/gateway` に依存し、`packages/gateway/src/index.ts:1-6` は audit / config / idp / proxy / bootstrap / dev の `export *`。`package.json` に `exports` マップはない。
- 帰結: 監査スキーマだけが欲しいレポートも、TB2 で信頼しない側の Orchestrator も、MCP SDK・IdP 実装・起動コード・開発用コネクタまで実行時にロードする。`createGatewayMcpServer(): Server`(`proxy/mcp.ts:166`)が公開面にあるため、MCP SDK v1 の型が `@kp/gateway` の公開 IF の一部になっている(v2 移行で公開面が変わる)。
- ADR-019 決定10 は `@kp/audit` の切り出しを決めているが、設定スキーマと `_meta` の規約は対象外のまま。

**D2. 差し替え口が Connector だけ開いていて、他は閉じた列挙(P3、#23)**
- 観測: Connector は 3 段の registry(プログラム登録 → 組み込み → `import("@kp/connector-<kind>")`、`bootstrap/plugins.ts:158-232`)。IdP は `discriminatedUnion` + `switch`(`config/schema.ts:228-284`、`idp/factory.ts:43-77`、`config/loader.ts:98-132`)、監査 sink は if 連鎖(`bootstrap/audit.ts:95-116`)、資格情報方式は 1 要素の enum(`schema.ts:175`)、LLM は 2 要素の switch(`orchestrator/src/llm/factory.ts:33-47`)。
- 観測: IdP を 1 つ足すのに 6〜9 か所、sink で 5〜8 か所、LLM で 5 ファイル。`factory.ts:3-5` と `schema.ts:224-225` のコメント「kind の追加はコア改変を要しない」は実態と違う。
- 2 社目(Okta / Entra ID)で P3 が破れる。

**D3. 組み立て役が複数あり、同じ知識が重複して漂流している(組み立て役は 1 つという §1.2 とのずれ)**
- Gateway 側: `assembleGateway`(`bootstrap/assemble.ts:187-382`、196 行)が組み立て役だが、`cli/run.ts:256-306` が開発専用部品の一覧を別に持ち、`config/validate.ts:21-73` の `ConfigIssueCode` は bootstrap しか出さないコードを含み、`proxy/gateway.ts:137` はコンストラクタで設定を再検証する。開発専用判定 `assertNotProduction` は `idp/mock.ts:18` に住み、監査 sink やコネクタの拒否でも `IdpError` を投げる(6 ファイルから呼ばれる)。
- Orchestrator 側: `bin/kp-ask.ts:463-512` と `bin/serve.ts:434-516` が composition root を二重に持つ。**既に漂流している**: deployment.yaml の `orchestrator` 節を読むのは serve だけ(`serve.ts:340-347`)、Slack 有効時の起動拒否と Gateway とのソース照合も serve だけ。同じ deployment.yaml で `kp-ask` と `kp-ask serve` の maxIterations が違いうる。
- 漂流は「組み立て役が 2 つあると起きる」ことの実証で、§4 の案の根拠になる。

**D4. 設定の出所が 2 系統で、読み手のない設定がある(P3、#23)**
- 観測: Orchestrator の LLM・Gateway URL・HMAC 鍵・AnswerRun の出力先は CLI フラグと環境変数(`bin/llm-options.ts`、`bin/upstream-options.ts`)。deployment.yaml の `chatHistory` は読み手がない。`connectors[].searchLayer.backend` / `authzCacheTtlSec` も読み手がない(検証だけ)。`retentionConfigFrom`(`config/loader.ts:135`)は export されているが src に呼び手がなく、保持期間の削除が起動コードに配線されていない。
- v2 §2.1「導入支援エンジニアが触るのはこのファイルだけ」の約束と実装がずれている。

**D5. 「ソースの性質」が概念として存在しない(P4、#22)**
- 観測: Slack 判定は kind の前方一致(`orchestrator/src/audit.ts`)、レポートは手書き `sources.json`、Gateway の `audit/docid.ts:31` のコメントは「Gateway が判定する」と書くが未実装。反例: kind が `rts-chat` のプラグインは Slack と判定されない(#22 で再現済み)。
- ADR-019 決定5「申告された sourceId に頼らず、全件に最も厳しい規則をかける」は、この概念がないことへの安全側の回避策で、症状(引用の集計が減る)を残す。

**D6. Connector SDK が型だけで、コネクタの共通部品がない(P4・P3)**
- 観測: `connector-sdk/src/index.ts` は 313 行でほぼ型。connector-github の約半分は汎用の配管(cursor の base64url、surrogate-safe の切り詰め、bearer 資格情報の前検査、HTTP ステータス→エラー分類、settings 検証、`isRecord`)。
- 観測: その配管は既に `gateway/src/dev/fixture-connector.ts` に 2 度目のコピーがあり、**漂流している**(`expiresAt <= 0` の扱い、非 bearer の資格情報に `permission_denied` を返すか `invalid_request` を返すか)。Gateway 自身の snippet 切り詰め(`proxy/gateway.ts:508-512`)は `slice` で、コネクタ側と違い surrogate-safe でない。
- 観測: factory 契約 `ConnectorFactoryInit` は Gateway(`plugins.ts:61-73`)と GitHub(`connector-github/src/index.ts:32-44`)で二重定義され、optional の有無が既に違う。
- 観測: `redactAuthContext()`(不変条件6 の標準手段)は src のどこからも呼ばれていない。契約テストキットは SDK から export されていない。
- T-005 / T-006 / T-020 で 3〜5 回目のコピーになる。

**D7. 探索ループが 1 ファイルに 14 責務、Anthropic 型が正準(P5)**
- 観測: `orchestrator.ts`(1,336 行)は入力検証、run の寿命、利用者束縛、プロンプト組み立て、ループ、LLM 呼び出し、ツール計画、Gateway 送信、出典検証、回答組み立て、監査書き込み、フィードバック、2 種のエラー写像、固定文言を持つ。`server/tools.ts:442-472` は利用者束縛を再実装している。
- 観測: 会話の内部表現が `Anthropic.*` 型(16 か所)であるため `llm/openai-compatible.ts`(875 行)はほぼ翻訳層。プロンプトの版は定数(`prompt.ts:34`)、制御メッセージ(催促・最終ターン)は版の外にある。
- CLAUDE.md は LLM を「設定で選ぶプラグイン境界」と書くが、閉じた 2 択。

**D8. 監査ストアの版と単一レプリカ前提(P6・Q3、#30・#25・#26)**
- 観測: 監査レコードに `schemaVersion` がなく、`strictObject` で読むため、片側に欄を足すだけで旧ログが読めなくなる。整合は `"@kp/gateway": "0.1.0"` の exact 固定だけで保たれている。
- 観測: JSONL の sink ロジック(0600、改行の復旧、直列化キュー)が `gateway/src/audit/jsonl.ts` と `orchestrator/src/server/answer-run-jsonl.ts` にコピーされている(ADR-019 で後者は廃止予定)。レート制御はプロセス内の固定窓。

**D9. 不変条件の機械的強制が、Claude Code のセッション内にしかない(P4)**
- 観測: `.claude/settings.json` の hook は `scripts/guard/*.sh` を呼ぶが、CI(`.github/workflows/ci.yml`)は `npm ci && npm run build && npm test` と e2e だけで、guard は走らない。ESLint / Biome の設定はない。ADR-019 決定10 は「lint の import 制限で機械的に検査する」と書くが、lint 基盤が存在しない。
- post-edit.sh の `JSON.stringify(auth|authContext|credential` は変数名に依存し、`ctx` やテンプレート文字列を通す。不変条件4・7 の機械的検査はない。
- 人間のレビューと Claude Code のセッションが強制の実体で、OSS 化後に外部コントリビュータが入ると効かない。

**D10. 1 イメージに 3 エントリポイント(TB2 の配布単位)**
- 観測: `deploy/Dockerfile` は Gateway・Orchestrator・レポートを同じイメージ・同じ `node_modules` に入れる。Gateway のイメージに `@anthropic-ai/sdk` が入り(ADR-018 帰結で明記)、workspace を足すたびに COPY 行を手で足す(コメントに過去の事故が残る)。
- TB2 を「別プロセス」に分けた意図が、配布単位では弱まる(Q2)。

**D11. 文書が真実の置き場で、追記連鎖になっている(保守性)**
- 観測: docs と README の合計は約 690 KB(コードは約 22,000 行)。ADR に 14 の「追記 / 追補」節、7 本の「→ ADR-xxx で置き換え」矢印。ADR-017・018 は Proposed のまま、一部だけ ADR-019 で確定した「部分的に生きている」状態。CLAUDE.md「現在のフェーズ」は 5,700 字の一段落。
- 帰結: 「いま何が決まっているか」を知るには ADR-001 → 追補3 → SDK 検証結果 → ADR-019 のように辿る必要がある。コード内コメントの陳腐化が既に複数(`plugins.ts:32-33`、`factory.ts:3-5`、`orchestrator/src/config.ts:8-12`、`orchestrator/README.md:465`)。docs/MODEL.md はない。
- これは Claude Code のセッションが文脈に載せられる量に直接効く。CLAUDE.md が長いほど、各セッションの既定が「読まれなかった部分」で決まる。

**D12. MCP SDK の接合が 3 か所に分かれ、HTTP の糊がコピーされている(P5)**
- 観測: Gateway の `proxy/mcp.ts` / `proxy/http.ts`、Orchestrator の `gateway/mcp-client.ts`、`server/http.ts` / `server/mcp.ts`。`server/http.ts:167-171` の `bearerToken` は `proxy/http.ts:100-104` の逐語コピーで、405 / healthz / `sendJson` も同型。v2 移行(スパイク済み)は 3 か所に同じ変更を要する。

**D13. 語彙のずれ(名前)**
- `@kp/gateway` は「製品」「組み立て役」「開発用コネクタ」「中核モデル」の 4 つを指す。`AuditLogger` を Orchestrator が持つが、ADR-019 後の Orchestrator は「記録者」ではなく「申告者」。`GatewaySession` はステートレスなのに session。`serve` が `kp-gateway serve` と `kp-ask serve` の両方にあり、片方は Gateway、片方は MCP サーバー化した Orchestrator。`kind` が Slack 判定・プラグイン名解決・開発専用判定の 3 つの用途を兼ねる。

### 3.3 根(4 つ)

| 根 | 束ねられるずれ | 一言 |
|---|---|---|
| R1 パッケージ境界が「責務」ではなく「作った順」で引かれた(T-001 → T-003 で全部 gateway に入れた) | D1, D4(一部), D6, D8, D10, D12 | 中核モデルと共通部品に置き場がない |
| R2 組み立て役が 1 つでない | D3, D4 | 同じ知識が 2〜4 か所に写され、既に漂流している |
| R3 差し替え口の設計が Connector で止まり、他は約束だけ | D2, D7(LLM) | ADR-005 の 3 境界のうち実装済みは 1 つ |
| R4 概念の欠落: SourceProfile、公開 API 面、「現在の真実」の置き場 | D5, D9, D11, D13 | 判定・強制・文書が、概念がないため分散している |

### 3.4 症状はずれそのものか、結果か

5 観点レビューの issue(#22, #23, #30, #33)は**ずれそのもの**を正しく指摘している。一方、次は**ずれの結果**であり、個別に直しても再発する:
- dev-fixture と connector-github の資格情報検査の漂流(R1 の結果)
- `kp-ask` と `kp-ask serve` の設定差(R2 の結果)
- ADR-019 決定5 の「全件に最も厳しい規則」(R4 の結果)
- コメントの陳腐化(R2・R4 の結果)

---

## 4. 案

### 4.1 対照: 症状を最も直接に消す案

issue ごとに個別対応する。#33 で `@kp/audit` を切り出す(ADR-019 決定10 で既決)、#23 でコメントと ADR-005 の文言を直す、#22 で SourceProfile を足す、#30 で `schemaVersion` を足す、dev-fixture の資格情報検査を GitHub に揃える、`kp-ask` に `settingsFromDeployment` を足す。

評価: 各修正は正しく、本来の姿と矛盾しない。**しかし R1・R2 に触れないため、次の 3 タスク(T-005 Drive、T-006 Slack、T-023 run API)で同じ種類のずれが 3 回目に出る。** dev-fixture の漂流が、コピーは必ず漂流することの証拠になっている。直接案は「構造案の前に着手できる小さい部分」として扱うのがよい。

### 4.2 構造案の導出

性質から順に導く。

1. P2・P4 により、Orchestrator は監査ストアと IdP を知ってはならない。**だから** Orchestrator が依存してよいのは「中核モデル(監査レコードの形、`_meta` の鍵、エラーコード)」と「Connector SDK の型」だけで、Gateway の実装パッケージに依存してはならない(→ S1)。
2. P6 により、スキーマは版を持ち、複数の実装から同じ定義を参照されなければならない。**だから** スキーマは実装パッケージの外に置く(→ S1)。
3. P3 により、2 社目の差分は設定 1 枚と差し替え口 1 つで済まなければならない。**だから** 差し替え口は種類ごとに「追加箇所が 1 か所」でなければならず、その 1 か所は組み立て役が持つ registry である(→ S2・S3)。
4. §1.2 の「全部を知る唯一の場所」は 1 つでなければならない。**だから** Gateway と Orchestrator それぞれに composition root を 1 つだけ置き、CLI・サーバーはそれを呼ぶ薄い入口にする(→ S2)。
5. P4 により、境界は各実装者の注意ではなく型と強制で守られなければならない。**だから** コネクタの共通部品(資格情報の前検査、切り詰め、cursor)と契約テストは SDK 側に 1 つだけ置き、不変条件の検査は CI で機械的に走らなければならない(→ S1・S6)。
6. P4 により、Slack 由来・プライベート領域の判定は 1 か所で導出されなければならない。**だから** SourceProfile を Gateway が deployment.yaml とコネクタの能力宣言から導出し、Orchestrator とレポートに配る(→ S4)。
7. 保守性(D11)により、次のセッションの既定は「開始時に文脈に載っているもの」で決まる。**だから** 現在の真実は 1 ファイル(MODEL)に置き、ADR は決定の履歴に戻す(→ S5)。

### 4.3 案の要素

**S1. パッケージ境界を責務で引き直す(R1)**
- `@kp/core-model`(名前は仮): 監査スキーマ(版付き)、deployment.yaml スキーマと移行、`_meta` の鍵、エラーコード、ツール名。依存は zod だけ。ADR-019 決定10 の `@kp/audit` を広げたもの。Gateway・Orchestrator・レポートはここから読む。
- `@kp/connector-sdk` に factory 契約(`ConnectorFactoryInit` / `ConnectorFactory`)と共通部品を移す。共通部品は型と分けて `@kp/connector-kit` としてもよい(cursor、surrogate-safe の切り詰め、bearer 前検査、HTTP ステータス→エラー分類、settings 検証、契約テストキット)。
- `dev-fixture` を `@kp/connector-dev-fixture` として gateway から出す。本番イメージと公開面から消える。
- `@kp/gateway` は `exports` マップで公開面を `assembleGateway` と組み立てに要る型に限り、`export *` の barrel をやめる。MCP SDK の型を公開面から外す。

**S2. 組み立て役を 1 つにする(R2)**
- Gateway: `assembleGateway` を唯一の組み立て役にし、`validate.ts` を「設定の純粋検証」と「組み立て時の検査(プラグインの能力照合、開発専用部品)」に分ける。開発専用判定 `DevOnlyPolicy` を 1 か所に置き、`idp/mock.ts` から出す。`cli/run.ts` は引数解釈と `assembleGateway` の呼び出しだけにする。
- Orchestrator: `composeOrchestrator(deploymentConfig, overrides)` を 1 つ作り、`kp-ask` と `kp-ask serve` の両方が呼ぶ。deployment.yaml を唯一の出所にし、フラグと環境変数は上書きに限る(Q4)。

**S3. 差し替え口の規約を ADR-005 改訂で 2 種類に分ける(R3)**
- 「動的プラグイン」(Connector、Q1 次第で IdP)と「コア内の列挙」(監査 sink、資格情報方式、LLM)を分けて書く。列挙側も `Map<kind, factory>` の registry にし、追加箇所を組み立て役の 1 行にする。コメントとガイドの「コア改変不要」を実態に合わせる。
- LLM バックエンドは CLAUDE.md の記述を「設定で選ぶ列挙」に直す(4 つ目の境界にするかは Q1・Q5)。

**S4. SourceProfile を Gateway が 1 か所で導出する(R4、#22)**
- deployment.yaml(`kind`、`privateScopes`)とコネクタの能力宣言から、Gateway が `{ persistable, privateScopeHandling, nativeSearch }` を導出し、`tools/list` の結果か run API の応答で Orchestrator に配る。レポートは監査レコードに記録された profile を読み、手書き `sources.json` を廃止する。
- kind 名の前方一致はやめる(反例 `rts-chat`)。未知の kind は fail-closed で「永続化不可」。

**S5. 現在の真実の置き場を作る(R4)**
- `docs/MODEL.md` に §1 の性質・部品の知識表・語彙・観測した運用事実・変化の筋書きを置く。ADR は「決定の履歴」に戻し、追記で置き換えた決定は Status 行に反映する(ADR-017・018 の該当決定を Superseded by ADR-019 と明記)。
- CLAUDE.md「現在のフェーズ」を、MODEL への参照と 10 行以内の状態表にする。

**S6. 機械的強制を CI に置く(R4、P4)**
- lint(import 制限)を導入し、「core-model は gateway を import しない」「orchestrator は gateway の実装を import しない」「dev-fixture は本番バンドルに入らない」を CI で落とす。ADR-019 決定10 が前提にしている基盤を先に作る。
- `scripts/guard/*.sh` を CI でも実行する。契約テストキットを SDK から export し、各コネクタの CI で走らせる。

### 4.4 知識の差分

案を採ったとき、各部品が新しく知ること・知らなくなることを §1.2 の表と突き合わせる。

| 部品 | 新しく知ること | 知らなくなること | §1.2 の「知らなくてよい」欄に入るか |
|---|---|---|---|
| Connector SDK | factory 契約、共通部品の実装 | — | 入らない(意図どおり) |
| Connector | SourceProfile のうち policy(既に v0.4 で渡っている) | Gateway の factory 型(再定義が消える) | 入らない |
| 中核モデル | 新設 | — | — |
| Gateway | SourceProfile の導出規則 | MCP SDK の型を公開すること、開発用コネクタ | 入らない |
| Orchestrator | 中核モデルの版 | Gateway の実装、監査 sink の実装(ADR-019 後)、dev-fixture | 入らない。「監査ストア」が知らなくてよい欄に戻る |
| レポート | SourceProfile を監査レコードから読む | 手書き sources.json、Gateway の実装 | 入らない |
| 組み立て役 | registry の中身 | — | 全部を知る唯一の場所(意図どおり) |

欄に入るものがないので、責務の分け方は §1.2 のままでよい。

### 4.5 変化の筋書き

| 筋書き | 現状で直す場所 | 案の後で直す場所 |
|---|---|---|
| (a) 2 社目が Okta + Google Drive + SIEM 直送の監査 sink を要求 | schema.ts、factory.ts、loader.ts、validate.ts、assemble.ts、run.ts、bootstrap/audit.ts、idp-adapter-guide(約 10 か所) | IdP アダプタ 1 ファイル + registry 1 行、sink 1 ファイル + registry 1 行、deployment.yaml |
| (b) Orchestrator を別ホスト・別イメージに置く(ADR-019 決定2 の α) | Orchestrator のイメージに Gateway 実装・MCP SDK・dev-fixture・IdP が同梱される。Dockerfile の COPY 行を手で調整 | core-model と connector-sdk の型だけに依存。イメージは workspace 単位で分けられる |
| (c) MCP SDK v2 へ移行 | gateway の mcp.ts / http.ts、orchestrator の mcp-client.ts / server/http.ts / server/mcp.ts(3 か所、HTTP の糊はコピー)、公開面の `Server` 型 | 同じ 3 か所だが公開面は変わらない。HTTP の糊を共有すれば 2 か所 |
| (d) Slack コネクタ(T-006)が入る | kind 前方一致の判定を orchestrator・レポート・serve の起動拒否の 3 か所で確かめる | SourceProfile の導出 1 か所 |
| (e) 監査スキーマに費用(#28)・actor(#24)の欄を足す | gateway と orchestrator の両方の `strictObject` を同時に変え、旧ログは読めなくなる | core-model の版を上げ、読み手は版で分岐 |

### 4.6 反例(規則で書けると書いたもの)

- 「kind 名で Slack と判定できる」→ `rts-chat`、`chat-official`、`@acme/connector-slackalike`(前方一致も後方一致も外れる)。規則ではなく宣言(SourceProfile)が要る。
- 「開発専用部品は kind / provider / sink の名前で判定できる」→ 本番用コネクタに `settings.corpusFile` を渡す構成、Keycloak で `allowedClients: ["*"]`(既に名前以外の判定になっている)。判定は部品の自己申告(`devOnly: true`)に寄せるのが自然で、`DevOnlyPolicy` の根拠になる。
- 「composition root は 1 つに閉じる」→ テストのハーネス(`orchestrator/test/helpers/harness.ts`)は第 3 の組み立て役になりうる。`composeOrchestrator` にテスト用の差し替え口を持たせないと、テストが別の組み立てを持ち始める。

### 4.7 名前

- `@kp/gateway` から中核モデルと開発用コネクタを出すと、残るのは「製品本体 + 組み立て役」で、名前と中身が一致する。
- Orchestrator 側の `AuditLogger` は ADR-019 後に `RunReporter`(申告者)に改名する。記録する者と申告する者を名前で分ける。
- `GatewaySession` は `RequestPrincipal` のように「リクエストに束縛された本人」を表す名前にする。
- `kind` の 3 用途(プラグイン名解決・Slack 判定・開発専用判定)のうち、後 2 つを SourceProfile と `devOnly` 宣言に移し、`kind` はプラグイン名解決だけにする。

### 4.8 コストと順序

- S5(MODEL)と S6 の lint 基盤は小さく、他の前提になる。先に行う。
- S1 は T-023(ADR-019 の `@kp/audit`)に相乗りできる。T-023 の着手前に範囲(監査だけか、設定スキーマと規約も含むか)を Q2・Q4 で決める。
- S2 の Orchestrator 側(`composeOrchestrator`)は既に漂流が起きているので、T-023 で `kp-ask` と `serve` の両方を触る前に行う。
- S4 は T-006 の前提(#22 の推奨と同じ)。
- S3 は ADR-005 の改訂(文書)と registry 化(小さいコード変更)で、Q1 の答えが出てから。
- 直接案(§4.1)のうち、dev-fixture の資格情報検査の統一と `kp-ask` の設定読み込みは、S1・S2 を待たずに入れてよい。

複数パッケージにまたがる変更になるため、design-diagnosis スキルは実装前に structure-critic サブエージェントへ MODEL と案を渡すよう求めている。このリポジトリにはその定義がないため、人間のレビューをそれに代える。

---

## 5. 仮定のまま置いた事実と、確かめていないこと

- **観測したこと**: `npm ci && npm run build && npm test` は全 5 パッケージで通る(テスト約 1,600 件、約 45 秒)。各 grep と行番号の参照は `cca3584` で確かめた。サブエージェントの報告は主要な主張(`redactAuthContext` の未使用、`chatHistory` と `retentionConfigFrom` の読み手なし、factory 契約の二重定義、`kp-ask` が `orchestrator` 節を読まないこと、`slice` の切り詰め、lint 設定の不在)を再確認した。それ以外の行番号は報告のまま。
- **確かめていないこと**: CI の `keycloak-e2e` と `reference-deploy`(Docker が要る)、LibreChat overlay の通し動作、実モデルでの探索。これらは本診断の結論に影響しない。
- **仮定**: OSS 公開(T-013)と 2 社目の導入は引き続き目標である。Orchestrator は当面 Gateway と同じ運用者が置く(ADR-019 決定2)。MCP SDK は v1 のまま当面動く(ADR-001 追補3)。
- **範囲外**: 個々の不具合(#25〜#29、#34、#45 の性能・上限)は構造のずれではなく、本診断では扱わない。セキュリティの残余(#15 T-004 未着手、#36 カナリア)は人手の前提待ちで、構造ではなく順序の問題。
