# 公開リポジトリには AGENTS.md・スキル・ADR・設計書だけを残す

エージェントによる開発を積極的に行う OSS の多くは、公開リポジトリに置くものを「短い AGENTS.md(または CLAUDE.md)」「手順を定義したスキル」「ADR / RFC と現行の設計書」に絞り、進行中のタスク・計画・評価結果は GitHub Issues や非公開の保管先で管理している。調査した約 50 のリポジトリのうち、タスクを 1 件 1 ファイルで管理するバックログをデフォルトブランチに常時置いている例は 1 つも見つからなかった。36,710 リポジトリを調べた研究でも、コミットされた計画ファイルは 10 リポジトリの 85 個にとどまる ([ESEM 2026](https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.ESEM.2026.54))。backlog・ADR・設計書・`.claude` をすべてリポジトリに置く leisen の構成は、この傾向から外れている。ただし、問題は文書の量ではなく、進捗や決定の状態をどこで管理するかが決まっておらず、同じ情報が複数の文書に書かれていることにある。CLAUDE.md の本文の約 69% が日付付きの進捗記録で、同じ進捗が少なくとも 4 種類の文書に手作業で転記されており、ADR-018 の Status や SDK のバージョンですでに記述の不一致が生じている ([棚卸し](../research_notes/エージェント開発OSSの開発環境管理/leisen_inventory.md))。提案は次の 3 点である。(1) CLAUDE.md を恒久的なルールだけの約 5,000 文字に戻し、その内容を AGENTS.md に移す(CLAUDE.md からは AGENTS.md をインポートする)。(2) タスクと未決事項は GitHub Issues で管理し、完了済みの backlog は変更しない履歴として残す。(3) ADR は残すが、追補を重ねる運用をやめ、「決定後は書き換えない ADR」と「現在の状態を記述する設計書」に分ける。非公開の内部リポジトリで開発し、公開リポジトリをそのミラーにする二重管理は、数人以下のチームではコストに見合わないので採用しない。複数のエージェントによる並行開発では、タスクの割り当てを人間か単一のオーケストレーターに集約し、作業は worktree で隔離する構成が一般的である。なお、OpenAI は社内プロダクトで設計書・実行計画・技術的負債の一覧までリポジトリに置いている。ただし、AGENTS.md は約 100 行の目次にとどめ、文書の鮮度を lint と CI で検査している。同社が公開している OSS(Agents SDK)では実行計画を gitignore しており、タスクは Issue Tracker で管理する方式(Symphony)を公開している。したがって、OpenAI の事例が支持しているのは、長期間有効な設計知識をリポジトリに置くことであり、タスクの進捗をリポジトリに置くことではない。

## 用語

本レポートでは次の用語を以下の意味で使う。

| 用語 | 意味 |
|---|---|
| ハーネス | エージェントを動作させるための設定一式。AGENTS.md / CLAUDE.md、スキル、サブエージェント定義、フック、`.claude/settings.json` などのツール設定を含む |
| 現行の設計書 | システムが現在どう動作するかを記述し、変更のたびに更新する文書。leisen では `docs/product-design*.md` が該当する |
| 追補 | leisen の ADR で、既存の ADR の末尾に日付付きで追記している変更・検証結果の記述 |

## 現在のプラクティスは 6 つの類型に分かれ、主流は「AGENTS.md とスキルをリポジトリに置く型」である

調査対象は、コーディングエージェントを開発しているベンダー自身のリポジトリ 17 と、エージェントを多用して開発されているプロダクトのリポジトリ約 35 である。いずれも 2026-11-15 時点のデフォルトブランチを clone して確認した。以下の A〜F は本レポートで定義した分類である。B、C、D は、前の類型にリポジトリに置くものを 1 段ずつ足した関係にある。E と F は、置くものではなく置き場所の分け方の類型で、B や C と併用される。採用例が最も多いのは B である。leisen の現状は D にあたり、本レポートが提案する構成は C である。

