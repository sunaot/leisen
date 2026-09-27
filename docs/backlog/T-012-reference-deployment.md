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
- [x] クリーンなマシン相当(CIコンテナ)で起動確認が自動化されている — CI の `reference-deploy` ジョブで自動化済み。PR #14(2026-09-27)で初めて実行し、イメージのビルド → compose 起動(keycloak → gateway が healthy)→ Keycloak 発行トークンでのスモーク(healthz / initialize / tools/list / search / 401)が成功した。初回は Dockerfile の build ステージに orchestrator の manifest がなく `npm run build` が失敗した(orchestrator は Dockerfile より後に追加された workspace)。COPY を 1 行足して修正
- [x] Helm化はスコープ外とし、要件だけ docs に記録(docs/install.md §11)
- [x] ループバック以外へ公開する前に、T-003 レビューの minor-6(MCP リクエスト単位の期限)/ minor-7(拒否応答への `connection: close`)/ minor-11(非ループバック公開の確認フラグと Host / Origin 検証)を Gateway 側で実装するか、リバースプロキシで同等の緩和(リクエストタイムアウト、接続数上限、Host / Origin の許可リスト)を入れる。**現時点ではリバースプロキシ側の緩和を前提とする**: 緩和の内容と nginx の設定例を docs/install.md §6 に記載し、compose のホストへの公開は `127.0.0.1:8787` に限定した(外部公開はリバースプロキシ経由)。minor-11 のうち確認フラグ(`gateway.http.confirmExposedHost`)は Gateway に実装済み
- [ ] (上記の Gateway 側の実装)minor-6 / minor-7 と Host / Origin 検証を `proxy/http.ts` に入れる — 本タスクの範囲外(T-003 の残作業)。実装されたら docs/install.md §6.2 を更新する

## 実装状況(2026-09-27)

- **Docker 化**(`deploy/`): `deploy/Dockerfile`(multi-stage。build で全 workspace を `npm ci` → `npm run build`、runtime は `npm ci --omit=dev` で本番依存だけの node_modules を作り直し dist だけをコピー。非 root(uid 1000)、`NODE_ENV=production`、`KP_DEPLOYMENT_CONFIG=/etc/kp/deployment.yaml`、HEALTHCHECK は node で `/healthz`、監査 `/var/lib/kp/audit` と生クエリ `/var/lib/kp/rawquery` を VOLUME)、ルートの `.dockerignore`、`deploy/compose/`(`docker-compose.yml`・`deployment.yaml`・`.env.example`・README)。compose は評価用構成(`dev-fixture` / `mock_env` のため `NODE_ENV=development`)で、秘密は `.env` からの変数展開で各コンテナに必要な分だけ渡す。Keycloak はホストで取得したトークンの `iss` とネットワーク内のイントロスペクションが一致するよう `KC_HOSTNAME` を固定。検索バックエンドは profile `search-backend` の枠(コメント)のみ
- **設定の追加**: `gateway.http.confirmExposedHost`(省略時 false)。host がループバック以外で確認フラグがなければ起動コードが `http_host_exposed_requires_confirmation` で拒否する(`validateGatewayHttpExposure`、`kp-gateway validate` / `serve` の両方)。静的検証(設定の解析)には入れていない(待ち受けない用途の解析を妨げない)
- **スモーク**(`scripts/smoke/`): `gateway-smoke.sh`(healthz → initialize → tools/list → search → 認証なし・不正トークンの 401。curl と node のみ。トークンと検索結果の中身を出力しない)、`keycloak-token.sh`(開発・CI 専用のパスワードグラント)
- **CI**: `.github/workflows/ci.yml` に `reference-deploy` ジョブ(`docker compose ... up -d --build --wait` → `e2e/keycloak/wait-ready.sh` → トークン取得 → スモーク → ログ出力 → `down -v`)。既存ジョブは変更なし
- **文書**: docs/install.md(5分手順、設定の注入と事前検証、秘密の渡し方、TLS 終端とリバースプロキシ(nginx 例)、監査ログの永続化、未実装事項、アップグレード骨子、導入チェックリスト、Helm 化の要件)
- **検証の範囲**: 作成環境に Docker デーモンがなく、`docker build` / `docker compose up` は未実行。確認済みなのは (1) `docker compose config`(静的検証)、(2) hadolint / shellcheck / actionlint、(3) Dockerfile の2ステージと同じファイル集合・npm コマンドのコンテナ外での再現と、その成果物での `validate`・`serve`・HEALTHCHECK のコマンド・スモーク(Keycloak は代役のサーバー)・SIGTERM での停止、(4) モック IdP での `gateway-smoke.sh`、(5) nginx 設定例の構文と挙動、(6) `packages/gateway/test/reference-deploy.test.ts`(リファレンス設定の検証・組み立てと、compose / .env.example / Dockerfile / realm との整合)。本物の Keycloak との結合(`KC_HOSTNAME` による `iss` の一致を含む)とイメージのビルドは PR #14 の CI(`reference-deploy`)で確認済み(2026-09-27。上記受け入れ条件1)。手元の Docker での起動は未確認

### 残課題
- 保持期限の定期削除ジョブ(`runRetentionPurge` の定期実行)と JSONL のローテーション(docs/install.md §8)
- 監査 sink の死活のヘルスチェック(threat-model TM-E6 が本タスクに割り当てている)は未実装。`/healthz` は待ち受けの死活だけを示す。バッファの滞留を readiness に反映するには `proxy/http.ts` の変更が要る(T-003 の残作業と合わせて判断)
- 本番の本人資格情報の取得(T-004)が入ったら、評価用ではないリファレンス構成(`NODE_ENV=production`)を追加する
