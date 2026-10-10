# 評価レポート: 探索プロンプト v3 の汎化確認(T-022、2026-10-09)

Status: 計測済み / 対象: `packages/orchestrator/prompts/explore.v3.md`(変更なし)/ 前回: [2026-10-08-explore-v3.md](2026-10-08-explore-v3.md)

探索プロンプト v3 は、合成コーパスの 4 問で見えた失敗を見て作った改訂で、同じ 4 問で 4 / 4 合格した。本レポートは、v3 の作成前に見ていない 16 問を足した 20 問を各 2 回流し、この 4 問への合わせ込みがないか・結果がぶれないかを確かめた結果。

## 1. 条件

| 項目 | 値 |
|---|---|
| 環境 | 前回と同じ(Gateway は `examples/deployment.dev.yaml`、合成コーパス 7 文書、LM Studio の `qwen3.6-27b-fable-fusion-711-uncensored-heretic-nm-dau-neo-max-mtp`、Orchestrator は既定値: `maxIterations` 6・`runTimeoutMs` 120 秒) |
| 質問セット | `examples/eval/dev-questions.json` 20 問(コミット `a2c28a6`)。baseline 4(v3 の改訂に使った質問)+ 新規 16(未カバーの文書 4、表記ゆれ 4、英語 2、複数文書 3、文書にない 3) |
| 質問の書き手 | **v3 を書いたセッション(T-022 のオーナー決定 C)。** 合わせ込みを避けるため、利用者の言い回しで書き、文書と語が一致しない質問・文書にない語を含む質問を意図して入れた。質問は計測前に別コミットで固定し、計測後に差し替えていない |
| 計測 | dev-eval `--repeat 2`(40 run)。所要時間は kp-ask の起動から終了までの実時間 |

## 2. 結果

**合格 37 / 40。** 不合格 3 件はすべて複数文書の質問。文書にない質問(baseline の 1 問を含む 4 問 × 2 回)はすべて unresolved で、作り話はなかった。探索の上限(ターン数・時間)に達した run は 8 件。

| 種類 | 合格 | LLM ターン(平均) | ツール呼び出し(平均、describe を含む) | 所要時間(中央値 / 最大、秒) | 入力トークン(平均) |
|---|---|---|---|---|---|
| baseline | 8 / 8 | 3.9 | 3.9 | 49.3 / 73.0 | 11,384 |
| uncovered-doc | 8 / 8 | 3.1 | 3.1 | 36.0 / 49.9 | 9,017 |
| paraphrase | 8 / 8 | 4.0 | 4.2 | 52.1 / 178.1 | 12,022 |
| english | 4 / 4 | 4.2 | 4.5 | 60.4 / 64.1 | 12,820 |
| multi-doc | **3 / 6** | 4.7 | 5.8 | 91.5 / 112.1 | 14,914 |
| absent | 6 / 6 | 6.2 | 6.2 | 77.8 / 113.4 | 17,925 |
| 全体 | **37 / 40** | 4.2 | 4.5 | 52.2 / 178.1 | 12,692 |

質問ごとに見ると、2 回で結果が分かれた(ぶれた)のは multi-incident-wiki(1 / 2)だけ。multi-newcomer-vpn は 2 回とも不合格(0 / 2)、ほかの 18 問は 2 回とも合格。

Gateway の監査(ToolInvocation)から読んだ呼び出し順(`search(n)` は返したヒット件数、`C` は `filters.container` 付き):

