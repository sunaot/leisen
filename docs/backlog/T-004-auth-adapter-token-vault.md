# T-004: Auth Adapter実装(実接続)とToken Vault

## 前提(人手)
**T-000a(認可実現性マトリクス)完了。** IdPサンドボックス、各ソースのOAuthクライアント登録・管理者同意(方式は `docs/auth-matrix.md` の各ソース「管理者同意」欄参照)、KMS相当の鍵管理手段。

## 内容
- T-000aの結果(`docs/auth-matrix.md` 5章)に基づき、実現可能と確認されたソース別Auth Adapterを実装する: Entra ID on-behalf-of、Google個別OAuth(drive.readonly)、Slack個別OAuth(search:read)、GitHub Appユーザー認可、Atlassian 3LO(rotating refresh token対応必須)
- スコープ外(auth-matrix.md 5章): DWD / Box as-user(個別ADR待ち)、Kerberos委任(T-017)、Notion(T-020判断待ち)、社内DB(個別ADR)
- **Token Vault実装**: リフレッシュトークンの暗号化保管(KMS連携)、ローテーション、失効。IdPのdeprovisioningイベント(SCIM等)からの各SaaSトークンrevoke
- 初回同意フロー用のエンドポイント(T-007/T-009の接続促し導線が使う)
- 失効・スコープ不足時のエラー分類をGatewayに伝播

## 受け入れ条件
- [ ] サンドボックスに対する結合テスト手順がREADME化され、手動実行結果がPRに添付されている
- [ ] トークンが平文でディスク・ログに残らないことをレビューで確認(redactAuthContext使用の確認を含む)
- [ ] deprovisioningイベント受信→対象ユーザーの全SaaSトークン失効のテスト(モックで可)
