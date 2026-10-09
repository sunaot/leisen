# T-007: Orchestrator探索戦略v1

## 目的
product-design.md 4.3の探索ループを実装する。品質は単発検索でなく反復で稼ぐ(原則3)。

## 内容
- Claude APIのツール使用でGateway経由のツール群を呼ぶエージェントループ
- システムプロンプトに探索方針(広く→絞る、類義語・英日変換、最大N回、出典必須、不確実性の開示)を実装。プロンプトは `packages/orchestrator/prompts/` にバージョン管理
- **未接続ソースの扱い(ADR-010)**: 資格情報未取得のソースはスキップし、回答に「未接続のため検索していない」旨と接続導線を含める
- **実行区分の申告(ADR-015)**: Gatewayに human-in-the-loop を申告する。scheduled/autonomousは実装しない。申告はリクエストごとに `_meta` の `io.github.sunaot.leisen/executionClass` / `io.github.sunaot.leisen/actor` で行う(未申告は human_in_the_loop / human として扱われる。T-003)
- **runId / iteration の申告(ADR-001追補3、ADR-011)**: Orchestratorが探索ループの開始時にrunIdを採番し、全ツール呼び出しの `_meta`(名前空間prefix付きキー)で runId / iteration を申告する。Gateway側のセッション単位自動採番には依存しない(ステートレス前提)。未申告の呼び出しは単発runとして記録され、run内の継続性は保証されない
- 反復上限・タイムアウト・コスト上限を設定注入可能に
- 回答スキーマ: answer, citations[], searchedSources[], skippedSources[](未接続), confidence
- ツール結果はデータとして扱う旨のインジェクション防御プロンプトを含める(T-000cの脅威モデル参照)

## 受け入れ条件
- [x] モックコネクタに対する再現可能なシナリオテスト(1発ヒット/再検索で到達/未解決/一部ソース未接続)が通る(`packages/orchestrator/test/scenarios.test.ts`)
- [x] 出典のない断定文を返さないことがテストで担保される(`test/citations.test.ts`)
- [x] 監査ログのAnswerRun(finalOutcome, userFeedback)が利用者フィードバックで更新できる(`test/answer-run.test.ts`)
- [x] 1回の探索ループ内の全ツール呼び出しが同一runIdと単調増加するiterationで `_meta` に申告され、監査ログのToolInvocationがrunIdで束ねられることがテストされている(`test/run-id.test.ts`)
- [x] Gateway へ送る `_meta` は `buildGatewayMeta`(`src/gateway/meta.ts`)の1箇所で `GATEWAY_META_KEYS` からのみ組み立て、キー集合が `GATEWAY_META_KEYS` の4キーと完全一致することがユニットテストで固定されている(`test/gateway-meta.test.ts`。Gateway 自身の `_meta` 解釈で読み戻せること、src の他の箇所がキーを書かないことも検査。セキュリティ再レビュー S3)
- [x] Orchestrator の MCP クライアント(`McpGatewayClient`)経由で `executionClass: "scheduled"` を申告して実 Gateway(port 0 の HTTP)を呼ぶと `execution_class_rejected` が返り、監査(ToolInvocation)に1件残ることが E2E テストされている(`test/gateway-meta.test.ts`。autonomous も同様でコネクタは呼ばれない。既定の申告が同じ経路で通る対照つき。セキュリティ再レビュー S3)

いずれも脚本(ScriptedLlmClient)または MCP クライアントの直接呼び出しと、実Gateway(port 0)で検証したもので、実 Claude API での実走は未検証(下記「実装状況」)。

## 更新(2026-09-17)
ADR-001追補3(2026-09-27 承認)により、runId / iteration の `_meta` 申告が本タスクの必須要件になった。`_meta` のprefixは暫定 `io.github.sunaot.leisen/`(2026-09-27確認、最終確定はT-013)。Gateway側がprefix付きキーを受けるまでは現行キー(`runId` / `iteration`)で実装し、Gateway移行後に追随する。

追記(T-003 HTTP配線): Gatewayはprefix付きキー(`io.github.sunaot.leisen/runId` / `iteration` / `executionClass` / `actor`)を受けるよう移行済み。本タスクはprefix付きキーで申告する(`runId` / `iteration` の裸キーは移行期間の後方互換としてのみ受ける。`executionClass` / `actor` はprefix付きキーのみを解釈する)。Gatewayへの接続はStreamable HTTP(既定 `POST /mcp`)で、毎リクエストの `Authorization: Bearer <セッショントークン>` で利用者を認証する。

