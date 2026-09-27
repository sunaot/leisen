# T-012: リファレンスデプロイ(Docker Compose)

## 前提
起動コード(`kp-gateway` CLI、`assembleGateway`)は先行実装済み(2026-09-27)。Docker 化はこの CLI をエントリポイントにする(例: `node packages/gateway/dist/bin/kp-gateway.js serve --config /etc/kp/deployment.yaml`、または `--config` を省略して環境変数 `KP_DEPLOYMENT_CONFIG`)。停止は SIGTERM(処理中のリクエストを待ち、監査バッファを flush してから終了。flush できなければ exit 1)。設定の事前検証は `kp-gateway validate`(listen しない、不備を全件列挙して exit 1)。

本タスクで扱う残り:
- `gateway.http.host` の既定は `127.0.0.1`。コンテナでは `0.0.0.0` 等を deployment.yaml で明示する
- 監査の永続sinkは当面 `audit.sink: jsonl`(`audit.jsonl.path` / `rawQueryPath`、出力先ディレクトリは事前に作成)。保持期限(`retentionDays` / `rawQueryRetentionDays`)の定期削除ジョブ(`runRetentionPurge`、JSONL監査ログのローテーション)は未実装
- 本番で使える本人資格情報の取得方式(`connectors[].auth.provider`)は T-004 で追加する。現状の `mock_env` は開発専用で本番では起動時に拒否される

## 内容
- gateway + keycloak + (検索バックエンドはprofile指定時のみ。エンジンはT-016のPoCで選定後に確定 — ADR-006) を docker compose up で起動できる構成
- deployment.yaml を volume 注入する導入手順を docs/install.md として整備
- アップグレード手順(イメージ差し替え+マイグレーション実行)の骨子

## 受け入れ条件
- [ ] クリーンなマシン相当(CIコンテナ)で起動確認が自動化されている
- [ ] Helm化はスコープ外とし、要件だけ docs に記録
