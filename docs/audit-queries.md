# 監査ログ サンプルクエリ(T-001)

2層監査モデル(ADR-011)のレコードを (runId, userId) で束ねて集計するサンプル。
昇格判定レポート(T-014)の「ソース別未解決率」「再検索回数分布」と、
rawQueryテーブルの digest 結合の例を示す。

前提: 監査レコードが `audit_records`、生クエリが `raw_queries` という
テーブル/ビューに格納されている(構造化JSONをロードした列指向ストア等。
永続ストアの選定はT-003/T-012)。列名は `packages/audit/src/schema.ts`
のフィールド名と一致する。

## 0. AnswerRun と ToolInvocation の結合は (runId, userId)

AnswerRun と ToolInvocation は **(runId, userId) の組で結合する**。どちらも Gateway が書く(ADR-019。
AnswerRun は Orchestrator の申告を Gateway が run API で受けて書く)。AnswerRun.userId は Gateway が
認証した userId で、Orchestrator からは指定できない(T-007 セキュリティレビュー 2026-09-27 H1 は、
Gateway が書くことで構造的に成り立つ)。runId は Gateway が発行する署名付きの値で、名前空間付きの
キーで申告された runId は署名・本人・actor・期限を検証してから記録し、満たさない申告は固定文言で
拒否して **新しい単発 run の runId と `invalid_run_id`** で記録する(申告値は記録しない)。したがって
正常な run では同じ runId の ToolInvocation と userId は必ず一致する。**それでも不一致は警告として
扱い**(集計から外し、次のクエリで定期的に検出して原因 — 実装の不具合・署名鍵の漏えい — を調べる)、
以下の集計はすべて (runId, userId) で結合する。

レコードの所在と run の 3 種のレコード: Gateway は ToolInvocation(`tool_invocation`)と run の記録を
同じ `audit.jsonl` に書く。run は書き直さず追記する — 開始時に `answer_run`(pending。`finalOutcome: pending`、
`endedAt` なし)、終了時に `answer_run_finish`(`finalOutcome` / `confidence` / `searchedSources` /
`citedDocIds` / `failureReason` / `endedAt`)、フィードバック時に `answer_run_feedback`(`userFeedback`)。
同じ runId の部分レコードは pending の AnswerRun と **userId が一致するものだけ** を統合し、最新
(`recordedAt`。同時刻は冪等キー `recordId`)が勝つ。pending のない部分レコードは「孤立」、有効期間
(`gateway.runs.ttlSec`)を過ぎて finish のない pending は「放棄」(finish を送らずに unresolved を
隠せないようにする)。以下の SQL はこの 3 種を 1 つの表 `audit_records` に取り込み、ビュー `answer_runs`
(下)で統合した前提で書いてある。昇格判定レポートも同じ規則で統合する(ADR-019 より前の構成で
Orchestrator が別ファイルに書いた完全な AnswerRun も `--audit` を足せば読める)。

```sql
-- run の最終状態(pending + 最新の finish + 最新の feedback。userId が一致するものだけ)
CREATE VIEW answer_runs AS
SELECT
  ar.runId, ar.userId, ar.executionClass, ar.startedAt, ar.finalQueryDigest,
  COALESCE(f.finalOutcome, 'pending')      AS finalOutcome,
  f.endedAt, f.confidence, f.searchedSources, f.citedDocIds, f.failureReason,
  fb.userFeedback
FROM audit_records ar
LEFT JOIN (
  SELECT * FROM audit_records x
  WHERE x.recordType = 'answer_run_finish'
    AND NOT EXISTS (SELECT 1 FROM audit_records y
                    WHERE y.recordType = 'answer_run_finish' AND y.runId = x.runId AND y.userId = x.userId
                      AND (y.recordedAt > x.recordedAt OR (y.recordedAt = x.recordedAt AND y.recordId > x.recordId)))
) f  ON f.runId = ar.runId AND f.userId = ar.userId
LEFT JOIN (
  SELECT * FROM audit_records x
  WHERE x.recordType = 'answer_run_feedback'
    AND NOT EXISTS (SELECT 1 FROM audit_records y
                    WHERE y.recordType = 'answer_run_feedback' AND y.runId = x.runId AND y.userId = x.userId
                      AND (y.recordedAt > x.recordedAt OR (y.recordedAt = x.recordedAt AND y.recordId > x.recordId)))
) fb ON fb.runId = ar.runId AND fb.userId = ar.userId
WHERE ar.recordType = 'answer_run';

-- 拒否された runId の申告(利用者ごとの件数。多ければ Orchestrator の不具合か署名鍵の問題。TM-I5)
SELECT userId, COUNT(DISTINCT requestId) AS rejected
FROM audit_records
WHERE recordType = 'tool_invocation' AND errorClass = 'invalid_run_id'
GROUP BY userId;
```

