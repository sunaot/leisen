# 公開リポジトリには AGENTS.md・スキル・ADR・設計書だけを残す

エージェントによる開発を積極的に行う OSS の多くは、公開リポジトリに置くものを「短い AGENTS.md(または CLAUDE.md)」「手順を定義したスキル」「ADR / RFC と現行の設計書」に絞り、進行中のタスク・計画・評価結果は GitHub Issues や非公開の保管先で管理している。調査した約 50 のリポジトリのうち、タスクを 1 件 1 ファイルで管理するバックログをデフォルトブランチに常時置いている例は 1 つも見つからなかった。36,710 リポジトリを調べた研究でも、コミットされた計画ファイルは 10 リポジトリの 85 個にとどまる ([ESEM 2026](https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.ESEM.2026.54))。backlog・ADR・設計書・`.claude` をすべてリポジトリに置く leisen の構成は、この傾向から外れている。ただし、問題は文書の量ではなく、進捗や決定の状態について正本(唯一の信頼できる情報源)が決まっていないことにある。CLAUDE.md の本文の約 69% が日付付きの進捗記録で、同じ進捗が少なくとも 4 種類の文書に手作業で転記されており、ADR-018 の Status や SDK のバージョンですでに記述の不一致が生じている ([棚卸し](../research_notes/エージェント開発OSSの開発環境管理/leisen_inventory.md))。提案は次の 3 点である。(1) CLAUDE.md を恒久的なルールだけの約 5,000 文字に戻し、その内容を AGENTS.md に移して正本にする。(2) タスクと未決事項の正本を GitHub Issues に移し、完了済みの backlog は変更しない履歴として残す。(3) ADR は残すが、追補を重ねる運用をやめ、「決定後は書き換えない ADR」と「現在の状態を記述する設計書」に分ける。非公開の内部リポジトリを正本とし、公開リポジトリをそのミラーにする二重管理は、数人以下のチームではコストに見合わないので採用しない。なお、すべてをリポジトリに置く構成を支持する根拠もある(OpenAI の社内事例)。ただし、その根拠は日本語訳でしか確認できておらず、公開 OSS での実例でもない。

## 用語

本レポートでは次の用語を以下の意味で使う。

| 用語 | 意味 |
|---|---|
| ハーネス | エージェントを動作させるための設定一式。AGENTS.md / CLAUDE.md、スキル、サブエージェント定義、フック、`.claude/settings.json` などのツール設定を含む |
| 現行の設計書 | システムが現在どう動作するかを記述し、変更のたびに更新する文書。leisen では `docs/product-design*.md` が該当する |
| 正本 | 同じ情報が複数の場所にあるとき、内容が食い違った場合に正しいとみなす唯一の場所 |
| 追補 | leisen の ADR で、既存の ADR の末尾に日付付きで追記している変更・検証結果の記述 |

## 現在のプラクティスは 6 つの類型に分かれ、主流は「AGENTS.md とスキルをリポジトリに置く型」である

調査対象は、コーディングエージェントを開発しているベンダー自身のリポジトリ 17 と、エージェントを多用して開発されているプロダクトのリポジトリ約 35 である。いずれも 2026-11-15 時点のデフォルトブランチを clone して確認した。以下の A〜F は本レポートで定義した分類である。類型は互いに排他的ではなく、B に C を組み合わせ、個人の作業中の資料だけを E の方法で分ける構成が最も多い。

