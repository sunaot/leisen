# 条件 4 の UI 側 LLM への入力を LibreChat に合わせた場合の比較: haiku、esa 型、各 3 回(2026-11-26)

T-027 の `dev-search-eval` による計測。条件 4(利用者の発言 → UI 側 LLM → 探索 LLM(`ask`)→ search)の UI 側 LLM への入力を、
これまでの近似(`simple`)と、LibreChat v0.8.7 のソースコードに合わせた再現(`librechat`)で比べた。参考に、`librechat.yaml` の
`serverInstructions` に instructions の文字列を書いた場合の再現(`librechat-instructions`)も流した。LibreChat の調査の記録は
`research_notes/エージェント検索ハーネス設計調査/librechat_ui_prompt.md`。

## 実行条件

- コード: コミット `556027a`(ブランチ `t027-ui-prompt-librechat`。`claude/relaxed-albattani-dzzqvy` の `039bb0e` に、`--ui-prompt` を足したもの)
- LLM: `claude -p --model haiku`(`--llm claude-cli`。UI 側 LLM も探索 LLM も haiku)。構造化出力(`--json-schema`)によるツール呼び出しの模擬で、
  ネイティブのツール呼び出しではない。Anthropic API のバックエンドでの結果とはみなせない
- 探索プロンプト: 既定の explore.v4、検索の状況の制御メッセージは有効(表の注記で確認した)
- 検索方式: 開発用コネクタの esa 型(模擬)。検索の仕様の伝え方は既定(`summary` の自由文だけ)
- コーパス: 合成 425 件。質問: 全 23 問(既知項目検索 10、複数文書 7、答えられない 6)。各 3 回(`--repeat 3`)。1 組 69 試行
- 各プロセスに `--run-timeout-sec 600 --claude-cli-max-total-usd 3`。条件 3・条件 4(simple)・条件 4(librechat)の 3 つを同時に流し、
  その後で条件 4(librechat-instructions)を 1 つ流した
- 調べた LibreChat: `github.com/danny-avila/LibreChat` のタグ v0.8.7(コミット `9e74cc0e57b395926122bd4062c1fcedc48ed465`)と
  `@librechat/agents` 3.2.46。リファレンス構成(`deploy/compose/`)のイメージ `ghcr.io/librechat-ai/librechat:v0.8.7` と同じ版

### UI 側 LLM への入力

| | simple(従来の近似) | librechat | librechat-instructions |
|---|---|---|---|
| システムプロンプト | `SERVER_INSTRUCTIONS`(leisen の initialize の instructions)そのまま | LibreChat の MCP の instructions の定型文。instructions の位置は `true` | 同じ定型文。instructions の位置に `SERVER_INSTRUCTIONS` |
| ツール | `ask` / `feedback` | `ask_mcp_leisen` / `feedback_mcp_leisen` | 同左 |
| ツールの説明とスキーマ | `orchestratorToolDefinitions` のまま | 同左(LibreChat は加工しない) | 同左 |
| 利用者のターン | 発言 1 つ | 同左 | 同左 |
| 探索 LLM に渡す引数 | `question` だけ | UI 側 LLM が書いた引数すべて(`leisen-ask serve` と同じ検証を通す) | 同左 |

librechat のシステムプロンプトの全文(LibreChat v0.8.7 の `packages/api/src/mcp/MCPManager.ts:305-331` の定型文。サーバー名 `leisen`):

```
# MCP Server Instructions

The following MCP servers are available with their specific instructions:

## leisen MCP Server Instructions

true

Please follow these instructions when using tools from the respective MCP servers.
```

`true` が入る理由: リファレンス構成の `librechat.yaml` は `serverInstructions: true` だが、`startup: false` で、ヘッダに実行時の
プレースホルダ(`{{LIBRECHAT_OPENID_ACCESS_TOKEN}}`)を持つ。LibreChat v0.8.7 が `serverInstructions: true` を initialize の
instructions で置き換えるのは起動時の検査だけで、その検査はこの 2 つの条件のどちらでも接続しないため、真偽値の `true` が残り、
定型文に文字列として入る(ソースコードの読解による。実機では未確認。詳細は調査の記録)。

