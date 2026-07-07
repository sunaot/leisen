# ADR-011: 監査データモデルの2層化とexistence leak対策

Status: Accepted / Date: 2026-07-05

## 文脈
T-001の単層AuditRecordでは、会話への束ねと反復連番がなく「何回再検索しても未解決」(product-design.md 4.4、T-014)を集計できない。また利用者フィードバックの更新先が未定義。加えて、post-filtering前の候補件数をログに残すと、返却0件との差分から「その語にマッチする未認可文書の存在」を漏らす(existence leak)。

## 決定
1. **2層モデル**: AnswerRun(runId, userId, actor[human/agentとon-behalf-ofチェーン], 最終質問digest, 開始/終了, finalOutcome, confidence, userFeedback, searchedSources, citedDocIds, failureReason)と ToolInvocation(runId, iteration, sourceId, tool, queryDigest, filtersDigest, returnedHitCount[認可済み返却件数のみ], fetchedDocCount, latencyMs, errorClass, retryCount)
2. **post-filtering前の候補件数フィールドを設けない。** post-filter品質の可視化(空振り率SLO)が必要な場合は、query/userId/docIdと結合できない集約テレメトリ(バケット化 0 / 1-10 / 11+、短期保持、閲覧はセキュリティ担当の高権限限定)として分離し、T-014の標準昇格レポートには含めない
3. **rawQueryは別テーブル**(queryDigestで結合、保持期間をdeployment.yamlで設定)。T-014が失敗クエリの原文参照に使う
4. **書き込み失敗時の挙動**: 既定はfail-closed(監査レコードを書けないツール呼び出しは失敗させる)+ローカルバッファによる緩和。可用性優先(fail-open)への切替はdeployment.yamlで明示設定した場合のみ許し、セキュリティポリシーへの明文化を導入プレイブックで要求する

## 帰結
- gateway/src/audit/ の骨格を2層に更新済み。zod化と検証強化はT-001
- 監査ログの閲覧権限・保持期間はADR-013(プライバシー方針)に従う
