# T-004: Auth Adapter実装(実接続)とToken Vault

## 前提(人手)
**T-000a(認可実現性マトリクス、docs/auth-matrix.md)調査完了(2026-07-09)、人間レビュー完了によりゲート解除済み(2026-07-12、ADR-010 Accepted)。** 以下は auth-matrix.md で実現可能と確認済みの作業のみ:
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
- `Credential.expiresAt`(connector-sdk)が 0 以下の場合の意味(「失効時刻不明」)を Token Vault の表現と合わせて確定し、ADR-016 追補に記す。現状は SDK 未定義で、connector-github は暫定で「判定せず GitHub の 401 に委ねる」(`packages/connector-github/src/api.ts` の TODO。NaN / ±Infinity は失効扱い)

## 人間への確認事項(T-003 セキュリティレビュー 2026-09-27 からの申し送り)
- **ADR-022(Proposed、2026-10-20)**: 本人資格情報の置き場所の検討。既定は Token Vault を維持したうえで、Token Store の共通 IF、接続・解除・失効の監査事象、接続時の本人照合、Slack の識別子を保管しないことを本タスクの内容と受け入れ条件に加える案。確認事項 1〜4(認可サーバー化、永続化しないことを要件とするか、Token Store の境界、失効の責任分担)の判断が先
- **H2**: `IdpAdapter.authenticate`(HTTP配線によりMCPリクエストごとに呼ばれる)の結果キャッシュを導入する場合、キャッシュキーはセッショントークンのハッシュ(トークン値そのものを保持しない)、TTL は「IdP 側の失効がGatewayに反映されるまでの遅延上限」として本タスクで定める。現状はキャッシュなし・毎リクエスト検証(T-003 注記)

## 受け入れ条件
- [ ] サンドボックスに対する結合テスト手順がREADME化され、手動実行結果がPRに添付されている
- [ ] トークンが平文でディスク・ログに残らないことをレビューで確認(redactAuthContext使用の確認を含む)
- [ ] deprovisioningイベント受信→対象ユーザーの全SaaSトークン失効のテスト(モックで可)
