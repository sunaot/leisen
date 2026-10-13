# ADR-004: OSSライセンスの選定

Status: Accepted(2026-10-13 オーナー決定。LICENSE / NOTICE 配置済み)/ Date: 2026-07-04

## 文脈
本プロジェクトをOSSとして公開し、複数社のシングルテナント導入+導入支援を事業とする(product-design-v2.md)。SaaS運営は行わない。

## 決定
**Apache-2.0 を採用する。**

- リポジトリ直下に `LICENSE`(Apache-2.0 全文。配布元 https://www.apache.org/licenses/LICENSE-2.0.txt と同一)と `NOTICE` を置く
- 著作権表示は `NOTICE` に一括で記載する(`Copyright 2026 Sunao Tanabe`)。ソースファイルごとのライセンスヘッダは付けない(Apache-2.0 で必須ではなく、監査・認可の実装に関係しないため)
- 全ワークスペースと `spikes/` の `package.json` に `"license": "Apache-2.0"` を記載する。公開パッケージのメタデータと一致させる
- 貢献の受け入れは **DCO**(Developer Certificate of Origin)とし、別途の CLA は求めない。Apache-2.0 本文 §5 で貢献物の特許許諾が成立するため(CONTRIBUTING.md の整備は T-013)
- 本番依存のライセンスを確認した(2026-10-13、`package-lock.json` の非 dev 依存 101 件): MIT 89、ISC 8、BSD-3-Clause 2(fast-uri、qs)、BSD-2-Clause 1(json-schema-typed)、Unlicense 1(fast-sha256)。Apache-2.0 と両立しないもの(GPL / AGPL / LGPL 等)はない。リファレンス構成が別コンテナで参照する Keycloak(Apache-2.0)、LibreChat(MIT)、Caddy(Apache-2.0)、MongoDB(SSPL)は本リポジトリのライセンスに影響しないが、SSPL は導入企業の法務審査で論点になりうるため docs/install.md で注記する(T-013)

## 理由
- SaaSを事業としないため、第三者によるクラウドサービス化は直接の脅威ではなく、採用拡大が導入支援パイプラインの源泉になる
- 特許条項を持ち、企業の法務審査を通りやすい(採用摩擦最小)
- AGPL-3.0は防御力があるが国内企業の社内導入でも審査障壁になりやすく、事業モデルと不整合
- BSL 等のソースアベイラブルは「OSS として公開」の趣旨から外れる(product-design-v2.md §3.1)

## 残る確認事項(公開前・T-013)
- ~~`NOTICE` の著作権者名~~ → 2026-10-13 オーナー決定: **個人名(`Sunao Tanabe`)のままとする**。法人名には変えない
- ~~プロジェクト名・商標と配布名~~ → 2026-10-13 オーナー判断: **保留**(時期尚早)。公開は現在の名前(`@kp` スコープ・`kp-ask`・`_meta` prefix `io.github.sunaot.leisen/`)のまま行う(issue #32 / #38、ADR-001 追補3 決定4)。公開時期は「すぐに公開する」で決定

## 経緯
- 2026-07-04 Proposed(Apache-2.0 を提案。最終決定は経営判断)
- 2026-10-13 Accepted。LICENSE / NOTICE / package.json の `license` を配置。T-013 の「人手の前提」からライセンスを外した(PR #54)
- 2026-10-13 `NOTICE` の著作権者は個人名のままで確定(オーナー決定)