| 質問 ID | 1 回目 | 2 回目 |
|---|---|---|
| expense-deadline | search(2) → fetch | search(2) → fetch |
| incident-contact | search(1) → fetch | search(1) → fetch |
| company-car-absent | search(0) ×3 → search(0,C) → list → search(0) | search(0) ×3 → search(0,C) → search(0) |
| vpn-url-request | search(2) → fetch | search(2) → fetch |
| onboarding-first-day | search(1) → fetch | search(1) → fetch |
| meeting-agenda-deadline | search(1) → fetch | search(1) → fetch |
| leave-paid-notice | search(1)(スニペットで回答) | search(1,C)(スニペットで回答) |
| wiki-page-opening | search(0) ×2 → search(1) → fetch | search(0) → search(1) → fetch |
| paraphrase-nenkyu | search(0) ×2 → search(2) → fetch | search(0) → search(1) → fetch |
| paraphrase-remote-access | search(0) → search(1) → fetch → search(2) → fetch | search(0) ×2 → search(2) → fetch |
| paraphrase-no-receipt | search(2) → search(0) → fetch | search(2) → fetch |
| paraphrase-outage-report | search(1) → search(0) → fetch | search(1) → fetch |
| english-expense-deadline | search(0) ×2 → search(2) → fetch | search(0) ×2 → search(2) → fetch |
| english-sick-day | search(0) → search(2) → fetch | search(0) → search(2) → fetch |
| multi-newcomer-vpn(×) | search(2) → search(0) ×4 → list(上限) | search(2) → fetch → search(0) ×3 → search(0,C)(上限) |
| multi-incident-wiki | search(1) → search(0) → fetch → search(0) ×2 → search(1) → fetch | search(1) → search(0) → fetch → search(1) → search(0)(2 つ目を fetch せず不合格) |
| multi-expense-and-leave | search(0) → search(1) → search(2) | search(2) → search(1) |
| absent-parking | search(0) ×3 | search(0) ×2 → search(0,C) → search(0) |
| absent-book-subsidy | search(0) ×3 → list → search(0) ×2(上限) | search(0) ×4 → search(0,C) ×2(上限) |
| absent-telework-allowance | search(0) ×6(上限) | search(0) ×6(上限) |

## 3. 読み取れること

1. **合わせ込みは見えない。** v3 の作成前に見ていない 1 文書の質問(uncovered-doc・paraphrase・english、計 20 run)はすべて合格した。baseline より少ない手数で解けている種類もある(uncovered-doc は平均 3.1 ターン)
2. **表記ゆれ・英語は「語を減らす」で立て直している。** paraphrase・english の多くは、最初の検索が質問側の語(年休、在宅、英語の語)で 0 件になり、1〜2 回の言い換えで当たっている(v3 の「0 件なら語を減らす・言い換えを別の search で試す」が効いている)。そのぶん 1 文書の質問より 1 ターン前後多い
3. **list の誤用はほぼ消えた。** 40 run で list は 3 回(文書にない質問の探索中に 2 回で結論は正しかった、multi-newcomer-vpn の上限直前に 1 回)。区画内の探索には `filters.container` 付きの search が使われている
4. **文書にない質問は正しく unresolved だが、上限まで探し続ける。** absent の 6 run のうち 4 run が上限(6 ターン)に達し、所要時間の中央値は 77.8 秒で、全種類の中で最も長い。見つからないときの打ち切りの基準がプロンプトにない
5. **複数文書の質問が弱い(3 / 6)。** 原因は §4

## 4. 不合格の原因の分類

| run | 分類 | 内容 |
|---|---|---|
| multi-newcomer-vpn 1 回目 | 検索語の作り方(2 つ目の文書に届かない)+ 上限到達 | 最初の検索で VPN の文書に当たった後、オンボーディングの文書を探す検索が 4 回とも 0 件で、上限に達した。文書のタイトルは「新入社員オンボーディングガイド」で、「新入社員」1 語なら当たる。監査は検索語をハッシュでしか残さないため語は推定できないが、質問の後半(「何を済ませておく」)を表す語を組み合わせて AND で落ちたと考えられる |
| multi-newcomer-vpn 2 回目 | 同上 | VPN の文書を fetch した後、もう 1 文書を探す検索が 4 回とも 0 件(最後は区画指定)で上限に達した |
| multi-incident-wiki 2 回目 | 2 つ目の文書を読まずに打ち切り | 障害の文書を fetch した後の検索で 1 件ヒットしたが、fetch せずに次の検索(0 件)へ進み、障害の文書だけを引用して unresolved とした。1 回目は同じ流れで 2 つ目のヒットを fetch して合格している |

共通するのは、**質問を「事柄ごとの検索」に分解できていないこと**。2 つの事柄が質問文に明示された multi-expense-and-leave(経費精算と有給休暇)は 2 回とも 2〜3 ターンで合格したが、2 つ目の事柄が質問文に明示されていない multi-newcomer-vpn(新入社員の準備 = オンボーディング)は 2 回とも届かなかった。

