# knowledge-platform leisen ~ 霊泉

社内ナレッジをLLMが権限透過で検索できるようにする基盤。設計の全体像は `docs/product-design.md`(v1)+ `docs/product-design-v2.md`(OSS化差分)+ `docs/product-design-v3.md`(実装前レビュー反映差分)、開発ルールは `CLAUDE.md`、タスクは `docs/backlog/` を参照。

**実装前ゲート(T-000a/b/c)は完了し、Gateway土台(T-001/T-002/T-010/T-003)と昇格判定レポート(T-014)がmainにある。** 次はコネクタ(T-005/T-019)・Orchestrator(T-007)・リファレンスデプロイ(T-012)。現在のフェーズと制約は `CLAUDE.md` の「現在のフェーズ」を正とする。

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

- 起動ログは標準エラー出力、監査レコード(`audit.sink: stdout`)は標準出力に1行1件のJSONで出る。Ctrl-C(SIGINT)/ SIGTERM で処理中のリクエストを待って停止する
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

### 本番では開発用の部品が拒否される

モックIdP(`idp.adapter.kind: mock`)・モック資格情報(`auth.provider: mock_env`)・開発用コネクタ(`kind: dev-fixture`)は開発専用で、`NODE_ENV=production` では起動時に拒否される(`dev_only_in_production`)。

```bash
NODE_ENV=production npx kp-gateway validate --config examples/deployment.dev.yaml   # 3件の不備を列挙して exit 1
```

`kp-gateway validate` は設定の読込からコネクタ・Gateway の組み立てまでを行い(listen しない)、見つかった不備を全件列挙して exit 1、問題がなければ要約を出して exit 0 で終わる。本番構成のサンプル `examples/deployment.yaml` はコネクタのプラグイン(`@kp/connector-<kind>`)と本人資格情報の取得方式(T-004)がまだないため、現時点では validate で不備が列挙される。

## 構成

- `packages/connector-sdk` — コネクタ共通IF
- `packages/gateway` — MCP Gateway(認証・IdP Adapter・監査・ルーティング・MCPサーバー面・Streamable HTTP)と起動コード(`kp-gateway` CLI、`assembleGateway`、開発用コネクタ、JSONL監査sink)
- `packages/promotion-report` — 昇格判定レポートCLI(T-014、ADR-006)
- `packages/connector-github` — GitHubコネクタ(T-019)。Search / Issues / Contents API を本人トークンで呼ぶ(nativeSearch: degraded)。モックテスト済み、実アカウント疎通は GitHub App 承認待ち
- `examples/deployment.yaml` — Deployment Profileのサンプル(T-010)。導入1件=このファイル1枚(ADR-005)。スキーマの正は `packages/gateway/src/config/`
- `examples/deployment.dev.yaml` — 手元で動かすための開発用設定(上記「手元で動かす」)
- `docs/adr` — 設計判断の記録
- `docs/backlog` — Phase 1タスク(受け入れ条件付き)

## 進め方

Claude Code でタスクIDを指定して着手する。例: 「docs/backlog/T-001-audit-log.md を読み、受け入れ条件を満たすまで実装して」
