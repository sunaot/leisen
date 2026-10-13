# @leisen/orchestrator — 探索戦略 v1(T-007)

利用者の質問に対し、LLM が Gateway 経由のツール(search / fetch / list / describe)を反復して呼び、出典付きで回答する探索ループ(product-design §4.3)。LLM バックエンドは設定で選ぶプラグイン境界で、参照実装は Anthropic Messages API(`AnthropicLlmClient`)と OpenAI 互換 Chat Completions(`OpenAiCompatibleLlmClient`。LM Studio / vLLM / llama.cpp server / Ollama 等)の2つ。設計判断は [ADR-017](../../docs/adr/ADR-017-orchestrator-llm-client.md)(Proposed、人間レビュー待ち)。

利用者向けの面は2つ: 1問ずつ答える CLI `leisen-ask` と、チャット UI などの MCP クライアントから使う MCP サーバー `leisen-ask serve`(下記「leisen-ask serve(MCP サーバー)」、[ADR-018](../../docs/adr/ADR-018-orchestrator-mcp-server-and-chat-ui.md)、T-021)。

run の記録(AnswerRun)の書き手は Gateway で、Orchestrator は申告者([ADR-019](../../docs/adr/ADR-019-gateway-run-api.md) 段階 1、T-023)。run の開始・終了・利用者フィードバックは Gateway の run API(`POST /runs` / `POST /runs/{runId}/finish` / `POST /runs/{runId}/feedback`)に申告し、runId は Gateway が発行する署名付きの値を使う。Orchestrator は監査ストアに触れず、監査用の鍵(docId の HMAC 鍵・runId の署名鍵)も持たない(下記「run の記録(AnswerRun)と昇格判定レポート」)。

**実モデルでの実走は OpenAI 互換(LM Studio)で初めて確認しました(2026-10-08、合成コーパスの 4 問。[評価レポート](../../docs/eval/2026-10-08-explore-v3.md))。Claude API での実走は未確認です。** 自動テストは脚本(`ScriptedLlmClient`)と、テスト内蔵のモック API サーバー(Anthropic 形式・OpenAI 互換形式)を相手にした e2e で行っています(下記「モック API サーバーでの e2e」)。手元で実モデルを使った回帰チェックは下記「dev-eval(合成コーパスでの簡易評価)」。

## 使い方(leisen-ask)

Gateway(`POST /mcp`)を起動した状態で(起動構成はリファレンスデプロイ T-012):

```sh
npm run build -w @leisen/orchestrator
export LEISEN_SESSION_TOKEN=...          # 利用者のセッショントークン(Gateway の IdP が検証する)
export ANTHROPIC_API_KEY=...         # または `ant auth login` のプロファイル
export LEISEN_ORCHESTRATOR_CREDENTIAL=... # Gateway と共有する Orchestrator の資格情報(手元の開発では省略可。下記)
node packages/orchestrator/dist/bin/leisen-ask.js \
  --gateway http://127.0.0.1:8787/mcp \
  "経費精算の締め日はいつ?"
```

| オプション | 内容 |
|---|---|
| `--gateway <URL>` | Gateway の MCP エンドポイント(必須)。ループバック(`localhost` / `127.0.0.1` / `[::1]`)以外は `https` 必須(`--allow-insecure-upstream` のときだけ例外)。資格情報・クエリ・フラグメントを含む URL は拒否する |
| `--token <トークン>` | セッショントークン。プロセス一覧に残るため環境変数 `LEISEN_SESSION_TOKEN` を推奨 |
| `--llm <種類>` | LLM バックエンド。`anthropic`(既定)/ `openai-compatible`。環境変数 `LEISEN_LLM_PROVIDER` でも指定可 |
| `--model <ID>` | モデル ID。anthropic は既定 `claude-opus-5`、openai-compatible は必須(サーバーでロードしたモデル名)。環境変数 `LEISEN_LLM_MODEL` でも指定可 |
| `--effort <level>` | anthropic のみ。`low` / `medium` / `high` / `xhigh` / `max`(既定 `high`) |
| `--llm-base-url <URL>` | openai-compatible のみ・必須。ベース URL(例: LM Studio は `http://localhost:1234/v1`)。環境変数 `LEISEN_LLM_BASE_URL` でも指定可(anthropic では使わない。Claude API の接続先は SDK 標準の `ANTHROPIC_BASE_URL` で変える) |
| `--llm-api-key-env <名前>` | openai-compatible のみ。API キーを入れた**環境変数の名前**(キーの値そのものは渡さない)。LM Studio 等キー不要のサーバーでは省略 |
| `--reasoning-effort <level>` | openai-compatible のみ。`low` / `medium` / `high`(`reasoning_effort` に対応するモデルのみ。指定したときだけ送る) |
| `--allow-insecure-upstream` | 環境変数 `LEISEN_ALLOW_INSECURE_UPSTREAM=1` でも可。Gateway の URL と LLM のベース URL について、ループバック以外の `http` を許す(開発・評価用途。`NODE_ENV=production` では固定文言で拒否して終了コード 2。有効時は平文 http の上流をホスト名で列挙した WARNING を stderr に1行) |
| `--max-iterations <N>` | ツールを呼べるターン数の上限(1〜20、既定 6) |
| `--user-id <ID>` | 照合用の質問者の申告(環境変数 `LEISEN_USER_ID` でも可)。AnswerRun に記録されるのは Gateway が `POST /runs` の Bearer で認証した userId で、申告と食い違えば run は `error`(`user_mismatch`)。省略時は照合しない |
| `--config <deployment.yaml>` | 任意。`orchestrator` セクション(`maxIterations` / `costLimitPerQuery`)を探索の設定にする(`--max-iterations` が優先)。citedDocIds の記録方針(Slack・プライベートスコープ)は Gateway が run API でかけるため、ここでは読まない(ADR-019 決定5)。読めない・不正なら終了コード 2。省略時は既定の設定で動く |
| 環境変数 `LEISEN_ORCHESTRATOR_CREDENTIAL` | Gateway と共有する Orchestrator の資格情報(16 文字以上、空白を含まない。Gateway 側は `gateway.runs.orchestratorCredentialEnv`、既定で同名の環境変数)。run API と、runId を申告する tools/call に HTTP ヘッダ `x-leisen-orchestrator-credential` で付ける。未設定なら開発用の既定値(`dev-only-orchestrator-credential`。Gateway も未設定で動いているときだけ通る)で動き、stderr に WARNING を1行出す。`NODE_ENV=production` では必須で、ないと固定文言で終了コード 2。値は表示・ログに出さない(`src/bin/credential-options.ts`) |
| `--json` | Answer を JSON で出力する。回答を返せない失敗でも stdout に JSON を1つ出す(下記「leisen-ask の出力契約」) |

- 表示: 回答・出典(タイトル、`sourceId:documentId`、原典 URL)・検索したソース・未接続でスキップしたソース・結果と確信度・使用量(トークン、LLM ターン、ツール呼び出し回数、概算費用)・警告・runId(Gateway が発行した署名付きの値)。回答本文には URL を含まない(原典 URL は出典の欄に出す)
- 監査: run の記録(AnswerRun)は Gateway の run API に申告し、Gateway が ToolInvocation と同じ監査ストアに書く(ADR-019)。leisen-ask は監査ストアに触れず、AnswerRun を stderr にも出さない。昇格判定レポート(`leisen-promotion-report --audit`)は Gateway の `audit.jsonl` を読む(下記「run の記録(AnswerRun)と昇格判定レポート」)
- 終了コード: 0 回答した(resolved / unresolved)、1 実行時エラー(Gateway が run を受け付けない(`run_not_accepted` / `orchestrator_credential_rejected` / `rate_limited` / `gateway_unauthenticated`)・run の終了を記録できない(`audit_write_failed`)・利用者の不一致など。失敗の表現には `errorClass` を添える。openai-compatible で接続できない・要求を拒否されたときは確認の手がかりを stderr に添える)、2 引数・設定の不備(`NODE_ENV=production` で `LEISEN_ORCHESTRATOR_CREDENTIAL` がない・16 文字未満を含む)、または LLM バックエンドの資格情報が無い・無効(プロバイダごとの案内を表示)。`--json` の有無で終了コードは変わらない
- `npm ci && npm run build` の後は `npx leisen-ask ...` でも起動できる(npm の bin は起動シム `bin/leisen-ask.js`。dist がなければ `Run npm run build first.` と表示して終了コード 1)。`--json` / `--help` を付けるときは `npx -- leisen-ask --json …` のように `--` を挟む(挟まないと npm 自身もそのオプションを解釈し、`--json` では失敗時に npm のエラー JSON が stdout に足される)