本番の前に 3 問 × 1 回の動作確認(`--ui-prompt librechat`)を行い、`claude -p` に渡る入力(`--system-prompt-file` の内容と標準入力)を
書き出して、上の定型文とツール名 `ask_mcp_leisen` / `feedback_mcp_leisen`、説明・スキーマが調査の結果と一致することを確かめた。
`claude -p` の模擬では、システムプロンプトの後ろに応答の形式の説明(`CLAUDE_CLI_RESPONSE_PROTOCOL`)が付き、ツール定義は標準入力の
`<tools>` に JSON で入る(下の「限界」)。

## 要約(正解のある 17 問 × 3 回 = 51 試行)

| | 条件 3 | 条件 4 simple | 条件 4 librechat | 参考: 条件 4 librechat-instructions |
|---|---|---|---|---|
| recall@1 | 83% | 77% | 83% | 78% |
| recall@5 | 95% | 90% | 92% | 93% |
| recall@10 | 100% | 94% | 100% | 98% |
| 正解文書を fetch した割合 | 100% | 92% | 100% | 94% |
| 正解文書を引用した割合 | 92% | 90% | 98% | 86% |
| search / 試行 | 3.7 | 3.3 | 3.1 | 2.9 |
| LLM ターン / 試行 | 3.3 | 3.3 | 3.4 | 3.2 |
| 0 件の search の割合 | 14% | 11% | 11% | 14% |
| 答えられない質問の棄権 | 18 / 18 | 18 / 18 | 18 / 18 | 18 / 18 |
| 答えられない質問の search / 試行 | 13.6 | 15.5 | 12.3 | 12.7 |
| 表の「エラー」(case_error) | 0 | 3 | 0 | 0 |
| 回答が outcome: error で終わった試行(69 試行のうち) | 4 | 2 | 3 | 6 |

- 条件 4 simple の case_error 3 件はすべて `ui_llm_error`(UI 側 LLM の `claude -p` の応答が読めなかった)で、探索 LLM を呼んでいない。
  表では recall 0 として数えている
- outcome: error は、探索 LLM の `claude -p` の応答が読めずに run が終わった試行(`llm_unexpected_response`)。表の「エラー」には数えられず、
  答えられない質問では棄権に数えられる(`docs/eval/2026-11-26-search-eval-spec-delivery-haiku.md` で記録した集計の性質)

### 質問の種類別(recall@1 / recall@5 / 引用した割合)

| 種類 | 条件 3 | 条件 4 simple | 条件 4 librechat | 参考: librechat-instructions |
|---|---|---|---|---|
| 既知項目検索(10 問 × 3 回) | 100% / 100% / 90% | 97% / 97% / 93% | 100% / 100% / 100% | 97% / 97% / 83% |
| 複数文書(7 問 × 3 回) | 60% / 88% / 95% | 50% / 81% / 86% | 60% / 81% / 95% | 52% / 88% / 90% |

既知項目検索の search / 試行: 条件 3 が 2.9、simple 2.8、librechat 2.1、librechat-instructions 1.6。

### 回ごとの値(正解のある 17 問。recall@1 / recall@5 / 引用した割合)

| 組 | 1 回目 | 2 回目 | 3 回目 | 3 回の recall@1 の幅 |
|---|---|---|---|---|
| 条件 3 | 85% / 94% / 76% | 82% / 91% / 100% | 82% / 100% / 100% | 3 ポイント |
| 条件 4 simple | 79% / 94% / 88% | 74% / 88% / 88% | 79% / 88% / 94% | 5 ポイント |
| 条件 4 librechat | 85% / 94% / 100% | 82% / 88% / 100% | 82% / 94% / 94% | 3 ポイント |
| 参考: librechat-instructions | 76% / 94% / 82% | 79% / 94% / 94% | 79% / 91% / 82% | 3 ポイント |

条件 3 の 1 回目の引用が 76% なのは、outcome: error の 4 試行(`ki-pr-1287`・`ki-eng-checklist`・`ki-retry-policy`・`md-expense-howto`)が
すべて 1 回目にあったため。

