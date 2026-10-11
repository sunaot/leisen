# knowledge-platform leisen ~ 霊泉

社内ナレッジをLLMが権限透過で検索できるようにする基盤。設計の全体像は `docs/product-design.md`(v1)+ `docs/product-design-v2.md`(OSS化差分)+ `docs/product-design-v3.md`(実装前レビュー反映差分)、開発ルールは `CLAUDE.md`、タスクは `docs/backlog/` を参照。

**実装前ゲート(T-000a/b/c)は完了し、Gateway土台(T-001/T-002/T-010/T-003)と昇格判定レポート(T-014)がmainにある。** Orchestrator(T-007)・リファレンスデプロイ(T-012)・利用者向けの面(T-021)も main にあり、手元で動かせる(下記)。次はコネクタの実疎通(T-019/T-005、人手の承認待ち)と評価(T-008)。現在のフェーズと制約は `CLAUDE.md` の「現在のフェーズ」を正とする。

## セットアップ

```bash
npm install
npm run build
npm test
```

## 手元で動かす(5分)

モックIdPと開発用コネクタ(合成の社内文書 `examples/fixtures/dev-corpus.yaml`)で Gateway を起動し、MCPクライアントから検索する。実SaaS・実資格情報は不要。Node 22 を前提とする。

```bash
npm ci && npm run build

# 開発用モックの設定(秘密情報は設定ファイルに書かず環境変数で渡す)
export KP_MOCK_SESSIONS=dev-token=alice          # Bearer トークン → 利用者ID(モックIdP)
export KP_MOCK_TOKEN_DEV_DOCS=dev-only-token     # ソース dev-docs に渡す本人資格情報(モック)

npx kp-gateway validate --config examples/deployment.dev.yaml   # 設定を検証(listen しない)
npx kp-gateway serve --config examples/deployment.dev.yaml      # http://127.0.0.1:8787/mcp で待ち受け
```

- 起動ログは標準エラー出力、監査レコード(`audit.sink: stdout`)は標準出力に1行1件のJSON(`{"kind":"audit", …}`)で出る。この標準出力はそのまま昇格判定レポート(`kp-promotion-report --audit`)に渡せる(保存するファイルは `umask 077` で作り、監査ログと同じ保持・閲覧の規程(ADR-013 §3)に従う。開発用。`NODE_ENV=production` では `stdout` シンクは起動時に拒否される)。Ctrl-C(SIGINT)/ SIGTERM で処理中のリクエストを待って停止する
- `KP_MOCK_SESSIONS` を設定し忘れると、モック IdP のセッション表が空になり全リクエストが 401(`a valid bearer session token is required`)になる。`validate` / `serve` はこのとき `WARNING: mock IdP: no sessions configured …` を標準エラー出力に出し(起動は止めない)、`serve` は最初に 401 で拒否したときにもサーバーログに1行残す(トークンの値は出さない)
- 待ち受けのポート・アドレスは `--port <n>` / `--host <addr>` で deployment.yaml の `gateway.http.port` / `host` より優先して変えられる(`validate` にも付けられる)。ループバック以外の `--host` には deployment.yaml の `gateway.http.confirmExposedHost: true` が必要(フラグでは解除できない。docs/install.md §6)。ポートが使用中なら `ポート N は使用中です。--port <番号> か deployment.yaml の gateway.http.port で別のポートを指定してください` と出して exit 1
- `--config` を省略すると環境変数 `KP_DEPLOYMENT_CONFIG` を使う。使い方は `npx kp-gateway help`(`npx kp-gateway --help` の `--help` は npm 自身が解釈する)
- ビルド成果物を直接実行してもよい: `node packages/gateway/dist/bin/kp-gateway.js serve --config examples/deployment.dev.yaml`
- 設定内の相対パス(例: `settings.corpusFile`)は設定ファイルの所在ディレクトリ基準で解決する(起動時のカレントディレクトリに依存しない)

### curl で試す

Streamable HTTP(ステートレス、応答は単発JSON)。全リクエストに `Authorization: Bearer <セッショントークン>` が必要で、欠落・不正は 401 になる。`initialize` 以降のリクエストには `mcp-protocol-version: 2025-11-25` を付ける。

```bash
curl -s http://127.0.0.1:8787/healthz   # {"status":"ok"}(認証不要)

curl -s http://127.0.0.1:8787/mcp \
  -H 'Authorization: Bearer dev-token' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0.0.0"}}}'

curl -s http://127.0.0.1:8787/mcp \
  -H 'Authorization: Bearer dev-token' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-11-25' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

curl -s http://127.0.0.1:8787/mcp \
  -H 'Authorization: Bearer dev-token' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-11-25' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search","arguments":{"source":"dev-docs","query":"VPN 接続"}}}'
```

