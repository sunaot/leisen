# 公開リポジトリには規則と決定だけを残す

エージェント開発を積極的に行う OSS の主流は、公開リポジトリに「短い規則ファイル」「手順としてのスキル」「長く効く決定記録と現状の設計書」だけを置き、進行中のタスク・計画・評価ログは GitHub Issues やプライベートな置き場に出している。調査した約 50 のリポジトリで、ファイル単位のバックログを既定ブランチに常設している例は 1 つも見つからず、36,710 リポジトリを調べた研究でもコミットされた計画ファイルは 10 リポジトリの 85 個にとどまる ([ESEM 2026](https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.ESEM.2026.54))。leisen の「backlog・ADR・設計書・.claude を全部入り」は、この分布の外側にある。問題は量ではなく、状態の正本が決まっていないことである。CLAUDE.md の本文の約 69% が日付付きの状況ログで、同じ進捗が少なくとも 4 層に手で複写され、ADR-018 の Status や SDK の版ですでに食い違いが出ている ([棚卸し](../research_notes/エージェント開発OSSの開発環境管理/leisen_inventory.md))。提案は次の 3 点である。(1) 規則ファイルを恒久ルールだけの約 5,000 文字に戻して AGENTS.md を正本にする。(2) タスクと未決事項の正本を GitHub Issues に移し、完了済み backlog は履歴として凍結する。(3) ADR は残すが、追補を重ねる運用をやめて「変わらない決定記録」と「現状を書く設計書」に分ける。内部正本と公開ミラーの二重化は、数人以下のチームには割に合わないので採らない。ただし「全部入り」を支持する根拠もある(OpenAI の社内事例)。その根拠は翻訳経由でしか確認できておらず、公開 OSS での実例ではない。

## 現在のプラクティスは 6 類型に分かれ、主流は「規則とスキルだけ同梱」である

調査対象は、コーディングエージェントのベンダー自身のリポジトリ 17 と、エージェントを多用するプロダクトのリポジトリ約 35 である。いずれも 2026-11-15 時点の既定ブランチを clone して確認した。類型は排他ではなく、B の上に C を重ね、個人の作業物を E に逃がす組み合わせが最も多い。

| 類型 | 何をリポジトリに置くか | 採用例 | 利点 | コスト | 評価 |
|---|---|---|---|---|---|
| A. 最小ハーネス | 数行〜数十行の規則ファイルのみ、または何も置かない | simonw/llm(24 行)、datasette(5 行)、antirez の各リポジトリ(なし)、minijinja(プロンプト 2 本)、workers-oauth-provider(AGENTS.md 295 行のみ) | 陳腐化するものがない。公開の記録はコミット履歴とテスト | 手順の知識が個人に残る。規則をテストや lint で表現できる成熟が要る | 単独メンテナの小さなライブラリ向き。不変条件が 9 つある leisen には足りない |
| B. 規則+スキル同梱(主流) | 短いルート規則、ディレクトリ別の規則、スキル、少数のフック。作業項目は Issues / Projects | opencode、gemini-cli、goose、next.js、sentry、PostHog、zed、OpenHands、modelcontextprotocol/servers | 外部の貢献者のエージェントも同じ規則で動く。常時読み込む量が小さい | スキルの保守。複数ツール対応の symlink 管理 | 公開 OSS の事実上の標準。leisen の土台にすべき型 |
| C. 決定記録と現状仕様の同梱 | B に加えて ADR / RFC と「今どう動くか」の設計書 | cloudflare/agents(design/ 58 ファイル、RFC 27 本)、vercel/ai(2026-03 に ADR 採用)、beads(engdocs/adr)、opencode(specs/v2)、MCP 仕様(seps/ 48 本) | 「なぜ」を再調査せずに済む。却下済みの案の蒸し返しを防ぐ | 索引と状態欄を保たないと読まれない | 認可・監査が価値の中心にある leisen には必須。ただし現状の書き方は直す |
| D. 変更単位の計画・仕様の同梱 | 変更ごとの proposal / plan / tasks、またはファイル型バックログ | sentry-mcp(OpenSpec と日付付き plan)、spec-kit、OpenSpec、Backlog.md、OpenAI の社内プロダクト(exec-plans/active・completed。翻訳経由) | エージェントがオフラインで読める。計画をレビューできる | 第二のコードベースになり腐る。並行エージェントで書き込みが衝突する | 完了後に凍結・アーカイブ・削除のいずれかを決めた場合だけ成立する。常設は少数派 |
| E. 私的な置き場への分離 | 規則とスキルは公開、調査・計画・タスクメモは別リポジトリかローカル | humanlayer(`/thoughts/` を gitignore し別リポジトリへ)、beads(メンテナ用の台帳は非公開、公開の追跡は Issues)、Ronacher(個人ハーネスを別リポジトリ agent-stuff に)、sentry(スキルを agents.toml で外部から取得) | 率直なメモを公開面に出さずに版管理できる | symlink とフックが各マシンに要る。クラウドセッションでは別リポジトリとして付ける必要がある(推論) | 公開に向かない少量の資料にだけ使うのが現実的 |
| F. 内部正本+公開ミラー | 公開側は派生物。ハーネスの本体は内部 | openai/codex(全コミットが copyberry、2026-09-30 にルート AGENTS.md と .codex/ を削除)、anthropics/claude-code(製品ソースなし)、E2B(仕様を Copybara で同期) | 内部資料が公開に出ない保証が最も強い | 外部 PR の取り込みが壊れやすい(snippet・未検証)。同期の保守が常時かかる | 大手ベンダーの型。数人のチームには割に合わない |

