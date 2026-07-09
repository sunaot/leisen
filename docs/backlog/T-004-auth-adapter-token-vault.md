# T-004: Auth Adapter実装(実接続)とToken Vault

## 前提(人手)
**T-000a(認可実現性マトリクス、docs/auth-matrix.md)完了済み(2026-07-09)。** 以下は auth-matrix.md で実現可能と確認済みの作業のみ:
- IdPサンドボックス(Keycloak自己ホスト or Entra IDテストテナント)
- Google: GCP OAuthクライアント登録(`drive.readonly` 等のRestricted scope。internalアプリの検証免除条件は導入形態ごとに要確認)+ Admin Consoleでのドメイン事前承認
- Slack: アプリ登録とワークスペース管理者承認(RTS scope: `search:read.public` 以上。privateスコープは本人同意ゲート付き)
- Entra ID: アプリ登録 + `Files.Read.All` / `Sites.Read.All`(delegated)のadmin consent
- GitHub: GitHub App登録。**導入前提としてOrgのSCIM(理想はEMU)連携を要求する**(SAML単独では退職後もトークンが失効しない — auth-matrix.md §4)
- KMS相当の鍵管理手段

## 内容
- auth-matrix.md §12.1 の方式分類に基づき、ソース別Auth Adapterを実装する(方式B: Entra ID on-behalf-of、方式A: Google個別OAuth、Slack個別OAuth)。方式C(delegated identity)はT-017の成果を待つ
- **Token Vault実装**: リフレッシュトークンの暗号化保管(KMS連携)、ローテーション、失効。IdPのdeprovisioningイベント(SCIM等)からの各SaaSトークンrevoke
- 初回同意フロー用のエンドポイント(T-007/T-009の接続促し導線が使う)
- 失効・スコープ不足時のエラー分類をGatewayに伝播

## 受け入れ条件
- [ ] サンドボックスに対する結合テスト手順がREADME化され、手動実行結果がPRに添付されている
- [ ] トークンが平文でディスク・ログに残らないことをレビューで確認(redactAuthContext使用の確認を含む)
- [ ] deprovisioningイベント受信→対象ユーザーの全SaaSトークン失効のテスト(モックで可)