### leisen-ask の出力契約(`--json`)

`--json` を付けると、stdout に JSON を**1つだけ**出す(2つの形のどちらか)。案内・警告は従来どおり stderr(AnswerRun は Gateway の監査に残り、leisen-ask は出さない)。

| 状況 | 終了コード | stdout の JSON |
|---|---|---|
| 回答した(`resolved` / `unresolved`) | 0 | Answer(`runId` / `answer` / `citations` / `searchedSources` / `skippedSources` / `confidence` / `outcome` / `usage` / `warnings`。`answerSchema`) |
| run が `error` で終わった(Gateway・LLM の失敗、利用者の不一致など) | 1 | Answer(`outcome: "error"`。`answer` に分類ごとの説明と正規化コード。下記「失敗の文言」) |
| run が例外で終わった(Gateway が run の開始を受け付けない `run_not_accepted` / `orchestrator_credential_rejected` / `rate_limited` / `gateway_unauthenticated`、終了を記録できない `audit_write_failed` 等) | 1 | 失敗の表現(`errorClass` は `GatewayClientError` / `OrchestratorError` の分類。Gateway の 401 は `gateway_unauthenticated`。想定外は `internal_error`) |
| 引数の不備(`--gateway` / `--token` / 質問文 / オプションの値、Gateway の URL の形式、環境変数 `LEISEN_ORCHESTRATOR_CREDENTIAL` の不備(`NODE_ENV=production` で未設定、16 文字未満・空白を含む)) | 2 | 失敗の表現(`errorClass: "invalid_arguments"`) |
| 設定の不備(`--config` を読めない・不正、クライアントを初期化できない) | 2 | 失敗の表現(`errorClass: "invalid_configuration"`) |
| LLM バックエンドの資格情報が無い・無効 | 2 | 失敗の表現(`errorClass: "llm_credentials_missing"` / `"llm_authentication_failed"`、`runId` 付き) |

失敗の表現(回答を返せなかったとき):

```json
{ "outcome": "error", "errorClass": "invalid_configuration", "message": "…", "runId": "…" }
```

- Answer の失敗(`outcome: "error"`)に揃えて `outcome` を持つ。回答本文の代わりに `message`(利用者向けの説明。stderr に出す文言と同じ)、正規化コード `errorClass`(lower snake_case。`leisen-ask serve` の `structuredContent.errorClass` と同じ規約)を持つ。`runId` は run を始めた後の失敗(LLM の資格情報の不備)だけで、Gateway の監査の AnswerRun と突き合わせられる。run の開始を Gateway が受け付けなかった失敗には runId がない
- 見分け方: `answer` を持てば Answer、持たずに `errorClass` / `message` を持てば失敗の表現。どちらも失敗なら `outcome` は `"error"`
- トークン・API キー・Orchestrator の資格情報・URL の中身は含めない(Gateway の URL の誤りも固定文言)
- Answer の形(`answerSchema`)は変えていない(strict のまま検証できる)

### 失敗の文言(outcome: error の `answer`)

run が `error` で終わったときの回答文は、失敗の分類ごとに次に何をすべきかを示す(`src/failure-text.ts`。以前は分類のない失敗が一律「時間をおいて再度お試しください」だった)。正規化コード(AnswerRun の `failureReason`)を括弧で添え、URL・ホスト名・トークン・上流の生のメッセージは含めない。文言は leisen-ask とチャット UI(`leisen-ask serve`)の両方に出る。

| 分類 | 正規化コード | 文言の要点 |
|---|---|---|
| 設定・接続先の誤り | `gateway_protocol_error`(接続先が MCP エンドポイントでない、400 / 404 / 405 / 406 / 415)、`gateway_rejected`(その他の拒否)、`no_searchable_sources`、`user_unverified`(Gateway が利用者を報告しない=対応していない版)、`orchestrator_credential_rejected`(run API の資格情報が Gateway と一致しない)、`llm_invalid_request`(400 / 404 / 422、モデル名・接続先の誤り) | 接続先・設定を確認する。利用者は管理者に連絡する |
| 資格情報の無効・期限切れ | `gateway_unauthenticated`(401)、`gateway_forbidden`(403)、`user_mismatch`、`llm_credentials_missing` / `llm_authentication_failed` / `llm_permission_denied` | Gateway はサインインし直す。LLM は管理者が資格情報・権限を確認する |
| 一時的な障害 | `gateway_unavailable`(408 / 429 / 5xx・接続失敗)、`gateway_timeout`、`run_timeout`、`run_not_accepted` / `rate_limited` / `audit_write_failed`(run API)、`llm_rate_limited` / `llm_overloaded` / `llm_unavailable` / `llm_timeout` | 時間をおいて再度試す。続く場合は管理者に連絡する |
| 質問・応答の内容や長さ | `llm_refusal`、`llm_max_tokens`、`llm_context_window_exceeded` | 質問の表現を変える・範囲を絞る |
| 不明 | 上記以外(`llm_client_error` / `llm_unexpected_response` / `internal_error` 等) | 再度試し、続く場合は runId を添えて管理者に連絡する |

「時間をおいて再度お試しください」は一時的な障害にだけ出す(待っても直らない失敗で待たせない)。`gateway_forbidden` は Gateway への HTTP 403(Gateway の前段のプロキシ等が返すもの。Gateway 自体は HTTP 層で 403 を返さない)を `gateway_rejected` から分けた分類。run API の分類(`run_not_accepted` / `orchestrator_credential_rejected` / `rate_limited` / `audit_write_failed`)は leisen-ask では run が例外で終わる(失敗の表現)ので回答文には出ず、`leisen-ask serve` の `ask` / `feedback` の固定文言に使う。

### 監査用の鍵は Gateway が持つ

citedDocIds の記録の規則(Slack は記録しない、プライベートスコープは `audit.privateScopeDocIds` の規則で HMAC)とその鍵 `LEISEN_AUDIT_HMAC_KEY`(Gateway の `audit.docIdHmacKeyEnv`)、runId の署名鍵 `LEISEN_RUN_ID_KEY` は Gateway だけが持つ(ADR-019 決定1・5)。leisen-ask / leisen-ask serve には渡さない(渡しても読まない)。鍵の生成と置き場(リファレンス構成では `deploy/compose/.env`)は docs/install.md §5。Orchestrator 側が持つ秘密は、利用者のセッショントークンと `LEISEN_ORCHESTRATOR_CREDENTIAL`(Gateway と共有する資格情報。鍵とは別の値)だけ。

## leisen-ask serve(MCP サーバー)

Orchestrator を MCP サーバー(Streamable HTTP、ステートレス)として公開する(T-021、[ADR-018](../../docs/adr/ADR-018-orchestrator-mcp-server-and-chat-ui.md))。チャット UI(LibreChat 等)や MCP クライアント(Claude Code、MCP Inspector、自作エージェント)から、利用者本人のトークンで `ask` / `feedback` を呼ぶ。LibreChat との接続手順は [docs/ui-librechat.md](../../docs/ui-librechat.md) を参照。

