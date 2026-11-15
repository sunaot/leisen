# 並行開発(タスク割り当て・排他・依存関係)に関する主張の検証

検証日: 2026-11-15。一次情報(公式ドキュメント、リポジトリ本体)で確認した。

## 検証方法と限界

- リポジトリは `git clone --depth 1` で取得し、ファイルを直接読んだ(実行はしていない)。引用は取得時点の既定ブランチの内容。
  取得コミット: openai/symphony `be10a1b`(2026-09-15)、steveyegge/beads `8cdfa79`(2026-11-13)、steveyegge/gastown `94cc822`(2026-11-12)、github/spec-kit `2ee2b1e`(2026-11-12)、eyaltoledano/claude-task-master `c0c98d3`(2026-04-23)、OpenHands/OpenHands `c255de9`、OpenHands/software-agent-sdk `5e49dda`、pydantic/pydantic-ai `f93bcff`、vercel/next.js `60f1fa82`、zed-industries/zed `24d3772`、PostHog/posthog `ca512d4`(以上 2026-11-15)、block/goose `2365bc5`(2026-11-13)。
- Web ページの引用は、ページ取得ツールが要約モデル経由で返した文言である。code.claude.com の 3 ページ(agent-teams / github-actions / worktrees)は全文が返ったので原文どおり。それ以外(docs.github.com、github.blog、linear.app、cursor.com、anthropic.com、graphite.com)は「原文の引用として返された文」であり、一字一句の照合はできていない。
- 開けなかったもの:
  - `https://openai.com/index/harness-engineering/`(HTTP 403)。二次情報の検索結果しか得られず、引用には使っていない。
  - GitHub Copilot の「issue を Copilot に割り当てる」手順そのもののページ。旧 URL はすべて総合ページ「Starting GitHub Copilot sessions」に転送され、issue 割り当ての詳細ページは開けていない。
  - GitHub API は使っていない。したがって各リポジトリのブランチ保護でマージキューが実際に有効かどうかは確認できていない(ワークフローに `merge_group` トリガーがあるかどうかだけを見た)。
  - beads の作者のブログ記事・CHANGELOG の該当エントリは探していない(リポジトリ内のドキュメントで確認した)。

## 判定一覧

| # | 主張 | 判定 |
|---|------|------|
| 1 | GitHub の issue 割り当ては原子的な claim ではない | CONFIRMED |
| 2 | GitHub に issue 依存関係と sub-issue があり API で使える | CONFIRMED |
| 3 | マージキューの存在と、エージェント利用の多い OSS での採用 | PARTLY CONFIRMED |
| 4 | Claude Code agent teams の共有タスクリスト・ロック・依存・保存先・同一ファイル回避 | CONFIRMED |
| 5 | Copilot / Claude / Linear の起動方法と「1 issue → 1 セッション → 1 ブランチ/PR」 | PARTLY CONFIRMED |
| 6 | spec-kit の `[P]` とフェーズ・依存 | CONFIRMED |
| 7 | claude-task-master の `dependencies` と `next` | CONFIRMED |
| 8 | beads の依存種別・`bd ready`・原子的 claim・Dolt の理由 | CONFIRMED(移転先は未確定) |
| 9 | gastown は Mayor が配車し、worktree と Refinery を使う | CONFIRMED |
| 10 | Symphony の claim・ワークスペース・ブロッカー・リトライ・workpad・別 issue 起票・成熟度 | CONFIRMED(ブロッカーの規則はアダプタ側) |
| 11 | OpenHands の `issue-readiness-check.yml` と `ready-for-dev` | CONFIRMED(両リポジトリにある) |
| 12 | 分割(ファイル所有)・契約先行・フェーズ実行の公開ガイダンス | PARTLY CONFIRMED |
| 13 | 依存は「main にマージ + CI 緑」で解決とみなす/スタック PR | PARTLY CONFIRMED |
| 14 | 作業中に見つけた仕事は別タスクとして起票しリンクする | CONFIRMED |
| 15 | next.js の worktree ツール設定のパス | CONFIRMED |