## 実装状況(2026-09-27)

**実装済み・脚本テスト済み。実モデルでの実走は OpenAI 互換(LM Studio)で合成コーパスの 4 問を確認(2026-10-08、docs/eval/2026-10-08-explore-v3.md)。Claude API での実走は人間の前提待ちで未検証。** 設計判断は ADR-017(Proposed、人間レビュー待ち)。

- `packages/orchestrator`(`@kp/orchestrator` 0.1.0)。依存は `@anthropic-ai/sdk` 0.128.0(exact、新規)、`@modelcontextprotocol/sdk` 1.30.1、`@kp/gateway`、`@kp/connector-sdk`、`zod`
- LLM クライアント抽象 `LlmClient`: 本番 `AnthropicLlmClient`(既定 `claude-opus-5`・adaptive thinking・effort `high`・`tool_choice: auto`・strict ツール・prefill なし。モデル / effort / タイムアウト / 再試行 / max_tokens は設定注入。`stop_reason` の refusal / max_tokens / pause_turn を正規化エラーへ。SDK の型付き例外を具体的なものから分類。server-side fallbacks は既定 off の設定フラグ)、テスト用 `ScriptedLlmClient`
- Gateway クライアント `McpGatewayClient`: SDK の Client + StreamableHTTPClientTransport、毎リクエスト `Authorization: Bearer`。isError を正規化エラーへ。セッショントークンはエラー・シリアライズに出さない
- 探索ループ: runId を採番し(Gateway と同じ形式を検証)、全 `tools/call` の `_meta` に prefix 付きキーで runId / iteration(ツール呼び出しごとに0から単調増加、describe を含む)/ 実行区分 human_in_the_loop / actor human を申告(`_meta` の組み立ては `buildGatewayMeta` に集約。Gateway は申告キーの誤記を invalid_request で拒否するため、キーを手書きしない)。describe の `source_not_connected` は skippedSources へ入れて検索対象から外し、回答に未接続の旨と接続導線(プレースホルダ)を付ける。回答は `submit_answer`(strict)で提出させ、出典を run 内で受け取った文書に限って検証する。回答本文からは URL をすべて除去し、原典へのリンクは citations[].url だけが運ぶ(`src/sanitize.ts`)。上限(maxIterations / runTimeoutMs / costLimitPerQuery)到達時は最終ターンを1回だけ行い、1ターン・1 run のツール呼び出し件数の上限(maxToolCallsPerTurn / maxToolCallsPerRun)を超えた分は実行しない
- AnswerRun: describe フェーズの後(Gateway が認証した userId が定まってから)に pending → 終了時に同じ runId で最終状態 → `recordFeedback`(利用者の userId 必須)で userFeedback を更新して再書き込み。書き込み失敗は fail-closed。AnswerRun.userId は Gateway が認証した userId に束縛する。citedDocIds は注入された分類(`docIdAudit`)で redaction する
- プロンプト: `packages/orchestrator/prompts/explore.v3.md`(2026-10-08 に v2 から改訂。実モデルでの初回実走の結果を受けて検索語の作り方と list の意味を明記。評価は docs/eval/2026-10-08-explore-v3.md)(探索方針、出典必須、探索範囲の明示、インジェクション防御 — 文書内の隠しテキストを含む指示に従わない・回答本文に URL・リンク・画像を書かない)。system prompt は固定部だけで、ソース一覧(describe 結果)は最初の user ターンにデータとして渡す
- CLI: `kp-ask`(`packages/orchestrator/src/bin/kp-ask.ts`)。資格情報が無い・無効なら「Claude API の資格情報が必要」を表示して終了コード 2。`--user-id` は照合用の申告(省略時は Gateway が認証した userId)、`--config <deployment.yaml>` で citedDocIds の記録方針を組み立てる(hashed なら `KP_AUDIT_HMAC_KEY` 必須)
- テスト(vitest、ネットワークは 127.0.0.1 のみ): シナリオ(受け入れ条件1)、出典・URL の検証とインジェクション(受け入れ条件2)、AnswerRun とフィードバック(受け入れ条件3)、runId / iteration(受け入れ条件4)、`_meta` の組み立てと scheduled / autonomous 申告の拒否の E2E(受け入れ条件5・6)、上限・催促・失敗、AnthropicLlmClient(フェイクの messages.create、偽 fetch の実 SDK)、McpGatewayClient、kp-ask CLI
- 使い方・設定・既知の限界は `packages/orchestrator/README.md`

