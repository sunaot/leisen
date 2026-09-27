# @kp/orchestrator — 探索戦略 v1(T-007)

利用者の質問に対し、LLM が Gateway 経由のツール(search / fetch / list / describe)を反復して呼び、出典付きで回答する探索ループ(product-design §4.3)。LLM バックエンドは設定で選ぶプラグイン境界で、参照実装は Anthropic Messages API(`AnthropicLlmClient`)と OpenAI 互換 Chat Completions(`OpenAiCompatibleLlmClient`。LM Studio / vLLM / llama.cpp server / Ollama 等)の2つ。設計判断は [ADR-017](../../docs/adr/ADR-017-orchestrator-llm-client.md)(Proposed、人間レビュー待ち)。

**実モデルでの実走は未検証です。** Claude API の資格情報も、LM Studio 等のローカル推論環境もこの開発環境にはないため、テストは脚本(`ScriptedLlmClient`)と、テスト内蔵のモック API サーバー(Anthropic 形式・OpenAI 互換形式)を相手にした e2e で行っています(下記「モック API サーバーでの e2e」)。

## 使い方(kp-ask)

Gateway(`POST /mcp`)を起動した状態で(起動構成はリファレンスデプロイ T-012):

```sh
npm run build -w @kp/orchestrator
export KP_SESSION_TOKEN=...          # 利用者のセッショントークン(Gateway の IdP が検証する)
export ANTHROPIC_API_KEY=...         # または `ant auth login` のプロファイル
export KP_AUDIT_HMAC_KEY=...         # --config の audit.privateScopeDocIds が hashed(既定)のとき
node packages/orchestrator/dist/bin/kp-ask.js \
  --gateway http://127.0.0.1:8787/mcp \
  --config examples/deployment.dev.yaml \
  "経費精算の締め日はいつ?"
```

| オプション | 内容 |
|---|---|
| `--gateway <URL>` | Gateway の MCP エンドポイント(必須)。ループバック(`localhost` / `127.0.0.1` / `[::1]`)以外は `https` 必須。資格情報・クエリ・フラグメントを含む URL は拒否する |
| `--token <トークン>` | セッショントークン。プロセス一覧に残るため環境変数 `KP_SESSION_TOKEN` を推奨 |
| `--llm <種類>` | LLM バックエンド。`anthropic`(既定)/ `openai-compatible`。環境変数 `KP_LLM_PROVIDER` でも指定可 |
| `--model <ID>` | モデル ID。anthropic は既定 `claude-opus-5`、openai-compatible は必須(サーバーでロードしたモデル名)。環境変数 `KP_LLM_MODEL` でも指定可 |
| `--effort <level>` | anthropic のみ。`low` / `medium` / `high` / `xhigh` / `max`(既定 `high`) |
| `--llm-base-url <URL>` | openai-compatible のみ・必須。ベース URL(例: LM Studio は `http://localhost:1234/v1`)。環境変数 `KP_LLM_BASE_URL` でも指定可(anthropic では使わない。Claude API の接続先は SDK 標準の `ANTHROPIC_BASE_URL` で変える) |
| `--llm-api-key-env <名前>` | openai-compatible のみ。API キーを入れた**環境変数の名前**(キーの値そのものは渡さない)。LM Studio 等キー不要のサーバーでは省略 |
| `--reasoning-effort <level>` | openai-compatible のみ。`low` / `medium` / `high`(`reasoning_effort` に対応するモデルのみ。指定したときだけ送る) |
| `--max-iterations <N>` | ツールを呼べるターン数の上限(1〜20、既定 6) |
| `--user-id <ID>` | 照合用の質問者の申告(環境変数 `KP_USER_ID` でも可)。AnswerRun に記録するのは Gateway が認証した userId で、申告と食い違えば run は `error`(`user_mismatch`)。省略時は照合しない |
| `--config <deployment.yaml>` | citedDocIds の記録方針に使う(`connectors[].kind` が `slack` なら Slack、`privateScopes` が `excluded` 以外ならプライベートスコープ、`audit.privateScopeDocIds`)。`hashed` なら環境変数 `KP_AUDIT_HMAC_KEY` にデプロイ固有鍵が必要(ないと終了コード 2)。省略時は citedDocIds を記録しない |
| `--json` | Answer を JSON で出力する |

