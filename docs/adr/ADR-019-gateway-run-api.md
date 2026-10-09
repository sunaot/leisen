# ADR-019: Gateway の run API と監査の書き手の一本化(段階 1: 署名付き runId)

Status: Accepted(リポジトリオーナー承認 2026-10-09、issue #18。段階 1 で進める)/ Date: 2026-10-09

置き換える決定(T-023 の実装をもって効力を持つ。それまでは現状の A が動く):
- ADR-017 決定2 のうち「AnswerRun は Orchestrator が書く」と、確認事項3(AnswerRun の書き手)
- ADR-018 決定4(AnswerRun を Orchestrator サービスが別 JSONL に追記する)、決定10 のうち本人確認のための describe、却下した案「Gateway に run 登録 API を作る」
- ADR-011 追記(2026-09-17)と ADR-001 追補3 決定3 のうち、runId の採番主体(iteration は Orchestrator の申告のまま)

## 文脈
監査 2 層(ADR-011)は、Gateway が書く ToolInvocation(ツール呼び出しごと)と、1 質問 = 1 run の AnswerRun(最終結果・confidence・引用・利用者フィードバック)を runId で束ね、昇格判定レポート(T-014)で集計する。これが製品原則 4(監査ログを証拠に Phase 2 を判断する)の計測ループである。

5 観点レビュー(2026-09-27、issue #18)で、このループが出荷構成で完結しないことが指摘された。その後 T-021 で ADR-018 決定4 の案(以下 **A**: Orchestrator が Gateway とは別のボリュームの別 JSONL に AnswerRun を追記する)を実装し、ループは閉じた。ただし A は「Orchestrator は Gateway と同じ運用者・同じ信頼境界で動かす」前提で TB2(Orchestrator は信頼しない)の例外を受け入れたもので、構造上の問題は残っている。

![図1 現状(A)の構造 — 「最終結果を知る者」と「監査を書く権威」が別の箱にある。赤い C1〜C5 が下の壁の位置](figures/ADR-019/fig1-current-structure.svg)

構造的な原因は 4 つある。
1. **観測点と信頼境界がずれている。** ToolInvocation は Gateway が観測できるが、AnswerRun(質問〜最終回答)は探索ループの中でしか観測できない。その探索ループを TB2 の外に置いたため、最終結果を知る者(Orchestrator)と監査を書く権威を持つ者(Gateway)が別になった
2. **Gateway の外向きの面が MCP のツール面だけ。** 外に見せる操作は `tools/list` と `tools/call` だけで、MCP には run の概念がない。runId は `_meta` の申告で運ぶしかなく、仕様 2026-07-28 版(ステートレス)で接続状態から run を推定する道も消えた
3. **TB2 の粒度が粗い。** 信頼できないのは LLM に駆動される入力であって、探索ループのコード(自分たちの製品コード)ではない。現状は両者を同じ箱に入れている
4. **不変条件がツール呼び出ししか想定していない。** 不変条件 2・5 は、run の開始・終了、フィードバック、質問原文といったツール呼び出し以外の監査事象の置き場を定めていない。そのため AnswerRun・質問原文・フィードバックが別々の issue(#18 / #22 / #30)に散った

この結果、次の壁・制約・コンフリクトがある。

| | 内容 |
|---|---|
| C1 | **観測点 ≠ 権威**: AnswerRun の中身は本質的に Orchestrator の申告で、誰が書いても「LLM が何を引用したか」の真偽は検証できない。ただし runId の実在、userId の一致、引用 docId がその run で実際に返した文書か、は検証できる余地がある |
| C2 | **ステートレス Gateway vs run のライフサイクル**: run は複数リクエストにまたがるが、Gateway はリクエストをまたぐ状態を持たない。状態の置き場が決まっていない |
| C3 | **ツール IF の凍結 vs 新しい事象**: MCP のツールに run の事象を足すと、コネクタ IF と Gateway の管理面が混ざる(不変条件 5 の対象) |
| C4 | **単純さ(1 デプロイ = 1 社、同一運用者)vs TB2 の厳格さ**: TB2 を字義どおりにすると Orchestrator は何も書けない。緩めた結果が A の「別ボリュームに書く」折衷 |
| C5 | **JSONL 追記 = 索引なし**: runId の所有者や引用の実在は、書き込み時には検証できず、レポート時にしか突合できない |

A はどれも解いておらず、同一運用者の前提で C4 を受け入れ、別ボリュームで被害範囲を限っているだけである。

## 決定
1. **記録の権威は Gateway に置く。Orchestrator は申告者とする。** 監査ストア(ToolInvocation・AnswerRun・生クエリ表)に書くのは Gateway だけ。Orchestrator は監査ストアのボリュームを一切マウントせず、監査用の鍵(docId の HMAC 鍵など)も持たない。観測点(最終結果を知るのは Orchestrator)は動かせないので、Orchestrator が申告し、Gateway が検証できる部分を検証してから記録する

2. **TB2 を「Orchestrator から届くものはすべて申告である」と定義し直す。** Orchestrator のコードは製品コードだが、プロセスは LLM の出力に駆動され、侵害・誤動作しうる。この前提(TB2 の意図)は変えない。変えるのは扱いで、Orchestrator に書き込みの権限を与えて例外を作るのではなく、Gateway が申告を受けて検証する。Orchestrator は Gateway と別のプロセスのまま置く(α)。Gateway と同じプロセスに統合する案(β)は採らない(却下した案)

   ![図2 TB2 の再定義 — 信頼しないのは LLM 由来の内容。Orchestrator は別プロセスのまま run API で申告する(α)](figures/ADR-019/fig2-trust-boundary.svg)

3. **Gateway に run API を設ける。** MCP の面(`/mcp`)とは別の HTTP + JSON の面で、MCP のツールでもコネクタ IF でもない(不変条件 5 の外)。認証は `/mcp` と同じで、利用者本人の Bearer を IdP Adapter で検証する。run の状態は Gateway のプロセスには持たず、監査ストアの記録の列(下表の順)として残すので、Gateway はステートレスのまま保てる(C2)

   | 呼び出し | Gateway がすること | 監査ストアに残るもの |
   |---|---|---|
   | `POST /runs` `{ question }` | 本人を認証し、署名付き runId(決定4)を発行する | AnswerRun(`pending`、userId は認証値、最終質問 digest)。質問原文は生クエリ表へ(決定5) |
   | `tools/call`(`_meta` に runId) | runId を検証してから、従来どおり中継する(決定4) | ToolInvocation(従来どおり) |
   | `POST /runs/{runId}/finish` `{ outcome, confidence, citations, searchedSources, failureReason }` | runId を検証し、引用 docId を不可逆化する(ADR-013 §2、Slack 由来は記録しない) | AnswerRun(最終状態) |
   | `POST /runs/{runId}/feedback` `{ outcome }` | runId の本人とフィードバックの期間を検証する | AnswerRun(userFeedback を更新) |

   AnswerRun のスキーマは変えない。冪等キーは従来どおり runId で、同じ runId の後の記録が前の記録を置き換える(ADR-017 決定2 の pending → 最終状態 → userFeedback の更新と同じ意味)。書き込みに失敗したら fail-closed とする(ADR-011 §4。`POST /runs` は runId を返さず、`finish` / `feedback` は失敗を返す)。リクエスト本文の大きさ・質問の長さ・利用者ごとの `POST /runs` の頻度に上限を設け、監査ストアを埋める濫用を防ぐ(既定値は T-023 で決め、deployment.yaml で変えられるようにする)

   ![図3 run API のシーケンスと監査ストアの記録の列。黄色の箱が Gateway の検証(段階 1 は署名だけ、段階 2 は索引で引用も)](figures/ADR-019/fig3-run-api-sequence.svg)

4. **runId は Gateway が発行する、HMAC 署名付きの不透明な値とする(段階 1)。** 形式は `r1.<kid>.<payload>.<sig>`(base64url)。payload は乱数(128 ビット)・発行時刻・期限を持ち、sig は payload と **利用者の userId** を合わせた HMAC-SHA256 である。userId は runId に平文で入れず、署名の入力として束縛するだけにする(runId は UI の `structuredContent` やログにも出るため。検証時には Gateway が認証した userId があるので再計算できる)。全体を 128 文字以内、既存の runId の文字種(`[A-Za-z0-9._:-]`)に収め、監査スキーマを変えない
   - **検証は署名だけで行い、索引を要らない**(C5 を段階 1 の範囲で避ける)。`tools/call` と `finish` は期限内、`feedback` は発行時刻からフィードバックの期間内(既定値は T-023 で決める)で受ける。`_meta` で申告された runId が署名・本人・期限のどれかを満たさなければ、その呼び出しを固定文言のエラーで拒否する(申告値はエコーしない)
   - **未申告の呼び出しは従来どおり単発 run として記録する**(ADR-011 追記。Gateway に直接つなぐ汎用の MCP クライアント向け)。iteration は従来どおり Orchestrator の申告とする
   - 署名鍵はデプロイ固有の秘密として環境変数から渡し、docId の HMAC 鍵とは分ける。`kid` で現行と 1 つ前の鍵を同時に受け、鍵を入れ替えられるようにする。鍵はログ・監査・エラーに出さない(不変条件6)
   - 段階 1 で検証できるのは「runId を Gateway が発行したこと・本人の run であること・期限内であること」まで。**引用がその run で返した文書かは Gateway では検証しない**(段階 2)。Orchestrator 側の出典の検証(ADR-017 決定3)は申告の質を保つ手段としてそのまま残す。outcome の妥当性はどの段階でも誰にも検証できない(C1 の残り)

5. **質問原文は `POST /runs` で生クエリ表に書く**(issue #18「質問原文の記録先」の A)。保持期間は ADR-011 §3・ADR-013 に従う(既定 30 日)。結合キーは AnswerRun の最終質問 digest と生クエリ表の digest。ただし deployment.yaml で永続化不可のソース(Slack)が有効な構成では、#22 が決まるまで質問原文を書かず digest だけを残す(不変条件7 を安全側に倒す)

6. **フィードバックは AnswerRun の更新として永続化する**(#30 のうち永続性)。Orchestrator のプロセス内に最終状態を覚えておく必要(既定 1,000 件)はなくなり、ADR-018 決定10 の「本人確認のための describe(`feedback:<UUID>` の別 runId)」も要らなくなる。本人であることは runId の署名で確かめる

7. **書き手は Gateway のプロセスに同居させる(G)。** 永続化は既存の `AuditSink` の向こう側に置く。次のいずれかを満たしたら、`AuditSink` をネットワーク越しに送る実装に差し替え、書き手だけを別プロセスの監査サービスに移す(S2)。run API とその受付・認証・検証は Gateway に残る
   - Gateway を複数台にする(単一レプリカの前提を外す。docs/install.md の「将来のスケールアウトの条件」)
   - 段階 2 の索引を複数の Gateway で共有する必要が出た
   - 導入先の要件で、監査の書き込み資格情報を Token Vault と同じプロセスに置けない(TM-F1 の厳格適用)

   run の事象だけを別サービスで受ける案(S1)は採らない(却下した案)

8. **モジュールの境界を固定する。** 同じプロセスに同居しても、run と監査のモジュールは MCP に依存させない
   - 監査のモジュール(現 `packages/gateway/src/audit/`)を `packages/audit`(`@kp/audit`)として切り出す。依存は zod と Node の標準ライブラリだけにする。orchestrator と promotion-report は `@kp/gateway` ではなく `@kp/audit` から読む
   - run の発行・検証・AnswerRun の組み立ては run モジュールに置く。runId の概念(現 `proxy/session.ts` の `isValidRunId`)も run モジュールが持つ。run モジュールは認証済みの主体(userId・actor)と値だけを受け取る
   - run モジュールと `@kp/audit` は、`proxy/`・`idp/`・`config/`・`@modelcontextprotocol/sdk`・`@kp/connector-sdk` を import しない。lint の import 制限で機械的に検査する。組み立て役(bootstrap / http.ts)だけがすべてを知る
   - ソースの知識(どのソースが Slack か・プライベートスコープか)は run モジュールに入れず、組み立て役が判定の関数として注入する
   - リクエストを失敗させるかどうか(fail-closed)の判断は呼び出し側が行う。run モジュールと sink は例外を投げるだけにする(現在の sink と同じ分担)

   ![図5 モジュール境界 — 段階 1 は Gateway に同居し、条件を満たしたら AuditSink の差し替えだけで書き手を別プロセスに移す](figures/ADR-019/fig5-module-boundary.svg)

9. **段階 2(引用の検証)はこの ADR の範囲外とし、別の ADR で決める。** run 単位の索引(SQLite 等。JSONL を正とし、索引は派生物)と、ToolInvocation に返した docId(不可逆化済み)を持たせるスキーマ変更(ADR-011 の改訂)が要る。決定7 の移行の条件と合わせて判断する

10. **移行。** T-023 が入るまでは A(ADR-018 決定4 の実装)のまま運用する。入った後は Orchestrator は AnswerRun を書かず、`--answer-run-jsonl` とリファレンス構成の `kp-answer-runs` ボリュームを廃止する。AnswerRun のスキーマは同じなので、A で書いた過去の JSONL は昇格判定レポートで引き続き読める(`--audit` の複数指定は残す)

![図4 移行の道筋 — 現状 A・段階 1・段階 2 で解ける問題](figures/ADR-019/fig4-migration-path.svg)

## 理由
- **C1(観測点 ≠ 権威)**: 観測点は動かせないので、権威の側を一本にする。書き手が Gateway になると、検証できる部分(runId の実在・本人・期限)は Gateway が検証してから記録する。outcome の真偽が検証できないのは誰が書いても同じで、この ADR で悪くなる点はない
- **C2(状態の置き場)**: run の状態は監査ストアの記録の列に置き、各リクエストは独立したままにする。runId の検証は署名で完結するので、Gateway はリクエストをまたぐ状態を持たない(ADR-001 追補3 と両立する)
- **C3(ツール IF)**: run API は MCP のツール面に足さない。ツールに足すと LLM から見える `tools/list` に管理操作が並び、コネクタ IF(search / fetch / list / describe)と混ざる
- **C4(TB2)**: Orchestrator は監査ストアに一切の書き込み権限を持たないので、TM-I4(Orchestrator から監査を読む・改竄する)は構成の工夫ではなく構造で成り立つ。Orchestrator を別ホスト・別の運用者の下に置く構成も取れる
- **C5(索引なし)**: 段階 1 は、索引がないと検証できないもの(引用の実在)を後回しにし、署名で検証できるもの(所有者・期限)に絞る。これだけで C2・C3・C4・質問原文・フィードバックが片づき、C1 は半分片づく
- **G を選び S2 を今は選ばない理由**: run API の受付は、本人の束縛(= 認証)が要るので、IdP Adapter を持つ Gateway から動かせない。G と S2 の違いは永続化の書き手の置き場所だけである。いまは単一レプリカで、1 社 1 デプロイの小規模な導入も多い。S2 にするとコンテナ・秘密情報・監視が増え、すべての tools/call が fail-closed で監査サービスの可用性に依存する。`AuditSink` は at-least-once と冪等キーで設計済みなので、条件を満たしたときに sink を差し替えるだけで移れる
- **userId を runId に平文で入れない理由**: runId は監査のほか UI の `structuredContent`・ログにも出る。検証時には Gateway が認証した userId が手元にあるので、署名の入力に含めれば束縛には十分である
- **A のまま終えない理由**: A は C1〜C5 のどれも解かない。質問原文(#22)・フィードバックの永続(#30)の置き場も決まらず、issue が散ったままになる

## 帰結
- **Gateway**: `/runs` の 3 つの経路、run モジュール、署名鍵の設定(deployment.yaml のスキーマ、T-010 の profile)を足す。リバースプロキシの設定例(docs/install.md §6 の `location = /mcp`)に `/runs` を足し、同じ期限・本文上限をかける
- **Orchestrator**: run の開始時に `POST /runs` で runId を受け取る(失敗したら LLM を呼ばない)。終了時に `finish`、`kp-ask serve` の `feedback` ツールは `POST /runs/{runId}/feedback` を呼ぶ。AnswerRun の書き込み・`docIdAudit` の鍵・プロセス内の run の記憶・本人確認の describe をやめる。AnswerRun.userId の束縛(セキュリティレビュー H1)は、Orchestrator 側の照合ではなく、Gateway が認証値で書くことで構造的に成り立つ
- **監査ストアの系統**: Gateway の 1 系統に戻る。昇格判定レポートの入力も 1 つで足りる(過去の A の JSONL を読むために複数指定は残す)
- **脅威モデル**: TB2 の記述を決定2 に合わせて改める。TM-I4 の対策は構造的なものになる。run API の脅威(runId の偽造・他人の runId の利用・期限切れの再利用・監査ストアを埋める濫用・署名鍵の漏えい)を TM-I5 として足す
- **不変条件**: 2(全ツール呼び出しを Gateway で監査)は変わらず、run の事象も Gateway を通るようになる。5(コネクタ IF)には触れない。6 は署名鍵に適用する。7 は決定5(Slack 有効時は質問原文を書かない)と既存の docId 不可逆化(Slack 由来は記録しない)で守る
- **残る限界**:
  - 侵害された Orchestrator は、手元にある利用者のトークンで、その利用者の run の結果を偽って申告できる。これは A と同じで、範囲はその利用者の期限内の run に限られる
  - 引用の実在は段階 2 まで Gateway では検証しない
  - 期限内の runId は、同じ本人なら再利用できる(`finish` の重複は後の記録が勝つ)
- **issue への影響**: #18 の書き手と質問原文の記録先はこの ADR で決まる。#30 の永続性は決定6 で決まる(同一性・スキーマ版は #30 で別に扱う)。#22 は Slack 有効時の扱いだけが残る

## 却下した案
- **A のまま(ADR-018 決定4)**: 計測ループは閉じるが、構造上の問題(C1〜C5)を解かず、Orchestrator を別の信頼境界に置けない
- **A′: Orchestrator が Gateway と同じ監査ストアに書く(ADR-017 決定2 の原文)**: Orchestrator が Gateway の監査ファイルを書き込み可能で持つことになる(TM-I4)
- **β: Orchestrator を Gateway と同じプロセスに統合する**: LLM の呼び出しと認可・Token Vault が同居し、LLM 側の障害・侵害が認可と監査に波及する。TB2 の意図を失う
- **S1: run の事象だけを別の監査サービスで受ける**: 監査サービスにも IdP Adapter が要って認証が二重になる。runId の署名鍵を Gateway と共有することになり、書き手も 2 系統のまま残る
- **S2 を今すぐ採る**: 決定7 の条件をまだ満たしておらず、運用コストと可用性の依存が増えるだけになる。`AuditSink` の差し替えで後から移れる
- **run の操作を Gateway の MCP ツールとして足す(`run_start` 等)**: LLM から見えるツール面に管理操作が混ざり、コネクタ IF の変更(不変条件5)に当たる
- **Gateway のプロセス内に run の状態を持つ**: ステートレスの前提(ADR-001 追補3)に反し、再起動や複数台で壊れる
- **runId に userId を平文で入れる**: UI・ログに利用者の識別子を広げる。束縛には署名の入力に含めれば足りる
- **段階 2 を同時に行う**: 索引と ToolInvocation のスキーマ変更が要り、移行の条件(決定7)と合わせて決めるべきである

## 図
図の元ファイル(SVG)は `docs/adr/figures/ADR-019/` にある。
- 図1 `fig1-current-structure.svg`: 現状(A)の構造と C1〜C5 の位置
- 図2 `fig2-trust-boundary.svg`: TB2 の再定義と α・β
- 図3 `fig3-run-api-sequence.svg`: run API のシーケンスと記録の列
- 図4 `fig4-migration-path.svg`: 現状 A・段階 1・段階 2 で解ける問題と進め方
- 図5 `fig5-module-boundary.svg`: モジュール境界と書き手の置き場所(G と S2)
