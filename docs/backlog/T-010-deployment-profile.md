# T-010: Deployment Profileスキーマとローダー【T-003より先に実施】

## 目的
ADR-005の設定駆動アーキテクチャの中核。導入1件=deployment.yaml 1枚を成立させる。T-003は本タスクのスキーマの最小サブセットに依存する(sources.yamlは作らない)。

## 前提
**T-000b(プライバシー方針、ADR-013)の決定。**

## 内容
- `packages/gateway/src/config/` にスキーマ(zod)、ローダー、静的検証を実装
- 項目: idp.adapter, connectors[](enabled, **privateScopes: excluded|consent|included(既定excluded)**, searchLayer.enabled/backend/authzCacheTtlSec), orchestrator(maxIterations, costLimit), audit(sink, **failureMode: fail-closed|fail-open(既定fail-closed)**, **privateScopeDocIds: hashed|omitted(既定hashed、ADR-013)**, **retentionDays(既定365)**, **rawQueryRetentionDays(既定30)**, **telemetryRetentionDays(既定14)**), **chatHistory.retentionDays(既定90、ADR-013)**, **agentExecution(ADR-015の区分設定の予約)**
- スキーマバージョンフィールドと将来のマイグレーション枠組み
- 危険設定の起動時拒否: searchLayer.enabled=true かつ対象コネクタがingest capability未実装、authzCacheTtlSecの上限超過、audit.failureMode=fail-openかつ確認フラグなし、**privateScopes: included かつ確認フラグなし(ADR-013 §1、TM-E4)** 等

## 受け入れ条件
- [ ] 妥当な設定のサンプル(examples/deployment.yaml)が同梱され、READMEから参照される
- [ ] 危険設定パターンごとに起動拒否のテストがある
- [ ] ConnectorCapabilities連動の検証: searchLayer.enabled=trueはingest:trueのコネクタのみ許可、nativeSearch:"none"のコネクタはsearchLayer.enabled=trueとセットでのみ許可(ADR-007)
- [ ] privateScopesの既定がexcludedであることがテストされている

## 更新(2026-09-27): 起動コード向けのスキーマ追加

起動コード(`kp-gateway` CLI、`assembleGateway`。`packages/gateway/src/bootstrap/`)がコネクタ実体・本人資格情報・監査シンクを設定から組み立てるための項目を追加した。**すべて追加のみ・既定値ありで、schemaVersion は 1 のまま**(既存の設定はそのまま通る)。スキーマの正は `packages/gateway/src/config/schema.ts`。

| 項目 | 型・既定 | 内容 |
|---|---|---|
| `connectors[].kind` | 文字列(英小文字・数字・`-`)。省略時は `id` と同じ | コネクタ実装の識別子。組み込みの `dev-fixture`(開発専用)またはプラグイン名 |
| `connectors[].module` | 文字列、任意 | プラグインの import 指定子。省略時は `@kp/connector-<kind>`。パッケージ名(サブパス可)か `./` `../` `/` で始まるパス(相対パスは設定ファイルの所在ディレクトリ基準)。URLスキーム(`data:` / `https:` 等)は拒否。組み込みの kind(`dev-fixture`)との併用は拒否。`@` で始まる値は YAML では引用符が必要。**設定から任意のコードを読み込む経路のため、deployment.yaml とプラグインの置き場所の書き込み権限は管理者に限る** |
| `connectors[].settings` | 任意のマッピング、既定 `{}` | コネクタ固有の**秘密でない**設定。検証はコネクタの factory が行う。秘密情報らしいキー(末尾が token / secret / password / apiKey / privateKey / credential(s) / cookie)は拒否し、秘密は `<name>Env` に環境変数名を書いて参照する(`*Env` の値は環境変数名の形式を強制。不変条件6) |
| `connectors[].auth` | `{ provider: "mock_env" }`、任意 | 本人資格情報の取得方式(ADR-010)。当面 `mock_env`(環境変数 `KP_MOCK_TOKEN_<SOURCEID>`、開発専用)のみ。T-004 で `oauth_individual` 等を追加する。**有効なコネクタで欠落すると起動時に拒否**(`connector_auth_provider_missing`。スキーマ検証だけでは拒否しない) |
| `audit.jsonl` | `{ path, rawQueryPath? }`、任意 | `audit.sink: jsonl` の出力先。監査レコードを1行1件のJSONで追記(promotion-report の入力形式)。`rawQueryPath` 省略時は生クエリ原文をメモリにのみ保持。`sink: jsonl` で欠落すると拒否(`audit_sink_options_missing`) |