```sh
npm run build
export LEISEN_ORCHESTRATOR_CREDENTIAL=... # Gateway と共有する Orchestrator の資格情報(手元の開発では省略可。NODE_ENV=production では必須)
export ANTHROPIC_API_KEY=...          # LLM バックエンドの資格情報(leisen-ask と同じ。起動時には接続しない)
npx leisen-ask serve \
  --gateway http://127.0.0.1:8787/mcp \
  --config examples/deployment.dev.yaml
# leisen-ask serve: listening on http://127.0.0.1:8790/mcp (health check: http://127.0.0.1:8790/healthz)
```

| オプション | 既定 | 内容 |
|---|---|---|
| `--gateway <URL>` | (必須) | Gateway の MCP エンドポイント。ループバック以外は `https` 必須(`--allow-insecure-upstream` のときだけ例外)。資格情報・クエリ・フラグメントを含む URL は拒否(leisen-ask と同じ規則) |
| `--config <deployment.yaml>` | (必須) | 探索の上限(`orchestrator.maxIterations` / `costLimitPerQuery`)、永続化不可のソースの判定(不変条件7)、Gateway のソースとの照合(下記)に使う。citedDocIds の記録方針は Gateway が run API でかけるため読まない(ADR-019 決定5)。読めない・不正なら終了コード 2 |
| `--listen <ホスト:ポート>` | `127.0.0.1:8790`(環境変数 `LEISEN_LISTEN`) | 待ち受け。IPv6 は `[::1]:8790`。ループバック以外は `--confirm-exposed-host` が必要 |
| `--path <パス>` | `/mcp` | MCP エンドポイントのパス(`/healthz` は不可) |
| 環境変数 `LEISEN_ORCHESTRATOR_CREDENTIAL` | 開発用の既定値(WARNING) | Gateway と共有する Orchestrator の資格情報(leisen-ask と同じ規則。16 文字以上)。`ask` / `feedback` の Gateway クライアント(run API と runId を申告する tools/call)に付ける。preflight の `tools/list` には付けない。`NODE_ENV=production` では必須で、ないと固定文言で終了コード 2 |
| `--max-concurrent-runs <N>` | 4 | 同時に実行する run の上限(1〜256)。超えた `ask` は待たせずに `busy` |
| `--max-question-chars <N>` | 4000 | 質問の長さの上限(1〜10000、前後の空白を除いた文字数)。超えた `ask` は `question_too_long` |
| `--confirm-exposed-host` | なし | ループバック以外で待ち受ける確認(TLS を終端するリバースプロキシを前段に置く前提。Gateway の `confirmExposedHost` と同じ規約) |
| `--allow-non-persistable-sources` | なし | 永続化不可のソース(Slack)が有効な構成で起動する(下記「不変条件7」) |
| `--llm` / `--model` / `--effort` / `--llm-base-url` / `--llm-api-key-env` / `--reasoning-effort` | leisen-ask と同じ | LLM バックエンド(環境変数 `LEISEN_LLM_PROVIDER` / `LEISEN_LLM_MODEL` / `LEISEN_LLM_BASE_URL` も同じ)。クライアントは起動時に1回作り、接続はしない |
| `--allow-insecure-upstream` | なし(環境変数 `LEISEN_ALLOW_INSECURE_UPSTREAM=1`) | Gateway の URL(`--gateway`)と LLM のベース URL(`--llm-base-url`)の両方について、ループバック以外の `http` を許す(開発・評価用途)。`NODE_ENV=production` では固定文言で拒否して終了コード 2。有効時は平文 http の上流をホスト名だけで列挙した WARNING を起動ログに1行 |

- リファレンス構成の LibreChat overlay(`deploy/compose/docker-compose.librechat.yml`)は、compose のネットワーク内の Gateway(`http://gateway:8787/mcp`)とホストの LM Studio(`http://host.docker.internal:1234/v1`)に平文の http で接続するため `--allow-insecure-upstream`(または `LEISEN_ALLOW_INSECURE_UPSTREAM=1`)を使う。平文の http では利用者のトークンと会話(利用者の権限で取得した文書の本文)が経路上で読めるので、本番では上流を https(またはループバック)にする
- 起動ログ(stderr): `listening on …`、`deployment: …`、`gateway: <スキーム://ホスト:ポート>`(パス・クエリは出さない)、`run api: gateway (orchestrator credential: env LEISEN_ORCHESTRATOR_CREDENTIAL)`(開発用の既定値なら `development default` と WARNING を1行)、`limits: max-concurrent-runs=… max-question-chars=… max-iterations=…`、`llm: <プロバイダ> (model: …)`(`--allow-insecure-upstream` で平文の http の上流があるときは、そのホスト名を列挙した WARNING を1行)。トークン・API キー・Orchestrator の資格情報・環境変数の値は出さない
- 終了コード: 0 停止の合図(SIGINT / SIGTERM)で正常に止まった、1 起動の拒否(不変条件7・公開境界・探索プロンプトがない・待ち受けの失敗。ポートが使用中なら `--listen`(`LEISEN_LISTEN`)での変え方を案内する)や停止時に進行中のリクエストが残った、2 引数・設定の不備(`--config` が読めない、`NODE_ENV=production` で `LEISEN_ORCHESTRATOR_CREDENTIAL` がない等)。`leisen-ask serve --help` で使い方
- 停止: SIGINT / SIGTERM で受付を止め、進行中のリクエスト(run を含む)の応答を返し終えるまで最大 30 秒待つ。残ったものは接続を切って終了コード 1(2回目の合図は即時終了)
- ライブラリとして組む場合は `createOrchestratorHttpServer({ orchestrator, gatewayUrl, orchestratorCredential, limits: new ServerLimits(...), sourcePolicy, feedbackTimeoutMs }, { path, maxBodyBytes, preflightTimeoutMs })`(`src/server/http.ts`)。`orchestratorCredential` を省くと Gateway の run API が拒否するので `ask` は失敗する。`sourcePolicy`(下記「Gateway のソースと --config の照合」)を省くと照合しない。`feedbackTimeoutMs` は feedback の申告の期限(既定 10 秒)。`ServerLimits` の `maxConcurrentFeedback`(既定 4)で feedback の同時実行数を変えられる

### 認証の規約(Gateway に委譲)

- MCP クライアントは全リクエスト(`initialize` / `tools/list` / `tools/call`)に `Authorization: Bearer <トークン>` を付ける。トークンは **IdP(Keycloak 等)が利用者に発行したアクセストークン**で、Gateway が検証するものと同じ
- Orchestrator は IdP を持たず、トークンを検証しない。リクエストごとに、そのトークンで Gateway の `tools/list` を呼んで(preflight)Gateway の判断に従う。結果はキャッシュしない(失効に次のリクエストで従う)。preflight(initialize → notifications/initialized → tools/list)の全体に 10 秒の期限を置く。JSON-RPC の本文を読む前に次のとおり拒否し、LLM もソースも呼ばない:

| 状況 | HTTP | `error.data.errorClass` |
|---|---|---|
| `Authorization` がない・`Bearer` でない・形式不正 | 401(`WWW-Authenticate: Bearer`。Gateway にも問い合わせない) | `unauthenticated` |
| Gateway がトークンを拒否 | 401(`WWW-Authenticate: Bearer error="invalid_token"`) | `unauthenticated` |
| Gateway に届かない・5xx(IdP 不達の 503 を含む)・preflight 全体の期限(10 秒)切れ | 503 | `gateway_unavailable` |
| それ以外(Gateway の URL のパスの誤り等) | 500 | `internal_error` |

