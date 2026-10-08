# T-006: Slackコネクタ(RTS/公式MCP第一候補)

## 前提(人手)
**導入形態の法務確認(ADR-014の3類型)**、Slackアプリの作成とワークスペース管理者承認、対象ワークスペースでのRTS利用可否確認。

## 内容
- **公式Slack MCPサーバー/RTS APIを第一候補として評価・採用する(ADR-001追補/ADR-014)。** legacyなsearch系メソッド前提の実装は行わない
- 全呼び出しは本人user token(各ユーザーのOAuth同意フロー)
- **取得データの非永続(不変条件7、ADR-014)**: 本文・スニペットに加え、permalink・channel名/ID・user名/ID・file名・timestamp等のメタデータも監査ログ・評価ログ・キャッシュ・カタログ生成・最終回答の永続履歴に残さない
- private/DM/MPDMスコープはADR-013の決定(既定excluded)に従う

## 受け入れ条件
- [ ] 全呼び出しが本人user tokenで行われる(bot token不使用)
- [ ] RTS利用可否の事前確認手順がdocs化されている
- [ ] semantic検索の可否(プラン・提供条件に依存)がConnectorCapabilitiesまたはdescribeに反映される
- [ ] public/private/MPDM/DM/filesのscopeごとの検索範囲が明示され、private系が既定OFFである(`consent` は #42 まで起動時に拒否される。ADR-016 追補2 決定6)
- [ ] **プライベート領域(ADR-016 追補2、connector-sdk v0.4)**: 会話の種別(public / private channel / MPDM / DM / files)ごとの `scope`(private / shared)の**対応表と判定の根拠**を README に書き、人間のレビューを受ける。判定に迷うものは private。分類の方法(結果ごとの会話の種別の判定)は着手時の fitting 検証で決める
- [ ] **能力の宣言**: `capabilities.privateScopeHandling` を宣言する(`enforced` を目指す: `excluded` では private 系の OAuth スコープを要求しない(T-004 の資格情報取得側)+可能ならクエリ条件で除く。除外の根拠と分類の根拠をできるだけ別にする)。`policy.privateScopes`(factory の `ConnectorFactoryInit.policy`)に従う
- [ ] **契約テスト**: search / fetch / list / describe の全結果に `scope` が付くこと、対応表どおりの分類、`excluded` で DM・プライベートチャンネルがソース側で除かれること、DM 等の documentId を直接 fetch した場合の拒否(`private_scope_excluded`。本人が取得できない文書は従来どおり `not_found` / `permission_denied`)をテストで固定する
- [ ] RTS不可時のfallbackが定義されている(legacy searchへのfallbackを採用する場合はADR必須)
- [ ] レート制限対応(Retry-After尊重)がテストされている
- [ ] Slack RTS/MCP由来のcontent/metadata(permalink・channel/user/file名・timestamp含む)がいかなる永続ストアにも書かれないことがテストされている
- [ ] documentIdがSlackメタデータ由来(channel:ts等)の場合、永続化前に不可逆化されることがテストされている