| 類型 | リポジトリに置くもの | 採用例 | 利点 | コスト | 評価 |
|---|---|---|---|---|---|
| A. 最小構成 | 数行〜数十行の AGENTS.md のみ、または何も置かない | simonw/llm(24 行)、datasette(5 行)、antirez の各リポジトリ(なし)、minijinja(プロンプト 2 本)、workers-oauth-provider(AGENTS.md 295 行のみ) | 陳腐化する文書がない。公開される記録はコミット履歴とテストである | 手順に関する知識が個人に属人化する。ルールをテストや lint で表現できるだけの成熟が必要になる | 単独メンテナの小規模なライブラリに向く。不変条件が 9 つある leisen には不足する |
| B. AGENTS.md とスキルを置く型(主流) | 短いルートの AGENTS.md、ディレクトリ別の AGENTS.md、スキル、少数のフック。タスクは Issues / Projects で管理する | opencode、gemini-cli、goose、next.js、sentry、PostHog、zed、OpenHands、modelcontextprotocol/servers | 外部のコントリビューターが使うエージェントも同じルールで動作する。毎セッション読み込まれる分量が小さい | スキルの保守。複数のツールに対応するためのシンボリックリンクの管理 | 公開 OSS の事実上の標準である。leisen はこの型を基本にすべきである |
| C. ADR / RFC と設計書も置く型 | B に加えて、ADR / RFC と現行の設計書 | cloudflare/agents(design/ 58 ファイル、RFC 27 本)、vercel/ai(2026-03 に ADR を採用)、beads(engdocs/adr)、opencode(specs/v2)、MCP 仕様(seps/ 48 本) | 決定の理由を再調査せずに済む。却下済みの案が再び議論されることを防げる | 索引と Status を維持しなければ参照されなくなる | 認可と監査が価値の中心である leisen には必須である。ただし現在の書き方は改める必要がある |
| D. 変更単位の計画・仕様も置く型 | 変更ごとの提案・計画・タスク、またはファイル形式のバックログ | sentry-mcp(OpenSpec と日付付きの計画)、spec-kit、OpenSpec、Backlog.md、OpenAI の社内プロダクト(exec-plans/active・completed。日本語訳で確認) | エージェントがネットワークなしで参照できる。計画をレビューできる | コードとは別に保守対象が増え、更新が追いつかず陳腐化する。複数のエージェントが並行して書き込むと競合する | 完了後の扱い(変更せず残す・アーカイブする・削除する)を決めた場合にだけ成立する。常時置く運用は少数派である |
| E. 非公開の保管先に分ける型 | AGENTS.md とスキルは公開し、調査・計画・タスクのメモは別リポジトリかローカルに置く | humanlayer(`/thoughts/` を gitignore し、別リポジトリで管理)、beads(メンテナ用のタスク管理データは非公開、公開のタスク管理は Issues)、Ronacher(個人用のハーネスを別リポジトリ agent-stuff で管理)、sentry(スキルを agents.toml で外部リポジトリから取得) | 率直な内容のメモを公開せずにバージョン管理できる | 各マシンでシンボリックリンクとフックの設定が必要になる。クラウドセッションでは別リポジトリとして追加する必要がある(推論) | 公開に適さない少量の資料に限って使うのが現実的である |
| F. 内部リポジトリを正本とし、公開ミラーを持つ型 | 公開リポジトリは内部リポジトリから生成される。ハーネスの本体は内部にある | openai/codex(全コミットのコミッターが copyberry、2026-09-30 にルートの AGENTS.md と .codex/ を削除)、anthropics/claude-code(製品のソースコードなし)、E2B(仕様を Copybara で同期) | 内部資料が公開されないことを最も確実に保証できる | 外部からの PR を取り込む処理が不安定になりやすい(検索結果の要約のみで、元のページは未確認)。同期の仕組みを継続的に保守する必要がある | 大手ベンダー向けの型である。数人のチームではコストに見合わない |

