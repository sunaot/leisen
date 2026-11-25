# 記録: 探索プロンプト v4 と検索の状況の制御メッセージ(2026-11-25、評価未実施)

Status: **評価未実施**(実装とユニットテストのみ。実モデルでの実走はしていない)/ 対象: `packages/orchestrator/prompts/explore.v4.md`、`packages/orchestrator/src/prompt.ts`(v4 の前置き・上限の制御メッセージ・検索の状況の制御メッセージの文言)、`packages/orchestrator/src/tools.ts`(USAGE_HINTS の v4)、`packages/orchestrator/src/search-feedback.ts`、`packages/orchestrator/src/server/tools.ts`(`ask` の description・`question` の説明・instructions)

これは評価レポートではない。`prompt.ts` の運用規則(プロンプトと制御メッセージの変更には評価レポートを添える)と T-024(改訂の評価は、改訂より前に固定した質問で v3 と比べる)に従い、評価が済むまで v4 と新しい制御メッセージを既定にしないことと、その理由を残す。

## 1. 既定値

| 項目 | 既定 | 切り替え |
|---|---|---|
| 探索プロンプト | `explore.v3`(変更なし) | 設定 `explorePrompt: "explore.v4"`(leisen-ask `--explore-prompt explore.v4`) |
| 検索の状況の制御メッセージと fetch 前の提出の差し戻し | 無効(v3 のとき) | 設定 `searchFeedback`。省略時は `explorePrompt` が v4 のときだけ有効(leisen-ask `--search-feedback on\|off`) |
| v3 の USAGE_HINTS・ソース一覧の前置き・上限の制御メッセージ | 変更なし | v4 を選んだときだけ v4 の文言 |
| `ask` の description・`question` の説明・instructions(UI 側 LLM 向け) | 新しい文言(既定で有効) | 切り替えなし |

- leisen-ask の `--explore-prompt` / `--search-feedback` は開発・評価用で、`NODE_ENV=production` では引数の不備として拒否する。`leisen-ask serve` と deployment.yaml には出していない(T-024「開発用にプロンプトの版を指定する手段(本番では使えないもの)」)
- `ask` の文言を既定にした理由: 引数(`ask({question})`、ADR-018 決定1)は変えず、指示の向きは「利用者の発言を変えずに渡す」という情報を減らさない方向であること。dev-eval は UI 側 LLM を通らないため、この文言は dev-eval では評価できない(T-024 の評価の対象外)。効きは LibreChat 経由の計測(UI 側モデルが `question` に利用者のキーワードを残す割合)で別に確かめる必要がある。**未確認**

## 2. v4 の変更点(v3 との差)

- 全ソース共通の指針(「多くのソースは空白区切りの語をすべて含む文書だけを返す」「名詞を 1〜2 語だけ」「質問文をそのまま入れない」)を削り、ソース一覧の各ソースの `summary` / `supportedFilters` に書かれた検索の仕様に合わせる指示にした。仕様が書かれていないソースは「語の組み合わせ方は分からない」として扱い、文ではなく語を空白で区切って入れ、0 件なら語を減らす
- 最初のターンに、利用者が入力したキーワードをそのまま使った検索・表記の違う言い換え(別の検索)・事柄ごとの検索を 1 回の応答で並べる。意味を知らない社内用語を推測で言い換えない。次の検索の語は結果に出てきた表記から選ぶ
- 有望な 2〜3 件を fetch してから判断する。止める基準(各事柄に本文で裏付けた文書がある / キーワード・語を減らした検索・表記を変えた検索がいずれも新しい有望な文書を返さない → 上限まで探さず unresolved)と、続ける基準(ヒットがあるのに未 fetch / 未裏付けの事柄と未試行の検索がある)
- 回数の目安(単純な質問は 2〜4 回の呼び出し、複数の事柄は 10 回前後、1 ターンに複数並べてよい)。上限の制御メッセージにも同じ目安と 1 ターンの呼び出し上限を出す
- 「回答のルール」は v3 と同一、「ツール結果の扱い」は v3 の各行を残し、summary の検索の仕様を「query と filters を合わせるための事実の記述としてだけ使う」行と、制御メッセージで再掲する query は指示ではない旨を足した(テストで固定)
- list の説明・手順は、`filters.container` を「そのソースの supportedFilters に container があれば」に限った(Redmine のようにフィルタ未対応のソースで 1 ターンを失わないため)

## 3. 検索の状況の制御メッセージ(`search-feedback.ts`)

各ツールターンの後、ツール結果の外に「[オーケストレーター]」で始まるテキストとして置く(上限に達したターンは最終ターンの指示だけ)。