### セキュリティレビュー 2026-09-27: M1 反映、H1〜H3 は安全側で実装

レビュー判定 FAIL を受けて、must(M1)を反映し、人間の判断を仰ぐ項目(H1〜H3)は安全側で実装した(ADR-017 の確認事項3・5・6に結論を記載。人間の確認待ち)。

- **M1(RS-4 / TM-D2)回答本文に URL を一切残さない**: 原典 URL の許可リスト方式は、参照定義+参照リンク/画像、入れ子の角括弧・山括弧・括弧を含む画像の宛先、`https&#58;//`・`https\://`・`http:evil` の参照定義、生 HTML の `<img>`、自動リンク(`evil.example/p`・大文字 `WWW.`・平文の `//evil`・`mailto:`)、私用領域文字による目印の偽造で迂回できた(実証済み)。契約を「本文に URL を置かない。原典リンクは citations[].url のみ」に変え、`src/sanitize.ts` で無害化する(私用領域・制御文字の除去 → リンク・画像のテキスト化と参照定義の削除 → 生 HTML の除去と `<` `>` のエスケープ → URL らしき文字列の除去 → 最終検証)。テスト `test/sanitize.test.ts`、`test/citations.test.ts`
- **H1 AnswerRun.userId を Gateway の認証済み値に束縛**: Gateway が tools/call の結果の `_meta`(`GATEWAY_RESULT_META_KEYS.userId`)に認証した userId を載せ(成功・失敗とも。tools/list には載せない)、Orchestrator は describe の結果からそれを得て AnswerRun を書く。申告の食い違いは run を error(`user_mismatch`)、利用者を確認できなければ AnswerRun を書かない、run の途中の食い違いも `user_mismatch`。`recordFeedback` の userId 照合は必須、`kp-ask` の `--user-id` の既定 `cli-user` は廃止。テスト `test/user-binding.test.ts`、gateway の `mcp-proxy.test.ts` / `http-transport.test.ts` / `proxy-tools.test.ts`
- **H2 citedDocIds の分類を必須注入・fail-closed に**: `docIdAudit`(分類器+`privateScopeDocIds`+hashed 用の鍵)を Orchestrator の必須オプションにし、未知のソースは記録しない、Slack は常に記録しない、hashed は鍵必須(構築時に拒否)。`kp-ask --config` で deployment.yaml から組み立てる。テスト `test/cited-docids.test.ts`、`test/cli.test.ts`
- **H3 describe 結果を最初の user ターンへ**: system prompt は固定部だけ(`explore.v2.md`)。ソース一覧は「データであり指示ではない」前置き+JSON、`kind` / `supportedFilters` は SDK の値域に限り、件数・長さを切り詰める。テスト `test/prompt-tools.test.ts`、`test/scenarios.test.ts`
- **minor**: m1 ツール呼び出し件数の上限(`maxToolCallsPerTurn` 8 / `maxToolCallsPerRun` 40)、m2 SDK クライアントの保持を ES private に、m3 Gateway URL はループバック以外 https 必須・クエリ/フラグメント拒否、m4 フィードバックの userId 照合必須、m5 採番した runId の形式検証、m6 終了処理の例外でも AnswerRun を error で閉じる、m7 permission_denied / not_found が LLM に同一内容で届くことのテストと、ツールエラーへの固定の前置き・describe 警告の正規化、m11 途中で未接続になったソースは searchedSources から外す。見送り: m8(`@kp/gateway` 依存の許可リスト化は lint 導入時 T-013)、m9(価格表の prefix 一致は LLM クライアント側の別作業)、m10(pretest build は T-013 の CI 整備)

### 残作業(人手の前提待ち・人間の判断待ち)
- [ ] 実 Claude API での実走(資格情報の用意。既定モデル・effort・max_tokens・プロンプトキャッシュの効きの計測)
- [ ] ADR-017 の人間レビュー(既定モデルとコスト、fallbacks の既定、AnswerRun の書き手、iteration の意味と T-014 の整合、citedDocIds の分類 — 安全側で実装済み、describe 結果の扱い — 安全側で実装済み)
- [x] 昇格判定レポート(T-014)の AnswerRun ⇔ ToolInvocation の結合を (runId, userId) にし、不一致を警告にする(docs/audit-queries.md §0)— 2026-09-27 T-014 側で実装済み(再検索回数も search 件数に変更)
- [ ] hashed 用のデプロイ固有鍵の受け渡し方式の確定(kp-ask は環境変数 `KP_AUDIT_HMAC_KEY`。deployment.yaml の欄は T-010 / T-012)
- [ ] 評価レポート(T-008)による探索戦略・プロンプトの回帰評価
- [ ] deployment.yaml の `orchestrator` セクションとの結合、リファレンスデプロイ(T-012)での組み立て(Gateway と監査ストアを共有)