`search` はスニペット付きのヒット一覧を返す。続けて `fetch`(`{"source":"dev-docs","documentId":"vpn-setup"}`)で本文、`describe` / `list` でソースの概要・区画を取得できる。

### MCP Inspector / Claude Code から接続する

- MCP Inspector(CLIモード、v2.8.0 で確認): `npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8787/mcp --transport http --header "Authorization: Bearer dev-token" --method tools/list`(`--method tools/call --tool-name search --tool-arg source=dev-docs --tool-arg query=VPN` で検索)
- MCP Inspector(ブラウザUI、**未検証**): `npx @modelcontextprotocol/inspector` を起動し、Transport に Streamable HTTP、URL に `http://127.0.0.1:8787/mcp`、ヘッダに `Authorization: Bearer dev-token` を指定する
- Claude Code: `claude mcp add --transport http kp-gateway http://127.0.0.1:8787/mcp --header "Authorization: Bearer dev-token"`。`claude mcp list` で `Connected` になることまで確認済み(対話の中でのツール呼び出しは**未検証**)
- 出典付きの回答(Orchestrator の `ask` / `feedback`)をチャット UI(LibreChat)や MCP クライアントから使う場合は、Orchestrator を MCP サーバーとして起動する(`kp-ask serve`。T-021)。手順は [docs/ui-librechat.md](docs/ui-librechat.md)

### Keycloak で試す

モック IdP の代わりに Keycloak(`e2e/keycloak` の realm `kp`。利用者 alice / bob とクライアントはローカル専用のダミー)でセッション検証を通す。Docker が要る。設定は `examples/deployment.keycloak.yaml`(IdP 以外は `deployment.dev.yaml` と同じ)。

```bash
docker compose -f e2e/keycloak/docker-compose.yml up -d && e2e/keycloak/wait-ready.sh   # realm を取り込んで起動
export KP_KEYCLOAK_CLIENT_SECRET=dev-only-gateway-secret     # realm のクライアント gateway の secret(ダミー)
export KP_MOCK_TOKEN_DEV_DOCS=dev-only-token
export KP_SESSION_TOKEN="$(scripts/smoke/keycloak-token.sh)"  # 利用者 alice のアクセストークン(クライアント e2e-cli。5 分で失効)

npx kp-gateway auth-check --config examples/deployment.keycloak.yaml --token-env KP_SESSION_TOKEN   # 検証項目ごとの結果を表示
npx kp-gateway serve --config examples/deployment.keycloak.yaml                                      # http://127.0.0.1:8787/mcp

# 別の端末で(KP_SESSION_TOKEN と KP_AUDIT_HMAC_KEY、LLM の資格情報を設定したうえで。packages/orchestrator/README.md)
npx kp-ask --gateway http://127.0.0.1:8787/mcp --config examples/deployment.keycloak.yaml "VPN の接続手順を教えて"
```