---

## 1. GitHub の issue 割り当ては原子的な claim ではない — CONFIRMED

- REST「Add assignees to an issue」: "Adds up to 10 assignees to an issue. Users already assigned to an issue are not replaced." 文書化されている応答は 201 のみ。複数の担当者が許され、既存の担当者は置き換えられないので、2 者がそれぞれ自分を追加してもどちらも失敗しない。
  - 追加の挙動: "Only users with push access can add assignees to an issue. Assignees are silently ignored otherwise."
  - https://docs.github.com/en/rest/issues/assignees?apiVersion=2022-11-28
- 条件付きリクエスト: "You can use the values of these headers to make conditional `GET` requests." / "Conditional requests for unsafe methods, such as `POST`, `PUT`, `PATCH`, and `DELETE` are not supported unless otherwise noted in the documentation for a specific endpoint." assignees のページには ETag / If-Match の記述はない。つまり書き込みの compare-and-swap はない。
  - https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api

## 2. GitHub の issue 依存関係と sub-issue — CONFIRMED

- sub-issue: 2025-04-09 GA。"Following our public preview in January, we're thrilled to announce the general availability of sub-issues, issue types, advanced search, and increased item limits in GitHub Projects."
  - https://github.blog/changelog/2025-04-09-evolving-github-issues-and-projects/
  - 上限: "You can add up to 100 sub-issues per parent issue" / "create up to eight levels of nested sub-issues" — https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues
  - REST: `GET/POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues`、`DELETE .../sub_issue`、`GET .../parent`、`PATCH .../sub_issues/priority` — https://docs.github.com/en/rest/issues/sub-issues?apiVersion=2022-11-28
- 依存関係: 2025-08-21 GA。"Dependencies on issues are now generally available!" / "Issue dependencies are fully supported in the API and webhooks"。関係の種類ごとに 50 件まで。
  - https://github.blog/changelog/2025-08-21-dependencies-on-issues/
  - "Issue dependencies let you define issues that are blocked by, or blocking, other work." — https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies
  - REST: `GET/POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by`、`DELETE .../dependencies/blocked_by/{issue_id}`、`GET .../dependencies/blocking` — https://docs.github.com/en/rest/issues/issue-dependencies?apiVersion=2022-11-28
- 注意: GitHub 側は関係を記録・表示するだけで、「ブロックされた issue には着手できない」という強制があるとはどのページにも書かれていない。

## 3. マージキュー — PARTLY CONFIRMED

- 存在と役割は確認: "The merge queue will ensure the pull request's changes pass all required status checks when applied to the latest version of the target branch and any pull requests already in the queue." / "You must use the merge_group event to trigger your GitHub Actions workflow when a pull request is added to a merge queue." / "As pull requests are added to the merge queue, the merge queue ensures that they are merged in a first-in-first-out order."
  - https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
- ワークフローの `merge_group` トリガー(あり):
  - zed: `.github/workflows/run_tests.yml:9`、`danger.yml:5` に `merge_group: {}` — https://github.com/zed-industries/zed/blob/main/.github/workflows/run_tests.yml
  - PostHog: `.github/workflows/desktop-ci.yml:21` に `merge_group:`。`ci-merge-queue-run-traces.yml` というファイルもある — https://github.com/PostHog/posthog/blob/master/.github/workflows/desktop-ci.yml
  - goose: `.github/workflows/ci.yml:10`、`mcp-conformance.yml:10` — https://github.com/block/goose/blob/main/.github/workflows/ci.yml
  - pydantic-ai: `ci.yml:19`、`pr-gates.yml:18` ほか 3 本 — https://github.com/pydantic/pydantic-ai/blob/main/.github/workflows/ci.yml
  - beads: `pr.yml:18`、`pr-risk.yml:15` — https://github.com/steveyegge/beads/blob/main/.github/workflows/pr.yml
