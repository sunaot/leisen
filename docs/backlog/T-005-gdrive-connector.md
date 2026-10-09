# T-005: Google Driveコネクタ

## 前提(人手)
GCPプロジェクトでOAuth同意画面とクライアントが承認済みであること。認証情報は環境変数で注入。

## 内容
- connector-sdkの `search/fetch/list/describe` を Google Drive API v3 で実装
- searchは files.list の fullText 検索を利用。フィルタ: 期間、オーナー、MIMEタイプ
- fetchはGoogle Docs/Sheets/Slidesをテキストにexport、その他はテキスト抽出可能な範囲で
- 公式Drive MCPサーバーの利用可否を最初に評価し、本人トークン要件とGateway統合(監査・境界・deployment.yaml)を満たすなら採用(判断を新規ADRとして記録。ADR-001追補参照)

## 受け入れ条件
- [ ] 全API呼び出しが呼び出しユーザーのトークンで行われる(サービスアカウント不使用)
- [ ] レート制限(429)時の指数バックオフがテストされている
- [ ] describeが共有ドライブ一覧と主要フォルダ構造を返す
- [ ] **プライベート領域(ADR-016 追補2、connector-sdk v0.4)**: 何を `scope: "private"` とするか(個人スコープ=マイドライブ全体か、本人だけが見られる文書か。auth-matrix §2)の**対応表と判定の根拠**を README に書き、人間のレビューを受ける。判定に迷うものは private
- [ ] **能力の宣言**: `capabilities.privateScopeHandling` を宣言する(`enforced` を目指す: `corpora` 等でクエリで除ける分はソース側で除き、除外の根拠と分類の根拠をできるだけ別にする)。`policy.privateScopes`(factory の `ConnectorFactoryInit.policy`)に従う
- [ ] **契約テスト**: search / fetch / list / describe の全結果に `scope` が付くこと、対応表どおりの分類、`excluded` で private がソース側で除かれること(`enforced` の場合)をテストで固定する
- [ ] 記録: 実アカウントでの手動疎通結果をPRに添付