### 質問ごとの最初の正解の順位(試行ごとに / で区切る。× = どの search でも返らなかった、! = 試行がエラー)

| 質問 | 種類 | 条件 3 | 条件 4 simple | 条件 4 librechat | 参考: librechat-instructions |
|---|---|---|---|---|---|
| ki-inc-0412 ほか既知項目 8 問 | known-item | すべて 1 | すべて 1 | すべて 1 | すべて 1 |
| ki-eng-checklist | known-item | 1/1/1 | 1/!/1 | 1/1/1 | 1/1/1 |
| ki-vpn-timeout | known-item | 1/1/1 | 1/1/1 | 1/1/1 | ×/1/1 |
| md-trip | multi-doc | 1/1/1 | 1/1/1 | 1/1/1 | 1/1/1 |
| md-pc-broken | multi-doc | 1/1/1 | 1/1/1 | 1/1/1 | 1/1/1 |
| md-telework-vpn | multi-doc | 1/1/1 | 1/1/! | 1/1/1 | 1/1/1 |
| md-incident-report | multi-doc | 1/1/1 | 1/1/1 | 1/1/1 | 1/1/1 |
| md-leave-handover | multi-doc | 1/1/1 | 3/!/3 | 1/3/1 | 3/2/3 |
| md-new-member-setup | multi-doc | 1/1/1 | 1/1/1 | 1/6/1 | 1/1/3 |
| md-expense-howto | multi-doc | 6/6/2 | 6/2/6 | 6/6/6 | 2/6/6 |
| un-parking ほか 5 問 | unanswerable | すべて ○ | すべて ○ | すべて ○ | すべて ○ |

(`ki-vpn-timeout` の librechat-instructions の 1 回目の × は、探索 LLM の応答が読めずに search の前に run が終わった試行)

## UI 側 LLM が書いた `ask` の引数

数え方: 「利用者が入力したキーワード」は、質問データの `keywords` を空白で区切った語のうち、発言にそのまま含まれるもの(23 問で 27 語。
例: `INC-2026-0412`、`情報セキュリティ規程`、`第7条`、`在宅勤務`、`VPN`)。`keywords` のうち発言にない語(`出張 手配` の `手配` など)は数えない。
各組 27 語 × 3 回 = 81。UI 側 LLM が `ask` を呼べなかった試行(simple の `ui_llm_error` 3 件)は、question なしとして分母に含める。

| | 条件 4 simple | 条件 4 librechat | 参考: librechat-instructions |
|---|---|---|---|
| UI 側 LLM が ask を呼んだ試行 | 66 / 69 | 69 / 69 | 69 / 69 |
| question が利用者の発言と同一 | 64 / 69(呼んだ試行の 64 / 66) | 67 / 69 | 69 / 69 |
| 利用者が入力したキーワードが question に残った | 77 / 81(呼んだ試行では 77 / 77) | 81 / 81 | 81 / 81 |
| userMessage を書いた | 66(すべて発言と同一) | 69(すべて発言と同一) | 69(すべて発言と同一) |
| keepTerms を書いた(要素数 1 / 2) | 52(41 / 11) | 34(25 / 9) | 45(30 / 15) |
| 利用者が入力したキーワードが keepTerms に入った | 51 / 81 | 39 / 81 | 52 / 81 |
| context / sources / period / depth を書いた | 0 | 0 | 0 |
| 引数が検証で拒否された | —(検証しない) | 0 | 0 |
| 探索 LLM に届いた引数 | question だけ | question + userMessage + keepTerms(書かれたもの) | 同左 |

question が発言と違った例(すべて):
- simple: `ki-minutes-0909`(3 回目)「2026-09-09 の部長会の議事録ある?」→「2026-09-09 の部長会の議事録はありますか?」、
  `un-minutes-1014`(3 回目)も同じ形の言い換え。ほか 3 件は ask を呼べなかった試行