- なし: vercel/next.js(`.github/workflows` 全体で 0 件)、OpenHands/OpenHands、OpenHands/software-agent-sdk、steveyegge/gastown、openai/symphony。
- 「PARTLY」の理由: トリガーがあることはワークフローがマージキューに対応していることを示すが、ブランチ保護で実際に有効かは API を使わないと分からない。next.js と OpenHands は該当なし。

## 4. Claude Code agent teams — CONFIRMED

出典はすべて https://code.claude.com/docs/en/agent-teams (名称は現在も "agent teams"。実験的機能で `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` が必要)。

- 共有タスクリストと依存: "The shared task list coordinates work across the team. The lead creates tasks and teammates work through them. Tasks have three states: pending, in progress, and completed. A task can also depend on other tasks and shows as blocked in the task list until they're completed. Teammates don't self-claim a blocked task, but you or the lead can still assign it."
- 割り当ての 2 方式: "**Lead assigns**: tell the lead which task to give to which teammate" / "**Self-claim**: after finishing a task, a teammate picks up the next unassigned, unblocked task on its own"
- ロック: "Task claiming uses file locking to prevent race conditions when multiple teammates try to claim the same task simultaneously."
- 依存の解除: "Claude Code manages task dependencies automatically: when a teammate completes a task that other tasks depend on, it unblocks the dependent tasks without any action from you."
- 保存先(ローカル、git ではない): "Teams and tasks are stored locally under a session-derived name." / "**Team config**: `~/.claude/teams/{team-name}/config.json`" / "**Task list**: `~/.claude/tasks/{team-name}/`. This directory stays on disk after the session ends." / "There is no project-level equivalent of the team config."
- 同一ファイルの回避: "Two teammates editing the same file leads to overwrites. Break the work so each teammate owns a different set of files." また "For sequential tasks, same-file edits, or work with many dependencies, a single session or subagents are more effective."
- 既知の制約(完了は自己申告): "**Task status can lag**: teammates sometimes fail to mark tasks as completed, which blocks dependent tasks."
- 主張の修正点: ブロックされたタスクは「self-claim されない」だけで、リードや人は割り当てられる。

## 5. Copilot / Claude / Linear の起動方法 — PARTLY CONFIRMED

- GitHub Copilot: 現在のドキュメント上の名称は "Copilot cloud agent"(旧 coding agent)。旧 URL は「Starting GitHub Copilot sessions」に転送される。確認できた文: 入口の一覧に "GitHub — issues, agents tab, dashboard, Copilot Chat, new repositories, and failing GitHub Actions runs."、"Copilot will start working on the task in the background."、"Some entry points open a pull request automatically."。制約として "Copilot can only work on one branch at a time and can open one pull request per task."
  - https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/start-copilot-sessions
  - https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent (取得時のページ題は "GitHub Copilot on GitHub.com and GitHub Mobile")
  - 「issue を Copilot に割り当てると draft PR が開く」という手順の原文ページは開けなかった(検索結果の断片でのみ確認)。
- Claude: "Mention `@claude` in a pull request or issue comment to have Claude analyze code, implement changes, and push commits." / "Install the Claude GitHub App to your repository." / "Claude replies in a comment on the same issue or PR and updates it as it works."
  - https://code.claude.com/docs/en/github-actions
  - 「1 issue → 1 ブランチ/PR」と明言する文はこのページにはない。
- Linear: "Delegate issues by assigning the issue to the agent." / "@mention them in comments or descriptions to trigger their functions." — https://linear.app/docs/agents-in-linear
  - "Assigning an issue to your app now sets it as the delegate, not the assignee" / "Sessions are created automatically when an agent is mentioned or delegated an issue." — https://linear.app/developers/agents
  - 「1 セッション = 1 ブランチ/PR」という記述はない(ブランチや PR はエージェント側の実装による)。

## 6. spec-kit の tasks.md — CONFIRMED

`templates/tasks-template.md` — https://github.com/github/spec-kit/blob/main/templates/tasks-template.md