| 類型 | リポジトリに置くもの | 採用例 | 利点 | コスト | 評価 |
|---|---|---|---|---|---|
| A. 最小構成 | 数行〜数十行の AGENTS.md のみ、または何も置かない | simonw/llm(24 行)、datasette(5 行)、antirez の各リポジトリ(なし)、minijinja(プロンプト 2 本)、workers-oauth-provider(AGENTS.md 295 行のみ) | 陳腐化する文書がない。公開される記録はコミット履歴とテストである | 手順に関する知識が個人に属人化する。ルールをテストや lint で表現できるだけの成熟が必要になる | 単独メンテナの小規模なライブラリに向く。不変条件が 9 つある leisen には不足する |
| B. AGENTS.md とスキルを置く型(主流) | 短いルートの AGENTS.md、ディレクトリ別の AGENTS.md、スキル、少数のフック。タスクは Issues / Projects で管理する | opencode、gemini-cli、goose、next.js、sentry、PostHog、zed、OpenHands、modelcontextprotocol/servers、openai-agents-python / js | 外部のコントリビューターが使うエージェントも同じルールで動作する。毎セッション読み込まれる分量が小さい | スキルの保守。複数のツールに対応するためのシンボリックリンクの管理 | 公開 OSS の事実上の標準である。leisen に提案する C の土台になる |
| C. ADR / RFC と設計書も置く型 | B に加えて、ADR / RFC と現行の設計書 | cloudflare/agents(design/ 58 ファイル、RFC 27 本)、vercel/ai(2026-03 に ADR を採用)、beads(engdocs/adr)、opencode(specs/v2)、MCP 仕様(seps/ 48 本) | 決定の理由を再調査せずに済む。却下済みの案が再び議論されることを防げる | 索引と Status を維持しなければ参照されなくなる | 認可と監査が価値の中心である leisen には必須である。ただし現在の書き方は改める必要がある |
| D. 変更単位の計画・仕様も置く型 | 変更ごとの提案・計画・タスク、またはファイル形式のバックログ | sentry-mcp(OpenSpec と日付付きの計画)、spec-kit、OpenSpec、Backlog.md、OpenAI の社内プロダクト(`docs/exec-plans/active/`・`completed/`。二次資料で確認) | エージェントがネットワークなしで参照できる。計画をレビューできる | コードとは別に保守対象が増え、更新が追いつかず陳腐化する。複数のエージェントが並行して書き込むと競合する | 完了後の扱い(変更せず残す・アーカイブする・削除する)を決めた場合にだけ成立する。常時置く運用は少数派である |
| E. 非公開の保管先に分ける型 | AGENTS.md とスキルは公開し、調査・計画・タスクのメモは別リポジトリかローカルに置く | humanlayer(`/thoughts/` を gitignore し、別リポジトリで管理)、beads(メンテナ用のタスク管理データは非公開、公開のタスク管理は Issues)、Ronacher(個人用のハーネスを別リポジトリ agent-stuff で管理)、sentry(スキルを agents.toml で外部リポジトリから取得) | 率直な内容のメモを公開せずにバージョン管理できる | 各マシンでシンボリックリンクとフックの設定が必要になる。クラウドセッションでは別リポジトリとして追加する必要がある(推論) | 公開に適さない少量の資料に限って使うのが現実的である |
| F. 内部リポジトリで開発し、公開ミラーを持つ型 | 公開リポジトリは内部リポジトリから生成される。ハーネスの本体は内部にある | openai/codex(全コミットのコミッターが copyberry、2026-09-30 にルートの AGENTS.md と .codex/ を削除)、anthropics/claude-code(製品のソースコードなし)、E2B(仕様を Copybara で同期) | 内部資料が公開されないことを最も確実に保証できる | 外部からの PR を内部リポジトリに取り込む際に、差分が元の PR と一致しない、基準となるコミットがずれるといった問題が報告されている([OpenXLA](https://openxla.org/xla/copybara)、[copybara issue #107](https://github.com/google/copybara/issues/107))。同期の仕組みを継続的に保守する必要がある | 大手ベンダー向けの型である。数人のチームではコストに見合わない |

A・B・C は、clone したリポジトリのファイル構成を直接確認した結果に基づく。opencode は方針を一文で明記している。「GitHub issues own active work; Git history preserves removed plans and scratchpads.」([specs/v2/README.md](https://github.com/anomalyco/opencode/blob/HEAD/specs/v2/README.md))。goose はタスクを issue で管理し、公開の Projects ボードでステータスが Ready になるまでエージェントに実装させない ([AGENTS.md](https://github.com/aaif-goose/goose/blob/HEAD/AGENTS.md))。gemini-cli、Roo-Code、pi-mono は計画用のディレクトリやファイル(`conductor/`、`plans/`、`todo.md`)を gitignore している ([gemini-cli .gitignore](https://github.com/google-gemini/gemini-cli/blob/HEAD/.gitignore)、[pi-mono .gitignore](https://github.com/earendil-works/pi-mono/blob/HEAD/.gitignore))。OpenHands は設計内容を PR の本文に書き、一時的な成果物を置く `.pr/` はリリース時に削除すると定めている ([software-agent-sdk AGENTS.md](https://github.com/OpenHands/software-agent-sdk/blob/HEAD/AGENTS.md))。

**D を常時運用して失敗した実例が beads である。** beads はリポジトリ内に issue をファイルとして置く方式を広めたプロジェクトだが、現在は自身の `.beads/` を gitignore し、「GitHub Issues is the public tracker」と明記している ([beads AGENTS.md](https://github.com/steveyegge/beads/blob/HEAD/AGENTS.md))。理由は、多数のエージェントが互いの書き込みを上書きし、復旧できなくなったためだと説明されている。この経緯の説明は Dolt の開発元の記事による ([DoltHub](https://www.dolthub.com/blog/2026-03-13-multi-agent-persistence/))。beads 自身のドキュメントは、Dolt を採用した理由として、行単位ではなくセル単位で差分とマージを扱えることと、複数の書き込み元に対応できることを挙げている ([docs/architecture/dolt.md](https://github.com/steveyegge/beads/blob/main/docs/architecture/dolt.md))。

F の codex では、直近 500 コミットのすべてでコミッターが `copyberry` であり、`GitOrigin-RevId` トレーラーが付いている。ルートの AGENTS.md と `.codex/skills/` を削除した PR には理由が書かれていない ([PR #49713](https://github.com/openai/codex/pull/49713))。「ハーネスは非公開にすべきである」と明文化した方針は、どのリポジトリにも見つからなかった。ハーネスはコミットするのが標準である。

## OpenAI は設計知識をリポジトリに、タスクを Issue Tracker に、実行状態を別の基盤に置いている

OpenAI の事例は 1 つの方式ではなく、対象ごとに異なる 3 つの事例として扱う必要がある。openai.com の記事 2 本(Harness engineering、Symphony)は、本調査では本文を取得できなかった(HTTP 403)。この 2 本の内容は、別途提供された調査結果(2026-11-16、英語の原文を確認したとするもの)と二次資料に基づく。公開リポジトリの内容と developers.openai.com の記事は、本調査で直接確認した。

**社内プロダクトでは、設計書・実行計画・技術的負債の一覧までリポジトリに置いている。** 記事「Harness engineering: leveraging Codex in an agent-first world」(2026-02-11)によると、リポジトリには `AGENTS.md`、`ARCHITECTURE.md` のほか、`docs/design-docs/`、`docs/exec-plans/active/`、`docs/exec-plans/completed/`、`docs/exec-plans/tech-debt-tracker.md`、`docs/product-specs/` がある。当初は 1 つの大きな AGENTS.md にすべてを書いたが機能せず、約 100 行の AGENTS.md を目次として使い、詳細は `docs/` の各文書から必要に応じて読み込む構成に変えた。文書の鮮度と相互リンクは lint と CI で検査し、古くなった文書はエージェントが定期的に修正の PR を出す。約 5 か月で約 100 万行のコードと約 1,500 件の PR を、当初 3 人のエンジニアで作成したと報告している ([openai.com](https://openai.com/index/harness-engineering/)、二次資料は [InfoQ](https://www.infoq.com/news/2026/02/openai-harness-engineering-codex/)、[martinfowler.com](https://martinfowler.com/articles/exploring-gen-ai/harness-engineering.html))。提供された調査結果は、小規模な変更の計画は一時的なものとし、複雑な変更だけを進捗と決定の記録を含む実行計画(ExecPlan)としてリポジトリに残す、という区別も挙げている。この区別は、本調査で確認できた資料には見つからなかった。この事例は非公開のリポジトリであり、公開 OSS での実績ではない。

**公開している OSS の Agents SDK では、AGENTS.md とスキルをコミットし、実行計画はコミットしていない。** openai-agents-python の `AGENTS.md` は 106 行、openai-agents-js は 186 行で、`.agents/skills/` にそれぞれ 14 個と 15 個のスキルがある ([AGENTS.md](https://github.com/openai/openai-agents-python/blob/64fbde5d02b42ae5f9db668eb0184cdb3fc9d775/AGENTS.md)、[.agents/skills](https://github.com/openai/openai-agents-python/tree/64fbde5d02b42ae5f9db668eb0184cdb3fc9d775/.agents/skills))。AGENTS.md は、ブランチの切り替えとコミットに明示的な許可を求め、「Never push, open a PR, or otherwise mutate GitHub.」と定めている。`PLANS.md` は、複数の手順や複数のファイルにまたがる作業、または約 1 時間を超える作業で ExecPlan を書くよう求め、Progress、Surprises & Discoveries、Decision Log、Outcomes & Retrospective の各節を定めている ([PLANS.md](https://github.com/openai/openai-agents-python/blob/64fbde5d02b42ae5f9db668eb0184cdb3fc9d775/PLANS.md))。ただし、どちらのリポジトリも `plans/` を gitignore しており、計画ファイルもバックログもコミットされていない ([.gitignore](https://github.com/openai/openai-agents-python/blob/64fbde5d02b42ae5f9db668eb0184cdb3fc9d775/.gitignore))。記事「Using skills to accelerate OSS maintenance」は、2 つのリポジトリでマージされた PR が 3 か月間で 316 件から 457 件に増えたと報告している。スキルの導入だけが原因であることを示す比較実験ではない ([developers.openai.com](https://developers.openai.com/blog/skills-agents-sdk))。

**タスクは Issue Tracker で管理し、オーケストレーターが Issue ごとの作業環境に割り当てる方式を公開している。** Symphony は、Issue Tracker からタスクを取得し、Issue ごとに独立したワークスペースとエージェントを割り当てるオーケストレーターの仕様である。エージェントの作業方針は、リポジトリで管理する `WORKFLOW.md` に書く ([SPEC.md](https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/SPEC.md))。実装例の `WORKFLOW.md` は、進捗・チェックリスト・検証結果を Issue の 1 つのコメント(「Codex Workpad」)に集約して更新し続けるよう指示し、作業範囲外の改善点を見つけた場合は「file a separate Linear issue instead of expanding scope」と定めている ([elixir/WORKFLOW.md](https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/elixir/WORKFLOW.md))。現在は Linear のほかに GitHub Issues、Jira Cloud、Asana、GitLab のアダプターがある。README は「a low-key engineering preview」、Elixir 実装の README は「prototype software intended for evaluation only」と明記しており、本番運用を想定したものではない ([README.md](https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/README.md))。

**エージェントの実行環境と資格情報は、リポジトリとは別の基盤で管理している。** 記事「Securing persistent agents like OpenClaw at OpenAI」(2026-11-12)は、信頼できるゲートウェイと、サンドボックス内で動作する信頼しないエージェントを分離すること、資格情報をエージェントから見えないようにする credential broker を置くこと、エージェントの識別情報を利用者の識別情報と分けることを挙げている ([developers.openai.com](https://developers.openai.com/blog/securing-persistent-agents-like-openclaw-at-openai))。会話の履歴、実行ログ、資格情報は、AGENTS.md やスキルとは性質が異なり、Git リポジトリの管理対象ではない。

**ハーネスは、モデルの更新に合わせて削る対象でもある。** 記事「Rethinking skills and prompts for GPT-6 Astra」は、長すぎるスキルの説明文が切り詰められること、文書の読み込みを必須とする指示が誤字の修正のような変更には過剰であること、以前のモデル向けのテストの指示が不要なテストを招くことを挙げている ([developers.openai.com](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra))。記事「Maintaining software with the GPT-6 family」は、AGENTS.md の指示を 1 つ選び、同じリポジトリの状態と同じモデルで同じタスクを再実行して、変更前後の結果を比較する方法を提案している。これは実験の報告ではなく、提案である ([developers.openai.com](https://developers.openai.com/blog/maintaining-software-with-the-gpt-6-family))。

これらを合わせると、OpenAI の事例が支持しているのは「長期間有効な設計知識はコードと同じリポジトリに置く」ことである。タスクの状態と進捗は Issue Tracker に、実行中の計画は(公開 OSS では)ローカルに、実行ログと資格情報は別の基盤に置いている。6 つの類型にあてはめると、社内プロダクトは D、Agents SDK は B である。

## AGENTS.md は短くし、手順はスキルに、決定は書き換えない ADR にする

成果物の種類ごとの扱いは、類型が違ってもほぼ共通している。

**AGENTS.md の内容は「コードからは読み取れないこと」に絞られている。** ベンダー各社のリポジトリのルートにある AGENTS.md(gemini-cli は GEMINI.md、zed は `.rules`)は 5〜240 行で、内容はコマンド、依存の方向、禁止事項である。Anthropic のドキュメントは CLAUDE.md を 1 ファイル 200 行未満にすることを目安とし、CLAUDE.md は「context, not enforced configuration」であるため、確実に禁止したい操作には PreToolUse フックを使うよう求めている ([Claude Code docs](https://code.claude.com/docs/en/memory))。ETH Zurich などによる評価研究(第 3 版、2026-09-29)は、AGENTS.md などのコンテキストファイルは一般にタスクの成功率を向上させないと結論している。LLM が生成したファイルでは成功率が約 0.5〜2 ポイント下がり、開発者が書いたファイルでは約 2.4 ポイント上がったが、いずれも統計的に有意ではない。推論コストは、LLM が生成したファイルで 20% と 23%、開発者が書いたファイルで最大 19% 増加した。リポジトリの概要説明については「Context files do not provide effective overviews」としている ([arXiv:2602.11988v3](https://arxiv.org/html/2602.11988v3))。各プロジェクトのルールも同じ方向である。modelcontextprotocol/servers は「ルールは AGENTS.md に、手順は必要なときに読み込むスキルに」と分け、「このファイルのルールはすべて、現在のリポジトリについて正しい」と定めている ([AGENTS.md](https://github.com/modelcontextprotocol/servers/blob/HEAD/AGENTS.md))。workers-sdk は、バージョン・ルールの一覧・件数を転記すると古くなるので、元の設定ファイルやドキュメントを参照するよう指示している ([AGENTS.md](https://github.com/cloudflare/workers-sdk/blob/HEAD/AGENTS.md))。

**ルールは AGENTS.md に書き、CLAUDE.md にはインポートの 1 行だけを書く構成が多い。** sentry、supabase、tldraw、ruff、mastra、goose の CLAUDE.md は `@AGENTS.md` の 1 行だけである ([sentry CLAUDE.md](https://github.com/getsentry/sentry/blob/HEAD/CLAUDE.md))。Claude Code は、CLAUDE.md がなければ AGENTS.md を直接読み込み、両方ある場合は CLAUDE.md がインポートしたときにだけ AGENTS.md を読み込む ([Claude Code docs](https://code.claude.com/docs/en/memory))。スキルは、特定のツールに依存しない `.agents/skills/` に実体を置き、`.claude/skills` をシンボリックリンクにする構成が広く使われている。スキルの対象は、リリース、PR の作成とレビュー、issue のトリアージ、テストの作成、動作検証に集中している。サブエージェント定義をコミットしている例は少なく、まとまった数を持つのは PostHog(11 個)と claude-code-action(レビュー用 5 個)程度である。

**フックは用途を限定した検査にとどまる。** コミットされているフックは、編集後のフォーマット、対話型コマンドのブロック、セッション開始時のセットアップ程度で、大規模なポリシーエンジンを置いている例はなかった。leisen の 2 本のフックはこの水準に合っている。一方で、リポジトリにコミットされた `.claude/settings.json` や `.mcp.json` は攻撃対象にもなる。Check Point は、`.claude/settings.json` のフックや MCP サーバーの自動承認が、ユーザーの確認なしにコマンドを実行する経路になっていた脆弱性を報告した。Anthropic のアドバイザリによると、対象は 3 件である。信頼確認の警告が不十分だった問題([GHSA-ph6w-f82w-28w6](https://github.com/anthropics/claude-code/security/advisories/GHSA-ph6w-f82w-28w6)、1.0.87 で修正)、信頼確認のダイアログより前にコマンドが実行される問題([CVE-2025-59536](https://github.com/anthropics/claude-code/security/advisories/GHSA-4fgq-fpq9-mr3g)、1.0.111 で修正)、`ANTHROPIC_BASE_URL` の設定によって API キーが外部に送信される問題([CVE-2026-21852](https://github.com/anthropics/claude-code/security/advisories/GHSA-jh7p-qr78-84p7)、2.0.65 で修正)。Check Point は設定ファイルを実行コードと同じ水準でレビューするよう推奨している ([Check Point Research](https://research.checkpoint.com/2026/rce-and-api-token-exfiltration-through-claude-code-project-files-cve-2025-59536/))。秘密情報の漏えいは `.claude/settings.local.json` で発生している。Apiiro の調査では、公開リポジトリにある `settings.local.json` 104,185 個のうち 1,122 個に、合計 1,379 件の秘密情報が含まれていた。Git の履歴、共有の `settings.json`、エージェントの会話記録を合わせた合計は、1,994 リポジトリで 2,539 件である(Apiiro の記事は取得できず、二次資料で確認した。[CSO Online](https://www.csoonline.com/article/4247336/claude-codes-dont-ask-again-button-has-a-secrets-spilling-problem.html))。原因は、このファイルの除外設定が利用者のマシンのグローバルな git 設定にしか書かれず、リポジトリの `.gitignore` には含まれないことである。ガードレール(フックや `scripts/guard/` の検査スクリプト)の定義を公開したこと自体が悪用につながった事例は見つかっていない。

**設計に関する文書は、現在の状態を記述する設計書と、決定時点の内容を保持する ADR / RFC に分ける構成が最も整理されている。** cloudflare/agents は、設計書を「現在どう動作するか」を記述して随時更新する文書と位置づけ、RFC は決定後に更新せず、却下されたものも削除しないと定めている。手順は「提案する → Status を accepted / rejected に更新する → 関連する設計書を更新する」である ([design/AGENTS.md](https://github.com/cloudflare/agents/blob/HEAD/design/AGENTS.md))。vercel/ai は、アーキテクチャに関わる変更の前に ADR を確認し、既存の ADR と矛盾する場合は作業を止めて人間に相談するよう AGENTS.md で指示している。ADR の起案手順はスキルとして定義されている ([AGENTS.md](https://github.com/vercel/ai/blob/HEAD/AGENTS.md))。

**完了した計画の扱いには 3 つの考え方がある。** 完了済みのディレクトリに移して残す(OpenAI の社内プロダクトの `docs/exec-plans/completed/`)、内容を現行仕様に反映したうえで残りをアーカイブする(OpenSpec)、削除して、残すべき事実だけをコード・テスト・短い ADR に移す、の 3 つである。3 番目は「変更がリリースされたら、仕様の大半は削除すべきである」とする記事に基づく ([The Main Thread](https://www.the-main-thread.com/p/spec-driven-development-exit-strategy))。いずれの考え方でも、完了した計画を継続的に更新する対象とはしていない。なお、OpenAI が公開している Agents SDK は、実行計画(ExecPlan)を `plans/` に書き、このディレクトリを gitignore している。リポジトリにコミットしているのは、実行計画の書き方を定めた `PLANS.md` だけである。

**評価は、定義をコミットし、実行結果はコミットしないのが一般的である。** gemini-cli は `evals/logs/` を、humanlayer は評価結果の出力先を gitignore している ([gemini-cli .gitignore](https://github.com/google-gemini/gemini-cli/blob/HEAD/.gitignore)、[humanlayer .gitignore](https://github.com/humanlayer/humanlayer/blob/HEAD/.gitignore))。日付付きの評価レポートをデフォルトブランチに置いている例は、調査した範囲にはなかった。

**外部からのコントリビューションに関するガバナンスは、「内容を理解している人間が責任を負う」という点で共通している。** ghostty は、メンテナ自身が AI を多用していると明記したうえで、外部のコントリビューターにだけ AI 利用の開示と内容の理解を求めている ([AI_POLICY.md](https://github.com/ghostty-org/ghostty/blob/HEAD/AI_POLICY.md))。goose と cline は issue の承認を PR の前提条件とし、codex は外部からの PR を受け付けていない ([docs/contributing.md](https://github.com/openai/codex/blob/HEAD/docs/contributing.md))。開示の方法はプロジェクトによって異なる。ASF は `Generated-by` または `Co-authored-by` トレーラーを推奨している ([ASF](https://www.apache.org/legal/generative-tooling.html))。Linux カーネルは、AI ツールの利用を `Assisted-by` タグで示すよう求めていたが、2026 年 10 月の Maintainers Summit でこの要件を削除すると決めた ([LWN](https://lwn.net/Articles/1099594/))。2026-11-15 時点の mainline の `coding-assistants.rst` には、このタグに関する記述がない ([coding-assistants.rst](https://github.com/torvalds/linux/blob/fa2933aac170dd19c6a7f0d7b81a8f537e40915c/Documentation/process/coding-assistants.rst))。

## 並行開発では、タスクの割り当てを 1 か所に集約し、作業は worktree で隔離する

タスクを Issues で管理する場合に、複数のエージェントによる並行開発で排他制御・タスクの割り当て・タスク間の依存関係をどう扱うかを整理する。以下の内容は、公式ドキュメントと、clone したリポジトリのファイルで確認した。確認できなかった点はその箇所に明記する。

**割り当ては人間か単一のオーケストレーターが行い、エージェント同士にタスクの取得を競わせない。** goose は、公開の Projects ボードでステータスが Ready になった issue だけをエージェントに実装させ、Ready でない issue を実装した PR は閉じる ([AGENTS.md](https://github.com/aaif-goose/goose/blob/HEAD/AGENTS.md))。OpenHands では、`ready-for-dev` ラベルは「明確な受け入れ条件がある」ことを意味し、CI のワークフローが、このラベルを付けたのが書き込み権限以上を持つ人であることを検査する ([issue-readiness-check.yml](https://github.com/OpenHands/OpenHands/blob/main/.github/workflows/issue-readiness-check.yml)、[pull_request_template.md](https://github.com/OpenHands/OpenHands/blob/main/.github/pull_request_template.md))。Symphony の仕様は「The orchestrator is the only component that mutates scheduling state.」と定め、同時に実行するエージェントの数に上限(既定値 10)を設けている ([SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md))。gastown では、Mayor と呼ぶ調整役のエージェントが作業担当のエージェントにタスクを渡す。人間が直接渡すこともできる ([README.md](https://github.com/steveyegge/gastown/blob/main/README.md))。

**GitHub の assignee は、タスクをアトミックに取得する手段にはならない。** assignee を追加する API は、1 つの issue に最大 10 人まで追加でき、すでに設定されている担当者を置き換えない ([REST API: assignees](https://docs.github.com/en/rest/issues/assignees?apiVersion=2022-11-28))。POST などの更新系のリクエストでは条件付きリクエストが原則として使えない ([REST API のベストプラクティス](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api))。したがって、複数のエージェントが同じ issue に自分を担当者として設定しても、どちらのリクエストも成功する。エージェントの起動は、人間が 1 件ずつ指示する形が基本である。GitHub Copilot のクラウドエージェントは 1 つのタスクにつき 1 つの PR を作成し ([GitHub Docs](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent))、Claude は issue や PR での `@claude` メンションで起動し ([Claude Code docs](https://code.claude.com/docs/en/github-actions))、Linear では issue の delegate としてエージェントを設定する ([Linear](https://linear.app/docs/agents-in-linear))。

**排他制御はロックではなく、作業環境の隔離とマージ時の検査で行う。** タスクごとに git worktree かクラウド上のサンドボックスを用意し、エージェントは互いの作業ツリーに触れない。next.js は worktree を扱うツールの設定をコミットしている ([conductor.json](https://github.com/vercel/next.js/blob/canary/conductor.json)、[.cursor/worktrees.json](https://github.com/vercel/next.js/blob/canary/.cursor/worktrees.json)、[.codex/environments/next.toml](https://github.com/vercel/next.js/blob/canary/.codex/environments/next.toml))。humanlayer は、タスク名ごとに worktree とブランチを作成するテンプレートを定義している ([workspace.json](https://github.com/humanlayer/humanlayer/blob/HEAD/.humanlayer/workspace.json))。gastown の作業担当のエージェントも、それぞれ独立した worktree で作業する。マージの直列化には GitHub のマージキューが使える ([GitHub Docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue))。マージキュー用の `merge_group` トリガーは、zed、PostHog、goose、pydantic-ai、beads のワークフローにあり、next.js、OpenHands、gastown、symphony にはない。ブランチの設定でマージキューが実際に有効になっているかどうかは確認していない。gastown は、Refinery と呼ぶ独自のマージキューを持つ。

ロックによる排他制御が機能しなかった実例を Cursor が報告している。多数のエージェントを並行して動かす実験で、ファイルのロックを使うと「Twenty agents would slow down to the effective throughput of two or three」となり、楽観的並行制御に変えるとエージェントがリスクを避けて難しい作業に着手しなくなった。最終的に、計画を担当するエージェントと実装を担当するエージェントに役割を分ける構成にした ([Scaling long-running autonomous coding](https://cursor.com/blog/scaling-agents))。

**エージェントが自律的に次のタスクを選ぶ構成では、Issues ではなく専用のタスク管理の仕組みを使う。** beads の `bd update <id> --claim` はタスクをアトミックに取得し、別のエージェントが先に取得していた場合は専用の終了コードを返す ([CLI_REFERENCE.md](https://github.com/steveyegge/beads/blob/main/docs/CLI_REFERENCE.md))。Claude Code の agent teams(実験的な機能)は、共有のタスクリストを `~/.claude/tasks/{team-name}/` に保存し、「Task claiming uses file locking to prevent race conditions」としている ([Claude Code docs](https://code.claude.com/docs/en/agent-teams))。いずれも、状態は Git リポジトリの外にある。Issues に置くのは「何を実装するか」「誰に割り当てたか」という粒度の情報にとどまり、実行中の細かい調整に使う状態は、ローカルのデータベースやオーケストレーターの内部に置かれる。

**タスク間の依存関係は、タスクのデータとして保持し、依存が解消されたタスクだけを割り当てる。** 実装ごとの方法は次のとおりである。

| 仕組み | 依存関係の持ち方 | 着手可能なタスクの求め方 |
|---|---|---|
| beads | `bd dep add` で登録する。種類として blocks、parent-child、related、discovered-from などを区別する | `bd ready` が、ブロックされていないタスクだけを返す ([dependencies.md](https://github.com/steveyegge/beads/blob/main/docs/core-concepts/dependencies.md)) |
| Symphony | Issue Tracker のブロック関係を使う | Linear のアダプターは、未着手の issue を、終了状態でないブロック元がない場合にだけ割り当てる ([SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md)) |
| Claude Code の agent teams | タスクリストの各タスクに依存関係を持たせる | 依存先が完了するまで、エージェントはそのタスクを自分では取得しない。リーダーか利用者が割り当てることはできる ([Claude Code docs](https://code.claude.com/docs/en/agent-teams)) |
| claude-task-master | `tasks.json` の `dependencies` フィールド | `next` コマンドが、依存先がすべて完了したタスクを返す。取得の排他制御はない ([task-structure.md](https://github.com/eyaltoledano/claude-task-master/blob/main/docs/task-structure.md)) |
| spec-kit | `tasks.md` で、並行して実行できるタスクに `[P]` を付け、タスクを Phase に分ける | 基盤となる Phase が完了するまで、後続の Phase に着手しない ([tasks-template.md](https://github.com/github/spec-kit/blob/main/templates/tasks-template.md)) |
| GitHub Issues | issue の依存関係(blocked by / blocking、2025-08-21 に一般提供)と sub-issue(2025-04-09 に一般提供)。どちらも REST API がある | GitHub 自体は、ブロックされている issue への着手を止めない。オーケストレーターか人間が API で確認する ([GitHub Docs](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies)) |

**依存関係は、実行時に解決するよりも、計画の段階で減らす。** 公開されている指針は、次の 2 つである。

- 変更範囲で分割する。Claude Code のドキュメントは「Break the work so each teammate owns a different set of files.」と書き、spec-kit の `[P]` は「different files, no dependencies」を条件としている。
- 段階に分ける。spec-kit は、基盤となる Phase が後続のすべての作業をブロックすると定めている。

インターフェースを先に決めてから実装を並行させる方法は、spec-kit が `contracts/` を実装の前提としている例があるだけで、ベンダーが明示的に推奨している記述は見つからなかった。

**依存先の完了の判定方法は、仕組みによって異なる。** 「マージをもって完了とする」と定めた指針は見つからなかった。実装では、gastown の Refinery がマージ後にマージリクエストと元のタスクを閉じ、Symphony ではブロック元の issue が終了状態になった時点で後続の issue が割り当て可能になる。どちらも、マージまたは Issue の終了を完了としている。一方、Claude Code の agent teams では、完了はエージェント自身の報告による。マージを待たずに進める方法として、依存先のブランチから後続のブランチを作成する stacked PR がある。pydantic-ai の `PLAN.md` は実装を stacked PR として順に提出する計画を記載し ([PLAN.md](https://github.com/pydantic/pydantic-ai/blob/main/PLAN.md))、next.js には stacked PR 用のワークフローがある ([pr_stack_optimizer.yml](https://github.com/vercel/next.js/blob/canary/.github/workflows/pr_stack_optimizer.yml))。

**作業中に見つかった作業は、元のタスクに含めず、新しいタスクとして登録する。** Symphony の `WORKFLOW.md` は「file a separate Linear issue instead of expanding scope」と指示し、新しい issue を元の issue に関連づける ([elixir/WORKFLOW.md](https://github.com/openai/symphony/blob/main/elixir/WORKFLOW.md))。beads には、作業中に見つかったタスクを元のタスクに関連づける `discovered-from` という依存関係の種類がある。gastown のドキュメントも、見つけた作業は自分で修正せずに登録するよう指示している ([molecules.md](https://github.com/steveyegge/gastown/blob/main/docs/concepts/molecules.md))。

**leisen は、assignee とラベルによる割り当てで足りる。** leisen ではオーナーが唯一の割り当て担当であり、「1 タスク = 1 ブランチ = 1 PR」のルールもすでにある。割り当てる人が 1 人であれば、assignee がアトミックでないことは問題にならない。GitHub App の承認待ちや API キーの入手待ちといった人手による前提条件は、タスク間の依存関係と同じく「ブロックされている」状態として扱い、issue の依存関係か `blocked` ラベルで表す。コネクタのツール IF は connector-sdk と ADR で先に固定されているので、コネクタの実装は互いに並行して進められる。認可と監査に関わる変更にはレビューが必要なので、依存先の完了は、エージェントの報告ではなくマージで判定するのが適している。並行開発で実際に衝突しているのは、タスクの割り当てではなく、どの PR も書き換える CLAUDE.md の「現在のフェーズ」と backlog README である。タスクと進捗を Issues に移せば、この衝突の原因がなくなる。将来、エージェントに次のタスクを自律的に選ばせる場合は、Issues 上で取得を競わせず、1 つのオーケストレーターのセッションが割り当てる構成にする。

## leisen の課題は文書の量ではなく、状態を管理する場所が決まっていないことにある

leisen の文書は 9,602 行で、ソースコードとテストコードの合計の約 15% にあたる。量だけを見れば、PostHog の 273 個のスキルや cloudflare/agents の 58 本の設計文書と比べて特に多いわけではない。違いは内容にあり、文書の約 6 割(約 5,800 行)が開発の経過と判断の記録である ([棚卸し](../research_notes/エージェント開発OSSの開発環境管理/leisen_inventory.md))。

**毎セッション読み込まれる CLAUDE.md が、進捗記録になっている。** CLAUDE.md は 58 行で、行数だけなら 200 行の目安に収まる。しかし、15,592 文字のうち「現在のフェーズ」の節が 10,223 文字を占め、恒久的なルールは約 4,600 文字しかない。この節には、ADR-018 を Proposed とする誤りがある(実際は Accepted)。MCP SDK のバージョンは、CLAUDE.md では 1.32.1、backlog README では 1.30.1、package.json では 1.32.2 と 3 通りの記述がある。AGENTS.md や CLAUDE.md に書かれた指示はエージェントによく守られるという評価結果を踏まえると、誤った状況の記述はそのままエージェントの判断に影響する。

**同じ事実を手作業で複数の文書に転記している。** PR #14 がマージされたという記述は 8 ファイルにある。backlog README が完了としている T-001 / T-002 / T-010 / T-014 は、各タスクのチェックボックスが未チェックのままである。サブエージェント定義には、connector-sdk が v0.3、ADR の次の番号が 017 と書かれている。PR テンプレートの不変条件 7 は、CLAUDE.md の現在の文言に更新されていない。workers-sdk が避けるよう指示している問題が、そのまま発生している。

**ADR が、決定の記録と経過の記録を兼ねている。** 22 本のうち 12 本に追補があり、ADR-001 には追補が 9 回、日付が 15 種類ある。現在有効な決定内容を知るには、全文(合計 233,787 文字)を読む必要がある。cloudflare/agents の「RFC は決定後に更新しない」とは逆の運用である。

**内部向けの率直な記述が、公開される文書に含まれている。** 実際の秘密情報は見つかっていない。懸念されるのは、次の記述が CLAUDE.md と利用者向け文書(`docs/install.md` など)に分散していることである。T-003 レビューなどで未修正のまま残っている指摘を、`minor-6` や `H1` といった識別子で列挙した記述(`minor-N` が 17 ファイル 59 か所、`H1` が 27 ファイル 63 か所)、商用配布と有償支援に関する論点、承認待ちの項目の一覧、オーナー個人の開発環境に関する記述。公開された ADR やバックログが攻撃に利用された事例は、調査では見つからなかった。したがって、これらの扱いはリスク評価の問題であり、実害が確認されているわけではない。

**外部のコントリビューターを受け入れるための文書がない。** CONTRIBUTING / SECURITY / issue テンプレート / CODEOWNERS がなく、フックによる検査は Claude Code を使わないコントリビューターには適用されない。コミットの 64% はエージェントが作者として記録されており、71% に Co-Authored-By トレーラーが付いている。開発体制はオーナー 1 人とエージェントであり、ASF の推奨の範囲には収まっている。

**OpenAI の社内プロダクトは、leisen に近い構成で成果を報告している。** 設計書・実行計画・技術的負債の一覧をリポジトリに置く点は leisen と同じである。違いは 3 つある。AGENTS.md を約 100 行の目次にとどめていること、文書の鮮度・相互リンク・構造を lint と CI で検査し、エージェントが定期的に修正の PR を出していること、進行中の計画と完了した計画をディレクトリで分けていることである。leisen に不足しているのは、この自動検査と、進行中の文書と完了済みの文書の分離である。また、OpenAI 自身もタスクの状態は Issue Tracker で管理する方式を公開しており(Symphony)、エージェントが GitHub の issue を読める構成であれば、タスクをリポジトリ内のファイルで管理する必要はない。

## 成果物ごとの判断: AGENTS.md は短くし、状態は Issues に移し、ADR は書き換えずに残す

判断基準は 1 つである。**コントリビューターのエージェントが正しく作業するために必要なものはリポジトリに置き、コアチームの進捗と内部の事情はリポジトリの外で管理する。** 文書の配置は、README がすでに示している 3 種類の読者(導入する人 / 設計を理解したい人 / 開発する人)に合わせる。

| 成果物 | 判断 | 保管先と書き方 |
|---|---|---|
| CLAUDE.md の恒久的なルール(不変条件・構成・開発ルール・タスクの進め方、約 4,600 文字) | 残す。AGENTS.md に移す | ルールは `AGENTS.md` に書き、`CLAUDE.md` は `@AGENTS.md` の 1 行にする。バージョン番号・ADR の追補番号・PR 番号は書かない |
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
| 3 | 未決事項と未着手のタスクを issue にし、CLAUDE.md から「現在のフェーズ」を削除する。ルールを AGENTS.md に移す | タスクと未決事項の管理場所(論点 1) | 最も効果が大きい。毎セッション読み込まれる分量が約 3 分の 1 になる |
| 4 | 完了済みの backlog を読み取り専用の履歴にし、README などの進捗の段落を削除し、最初のタグを付ける | 論点 1 | 重複した記載が生じる原因をなくす |
| 5 | ADR の索引を作成し、追補をやめる運用を ADR として記録する。設計書 3 本を 1 本に統合する | ADR の運用(論点 4) | 現在有効な決定を、全文を読まずに確認できる |
| 6 | 検討メモ(`docs/notes/`)・公開チェックリスト・評価結果・未修正の指摘(`minor-N`、`H1`)の一覧を公開リポジトリから外す | 非公開の保管先(論点 2) | 公開される文書を整理する。履歴の書き換えは行わない |
| 7 | 文書の検査を CI に追加する。AGENTS.md の文字数の上限と日付・PR 番号の禁止、ADR の索引の網羅性、リンク切れ、guard の grep による検査 | なし | 再発を防止する。OpenAI の事例が前提としている条件である |
| 8 | CONTRIBUTING.md と AI_POLICY.md を置く。手順をスキルにし、パッケージ別の AGENTS.md を追加する | 外部からのコントリビューションの受け入れ方針(論点 5) | 外部のコントリビューターとそのエージェントが参加するために必要である |

手順 6 で履歴を書き換えないのは、公開後に履歴を書き換えても、既存の clone や fork からは何も削除されないためである。GitHub のドキュメントも、他の利用者の clone からは機密データを削除できず、fork にも残ると説明している ([GitHub Docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository))。リポジトリが現在公開されているかどうかは、棚卸しでは確認できていない。まだ非公開であれば、履歴に含まれる作者のメールアドレスの扱いを、公開前に 1 度だけ決めることができる。CI からエージェントを起動して行う issue のトリアージや重複検出は、ベンダー各社が自社のリポジトリで実施しているが、leisen では外部からの issue が増えるまで導入を見送る。公開された issue の本文を読むエージェントに対して、プロンプトインジェクションが報告されているためである(対象は Gemini CLI、Claude Code Action、Codex Action など。Claude と Codex は既定ではない設定の場合に限られる。[Aikido](https://www.aikido.dev/blog/promptpwnd-github-actions-ai-agents))。手順 7 に関連して、AGENTS.md の指示を変更するときは、同じコミット・同じモデル・同じタスクで変更前後の結果、ツール呼び出し、トークン使用量、コストを比較する方法を OpenAI が提案している ([Maintaining software with the GPT-6 family](https://developers.openai.com/blog/maintaining-software-with-the-gpt-6-family))。

オーナーが決定すべき論点は次の 8 つである。

| # | 論点 | 選択肢 | 推奨 |
|---|---|---|---|
| 1 | タスクと未決事項の管理場所 | GitHub Issues / リポジトリ内の 1 ファイルに集約する / 現状を維持する | Issues。エージェントが issue を読める構成であることが条件である。満たせない場合は 1 ファイルに集約し、他の文書からは参照だけにする |
| 2 | 非公開の保管先を持つか | 持たない / 非公開の別リポジトリ / ローカルのみ | 未修正のセキュリティ指摘(`minor-N`、`H1`)の一覧と事業上の論点に限定して、小規模な非公開リポジトリを持つ。クラウドセッションでは 2 つ目のリポジトリとして追加する必要がある(推論) |
| 3 | 脆弱性の報告窓口と、未修正の指摘を公開する範囲 | GitHub の Private Vulnerability Reporting / メール / 保留を続ける | Private Vulnerability Reporting。追加の契約なしで始められる。なお、curl は 2026-01-31 の報奨金制度の終了時にこの方式へ移行したが、約 1 か月後に HackerOne での受け付けに戻している ([curl](https://daniel.haxx.se/blog/2026/02/25/curl-security-moves-again/))。報告件数が増えた場合は見直す |
| 4 | ADR の運用 | 追補を続ける / 新しい ADR で置き換える / 既存の ADR も書き直す | 新しい ADR で置き換える。既存の 22 本は書き直さず、索引と 1 行要約で現在有効な決定を示す |
| 5 | 外部からのコントリビューションの受け入れ方針 | 受け付けない(codex)/ issue の承認を前提条件にする(goose、cline)/ 制限しない | issue の承認を前提条件にする。ADR の起案は誰でもでき、Accepted にできるのはオーナーだけであることを明記する |
| 6 | AI 利用の開示 | Co-Authored-By を続ける / やめる / 外部のコントリビューターにだけ求める | 続ける。ghostty と同じ形式で、メンテナが AI を利用していることを明記し、外部のコントリビューターには内容の理解と開示を求める。コミットに付くセッション URL の行は第三者が開けないので、残すかどうかを別途決める |
| 7 | AGENTS.md と文書の言語 | 日本語のみ / AGENTS.md と README だけ英語を併記する | 調査では判断の根拠となる資料が得られなかった。想定する導入先に合わせて決める |
| 8 | 完了した計画と評価結果の残し方 | 変更せずにリポジトリに残す / PR と issue にだけ残す / 削除する | backlog は変更せずに残す(コードから参照されているため)。新しい計画と評価結果は PR と issue にだけ残す。複数の PR にまたがる変更で実行計画を書く場合は、Agents SDK と同様に gitignore したローカルの作業ファイルとし、決定事項だけを ADR に記録する |

## 結論

調査で明らかになったのは、エージェントによる開発が進んでいるプロジェクトほど、リポジトリに置く文書を「いつ読んでも内容が正しい文書」に絞っていることである。AGENTS.md のルール、スキル、ADR、現行の設計書がこれにあたる。「特定の時点では正しかった記録」(進捗、計画、評価結果、レビューでの指摘)は、日付と状態が自動的に記録される場所、すなわち issue、PR、コミット、リリースで管理している。すべてをリポジトリに置く leisen の構成は、エージェントにコンテキストを渡すという目的に対しては妥当だった。ただし、この構成が成立するのは、オーナー 1 人とエージェントという閉じた体制で、PR のたびにすべての文書を更新できる間だけである。記述の不一致がすでに生じていることから、その限界は超えている。

leisen は認可と監査を強みとするプロダクトなので、ADR と脅威モデルを公開していること自体は、導入を検討する側にとって価値がある。削除すべきなのは ADR ではなく、ADR や CLAUDE.md に混在している作業の記録である。今回の調査で確認できなかった点が 2 つある。完了済みの計画を残すことがエージェントの作業の成功率を上げるのか下げるのかを測定したデータは見つかっていない。エージェントで開発されたプロジェクトが、公開時に開発プロセスに関する文書をどう再編成したかの事例も見つかっていない。leisen の移行は、その最初の記録の 1 つになりうる。