- librechat: `ki-cache-note`(1 回目)「設計メモの「検索キャッシュの方針」を読みたいんだけど、どこにある?」→「設計メモの「検索キャッシュの方針」はどこにありますか?」、
  `md-trip`(3 回目)「来月大阪に出張する。新幹線の予約と、出張費の精算はどうすればいい?」→「社内で、大阪への出張に伴う新幹線の予約方法と、出張費の精算方法を教えてください。」
  (「来月」が落ち、「社内で」が足された)。どちらも userMessage には発言がそのまま入っていた
- librechat-instructions: なし

keepTerms の例: `INC-2026-0412`・`retry-policy.yaml`・`#1287`・`情報セキュリティ規程` と `第7条` はどの組でも 3 回とも書かれた。
simple は `「経費精算ルール(2026年度版)」`(かぎ括弧ごと)を 2 回書いた。librechat と librechat-instructions は括弧の中だけ(`経費精算ルール(2026年度版)`)を 3 回書いた。
発言にない語を keepTerms に書いた例はなかった。

## 読み取れること(事実)

- 条件 4 librechat の recall@1 / @5 / @10 は 83% / 92% / 100% で、条件 3(83% / 95% / 100%)とほぼ同じだった。条件 4 simple は 77% / 90% / 94%
  で、3 件の `ui_llm_error`(UI 側 LLM の応答が読めなかった)の試行が recall 0 として入っている。その 3 件を除いた 48 試行では、
  simple の recall@1 / @5 / @10 / 引用は 82% / 96% / 100% / 96% で、librechat(83% / 92% / 100% / 98%)と同じ程度になる
- 回ごとの recall@1 の幅は 3〜5 ポイントで、librechat と条件 3 の差(0 ポイント)、simple と librechat の差(6 ポイント。上の 3 件を含む。除くと 1 ポイント)は、
  この幅と同じ程度か、エラーの件数で説明できる大きさだった
- librechat の UI 側 LLM は、システムプロンプトに leisen の指示がなく(`true` だけ)、ツールの説明だけを読んで ask を呼んだ。69 試行すべてで
  ask_mcp_leisen を呼び、userMessage は 69 回すべて発言と同一、question は 67 回が発言と同一、利用者が入力したキーワードは 81 語すべてが question に残った
- simple と librechat-instructions(どちらも leisen の instructions がシステムプロンプトにある)は、librechat より keepTerms を多く書いた(52 回・45 回と 34 回)
- simple でも UI 側 LLM は userMessage(66 回)と keepTerms(52 回)を書いていたが、simple の再現は question だけを探索 LLM に渡すため、
  それらは探索 LLM に届いていない。librechat と librechat-instructions では届いた
- 既知項目検索の search / 試行は、条件 3 が 2.9、simple 2.8、librechat 2.1、librechat-instructions 1.6 で、探索 LLM に userMessage・keepTerms の区分が
  届いた組で少なかった
- context・sources・period・depth は、どの組でも一度も書かれなかった(23 問の発言には、期間・対象のソース・深さの指定や、前の会話を指す語がない)
- 答えられない質問は、どの組でも 18 試行すべてで棄権した

## 解釈

- この質問セットと haiku では、UI 側 LLM はほぼ常に利用者の発言をそのまま question に写した。UI 側 LLM を通すことによる損失は、simple でも
  librechat でも、`claude -p` の応答が読めなかった失敗を除けば、試行ごとのばらつきより明確に大きいとは言えない
- LibreChat のリファレンス構成で instructions が `true` になっていても、この質問セットでは UI 側 LLM の引数の書き方は大きく崩れなかった。
  ツールの説明(`ask` の description と各引数の説明)に同じ指示があるためと考えられる。ただし、instructions がある組の方が keepTerms を多く書いており、
  instructions が全く効いていないわけではない
- librechat と librechat-instructions で、探索 LLM に keepTerms・userMessage が届くと既知項目検索の search の回数が減った。recall と引用に
  はっきりした差は出なかった(既知項目検索はどの組でも 1 位がほぼ 100%)
- 以前の simple の再現は、question 以外の引数を捨てていたため、実際の LibreChat の経路(引数がすべて渡る)と違う入力を探索 LLM に与えていた。
  この計測の範囲では、その違いで結果が大きく変わることはなかった

### 言えること

