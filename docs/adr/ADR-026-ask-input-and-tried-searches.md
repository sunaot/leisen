# ADR-026: `ask` の引数の追加(利用者の発言・変えてはならない語・対象)と、返り値の「試した検索」

Status: Proposed(人間のレビュー待ち)/ Date: 2026-11-25

本 ADR は ADR-018 決定 1(`ask({ question })`)を変える提案であり、ADR-019(run API・監査・生クエリ表)への追補を含む。コネクタ IF(検索プロファイル、notices)は ADR-025 で扱う。CLAUDE.md「タスクの進め方」2 に従い、実装(T-031)は本 ADR の承認後に行う。

## 用語

ADR-025「用語」と同じ。**UI 側 LLM** は LibreChat などで利用者と対話し `ask` を呼ぶ LLM、**探索 LLM** は Orchestrator の中で `search` / `fetch` を呼んで回答を作る LLM、**利用者が入力したキーワード**は利用者の発言にそのまま含まれている検索に使える語句(固有名詞、ID、エラーメッセージ、引用符で囲まれた語句など)を指す。**検索プロファイル**はソースごとの検索の仕様をまとめた情報で、コネクタが持ち、Orchestrator が探索 LLM に伝える(ADR-025)。

## 文脈

### オーナーの方針(2026-11-25)

ADR-025「文脈」と同じ。ハーネスの役割の 2 番目は「利用者が入力したキーワードを `ask` と最初の検索に残すよう指示する」ことで、クエリは探索 LLM が書く。利用者が入力したキーワードをコードで抽出する仕組みは今回の範囲外とした。したがって、利用者が入力したキーワードを探索 LLM まで届ける手段は、UI 側 LLM への指示と `ask` の引数だけになる。

IF を変えない段階(`ask` の description と `instructions` の改訂)は T-024 で先に行う。本 ADR は、それを引数として固定する段階を扱う。

### 現状(行番号は 2026-11-25 時点。根拠はレポート「情報が失われる場所は経路の入口と出口に集中し、途中に補正する層がない」と `research_notes/エージェント検索ハーネス設計調査/leisen_current_implementation.md` §1・§8)

- `ask` の引数は自然文の `question` 1 つだけで、サーバー側は `z.strictObject({ question: z.string() })` で他の引数を拒否する(`packages/orchestrator/src/server/tools.ts:164`、`:219-240`)
- UI 側 LLM への入力側の指示は「利用者の質問は ask ツールに渡してください」だけで、利用者の発言をそのまま入れることや固有名詞を保つことに触れない(`packages/orchestrator/src/server/tools.ts:206-212`)。リファレンス構成の UI 側の既定モデルは小型のローカルモデル(`deploy/compose/librechat/librechat.yaml:92-106`)
- `ask` はステートレスで会話履歴を受け取らない(`packages/orchestrator/src/server/mcp.ts:11-15`、ADR-018 決定 1)。フォローアップの質問は、UI 側 LLM が自立した質問に書き直さない限り文脈を失う
- 返り値の `structuredContent` は Answer(runId / answer / citations / searchedSources / skippedSources / confidence / outcome / usage / warnings)と `retentionClass` / `errorClass`(`packages/orchestrator/src/server/render.ts:1-40`、`packages/orchestrator/src/answer.ts`)。試したクエリや、検索したが有用な結果がなかったソースは、探索 LLM が answer に書かない限り返らない
- 監査は ToolInvocation にクエリの digest だけを残し、`search` のクエリ原文は Gateway が生クエリ表に書く(`packages/gateway/src/proxy/gateway.ts:328-332`、ADR-011 決定 3)。質問原文は `POST /runs` で生クエリ表に書く(ADR-019 決定 7)。Slack が有効な構成では質問原文を書かない(同決定 7)が、tools/call の `search` のクエリ原文は Slack 有効時も書かれる(ADR-019「実装の記録」。CLAUDE.md の未決事項で、T-006 の前に決める)
- UI 側 LLM が実際に `question` をどう書き換えているかの記録はリポジトリにない(レポート。比較実験は T-027)

