# T-019: GitHubコネクタ

## 前提(人手)
GitHub App/OAuth Appの作成と組織承認(本人トークンでの検索・取得)。

## 内容
- connector-sdk IFをGitHub検索API(code/issue/PR、nativeSearch: degraded)で実装
- fetchはファイル/イssue/PR本文。describeはアクセス可能なorg/repo一覧
- コード専用索引(シンボル/AST)はコア外(ADR-008)

## 受け入れ条件
- [ ] 全呼び出しが本人トークン
- [ ] レート制限対応(残quota尊重)がテストされている
