# T-001: 監査ログスキーマとロガー(2層モデル)

## 目的
全ツール呼び出しの監査記録(プロダクト原則4)と昇格判断のデータ基盤。ADR-011の2層モデルを完成させる。骨格は `packages/gateway/src/audit/` に実装済み。

## 内容
- 骨格のAnswerRun / ToolInvocationレコードをzodスキーマ化し、検証を強化する
- ToolInvocationは returnedHitCount(認可済み返却件数)のみを持つ。**post-filtering前の候補件数フィールドを追加しない**(ADR-011/012、existence leak対策)
- rawQueryはqueryDigestで結合できる短期保持の別テーブルとして設計(保持期間はdeployment.yamlから注入)。T-014が原文参照に使う
- actor(human/agent、on-behalf-ofチェーン)の記録(ADR-015)
- 出力は構造化JSON。書き込み失敗時の挙動はADR-011(既定fail-closed)に従い、Gateway統合はT-003
- AuditSink.write は Promise を返す(骨格で非同期化済み)。永続sink(retry・local buffer・at-least-once・shutdown時flush)とstdoutデバッグsinkを分離して実装する
- **型・zodスキーマにpre-filter候補件数フィールドが存在しないこと**をテストで検証する(guard hookは補助、テスト/型が本命)
- **禁止**: トークン・認証ヘッダ・文書本文・未認可候補の内容/件数をログに含めない。プライベートスコープのdocIdは `audit.privateScopeDocIds: hashed | omitted`(既定hashed、デプロイ固有鍵HMACで秘匿化。ADR-013決定値)に従って処理する。**Slack由来docIdは設定に関わらず記録しない**(omitted扱い。HMACはADR-014の不可逆化要件を満たさない — ADR-013 §2)
- 保持期間の設定注入(ADR-013決定値): 監査ログ本体は既定365日、rawQueryは既定30日、分離テレメトリは既定14日。期限超過分の削除と削除実行の記録
- **メタ監査**: 監査ログへのアクセス自体を記録する(ADR-013 §3、TM-F3)

## 受け入れ条件
- [ ] zodスキーマで両レコード(AnswerRun / ToolInvocation)が検証される
- [ ] 秘密情報・pre-filter候補件数のフィールドが型レベルで存在しない
- [ ] runIdで束ねて「ソース別未解決率」「再検索回数分布」を集計するサンプルクエリがdocsに付属
- [ ] rawQueryテーブルの保持期間が設定注入可能で、digest結合の例が付属
- [ ] 正常系・検証失敗系・禁止フィールド混入のテスト