委譲の研究では、委譲する側の書き直しがタスクを変えてしまうことと、委譲先の取得の失敗が委譲する側に伝わらないことが、委譲で精度が下がる主な原因とされる(レポート「委譲すると情報が失われる」。Lost in Delegation、査読前、同一モデルの組の Web 検索での結果で、leisen の構成にそのまま当てはまるとは限らない)。

## 決定(案)

1. **`ask` に省略可能な引数を足す。`question` は必須のまま残す。** 既存の MCP クライアントと LibreChat の設定は変更なしで動く

   | 引数 | 型と上限(案) | 意味 |
   |---|---|---|
   | `question` | 文字列(既存。`--max-question-chars`、既定 4,000 字) | 1 回の呼び出しで完結する質問。従来どおり |
   | `userMessage` | 文字列(`question` と同じ上限) | 利用者の直近の発言そのもの。言い換え・要約・翻訳をしない |
   | `context` | 文字列(1,000 字まで) | 会話から分かっている前提(「それ」が指す対象など)。UI 側 LLM が補ったもので、利用者の発言ではない |
   | `keepTerms` | 文字列の配列(10 個まで、各 100 字まで) | 変えてはならない語(利用者が入力したキーワード)。UI 側 LLM が利用者の発言から写す |
   | `sources` | sourceId の配列(有効なソースの列挙値) | 利用者が対象のソースを指定したときだけ使う |
   | `period` | `{ updatedAfter?, updatedBefore? }`(ISO 8601) | 利用者が期間を指定したときだけ使う |
   | `depth` | `"quick" \| "standard" \| "thorough"` | 探索の深さ。`maxIterations` を設定値以下の範囲で選ぶ(例: quick = 2、standard = 設定値、thorough = 設定値。上限は変えない。値は確認事項 4) |

   - 各引数の description に、UI 側 LLM への指示を書く。`userMessage` と `keepTerms` は「利用者の発言から一字も変えずに写す」、`context` は「直近の発言だけでは意味が通らないときに限り書く」、`sources` / `period` は「利用者が言ったときだけ書く。利用者が言っていない条件を足さない」とする
   - `userMessage` と `context` を分ける理由: 語彙で照合する検索では、UI 側 LLM が足した条件が AND の条件を増やし、目的の文書を見つけられなくなる。利用者の発言と補足を分ければ、探索 LLM は補足を検索語に入れるかを区別して判断できる
   - サーバーは `z.strictObject` で上の引数だけを受け、上限を超えた値は固定文言のエラーで拒否する。`sources` に有効でない sourceId が含まれていたら拒否する(有効なソースの一覧は deployment.yaml 由来で利用者によらない。ADR-001 追補 3 決定 5)。利用者が未接続のソースは従来どおり `skippedSources` に入る

2. **Orchestrator は追加の引数を、探索 LLM への最初の user ターンに区分を分けて置く。** クエリは探索 LLM が書く(コードで検索を実行しない)
   - 区分は「利用者の発言(そのまま)」「UI 側 LLM による補足(利用者の発言ではない)」「利用者が入力したキーワード」「対象のソース・期間」とする。どれも質問と同じ扱い(利用者ターンの入力)で、`[オーケストレーター]` の制御メッセージとしては書かない(利用者の入力が制御メッセージの権威を持たないため)
   - 探索プロンプトに「最初のターンでは、利用者が入力したキーワードをそのまま使った検索を必ず 1 本出す」と書く(T-024 の v4 の方針と同じ。引数がないときは `question` から探索 LLM が自分で拾う)
   - `sources` は、そのソースだけを run の有効ソースにする(ツール定義の `source` の列挙値を絞る。`packages/orchestrator/src/tools.ts:106-126`)。これは利用者の指定による検索範囲の絞り込みであり、認可判定ではない(不変条件 1)
   - `period` は探索 LLM に「search の filters.updatedAfter / updatedBefore に入れる」と伝える。Orchestrator が検索の引数を書き換えて強制するかは確認事項 5 とする(本案は伝えるだけ)