- 本文は preflight の後に読む。上限は 64 KiB(ライブラリでは `maxBodyBytes`)で、超えたら 413 `payload_too_large`(応答後に接続を閉じる)。JSON-RPC のバッチ(配列)は 400 `invalid_request`(1回の POST に ask / feedback を並べて Gateway・LLM への呼び出しを増幅させない。1 POST に 1 メッセージ)。JSON のオブジェクトとして読めない本文も 400 `invalid_request`。いずれも Gateway への呼び出しは preflight の `tools/list` だけ
- 拒否の本文は Gateway と同じ形(`{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":<固定文言>,"data":{"errorClass":…}}}`)。トークン・Gateway 由来の文言は含めない
- `GET` / `DELETE` の MCP エンドポイントは 405(`Allow: POST`)、未知のパスは 404、`GET /healthz` は認証不要で `{"status":"ok"}`
- `ask` の run では、AnswerRun の userId は Gateway が `POST /runs` の Bearer で認証した userId(H1。Gateway が認証値で書くので、呼び出し元は指定できない)。実行区分は human_in_the_loop / actor human 固定(ADR-015)。`ask` / `feedback` の Gateway への接続には利用者のトークンに加えて Orchestrator の資格情報(`LEISEN_ORCHESTRATOR_CREDENTIAL`)を付ける(preflight には付けない)

### ツール `ask`

入力 `{ "question": string }`(1〜`--max-question-chars` 文字。他のプロパティは不可)。処理の順: Gateway のソースと `--config` の照合(下記「不変条件7」)→ 引数の検証 → 質問長 → 同時実行の枠 → run(利用者のトークンと Orchestrator の資格情報で Gateway に接続。開始・終了は Gateway の run API に申告する。接続を含め run の時間上限が効く)。

text(Markdown。Answer 表示契約の v1、ADR-018 決定6):

```
{注意書き: outcome が resolved 以外で、本文の先頭に既知の注意書きがないとき}

{本文: Answer.answer。無害化済みで URL を含まない}

## 出典
- [1] {title}(`{sourceId}:{documentId}`)— <{url}>
(出典が 0 件なら「出典: なし」)

runId: `{runId}`
```

- 出典の url は `http:` / `https:` の絶対 URL だけを描画する(`javascript:` / `data:` / 相対 URL / 資格情報付きは url を省く)。url は正規化形を CommonMark の自動リンク `<…>` で囲む(URL のパスの `[` `]` `(` `)` はエンコードされないため、裸で描くと `…/a[公式](https://evil/x)` から別のリンクが作れる)。title はソース由来の文字列なので、制御文字を除き、本文と同じ無害化(リンク・画像・HTML・URL の除去)を通して Markdown の記号をエスケープする。ID はコードスパン。本文が閉じていないコードフェンスで終わっていれば閉じてから出典節を足す
- runId は `feedback` に渡す識別子(Gateway が発行した署名付きの値。利用者の識別子は平文で含まない)。structuredContent を LLM に渡さないクライアントのため text の末尾にも置く

structuredContent: Answer の全フィールド(`runId` / `answer` / `citations` / `searchedSources` / `skippedSources` / `confidence` / `outcome` / `usage` / `warnings`)+ `retentionClass`(v1 は `persistable`。`--allow-non-persistable-sources` で起動したときだけ `non_persistable`)+ outcome が resolved 以外なら `errorClass`(AnswerRun の failureReason と同じ正規化コード。例 `no_citations` / `model_reported_unresolved` / `llm_unavailable` / `gateway_unauthenticated`)。`citations` は text の出典欄と同じ規則で無害化済み(`title` は制御文字・リンク・HTML・URL を除いたもの。Markdown のエスケープはしない。`url` は出典欄に描く http / https の正規化形だけで、それ以外は省く)。ツール定義の `outputSchema` はこの形と、エラー形 `{ "errorClass": … }` のどちらかに合う JSON Schema(`anyOf`。SDK の Client はこれで structuredContent を検証する)。

| 結果 | `isError` | text | `structuredContent` |
|---|---|---|---|
| resolved / unresolved | なし | 上の Markdown | Answer + `retentionClass`(+ unresolved は `errorClass`) |
| outcome: error(LLM・Gateway の失敗など) | true | 上の Markdown(先頭に注意書き) | Answer + `retentionClass` + `errorClass` |
| 質問が長すぎる | true | 「質問が長すぎます(N 文字まで)。…」 | `{ errorClass: "question_too_long" }` |
| 同時実行の上限 | true | 「混み合っています。しばらくして再度お試しください。」 | `{ errorClass: "busy" }` |
| Gateway のソースが `--config` と食い違う(下記) | true | 固定文言(ソース名は出さない) | `{ errorClass: "config_mismatch" }` |
| 空の質問・不正な引数 | true | 固定文言 | `{ errorClass: "invalid_request" }` |
| run が例外で終わった(Gateway が run を受け付けない・終了を記録できない等) | true | 分類ごとの固定文言(`src/server/tools.ts` の `ASK_FAILURE_TEXTS`。表にない分類は「失敗の文言」の分類ごとの文言) | `{ errorClass: "run_not_accepted" / "orchestrator_credential_rejected" / "rate_limited" / "audit_write_failed" / "gateway_unauthenticated" など }` |

initialize の `instructions`: 「ask の結果の本文と出典節は改変・要約・言い換えをせず、そのまま利用者に提示する」「リンクは出典節の URL だけを使う」「outcome が resolved 以外のときは注意書きを省かない」「feedback は利用者が解決した / しなかったと明示したときだけ呼ぶ」。最終文面を書くのは UI 側の LLM なので、出典の保証はツール境界までで、instructions とツール定義の文言で抑えるにとどまる(ADR-018 帰結)。

### ツール `feedback`

入力 `{ "runId": string, "outcome": "resolved" | "unresolved" }`。利用者のトークンと Orchestrator の資格情報で Gateway の run API(`POST /runs/{runId}/feedback`)に申告する(ADR-019 決定8)。本人と期間の検証は Gateway が runId の署名で行い(質問した本人が、runId の発行から `gateway.runs.feedbackWindowSec`(既定 7 日)の間だけ記録できる)、Gateway の監査ストアに `answer_run_feedback`(部分レコード)として残る。`leisen-ask serve` はプロセス内に run を覚えず、再起動後の run にも記録できる。本人確認のための `describe` と別 runId の採番はしない。往復には 10 秒の期限(`feedbackTimeoutMs`、既定 `FEEDBACK_TIMEOUT_MS`)を置く。

| 結果 | `isError` | `structuredContent` |
|---|---|---|
| 記録した | なし | `{ runId, outcome }` |
| 同時実行の上限(`maxConcurrentFeedback`、既定 4。ask とは別枠) | true | `{ errorClass: "busy" }` |
| Gateway のソースが `--config` と食い違う | true | `{ errorClass: "config_mismatch" }` |
| Gateway が runId を受け付けない(他人の run・期間外・不明な runId・別の署名鍵。理由は区別しない。文言「この回答にはフィードバックを記録できません(質問した本人が、回答から一定の期間内に記録できます)。」) | true | `{ errorClass: "run_not_accepted" }` |
| Gateway が利用者の認証を拒否(文言「利用者を確認できなかったため、フィードバックを記録していません。…」) | true | `{ errorClass: "gateway_unauthenticated" }` |
| Orchestrator の資格情報を Gateway が拒否(設定のずれ) | true | `{ errorClass: "orchestrator_credential_rejected" }` |
| 利用者ごとの頻度上限 | true | `{ errorClass: "rate_limited" }` |
| Gateway が監査ストアに書けない(fail-closed) | true | `{ errorClass: "audit_write_failed" }` |
| 往復が 10 秒の期限切れ | true | `{ errorClass: "gateway_timeout" }` |
| 不正な引数 | true | `{ errorClass: "invalid_request" }` |

