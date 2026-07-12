# ADR-010: ソース別認可方式とToken Vault(ADR-002の改訂)

Status: Accepted(2026-07-12 人間レビュー完了・承認。ADR-002は同時にSuperseded)/ Date: 2026-07-05 / 調査反映: 2026-07-09

## 文脈
ADR-002はIdP起点のToken Exchange(RFC 8693)を基本方式、個別OAuthをフォールバックとした。しかしPhase 1の主要対象について、外部IdPトークンを各SaaSの本人アクセストークンへ交換する、公式に前提化できる汎用経路は確認できない(Google Workspace: 個別OAuth同意またはドメインワイド委任のみ。Slack: 本人のOAuth承認フローのみ。Entra ID→Graphのon-behalf-ofは成立)。「フォールバック」が実際の主経路であり、ADR-002の採用理由(トークン保管最小化、IdPでの一元失効)は前提から反転する。

**T-000a(docs/auth-matrix.md、2026-07-09)による裏付け**: 主要ソースの一次情報調査により上記が確定した。要点:
- token exchange が公式に成立するのは Microsoft 圏(Entra ID On-Behalf-Of、delegated専用)のみ。GoogleのWorkforce Identity FederationはRFC 8693準拠だがWorkspace API対象外
- Google / Slack / GitHub / Confluence / Notion / Box はいずれも本人の個別OAuth承認が唯一の本人資格情報取得経路
- 失効経路はソースごとに異なる(Slack: アカウント無効化で自動失効、M365: CAE、GitHub: SCIM/EMU連携が前提でSAML単独では失効しない、Kerberos/STS: チケット寿命ラグ)
- ファイル共有(SMB)/S3/社内DBは「中央検索API不在(index-required)」かつ「delegated identityが必要」の交差クラス(T-015/T-017)
- Notionの本人性は部分的(権限逸脱はしないがrecallが構造的に欠落する「botへの共有範囲」モデル)

## 決定
1. 認可方式は**ソース別Auth Adapter**で吸収する。token exchangeが成立するソース(Microsoft圏等)を例外として扱う
2. **Token Vault**を中核コンポーネントとする: 個別OAuthリフレッシュトークンの暗号化保管(KMS連携)、ローテーション、失効。IdPのdeprovisioningイベント(SCIM等)を受けて各SaaSトークンをrevokeする
3. **初回同意UX**を製品要件とする(未接続ソースのスキップと接続促し)
4. ドメインワイド委任等のサービスアカウント系資格情報は「認可判定が本人に対して行われる」場合に限りソースごとのADRで採用可否を判断する(不変条件1の精緻化: 認可判定の主体と資格情報の形態を分けて扱う)
5. **Auth Adapter の方式分類**(auth-matrix.md §12.1)を採用する: A. 個別OAuth(Vault要)/ B. token exchange(OBO、Vault不要)/ C. delegated identity(方式ごとにADR承認必須)/ D. サービスアカウント+本人判定(既定不採用、ソース別ADRで例外承認)

## 帰結
- ADR-002 は本ADRの**Accepted化と同時に Superseded** となる
- T-002はIdpAdapter IF(方式差の吸収)として実装する(旧T-011を統合)。IFは方式A/B/Cの差を吸収できること
- T-002のKeycloak E2Eは実SaaS(Drive/Slack)の認可経路を検証しない。この限界をCI/READMEに明記する
- T-004の前提・内容は auth-matrix.md の確定方式(Entra ID OBO / Google個別OAuth / Slack個別OAuth、GitHubはSCIM/EMU前提)に更新済み
- 導入チェックリスト(T-012)に「GitHub SCIM連携必須」「Google管理者事前承認」等のソース別前提を反映する(auth-matrix.md §13)