- 18 行目: "- **[P]**: Can run in parallel (different files, no dependencies)"
- 246 行目: "- [P] tasks = different files, no dependencies"
- フェーズ: "## Phase 1: Setup (Shared Infrastructure)" / "## Phase 2: Foundational (Blocking Prerequisites)" / "## Phase 3: User Story 1 - [Title] (Priority: P1)" … / "## Phase N: Polish & Cross-Cutting Concerns"
- 依存(163 行目以降 "## Dependencies & Execution Order"): "**Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories" / "**User Stories (Phase 3+)**: All depend on Foundational phase completion" / "User stories can then proceed in parallel (if staffed)" / "**Polish (Final Phase)**: Depends on all desired user stories being complete"
- 並行の指針(188 行目以降): "All Setup tasks marked [P] can run in parallel" / "Once Foundational phase completes, all user stories can start in parallel (if team capacity allows)"

## 7. claude-task-master — CONFIRMED

- `docs/task-structure.md` 13 行目: "- `dependencies`: IDs of tasks that must be completed before this task (Example: `[1, 2]`)"、217 行目: "- **`dependencies`** (array): IDs of prerequisite tasks that must be completed first"
- 同 95 行目以降: "The `next` command: - Identifies tasks that are pending/in-progress and have all dependencies satisfied - Prioritizes tasks by priority level, dependency count, and task ID"
  - https://github.com/eyaltoledano/claude-task-master/blob/main/docs/task-structure.md
- `docs/command-reference.md` 37 行目: "# Show the next task to work on based on dependencies and status" / `task-master next`
  - https://github.com/eyaltoledano/claude-task-master/blob/main/docs/command-reference.md
- 補足: 排他(claim)の仕組みは見当たらない。最終コミットは 2026-04-23。

## 8. beads — CONFIRMED(移転先は未確定)

- 所在: `https://github.com/steveyegge/beads` で clone できた。README には `github.com/steveyegge/beads` が 3 回、`github.com/gastownhall/beads` が 1 回出てくる。clone が転送されたかどうかは確認していない。
- README — https://github.com/steveyegge/beads/blob/main/README.md
  - 3 行目: "**Distributed graph issue tracker for AI agents, powered by [Dolt](https://github.com/dolthub/dolt).**"
  - 73 行目: "| `bd ready` | List tasks with no open blockers. |"
  - 75 行目: "| `bd update <id> --claim` | Atomically claim a task (sets assignee + in_progress). |"
  - 76 行目: "| `bd dep add <child> <parent>` | Link tasks (blocks, related, parent-child). |"
  - 153 行目以降: "Beads uses Dolt as its database. Two modes: **Embedded (default)** — `bd init`. Dolt runs in-process, data lives in `.beads/embeddeddolt/`, single writer. … **Server** — `bd init --server`. Connects to an external `dolt sql-server` for multiple concurrent writers"
  - 160 行目: "Cross-machine sync uses `bd dolt push` / `bd dolt pull` against `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is an export …"
  - 406 行目: "Beads works without git. The Dolt database is the storage backend"
- 依存種別 — https://github.com/steveyegge/beads/blob/main/docs/core-concepts/index.md
  - "| `blocks` | hard ordering — the blocker must close first | **yes** |" / "| `parent-child` | epic/subtask structure | **indirectly** — a blocked parent blocks its children |" / "| `discovered-from` | provenance — found while working on the parent | no |" / "| `related` | soft association | no |"
  - `docs/core-concepts/dependencies.md`: "When issue-1 is open, issue-2 won't appear in `bd ready`. Once issue-1 is closed, issue-2 unblocks automatically." / "`bd ready` shows issues with no open blocking dependencies:" — https://github.com/steveyegge/beads/blob/main/docs/core-concepts/dependencies.md
- claim の原子性 — https://github.com/steveyegge/beads/blob/main/docs/CLI_REFERENCE.md
  - 1863 行目: "--claim  Atomically claim the issue (sets assignee to you, status to in_progress; idempotent if already claimed by you; …)"
  - 1844 行目以降: "13 when every failure is a stale --if-assignee/--if-status guard (the precondition no longer held, nothing was written — another actor won the race, so retrying the same guard is pointless)."
  - 1825 行目: "--if-assignee string   Only release if still assigned to this assignee (atomic compare-and-swap; …)"