- 表示: 回答・出典(タイトル、`sourceId:documentId`、原典 URL)・検索したソース・未接続でスキップしたソース・結果と確信度・使用量(トークン、LLM ターン、ツール呼び出し回数、概算費用)・警告・runId。回答本文には URL を含まない(原典 URL は出典の欄に出す)
- 監査: AnswerRun を stderr に JSON 1行で出す(開発用。本番の監査ストアへの書き込みはリファレンスデプロイで組む)。ToolInvocation は Gateway 側の監査に記録される
- 終了コード: 0 回答した(resolved / unresolved)、1 実行時エラー(Gateway の拒否・利用者の不一致など。openai-compatible で接続できない・要求を拒否されたときは確認の手がかりを stderr に添える)、2 引数・設定の不備、または LLM バックエンドの資格情報が無い・無効(プロバイダごとの案内を表示)

## LM Studio で使う(OpenAI 互換バックエンド)

**この手順はモック API サーバーでしか検証していません(実モデル・実際の LM Studio では未検証)。精度も保証しません**(評価ハーネス T-008 で測るまで判断しない。ADR-017)。

1. LM Studio でツール呼び出し(function calling)に対応したモデルをロードする。gpt-oss 20B クラス以上を想定。探索ループはツール呼び出しが前提なので、非対応のモデルでは動かない
2. モデルのコンテキスト長は長めにとる(目安 16k トークン以上)。system prompt・ツール定義・ソース一覧・ツール結果(検索のスニペット、文書の本文)が毎ターン積み上がる
3. LM Studio のローカルサーバーを起動する(既定 `http://localhost:1234/v1`)。モデル名は `curl http://localhost:1234/v1/models` の `id` で確認できる
4. Gateway を起動した状態で実行する:

```sh
export KP_SESSION_TOKEN=...
node packages/orchestrator/dist/bin/kp-ask.js \
  --gateway http://127.0.0.1:8787/mcp \
  --llm openai-compatible --llm-base-url http://localhost:1234/v1 \
  --model <LM Studio のモデル名> \
  "経費精算の締め日はいつ?"
```

- LM Studio はキー不要なので `--llm-api-key-env` は付けない(`Authorization` ヘッダを送らない)。キーを要求するサーバー(vLLM の `--api-key` 等)では、キーを環境変数に入れて `--llm-api-key-env その変数名` を付ける
- `--llm-base-url` はループバック(`localhost` / `127.0.0.1` / `[::1]`)以外では `https` 必須(Gateway の URL と同じ規則。会話には取得した文書の本文が入る)。別のマシンの LM Studio / vLLM は https で公開するか、SSH のポート転送で localhost に向ける
- `--config` と `KP_AUDIT_HMAC_KEY` は上の例と同じ(省略すると citedDocIds を記録しない)。`--user-id` は照合用で省略できる
- ローカル推論は1ターンが遅いことがある。1リクエストのタイムアウトは 120 秒(`timeoutMs`)、run 全体の時間上限は `runTimeoutMs`(既定 120 秒)。上限に達すると、その時点の情報で回答を促す最終ターンを1回行う(警告に出る)
- 費用は価格表がないため「不明」と表示される(0 円とはみなさない)。`costLimitPerQuery` を設定していなければ探索は止まらない
- 環境変数で指定する場合: `KP_LLM_PROVIDER=openai-compatible KP_LLM_BASE_URL=http://localhost:1234/v1 KP_LLM_MODEL=<モデル名>`

## 必要な資格情報

