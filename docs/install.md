# 導入手順(リファレンスデプロイ、T-012)

このドキュメントは、Gatewayを1社1デプロイ(ADR-005)で導入する手順を示す。
構成の実体は `deploy/reference/` にある(Docker Compose)。Helm/Kubernetes化は
現時点でスコープ外(本文末尾の「Helm化の要件メモ」参照)。

## 構成要素

| サービス | 役割 | 備考 |
|---|---|---|
| gateway | MCP Gateway(認証・監査・ルーティング) | このリポジトリからビルド |
| keycloak | IdP(参照実装) | 既存IdPがある場合は差し替え可 |
| (検索バックエンド) | 汎用検索層(ADR-006) | エンジン選定(T-016)後にprofile指定で追加。全導入は検索層OFFで開始する |

## 前提

- Docker / Docker Compose v2
- 導入先の deployment.yaml(下記)と、それが参照する秘密情報(環境変数)

## 手順

### 1. deployment.yaml を用意する

導入1件の全構成は deployment.yaml 1枚で表現する(ADR-005)。
出発点として `deploy/reference/deployment.yaml`(最小)または
`examples/deployment.yaml`(全項目の説明付き)をコピーして編集する。

- スキーマの正: `packages/gateway/src/config/schema.ts`
- 危険設定(fail-openの未確認有効化、privateScopes: included の未確認有効化、
  検索層の不正な有効化など)は起動時に拒否される(`config/validate.ts`)
- **秘密情報(clientSecret等)をこのファイルに書かない**(不変条件6)。
  ファイルには環境変数の「名前」(例: `clientSecretEnv: KP_KEYCLOAK_CLIENT_SECRET`)
  だけを書き、値は環境変数で注入する

### 2. deployment.yaml をvolume注入する

Gatewayコンテナは起動時に `KP_DEPLOYMENT_CONFIG`(既定
`/etc/kp/deployment.yaml`)から設定を読む。compose では read-only volume で
注入する:

```yaml
services:
  gateway:
    volumes:
      - ./deployment.yaml:/etc/kp/deployment.yaml:ro
    environment:
      KP_KEYCLOAK_CLIENT_SECRET: ${KP_KEYCLOAK_CLIENT_SECRET}
```

設定不備・危険設定があるとGatewayは起動せず、全不備を列挙した
`deployment config rejected` エラーを標準エラーに出す(1回の起動失敗で
全件把握できる)。

### 3. 起動と確認

```sh
docker compose -f deploy/reference/docker-compose.yml up -d --build
deploy/reference/smoke.sh
```

smoke.sh は「/healthz応答 → 未認証拒否(401) → IdPトークンでのMCPセッション
確立 → tools/list」までを確認する。CIの `reference-deploy` ジョブが同じ検査を
クリーンなコンテナ環境で自動実行している。

エンドポイント:

- `GET /healthz` — 死活確認(認証不要。構成情報は返さない)
- `POST /mcp` — MCP(Streamable HTTP)。`Authorization: Bearer <IdPトークン>`
  でセッションを確立する

セキュリティ上の注意:

- **`mcp-session-id` はベアラ資格として扱う**(MCP Streamable HTTPの設計)。
  セッション確立後のリクエストはこのIDでルーティングされるため、ログ・URL等に
  書き出さず秘匿すること。IdPトークン失効の即時反映はセッション層ではなく
  資格情報層(`IdpAdapter.invalidateUser`、TM-C4)が担う
- Gatewayの生HTTPサーバーはHost/Originの検証を行わない。ブラウザから直接
  到達させる構成にする場合や共有ネットワークに面する場合は、前段の
  リバースプロキシでHost/Origin制限(DNSリバインディング対策)を行うこと。
  エンドポイントはBearer必須でCookie等のアンビエント認証を使わないため、
  リスクは限定的だが多層防御として推奨する

### 4. 本番導入での差し替えポイント

リファレンス構成は開発・評価用の既定を含む。本番では以下を差し替える:

- **IdP**: 同梱Keycloakは参照実装。既存IdPを使う場合は deployment.yaml の
  `idp.adapter` を差し替える(IdP Adapterはプラグイン境界。ADR-005、
  docs/idp-adapter-guide.md)
- **監査シンク**: `audit.sink: stdout` はat-least-once非保証の開発用。
  本番は導入先の監査ストア向け `AuditStoreWriter` を実装し、
  `assembleGateway` の `auditSinks` 登録簿に登録して差し替える
  (`packages/gateway/src/server/assemble.ts`)。監査ストアはappend-only構成を
  標準とする(threat-model TM-F1)
- **秘密情報の管理**: composeの `${VAR:-dev-only-...}` 既定値は同梱realm専用。
  実環境ではシークレットストア(環境変数注入)で必ず上書きする
- **コネクタ**: コネクタ実装(T-005以降)の追加時に、Gatewayサーバーの
  組み立て(`packages/gateway/src/server/main.ts`)へ実体を登録し、
  deployment.yaml の `connectors` に宣言する

## アップグレード手順(骨子)

イメージ差し替え+設定マイグレーションの2段で行う。

1. **退避**: 現行の deployment.yaml と監査ストアをバックアップする
2. **リリースノート確認**: 対象バージョンの設定スキーマ変更
   (`schemaVersion`)・ADR追加を確認する
3. **イメージ差し替え**: 新しいイメージタグで `docker compose up -d --build`
   (または配布イメージのタグ更新)。Gatewayはステートレス
   (セッションはインメモリ)のため、再起動でMCPセッションは切れる。
   クライアントは再接続すればよい
4. **設定マイグレーション**: 旧 `schemaVersion` の deployment.yaml は起動時に
   自動で現行バージョンへ移行される(`config/migrate.ts`)。
   - 新しいビルドが知らない(より新しい)schemaVersionは起動時拒否される。
     「新しい設定を古いビルドで黙って読み違える」事故は起きない
   - 移行はメモリ上で行われ、ファイル自体は書き換えない。恒久化する場合は
     移行後の内容にファイルを更新して差分をレビューする
5. **起動確認**: `deploy/reference/smoke.sh`(または同等の確認)を実行する
6. **切り戻し**: 問題があれば旧イメージタグ+退避した deployment.yaml に戻す

監査ストア側のスキーマ変更(2層モデルの変更)が入る場合は、該当リリースの
移行手順(ADRと共に提供)に従う。

## Helm化の要件メモ(スコープ外、将来タスク用の記録)

Helm/Kubernetes対応は要件のみ記録し、実装しない(T-012受け入れ条件):

- deployment.yaml はConfigMapではなくSecretと分離した上でvolume注入できること
  (設定自体は秘密を含まない設計だが、導入先ポリシーによりSecret扱いを
  選べること)
- 秘密情報(`*Env` が参照する環境変数)は外部シークレットストア
  (External Secrets等)から注入できること
- 監査シンクの可用性要件: 監査ストアが落ちるとfail-closed既定でツール呼び出しが
  止まるため、監査ストアのHA・PodDisruptionBudgetを導入ガイドに含めること
- GatewayはステートレスでレプリカN可。ただしMCPセッション(mcp-session-id)は
  インメモリのため、セッションアフィニティ(sticky routing)が必要
- ソース別レート制御(maxRequestsPerMinute)はプロセス単位で適用される。
  レプリカ数を掛けた実効値になることを values の説明に明記すること
- NetworkPolicy: コネクタ→ソースAPIのegress以外を絞り、Gatewayを経由しない
  ソースアクセス経路を作らない(不変条件2)
