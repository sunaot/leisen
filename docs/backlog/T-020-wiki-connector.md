# T-020: wikiコネクタ(Confluence/Notion等、導入先で選択)

## 前提(人手)
対象wikiのOAuthアプリ承認。T-000aで対象製品の本人権限方式を確定していること。

## 内容
- connector-sdk IFを対象wikiのネイティブ検索で実装(nativeSearchは製品により full/degraded)
- describeはスペース一覧

## 受け入れ条件
- [ ] 全呼び出しが本人トークン
- [ ] スペース/ページ権限外のコンテンツがヒットに現れないことのテスト