3. **`ask` の返り値に「試した検索」を足す。** `structuredContent.searchesTried` に、run 内で探索 LLM が呼んだ `search` を順に載せる

   ```ts
   interface SearchTried {
     sourceId: string;
     query: string;          // 探索 LLM が渡した query(決定 5 の場合は載せない)
     filters?: SearchFilters;
     outcome: "hits" | "no_hits" | "error";
     /** その run で初めて返った文書の数。認可済みで返ったヒットから数える */
     newDocuments: number;
   }
   ```

   - `newDocuments` は Orchestrator が受け取った認可済みのヒットから数えるので、ADR-012 に触れない。件数の総数や「権限がないため 0 件」を区別する情報は載せない。error の errorClass は従来どおり正規化した値だけにする(`permission_denied` / `not_found` / `not_available` は固定文言に統一。`packages/orchestrator/src/orchestrator.ts:122-133`)
   - text(Markdown)には、outcome が resolved 以外のときだけ「探した範囲」として短く載せる(ソースと query の一覧)。resolved のときは `structuredContent` だけに載せる(UI 側 LLM が本文として利用者に見せる量を増やさない)。UI 側 LLM が利用者に「別の語で探し直すか」を尋ねる材料にする
   - 件数は 1 run のツール呼び出しの上限(`maxToolCallsPerRun`、既定 40)以下に収まる

4. **ADR-019 への追補: run API で申告する質問を、`ask` の入力全体にする。**
   - `POST /runs` の本文の `question` を、`ask` の入力(決定 1 の引数のうち文字列を含むもの: `question` / `userMessage` / `context` / `keepTerms`)を正規化した JSON(キーを辞書順に並べ空白を含まない形)に置き換える案と、`question` のまま残して追加の引数を記録しない案がある(確認事項 6)。本案は前者で、生クエリ表にその JSON を書き、AnswerRun の最終質問 digest もその JSON から計算する。保持期間は従来どおり(ADR-011 §3、ADR-013、既定 30 日)
   - 理由: 昇格判定レポート(T-014)が失敗した run の原文を読むときに、利用者の発言と UI 側 LLM の補足を区別できる。区別できないと、比較実験(T-027)で見る「UI 側 LLM を通すことによる損失」を実運用の記録から確かめられない
   - 永続化できないソース(Slack)が有効な構成では、ADR-019 決定 7 と同じく原文を書かず digest だけを残す
   - run API の上限(本文の大きさ・質問の長さ。ADR-019 決定 3)は、追加の引数を含めた大きさにかける