**質問側の注記:** multi-newcomer-vpn は「VPN の文書だけでも部分的に答えられる」質問で、期待値(オンボーディングの文書も引用する)はやや厳しい。ただしモデルは 2 回とも「部分的に答える」ではなく unresolved を選んでおり、期待値を緩めても合格にはならない。計測後に期待値は変えていない。

## 5. 次の改訂の候補(未実施)

- **複数の事柄を聞く質問は、事柄ごとに分けて検索する**(並行に呼んでよい)。1 つの事柄の文書が見つかった後も、残りの事柄を探す。見つかったヒットは fetch してから判断する
- **見つからないときの打ち切り**: 1 語の検索・区画を絞った検索がいずれも 0 件なら、上限まで探さずに unresolved で答える(absent の所要時間を縮める)。ただし探索を早く打ち切ると表記ゆれの立て直し(§3-2)を損なうおそれがあり、効き方の確認が要る

T-022 の受け入れ条件のとおり、プロンプトを再改訂する場合は、改訂前に見ていない質問でも測る(本レポートの 20 問は改訂の材料になったため、再改訂の評価だけには使えない)。

## 6. 限界

- 質問の書き手は v3 を書いたセッション(§1)。手当てはしたが、書き手の偏りは否定できない
- 合成コーパス 7 文書・20 問・1 モデル・各 2 回。2 回では、ぶれの有無は見えても、ぶれの大きさは推定できない
- 開発用コネクタの検索は AND の部分一致だけ。表記ゆれの立て直しの手数は、形態素解析や同義語展開を持つ実ソースでは変わる
- Claude API では未計測

## 付録: dev-eval の出力(抜粋)

各 run の行(質問文・回答本文は含まない):