- 作者自身による Dolt の理由 — `docs/architecture/dolt.md` の "## Why Dolt?": "**Native version control** — cell-level diffs and merges, not line-based" / "**Multi-writer support** — server mode enables concurrent agents" / "**Built-in history** — every write creates a Dolt commit" / "**Native branching** — Dolt branches independent of git branches" / "**Single-binary option** — embedded mode for solo users (no server needed)"
  - https://github.com/steveyegge/beads/blob/main/docs/architecture/dolt.md
  - ブログや CHANGELOG での作者の発言は探していない。

## 9. gastown — CONFIRMED

README — https://github.com/steveyegge/gastown/blob/main/README.md

- 中央の調整役: "### The Mayor … Your primary AI coordinator. The Mayor is a Claude Code instance with full context about your workspace, projects, and agents." シーケンス図: "You->>Mayor: Tell Mayor what to build" / "Mayor->>Convoy: Create convoy with beads" / "Mayor->>Agent: Sling bead to agent"。コマンド: "`gt sling <bead-id> <rig>`    # Assign work to agent"
  - `docs/glossary.md`: "Chief-of-staff agent responsible for initiating Convoys, coordinating work distribution, and notifying users of important events." — https://github.com/steveyegge/gastown/blob/main/docs/glossary.md
  - 人が直接 `gt sling` することもできる(README "Manual Convoy Workflow")。いずれにせよ作業者が自分で取りに行く方式ではなく、配る方式。
- worktree: "### Hooks … Git worktree-based persistent storage for agent work. Survives crashes and restarts." `docs/glossary.md`(Polecats): "They work in isolated git worktrees to avoid conflicts."
- マージ: "### Refinery … Per-rig merge queue processor. When polecats complete work via `gt done`, the Refinery batches merge requests, runs verification gates, and merges to main using a Bors-style bisecting queue. Failed MRs are isolated and either fixed inline or re-dispatched."
- 配車の上限: "Config-driven capacity governor for polecat dispatch. … Default is direct dispatch; set `scheduler.max_polecats` to enable deferred dispatch with the daemon."

## 10. OpenAI Symphony — CONFIRMED(ブロッカーの規則はアダプタ側)

- 成熟度:
  - `README.md`: "> Symphony is a low-key engineering preview for testing in trusted environments." / "### Option 2. Use our experimental reference implementation" — https://github.com/openai/symphony/blob/main/README.md
  - `SPEC.md` 3 行目: "Status: Draft v1 (language-agnostic)"
  - `elixir/README.md` 7 行目: "> Symphony Elixir is prototype software intended for evaluation only and is presented as-is."
- 単一の権限と claim — `SPEC.md` — https://github.com/openai/symphony/blob/main/SPEC.md
  - 637 行目: "The orchestrator is the only component that mutates scheduling state."
  - 7.1(642 行目以降): "This is not the same as tracker states (`Todo`, `In Progress`, etc.). This is the service's internal claim state." 状態は `Unclaimed` / `Claimed`("Orchestrator has reserved the issue to prevent duplicate dispatch.")/ `Running` / `RetryQueued` / `Released`。
  - 7.4(727 行目): "The orchestrator serializes state mutations through one authority to avoid duplicate dispatch." / "`claimed` and `running` checks are REQUIRED before launching any worker." / "Restart recovery is tracker-driven and filesystem-driven (without a durable orchestrator DB)."
  - 8.2: "An issue is dispatch-eligible only if all are true: … Its state is in `active_states` and not in `terminal_states`. Its adapter-provided `dispatchable` value is `true`. … It is not already in `running`. It is not already in `claimed`. Global concurrency slots are available. Per-state concurrency slots are available."
