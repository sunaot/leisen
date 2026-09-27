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

いずれも脚本(ScriptedLlmClient)と実Gateway(port 0)で検証したもので、実 Claude API での実走は未検証(下記「実装状況」)。

## 更新(2026-09-17)
ADR-001追補3(2026-09-27 承認)により、runId / iteration の `_meta` 申告が本タスクの必須要件になった。`_meta` のprefixは暫定 `io.github.sunaot.leisen/`(2026-09-27確認、最終確定はT-013)。Gateway側がprefix付きキーを受けるまでは現行キー(`runId` / `iteration`)で実装し、Gateway移行後に追随する。

追記(T-003 HTTP配線): Gatewayはprefix付きキー(`io.github.sunaot.leisen/runId` / `iteration` / `executionClass` / `actor`)を受けるよう移行済み。本タスクはprefix付きキーで申告する(`runId` / `iteration` の裸キーは移行期間の後方互換としてのみ受ける。`executionClass` / `actor` はprefix付きキーのみを解釈する)。Gatewayへの接続はStreamable HTTP(既定 `POST /mcp`)で、毎リクエストの `Authorization: Bearer <セッショントークン>` で利用者を認証する。

## 実装状況(2026-09-27)

**実装済み・脚本テスト済み。実走(Claude API の資格情報)は人間の前提待ちで未検証。** 設計判断は ADR-017(Proposed、人間レビュー待ち)。

- `packages/orchestrator`(`@kp/orchestrator` 0.1.0)。依存は `@anthropic-ai/sdk` 0.128.0(exact、新規)、`@modelcontextprotocol/sdk` 1.30.1、`@kp/gateway`、`@kp/connector-sdk`、`zod`
- LLM クライアント抽象 `LlmClient`: 本番 `AnthropicLlmClient`(既定 `claude-opus-5`・adaptive thinking・effort `high`・`tool_choice: auto`・strict ツール・prefill なし。モデル / effort / タイムアウト / 再試行 / max_tokens は設定注入。`stop_reason` の refusal / max_tokens / pause_turn を正規化エラーへ。SDK の型付き例外を具体的なものから分類。server-side fallbacks は既定 off の設定フラグ)、テスト用 `ScriptedLlmClient`
- Gateway クライアント `McpGatewayClient`: SDK の Client + StreamableHTTPClientTransport、毎リクエスト `Authorization: Bearer`。isError を正規化エラーへ。セッショントークンはエラー・シリアライズに出さない
- 探索ループ: runId を採番し、全 `tools/call` の `_meta` に prefix 付きキーで runId / iteration(ツール呼び出しごとに0から単調増加、describe を含む)/ 実行区分 human_in_the_loop / actor human を申告。describe の `source_not_connected` は skippedSources へ入れて検索対象から外し、回答に未接続の旨と接続導線(プレースホルダ)を付ける。回答は `submit_answer`(strict)で提出させ、出典を run 内で受け取った文書に限って検証、回答中の原典以外の URL を除去。上限(maxIterations / runTimeoutMs / costLimitPerQuery)到達時は最終ターンを1回だけ行う
- AnswerRun: 開始時 pending → 終了時に同じ runId で最終状態 → `recordFeedback` で userFeedback を更新して再書き込み。書き込み失敗は fail-closed
- プロンプト: `packages/orchestrator/prompts/explore.v1.md`(探索方針、出典必須、探索範囲の明示、インジェクション防御 — 文書内の隠しテキストを含む指示に従わない・原典以外の URL を生成しない)
- CLI: `kp-ask`(`packages/orchestrator/src/bin/kp-ask.ts`)。資格情報が無い・無効なら「Claude API の資格情報が必要」を表示して終了コード 2
- テスト(vitest、ネットワークは 127.0.0.1 のみ): シナリオ(受け入れ条件1)、出典・URL の検証とインジェクション(受け入れ条件2)、AnswerRun とフィードバック(受け入れ条件3)、runId / iteration(受け入れ条件4)、上限・催促・失敗、AnthropicLlmClient(フェイクの messages.create、偽 fetch の実 SDK)、McpGatewayClient、kp-ask CLI
- 使い方・設定・既知の限界は `packages/orchestrator/README.md`

### 残作業(人手の前提待ち・人間の判断待ち)
- [ ] 実 Claude API での実走(資格情報の用意。既定モデル・effort・max_tokens・プロンプトキャッシュの効きの計測)
- [ ] ADR-017 の人間レビュー(既定モデルとコスト、fallbacks の既定、AnswerRun の書き手、iteration の意味と T-014 の整合、citedDocIds の分類、describe 結果の扱い)
- [ ] 評価レポート(T-008)による探索戦略・プロンプトの回帰評価
- [ ] deployment.yaml の `orchestrator` セクションとの結合、リファレンスデプロイ(T-012)での組み立て(Gateway と監査ストアを共有)