| 対象 | 渡し方 | 備考 |
|---|---|---|
| Claude API(`--llm anthropic`) | SDK が環境から解決(`ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → `ant auth login` のプロファイル → Workload Identity Federation) | コード・設定ファイルに書かない。無い場合 kp-ask は「Claude API の資格情報が必要です」と表示して終了コード 2 |
| OpenAI 互換(`--llm openai-compatible`) | 任意。`apiKeyEnv`(`--llm-api-key-env`)で指定した環境変数の値を `Authorization: Bearer` で送る | 設定には環境変数の**名前**だけを書く。キー不要のサーバーでは指定しない。サーバーが 401 を返した場合、キーを送っていなければ「資格情報が必要」、送っていれば「拒否された」と表示して終了コード 2。キー・ベース URL のクエリ・応答本文は例外メッセージに出さない |
| Gateway | 利用者本人のセッショントークン(`Authorization: Bearer`、毎リクエスト) | ログ・エラー・例外メッセージに出さない。`McpGatewayClient` は private フィールドに保持する |

ソース(Drive・GitHub 等)の本人資格情報は Gateway 側(IdP Adapter / Token Vault)が扱い、Orchestrator は触れない(不変条件1・2)。

## ライブラリとして使う

```ts
import { AuditLogger, loadDeploymentConfig } from "@kp/gateway";
import {
  createLlmClient,
  McpGatewayClient,
  Orchestrator,
  docIdAuditFromDeployment,
} from "@kp/orchestrator";

const config = loadDeploymentConfig("deployment.yaml");
// LLM バックエンドは設定で選ぶ(生成は createLlmClient に集約。設定は zod で検証する)
const llm = createLlmClient({ provider: "anthropic", model: "claude-opus-5", effort: "high" });
// const llm = createLlmClient({
//   provider: "openai_compatible",
//   baseUrl: "http://localhost:1234/v1",
//   model: "<LM Studio のモデル名>",
// });

const orchestrator = new Orchestrator({
  llm,
  auditLogger, // リファレンス構成では Gateway と同じ監査ストア(ADR-017 決定2)
  // citedDocIds の記録方針(必須)。deployment.yaml から組み立てる。hashed は鍵が必須
  docIdAudit: docIdAuditFromDeployment(config, process.env.KP_AUDIT_HMAC_KEY),
  settings: { maxIterations: 6, runTimeoutMs: 120_000, costLimitPerQuery: 0.5 },
});
const gateway = new McpGatewayClient({ url: "https://gateway.example.test/mcp", sessionToken });
try {
  // userId は照合用の申告(任意)。記録する主体は Gateway が認証した userId
  const answer = await orchestrator.run({ question, userId, gateway });
  // 利用者の「解決した / しない」ボタン(受け入れ条件3)。userId は必須で、run の利用者と照合する
  await orchestrator.recordFeedback(answer.runId, "resolved", { userId });
} finally {
  await gateway.close();
}
```

利用者の束縛(セキュリティレビュー 2026-09-27 H1): AnswerRun の `userId` は、呼び出し元の申告ではなく **Gateway がそのリクエストで認証した userId**(tools/call の結果の `_meta` の `io.github.sunaot.leisen/userId`)にする。

- 呼び出し元(チャットUIのバックエンド等)が `userId` を申告していて一致しなければ fail-closed: run を `error`(`failureReason: "user_mismatch"`)で閉じ、LLM・検索に進まない
- describe フェーズで Gateway が利用者を確認できない(HTTP の認証失敗・到達不能・報告なし・食い違い)ときは AnswerRun を書かずに `error` の Answer を返す(`recordFeedback` の対象にもならない)
- run の途中で別の userId が報告されたら `user_mismatch` で止める
- AnswerRun と ToolInvocation は `(runId, userId)` で結合する(docs/audit-queries.md)

回答本文の契約(M1): **`Answer.answer` には URL を一切残さない。** 原典へのリンクは `citations[].url`(ツール結果の値)からのみ、利用側が描画する。`citations[].title` はソース由来の文字列(信頼しない入力)なので、利用側はプレーンテキストとして描画する。

## 設定

`orchestratorSettingsSchema`(探索ループ):

| 項目 | 既定 | 内容 |
|---|---|---|
| `maxIterations` | 6 | LLM のツール呼び出しターン数の上限(1〜20。submit_answer だけのターンは数えない) |
| `maxToolCallsPerTurn` | 8 | 1ターンに実行するツール呼び出しの上限(応答内の順で先頭から。1〜64)。超えた分は実行せず `is_error` の tool_result(固定文言)で返し、warnings に記録 |
| `maxToolCallsPerRun` | 40 | 1 run に実行する LLM 起点のツール呼び出しの上限(最初の describe は数えない。1〜1000)。超えた分の扱いは同上 |
| `runTimeoutMs` | 120000 | 探索フェーズの時間上限。到達すると進行中の LLM・Gateway 呼び出しを中断する |
| `finalTurnTimeoutMs` | 60000 | 上限到達後の最終ターンの時間枠 |
| `costLimitPerQuery` | なし | 1質問の LLM 費用の上限(`pricing` の通貨単位)。超過したターンの次は最終ターンだけ行う(最終ターンの分だけ超えうる)。設定時に費用が不明(価格表にないモデル・usage を返さない応答)なら確認できないため到達扱い。未設定なら判定しない(ローカル推論でも探索を止めない) |
| `maxTokensPerTurn` | 16000 | 1ターンの max_tokens(adaptive thinking の思考を含む。非ストリーミングの実用上限 64000) |
| `pricing` | 下記 | プロバイダ → モデル ID → 単価(100万トークンあたり。既定は USD)。`{ anthropic: {...}, openai_compatible: {...} }`。LLM クライアントの provider の表を、応答の model で引く(完全一致を優先し、日付スナップショット付き ID `<ID>-YYYYMMDD` / `<ID>@YYYYMMDD` / `<ID>-YYYY-MM-DD` は元の ID の行。日付以外の接尾辞は写さない) |
| `connectGuidance` | プレースホルダ | 未接続ソースの接続導線の文言(T-009 で確定)。URL を書かない(回答本文から除去される。接続画面へのリンクは UI が描画する) |

LLM バックエンドの設定は `llmBackendConfigSchema`(`provider` で選ぶ判別共用体。`createLlmClient` の入力):

`provider: "anthropic"`(`anthropicLlmSettingsSchema`、`AnthropicLlmClient`):

| 項目 | 既定 | 内容 |
|---|---|---|
| `model` | `claude-opus-5` | |
| `effort` | `high` | `output_config.effort`。API 既定と同じ値を明示している(既定 effort の異なるモデルに切り替えても挙動が黙って変わらないように) |
| `timeoutMs` | 60000 | 1リクエストのタイムアウト(SDK は再試行ごとに適用) |
| `maxRetries` | 2 | SDK の自動再試行(429 / 5xx / 接続失敗) |
| `serverSideFallbacks` | false | 下記 |

`provider: "openai_compatible"`(`openAiCompatibleLlmSettingsSchema`、`OpenAiCompatibleLlmClient`):

| 項目 | 既定 | 内容 |
|---|---|---|
| `baseUrl` | (必須) | ベース URL。ループバック(`localhost` / `127.0.0.1` / `[::1]`)以外は `https` 必須(Gateway の URL と同じ規則)。資格情報・フラグメントは不可。`{baseUrl}/chat/completions` を呼ぶ。クエリは保つが表示・例外には出さない |
| `model` | (必須) | モデル名 |
| `apiKeyEnv` | なし | API キーを入れた環境変数の名前(英数字と `_`)。指定時だけ `Authorization: Bearer` を送る |
| `timeoutMs` | 120000 | 1リクエストのタイムアウト。タイムアウトは再試行しない |
| `maxRetries` | 2 | 429 / 5xx / 接続失敗のみ再試行(指数バックオフ 0.5 秒起点・上限 8 秒、`Retry-After` / `retry-after-ms` が 0〜60 秒ならそれに従う) |
| `reasoningEffort` | なし | `low` / `medium` / `high`。指定したときだけ `reasoning_effort` を送る(能力フラグ effort が true になる) |
| `extraHeaders` | なし | 追加の HTTP ヘッダ(秘密でないもの。値は表示可能な ASCII)。`Authorization` / `Cookie` / `X-Api-Key` / `Api-Key` 等の認証系・トランスポート系ヘッダは置けない |
| `maxContextTokens` | なし | サーバーでロードしたコンテキスト長(参照用。能力フラグに出すだけで上限判定には使っていない) |

既定の価格表(`pricing.anthropic`。claude-api スキルの価格表、2026-06-24 時点): `claude-opus-5` 5 / 25、`claude-opus-5-5` 4 / 20、`claude-fable-5-1` 10 / 50、`claude-opus-4-8` 5 / 25、`claude-sonnet-5` 2 / 10、`claude-haiku-4-5` 1 / 5(入力 / 出力、USD)。キャッシュ書き込みは入力単価の 1.25 倍、読み出しは 0.1 倍(Opus 5.5 は $0.20、Fable 5.1 は $0.25)。導入先の契約単価・通貨に合わせて差し替える。`pricing.openai_compatible` の既定は空(ローカル推論の費用は「不明」のまま扱い、0 とみなさない。商用の OpenAI 互換 API を使う導入先は単価を設定する)。

### server-side fallbacks(既定 off)

`serverSideFallbacks: true` にすると、beta ヘッダ `server-side-fallback-2026-07-01` と `fallbacks: "default"` を付けて呼ぶ。安全分類器が要求を辞退(`stop_reason: refusal`)したとき、API 側で辞退の分類に応じたモデルが同じ要求を処理する。

- 利点: 辞退で回答できない run を減らせる。claude-api スキルは Claude Opus 5 / Fable 系で既定 on を勧めている
- 既定 off にした理由: 社内ナレッジ検索の質問が辞退に当たることは稀で、beta 機能への依存を既定にしない。Claude API と Claude Platform on AWS でしか使えない(Bedrock / Vertex / Foundry では不可)。フォールバック先の単価・レート制限の見積もりが別に要る。辞退が観測された導入で有効化を検討する
- 有効時の扱い: 応答の `fallback` ブロックは履歴に戻さない。費用は `usage.iterations`(辞退した試行・フォールバック先の試行)で数える

## LLM バックエンドと能力フラグ

探索ループは `LlmClient` IF(`provider` / `capabilities` / `complete`)だけに依存する。会話の内部表現は Anthropic SDK の型で、他形式のバックエンドは実装側で変換する。バックエンドの差は能力フラグ(`LlmCapabilities`)で吸収し、Orchestrator は正準形の要求(strict のツール定義・キャッシュのブレークポイント付き)を `adaptRequestToCapabilities` に1回通して、対応している機能だけを付ける。

| 能力フラグ | Anthropic | OpenAI 互換 | Orchestrator の扱い |
|---|---|---|---|
| `strictTools` | true | false | false ならツール定義から `strict` を外す(引数は submit_answer の検証と Gateway の zod が守る) |
| `thinking` | `adaptive` | `none` | `adaptive` のときだけ `thinking: {type: "adaptive"}` を要求する |
| `effort` | true | `reasoningEffort` 設定時のみ true | true のときだけ推論の深さの制御を付ける(段階の値はバックエンドの設定: `effort` / `reasoningEffort`) |
| `promptCaching` | true | false | false なら system の `cache_control` を外す |
| `parallelToolCalls` | true | false(サーバー・モデル依存で不明) | 参照のみ。応答内の呼び出しはすべて処理する |
| `maxContextTokens` | なし | 設定時のみ | 参照のみ |

OpenAI 互換の変換(一次情報: OpenAI API リファレンスの Chat Completions):

| 内部表現(Anthropic 形式) | Chat Completions |
|---|---|
| system のテキストブロック(固定部だけ。ソース一覧・上限・質問は最初の user ターン) | `system` メッセージ1件(複数ブロックなら空行で連結。`cache_control` は送らない) |
| user の text | `user` メッセージ(同じターンのテキストは連結) |
| user の `tool_result` | `tool` メッセージ(`tool_call_id`。本文はテキストを改行で連結。`is_error` に当たる項目はないので本文の `{ errorClass, message }` で伝える)。同じターンのテキストより前に並べる |
| assistant の text / `tool_use` | `assistant` メッセージの `content` / `tool_calls[]`(`{ id, type: "function", function: { name, arguments: JSON 文字列 } }`。テキストがなければ `content: null`) |
| assistant の thinking | 送らない(署名付きの思考は他形式に写せない) |
| ツール定義 | `{ type: "function", function: { name, description, parameters } }`(`strict` は付けない)。`tool_choice: "auto"`、`max_tokens`、`stream: false` |
| 応答 `choices[0].message.content` / `tool_calls` | text ブロック / `tool_use` ブロック(`arguments` を `JSON.parse`。オブジェクトのまま・二重に JSON 化・空文字も受ける。読めなければ input を `null` にして `invalidToolUseIds` に入れ、Orchestrator の引数検査が Gateway に送らずに `is_error` の tool_result(`invalid_request`)を返す。submit_answer なら不正な提出として unresolved で終える。履歴に戻すときは `{}` を送る) |
| `finish_reason` | `stop` → end_turn(`tool_calls` があれば tool_use)、`tool_calls` → tool_use、`length` → `llm_max_tokens`、`content_filter` → `llm_refusal`、未知 → `llm_unexpected_response`(返さないサーバーは `tool_calls` の有無で推定) |
| `usage` | `prompt_tokens` − `cached_tokens` → input、`cached_tokens` → キャッシュ読み出し、`completion_tokens` → output。`usage` がなければ費用は不明扱い |

エラーの正規化(Anthropic と同じ分類): 401 はキーを送っていなければ `llm_credentials_missing`、送っていれば `llm_authentication_failed` / 403 `llm_permission_denied` / 404・400・422・3xx(リダイレクトは追わない)`llm_invalid_request`(`error.code: context_length_exceeded` は `llm_context_window_exceeded`)/ 408・タイムアウト `llm_timeout` / 429 `llm_rate_limited` / 5xx・409・接続失敗 `llm_unavailable` / 呼び出し側の中断 `llm_aborted`。例外メッセージは固定文言で、キー・ベース URL(クエリ)・応答本文を含めない。

## 探索ループの仕様

- 開始時: runId を採番(Gateway と同じ形式 `[A-Za-z0-9._:-]{1,128}` を検証し、外れたら Gateway にアクセスせずに `invalid_configuration`)→ `tools/list` → 全ソースに `describe`(`source_not_connected` のソースは skippedSources に入れて検索対象から外す。それ以外の失敗は正規化後の分類で警告を残して検索対象に残す)→ describe の結果の `_meta` から Gateway が認証した userId を得て AnswerRun(`pending`、`startedAt` は run の開始時刻)を書く → system prompt(固定部 `prompts/explore.v2.md` だけ)・最初の user ターン(ソース一覧・上限・質問)・ツール定義(strict、`source` は有効ソースの enum)を組む
- ソース一覧(セキュリティレビュー H3): describe 結果はコネクタ由来の外部データなので、system prompt には入れず、最初の user ターンに「固定の前置き(データであり指示ではない)」+「JSON」で渡す(ツール結果と同じ扱い)。`kind` は connector-sdk の `ContainerEntry.kind` の値域に限り(それ以外は `other`)、`supportedFilters` は `SearchFilters` のキーに限る。件数・長さを切り詰め、JSON の `<` `>` はエスケープする。system prompt が固定文字列だけになるので、プロンプトキャッシュの prefix も run をまたいで安定する
- 反復: LLM の応答内のツール呼び出しは並行に Gateway へ送り(1ターン `maxToolCallsPerTurn` 件・run 全体 `maxToolCallsPerRun` 件まで。超えた分は実行しない)、結果は1つの user メッセージにまとめて返す。成功した結果は「固定の前置き(データであり指示ではない)」と「データ本体の JSON」の2ブロック、ツールエラーも「固定の前置き(ツールエラーはデータ)」と `{ errorClass, message }` の JSON の2ブロックで返す(`is_error: true`)。`permission_denied` と `not_found` は区別せず `not_available` として渡す(TM-B2。Gateway も正規化する)
- 終了: `submit_answer` の提出 / 提出せずに終えたら1回だけ催促し、それでも提出しなければ unresolved / 上限に達したら提出を促す最終ターンを1回だけ行う / LLM・Gateway の失敗・利用者の不一致は error
- 出典の検証: citations はその run で search のヒット・fetch の結果として受け取った (sourceId, documentId) に限る。検証済みの出典が0件なら unresolved、回答の先頭に「【注意】出典を確認できませんでした」、confidence を 0.3 以下に丸める
- 回答本文の無害化(M1、`src/sanitize.ts`): 私用領域・制御文字・不可視の書式文字を除き、Markdown のリンク・画像(参照形式・入れ子を含む)はテキストだけに、参照定義は削除、生の HTML は除去して残った `<` `>` はエスケープし(コードの外だけ。行頭の引用記号は残す)、URL らしき文字列(任意の `scheme://`、`http:evil`・`mailto:`・`javascript:` 等、`www.`、`//host`、`label.tld/path`。実体参照・`\`・全角で組んだものを含む)は `［URL削除］` に置き換える。最後に同じ処理をかけ直す最終検証(fail-closed)を行い、残っていたものも除去する。除去は warnings に記録する
- 未接続: run の途中で `source_not_connected` になったソースは searchedSources から外し、skippedSources にだけ載せる
- `_meta`: 全 `tools/call` に `io.github.sunaot.leisen/runId` / `iteration` / `executionClass`(`human_in_the_loop`)/ `actor`(`{ kind: "human" }`)を付ける。iteration はツール呼び出しごとに 0 から単調増加(describe を含む。同一ターン内の並列呼び出しは応答内の順。Gateway に送らなかった呼び出しは番号を消費しない)。結果の `_meta` の `io.github.sunaot.leisen/userId` は Gateway が認証した利用者(H1)
- 監査: Orchestrator は AnswerRun だけを書く(ToolInvocation は Gateway)。終了時に同じ runId で最終状態、`recordFeedback` で userFeedback を更新して再書き込み。書き込めなければ fail-closed(開始時は LLM を呼ばず、describe より後の Gateway 呼び出しもしない。終了時は回答を返さない)。終了処理(Answer の組み立て・最終状態の記録)で例外が起きても AnswerRun を `error` で閉じる。質問の原文・回答本文・タイトル・URL は書かない(質問は SHA-256 のみ)
- citedDocIds(H2): `<sourceId>:<documentId>` を注入された分類(`docIdAudit`)で gateway の redaction(docid.ts)に通す。Slack は常に記録しない、プライベートスコープは `hashed`(デプロイ固有鍵の HMAC)/ `omitted`(記録しない)、分類できないソースは記録しない(fail-closed)。`hashed` で鍵がない構成は構築時に拒否する

## 脚本テストの書き方

`ScriptedLlmClient` は、直前のツール結果を見て次の応答を返す関数の配列(または全ターン共通の関数)を受け取る。テストの Gateway は `test/helpers/harness.ts` の `startGateway` で起動する(実 Gateway を port 0 で listen、コーパス型のモックコネクタ、スタブの資格情報)。

```ts
const harness = await startGateway({ connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])] });
const llm = new ScriptedLlmClient([
  () => scriptedToolUse([{ name: "search", input: { source: "alpha", query: "締め日" } }]),
  (context) => {
    const hit = firstHit(context); // 直前の search のヒット(test/helpers/script.ts)
    return scriptedSubmit({
      answer: "経費精算の締め日は毎月25日です。",
      citations: [{ documentId: hit.documentId, sourceId: hit.source }],
      confidence: 0.9,
    });
  },
]);
const answer = await new Orchestrator({ llm, auditLogger: harness.auditLogger })
  .run({ question: "締め日は?", userId: "alice", gateway: harness.client() });
```

- `context.lastToolResults`(パース済みのツール結果)、`context.lastUserTexts`(催促・最終ターンの指示)、`context.request`(system / messages / tools)で分岐できる
- `new ScriptedLlmClient(script, { provider, capabilities })` で、能力の違うバックエンド(OpenAI 互換など)に対する要求の組み方・価格表の引き当てを検証できる(既定は Anthropic と同じ)
- `scriptedToolUse(calls, { usage, model })` で使用量を与えると費用上限の挙動も再現できる。`context.signal` に従えば時間上限の中断も再現できる
- 秘密情報の実値をテストに書かない(ダミーは `dev-only-...`)

## モック API サーバーでの e2e

実 LLM を使わずに HTTP の形まで通すため、テストにモック API サーバーを内蔵している(`node:http`、127.0.0.1 の port 0)。CI で両経路を固定する。

- `test/helpers/mock-anthropic-server.ts`: `POST /v1/messages` を受け、脚本どおりに Messages API 形式(content blocks・`stop_reason`・`usage`)で応答する。要求本文と、`x-api-key` / `Authorization` ヘッダの有無(値は記録しない)・`anthropic-version` を記録する
- `test/helpers/mock-openai-server.ts`: `POST /v1/chat/completions` を受け、脚本どおりに `choices[0].message`(`content` / `tool_calls`)・`finish_reason`・`usage` で応答する。`Authorization` ヘッダの有無とスキームを記録する(値は記録しない)
- 脚本は「受けた要求を読んで次の応答を返す関数」の配列。要求の直前のツール結果を `ScriptedLlmClient` と同じ形(`lastToolResults` / `lastUserTexts`)に読んで渡すので、`test/helpers/script.ts` の `firstHit` 等をそのまま使える。脚本内の例外は `scriptErrors` に記録される
- `test/e2e-anthropic-mock.test.ts`: 実 Gateway + `AnthropicLlmClient`(公式 SDK を `new Anthropic({ baseURL: モック, apiKey: "dev-only-key" })` で明示注入)+ モック。1発ヒット / 再検索 / 未解決 / 未接続ソース、要求の形(model・strict・thinking・effort・tool_choice・system の固定部が先頭)、`max_tokens`・429
- `test/e2e-openai-compatible-mock.test.ts`: 実 Gateway + `createLlmClient({ provider: "openai_compatible", baseUrl: モック })` + モック。同じ4シナリオ、要求の形(messages・tools・`strict` なし・`tool_choice`・`stream: false`)、`arguments` が壊れた JSON、`finish_reason: length`、催促、429 の再試行、`Authorization` / `reasoning_effort` / 追加ヘッダ、kp-ask(フラグ・環境変数・401)

脚本だけの単体経路(`ScriptedLlmClient`)は高速な検証として残している。

## プロンプトの変更

固定部は `prompts/explore.v2.md`、制御メッセージ(催促・最終ターンの指示・ソース一覧とツール結果・ツールエラーの前置き)は `src/prompt.ts`。変更する PR には評価レポート(T-008)を添付する。挙動が変わる改訂はファイルを `explore.v3.md` として追加し、`EXPLORE_PROMPT_VERSION` を上げる。v2 はセキュリティレビュー(2026-09-27)でソース一覧を user ターンへ移し、回答本文に URL を書かない方針にした版(v1 は評価結果がないまま置き換えた。T-008 の評価レポートは未添付)。

## 既知の限界

- **実走未検証**: Claude API の資格情報が用意されるまで、モデル・effort・max_tokens の既定値、プロンプトの効き、キャッシュの効き(`cache_read_input_tokens`)は未計測。OpenAI 互換(LM Studio + gpt-oss 等)も実モデルでは未検証で、モックでの e2e のみ
- **OpenAI 互換の限界**: プロンプト(`prompts/explore.v2.md`)は Claude を前提に書いており、オープンウェイトのモデルで同じ効きになる保証はない(バックエンド別の派生を `prompts/` に置いてよい。ADR-017)。strict がないため引数の形は保証されず、壊れた引数の呼び出しは実行せずに不正な入力として返す。submit_answer の引数が壊れていると再提出を求めずに unresolved で終える(再提出させるかは T-008 の計測を見て決める)。推論の過程(`reasoning_content` 等の非標準フィールド)は履歴に戻さない。`max_tokens` を送る(OpenAI 本家の o 系・推論モデルは `max_completion_tokens` のみを受けるため対象外)。プロンプト+`max_tokens` がコンテキスト長を超える要求を 400 で拒否するサーバー(vLLM 等)では `maxTokensPerTurn` を下げる
- **評価ハーネス(T-008)未実装**: 解決率・引用正確性・インジェクション耐性(RS-3 / RS-4)の率は測れていない
- **Slack コネクタ未実装**: Slack コネクタ(T-006)は法務確認待ち。citedDocIds の分類は注入式で実装済み(Slack は記録しない、分類できないソースは記録しない)。分類器の組み立ては kp-ask の `--config` と同じ規則(`docIdAuditFromDeployment`)を、リファレンス構成(T-012)の Orchestrator 組み込み時に使う
- **回答本文の URL の検出の限界**: スキーム・`www.`・`//`・パス/クエリのない裸のドメイン名(`evil.example`)とメールアドレスは残す(ファイル名等と区別できない)。利用側は fuzzy な自動リンク(裸のドメインのリンク化)を無効にし、外部画像を自動取得しない(T-009)。検出は保守的(fail-closed)で、`Node.js/Express` のような表記やコード片の中の URL も除去される(除去は warnings に出る)。ゼロ幅接合子(ZWJ)も除くため、絵文字の合成列は分かれて表示される
- **AnswerRun の書き手**: Gateway と同じ監査ストアを共有する構成が前提。別プロセス構成では Gateway 側の run 登録の口が要る(将来 ADR)
- **フィードバックの保持**: `recordFeedback` はプロセス内に覚えている run(既定 1000 件)に対してだけ使える
- **iteration と T-014**: iteration は「run 内のツール呼び出しの通番」。昇格判定レポート(T-014)の再検索回数(search の max(iteration)+1)とは意味がずれている(ADR-017 確認事項4)
- **ストリーミングなし**: 途中経過の表示は T-009 で必要になった時点で検討する
- **deployment.yaml 未結合**: 設定は自パッケージの zod スキーマで受ける。deployment.yaml の `orchestrator` セクションとの結合は後続タスク