```sql
-- runId は同じだが userId が食い違う ToolInvocation(警告)
SELECT
  ar.runId,
  ar.userId                      AS answer_run_user,
  ti.userId                      AS tool_invocation_user,
  COUNT(DISTINCT ti.requestId)   AS invocations   -- 重複行で二重に数えない
FROM answer_runs ar
JOIN audit_records ti
  ON ti.recordType = 'tool_invocation' AND ti.runId = ar.runId
WHERE ti.userId <> ar.userId
GROUP BY ar.runId, ar.userId, ti.userId;
```

AnswerRun のない runId の ToolInvocation は、単発の呼び出し(runId 未申告・旧キーでの申告)か、
申告を拒否された呼び出し(`invalid_run_id`。新しい単発 run の runId で記録される)である。不一致ではない。
Orchestrator が利用者を確認できずに終えた run(describe フェーズで Gateway の認証に失敗した等)も、
run の開始が Gateway に受け付けられていれば AnswerRun(`error`)が残る。

昇格判定レポート(`packages/promotion-report`)も (runId, userId) で結合する。不一致の
ToolInvocation はソース別未解決率・再検索回数分布の集計から除外し、run ごとの件数を
「警告」としてレポートの冒頭に出す(JSON では `userMismatchWarnings`)。レポートに出すのは
runId と件数だけで、userId・文書ID・クエリは出さない。原因の調査は上のクエリで行う。

## 1. ソース別未解決率

「どのソースを検索した会話が未解決に終わりやすいか」。AnswerRun の
finalOutcome と ToolInvocation の sourceId を (runId, userId) で結合する(§0)。
describe の呼び出しは数えない: Orchestrator(T-007)は run の冒頭で全ソースに describe を
呼ぶため、数えると全ソースが全 run に現れる。

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
 AND ti.tool <> 'describe'
WHERE ar.recordType = 'answer_run'
  AND ar.finalOutcome IN ('resolved', 'unresolved')
GROUP BY ti.sourceId
ORDER BY unresolved_rate DESC;
```

利用者フィードバック(userFeedback)ベースで見る場合は
`ar.finalOutcome` を `ar.userFeedback` に読み替える。

## 2. 再検索回数分布

「何回再検索しても未解決」(product-design 4.4)の把握。結果確定済みの run ごとに、
run 内の search の ToolInvocation の件数(再検索回数)を数え、ヒストグラム化する。
**0回 = 検索なし、1回 = 1発、2回以上 = 再検索**。describe / fetch / list の呼び出しは
数えない。ToolInvocation は (runId, userId) で結合する(§0)。

iteration は run 内のツール呼び出しの通番(0始まり。describe / search / fetch / list を
すべて含み、並列呼び出しも個別に採番。ADR-011 追記、ADR-017 決定2)であり、run 内の
順序付けにだけ使う。`MAX(iteration) + 1` は describe や fetch の呼び出しまで数えるため、
回数には使わない。監査ストアは at-least-once で同じレコードが複数行に現れうるため、
冪等キー(tool_invocation は requestId)で重複を除いて数える。search のない run も 0回として
数えるよう LEFT JOIN にする(ToolInvocation 側の条件は ON 句に置く)。

```sql
WITH per_run AS (
  SELECT
    ar.runId,
    ar.finalOutcome,
    COUNT(DISTINCT ti.requestId) AS search_count   -- 重複行を除いた search の件数
  FROM audit_records ar
  LEFT JOIN audit_records ti
    ON ti.recordType = 'tool_invocation' AND ti.runId = ar.runId
   AND ti.userId = ar.userId
   AND ti.tool = 'search'
  WHERE ar.recordType = 'answer_run'
    AND ar.finalOutcome IN ('resolved', 'unresolved')
  GROUP BY ar.runId, ar.finalOutcome
)
SELECT
  search_count,
  COUNT(*)                                                        AS runs,
  COUNT(CASE WHEN finalOutcome = 'unresolved' THEN 1 END)         AS unresolved
FROM per_run
GROUP BY search_count
ORDER BY search_count;
```

昇格判定レポートでは JSON の `searchCountDistribution[].searchCount`(旧
`iterationDistribution[].searchIterations` = search の max(iteration)+1 は 2026-09-27 に廃止)。

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
  retentionDays: 365          # AnswerRun(pending・finish・feedback)/ ToolInvocation(既定365)
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