A・B・C は、clone したリポジトリのファイル構成を直接確認した結果に基づく。opencode は方針を一文で明記している。「GitHub issues own active work; Git history preserves removed plans and scratchpads.」([specs/v2/README.md](https://github.com/anomalyco/opencode/blob/HEAD/specs/v2/README.md))。goose は issue をタスクの正本とし、公開の Projects ボードでステータスが Ready になるまでエージェントに実装させない ([AGENTS.md](https://github.com/aaif-goose/goose/blob/HEAD/AGENTS.md))。gemini-cli、Roo-Code、pi-mono は計画用のディレクトリやファイル(`conductor/`、`plans/`、`todo.md`)を gitignore している ([gemini-cli .gitignore](https://github.com/google-gemini/gemini-cli/blob/HEAD/.gitignore)、[pi-mono .gitignore](https://github.com/earendil-works/pi-mono/blob/HEAD/.gitignore))。OpenHands は設計内容を PR の本文に書き、一時的な成果物を置く `.pr/` はリリース時に削除すると定めている ([software-agent-sdk AGENTS.md](https://github.com/OpenHands/software-agent-sdk/blob/HEAD/AGENTS.md))。

**D を常時運用して失敗した実例が beads である。** beads はリポジトリ内に issue をファイルとして置く方式を広めたプロジェクトだが、現在は自身の `.beads/` を gitignore し、「GitHub Issues is the public tracker」と明記している ([beads AGENTS.md](https://github.com/steveyegge/beads/blob/HEAD/AGENTS.md))。理由は、多数のエージェントが互いの書き込みを上書きし、復旧できなくなったためだと説明されている。ただし、この説明は Dolt の開発元の記事によるもので、作者本人の記述は確認していない ([DoltHub](https://www.dolthub.com/blog/2026-03-13-multi-agent-persistence/))。

F の codex では、直近 500 コミットのすべてでコミッターが `copyberry` であり、`GitOrigin-RevId` トレーラーが付いている。ルートの AGENTS.md と `.codex/skills/` を削除した PR には理由が書かれていない ([PR #49713](https://github.com/openai/codex/pull/49713))。「ハーネスは非公開にすべきである」と明文化した方針は、どのリポジトリにも見つからなかった。ハーネスはコミットするのが標準である。

## AGENTS.md は短くし、手順はスキルに、決定は書き換えない ADR にする

成果物の種類ごとの扱いは、類型が違ってもほぼ共通している。

**AGENTS.md の内容は「コードからは読み取れないこと」に絞られている。** ベンダー各社のリポジトリのルートにある AGENTS.md(gemini-cli は GEMINI.md、zed は `.rules`)は 5〜240 行で、内容はコマンド、依存の方向、禁止事項である。Anthropic のドキュメントは CLAUDE.md を 1 ファイル 200 行未満にすることを目安とし、CLAUDE.md は「context, not enforced configuration」であるため、確実に禁止したい操作には PreToolUse フックを使うよう求めている ([Claude Code docs](https://code.claude.com/docs/en/memory))。ETH Zurich などによる評価研究は、AGENTS.md などのコンテキストファイルは一般にタスクの成功率を向上させず、推論コストを平均 20% 以上増加させ、リポジトリの概要説明は効果がないと結論している(確認したのは要旨のみ。[arXiv:2602.11988](https://arxiv.org/abs/2602.11988))。各プロジェクトのルールも同じ方向である。modelcontextprotocol/servers は「ルールは AGENTS.md に、手順は必要なときに読み込むスキルに」と分け、「このファイルのルールはすべて、現在のリポジトリについて正しい」と定めている ([AGENTS.md](https://github.com/modelcontextprotocol/servers/blob/HEAD/AGENTS.md))。workers-sdk は、バージョン・ルールの一覧・件数を転記すると古くなるので、正本である設定ファイルやドキュメントを参照するよう指示している ([AGENTS.md](https://github.com/cloudflare/workers-sdk/blob/HEAD/AGENTS.md))。

**AGENTS.md を正本とし、CLAUDE.md にはインポートの 1 行だけを書く構成が多い。** sentry、supabase、tldraw、ruff、mastra、goose の CLAUDE.md は `@AGENTS.md` の 1 行だけである ([sentry CLAUDE.md](https://github.com/getsentry/sentry/blob/HEAD/CLAUDE.md))。Claude Code は、CLAUDE.md がなければ AGENTS.md を直接読み込み、両方ある場合は CLAUDE.md がインポートしたときにだけ AGENTS.md を読み込む ([Claude Code docs](https://code.claude.com/docs/en/memory))。スキルは、特定のツールに依存しない `.agents/skills/` に実体を置き、`.claude/skills` をシンボリックリンクにする構成が広く使われている。スキルの対象は、リリース、PR の作成とレビュー、issue のトリアージ、テストの作成、動作検証に集中している。サブエージェント定義をコミットしている例は少なく、まとまった数を持つのは PostHog(11 個)と claude-code-action(レビュー用 5 個)程度である。

**フックは用途を限定した検査にとどまる。** コミットされているフックは、編集後のフォーマット、対話型コマンドのブロック、セッション開始時のセットアップ程度で、大規模なポリシーエンジンを置いている例はなかった。leisen の 2 本のフックはこの水準に合っている。一方で、リポジトリにコミットされた `.claude/settings.json` や `.mcp.json` は攻撃対象にもなる。Check Point は、`.claude/settings.json` のフックや MCP サーバーの自動承認が、ユーザーの確認なしにコマンドを実行する経路になっていた脆弱性を報告した。いずれも修正済みで、同社は設定ファイルを実行コードと同じ水準でレビューするよう推奨している ([Check Point Research](https://research.checkpoint.com/2026/rce-and-api-token-exfiltration-through-claude-code-project-files-cve-2025-59536/))。秘密情報の漏えいは `.claude/settings.local.json` で発生している。Apiiro は 1,994 の公開リポジトリから 2,539 件の秘密情報を発見したと報じられた。ただし、件数は媒体によって異なる ([Privacy Guides](https://www.privacyguides.org/news/2026/11/10/claude-code-leaks-secrets-and-passwords-in-public-github-repositories/))。原因は、このファイルの除外設定が利用者のマシンのグローバルな git 設定にしか書かれず、リポジトリの `.gitignore` には含まれないことである。ガードレール(フックや `scripts/guard/` の検査スクリプト)の定義を公開したこと自体が悪用につながった事例は見つかっていない。

**設計に関する文書は、現在の状態を記述する設計書と、決定時点の内容を保持する ADR / RFC に分ける構成が最も整理されている。** cloudflare/agents は、設計書を「現在どう動作するか」を記述して随時更新する文書と位置づけ、RFC は決定後に更新せず、却下されたものも削除しないと定めている。手順は「提案する → Status を accepted / rejected に更新する → 関連する設計書を更新する」である ([design/AGENTS.md](https://github.com/cloudflare/agents/blob/HEAD/design/AGENTS.md))。vercel/ai は、アーキテクチャに関わる変更の前に ADR を確認し、既存の ADR と矛盾する場合は作業を止めて人間に相談するよう AGENTS.md で指示している。ADR の起案手順はスキルとして定義されている ([AGENTS.md](https://github.com/vercel/ai/blob/HEAD/AGENTS.md))。

**完了した計画の扱いには 3 つの考え方がある。** そのまま残す(OpenAI の社内事例。日本語訳で確認)、内容を現行仕様に反映したうえで残りをアーカイブする(OpenSpec)、削除して、残すべき事実だけをコード・テスト・短い ADR に移す、の 3 つである。3 番目は「変更がリリースされたら、仕様の大半は削除すべきである」とする記事に基づく ([The Main Thread](https://www.the-main-thread.com/p/spec-driven-development-exit-strategy))。いずれの考え方でも、完了した計画を継続的に更新する対象とはしていない。

**評価は、定義をコミットし、実行結果はコミットしないのが一般的である。** gemini-cli は `evals/logs/` を、humanlayer は評価結果の出力先を gitignore している ([gemini-cli .gitignore](https://github.com/google-gemini/gemini-cli/blob/HEAD/.gitignore)、[humanlayer .gitignore](https://github.com/humanlayer/humanlayer/blob/HEAD/.gitignore))。日付付きの評価レポートをデフォルトブランチに置いている例は、調査した範囲にはなかった。

**外部からのコントリビューションに関するガバナンスは、「内容を理解している人間が責任を負う」という点で共通している。** ghostty は、メンテナ自身が AI を多用していると明記したうえで、外部のコントリビューターにだけ AI 利用の開示と内容の理解を求めている ([AI_POLICY.md](https://github.com/ghostty-org/ghostty/blob/HEAD/AI_POLICY.md))。goose と cline は issue の承認を PR の前提条件とし、codex は外部からの PR を受け付けていない ([docs/contributing.md](https://github.com/openai/codex/blob/HEAD/docs/contributing.md))。開示の方法はプロジェクトによって異なる。ASF は `Generated-by` または `Co-authored-by` トレーラーを推奨している ([ASF](https://www.apache.org/legal/generative-tooling.html))。Linux カーネルは 2026 年 10 月に、必須としていた `Assisted-by` タグを廃止することで合意したと報じられた。マージ済みかどうかは確認していない ([The Register](https://www.theregister.com/ai-and-ml/2026/10/14/linux-kernel-devs-drop_obligatory_confession_of_ai_tool_usage/5303140))。

## leisen の課題は文書の量ではなく、状態の正本が決まっていないことにある

leisen の文書は 9,602 行で、ソースコードとテストコードの合計の約 15% にあたる。量だけを見れば、PostHog の 273 個のスキルや cloudflare/agents の 58 本の設計文書と比べて特に多いわけではない。違いは内容にあり、文書の約 6 割(約 5,800 行)が開発の経過と判断の記録である ([棚卸し](../research_notes/エージェント開発OSSの開発環境管理/leisen_inventory.md))。

**毎セッション読み込まれる CLAUDE.md が、進捗記録になっている。** CLAUDE.md は 58 行で、行数だけなら 200 行の目安に収まる。しかし、15,592 文字のうち「現在のフェーズ」の節が 10,223 文字を占め、恒久的なルールは約 4,600 文字しかない。この節には、ADR-018 を Proposed とする誤りがある(実際は Accepted)。MCP SDK のバージョンは、CLAUDE.md では 1.32.1、backlog README では 1.30.1、package.json では 1.32.2 と 3 通りの記述がある。AGENTS.md や CLAUDE.md に書かれた指示はエージェントによく守られるという評価結果を踏まえると、誤った状況の記述はそのままエージェントの判断に影響する。

**同じ事実を手作業で複数の文書に転記している。** PR #14 がマージされたという記述は 8 ファイルにある。backlog README が完了としている T-001 / T-002 / T-010 / T-014 は、各タスクのチェックボックスが未チェックのままである。サブエージェント定義には、connector-sdk が v0.3、ADR の次の番号が 017 と書かれている。PR テンプレートの不変条件 7 は、CLAUDE.md の現在の文言に更新されていない。workers-sdk が避けるよう指示している問題が、そのまま発生している。

**ADR が、決定の記録と経過の記録を兼ねている。** 22 本のうち 12 本に追補があり、ADR-001 には追補が 9 回、日付が 15 種類ある。現在有効な決定内容を知るには、全文(合計 233,787 文字)を読む必要がある。cloudflare/agents の「RFC は決定後に更新しない」とは逆の運用である。

**内部向けの率直な記述が、公開される文書に含まれている。** 実際の秘密情報は見つかっていない。懸念されるのは、次の記述が CLAUDE.md と利用者向け文書(`docs/install.md` など)に分散していることである。T-003 レビューなどで未修正のまま残っている指摘を、`minor-6` や `H1` といった識別子で列挙した記述(`minor-N` が 17 ファイル 59 か所、`H1` が 27 ファイル 63 か所)、商用配布と有償支援に関する論点、承認待ちの項目の一覧、オーナー個人の開発環境に関する記述。公開された ADR やバックログが攻撃に利用された事例は、調査では見つからなかった。したがって、これらの扱いはリスク評価の問題であり、実害が確認されているわけではない。

**外部のコントリビューターを受け入れるための文書がない。** CONTRIBUTING / SECURITY / issue テンプレート / CODEOWNERS がなく、フックによる検査は Claude Code を使わないコントリビューターには適用されない。コミットの 64% はエージェントが作者として記録されており、71% に Co-Authored-By トレーラーが付いている。開発体制はオーナー 1 人とエージェントであり、ASF の推奨の範囲には収まっている。

**すべてをリポジトリに置く構成を支持する根拠もある。** OpenAI の社内プロダクトに関する報告は、エージェントが参照できない場所にある知識は存在しないのと同じであるとして、計画・技術的負債・設計書をすべてリポジトリに置いたとしている。ただし、AGENTS.md は目次の役割にとどめて短くし、文書の鮮度・相互リンク・構造を lint と CI で検査し、定期的にエージェントが修正の PR を出すことを前提としている。原文は取得できておらず、日本語訳で確認した ([npaka 訳](https://note.com/npaka/n/nb4c5488e82fd?hl=en)、原文は [openai.com](https://openai.com/index/harness-engineering/))。leisen に不足しているのは、この自動検査と、進行中の文書と完了済みの文書の分離である。また、エージェントが GitHub の issue を読める構成であれば、「エージェントが参照できない」という論拠は Issues にはあてはまらない。

## 成果物ごとの判断: AGENTS.md は短くし、状態は Issues に移し、ADR は書き換えずに残す

判断基準は 1 つである。**コントリビューターのエージェントが正しく作業するために必要なものはリポジトリに置き、コアチームの進捗と内部の事情はリポジトリの外で管理する。** 文書の配置は、README がすでに示している 3 種類の読者(導入する人 / 設計を理解したい人 / 開発する人)に合わせる。

| 成果物 | 判断 | 保管先と書き方 |
|---|---|---|
| CLAUDE.md の恒久的なルール(不変条件・構成・開発ルール・タスクの進め方、約 4,600 文字) | 残す。正本を変更する | `AGENTS.md` を正本とし、`CLAUDE.md` は `@AGENTS.md` の 1 行にする。バージョン番号・ADR の追補番号・PR 番号は書かない |
| CLAUDE.md の「現在のフェーズ」(10,223 文字) | 移す | 着手の順序と、人手による前提条件を待っているタスクは、GitHub Issues とラベルまたは Projects に移す。「人間の未決事項」は issue にする(例: ラベル `decision-needed`)。AGENTS.md には「現在の作業は Issues を参照する」という 1 行だけを残す |
| パッケージ固有の制約(audit の import 境界、gateway/run、コネクタの IF) | 移す | `packages/*/AGENTS.md` に数行〜数十行で書く。ルートの AGENTS.md からは一覧で参照する |
| サブエージェント 3 本 | security-reviewer は残して更新する。他の 2 本は短くして移す | adr-keeper と connector-implementer は内容が手順なので、スキルにする(実体は `.agents/skills/` に置き、`.claude/skills` はシンボリックリンクにする)。古い番号とバージョンの記述は削除する |
| フック 2 本と scripts/guard | 残す。CI でも実行する | 同じ grep による検査を `npm run` のスクリプトにして、CI の build-test で実行する。`.claude/`、`scripts/guard/`、`.github/workflows/` は CODEOWNERS で人間のレビューを必須にする |
| `.claude/settings.local.json` と `CLAUDE.local.md` | Git で管理しない | リポジトリの `.gitignore` に明記する |
| ADR 22 本 | 残す。追補をやめる | 決定後は Status 以外を書き換えない。変更は新しい ADR で行い、元の ADR には Superseded / Amended by を記載する。`docs/adr/README.md` に「主題 → 現在有効な ADR → 現在の決定の 1 行要約」の索引を置く。Status 行には状態と日付だけを書く。実装の記録と検証結果は、今後は PR の説明に書く |
| 設計書 v1 / v2 / v3(538 行) | 短くする(統合する) | 現在の状態を記述する 1 本の設計書にまとめる。差分形式の v2 / v3 の経緯は Git の履歴で参照する。AGENTS.md で必ず読むよう指定する箇所は「プロダクト原則」の 1 か所にする |
| backlog 29 タスク | 未着手のものは移す。完了したものは変更せずに残す | 未着手・進行中のタスクは issue にする。issue テンプレートに「前提(人手)/ 内容 / 受け入れ条件」の項目を設ける。完了したタスクは履歴用のディレクトリに移し、読み取り専用であることを明記する。コード中に T 番号への参照が 216 か所あるため、削除はしない。新しく書くコードコメントには T 番号と PR 番号を書かない |
| README 冒頭の進捗の段落、backlog README の進捗の段落 | 削除する | タグと GitHub Releases(または CHANGELOG)を、進捗の公開記録とする |
| 評価(docs/eval 2 本) | 定義は残す。結果は移す | 質問セットと実行手順は orchestrator パッケージに置く。日付付きの結果は、該当する PR か issue に記載する。実行環境の名前とモデル名は結果の側にだけ書く |
| 検討メモ HTML 4 本(2,396 行) | 移すか削除する | 決定ではなく分析の資料なので、公開リポジトリから外す。棚卸しでは全文を確認していないので、外す前に固有名詞が含まれていないかを確認する |
| スパイク(文書 307 行、コード 1,027 行) | 当面は残し、決定後に削除する | SDK v2 への移行時期が未決の間は残す。決定したら、結論を ADR に記載して削除する |
| 公開チェックリスト | 移す | コミットの作者のメールアドレスに関する記述があるので、公開リポジトリから外して非公開の保管先に移す |
| 脅威モデル、auth-matrix、導入・運用ガイド | 残す | 利用者向けと設計を理解したい人向けに、ディレクトリを分ける。「受容した残余リスク」は導入する側に必要な情報なので残す |
| 未修正のレビュー指摘の識別子(`minor-N`、`H1`) | 短くする(書き換える) | 利用者向け文書では、識別子ではなく、事象と緩和策を文章で書く(例: リクエストに期限がないため、リバースプロキシで制限する)。`minor-N`・`H1` で識別している未修正の指摘の一覧は、非公開の保管先で管理する |
| 商用配布・有償支援に関する論点 | 移す | 技術的な決定(Slack の導入形態は類型 (a))だけを ADR に残す。事業上の論点は issue #59 か非公開の保管先にまとめる |
| PR テンプレートの不変条件チェック | 短くする | 文言を転記せず、AGENTS.md の不変条件を番号で参照する |
| SECURITY.md、CONTRIBUTING.md などのコミュニティヘルスファイル | 新しく作成する | SECURITY.md、CONTRIBUTING.md、AI_POLICY.md(AI 利用に関する方針)、issue テンプレート、CODEOWNERS |

移行は、オーナーの判断を必要としないものから順に進める。1 つの手順を 1 つの PR にする。

| 優先順位 | 手順 | 前提となる決定 | 根拠 |
|---|---|---|---|
| 1 | CLAUDE.md の事実の誤り(ADR-018 の Status、SDK のバージョン)、サブエージェント定義の古い番号、PR テンプレートの不変条件 7 を修正する。`.gitignore` に `.claude/settings.local.json` と `CLAUDE.local.md` を追加する | なし | 誤ったルールがエージェントの判断に影響する。秘密情報が漏えいする経路を塞ぐ |
| 2 | SECURITY.md と CODEOWNERS を置く | 脆弱性の報告窓口(論点 3) | 公開リポジトリの最低限の要件である。`.claude/` 配下の設定とフックは実行コードと同じ扱いにする |
| 3 | 未決事項と未着手のタスクを issue にし、CLAUDE.md から「現在のフェーズ」を削除する。AGENTS.md を正本にする | 状態の正本(論点 1) | 最も効果が大きい。毎セッション読み込まれる分量が約 3 分の 1 になる |
| 4 | 完了済みの backlog を読み取り専用の履歴にし、README などの進捗の段落を削除し、最初のタグを付ける | 論点 1 | 重複した記載が生じる原因をなくす |
| 5 | ADR の索引を作成し、追補をやめる運用を ADR として記録する。設計書 3 本を 1 本に統合する | ADR の運用(論点 4) | 現在有効な決定を、全文を読まずに確認できる |
| 6 | 検討メモ(`docs/notes/`)・公開チェックリスト・評価結果・未修正の指摘(`minor-N`、`H1`)の一覧を公開リポジトリから外す | 非公開の保管先(論点 2) | 公開される文書を整理する。履歴の書き換えは行わない |
| 7 | 文書の検査を CI に追加する。AGENTS.md の文字数の上限と日付・PR 番号の禁止、ADR の索引の網羅性、リンク切れ、guard の grep による検査 | なし | 再発を防止する。OpenAI の事例が前提としている条件である |
| 8 | CONTRIBUTING.md と AI_POLICY.md を置く。手順をスキルにし、パッケージ別の AGENTS.md を追加する | 外部からのコントリビューションの受け入れ方針(論点 5) | 外部のコントリビューターとそのエージェントが参加するために必要である |

手順 6 で履歴を書き換えないのは、公開後に履歴を書き換えても、既存の clone や fork からは何も削除されないためである。この説明は検索結果の要約に基づくもので、元のページは確認していない。リポジトリが現在公開されているかどうかは、棚卸しでは確認できていない。まだ非公開であれば、履歴に含まれる作者のメールアドレスの扱いを、公開前に 1 度だけ決めることができる。CI からエージェントを起動して行う issue のトリアージや重複検出は、ベンダー各社が自社のリポジトリで実施しているが、leisen では外部からの issue が増えるまで導入を見送る。公開された issue の本文を読むエージェントに対して、プロンプトインジェクションが報告されているためである(検索結果の要約のみで、元のページは未確認。[Aikido](https://aikido.dev/blog/promptpwnd-github-actions-ai-agents))。

オーナーが決定すべき論点は次の 8 つである。

| # | 論点 | 選択肢 | 推奨 |
|---|---|---|---|
| 1 | タスクと未決事項の正本 | GitHub Issues / リポジトリ内の 1 ファイルに集約する / 現状を維持する | Issues。エージェントが issue を読める構成であることが条件である。満たせない場合は 1 ファイルに集約し、他の文書からは参照だけにする |
| 2 | 非公開の保管先を持つか | 持たない / 非公開の別リポジトリ / ローカルのみ | 未修正のセキュリティ指摘(`minor-N`、`H1`)の一覧と事業上の論点に限定して、小規模な非公開リポジトリを持つ。クラウドセッションでは 2 つ目のリポジトリとして追加する必要がある(推論) |
| 3 | 脆弱性の報告窓口と、未修正の指摘を公開する範囲 | GitHub の Private Vulnerability Reporting / メール / 保留を続ける | Private Vulnerability Reporting。curl は報奨金制度の廃止後にこの方式へ移行した(二次資料で確認。[curl](https://daniel.haxx.se/blog/2026/01/26/the-end-of-the-curl-bug-bounty/)) |
| 4 | ADR の運用 | 追補を続ける / 新しい ADR で置き換える / 既存の ADR も書き直す | 新しい ADR で置き換える。既存の 22 本は書き直さず、索引と 1 行要約で現在有効な決定を示す |
| 5 | 外部からのコントリビューションの受け入れ方針 | 受け付けない(codex)/ issue の承認を前提条件にする(goose、cline)/ 制限しない | issue の承認を前提条件にする。ADR の起案は誰でもでき、Accepted にできるのはオーナーだけであることを明記する |
| 6 | AI 利用の開示 | Co-Authored-By を続ける / やめる / 外部のコントリビューターにだけ求める | 続ける。ghostty と同じ形式で、メンテナが AI を利用していることを明記し、外部のコントリビューターには内容の理解と開示を求める。コミットに付くセッション URL の行は第三者が開けないので、残すかどうかを別途決める |
| 7 | AGENTS.md と文書の言語 | 日本語のみ / AGENTS.md と README だけ英語を併記する | 調査では判断の根拠となる資料が得られなかった。想定する導入先に合わせて決める |
| 8 | 完了した計画と評価結果の残し方 | 変更せずにリポジトリに残す / PR と issue にだけ残す / 削除する | backlog は変更せずに残す(コードから参照されているため)。新しい計画と評価結果は PR と issue にだけ残す |

## 結論

調査で明らかになったのは、エージェントによる開発が進んでいるプロジェクトほど、リポジトリに置く文書を「いつ読んでも内容が正しい文書」に絞っていることである。AGENTS.md のルール、スキル、ADR、現行の設計書がこれにあたる。「特定の時点では正しかった記録」(進捗、計画、評価結果、レビューでの指摘)は、日付と状態が自動的に記録される場所、すなわち issue、PR、コミット、リリースで管理している。すべてをリポジトリに置く leisen の構成は、エージェントにコンテキストを渡すという目的に対しては妥当だった。ただし、この構成が成立するのは、オーナー 1 人とエージェントという閉じた体制で、PR のたびにすべての文書を更新できる間だけである。記述の不一致がすでに生じていることから、その限界は超えている。

leisen は認可と監査を強みとするプロダクトなので、ADR と脅威モデルを公開していること自体は、導入を検討する側にとって価値がある。削除すべきなのは ADR ではなく、ADR や CLAUDE.md に混在している作業の記録である。今回の調査で確認できなかった点が 2 つある。完了済みの計画を残すことがエージェントの作業の成功率を上げるのか下げるのかを測定したデータは見つかっていない。エージェントで開発されたプロジェクトが、公開時に開発プロセスに関する文書をどう再編成したかの事例も見つかっていない。leisen の移行は、その最初の記録の 1 つになりうる。
