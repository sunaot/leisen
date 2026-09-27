# 監査ログ サンプルクエリ(T-001)

2層監査モデル(ADR-011)のレコードを runId で束ねて集計するサンプル。
昇格判定レポート(T-014)の「ソース別未解決率」「再検索回数分布」と、
rawQueryテーブルの digest 結合の例を示す。

前提: 監査レコードが `audit_records`、生クエリが `raw_queries` という
テーブル/ビューに格納されている(構造化JSONをロードした列指向ストア等。
永続ストアの選定はT-003/T-012)。列名は `packages/gateway/src/audit/schema.ts`
のフィールド名と一致する。

## 0. AnswerRun と ToolInvocation の結合は (runId, userId)

AnswerRun(Orchestrator が書く)と ToolInvocation(Gateway が書く)は **(runId, userId) の組で
結合する**。AnswerRun.userId は Gateway が認証した userId(tools/call の結果の `_meta`)に
束縛されている(T-007 セキュリティレビュー 2026-09-27 H1)ため、正常な run では同じ runId の
ToolInvocation と userId が一致する。runId は呼び出し元が申告する値で Gateway は認証しない
ため、runId だけで結合すると、別の利用者が同じ runId を申告した ToolInvocation を他人の run に
混ぜうる。**不一致は警告として扱い**(集計から外し、次のクエリで定期的に検出して原因 —
実装の不具合・申告の偽装 — を調べる)、以下の集計はすべて (runId, userId) で結合する。

```sql
-- runId は同じだが userId が食い違う ToolInvocation(警告)
SELECT
  ar.runId,
  ar.userId  AS answer_run_user,
  ti.userId  AS tool_invocation_user,
  COUNT(*)   AS invocations
FROM audit_records ar
JOIN audit_records ti
  ON ti.recordType = 'tool_invocation' AND ti.runId = ar.runId
WHERE ar.recordType = 'answer_run'
  AND ti.userId <> ar.userId
GROUP BY ar.runId, ar.userId, ti.userId;
```

AnswerRun のない runId の ToolInvocation は、単発の呼び出し(runId 未申告)か、Orchestrator が
利用者を確認できずに終えた run(describe フェーズで Gateway の認証に失敗した等。AnswerRun は
書かない)である。

注: 昇格判定レポート(`packages/promotion-report`)の集計は現状 runId だけで結合している。
(runId, userId) での結合と不一致の警告への追随は T-014 側の残作業。

## 1. ソース別未解決率

「どのソースを検索した会話が未解決に終わりやすいか」。AnswerRun の
finalOutcome と ToolInvocation の sourceId を (runId, userId) で結合する(§0)。

```sql
SELECT
  ti.sourceId,
  COUNT(DISTINCT ar.runId)                                            AS runs,
  COUNT(DISTINCT CASE WHEN ar.finalOutcome = 'unresolved'
                      THEN ar.runId END)                              AS unresolved_runs,
  ROUND(
    COUNT(DISTINCT CASE WHEN ar.finalOutcome = 'unresolved'
                        THEN ar.runId END) * 1.0
      / COUNT(DISTINCT ar.runId), 3)                                  AS unresolved_rate
FROM audit_records ar
JOIN audit_records ti
  ON ti.recordType = 'tool_invocation' AND ti.runId = ar.runId
 AND ti.userId = ar.userId
WHERE ar.recordType = 'answer_run'
  AND ar.finalOutcome IN ('resolved', 'unresolved')
GROUP BY ti.sourceId
ORDER BY unresolved_rate DESC;
```

利用者フィードバック(userFeedback)ベースで見る場合は
`ar.finalOutcome` を `ar.userFeedback` に読み替える。

## 2. 再検索回数分布

「何回再検索しても未解決」(product-design 4.4)の把握。run ごとの最大
iteration(0始まり)から反復回数を出し、ヒストグラム化する。

```sql
WITH per_run AS (
  SELECT
    ti.runId,
    MAX(ti.iteration) + 1 AS search_iterations,
    ar.finalOutcome
  FROM audit_records ti
  JOIN audit_records ar
    ON ar.recordType = 'answer_run' AND ar.runId = ti.runId
   AND ar.userId = ti.userId
  WHERE ti.recordType = 'tool_invocation'
    AND ti.tool = 'search'
  GROUP BY ti.runId, ar.finalOutcome
)
SELECT
  search_iterations,
  COUNT(*)                                                        AS runs,
  COUNT(CASE WHEN finalOutcome = 'unresolved' THEN 1 END)         AS unresolved
FROM per_run
GROUP BY search_iterations
ORDER BY search_iterations;
```

## 3. rawQuery の digest 結合(失敗クエリの原文参照)

未解決に終わった run の最終質問の原文を、rawQueryテーブル(短期保持・
既定30日、ADR-013)から引く。**保持期間を過ぎた原文は存在しない**のが
正常であり、JOIN が欠けることを前提に LEFT JOIN で書く。

```sql
SELECT
  ar.runId,
  ar.finalQueryDigest,
  rq.rawQuery,          -- 保持期間内のみ非NULL
  ar.failureReason
FROM audit_records ar
LEFT JOIN raw_queries rq
  ON rq.queryDigest = ar.finalQueryDigest
WHERE ar.recordType = 'answer_run'
  AND ar.finalOutcome = 'unresolved'
ORDER BY ar.startedAt DESC;
```

ツール呼び出し単位で引く場合は `ti.queryDigest = rq.queryDigest`。

注意(ADR-013 §3): raw_queries への直接アクセスは監査閲覧担当に限定し、
アクセス自体をメタ監査(`audit_access` レコード、target = 'raw_query')に
記録する。

## 4. 保持期間の設定注入と削除記録

保持期間は deployment.yaml から注入する(設定スキーマ本体はT-010)。

```yaml
audit:
  retentionDays: 365          # AnswerRun / ToolInvocation(既定365)
  rawQueryRetentionDays: 30   # rawQueryテーブル(既定30)
  telemetryRetentionDays: 14  # 分離テレメトリ(既定14)
  privateScopeDocIds: hashed  # hashed | omitted(既定hashed、ADR-013 §2)
```

コード側は `resolveRetentionConfig()` が既定値の合成と検証を行い、
`runRetentionPurge()` が期限超過分の削除と削除実行の記録
(`retention_purge` レコード)を行う。削除実行の監査:

```sql
SELECT timestamp, target, retentionDays, cutoff, deletedCount
FROM audit_records
WHERE recordType = 'retention_purge'
ORDER BY timestamp DESC;
```

## 5. 集計してはいけないもの

- **post-filtering前の候補件数**: フィールド自体が存在しない(ADR-011/012、
  existence leak対策)。`returnedHitCount` は認可済み返却件数のみ
- **Slack由来のdocId**: 記録されない(ADR-013 §2)。T-014集計・Source
  Catalog/マップ生成の入力にSlack由来データを使わない(不変条件7)
- **プライベートスコープの hmac: 付きdocId**: 参照頻度集計(GROUP BY)は
  可能だが、docIdの復元・特定を試みる利用は目的外(ADR-013 §3)