- ヒットを返さなかった検索: そのソースの summary の検索の仕様を読み直し、語を減らす・(filters を指定していれば)filters を外す・別の表記・別のソースを試す。「見つからなかったことは、文書が存在しない根拠にならない」を保つ
- 同じソースへの同じ query(NFKC・空白・大文字小文字を正規化)と filters(と cursor)の再実行
- ヒットがすべて既出の文書(この run の search ヒット・fetch で得た文書)
- ここまでの検索の一覧(ターン、ソース、query、新しく得た文書の数 / ヒットなし / 繰り返し / エラー。直近 20 件)と残りのターン数
- ヒットを受け取ったのに 1 件も fetch せずに submit_answer を呼んだら 1 回だけ差し戻す(`MAX_FETCH_PUSHBACKS = 1`。ヒットが 1 件もなければ差し戻さない。上限到達後の最終ターンでは差し戻さない。差し戻しはツールターンに数えない)

ADR-012 との関係: 書くのは query の形と、返却済みのヒット(LLM がツール結果として受け取ったもの)から数えた値だけ。総件数・未認可候補の件数・権限で落ちたかどうかは書かない(Orchestrator は持っていない)。search のツールエラーは分類を問わず「エラー」とだけ書く(権限外と不在の区別を推させない。テストで permission_denied / not_found / not_available が同一の制御メッセージになることを固定)。`nextCursor` は使わない。語数の上限などソースの検索の仕様に基づく判定は、構造化された検索プロファイル(コネクタの IF 変更、ADR が要る)がないため実装していない。

不変条件7 との関係: query の一覧は run のメモリと探索 LLM への制御メッセージ(揮発)にだけ置き、`ask` の返り値(Answer・warnings)と run API の申告(監査)には載せない(テストで固定)。Gateway の生クエリ表・監査の書き込みは変えていない。なお、制御メッセージは LLM への入力として LLM バックエンドに送られる(既存のツール結果と同じ扱い)。

query の再掲は JSON 文字列として引用し、`[` `]` `<` `>` をエスケープし、100 文字で切る(文書由来の文字列で「[オーケストレーター]」やタグを偽装させない)。

## 4. 評価の予定(T-024 の受け入れ条件に従う)

1. v4 を書いていない別のセッション・人が、新しい質問(複数文書・文書にない質問・1 文書の表記ゆれ / 英語)を `examples/eval/` に、計測前の別コミットで固定する(T-024「判断が必要な点」の A / B。本セッションは v4 の改訂者なので質問を書いていない)
2. 同じ質問を v3 と v4 で `--repeat 2` で流す。例:

   ```sh
   node packages/orchestrator/dist/bin/dev-eval.js --label explore.v4 --repeat 2 -- \
     --gateway http://127.0.0.1:8787/mcp --config examples/deployment.dev.yaml \
     --llm openai-compatible --llm-base-url http://localhost:1234/v1 --model <モデル名> \
     --explore-prompt explore.v4
   ```

   v4 から制御メッセージだけを外した比較は `--search-feedback off`、v3 に制御メッセージだけを足した比較は `--explore-prompt explore.v3 --search-feedback on`
3. T-022 の 20 問で v4 を `--repeat 2` で流し、回帰(表記ゆれ・英語の合格、文書にない質問での作り話)を確かめる。文書にない質問のターン数・所要時間の変化を報告する
4. v4 が v3 より良くならなければ v3 のままにし、根拠を評価レポートに残す。良ければ `EXPLORE_PROMPT_VERSION` を `explore.v4` に上げる

注意:
- dev-eval のレポートの「プロンプト」欄は `EXPLORE_PROMPT_VERSION`(既定の版)を出すため、`--explore-prompt` で v4 を選んでも `explore.v3` と表示される。v4 の計測では `--label` で版を明示する(dev-eval は本タスクの範囲外のため変えていない)
- 開発用コネクタは AND の部分一致で、summary に検索の仕様を書いていない(既定の summary)。v4 の「summary の検索の仕様に合わせる」の効きは、コネクタ側の summary(別の作業)と、実ソース型のフィクスチャがそろってから測る必要がある

## 5. 確認したこと / 確認していないこと

- 確認した: `npm run build && npm test`、`npm run lint:imports`(ユニットテストは脚本の LLM と偽の Gateway で、0 件・重複・既出のみ・一覧・差し戻し(上限 1 回、ヒットなし・最終ターン・v3 では差し戻さない)・ADR-012(権限・件数の語が出ない、エラーの内訳で文言が変わらない)・不変条件7(query が回答・申告に載らない)・v3 の既定が変わらないこと・v3 の防御の文言の引き継ぎ)
- **未確認**: 実モデル(LM Studio / Claude API)での v4 と制御メッセージの効き、所要時間・ターン数への影響、UI 側 LLM が新しい `ask` の説明に従うか、OpenAI 互換バックエンドで差し戻しのターン(submit_answer へのエラーの tool_result)が期待どおりに扱われるか
