# ADR-010: ソース別認可方式とToken Vault(ADR-002の改訂)

Status: Proposed(T-000a完了後にAccepted化) / Date: 2026-07-05

## 文脈
ADR-002はIdP起点のToken Exchange(RFC 8693)を基本方式、個別OAuthをフォールバックとした。しかしPhase 1の主要対象について、外部IdPトークンを各SaaSの本人アクセストークンへ交換する、公式に前提化できる汎用経路は確認できない(Google Workspace: 個別OAuth同意またはドメインワイド委任のみ。Slack: 本人のOAuth承認フローのみ。Entra ID→Graphのon-behalf-ofは成立)。「フォールバック」が実際の主経路であり、ADR-002の採用理由(トークン保管最小化、IdPでの一元失効)は前提から反転する。

## 決定(提案)
1. 認可方式は**ソース別Auth Adapter**で吸収する。token exchangeが成立するソース(Microsoft圏等)を例外として扱う
2. **Token Vault**を中核コンポーネントとする: 個別OAuthリフレッシュトークンの暗号化保管(KMS連携)、ローテーション、失効。IdPのdeprovisioningイベント(SCIM等)を受けて各SaaSトークンをrevokeする
3. **初回同意UX**を製品要件とする(未接続ソースのスキップと接続促し)
4. ドメインワイド委任等のサービスアカウント系資格情報は「認可判定が本人に対して行われる」場合に限りソースごとのADRで採用可否を判断する(不変条件1の精緻化: 認可判定の主体と資格情報の形態を分けて扱う)

## 未決事項
T-000a(主要10ソースの認可実現性マトリクス: 本人検索/本人fetch/permission check/token exchange可否/必要scope/rate limit/管理者同意/退職時失効/private・shared領域)の完了をもって本ADRをAcceptedに更新し、ADR-002をSupersededとする。

## 追補(2026-07-07): T-000a調査結果の反映

認可実現性マトリクスのドラフトが `docs/auth-matrix.md` として完成した。調査結果は本ADRの決定1〜4をすべて裏付ける:

1. token exchangeが公式に成立するのはMicrosoft圏(Entra ID on-behalf-of)のみ → 決定1(ソース別Auth Adapter、token exchangeは例外)
2. Google / Slack / GitHub / Atlassian / Notion / Box はすべて個別OAuthが主経路 → 決定2(Token Vault中核。Atlassianのrotating refresh token対応を要件に追加)
3. 全A方式ソースで本人同意フローが必要 → 決定3(初回同意UX)
4. 「認可判定が本人」となるサービスアカウント系はGoogle DWD / Box as-user / SMB Kerberos委任(T-017)の3系統。いずれも個別ADR必須 → 決定4

追加の発見: Notionは認可時のページ共有選択制のため「本人が読めるものは漏れなく対象」が成立しない(auth-matrix.md 3.6)。Slack自前コネクタは2025年レート制限で実用性が低く、公式MCP/RTS第一候補(ADR-014)を補強する。

**Accepted化の残条件(人手)**: auth-matrix.md はエージェントのモデル知識ベースのドラフトであり、同文書「6. 人手検証チェックリスト」の一次情報検証(参照URL・レート制限現行値・管理コンソール実地確認)の完了レビューをもって本ADRをAcceptedに更新し、ADR-002をSupersededとする。

## 帰結
- T-002はIdpAdapter IF(方式差の吸収)として実装する(旧T-011を統合)
- T-002のKeycloak E2Eは実SaaS(Drive/Slack)の認可経路を検証しない。この限界をCI/READMEに明記する