- Gateway は `active` だけでなく、発行者(`iss`)・種別(`typ` が `Bearer`。リフレッシュトークン・ID トークンは拒否)・発行先クライアント(`azp` が `idp.adapter.allowedClients` にあること)・受け手(`requireAudience: true` のとき `aud` に自分の `clientId` を含むこと)を検証する(issue #16)。どれかに失敗すると利用者には固定文言の 401 が返り、サーバーログ(stderr)に `WARNING: keycloak introspection rejected a session token: azp "foo" is not in allowedClients` のようにクレーム名だけの理由が 1 行出る(トークン・利用者 ID は出さない)。原因の切り分けは `kp-gateway auth-check --config <yaml> --token-env <変数名>`(環境変数のトークンを 1 回イントロスペクションし、`active` / `iss` / `typ` / `azp` / `aud` ごとの pass / fail / skipped と userId を表示。全項目 pass で exit 0、どれかが fail で 1、設定不備・`kind: mock` では 2。トークンは出力しない)
- **自作の MCP クライアントなど新しいクライアントを使うとき**: realm(`e2e/keycloak/realm/kp-realm.json`、本番では IdP の管理画面)にクライアントを登録し、`requireAudience: true` なら Gateway を audience に加えるマッパー(`oidc-audience-mapper`、`included.client.audience: gateway`)を付けたうえで、deployment.yaml の `allowedClients` に追記して `kp-gateway validate` → 再起動する。realm を取り込み直すには `docker compose -f e2e/keycloak/docker-compose.yml down -v` してから起動する(既存の realm は上書きされない)
- 開発だけで使う明示の逃げ道として `allowedClients: ["*"]` がある(`azp` の検証だけを省く。`iss` / `typ` / `aud` は検証する)。`validate` / `serve` は `WARNING: any client is accepted (azp check disabled; idp.adapter.allowedClients contains "*")` を出し、`NODE_ENV=production` では `dev_only_in_production` で起動を拒否する

### 本番では開発用の部品が拒否される

モックIdP(`idp.adapter.kind: mock`)・モック資格情報(`auth.provider: mock_env`)・開発用コネクタ(`kind: dev-fixture`)・監査シンク `stdout`・Keycloak の `allowedClients: ["*"]` は開発専用で、`NODE_ENV=production` では起動時に拒否される(`dev_only_in_production`)。

```bash
NODE_ENV=production npx kp-gateway validate --config examples/deployment.dev.yaml   # 4件の不備を列挙して exit 1
```

`kp-gateway validate` は設定の読込からコネクタ・Gateway の組み立てまでを行い(listen しない)、見つかった不備を全件列挙して exit 1、問題がなければ要約を出して exit 0 で終わる。本番構成のサンプル `examples/deployment.yaml` はコネクタのプラグイン(`@kp/connector-<kind>`)と本人資格情報の取得方式(T-004)がまだないため、現時点では validate で不備が列挙される。

## Docker Compose で動かす(リファレンスデプロイ)

Gateway と Keycloak をコンテナで起動する評価用構成(T-012)。手順・前提・未実装事項・ループバック以外へ公開する前の必須条件(TLS 終端のリバースプロキシ)は [docs/install.md](docs/install.md) を参照。

```bash
cd deploy/compose && cp .env.example .env
docker compose up -d --build --wait
KP_SESSION_TOKEN="$(../../scripts/smoke/keycloak-token.sh)" ../../scripts/smoke/gateway-smoke.sh
```

起動確認は CI の `reference-deploy` ジョブが担う(PR #14 で成功を確認)。

チャット UI から問い合わせる場合は LibreChat の overlay を重ねる(`deploy/compose` で `cp librechat/librechat.env.example librechat/librechat.env` のあと `docker compose -f docker-compose.yml -f docker-compose.librechat.yml up -d --build --wait` → http://localhost:3080。LM Studio が要る)。手順と MCP クライアント(Claude Code 等)からの接続は [docs/ui-librechat.md](docs/ui-librechat.md)。

## 構成

- `packages/connector-sdk` — コネクタ共通IF(v0.4。ADR-016 追補2: 結果ごとのプライベート領域の分類 `scope`、能力 `privateScopeHandling`、factory への方針 `policy`)
- `packages/audit` — 監査ログの共通モジュール(ADR-011 の 2 層モデル。Gateway が書き、Orchestrator が申告し、昇格判定レポートが読む型と実装。ADR-019 決定10 で Gateway から切り出した。依存は zod と Node 標準のみ)
- `packages/gateway` — MCP Gateway(認証・IdP Adapter・監査・ルーティング・MCPサーバー面・Streamable HTTP。HTTPトランスポートは配線済みで `kp-gateway serve` で起動する)と起動コード(`kp-gateway` CLI、`assembleGateway`、開発用コネクタ、JSONL監査sink)
- `packages/promotion-report` — 昇格判定レポートCLI(T-014、ADR-006)
- `packages/connector-github` — GitHubコネクタ(T-019)。Search / Issues / Contents API を本人トークンで呼ぶ(nativeSearch: degraded、privateScopeHandling: classified。GitHub App は組織にだけインストールする前提)。モックテスト済み、実アカウント疎通は GitHub App 承認待ち
- `packages/orchestrator` — Orchestrator 探索戦略 v1(T-007)と `kp-ask` CLI(`kp-ask serve` で MCP サーバーとして公開する。T-021、ADR-018)。LLM バックエンドは設定で選ぶ(Anthropic Messages API / OpenAI 互換。LM Studio・llama.cpp 等のローカルモデルは `--llm openai-compatible`)。使い方・LM Studio 手順・出典検証の契約は `packages/orchestrator/README.md`。設計は ADR-017(Proposed)
- `examples/deployment.yaml` — Deployment Profileのサンプル(T-010)。導入1件=このファイル1枚(ADR-005)。スキーマの正は `packages/gateway/src/config/`
- `examples/deployment.dev.yaml` — 手元で動かすための開発用設定(上記「手元で動かす」)
- `deploy/` — リファレンスデプロイ(T-012): `Dockerfile` と `compose/`(gateway + keycloak の評価用構成と、LibreChat の overlay)。導入手順は `docs/install.md`、UI からの利用は `docs/ui-librechat.md`
- `scripts/smoke/` — スモークテスト(`gateway-smoke.sh`、LibreChat overlay の `orchestrator-smoke.sh` / `librechat-smoke.sh`)と開発・CI 専用のトークン取得(`keycloak-token.sh`)
- `docs/adr` — 設計判断の記録
- `docs/backlog` — Phase 1タスク(受け入れ条件付き)

## 進め方

Claude Code でタスクIDを指定して着手する。例: 「docs/backlog/T-001-audit-log.md を読み、受け入れ条件を満たすまで実装して」