- 同時実行数: 8.3 "`available_slots = max(max_concurrent_agents - running_count, 0)`"、既定 "`agent.max_concurrent_agents`: integer, default `10`"、状態別 "`max_concurrent_agents_by_state`"。
- issue ごとの隔離ワークスペース: 1 章 "creates an isolated workspace for each issue, and runs a coding agent session for that issue inside the workspace." / 9.1 "Per-issue workspace path: `<workspace.root>/<workspace_key>`" / "Workspaces are reused across runs for the same issue." / "Invariant 1: Run the coding agent only in the per-issue workspace path."
- ブロッカー: SPEC 本体は判定をアダプタに委ねる。"`blocked_by` (list of blocker refs) - Best-effort provider metadata." / "`dispatchable` (boolean) - REQUIRED adapter-derived eligibility for provider-specific rules that the generic scheduler cannot infer safely, such as assignment, board membership, or blocker semantics." / "The orchestrator MUST NOT inspect provider payloads, … or branch on provider-specific blocker, board, transition, or comment semantics."
  - Linear アダプタの規則 — `elixir/README.md` 226 行目: "Dispatchability: the adapter marks an issue dispatchable only when optional assignee routing matches and a `Todo` issue has no non-terminal blocker." — https://github.com/openai/symphony/blob/main/elixir/README.md
  - 実装 `elixir/lib/symphony_elixir/linear/client.ex` 496〜513 行目: `normalize_state_name(state_name) == "todo" and Enum.any?(blockers, fn %{state: blocker_state} … -> not terminal_state?(blocker_state); _ -> true end)` — https://github.com/openai/symphony/blob/main/elixir/lib/symphony_elixir/linear/client.ex
  - つまり「未解決のブロッカーがある issue は配車しない」は `Todo` 状態の issue に限った規則で、解決の基準はブロッカーが終端状態(Done など)にあること。Jira アダプタも同種("issues in Jira's `new` status category wait until blockers reach configured terminal states, while in-progress categories keep running.")。
- リトライ: 8.4 "Failure-driven retries use `delay = min(10000 * 2^(attempt - 1), agent.max_retry_backoff_ms)`."(既定の上限 300000 ms)。正常終了後も "the orchestrator still schedules a short continuation retry"。
- workpad — `elixir/WORKFLOW.md` — https://github.com/openai/symphony/blob/main/elixir/WORKFLOW.md
  - 86 行目: "- Treat a single persistent Linear comment as the source of truth for progress."
  - 281 行目: "- Use exactly one persistent workpad comment (`## Codex Workpad`) per issue."
- 範囲外の発見(89 行目以降): "- When meaningful out-of-scope improvements are discovered during execution, file a separate Linear issue instead of expanding scope. The follow-up issue must include a clear title, description, and acceptance criteria, be placed in `Backlog`, be assigned to the same project as the current issue, link the current issue as `related`, and use `blockedBy` when the follow-up depends on the current issue."
- ワークフロー例の設定: `active_states: Todo / In Progress / Merging / Rework`、`max_concurrent_agents: 10`、`after_create` で `git clone --depth 1`(worktree ではなく issue ごとの clone)。

## 11. OpenHands の `issue-readiness-check.yml` — CONFIRMED(両リポジトリにある)

- OpenHands/OpenHands — https://github.com/OpenHands/OpenHands/blob/main/.github/workflows/issue-readiness-check.yml
  - "name: Ready-for-dev Label Policy" / "# The issue-triage automation and repository writers may grant ready-for-dev. # Labels from any other actor are removed." 付与者の権限が `write|maintain|admin` でなければ `gh issue edit … --remove-label ready-for-dev`。
- OpenHands/software-agent-sdk — https://github.com/OpenHands/software-agent-sdk/blob/main/.github/workflows/issue-readiness-check.yml
  - "# Granting ready-for-dev requires write, maintain, or admin permission, even for bots. # This workflow checks permission, not issue content."
- ラベルの意味 — OpenHands/OpenHands `.github/pull_request_template.md` 31 行目以降: "Required. The linked issue must carry the `ready-for-dev` label, which means it has clear acceptance criteria (and, for bugs, reproduction evidence). If no such issue exists yet, open one using the Bug or Feature Request template and wait for it to be labeled `ready-for-dev` before opening this PR."
  - https://github.com/OpenHands/OpenHands/blob/main/.github/pull_request_template.md