- haiku・合成コーパス・23 問・発言 1 つでは、LibreChat v0.8.7 のリファレンス構成に合わせた再現(librechat)の条件 4 は、条件 3 と同じ程度の recall だった
- その再現では、UI 側 LLM は利用者の発言をほぼ変えずに question と userMessage に入れ、利用者が入力したキーワードを question からなくさなかった
- ソースコードの読解では、リファレンス構成の `serverInstructions: true` は、`startup: false` のため leisen の instructions を UI 側 LLM に渡さない
  (定型文に `true` が入る)。これは計測ではなく調査の結果である

### 言えないこと

- 実際の LibreChat で UI 側 LLM が書く引数がこの再現と同じであること(実走の引数と突き合わせていない)
- 実機の LibreChat のシステムプロンプトに `true` が入ること(ソースコードを読んだだけで、動かしていない)
- 利用者が LibreChat で選ぶモデル(リファレンス構成は LM Studio の手元のモデル、既定 `openai/gpt-oss-20b`)での結果。haiku は小型の手元のモデルより
  指示に従いやすい可能性がある
- 会話の途中の発言(「それ」「さっきの件」など)での引数の書き方。context が要る場面がこの質問セットにない
- instructions の有無(librechat と librechat-instructions)の差が recall に効くかどうか。差はばらつきと同じ程度で、outcome: error の件数(3 件と 6 件)の違いも混ざっている

## 限界

- 1 つのモデル(haiku)を UI 側 LLM と探索 LLM の両方に使った。`claude -p` の構造化出力によるツール呼び出しの模擬で、ネイティブのツール呼び出しではない。
  UI 側 LLM への入力の再現もこの模擬を通るため、実際の LibreChat とは次の点でずれる:
  - システムプロンプトの後ろに、この実行環境の応答の形式の説明(`CLAUDE_CLI_RESPONSE_PROTOCOL`。日本語で、「submit_answer を含む」ツールを JSON で呼ぶ決まり)が付く。LibreChat にはない文で、
    探索 LLM 向けの語(submit_answer)も含む
  - ツール定義は API のツールの欄ではなく、標準入力の `<tools>` に JSON の文字列として入り、利用者の発言も `<conversation>` のタグに包まれる
  - `claude -p` 自身の内部の指示と構造化出力の仕組みが間に入る。CLI の内部で 3 ターン以上かかった呼び出しが、各組で呼び出しの 42〜53%(simple 179 / 338、librechat 173 / 338)あった
  - LibreChat が使う LangChain のツール定義の変換(strict の付与など)は再現していない(未確認)
- 利用者の発言 1 つだけで、会話履歴はない。利用者のカスタム指示・artifacts・ファイル・メモリの文は入れていない(リファレンス構成の既定では入らない)
- `ask` がエラーを返したときに UI 側 LLM が言い直す動き、ask の結果を UI 側 LLM が利用者に示す部分は再現していない
- 検索方式は開発用コネクタの esa 型の模擬、合成コーパス(425 件)と 23 問。複数文書の質問は 7 問で、1〜2 問の違いが割合を大きく動かす
- 各組 3 回。条件 3・simple・librechat は同時に流し、librechat-instructions はその後に流した(時間帯の違いによる影響は確かめていない)
- 回答の内容の正しさは採点していない
- 実際の LibreChat の実走で採った `ask` の引数との突き合わせ(T-027 の受け入れ条件)はしていない

## 費用と時間

| 組 | `claude -p` の呼び出し | 失敗 | 費用 | 子プロセスの実時間の合計 |
|---|---|---|---|---|
| 条件 3 | 273 | 4 | $0.5668 | 1,507 秒 |
| 条件 4 simple | 338 | 5 | $0.6116 | 1,762 秒 |
| 条件 4 librechat | 338 | 3 | $0.5969 | 1,679 秒 |
| 参考: librechat-instructions | 346 | 6 | $0.5940 | 1,757 秒 |

合計 $2.37(動作確認の $0.02 を含めると $2.39)。失敗はすべて `llm_unexpected_response`(構造化出力が読めない)。3 つを同時に流した分は約 40 分、
librechat-instructions は約 30 分かかった。