`audit.sink` は自由文字列のままで、起動コードが解決できない値(`stdout` / `jsonl` 以外)は起動時に拒否する(`unknown_audit_sink`)。

起動コードが出す検証コード(`ConfigIssueCode` に追加): `unknown_audit_sink` / `audit_sink_options_invalid`(出力先に書けない、`rawQueryPath` が監査ログと同じ)/ `unknown_connector_kind` / `connector_plugin_invalid` / `connector_settings_invalid` / `connector_factory_failed` / `connector_auth_provider_missing` / `idp_adapter_misconfigured` / `dev_only_in_production`(NODE_ENV=production で mock IdP・`mock_env`・`dev-fixture` を使おうとした)。

あわせて、無効化したコネクタ(`enabled: false`)は実体を構築しないため、capability 連動の検証で実体の登録(`unknown_connector_id`)を要求しないようにした(有効なコネクタは従来どおり要求する)。

追加(2026-10-09、issue #17、ADR-011 追記): `audit.sink: stdout` は開発専用とし、`NODE_ENV=production` では起動コードが `dev_only_in_production` で拒否する(`kp-gateway validate` / `serve` の WARNING にも列挙)。`idp.adapter.confirmPlainHttp`(keycloak、boolean、省略時 false 扱い・解析結果には補わない): `baseUrl` が平文 `http:` でループバック以外を指すとき true を要求し、なければ静的検証が `idp_plain_http_requires_confirmation` で拒否する(`validate.ts` の `validateIdpTransport`。docs/install.md §6.4)。`examples/deployment.yaml` は `jsonl` + `https` に変更。schemaVersion は 1 のまま。

追加(2026-10-09、issue #16、ADR-010 追補): keycloak アダプタに `allowedClients`(文字列の配列、**必須・空不可**): トークンの発行先クライアント(`azp`)として受け入れるクライアント ID。`"*"` を含むと(他の項目と混在しても)`azp` の検証を省き、起動コードが `NODE_ENV=production` では `dev_only_in_production` で拒否し、それ以外では WARNING(`any client is accepted …`)を `kp-gateway validate` / `serve` に出す。`requireAudience`(boolean、既定 false): true なら `aud` に自分の `clientId` を要求する。`allowedIssuers`(文字列の配列、任意): 受け入れる `iss`。省略時は `<baseUrl>/realms/<realm>`。IdP の公開 URL が `baseUrl` と異なる構成(リファレンス compose の `KC_HOSTNAME`)でだけ書く。`typ` が `Bearer` であることの検証は設定によらず常に行う。診断コマンド `kp-gateway auth-check --config <yaml> --token-env <VAR>` を追加。schemaVersion は 1 のまま。

追加(2026-09-27、T-012): `gateway.http.confirmExposedHost`(boolean、省略時 false 扱い・解析結果には補わない)。`gateway.http.host` がループバック以外のとき true を要求し、なければ起動コードが `http_host_exposed_requires_confirmation` で拒否する(`validate.ts` の `validateGatewayHttpExposure`。Gateway は TLS を終端せず Host / Origin も検証しないため、前段のリバースプロキシに委ねる前提の明示。T-003 レビュー minor-11、docs/install.md §6)。schemaVersion は 1 のまま。

コネクタ実装の解決順(`bootstrap/plugins.ts`): `assembleGateway` の `connectorFactories[kind]`(プログラム登録)→ 組み込み(`dev-fixture`)→ 動的 import(`module ?? "@kp/connector-<kind>"`)の `createConnector` 名前付き export(なければ関数の default export)。契約 `ConnectorFactory = (init: { sourceId, settings, configDir }) => Connector | Promise<Connector>` は起動コード側のもので、connector-sdk の IF は変更していない。