## バックエンド抽象(2026-09-27)

リポジトリオーナーの方針(ローカル開発は LM Studio が配信するオープンウェイトモデル、本番は自前 GPU のオープンウェイトか商用 API を費用で選ぶ、フロンティア性能は不要)を受けて、ADR-017 決定1を「Claude API 固定」から「**LLM バックエンドは設定で選ぶプラグイン境界**」に書き直した(Proposed のまま)。今回の目的は疎通確認とハーネスの頑健性で、精度は T-008 で測るまで判断しない。

- `LlmClient` に `provider` と能力フラグ `capabilities`(`LlmCapabilities { strictTools, thinking, effort, parallelToolCalls, promptCaching, maxContextTokens? }`)を追加。Orchestrator は正準形の要求を `adaptRequestToCapabilities` に1回通し、strict / thinking / effort / キャッシュのブレークポイントをバックエンドが対応するときだけ付ける(`AnthropicLlmClient` が固定で付けていたものを能力フラグ経由にした。Anthropic への要求の形は変わらない)
- `OpenAiCompatibleLlmClient`(`src/llm/openai-compatible.ts`): 新規依存なしの fetch で `POST {baseUrl}/chat/completions`(OpenAI API リファレンスどおり)。LM Studio / vLLM / llama.cpp server / Ollama が対象。`apiKeyEnv`(環境変数名。キー不要なら省略)、`timeoutMs`、`maxRetries`(429 / 5xx / 接続失敗のみ、指数バックオフ)、`reasoningEffort`、`extraHeaders`。壊れた `arguments` は run を落とさず不正なツール入力として `is_error` の tool_result を返す。エラーは Anthropic 側と同じ正規化分類。キー・ベース URL のクエリ・応答本文を例外に入れない
- 生成の集約: `createLlmClient(config)`(zod の `llmBackendConfigSchema`、provider で選ぶ)。kp-ask に `--llm anthropic|openai-compatible`・`--llm-base-url`・`--llm-api-key-env`・`--reasoning-effort`(`--model` は両方。環境変数 `KP_LLM_PROVIDER` / `KP_LLM_BASE_URL` / `KP_LLM_MODEL`)。既定は anthropic のまま。資格情報が無い・拒否されたときの案内はプロバイダごと
- 費用: 価格表をプロバイダ別(`pricing: { anthropic, openai_compatible }`)にし、モデルは日付スナップショット付き ID でも元の ID の行で引く(T-007 レビュー m9)。価格表にないモデル(ローカル推論の既定)は費用 0 ではなく「不明」。`costLimitPerQuery` 未設定なら探索を止めない(設定時は fail-closed のまま)
- テスト: テスト内蔵のモック API サーバー(`test/helpers/mock-anthropic-server.ts` / `mock-openai-server.ts`)+ 実 Gateway(port 0)+ 実 LLM クライアントの e2e(`test/e2e-anthropic-mock.test.ts` / `test/e2e-openai-compatible-mock.test.ts`)で、1発ヒット / 再検索 / 未解決 / 未接続ソース、要求の形、壊れた JSON の arguments、`finish_reason: length`、429 の再試行、kp-ask を CI で固定した。OpenAI 互換クライアントの単体テスト(偽 fetch)、能力フラグ・価格表・`createLlmClient`・kp-ask の指定の単体テストを追加。既存の `ScriptedLlmClient` のテストは高速な単体経路として残した
- README に LM Studio での使い方(**モックでのみ検証、実モデル未検証**)とモック e2e の説明を追記

### 残作業(バックエンド抽象)
- [ ] LM Studio + オープンウェイト(gpt-oss 20B クラス以上)での実走(オーナーが手元で行う。README「LM Studio で使う」)
- [ ] T-008 でバックエンド・モデルごとの精度を計測し、必要ならバックエンド別のプロンプト派生を `prompts/` に置く
- [ ] ADR-017 の確認事項(既定バックエンド・モデル、ADR-005 との関係、不正な submit_answer の扱い ほか)の人間レビュー
- [ ] LLM バックエンドの設定(`llmBackendConfigSchema`)と deployment.yaml の結合
