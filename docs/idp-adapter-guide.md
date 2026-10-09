# IdP Adapter 開発ガイド(ドラフト、T-002)

Status: Draft / 対象: `packages/gateway/src/idp/`

IdP Adapter は ADR-005 の3つのプラグイン境界のひとつで、
「利用者のセッション検証」と「ソース別の本人資格情報の取得」を担う。
Gateway 本体は `IdpAdapter` IF(`authenticate` / `getCredential` /
`invalidateUser`)だけに依存し、IdP実装は deployment.yaml(T-010)で
差し替える。

## 全体像

```
クライアント ──(毎リクエストのBearerセッショントークン)──▶ Gateway
    Gateway ──▶ IdpAdapter.authenticate(token) ──▶ Identity { userId, session }
    Gateway ──▶ IdpAdapter.getCredential(identity, sourceId)
                   │  CredentialCache(userId×sourceId、TTL、single-flight)
                   └─▶ CredentialProvider(ソース別、方式A/B/C)
                          └─▶ Credential(oauth_bearer | delegated_identity)
    Gateway ──▶ Connector.search(AuthContext, ...)
```

`authenticate` はMCPのHTTPリクエストごとに、JSON-RPCをディスパッチする前に
呼ばれる(ADR-001 追補3 決定1。接続やセッションに本人を束縛しない)。
失敗の分類はそのままHTTP応答に写る: `unauthenticated` → 401、
`idp_unavailable` → 503、`misconfigured` 等 → 500(`proxy/http.ts`)。

## 認可方式の吸収(ADR-010 / auth-matrix.md §12.1)

`CredentialProvider` がソースごとの方式差を吸収する。

| 方式 | `method` | 実装の要点 | Token Vault |
|---|---|---|---|
| A. 個別OAuth | `oauth_individual` | `TokenVault.retrieve` でリフレッシュトークンを取得しアクセストークン化。未保管なら `source_not_connected` を投げ、初回同意UXへ誘導 | 要(実装はT-004) |
| B. token exchange(OBO) | `token_exchange` | `identity.session.subjectToken` を都度交換。保管しない | 不要 |
| C. delegated identity | `delegated_identity` | `identity.userId` からソース側principalを導出し `{ kind: "delegated_identity", principal }` を返す。**方式ごとにADR承認必須**(T-017) | 不要 |

方式D(サービスアカウント+本人判定)は既定不採用。プロバイダ・コネクタが
独自にサービスアカウントへフォールバックするコードは書かない(不変条件1)。

### IFがuserIdでなくIdentityを取る理由

バックログのIF案は `getCredential(userId, source)` だが、方式Bは本人の
IdPトークン(subject token)を交換に使うため、userId文字列だけでは資格情報を
導出できない。`authenticate()` が返す `Identity`(userId+セッション)を
受け取ることで方式A/B/Cを同一IFで吸収している。userId は
`identity.userId` を用いる。

## 新しいIdP(authenticate実装)を追加する

1. `CredentialResolvingIdpAdapter` を継承し `authenticate(sessionToken)` を実装する
   (プロバイダ委譲・キャッシュは基底クラスが担う)
2. 検証失敗は `IdpError("unauthenticated")`、IdP到達不能は
   `IdpError("idp_unavailable")` で区別する(fail-closed。到達不能を
   unauthenticated に潰すと利用者へ誤った再ログイン誘導をする。HTTP層では
   401 と 503 に分かれる)
3. `authenticate` はリクエストごとに呼ばれるため、検証のコスト(IdPへの往復)は
   毎リクエストのレイテンシに乗る。検証結果をキャッシュする場合はTTLが失効
   反映の遅延上限になる(採否はT-004で判断)
4. HTTP呼び出しはfetch注入・タイムアウト設定可能にする(開発ルール:
   外部APIは薄いラッパー越し)
5. `factory.ts` の `IdpAdapterConfig` にkindを追加する
6. 参照実装: `keycloak.ts`(イントロスペクション方式。採用理由は
   ファイル先頭コメント)

## 受け手・種別・発行者の検証(全アダプタの契約)

`authenticate` は「トークンが有効(active)であること」だけでは足りない。別の realm /
IdP が発行したトークン、アクセストークン以外のトークン(リフレッシュトークン・ID
トークン)、この Gateway 向けに発行されたのではないトークン(別のクライアントが
別の API のために取得したもの)を、すべて `unauthenticated` で拒否する(issue #16、
ADR-010 追補 2026-10-09)。検証は環境によらず常に行い、開発で緩められるのは
許可リストの内容だけで、緩めたことは設定(`allowedClients: ["*"]`)と起動ログの
WARNING に現れる。参照実装は `keycloak.ts` の `checkIntrospection`。

