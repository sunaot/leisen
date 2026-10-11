# T-023: Gateway の run API と署名付き runId(ADR-019 段階 1)

## 依存
T-003(Gateway の HTTP 配線)、T-007(Orchestrator)、T-021(`kp-ask serve`)、T-014(昇格判定レポート)。設計は ADR-019(2026-10-09 Accepted)

## 前提(人手)
なし(実装・テストはモック IdP + 開発用コネクタで完結する)

## 背景
監査 2 層のうち AnswerRun は、現状 Orchestrator が別ボリュームの JSONL に書いている(ADR-018 決定4。issue #18 の A)。ADR-019 で、監査ストアに書くのは Gateway だけとし、Orchestrator は Gateway の run API で申告する形に決めた。段階 1 では runId を Gateway が HMAC 署名付きで発行し、本人と期限を署名だけで検証する(索引は持たない。引用の検証は段階 2 で別 ADR)。図は `docs/adr/figures/ADR-019/`。

## 内容
作業は次の順に分けて進める(1 つずつ PR にしてよい)。

**進捗**: 1〜5 は 2026-10-11 に実装(ブランチ `claude/t023-audit-package`、段階ごとに 1 コミット)。1: `packages/audit`、import 境界は `scripts/lint-imports.mjs` を CI の `npm run lint:imports` で検査(run モジュールの境界も同じスクリプト)。2: `packages/gateway/src/run/`(runid / records / request)。3: `proxy/runs.ts`・`http.ts` の `/runs`・`proxy/gateway.ts` の runId 検証・`gateway.runs` の設定・`bootstrap/runs.ts`。4: Orchestrator の `startRun` / `finishRun` / `feedbackRun`、`KP_ORCHESTRATOR_CREDENTIAL`(`bin/credential-options.ts`)、`--answer-run-jsonl` と `docIdAudit` の削除。5: compose(gateway に `KP_RUN_ID_KEY` / `KP_ORCHESTRATOR_CREDENTIAL` / `KP_AUDIT_HMAC_KEY`、orchestrator に `KP_ORCHESTRATOR_CREDENTIAL`。`kp-answer-runs` 廃止)、Dockerfile、`.env.example`、docs/install.md(§5 秘密、§6 `/runs`、§7 容量の警報、§7.1)、docs/ui-librechat.md、docs/playbook.md、docs/audit-queries.md、docs/threat-model.md(TM-I4 / TM-I5)、`examples/deployment.yaml`、`packages/orchestrator/README.md`。6(昇格判定レポート)は未着手。
1. **`@kp/audit` の切り出し**: `packages/gateway/src/audit/` を `packages/audit` に移す。依存は zod と Node の標準ライブラリだけ。gateway・orchestrator・promotion-report の import を `@kp/audit` に向ける。run モジュールと `@kp/audit` が `proxy/`・`idp/`・`config/`・`@modelcontextprotocol/sdk`・`@kp/connector-sdk` を import しないことを lint の import 制限で検査する(ADR-019 決定10)
2. **run モジュール**: runId の発行と検証(ADR-019 決定4 の符号化どおり。payload は固定長 28 バイト、sig は版・kid・payload・userId・actor を区切った入力の HMAC-SHA256、検証は再符号化の一致と `timingSafeEqual`)、監査レコードの組み立て(pending の AnswerRun、部分レコード `answer_run_finish`・`answer_run_feedback`)。`isValidRunId` を `proxy/session.ts` から移す。ソースの判定(有効なソース・Slack・プライベートスコープの有無)は関数として注入する。`@kp/audit` のスキーマに部分レコード 2 種を足す
3. **Gateway の run API**: `POST /runs`・`POST /runs/{runId}/finish`・`POST /runs/{runId}/feedback`。認証は本人の Bearer(`/mcp` と同じ)と Orchestrator の資格情報(既定は共有秘密、定数時間比較)。`POST /runs` は生クエリ表 → pending の順に書く(Slack が有効な構成では質問原文を書かず digest だけ)。引用 docId は ADR-019 決定5 の規則で記録する。本文・質問の長さ・利用者ごとの頻度の上限を 3 経路すべてにかける。書き込み失敗は ADR-011 §4 の設定に従う。`tools/call` で名前空間付きのキーで申告された runId を検証し、満たさなければ固定文言で拒否して `invalid_run_id` の単発 run として記録する(旧キーと未申告は従来どおり単発 run)。名前空間付きのキーで runId を申告する `tools/call` にも Orchestrator の資格情報を求める。署名鍵(32 バイト以上、欠落・短い・開発用の値は production で起動拒否)・Orchestrator の資格情報・有効期間・フィードバックの期間・上限を deployment.yaml(T-010 の profile)で設定できるようにし、`kp-gateway validate` の出力で秘密を伏せる
4. **Orchestrator の移行**: run の開始で `POST /runs`(失敗したら LLM を呼ばない)、終了で `finish`(失敗したら回答を返さない)、`kp-ask serve` の `feedback` は `POST /runs/{runId}/feedback`(失敗は利用者にエラー)。`runTimeoutMs` を runId の有効期間より短くする。AnswerRun の書き込み・`docIdAudit`・プロセス内の run の記憶・本人確認の describe(`feedback:<UUID>`)・`--answer-run-jsonl` を外す
5. **リファレンス構成と文書**: compose から `kp-answer-runs` と orchestrator への `KP_AUDIT_HMAC_KEY` を外し、署名鍵(gateway だけ)と Orchestrator の資格情報(両方)の秘密を足す。docs/install.md のリバースプロキシ例に `/runs` を足し、監査ボリュームの容量の警報を運用項目に足す。プレイブックに fail-open の設定が run API にも及ぶことを書く。`docs/audit-queries.md`・`packages/orchestrator/README.md`・docs/ui-librechat.md を更新する
6. **昇格判定レポート**: AnswerRun を runId ごとにフィールド単位で統合する(pending の AnswerRun・`answer_run_finish` の最新・`answer_run_feedback` の最新。A で書いた完全な AnswerRun も読む)。「最新」は記録時刻(同時刻は冪等キー)で決め、userId が pending と一致する部分レコードだけを統合し、pending のない部分レコードは「孤立」と数える。有効期間を過ぎた pending の run を「放棄」と数える。生クエリ表の原文の表示で「未記録」と「保持期間切れ」を分ける(issue #18)。`--audit` の複数指定は過去の A の JSONL を読むために残す

## 受け入れ条件
- [ ] 認可分岐のテストが先にある: トークンなし・無効なトークン・Orchestrator の資格情報なし / 誤りの `/runs` 呼び出しが拒否、他人の runId・actor の違う runId での `tools/call`・`finish`・`feedback` が拒否、署名を改竄した runId・正規でない符号化(payload と sig の両方の base64url の未使用ビット)・未知の kid・期限切れの runId が拒否、名前空間付きの runId を申告した `tools/call` が Orchestrator の資格情報なしで拒否、拒否の応答に申告値をエコーしない
- [ ] 拒否した `tools/call` が、申告された runId ではなく新しい単発 run の runId と `invalid_run_id` で記録される
- [ ] 未申告・旧キーの runId の `tools/call` は従来どおり単発 run として記録される(既存のテストが通る)
- [ ] 監査ストアに書けないとき、`POST /runs` は runId を返さず(Orchestrator は LLM を呼ばない)、`finish` の失敗で Orchestrator は回答を返さず、`feedback` の失敗は利用者にエラーで返る(fail-closed のテスト)
- [ ] `finish` を再送しても `answer_run_feedback` の userFeedback が消えない(レポートの統合のテスト)
- [ ] `/runs` の 3 経路すべてに本文・頻度の上限がかかる
- [ ] 署名鍵が欠落・32 バイト未満・開発用の値のとき production で起動を拒否する
- [ ] 鍵の入れ替え: 現行と 1 つ前の kid の runId を受け、それより古い kid は拒否するテスト
- [ ] AnswerRun の userId は Gateway の認証値で書かれ、Orchestrator からは指定できない
- [ ] Slack が有効な構成で、質問原文が生クエリ表に書かれず、citedDocIds も記録されないテスト。Slack 以外の sourceId で申告された Slack 形式の docId が平文で残らないテスト。プライベートスコープを持つソースが有効な構成で、全件に `privateScopeDocIds` の規則がかかるテスト。有効でない sourceId の引用と searchedSources が記録されないテスト
- [ ] 署名鍵・トークンがログ・監査・エラーに出ないテスト(不変条件6、`redactAuthContext()` の利用)
- [ ] `@kp/audit` と run モジュールの import 制限が lint で検査され、違反すると CI が落ちる
- [ ] Orchestrator のコンテナが監査ストアのボリュームを一切マウントせず、環境変数に runId の署名鍵と `KP_AUDIT_HMAC_KEY` を持たず、librechat のコンテナが Orchestrator の資格情報を持たないことを `packages/gateway/test/reference-deploy.test.ts` で確かめる
- [ ] Gateway・Orchestrator・昇格判定レポートを結線したゴールデンテストで、run が集計され(run > 0)、質問原文が表示され、フィードバックがプロセスの再起動後も残り、finish のない期限切れの run が「放棄」と数えられる
- [ ] レポートが「未記録」と「保持期間切れ」を区別して表示する
- [ ] 脅威モデル TM-I4・TM-I5 の検出手段の欄に、実装したテストの名前を書く
- [ ] セキュリティレビュー(`.claude/agents/security-reviewer`)を通す

## 判断が必要な点
- **既定値**: runId の有効期間(tool 呼び出し・finish)、フィードバックの期間、`/runs` の利用者ごとの頻度の上限。実装時に案を出し、PR で確認する
- **ADR-019 の確認事項 1〜4**(Orchestrator の資格情報、Slack 有効時の引用、不変条件2 の文言、fail-open の適用範囲)は安全側の既定で実装する。人間の判断で変わったら ADR とこのタスクを改める
- **移行の互換**: Orchestrator と Gateway は同じイメージで配るため、旧形式の runId を受ける移行期間は設けない想定。別々に更新する導入先が現れたら再検討する

## 限界
- 引用がその run で返した文書かは Gateway では検証しない(段階 2。ADR-019 決定11)
- 侵害された Orchestrator は、手元の利用者トークンで、その利用者の期限内の run の結果を偽って申告できる(ADR-019「残る限界」)
- Orchestrator の資格情報が漏れると、利用者が自分の run の結果・ToolInvocation を偽れる(他人の run には触れない)
- Slack が有効な構成では、段階 1 の間は引用 docId を記録しない(引用の集計が減る)