### 不変条件7(永続化不可のソース)

汎用 UI は会話の履歴を保存するため、`--config` に kind が `slack` / `slack-*` のソースが有効なら起動を拒否する(終了コード 1。ADR-018 決定5、ADR-014)。`--allow-non-persistable-sources` で解除できるが、UI 側で一時チャットの強制と保持期間を設定し、法務確認を経ることが前提(docs/ui-librechat.md)。解除して起動した場合は起動ログに WARNING を出し、`ask` の `retentionClass` を `non_persistable` にする(describe の結果も LLM に渡るため、run 単位ではなくデプロイ単位で判定する)。

**Gateway のソースと --config の照合**: この判定は `--config` で行うため、Gateway が別の設定で動いていると Slack ソースを見逃す。そこでリクエストごとに、preflight で得た Gateway の `tools/list` の search のソース enum を `--config` の有効なコネクタと照合し、`--config` にない(または無効な)ソースがあれば、そのリクエストの `ask` / `feedback` を `config_mismatch`(isError、固定文言)にする(initialize / tools/list は通す)。`--allow-non-persistable-sources` のときは不一致を許し、`retentionClass` を `non_persistable` にする。`--config` には Gateway と同じ deployment.yaml を渡す。

### run の記録(AnswerRun)と昇格判定レポート

- AnswerRun は Gateway が書く(ADR-019 決定1・3、T-023)。`leisen-ask` / `leisen-ask serve` は run の開始(`POST /runs`: 質問・実行区分・actor)で署名付き runId を受け取り、終了(`POST /runs/{runId}/finish`: outcome・confidence・searchedSources・citations・failureReason)とフィードバック(`POST /runs/{runId}/feedback`)を申告する。Gateway は本人(Bearer)と Orchestrator の資格情報を確認し、pending の AnswerRun(`answer_run`)と部分レコード `answer_run_finish` / `answer_run_feedback` を ToolInvocation と同じ監査ストア(`audit.jsonl`)に追記する。質問の原文は `POST /runs` で Gateway の生クエリ表に入る(保持期間つき。ADR-019 決定7)
- fail-closed: 開始を Gateway が受け付けなければ LLM を呼ばない(runId がないので Answer もなく、`GatewayClientError`)。終了を記録できなければ回答を返さない(`audit_write_failed`。ADR-011 §4・ADR-019 決定6)
- Orchestrator は監査ストアのボリュームをマウントせず、Gateway の `audit.jsonl` にも別ファイルにも書かない。Gateway と別のホストに置けるが、利用者のトークンを扱うので置き場所は Gateway と同じ運用者の下に限る(ADR-019 決定2)。リファレンス構成の orchestrator コンテナは `deploy/compose/.env` から `LEISEN_ORCHESTRATOR_CREDENTIAL` だけを受け取り、Gateway が `LEISEN_RUN_ID_KEY` / `LEISEN_ORCHESTRATOR_CREDENTIAL` / `LEISEN_AUDIT_HMAC_KEY` を持つ
- 昇格判定レポートには Gateway の `audit.jsonl` を 1 つ渡す(pending の AnswerRun に finish / feedback を runId で統合する。以前の構成で別ファイルに書いた AnswerRun を読むための `--audit` の複数指定は残っている):

```sh
npx leisen-promotion-report \
  --audit var/audit.jsonl \
  --sources sources.json --accessor <監査閲覧担当の userId> --meta-audit-out var/meta-audit.jsonl
```

### 運用上の注意

- 1回の `ask` は探索の時間上限(`runTimeoutMs` 既定 120 秒)+ 最終ターン(`finalTurnTimeoutMs` 既定 60 秒)まで応答を返さないことがある。MCP クライアント側のツール呼び出しのタイムアウトはこれより長くする(SDK の既定は 60 秒)。クライアントが接続を切っても進行中の run は止めない(時間上限で終わる)
- 進捗のストリーミング(MCP の progress 通知)はしない(応答は単発 JSON)
- TLS・Host / Origin の検証・利用者単位の流量制御はリバースプロキシで担う(docs/install.md)。`--max-concurrent-runs` はプロセス全体の上限

## LM Studio で使う(OpenAI 互換バックエンド)

**実際の LM Studio で、合成コーパスの 4 問を通すところまで確認しました(2026-10-08。[評価レポート](../../docs/eval/2026-10-08-explore-v3.md))。精度は保証しません**(評価ハーネス T-008 で測るまで判断しない。ADR-017)。

1. LM Studio でツール呼び出し(function calling)に対応したモデルをロードする。gpt-oss 20B クラス以上を想定。探索ループはツール呼び出しが前提なので、非対応のモデルでは動かない
2. モデルのコンテキスト長は長めにとる(目安 16k トークン以上)。system prompt・ツール定義・ソース一覧・ツール結果(検索のスニペット、文書の本文)が毎ターン積み上がる
3. LM Studio のローカルサーバーを起動する(既定 `http://localhost:1234/v1`)。モデル名は `curl http://localhost:1234/v1/models` の `id` で確認できる
4. Gateway を起動した状態で実行する:

```sh
export LEISEN_SESSION_TOKEN=...
node packages/orchestrator/dist/bin/leisen-ask.js \
  --gateway http://127.0.0.1:8787/mcp \
  --llm openai-compatible --llm-base-url http://localhost:1234/v1 \
  --model <LM Studio のモデル名> \
  "経費精算の締め日はいつ?"
```

- LM Studio はキー不要なので `--llm-api-key-env` は付けない(`Authorization` ヘッダを送らない)。キーを要求するサーバー(vLLM の `--api-key` 等)では、キーを環境変数に入れて `--llm-api-key-env その変数名` を付ける
- `--llm-base-url` はループバック(`localhost` / `127.0.0.1` / `[::1]`)以外では `https` 必須(Gateway の URL と同じ規則。会話には取得した文書の本文が入る)。別のマシンの LM Studio / vLLM は https で公開するか、SSH のポート転送で localhost に向ける。開発・評価用途に限り `--allow-insecure-upstream` で平文の http を許せる(本番の `NODE_ENV=production` では拒否)
- `--config`(探索の設定)と `--user-id`(照合用)は省略できる。`LEISEN_ORCHESTRATOR_CREDENTIAL` は手元の開発では省略できる(開発用の既定値。Gateway も未設定のときだけ通る)
- ローカル推論は1ターンが遅いことがある。1リクエストのタイムアウトは 120 秒(`timeoutMs`)、run 全体の時間上限は `runTimeoutMs`(既定 120 秒)。上限に達すると、その時点の情報で回答を促す最終ターンを1回行う(警告に出る)
- 費用は価格表がないため「不明」と表示される(0 円とはみなさない)。`costLimitPerQuery` を設定していなければ探索は止まらない
- 環境変数で指定する場合: `LEISEN_LLM_PROVIDER=openai-compatible LEISEN_LLM_BASE_URL=http://localhost:1234/v1 LEISEN_LLM_MODEL=<モデル名>`

## 必要な資格情報