- 注意: ワークフロー名は readiness check だが、中身は「誰がラベルを付けられるか」の検査で、issue の内容は見ていない。

## 12. 分割・契約先行・フェーズ実行のガイダンス — PARTLY CONFIRMED

- (a) ファイル/モジュール所有での分割 — 確認。
  - Claude Code: "Two teammates editing the same file leads to overwrites. Break the work so each teammate owns a different set of files." / "**New modules or features**: teammates can each own a separate piece without stepping on each other" — https://code.claude.com/docs/en/agent-teams
  - spec-kit: "[P] tasks = different files, no dependencies"
  - Anthropic(Nicholas Carlini、2026-02-05)は逆の例: 独立した失敗テストが多いと並行化しやすいが、"compiling the Linux kernel is one giant task" ではエージェントが同じバグに当たって互いの修正を上書きした。GCC を基準にして対象ファイルを分けることで並行化した。調整役は置いていない("I don't use an orchestration agent.")。"If two agents try to claim the same task, git's synchronization forces the second agent to pick a different one." / "Merge conflicts are frequent, but Claude is smart enough to figure that out." — https://www.anthropic.com/engineering/building-c-compiler
- (b) インターフェース/契約を先に決める — ベンダー公式の明文は見つからなかった。
  - 近いもの: spec-kit のテンプレートは `contracts/` を前提物に挙げ("**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/")、共有基盤を先に済ませる("Phase 2: Foundational (Blocking Prerequisites)"、"BLOCKS all user stories")。
  - 「1 ファイル 1 所有者 → 契約を作る → 並行開始」と明記しているのはコミュニティのスキル(wshobson/agents の parallel-feature-development など)で、検索結果の要約でしか見ていない。
- (c) フェーズ/階層での実行 — 確認。
  - spec-kit のフェーズ(6 を参照)。
  - Cursor「Scaling long-running autonomous coding」(Wilson Lin、2026-01-14): "Our initial approach gave agents equal status and let them self-coordinate through a shared file." ロックは保持しすぎ・解放忘れで "Twenty agents would slow down to the effective throughput of two or three, with most time spent waiting." 楽観的並行制御に替えても "With no hierarchy, agents became risk-averse." / "No agent took responsibility for hard problems or end-to-end implementation." その後プランナーとワーカーに分け、ワーカーは "They don't coordinate with other workers or worry about the big picture."、"At the end of each cycle, a judge agent determined whether to continue, then the next iteration would start fresh."、"We initially built an integrator role for quality control and conflict resolution" は取り除いた。 — https://cursor.com/blog/scaling-agents
  - Cursor「Towards self-driving codebases」(2026-02-05): "Locking also caused too much contention." / "A root planner owns the entire scope of the user's instructions." / サブプランナーは "fully own the delegated narrow slice." / 統合役は "It quickly became an obvious bottleneck." / "a final 'green' branch is needed"。 — https://cursor.com/blog/self-driving-codebases
  - OpenAI の harness engineering の記事は開けなかった(403)。

## 13. 依存の解決基準とスタック PR — PARTLY CONFIRMED

- 「依存はエージェントの自己申告ではなく、main へのマージと CI の緑で解決とみなす」と規範として書いた公開ガイダンスは見つからなかった。実装としてそうなっている例はある。
  - gastown: `docs/design/polecat-lifecycle-patrol.md` 107 行目 "| Refinery merges | Squash-merge to main, closes MR and source issue |"、641 行目 "| Merge queue | Refinery | Squash-merge, close MR and issue, convoy check |"。issue を閉じるのはマージした Refinery で、beads の依存はブロッカーが閉じたときに外れる。未実装の項目として "| Refinery notifies mayor after merge | … | Unblocks dependent work dispatch |"。 — https://github.com/steveyegge/gastown/blob/main/docs/design/polecat-lifecycle-patrol.md
  - Symphony: ブロッカーは終端状態で解決(10 を参照)。`WORKFLOW.md`: "When the issue is in `Merging`, open and follow `.codex/skills/land/SKILL.md`, then run the `land` skill in a loop until the PR is merged." / "After merge is complete, move the issue to `Done`." Human Review に進む条件にも "PR checks are green, branch is pushed, and PR is linked on the issue." がある。
  - 反対の例(自己申告): Claude Code agent teams は teammate がタスクを完了にすると依存が外れ、"teammates sometimes fail to mark tasks as completed, which blocks dependent tasks." と制約に書かれている。