5. **Slack(ADR-014、不変条件 7)との関係を次のように扱う。**
   - **検索結果に出た語を次のクエリに使う場合**: 探索プロンプトは「次の検索の語は、ここまでの結果に実際に出てきた表記から選ぶ」と指示する(T-024)。Slack の結果に出た語(チャンネル名、人名、本文の語)がクエリに入ると、その語は Slack 由来のデータである。Slack 以外のソースへのクエリに入った場合も同じである。このクエリは、(1) Gateway が生クエリ表に書く `search` のクエリ原文、(2) 決定 3 の `searchesTried`(UI の履歴に残る)、(3) 監査の queryDigest(digest は不可逆なので不変条件 7 の対象外と整理できるかは要確認)、に残りうる
   - **本案**: deployment.yaml で永続化できないソースが有効な構成では、(1) Gateway は tools/call の `search` のクエリ原文を、どのソースへの検索でも生クエリ表に書かない(digest だけを残す。ADR-019 決定 7 の質問原文の扱いに合わせる)。(2) `searchesTried` は query を載せず、sourceId・outcome・newDocuments だけにする。どちらも「run の中で Slack の結果を受け取った後のクエリだけを除く」案より粗いが、Gateway は run の状態を持たない(ADR-019 決定 3)ため、構成単位の判定にする
   - この扱いは、既存の未決事項「Slack 有効時に tools/call の search のクエリ原文を生クエリ表に書く挙動」(ADR-019「実装の記録」、CLAUDE.md)の決着案を兼ねる。T-006 の前に決める
   - `userMessage` / `context` / `keepTerms` は利用者と UI 側 LLM が書いたもので、Slack から取得したデータではない。ただし利用者が Slack で見た内容を書き写すことはありうる。これは現在の `question` と同じ扱い(Slack 有効時は digest だけ)で足りる
   - `leisen-ask serve` は Slack 系のソースが有効なら既定で起動を拒否する(ADR-018 決定 5)ので、LibreChat の経路に Slack は現状含まれない。`--allow-non-persistable-sources` で起動した構成で上の規則が効く
   - Slack の意味検索が使える導入先では、利用者の発言をそのまま渡す検索が有効になりうる(レポート)。その可否は検索プロファイルの `naturalLanguage`(ADR-025 決定 3 の上書き)で伝え、本 ADR の引数は変えない

6. **実行区分と認証は変えない。** human_in_the_loop / actor human 固定(ADR-015、ADR-018 決定 3)、認証の Gateway への委譲(ADR-018 決定 2)はそのまま。追加の引数はトークン・資格情報を含まないが、ログ・エラー・`structuredContent` への出し方は既存の `question` と同じ規律に従う(引数の値をエラー文にエコーしない)

## 理由

- 利用者が入力したキーワードが失われる場所は、UI 側 LLM の書き直しと、探索 LLM のクエリの作り方の 2 か所である(レポート)。後者は探索プロンプトで扱える(T-024)。前者は UI 側 LLM への指示でしか扱えず、自然文の `question` 1 本では、指示に従ったかどうかを Orchestrator が区別できない。`userMessage` と `keepTerms` を分けておけば、UI 側 LLM が従わなかった場合も、比較実験(T-027)と生クエリ表で確かめられる
- `question` を残す理由: 既存の利用面(LibreChat の設定、MCP クライアント、`leisen-ask` CLI)を変えずに済む。新しい引数をどの程度 UI 側 LLM が埋めるかは、モデルによって違うと考えられ(公開の計測は見つかっていない)、埋めない場合でも動く必要がある
- 「試した検索」を返す理由: 委譲先(Orchestrator)の失敗を委譲する側(UI 側 LLM と利用者)に伝える。利用者が別の語で尋ね直す判断の材料になる。返すのは認可済みの結果から計算できることだけにする
- 引数を足すことは利用者向けの面の変更であり、コネクタ IF の変更ではない。ただし ADR-018 決定 1 がツールの形を決めているので ADR で決める

## 帰結

- `packages/orchestrator/src/server/tools.ts`(入力のスキーマと description、`instructions`)、`packages/orchestrator/src/prompt.ts`(最初の user ターンの区分)、`packages/orchestrator/src/answer.ts` と `render.ts`(`searchesTried`、探した範囲の表示)、Gateway の run API(`packages/gateway/src/proxy/runs.ts`、生クエリ表の記録)、`docs/ui-librechat.md` に変更が及ぶ(T-031)
- 生クエリ表に書く量が増える(追加の引数の分)。保持期間とアクセスの経路は変えない
- Slack が有効な構成では、生クエリ表に検索のクエリ原文が残らなくなる(本案を採った場合)。昇格判定レポートの「失敗クエリの原文」は、その構成では「未記録」と表示される(ADR-019 の実装の記録にある「保持期間切れ」と「未記録」の区別を使う)
- 評価(T-027)の条件 4(UI 側 LLM が `ask` に渡した引数を使う)で、`userMessage` / `keepTerms` に利用者が入力したキーワードが残った割合(キーワードの保持率)を、引数の追加の前後で比べられるようになる

