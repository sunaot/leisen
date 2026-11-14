# T-026: esa コネクタ(公式リモート MCP サーバー、Token Vault / ESC)

## 依存
T-004(本人資格情報の 3 方式と認可サーバー、ADR-022)、T-003(Gateway)、ADR-021(公式コネクタの許可表)

## 前提(人手)
- 導入先の esa チームの owner が、リモート MCP サーバー(`https://mcp.esa.io`、β)へのアクセスを許可する(既定は拒否。docs.esa.io/posts/584)
- esa の OAuth クライアントの登録(`/oauth/dcr` か esa のアプリ登録)と owner の承認。リダイレクト URI は `<publicBaseUrl>/connections/callback`
- 実疎通は上の 2 つが済んでから。モックでの実装とテストは先行してよい

## 内容(ADR-023)
- `packages/connector-esa`: connector-sdk v0.4 の IF を esa の読み取り系 MCP ツールで実装する。上流は公式 SDK のクライアントで、本人の OAuth アクセストークンで呼ぶ。書き込み系のツールは呼べない
- Gateway の OAuth プリセット `esa`(端点、RFC 8707 の `resource=https://mcp.esa.io`、本人照合は `GET /v1/user` の email、失効は RFC 7009)。`connectors[].auth.oauth.resource` の設定
- 公式コネクタの許可表に `esa` の行を足す
- 設定例(`examples/deployment.credentials.yaml`)、docs/personal-auth.md、docs/auth-matrix.md、Dockerfile

## 受け入れ条件
- [x] 全呼び出しが本人トークン(上流に届く Authorization が本人の esa トークンだけで、IdP・MCP クライアントのトークンが届かないことの結合テスト)
- [x] トークン欠落・期限切れ・資格情報の種類違いで上流を呼ばずに失敗するテスト
- [x] 書き込み系のツールを呼べないことのテスト
- [x] Token Vault と ESC の両方で、接続 → 検索ができる結合テスト(esa の OAuth はモック、MCP サーバーは SDK のフェイク)
- [x] 本人照合の不一致で保管せず、失効を依頼するテスト
- [x] 件数(total_count、カテゴリの count)を返さないテスト
- [ ] 導入先の esa チームでの実疎通(ADR-023「残る確認事項」1〜7)。結果を ADR-023 に追記する