| 項目 | 契約 | Keycloak 参照実装(RFC 7662 の応答) |
|---|---|---|
| 発行者 | 期待する発行者と完全一致(末尾スラッシュは同一視)。欠落は拒否 | `iss` = `${baseUrl}/realms/${realm}`(realm は URL エンコード)。IdP の公開 URL が `baseUrl` と異なる構成だけ `allowedIssuers` で明示 |
| 種別 | 利用者のアクセストークンだけを受ける。欠落は拒否(fail-closed) | `typ` = `Bearer`(`Refresh` / `ID` は拒否) |
| 発行先 | トークンを得たクライアントが許可リストにあること。欠落は拒否 | `azp` ∈ `allowedClients`。`"*"` を含むときだけ省略(開発専用。`NODE_ENV=production` では `dev_only_in_production`) |
| 受け手 | 自分が受け手に含まれること(IdP 側の設定で付与される前提) | `requireAudience: true` のとき `aud`(文字列または配列)に自分の `clientId` を含む |

- 検証の順序は active → 発行者 → 種別 → 発行先 → 受け手で、最初の失敗で止める。失敗は
  すべて `IdpError("unauthenticated", <固定文言>)` にし、HTTP 層は 401 の固定文言に写す
  (理由を利用者に返さない)
- **診断フックの規則**: 失敗の理由は `diagnose`(factory の `deps.warn`。kp-gateway serve は
  stderr の `WARNING:`)に 1 行で渡す。渡してよいのはクレーム名と、設定値・クレームの値の
  うち秘密でないもの(`azp "foo" is not in allowedClients`、`aud does not include "gateway"`、
  `typ "Refresh" is not Bearer`、`iss mismatch`)だけ。トークン・`sub`(利用者 ID)・応答全体は
  渡さない(不変条件6)。診断フックにそれらが渡らないことをユニットテストで固定する
- 運用者の切り分けは `kp-gateway auth-check --config <yaml> --token-env <VAR>`(項目ごとの
  pass / fail / skipped)。新しいアダプタも同じ項目名(`active` / `iss` / `typ` / `azp` / `aud`)で
  `checkIntrospection` 相当を公開すると、同じコマンドで診断できる

## 新しいソース(CredentialProvider)を追加する

1. `CredentialProvider` を実装する(`sourceId` / `method` / `getCredential`)
2. 認可分岐を最優先でテストする: 未接続(`source_not_connected`)、
   失効(`unauthenticated` / コネクタ側 `auth_expired`)、ユーザー分離
3. 追加できる `Credential` の kind は connector-sdk の定義に限る。
   kind追加はコネクタIF変更でありADR必須(不変条件5)

## 不変条件との対応(レビュー観点)

- **不変条件1**: プロバイダは常に本人の資格情報を返す。サービスアカウント
  フォールバック禁止
- **不変条件4**: 資格情報キャッシュのキーは `userId × sourceId`
  (`cache.ts`)。キャッシュTTLは権限剥奪の反映遅延の上限になるため、
  deployment.yaml から注入可能(threat-model TM-C系)
- **不変条件6**: `Identity.session.subjectToken` / `clientSecret` /
  `Credential.accessToken` はログ・エラーメッセージ・監査ログに出さない。
  文字列化は `redactIdentity()` / `redactAuthContext()` 経由のみ。
  エラーメッセージにトークン値を含めないことをテストで確認する
- **本番でのモック無効化**: `MockIdpAdapter` / `MockCredentialProvider` は
  `NODE_ENV=production` で構築を拒否する(factoryでも二重に検査)

## 失効(deprovisioning)の流れ

IdPのSCIM等のイベント受信時(受信口はT-004以降):

1. `IdpAdapter.invalidateUser(userId)` — 資格情報キャッシュの即時破棄
2. `TokenVault.revokeAllForUser(userId)` — 方式Aの保管トークンをソース側で
   revoke(実装はT-004)

方式Bはトークンを保管しないためIdPセッション失効に自動追随する。
キャッシュTTL分の残存ウィンドウがあることに注意(1.で短縮)。

## テスト・E2E

- ユニット: `packages/gateway/test/idp-*.test.ts`
- E2E: `e2e/keycloak/`(実行方法・**検証範囲の限界**は同README)。
  実SaaSの認可経路はT-004以降で検証する

## 未確定事項(このドラフトの残課題)

- Token Vault の暗号化(KMS連携)・ローテーション詳細(T-004)
- deployment.yaml の idp セクションのスキーマ確定(T-010 と擦り合わせ)
- 監査ログへの認証イベント(authenticate失敗等)の記録要否(ADR-011の
  スコープ外。必要ならADR追記)