| 対象 | 渡し方 | 備考 |
|---|---|---|
| Claude API(`--llm anthropic`) | SDK が環境から解決(`ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → `ant auth login` のプロファイル → Workload Identity Federation) | コード・設定ファイルに書かない。無い場合 leisen-ask は「Claude API の資格情報が必要です」と表示して終了コード 2 |
| OpenAI 互換(`--llm openai-compatible`) | 任意。`apiKeyEnv`(`--llm-api-key-env`)で指定した環境変数の値を `Authorization: Bearer` で送る | 設定には環境変数の**名前**だけを書く。キー不要のサーバーでは指定しない。サーバーが 401 を返した場合、キーを送っていなければ「資格情報が必要」、送っていれば「拒否された」と表示して終了コード 2。キー・ベース URL のクエリ・応答本文は例外メッセージに出さない |
| Gateway | 利用者本人のセッショントークン(`Authorization: Bearer`、毎リクエスト) | ログ・エラー・例外メッセージに出さない。`McpGatewayClient` は private フィールドに保持する |
| Gateway の run API | Orchestrator の資格情報(環境変数 `LEISEN_ORCHESTRATOR_CREDENTIAL`。HTTP ヘッダ `x-leisen-orchestrator-credential`) | Gateway と共有するデプロイ固有の秘密(ADR-019 決定3)。run API と、runId を申告する tools/call に Bearer と併せて送る。未設定なら開発用の既定値(WARNING)、`NODE_ENV=production` では必須。ログ・エラーに出さない。**利用者には配らない**(持つと Orchestrator を通さずに自分の run の記録を偽れる。TM-I5 (f))。接続は Gateway の MCP URL と同じディレクトリの `runs`(`/leisen/mcp` → `/leisen/runs`)にだけ送り、リダイレクトは追わない |

ソース(Drive・GitHub 等)の本人資格情報は Gateway 側(IdP Adapter / Token Vault)が扱い、Orchestrator は触れない(不変条件1・2)。監査用の鍵(docId の HMAC 鍵 `LEISEN_AUDIT_HMAC_KEY`、runId の署名鍵 `LEISEN_RUN_ID_KEY`)も Gateway だけが持つ(ADR-019 決定1)。

## ライブラリとして使う

```ts
import { createLlmClient, McpGatewayClient, Orchestrator } from "@leisen/orchestrator";

// LLM バックエンドは設定で選ぶ(生成は createLlmClient に集約。設定は zod で検証する)
const llm = createLlmClient({ provider: "anthropic", model: "claude-opus-5", effort: "high" });
// const llm = createLlmClient({
//   provider: "openai_compatible",
//   baseUrl: "http://localhost:1234/v1",
//   model: "<LM Studio のモデル名>",
// });

// 監査ロガー・citedDocIds の分類器・鍵は受け取らない(書き手は Gateway。ADR-019)
const orchestrator = new Orchestrator({
  llm,
  settings: { maxIterations: 6, runTimeoutMs: 120_000, costLimitPerQuery: 0.5 },
  // systemPrompt(評価用の差し替え)、now(テスト用の時計)は任意
});
// 利用者本人のトークンと、Gateway と共有する Orchestrator の資格情報(run API と runId を申告する
// tools/call に付ける。省くと run API が拒否する)
const gateway = new McpGatewayClient({
  url: "https://gateway.example.test/mcp",
  sessionToken,
  orchestratorCredential: process.env.LEISEN_ORCHESTRATOR_CREDENTIAL,
});
try {
  // userId は照合用の申告(任意)。記録される主体は Gateway が認証した userId。
  // run の開始・終了は gateway.startRun / gateway.finishRun で Gateway に申告される
  const answer = await orchestrator.run({ question, userId, gateway });
  // 利用者の「解決した / しない」ボタン(受け入れ条件3)。本人・期間は Gateway が runId の署名で検証する
  await gateway.feedbackRun(answer.runId, "resolved");
} finally {
  await gateway.close();
}
```

`GatewayClient` IF(`src/gateway/types.ts`)は `listTools` / `callTool` に加えて `startRun` / `finishRun` / `feedbackRun` を持つ。run の開始を Gateway が受け付けなければ `run()` は Answer を返さず `GatewayClientError` を投げる(runId がないため)。終了を記録できなければ回答を返さない(`audit_write_failed` なら `OrchestratorError`、それ以外は `GatewayClientError`)。

利用者の束縛(セキュリティレビュー 2026-09-27 H1): AnswerRun の `userId` は、呼び出し元の申告ではなく **Gateway が認証した userId** にする。T-023 以降は Gateway が `POST /runs` の Bearer の認証値で pending の AnswerRun を書くので構造的に成り立ち、Orchestrator 側は describe の結果の `_meta`(`io.github.sunaot.leisen/userId`)で申告との照合だけを行う。

- 呼び出し元(チャットUIのバックエンド等)が `userId` を申告していて一致しなければ fail-closed: run を `error`(`failureReason: "user_mismatch"`)で閉じ、LLM・検索に進まない
- describe フェーズで Gateway が利用者を確認できない(HTTP の認証失敗・到達不能・報告なし・食い違い)ときは探索せず `error` の Answer を返す(run は Gateway に `error` で記録される)
- run の途中で別の userId が報告されたら `user_mismatch` で止める
- AnswerRun と ToolInvocation は `(runId, userId)` で結合する(docs/audit-queries.md)。runId を申告する tools/call は Gateway が署名・本人・actor・期限を検証するので、他人の run に ToolInvocation を混ぜることはできない

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
| `baseUrl` | (必須) | ベース URL。ループバック(`localhost` / `127.0.0.1` / `[::1]`)以外は `https` 必須(Gateway の URL と同じ規則。`allowInsecureHttp` のときだけ例外)。資格情報・フラグメントは不可。`{baseUrl}/chat/completions` を呼ぶ。クエリは保つが表示・例外には出さない |
| `model` | (必須) | モデル名 |
| `apiKeyEnv` | なし | API キーを入れた環境変数の名前(英数字と `_`)。指定時だけ `Authorization: Bearer` を送る |
| `timeoutMs` | 120000 | 1リクエストのタイムアウト。タイムアウトは再試行しない |
| `maxRetries` | 2 | 429 / 5xx / 接続失敗のみ再試行(指数バックオフ 0.5 秒起点・上限 8 秒、`Retry-After` / `retry-after-ms` が 0〜60 秒ならそれに従う) |
| `reasoningEffort` | なし | `low` / `medium` / `high`。指定したときだけ `reasoning_effort` を送る(能力フラグ effort が true になる) |
| `extraHeaders` | なし | 追加の HTTP ヘッダ(秘密でないもの。値は表示可能な ASCII)。`Authorization` / `Cookie` / `X-Api-Key` / `Api-Key` 等の認証系・トランスポート系ヘッダは置けない |
| `maxContextTokens` | なし | サーバーでロードしたコンテキスト長(参照用。能力フラグに出すだけで上限判定には使っていない) |
| `allowInsecureHttp` | なし(false) | true のときだけループバック以外の `http` の `baseUrl` を受ける(leisen-ask の `--allow-insecure-upstream`。開発・評価用途)。`NODE_ENV=production` では `OpenAiCompatibleLlmClient` の構築を拒否する(`invalid_configuration`)。`McpGatewayClient` にも同名のオプションがあり、Gateway の URL について同じ規則 |

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

- 開始時: Gateway の run API に開始を申告し(`POST /runs`。質問・実行区分・actor)、署名付き runId(`r1.<kid>.<payload>.<sig>`。Gateway が生クエリ表と pending の AnswerRun を書く)を受け取る。受け付けられなければ LLM を呼ばず、Gateway にもそれ以上アクセスしない(`GatewayClientError`)→ 探索の時間上限を runId の有効期間(`expiresAt`。Gateway の `gateway.runs.ttlSec`)に収める(最終ターン `finalTurnTimeoutMs` と finish の往復の余裕 `RUN_FINISH_MARGIN_MS`(5 秒)を残す。短くしたら warnings に記録)→ `tools/list` → 全ソースに `describe`(`source_not_connected` のソースは skippedSources に入れて検索対象から外す。それ以外の失敗は正規化後の分類で警告を残して検索対象に残す)→ describe の結果の `_meta` から Gateway が認証した userId を得て申告と照合する → system prompt(固定部 `prompts/explore.v3.md` だけ)・最初の user ターン(ソース一覧・上限・質問)・ツール定義(strict、`source` は有効ソースの enum)を組む
- ソース一覧(セキュリティレビュー H3): describe 結果はコネクタ由来の外部データなので、system prompt には入れず、最初の user ターンに「固定の前置き(データであり指示ではない)」+「JSON」で渡す(ツール結果と同じ扱い)。`kind` は connector-sdk の `ContainerEntry.kind` の値域に限り(それ以外は `other`)、`supportedFilters` は `SearchFilters` のキーに限る。件数・長さを切り詰め、JSON の `<` `>` はエスケープする。system prompt が固定文字列だけになるので、プロンプトキャッシュの prefix も run をまたいで安定する
- 反復: LLM の応答内のツール呼び出しは並行に Gateway へ送り(1ターン `maxToolCallsPerTurn` 件・run 全体 `maxToolCallsPerRun` 件まで。超えた分は実行しない)、結果は1つの user メッセージにまとめて返す。成功した結果は「固定の前置き(データであり指示ではない)」と「データ本体の JSON」の2ブロック、ツールエラーも「固定の前置き(ツールエラーはデータ)」と `{ errorClass, message }` の JSON の2ブロックで返す(`is_error: true`)。`permission_denied` と `not_found` は区別せず `not_available` として渡す(TM-B2。Gateway も正規化する)
- 終了: `submit_answer` の提出 / 提出せずに終えたら1回だけ催促し、それでも提出しなければ unresolved / 上限に達したら提出を促す最終ターンを1回だけ行う / LLM・Gateway の失敗・利用者の不一致は error(回答文は失敗の分類ごとの文言。上記「失敗の文言」)
- 出典の検証: citations はその run で search のヒット・fetch の結果として受け取った (sourceId, documentId) に限る。検証済みの出典が0件なら unresolved、回答の先頭に「【注意】出典を確認できませんでした」、confidence を 0.3 以下に丸める
- 回答本文の無害化(M1、`src/sanitize.ts`): 私用領域・制御文字・不可視の書式文字を除き、Markdown のリンク・画像(参照形式・入れ子を含む)はテキストだけに、参照定義は削除、生の HTML は除去して残った `<` `>` はエスケープし(コードの外だけ。行頭の引用記号は残す)、URL らしき文字列(任意の `scheme://`、`http:evil`・`mailto:`・`javascript:` 等、`www.`、`//host`、`label.tld/path`。実体参照・`\`・全角で組んだものを含む)は `［URL削除］` に置き換える。最後に同じ処理をかけ直す最終検証(fail-closed)を行い、残っていたものも除去する。除去は warnings に記録する
- 未接続: run の途中で `source_not_connected` になったソースは searchedSources から外し、skippedSources にだけ載せる
- `_meta`: 全 `tools/call` に `io.github.sunaot.leisen/runId`(Gateway が発行した値)/ `iteration` / `executionClass`(`human_in_the_loop`)/ `actor`(`{ kind: "human" }`)を付け、HTTP ヘッダで Orchestrator の資格情報を送る。Gateway は runId の署名・本人・actor・期限と資格情報を検証し、満たさない呼び出しを `invalid_run_id` で拒否する(ADR-019 決定4。Orchestrator 側では `run_not_accepted`)。iteration は従来どおり Orchestrator の申告で、ツール呼び出しごとに 0 から単調増加(describe を含む。同一ターン内の並列呼び出しは応答内の順。Gateway に送らなかった呼び出しは番号を消費しない)。結果の `_meta` の `io.github.sunaot.leisen/userId` は Gateway が認証した利用者(H1)
- 監査: Orchestrator は監査ストアに書かない(ADR-019 決定1)。開始(pending の AnswerRun)・終了(`answer_run_finish`)・フィードバック(`answer_run_feedback`)を run API に申告し、Gateway が ToolInvocation と同じストアに書く。終了を申告できなければ回答を返さない(fail-closed。`audit_write_failed` なら `OrchestratorError`、それ以外は `GatewayClientError`)。終了処理(Answer の組み立て・finish)で例外が起きても `error` の finish を試みてから例外を投げ直す(run を pending のまま残さない)。finish で送るのは outcome・confidence・searchedSources・citations(`sourceId` と `documentId`)・failureReason で、回答本文・タイトル・URL は送らない。質問の原文は `POST /runs` で Gateway の生クエリ表に入り(保持期間つき)、AnswerRun 本体には digest だけが残る
- citedDocIds(H2): 記録の規則は Gateway がデプロイ単位でかける(ADR-019 決定5)。Slack が有効な構成では citedDocIds を記録しない(searchedSources だけ)、プライベートスコープを持つソースが有効なら全件に `audit.privateScopeDocIds` の規則(既定 `hashed`。Gateway の `LEISEN_AUDIT_HMAC_KEY`)をかける、有効でない sourceId は記録しない。Orchestrator は鍵も分類器も持たない。引用がその run で実際に返した文書かの Gateway 側の照合は段階 2(別 ADR、未着手)で、Orchestrator 側の出典の検証(上記)は申告の質を保つ手段として残す

## 脚本テストの書き方

`ScriptedLlmClient` は、直前のツール結果を見て次の応答を返す関数の配列(または全ターン共通の関数)を受け取る。テストの Gateway は `test/helpers/harness.ts` の `startGateway` で起動する(実 Gateway を run API つきで port 0 で listen、コーパス型のモックコネクタ、スタブの資格情報)。`harness.client()` は利用者のトークンと Orchestrator の資格情報を持つ `McpGatewayClient`、`harness.answerRuns()` は pending の AnswerRun に finish / feedback を統合したもの(Gateway の監査ストアから読む)。利用者の束縛・citedDocIds・失敗の文言のテストは `test/user-binding.test.ts` / `test/cited-docids.test.ts` / `test/failure-text.test.ts`。

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
const answer = await new Orchestrator({ llm })
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
- `test/e2e-openai-compatible-mock.test.ts`: 実 Gateway + `createLlmClient({ provider: "openai_compatible", baseUrl: モック })` + モック。同じ4シナリオ、要求の形(messages・tools・`strict` なし・`tool_choice`・`stream: false`)、`arguments` が壊れた JSON、`finish_reason: length`、催促、429 の再試行、`Authorization` / `reasoning_effort` / 追加ヘッダ、leisen-ask(フラグ・環境変数・401)

脚本だけの単体経路(`ScriptedLlmClient`)は高速な検証として残している。

## dev-eval(合成コーパスでの簡易評価)

合成コーパス(`examples/fixtures/dev-corpus.yaml`)に対する質問セット `examples/eval/dev-questions.json` を leisen-ask で1問ずつ流し、判定と計測値を Markdown の表にする開発用の道具(T-008 評価ハーネスの前段)。プロンプトや既定値を変えたときの回帰チェックに使う。

```sh
# Gateway を開発用設定で起動しておく(README「手元で動かす」)。トークン・LLM の設定は leisen-ask と同じ環境変数で渡す
# (LEISEN_ORCHESTRATOR_CREDENTIAL は Gateway も未設定の手元の開発では省略できる)
export LEISEN_SESSION_TOKEN=dev-token
node packages/orchestrator/dist/bin/dev-eval.js --label after -- \
  --gateway http://127.0.0.1:8787/mcp --config examples/deployment.dev.yaml \
  --llm openai-compatible --llm-base-url http://localhost:1234/v1 --model <モデル名>
```

| オプション | 内容 |
|---|---|
| `--questions <file>` | 質問セット(既定 `examples/eval/dev-questions.json`)。質問ごとに期待する `outcome`(resolved / unresolved)と、resolved なら引用すべき文書(どれか1つで足りる `citeAnyOf`、すべてが要る `citeAllOf`。`sourceId:documentId`)、任意で種類 `category`(baseline / uncovered-doc / paraphrase / english / multi-doc / absent)を書く |
| `--repeat <N>` | 各質問を N 回流す(1〜20、既定 1。ぶれを見る) |
| `--only <id,...>` | 質問を ID で絞る |
| `--label <見出し>` | 表の見出し(例: before / after) |
| `--timeout-sec <N>` | 1問あたりの打ち切り(既定 300 秒) |
| `--` 以降 | leisen-ask にそのまま渡す。dev-eval は `--json` と質問文を足す |

- 判定: 期待した outcome か、resolved を期待した質問で期待した文書を引用したか(`citeAnyOf` はどれか、`citeAllOf` はすべて)、回答本文に URL が残っていないか。種類を書いた質問があれば種類ごとの合格数を、`--repeat` が 2 以上なら質問ごとの合格回数(n 回中 k 回)も表にする。○ 合格 / × 不合格 / ! エラー(leisen-ask が回答を返せない・run が error)。終了コードは全問合格で 0、それ以外 1、引数・質問セットの不備で 2
- 表に出すのは質問 ID・判定・outcome・引用した文書 ID・LLM ターン数・ツール呼び出し数(describe を含む)・トークン数・所要時間(leisen-ask の起動から終了までの実時間)。質問文・回答本文は出さない。進捗は stderr、表は stdout(`> report.md` で保存できる)
- leisen-ask の stderr(失敗時の案内)は、回答を返せなかった run のときだけ流す。run の記録(AnswerRun)は Gateway の監査ログに残る(ADR-019。dev-eval 側に残す手段はない)
- 合成データ専用。表には引用した文書 ID(`sourceId:documentId`)をそのまま出し、Gateway が AnswerRun の citedDocIds にかける規則(Slack・有効でないソースは記録しない)を通らないため、Slack を含むデプロイや実データには向けない(不変条件7)。実データの質問セットの扱い(機密クエリの保管・アイデンティティごとの期待値・文書 ID の分類)は T-008 で決める

## プロンプトの変更

固定部は `prompts/explore.v3.md`、制御メッセージ(催促・最終ターンの指示・ソース一覧とツール結果・ツールエラーの前置き)は `src/prompt.ts`。変更する PR には評価レポート(T-008)を添付する。挙動が変わる改訂はファイルを `explore.v3.md` として追加し、`EXPLORE_PROMPT_VERSION` を上げる。v2 はセキュリティレビュー(2026-09-27)でソース一覧を user ターンへ移し、回答本文に URL を書かない方針にした版(v1 は評価結果がないまま置き換えた。T-008 の評価レポートは未添付)。v3(2026-10-08)は実モデルでの初回実走で見えた空振りへの対処で、検索語を名詞 1〜2 語にして言い換えを 1 つの query に並べない(多くのソースは語の AND)、0 件なら語を減らす、list は区画だけを返し文書は返さない(区画内は `filters.container` で探す)、見つからないことを「存在しない」と断定しない、を足した。同じ趣旨をツールの説明文(`src/tools.ts` の USAGE_HINTS と Gateway の list の説明)にも入れた。評価は `docs/eval/2026-10-08-explore-v3.md`(dev-eval)。

## 既知の限界

- **実走は限定的**: OpenAI 互換(LM Studio)で合成コーパスの 4 問を流しただけ(2026-10-08、`docs/eval/`)。Claude API の資格情報が用意されるまで、Claude のモデル・effort・max_tokens の既定値、プロンプトの効き、キャッシュの効き(`cache_read_input_tokens`)は未計測
- **OpenAI 互換の限界**: プロンプト(`prompts/explore.v3.md`)は Claude を前提に書いており、オープンウェイトのモデルで同じ効きになる保証はない(バックエンド別の派生を `prompts/` に置いてよい。ADR-017)。strict がないため引数の形は保証されず、壊れた引数の呼び出しは実行せずに不正な入力として返す。submit_answer の引数が壊れていると再提出を求めずに unresolved で終える(再提出させるかは T-008 の計測を見て決める)。推論の過程(`reasoning_content` 等の非標準フィールド)は履歴に戻さない。`max_tokens` を送る(OpenAI 本家の o 系・推論モデルは `max_completion_tokens` のみを受けるため対象外)。プロンプト+`max_tokens` がコンテキスト長を超える要求を 400 で拒否するサーバー(vLLM 等)では `maxTokensPerTurn` を下げる
- **評価ハーネス(T-008)未実装**: 解決率・引用正確性・インジェクション耐性(RS-3 / RS-4)の率は測れていない
- **Slack コネクタ未実装**: Slack コネクタ(T-006)は未着手(導入形態は 2026-10-13 に類型(a)で確定、issue #59)。citedDocIds の記録の規則は Gateway がデプロイ単位でかける(ADR-019 決定5。Slack が有効な構成では段階 1 の間 citedDocIds を記録しない)。Orchestrator 側に残るのは `leisen-ask serve` の起動拒否(不変条件7)の判定だけ
- **回答本文の URL の検出の限界**: スキーム・`www.`・`//`・パス/クエリのない裸のドメイン名(`evil.example`)とメールアドレスは残す(ファイル名等と区別できない)。利用側は fuzzy な自動リンク(裸のドメインのリンク化)を無効にし、外部画像を自動取得しない(T-009)。検出は保守的(fail-closed)で、`Node.js/Express` のような表記やコード片の中の URL も除去される(除去は warnings に出る)。ゼロ幅接合子(ZWJ)も除くため、絵文字の合成列は分かれて表示される
- **AnswerRun の書き手(ADR-019 で解決)**: 書き手は Gateway に一本化し、Orchestrator は監査ストアをマウントせず鍵も持たない申告者になった(2026-10-09 Accepted、T-023 段階 1)。残る限界は、侵害された Orchestrator が手元の利用者トークンと資格情報でその利用者の期限内の run の結果を偽って申告できること(範囲はその利用者に限られる)と、引用がその run で返した文書かを Gateway がまだ検証しないこと(段階 2、別 ADR)。Orchestrator を Gateway と別の運用者に置く構成は別 ADR
- **フィードバックの期間**: `feedback` は runId の発行から `gateway.runs.feedbackWindowSec`(既定 7 日)の間だけ Gateway が受け付け、過ぎると `run_not_accepted`。記録は Gateway の監査ストアに残るので `leisen-ask serve` の再起動では消えない。runId の署名鍵を入れ替えると(1 つ前の鍵も外すと)期限内の run の feedback も受け付けられなくなる
- **iteration と T-014**: iteration は「run 内のツール呼び出しの通番」(describe を含む、並列呼び出しも個別に採番)。昇格判定レポート(T-014)の再検索回数は、2026-09-27 以降 run 内の `search` の ToolInvocation 件数(重複行を除き、(runId, userId) で束ねたもの)で数える。iteration は順序付けにのみ使う(ADR-017 確認事項4、docs/audit-queries.md §2)
- **ストリーミングなし**: 途中経過の表示は T-009 で必要になった時点で検討する
- **deployment.yaml との結合**: ライブラリの設定は自パッケージの zod スキーマで受ける。`leisen-ask`(`--config` は任意)と `leisen-ask serve`(必須)は `--config` の `orchestrator` セクション(`maxIterations` / `costLimitPerQuery`)を探索の設定に使う。それ以外の項目(`runTimeoutMs` 等)の結合は後続タスク。`runTimeoutMs` は Gateway の `gateway.runs.ttlSec`(既定 900 秒)より短くする必要があり、長ければ run ごとに短くして warnings に出す