| 質問 | 種類 | 回 | 判定 | outcome | 引用 | LLM ターン | ツール呼び出し | 入力 / 出力トークン | 秒 |
|---|---|---|---|---|---|---|---|---|---|
| expense-deadline | baseline | 1 | ○ | resolved | dev-docs:expense-rules | 3 | 3 | 9043 / 405 | 31.6 |
| incident-contact | baseline | 1 | ○ | resolved | dev-docs:incident-flow | 3 | 3 | 8637 / 544 | 37.2 |
| company-car-absent | baseline | 1 | ○ | unresolved | — | 7 | 7 | 20604 / 748 | 52.6 |
| vpn-url-request | baseline | 1 | ○ | resolved | dev-docs:vpn-setup | 3 | 3 | 8913 / 724 | 48.5 |
| onboarding-first-day | uncovered-doc | 1 | ○ | resolved | dev-docs:onboarding-guide | 3 | 3 | 8665 / 472 | 33.8 |
| meeting-agenda-deadline | uncovered-doc | 1 | ○ | resolved | dev-docs:meeting-bodies | 3 | 3 | 8756 / 350 | 27.9 |
| leave-paid-notice | uncovered-doc | 1 | ○ | resolved | dev-docs:leave-request | 2 | 2 | 5515 / 283 | 22.4 |
| wiki-page-opening | uncovered-doc | 1 | ○ | resolved | dev-docs:wiki-writing-guide | 5 | 5 | 14650 / 439 | 39.5 |
| paraphrase-nenkyu | paraphrase | 1 | ○ | resolved | dev-docs:leave-request | 5 | 5 | 14879 / 615 | 65.5 |
| paraphrase-remote-access | paraphrase | 1 | ○ | resolved | dev-docs:vpn-setup | 6 | 6 | 19014 / 744 | 178.1 |
| paraphrase-no-receipt | paraphrase | 1 | ○ | resolved | dev-docs:expense-rules | 3 | 4 | 9244 / 475 | 52.2 |
| paraphrase-outage-report | paraphrase | 1 | ○ | resolved | dev-docs:incident-flow | 3 | 4 | 8833 / 499 | 48.9 |
| english-expense-deadline | english | 1 | ○ | resolved | dev-docs:expense-rules | 5 | 5 | 15109 / 582 | 57.1 |
| english-sick-day | english | 1 | ○ | resolved | dev-docs:leave-request | 3 | 4 | 9124 / 542 | 51.0 |
| multi-newcomer-vpn | multi-doc | 1 | × | unresolved | dev-docs:vpn-setup | 7 | 7 | 22358 / 1026 | 93.6 |
| multi-incident-wiki | multi-doc | 1 | ○ | resolved | dev-docs:incident-flow, dev-docs:wiki-writing-guide | 5 | 8 | 16434 / 1196 | 112.1 |
| multi-expense-and-leave | multi-doc | 1 | ○ | resolved | dev-docs:expense-rules, dev-docs:leave-request | 3 | 4 | 9052 / 715 | 70.4 |
| absent-parking | absent | 1 | ○ | unresolved | — | 4 | 4 | 11079 / 479 | 47.1 |
| absent-book-subsidy | absent | 1 | ○ | unresolved | — | 7 | 7 | 20582 / 825 | 81.1 |
| absent-telework-allowance | absent | 1 | ○ | unresolved | — | 7 | 7 | 20553 / 630 | 63.4 |
| expense-deadline | baseline | 2 | ○ | resolved | dev-docs:expense-rules | 3 | 3 | 9043 / 492 | 50.1 |
| incident-contact | baseline | 2 | ○ | resolved | dev-docs:incident-flow | 3 | 3 | 8637 / 368 | 38.0 |
| company-car-absent | baseline | 2 | ○ | unresolved | — | 6 | 6 | 17284 / 742 | 73.0 |
| vpn-url-request | baseline | 2 | ○ | resolved | dev-docs:vpn-setup | 3 | 3 | 8913 / 589 | 58.9 |
| onboarding-first-day | uncovered-doc | 2 | ○ | resolved | dev-docs:onboarding-guide | 3 | 3 | 8665 / 427 | 43.8 |
| meeting-agenda-deadline | uncovered-doc | 2 | ○ | resolved | dev-docs:meeting-bodies | 3 | 3 | 8756 / 490 | 49.9 |
| leave-paid-notice | uncovered-doc | 2 | ○ | resolved | dev-docs:leave-request | 2 | 2 | 5532 / 289 | 29.7 |
| wiki-page-opening | uncovered-doc | 2 | ○ | resolved | dev-docs:wiki-writing-guide | 4 | 4 | 11598 / 354 | 38.1 |
| paraphrase-nenkyu | paraphrase | 2 | ○ | resolved | dev-docs:leave-request | 4 | 4 | 11584 / 505 | 52.0 |
| paraphrase-remote-access | paraphrase | 2 | ○ | resolved | dev-docs:vpn-setup | 5 | 5 | 14913 / 613 | 64.3 |
| paraphrase-no-receipt | paraphrase | 2 | ○ | resolved | dev-docs:expense-rules | 3 | 3 | 9060 / 384 | 42.5 |
| paraphrase-outage-report | paraphrase | 2 | ○ | resolved | dev-docs:incident-flow | 3 | 3 | 8649 / 374 | 40.1 |
| english-expense-deadline | english | 2 | ○ | resolved | dev-docs:expense-rules | 5 | 5 | 15106 / 595 | 64.1 |
| english-sick-day | english | 2 | ○ | resolved | dev-docs:leave-request | 4 | 4 | 11939 / 616 | 63.6 |
| multi-newcomer-vpn | multi-doc | 2 | × | unresolved | dev-docs:vpn-setup | 7 | 7 | 23294 / 1075 | 107.7 |
| multi-incident-wiki | multi-doc | 2 | × | unresolved | dev-docs:incident-flow | 4 | 6 | 12401 / 922 | 89.4 |
| multi-expense-and-leave | multi-doc | 2 | ○ | resolved | dev-docs:expense-rules, dev-docs:leave-request | 2 | 3 | 5945 / 532 | 52.2 |
| absent-parking | absent | 2 | ○ | unresolved | — | 5 | 5 | 14137 / 600 | 74.5 |
| absent-book-subsidy | absent | 2 | ○ | unresolved | — | 7 | 7 | 20633 / 899 | 113.4 |
| absent-telework-allowance | absent | 2 | ○ | unresolved | — | 7 | 7 | 20566 / 826 | 98.8 |