## 検討した代替案

- **引数を変えず、description と `instructions` だけで指示する**: 費用は最も小さく、T-024 で先に行う。指示に従ったかを区別できないことが残るので、T-027 で保持率を測って本 ADR の採否を決める材料にする
- **`question` を `userMessage` に置き換えて必須にする**: 役割は明確になるが、既存の利用面が壊れる。確認事項 1 とする
- **会話履歴(`messages` の配列)をそのまま受け取る**(Perplexity の公式 MCP の形。レポート): 文脈は最も多く残るが、`ask` に渡る量と生クエリ表に書く量が大きく増え、UI の履歴に含まれる他の情報(別のツールの結果など)まで Orchestrator と監査に入る。ステートレスの前提(ADR-018 決定 1)とは矛盾しないが、記録の範囲を ADR-013 の観点で見直す必要がある。今回は採らない
- **Orchestrator が利用者の発言からキーワードをコードで抽出し、最初の検索に必ず使う**: レポートの提案だが、オーナーの方針(2026-11-25)により今回の範囲外とした
- **`search` を UI 側 LLM にも公開する**(レポートの案 4): 既知の文書を探す質問を速く正確にできる可能性があるが、Orchestrator を通らない検索は run に紐づかず、ADR-018・ADR-019 に関わる。構成を変えない方針(2026-11-25)により範囲外とした
- **`searchesTried` を返さず、探索 LLM に answer へ書かせるだけにする**: 現行の形。探索 LLM が書くかどうかに依存し、形もそろわない

## 人間に確認してほしい点

1. `question` を必須のまま残し、追加の引数を省略可能にする(本案)か、`userMessage` を必須にするか
2. 追加する引数の範囲: 6 つ(`userMessage` / `context` / `keepTerms` / `sources` / `period` / `depth`)すべてか、まず `userMessage` と `keepTerms` だけにするか
3. 各引数の上限(`context` 1,000 字、`keepTerms` 10 個 × 100 字)
4. `depth` の値と `maxIterations` の対応(上限を超えないことだけを固定し、値は評価で決めるか)
5. `period` を探索 LLM に伝えるだけにする(本案)か、Orchestrator が `search` の引数を書き換えて強制するか
6. run API(ADR-019)で申告する質問を `ask` の入力全体の JSON にする(本案)か、`question` だけのままにするか
7. `searchesTried` を text に載せる条件(本案は outcome が resolved 以外のときだけ)
8. **Slack が有効な構成で、tools/call の `search` のクエリ原文を、どのソースへの検索でも生クエリ表に書かない(本案)か。** 既存の未決事項の決着を兼ねる。T-006 の前に決める
9. Slack 由来の語を含みうるクエリの digest(ToolInvocation の queryDigest、AnswerRun の最終質問 digest)を、不変条件 7 の「永続化」に当たらないと整理してよいか

## 参照

注: 下のレポートと調査ノートは 2026-11-25 時点で main に未収録(作業ツリーの外にある)。収録先が決まったらパスを直す。

- `reports/エージェント検索ハーネス設計調査.md`(「`ask` には利用者の発言をそのまま渡させ、言い換えを UI 側 LLM に任せない」「不変条件と ADR は、変更の置き場所を決めている」のうち Slack の 3 点、「精度の低下は、区間ごとにクエリの作り手を入れ替えて測る」)
- `research_notes/エージェント検索ハーネス設計調査/leisen_current_implementation.md` §1・§7・§8
- ADR-001 追補 3 決定 5、ADR-011 決定 3、ADR-012、ADR-013、ADR-014、ADR-015、ADR-018 決定 1〜3・5、ADR-019 決定 3・7 と「実装の記録」、ADR-025
