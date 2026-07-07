# T-004: Auth Adapter実装(実接続)とToken Vault

## 前提(人手)
**T-000a(認可実現性マトリクス)完了。** IdPサンドボックス、各ソースのOAuthクライアント登録・管理者同意、KMS相当の鍵管理手段。

## 内容
- T-000aの結果に基づき、ソース別Auth Adapterを実装する(例: Entra ID on-behalf-of、Google個別OAuth、Slack個別OAuth)
- **Token Vault実装**: リフレッシュトークンの暗号化保管(KMS連携)、ローテーション、失効。IdPのdeprovisioningイベント(SCIM等)からの各SaaSトークンrevoke
- 初回同意フロー用のエンドポイント(T-007/T-009の接続促し導線が使う)
- 失効・スコープ不足時のエラー分類をGatewayに伝播

## 受け入れ条件
- [ ] サンドボックスに対する結合テスト手順がREADME化され、手動実行結果がPRに添付されている
- [ ] トークンが平文でディスク・ログに残らないことをレビューで確認(redactAuthContext使用の確認を含む)
- [ ] deprovisioningイベント受信→対象ユーザーの全SaaSトークン失効のテスト(モックで可)
