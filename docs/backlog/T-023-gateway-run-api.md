# T-023: Gateway の run API と署名付き runId(ADR-019 段階 1)

## 依存
T-003(Gateway の HTTP 配線)、T-007(Orchestrator)、T-021(`kp-ask serve`)、T-014(昇格判定レポート)。設計は ADR-019(2026-10-09 Accepted)

## 前提(人手)
なし(実装・テストはモック IdP + 開発用コネクタで完結する)

## 背景
監査 2 層のうち AnswerRun は、現状 Orchestrator が別ボリュームの JSONL に書いている(ADR-018 決定4。issue #18 の A)。ADR-019 で、監査ストアに書くのは Gateway だけとし、Orchestrator は Gateway の run API で申告する形に決めた。段階 1 では runId を Gateway が HMAC 署名付きで発行し、本人と期限を署名だけで検証する(索引は持たない。引用の検証は段階 2 で別 ADR)。図は `docs/adr/figures/ADR-019/`。

## 内容
作業は次の順に分けて進める(1 つずつ PR にしてよい)。
1. **`@kp/audit` の切り出し**: `packages/gateway/src/audit/` を `packages/audit` に移す。依存は zod と Node の標準ライブラリだけ。gateway・orchestrator・promotion-report の import を `@kp/audit` に向ける。run モジュールと `@kp/audit` が `proxy/`・`idp/`・`config/`・`@modelcontextprotocol/sdk`・`@kp/connector-sdk` を import しないことを lint の import 制限で検査する(ADR-019 決定8)
2. **run モジュール**: runId の発行と検証(`r1.<kid>.<payload>.<sig>`、payload は乱数 128 ビット・発行時刻・期限、sig は payload と userId の HMAC-SHA256、128 文字以内で既存の runId の文字種に収める)、AnswerRun の組み立て(pending / 最終状態 / userFeedback 更新)。`isValidRunId` を `proxy/session.ts` から移す。ソースの判定(Slack・プライベートスコープ)は関数として注入する
3. **Gateway の run API**: `POST /runs`・`POST /runs/{runId}/finish`・`POST /runs/{runId}/feedback`。認証は `/mcp` と同じ。`POST /runs` で質問原文を生クエリ表に書く(Slack が有効な構成では書かず digest だけ)。本文・質問の長さ・利用者ごとの `POST /runs` の頻度に上限。書き込み失敗は fail-closed。`tools/call` で申告された runId を検証し、満たさなければ固定文言で拒否する(未申告は従来どおり単発 run)。署名鍵・期限・フィードバックの期間・上限を deployment.yaml(T-010 の profile)で設定できるようにする
4. **Orchestrator の移行**: run の開始で `POST /runs`(失敗したら LLM を呼ばない)、終了で `finish`、`kp-ask serve` の `feedback` は `POST /runs/{runId}/feedback`。AnswerRun の書き込み・`docIdAudit`・プロセス内の run の記憶・本人確認の describe(`feedback:<UUID>`)・`--answer-run-jsonl` を外す
5. **リファレンス構成と文書**: compose から `kp-answer-runs` を外し、署名鍵の秘密を足す。docs/install.md のリバースプロキシ例に `/runs` を足す。`docs/audit-queries.md`・`packages/orchestrator/README.md`・docs/ui-librechat.md を更新する
6. **昇格判定レポート**: 生クエリ表の原文の表示で「未記録」と「保持期間切れ」を分ける(issue #18)。`--audit` の複数指定は過去の A の JSONL を読むために残す

## 受け入れ条件
- [ ] 認可分岐のテストが先にある: トークンなし・無効なトークンの `/runs` 呼び出しが 401、他人の runId での `tools/call`・`finish`・`feedback` が拒否、署名を改竄した runId・未知の kid・期限切れの runId が拒否、拒否の応答に申告値をエコーしない
- [ ] 未申告の runId の `tools/call` は従来どおり単発 run として記録される(既存のテストが通る)
- [ ] 監査ストアに書けないとき、`POST /runs` は runId を返さず、`finish` / `feedback` は失敗を返す(fail-closed のテスト)
- [ ] 鍵の入れ替え: 現行と 1 つ前の kid の runId を受け、それより古い kid は拒否するテスト
- [ ] AnswerRun の userId は Gateway の認証値で書かれ、Orchestrator からは指定できない
- [ ] Slack が有効な構成で、質問原文が生クエリ表に書かれないテスト。Slack 由来の引用 docId が記録されないテスト(既存の docId 不可逆化の規則)
- [ ] 署名鍵・トークンがログ・監査・エラーに出ないテスト(不変条件6、`redactAuthContext()` の利用)
- [ ] `@kp/audit` と run モジュールの import 制限が lint で検査され、違反すると CI が落ちる
- [ ] Orchestrator のコンテナが監査ストアのボリュームを一切マウントしないことを `packages/gateway/test/reference-deploy.test.ts` で確かめる
- [ ] Gateway・Orchestrator・昇格判定レポートを結線したゴールデンテストで、run が集計され(run > 0)、質問原文が表示され、フィードバックがプロセスの再起動後も残る
- [ ] レポートが「未記録」と「保持期間切れ」を区別して表示する
- [ ] 脅威モデル TM-I4・TM-I5 の検出手段の欄に、実装したテストの名前を書く
- [ ] セキュリティレビュー(`.claude/agents/security-reviewer`)を通す

## 判断が必要な点
- **既定値**: runId の期限(tool 呼び出し・finish)、フィードバックの期間、`POST /runs` の利用者ごとの頻度の上限。実装時に案を出し、PR で確認する
- **移行の互換**: Orchestrator と Gateway は同じイメージで配るため、旧形式の runId を受ける移行期間は設けない想定。別々に更新する導入先が現れたら再検討する

## 限界
- 引用がその run で返した文書かは Gateway では検証しない(段階 2。ADR-019 決定9)
- 侵害された Orchestrator は、手元の利用者トークンで、その利用者の期限内の run の結果を偽って申告できる(ADR-019「残る限界」)
