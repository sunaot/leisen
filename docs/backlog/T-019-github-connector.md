# T-019: GitHubコネクタ

## 前提(人手)
GitHub App/OAuth Appの作成と組織承認(本人トークンでの検索・取得)。

## 内容
- connector-sdk IFをGitHub検索API(code/issue/PR、nativeSearch: degraded)で実装
- fetchはファイル/イssue/PR本文。describeはアクセス可能なorg/repo一覧
- コード専用索引(シンボル/AST)はコア外(ADR-008)

## 受け入れ条件
- [x] 全呼び出しが本人トークン
- [x] レート制限対応(残quota尊重)がテストされている

## 実装状況(2026-09-27)

**実装済み・モックテスト済み。残りは GitHub App 承認後の実疎通記録のみ。**

- `packages/connector-github`(`@kp/connector-github` 0.1.0、依存は `@kp/connector-sdk` のみ)。connector-sdk v0.3 の IF は変更していない
- API 薄ラッパー(`src/api.ts`): baseUrl(GHES 可)・タイムアウト・User-Agent・fetch を注入可能。全リクエストに本人トークン(`Authorization: Bearer`)と GitHub 標準ヘッダを付与し、応答を ConnectorErrorClass に分類する。サービスアカウント・installation token へのフォールバックなし(不変条件1)
- 残quota(`src/quota.ts`): `x-ratelimit-*` / `retry-after` / 二次制限の指数バックオフを userId × リソース種別(core / search / code_search)ごとに上限件数付きで保持し、制限中は API を呼ばずに `rate_limited`(retryAfterMs 付き)を返す
- search は issue / PR(GitHub App の user access token では混在検索不可のため別クエリ)/ コードの3本を統合。総件数(total_count)は返さない(ADR-012)
- テスト(vitest、フェイク GitHub API): 認可分岐(資格情報の前提違反・401/403/404/422/5xx・通信失敗・タイムアウト・本人トークンの付与とユーザー間の非混線・エラーメッセージの非流出・baseUrl 外へのリダイレクトを追わない)、残quotaの尊重(ユーザー別・リソース種別の分離、reset 後の再開、上限件数)、snippet 長、documentId の往復、ページング、base64 復号・バイナリ拒否、filters の修飾子生成、list / describe
- 使い方・前提・既知の限界は `packages/connector-github/README.md`
- **セキュリティレビュー 2026-09-27: PASS、R1〜R3・minor 反映済み。** R1: 脅威モデルに §4-H(GitHub コネクタ固有、TM-H1〜H5)を新設。R2: README の資格情報を「本番は GitHub App の user access token に限る(ADR-010 方式A)、PAT は開発時の MockCredentialProvider 経由のみ」に改め、権限境界の検証ではユーザー別 `KP_MOCK_TOKEN_GITHUB__<USERID>` を必須化。R3: Gateway が LLM/利用者向けに `permission_denied` / `not_found` を同一の `not_available` に正規化(TM-B2、監査は元の分類を保持)。minor: 偽造カーソル(per_page 合計の上限超過)の拒否、installation / refresh token 接頭辞の拒否、有限でない `expiresAt` の失効扱い、注入 fetch の `redirect: "manual"` 前提の明示と追従済み応答の破棄、エンコード済み区切り文字を含むリダイレクトの非追従、公開 API を factory と型に限定、`filters.container` が安全境界でないことの開示、guard hook の GitHub トークン接頭辞の拡張。見送り: 本文の部分読み・サロゲートペア(認可・秘密情報の境界に関わらない品質改善のため別途)、部分失敗の監査(将来 ADR)、Orchestrator 側で対処済みの申し送り

### 残作業(人手の前提待ち)
- [ ] GitHub App の作成と組織承認(OAuth App アクセス制限・SAML SSO 認可・SCIM/EMU 連携の確認を含む。auth-matrix §4)
- [ ] 実アカウントでの手動疎通結果の記録(本人トークンでの search / fetch / list / describe、権限外 private repo の非ヒット・fetch 拒否=カナリア検証 threat-model §5.2、SAML SSO 未認可 org の挙動、Enterprise internal repo の可視性、レート制限ヘッダの実値)
- [ ] SSO 強制 org で、存在しない repo と存在するが権限外の repo の応答差(403-SSO か 404 か)を実疎通で記録する(threat-model TM-H1。Gateway は両者を `not_available` に正規化済みだが、ソース側の区別の有無を把握しておく)
- [ ] deployment.yaml へのコネクタ組み込み(T-012 のデプロイ組み立てで `createGitHubConnector` にタイムアウト等を注入)