A・B・C の根拠は直接確認したツリーである。opencode は方針を一文で書いている。「GitHub issues own active work; Git history preserves removed plans and scratchpads.」([specs/v2/README.md](https://github.com/anomalyco/opencode/blob/HEAD/specs/v2/README.md))。goose は issue を作業の正本とし、公開の Projects ボードで状態が Ready になるまでエージェントに実装させない ([AGENTS.md](https://github.com/aaif-goose/goose/blob/HEAD/AGENTS.md))。gemini-cli、Roo-Code、pi-mono は計画用のディレクトリ(`conductor/`、`plans/`、`todo.md`)を gitignore している ([gemini-cli .gitignore](https://github.com/google-gemini/gemini-cli/blob/HEAD/.gitignore)、[pi-mono .gitignore](https://github.com/earendil-works/pi-mono/blob/HEAD/.gitignore))。OpenHands は設計書を PR 本文に書き、一時的な成果物を置く `.pr/` はリリース時に消す決まりにしている ([software-agent-sdk AGENTS.md](https://github.com/OpenHands/software-agent-sdk/blob/HEAD/AGENTS.md))。

**D の常設がうまくいかなかった実例が beads である。** リポジトリ内の issue ファイルを広めた当のプロジェクトが、今は自分の `.beads/` を gitignore し、「GitHub Issues is the public tracker」と書いている ([beads AGENTS.md](https://github.com/steveyegge/beads/blob/HEAD/AGENTS.md))。理由は、多数のエージェントが互いの書き込みを上書きして復旧できなくなったことだと説明されている。ただしこの説明は Dolt の開発元の記事によるもので、作者本人の記述は確認していない ([DoltHub](https://www.dolthub.com/blog/2026-03-13-multi-agent-persistence/))。

F の codex では、最近 500 コミットのすべてでコミッターが `copyberry` であり、`GitOrigin-RevId` が付いている。ルートの AGENTS.md と `.codex/skills/` を消した PR は理由を書いていない ([PR #49713](https://github.com/openai/codex/pull/49713))。「ハーネスは非公開にすべきだ」と明文化した方針はどのリポジトリにも見つからなかった。既定はコミットである。

## 規則ファイルは短く、手順はスキルへ、決定は不変の記録へ

類型を横断して、成果物の種類ごとの扱いはほぼ揃っている。

**規則ファイルは「コードから読み取れないこと」に絞られている。** ベンダー自身のルートファイルは 5〜240 行で、中身はコマンド、依存の向き、禁止事項である。Anthropic の文書は 1 ファイル 200 行未満を目安とし、規則ファイルは「context, not enforced configuration」であって、確実に止めたい操作には PreToolUse フックを使えと書く ([Claude Code docs](https://code.claude.com/docs/en/memory))。ETH Zurich らの評価は、コンテキストファイルは一般にタスク成功率を上げず、推論コストを平均 20% 以上増やし、リポジトリ概要は役に立たないと結論した(確認したのは要旨のみ。[arXiv:2602.11988](https://arxiv.org/abs/2602.11988))。現場の規則も同じ方向を向いている。modelcontextprotocol/servers は「規則はこのファイル、手順はオンデマンドで読み込むスキル」と分け、「このファイルの規則はすべて現在のリポジトリについて真である」と定める ([AGENTS.md](https://github.com/modelcontextprotocol/servers/blob/HEAD/AGENTS.md))。workers-sdk は、版・規則一覧・件数を写すと古くなるので、正本の設定や文書を参照せよと書く ([AGENTS.md](https://github.com/cloudflare/workers-sdk/blob/HEAD/AGENTS.md))。

**正本は AGENTS.md で、CLAUDE.md は 1 行の取り込みにする形が多い。** sentry、supabase、tldraw、ruff、mastra、goose の CLAUDE.md は `@AGENTS.md` だけである ([sentry CLAUDE.md](https://github.com/getsentry/sentry/blob/HEAD/CLAUDE.md))。Claude Code は CLAUDE.md がなければ AGENTS.md を直接読み、両方あれば CLAUDE.md が取り込んだ場合にだけ AGENTS.md を読む ([Claude Code docs](https://code.claude.com/docs/en/memory))。スキルの置き場は、ツールに依存しない `.agents/skills/` を実体にして `.claude/skills` を symlink にする形が広い。仕事の種類はリリース、PR 作成とレビュー、issue のトリアージ、テスト作成、動作検証に集中する。サブエージェント定義は少なく、まとまった数を持つのは PostHog(11 個)と claude-code-action(レビュー用 5 個)くらいである。

**フックは狭いガードにとどまる。** コミットされているのは、編集後の整形、対話コマンドの遮断、セッション開始時のセットアップ程度で、大きなポリシーエンジンを置く例はなかった。leisen の 2 本のフックはこの水準に合っている。一方で、リポジトリが持つ設定は攻撃面でもある。Check Point は `.claude/settings.json` のフックや MCP の自動承認が、確認なしでコマンドを実行する経路になっていた問題を報告した。いずれも修正済みで、同社は設定ファイルを実行コードと同じ注意でレビューせよと勧める ([Check Point Research](https://research.checkpoint.com/2026/rce-and-api-token-exfiltration-through-claude-code-project-files-cve-2025-59536/))。秘密情報の漏えいは `.claude/settings.local.json` で起きている。Apiiro は 1,994 の公開リポジトリから 2,539 件を見つけたと報じられた。ただし件数は媒体によって食い違う ([Privacy Guides](https://www.privacyguides.org/news/2026/11/10/claude-code-leaks-secrets-and-passwords-in-public-github-repositories/))。原因は、除外設定が利用者のマシンのグローバル設定にしか書かれず、リポジトリの `.gitignore` には入らないことである。ガードレールの定義を公開したこと自体が悪用された事例は見つかっていない。

**決定記録は「現状を書く文書」と「変えないスナップショット」に分ける形が最も整理されている。** cloudflare/agents は、設計書を「今どう動くか」を書く生きた文書とし、RFC は決定後に更新せず、却下されたものも消さないと定める。手順は「提案 → 状態を accepted / rejected に更新 → 関連する設計書を更新」である ([design/AGENTS.md](https://github.com/cloudflare/agents/blob/HEAD/design/AGENTS.md))。vercel/ai は、アーキテクチャに触れる前に ADR を確認し、既存の ADR と矛盾するなら止まって人間と相談するよう AGENTS.md で指示する。ADR の起案はスキルにしてある ([AGENTS.md](https://github.com/vercel/ai/blob/HEAD/AGENTS.md))。

**計画については 3 つの立場がある。** 完了した計画を残す(OpenAI の社内事例。翻訳経由)、現状仕様に畳み込んで残りをアーカイブする(OpenSpec)、消して事実をコード・テスト・短い ADR に移す、の 3 つである。3 番目は「変更が出荷されたら大半は消えるべき」とする論考による ([The Main Thread](https://www.the-main-thread.com/p/spec-driven-development-exit-strategy))。どの立場も、完了した計画を編集し続ける対象としては扱わない。

**評価は、定義をコミットし、実行結果はコミットしないのが普通である。** gemini-cli は `evals/logs/` を、humanlayer は評価の出力先を gitignore している ([gemini-cli .gitignore](https://github.com/google-gemini/gemini-cli/blob/HEAD/.gitignore)、[humanlayer .gitignore](https://github.com/humanlayer/humanlayer/blob/HEAD/.gitignore))。日付付きの評価レポートを既定ブランチに置く例は、調べた範囲にはなかった。

**外部貢献の統治は「理解している人間が責任を持つ」に収束している。** ghostty は、メンテナ自身が AI を多用すると明記したうえで、外部の貢献者にだけ開示と理解を求める ([AI_POLICY.md](https://github.com/ghostty-org/ghostty/blob/HEAD/AI_POLICY.md))。goose と cline は issue の承認を PR の前提にし、codex は外部 PR を受け付けない ([docs/contributing.md](https://github.com/openai/codex/blob/HEAD/docs/contributing.md))。開示の方法は割れている。ASF は `Generated-by` か `Co-authored-by` を勧める ([ASF](https://www.apache.org/legal/generative-tooling.html))。Linux カーネルは 2026 年 10 月に、必須だった `Assisted-by` タグを廃止する合意に達したと報じられた。マージ済みかどうかは確認していない ([The Register](https://www.theregister.com/ai-and-ml/2026/10/14/linux-kernel-devs-drop_obligatory_confession_of_ai_tool_usage/5303140))。

## leisen の課題は量ではなく、状態の正本が 4 層に複写されていること

leisen の文書は 9,602 行で、ソースとテストの約 15% にあたる。量だけなら、PostHog の 273 スキルや cloudflare/agents の 58 設計文書と比べて突出しているわけではない。違いは中身にあり、文書の約 6 割(約 5,800 行)がプロセスと判断のログである ([棚卸し](../research_notes/エージェント開発OSSの開発環境管理/leisen_inventory.md))。

**常時読み込まれる規則ファイルが状況ログになっている。** CLAUDE.md は 58 行で、行数だけなら 200 行の目安に収まる。しかし 15,592 文字のうち「現在のフェーズ」が 10,223 文字を占め、恒久ルールは約 4,600 文字しかない。この節には、ADR-018 を Proposed とする誤り(実際は Accepted)がある。MCP SDK の版は、CLAUDE.md が 1.32.1、backlog README が 1.30.1、package.json が 1.32.2 と 3 通りある。規則ファイルの指示はよく守られるという評価結果を踏まえると、誤った状況記述はそのままエージェントの判断に入る。

**同じ事実を手で複写している。** PR #14 のマージ記述は 8 ファイルにある。backlog README が完了とする T-001 / T-002 / T-010 / T-014 のチェックボックスは未チェックのままである。サブエージェント定義は connector-sdk を v0.3、ADR の次番号を 017 と書く。PR テンプレートの不変条件 7 は、CLAUDE.md の現行の文言に追随していない。workers-sdk が避けよと書いている失敗がそのまま起きている。

**ADR が決定とログを兼ねている。** 22 本のうち 12 本に追補があり、ADR-001 には追補が 9 回、日付が 15 種ある。決定の現在形を知るには全文(合計 233,787 文字)を読む必要がある。cloudflare/agents の「RFC は決定後に更新しない」の逆をやっている。

**率直な内部メモが公開面に出ている。** 本物の秘密は見つかっていない。気になるのは次の記述が規則ファイルと利用者向け文書に散っていることである。未修正の指摘を符号で並べた記述(`minor-N` が 17 ファイル 59 か所、`H1` が 27 ファイル 63 か所)、商用配布と有償支援の論点、承認待ちの一覧、オーナーの手元の環境の記述。公開された ADR やバックログが攻撃に使われた事例は調査では見つからなかった。したがって扱いはリスクの見積もりの問題であり、実害の実証はない。

**外部の貢献者に向けた入口がない。** CONTRIBUTING / SECURITY / issue テンプレート / CODEOWNERS がなく、フックの検査は Claude Code を使わない貢献者には効かない。コミットの 64% がエージェント名義で、71% に Co-Authored-By が付いている。体制はオーナー 1 人とエージェントであり、ASF の推奨の範囲には収まっている。

**全部入りを支持する根拠もある。** OpenAI の社内プロダクトの報告は、エージェントが届かない場所の知識は存在しないのと同じだとして、計画・技術的負債・設計書をすべてリポジトリに置いたとする。ただし AGENTS.md は短い地図にとどめ、文書の鮮度・相互リンク・構造を lint と CI で検査し、定期的にエージェントが修正 PR を出す前提である。原文は取得できておらず、翻訳経由の確認である ([npaka 訳](https://note.com/npaka/n/nb4c5488e82fd?hl=en)、原文は [openai.com](https://openai.com/index/harness-engineering/))。leisen に欠けているのは、この機械的な検査と、進行中と完了済みの分離である。エージェントが GitHub の issue を読める構成であれば、「届かない」という論拠は Issues にはあてはまらない。

## 成果物ごとの判断: 規則は短く、状態は Issues へ、決定は凍結して残す

判断の基準は 1 つである。**貢献者のエージェントが正しい仕事をするのに必要なものはリポジトリに置き、コアチームの進行状況と内部の事情は外に出す。** 置き場は README がすでに示している 3 読者(導入 / 設計理解 / 開発)に合わせる。

| 成果物 | 判断 | 置き場と書き方 |
|---|---|---|
| CLAUDE.md の恒久ルール(不変条件・構成・開発ルール・進め方、約 4,600 文字) | 残す。正本を移す | `AGENTS.md` を正本にし、`CLAUDE.md` は `@AGENTS.md` の 1 行にする。版番号・ADR の追補番号・PR 番号は書かない |
| CLAUDE.md「現在のフェーズ」(10,223 文字) | 移す | 着手順と前提待ちは GitHub Issues とラベルまたは Project に移す。「人間の未決事項」は issue 化する(例: ラベル `decision-needed`)。規則ファイルには「現在の作業は Issues を見る」の 1 行だけ残す |
| パッケージ固有の契約(audit の import 境界、gateway/run、コネクタの IF) | 移す | `packages/*/AGENTS.md` に数行〜数十行で書く。ルートからは一覧で参照する |
| サブエージェント 3 本 | security-reviewer は残して更新する。他の 2 本は短くして移す | adr-keeper と connector-implementer は手順なのでスキルにする(実体は `.agents/skills/`、`.claude/skills` は symlink)。古い番号と版は消す |
| フック 2 本と scripts/guard | 残す。CI にも載せる | 同じ grep 検査を `npm run` のスクリプトにして CI の build-test で走らせる。`.claude/`、`scripts/guard/`、`.github/workflows/` は CODEOWNERS で人間のレビューを必須にする |
| ローカルのエージェント状態 | 捨てる(追跡しない) | リポジトリの `.gitignore` に `.claude/settings.local.json` と `CLAUDE.local.md` を明記する |
| ADR 22 本 | 残す。追補をやめる | 決定後は Status 以外を書き換えない。変更は新しい ADR で行い、旧 ADR に Superseded / Amended by を付ける。`docs/adr/README.md` に「主題 → 現行の ADR → 現在の決定の 1 行要約」の索引を置く。Status 行は状態と日付だけにする。「実装の記録・検証結果」は今後 PR の説明に書く |
| 設計書 v1 / v2 / v3(538 行) | 短くする(統合) | 現状を書く 1 本の設計書にまとめる。差分形式の v2 / v3 は Git 履歴に任せる。規則ファイルの必読指定は「プロダクト原則」の 1 か所にする |
| backlog 29 タスク | 未着手は移す。完了は凍結する | 未着手・進行中は issue にする。issue テンプレートに「前提(人手)/ 内容 / 受け入れ条件」を持たせる。完了分は履歴用のディレクトリに移して読み取り専用と明記する。コード中の T 番号参照 216 か所が切れないよう、削除はしない。新しいコードコメントには T 番号と PR 番号を書かない |
| README 冒頭の進捗段落、backlog README の進捗段落 | 捨てる | タグと GitHub Releases(または CHANGELOG)を進捗の公開記録にする |
| 評価(docs/eval 2 本) | 定義は残す。結果は移す | 質問セットと手順は orchestrator パッケージ側に置く。日付付きの結果は該当の PR か issue に貼る。手元の環境名とモデル名は結果側にだけ書く |
| 検討メモ HTML 4 本(2,396 行) | 移すか捨てる | 決定ではない分析なので公開ツリーから外す。棚卸しでは全文を精読していないので、外す前に固有名の有無を確認する |
| スパイク(文書 307 行、コード 1,027 行) | 当面残し、決定後に捨てる | SDK v2 への移行時期が未決の間は残す。決定したら結論を ADR に移して削除する |
| 公開チェックリスト | 移す | 作者アドレスに触れる記述があるので、ツリーから外して非公開の置き場に移す |
| 脅威モデル、auth-matrix、導入・運用ガイド | 残す | 利用者向けと設計理解向けにディレクトリを分ける。「受容した残余リスク」は導入者に必要なので残す |
| 未修正の指摘の符号(minor-N、H1) | 短くする(言い換える) | 利用者向け文書では、症状と緩和策を平文で書く(例: リクエスト期限がないのでリバースプロキシで制限する)。符号つきの残件一覧は非公開の置き場で持つ |
| 商用配布・有償支援の論点 | 移す | 技術的な決定(Slack の導入形態は類型 (a))だけを ADR に残す。事業上の論点は issue #59 か非公開の置き場に寄せる |
| PR テンプレートの不変条件チェック | 短くする | 文言を複写せず、AGENTS.md の不変条件を番号で参照する |
| OSS の定番ファイル | 新設する | SECURITY.md、CONTRIBUTING.md、AI 利用の方針、issue テンプレート、CODEOWNERS |

移行は、判断が要らないものから順に行う。1 項目を 1 PR にする。

| 優先 | 手順 | 前提となる決定 | 根拠 |
|---|---|---|---|
| 1 | CLAUDE.md の事実誤り(ADR-018 の Status、SDK の版)、サブエージェントの古い番号、PR テンプレートの不変条件 7 を直す。`.gitignore` にローカルのエージェント状態を足す | なし | 誤った規則がエージェントの判断に入る。秘密情報の漏えい経路をふさぐ |
| 2 | SECURITY.md と CODEOWNERS を置く | 脆弱性報告窓口(論点 3) | 公開リポジトリの最低線。設定ファイルは実行コードと同じ扱いにする |
| 3 | 未決事項と未着手タスクを issue にし、CLAUDE.md から「現在のフェーズ」を削る。AGENTS.md を正本にする | 状態の正本(論点 1) | 最大の効果が出る。毎セッションの読み込みが約 3 分の 1 になる |
| 4 | 完了済み backlog を凍結し、README 類の進捗段落を消し、最初のタグを打つ | 論点 1 | 複写の発生源をなくす |
| 5 | ADR の索引を作り、追補をやめる運用を ADR として書く。設計書 3 本を 1 本に統合する | ADR の運用(論点 4) | 現在の決定を全文を読まずに引ける |
| 6 | 検討メモ・公開チェックリスト・評価結果・符号つきの残件を公開ツリーから外す | 非公開の置き場(論点 2) | 公開面の整理。履歴の書き換えはしない |
| 7 | 文書の検査を CI に足す。AGENTS.md の文字数上限と日付・PR 番号の禁止、ADR の索引の網羅、リンク切れ、guard の grep 検査 | なし | 再発防止。OpenAI の事例が示す前提条件 |
| 8 | CONTRIBUTING.md と AI 利用の方針を置く。手順をスキルにし、パッケージ別の AGENTS.md を足す | 外部貢献の受け方(論点 5) | 外部の貢献者とそのエージェントの入口 |

手順 6 で履歴を書き換えないのは、公開後の書き換えが既存の clone や fork からは何も消さないためである。この一般論は検索結果の要約に基づくもので、元のページは開いていない(snippet・未検証)。リポジトリが現在公開されているかどうかは、棚卸しでは確認できていない。まだ非公開であれば、履歴に含まれる作者アドレスの扱いを公開前に決める機会が 1 度だけある。CI からエージェントを起動するトリアージや重複検出は、ベンダー各社が自社リポジトリで行っているが、leisen では外部からの issue が増えるまで見送る。公開 issue の文面を読むエージェントにはプロンプトインジェクションの報告があるためである(snippet・未検証。[Aikido](https://aikido.dev/blog/promptpwnd-github-actions-ai-agents))。

オーナーが決めるべき論点は次の 8 つである。

| # | 論点 | 選択肢 | 推奨 |
|---|---|---|---|
| 1 | タスクと未決事項の正本 | GitHub Issues / リポジトリ内の 1 ファイルに一本化 / 現状維持 | Issues。エージェントが issue を読める構成が条件。満たせないなら 1 ファイルに一本化し、他の文書からは参照だけにする |
| 2 | 非公開の置き場を持つか | 持たない / 非公開の companion リポジトリ / ローカルのみ | 符号つきのセキュリティ残件と事業上の論点に限って、小さな非公開リポジトリを持つ。クラウドセッションでは 2 つ目のリポジトリとして付ける必要がある(推論) |
| 3 | 脆弱性報告窓口と未修正の指摘の公開範囲 | GitHub の Private Vulnerability Reporting / メール / 保留を続ける | Private Vulnerability Reporting。curl は報奨金の廃止後にこれへ移った(二次資料経由。[curl](https://daniel.haxx.se/blog/2026/01/26/the-end-of-the-curl-bug-bounty/)) |
| 4 | ADR の運用 | 追補を続ける / 新しい ADR で置き換える / 既存 ADR も書き直す | 新しい ADR で置き換える。既存の 22 本は書き直さず、索引と 1 行要約で現在形を示す |
| 5 | 外部貢献の受け方 | 受け付けない(codex)/ issue の承認を前提にする(goose、cline)/ 自由 | issue の承認を前提にする。ADR の起案は誰でもでき、Accepted にするのはオーナーだけ、と明記する |
| 6 | AI 利用の開示 | Co-Authored-By を続ける / やめる / 外部の貢献者にだけ求める | 続ける。ghostty の形で、メンテナの利用を明記し、外部には理解と開示を求める。コミットに付くセッション URL の行は第三者が開けないので、残すかどうかを別に決める |
| 7 | 規則ファイルと文書の言語 | 日本語のみ / AGENTS.md と README だけ英語を併記 | 調査に根拠となる資料がない。導入先の想定で決める |
| 8 | 完了した計画・評価結果の残し方 | 凍結して残す / PR と issue にだけ残す / 削除 | backlog は凍結(コードからの参照があるため)。新しい計画と評価結果は PR と issue にだけ残す |

## Conclusion

調査で分かったのは、エージェント開発の先端にいるプロジェクトほど、リポジトリに置く文書を「いつ読んでも真であるもの」に絞っているということである。規則、手順、決定、現状の設計がそれにあたる。「ある時点で真だったもの」(進捗、計画、評価結果、レビュー指摘)は、日付と状態が自動で付く場所、つまり issue、PR、コミット、リリースに任せている。leisen の全部入りは、エージェントに文脈を渡すという目的では正しかった。ただしそれは、オーナー 1 人とエージェントという閉じた体制で、全文書を毎 PR 更新できる間だけ成り立つ設計である。食い違いがすでに出ていることから、その限界は越えている。

leisen は認可と監査を売りにするプロダクトなので、ADR と脅威モデルを公開していること自体は、導入を評価する側にとって価値がある。捨てるべきなのは決定の記録ではなく、決定の記録に混ざった作業ログである。今回の調査では確かめられなかった点が 2 つある。完了済みの計画を残すことがエージェントの成績を上げるか下げるかを測ったデータは見つかっていない。エージェントで開発したプロジェクトが公開時にプロセス文書をどう再編したかの事例も見つかっていない。leisen の移行は、その最初の記録の 1 つになりうる。
