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
- [ ] public/private/MPDM/DM/filesのscopeごとの検索範囲が明示され、private系が既定OFF(または明示同意)である
- [ ] RTS不可時のfallbackが定義されている(legacy searchへのfallbackを採用する場合はADR必須)
- [ ] レート制限対応(Retry-After尊重)がテストされている
- [ ] Slack RTS/MCP由来のcontent/metadata(permalink・channel/user/file名・timestamp含む)がいかなる永続ストアにも書かれないことがテストされている
- [ ] documentIdがSlackメタデータ由来(channel:ts等)の場合、永続化前に不可逆化されることがテストされている