- スタック PR — 確認。
  - pydantic-ai `PLAN.md` 3 行目: "> Status: **design proposal for maintainer alignment**. No code yet. Implementation lands as stacked follow-up PRs once §7 is settled."、558 行目: "## 6. Roadmap: stacked PRs, each independently mergeable"。項目 1 のテスト: "N concurrent claimers produce exactly one winner; concurrent completions unblock dependents exactly once"。 — https://github.com/pydantic/pydantic-ai/blob/main/PLAN.md
  - Graphite GT MCP: "With large AI-generated diffs, stacking is more essential than ever." / "allows AI agents to automatically create stacked PRs" / "Stacking breaks AI output into clear, sequential chunks."(ベータ) — https://graphite.com/docs/gt-mcp
  - next.js にはスタックを前提にした CI がある: `.github/workflows/pr_stack_optimizer.yml` "# Avoid running the full CI concurrently on every PR in a branch-based stack." — https://github.com/vercel/next.js/blob/canary/.github/workflows/pr_stack_optimizer.yml

## 14. 作業中の発見は別タスクとして起票する — CONFIRMED

- Symphony `elixir/WORKFLOW.md` 89 行目以降と 284 行目以降(10 を参照): "If out-of-scope improvements are found, create a separate Backlog issue rather than expanding current scope, and include a clear title/description/acceptance criteria, same-project assignment, a `related` link to the current issue, and `blockedBy` when the follow-up depends on the current issue."
- beads: `discovered-from` 依存種別("provenance — found while working on the parent"、ready 判定には影響しない)。`docs/core-concepts/issues.md` 97 行目: "# Discovered-from (found during work)" / `bd create "Found bug" --deps discovered-from:bd-42` — https://github.com/steveyegge/beads/blob/main/docs/core-concepts/issues.md
- gastown `docs/concepts/molecules.md` 132 行目: "4. **File discovered work** — `bd create` for bugs found, don't fix them yourself" — https://github.com/steveyegge/gastown/blob/main/docs/concepts/molecules.md

## 15. next.js の worktree ツール設定 — CONFIRMED

既定ブランチは `canary`。

- `conductor.json` — https://github.com/vercel/next.js/blob/canary/conductor.json
  - `"scripts": {"setup": "./.conductor/scripts/setup.sh", "run": "./.conductor/scripts/run.sh"}`、`"worktree": {"default_branch": "canary"}`、`"recommendations": {"parallel_agents": 3, …}`
- `.conductor/README.md`、`.conductor/scripts/setup.sh`、`.conductor/scripts/run.sh` — https://github.com/vercel/next.js/blob/canary/.conductor/README.md
  - "Conductor is a macOS application that orchestrates multiple Claude Code agents in parallel. Each agent gets its own isolated git worktree"
- `.cursor/worktrees.json` — https://github.com/vercel/next.js/blob/canary/.cursor/worktrees.json
  - `{"setup-worktree": ["pnpm install", "pnpm build"]}`
- `.codex/environments/next.toml` — https://github.com/vercel/next.js/blob/canary/.codex/environments/next.toml
  - "# THIS IS AUTOGENERATED. DO NOT EDIT MANUALLY"、`cd "$CODEX_WORKTREE_PATH"` / `pnpm install --frozen-lockfile` / `pnpm build --filter=next`
- 参考: PostHog にも `.codex/environments/environment.toml` と `.codex/config.toml` がある。
