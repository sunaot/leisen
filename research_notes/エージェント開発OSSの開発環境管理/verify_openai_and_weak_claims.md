# Verification notes: OpenAI practices (Group A) and weakly sourced claims (Group B)

Checked 2026-11-15. Verdicts: CONFIRMED / PARTLY CONFIRMED / CONTRADICTED / NOT FOUND.

## Access limits (read this first)

- **openai.com: every fetch returned HTTP 403** (`/index/harness-engineering/`, `/index/open-source-codex-orchestration-symphony/`, the `ja-JP` variant). web.archive.org is not fetchable from this environment. So the three openai.com articles (Harness engineering, Symphony, Unlocking the Codex harness) were **not opened**. Their existence, titles, dates and authors come from search-engine snippets of openai.com; their content comes from secondary coverage, labelled below.
- **developers.openai.com and its mirror learn.chatgpt.com were fetchable.** Pages were read through a fetch tool that summarises and returns short quotes, so quotes are short fragments, not full paragraphs. Dates and authors are shown only on the learn.chatgpt.com mirror, not on developers.openai.com.
- **apiiro.com: HTTP 403** (blog index and the post). Apiiro figures are from secondary coverage only.
- **nvd.nist.gov** returned only a page shell (JavaScript-rendered). CVE details are from Anthropic's GitHub security advisories instead.
- **git.kernel.org: HTTP 403.** The kernel doc was read from a shallow sparse clone of `github.com/torvalds/linux` instead.
- Repos were cloned with `git clone --depth 1` and only read, nothing executed:
  - `openai/symphony` @ `be10a1b79df723d6d7612b5651c8522704dafb2e` (2026-09-15)
  - `openai/openai-agents-python` @ `64fbde5d02b42ae5f9db668eb0184cdb3fc9d775` (2026-11-11)
  - `openai/openai-agents-js` @ `8aeac0eb255dbdff9adcdc65a0eae638cbcea74f` (2026-11-12)
  - `torvalds/linux` @ `fa2933aac170dd19c6a7f0d7b81a8f537e40915c` (2026-11-15), `Documentation/process` only

---

# Group A

## A1. "Harness engineering: leveraging Codex in an agent-first world"

Primary page not opened (403): https://openai.com/index/harness-engineering/ . Search snippets of openai.com give: published 2026-02-11, author Ryan Lopopolo.

| Sub-claim | Verdict | Evidence |
|---|---|---|
| Article exists, 2026-02-11 | CONFIRMED (snippet level) | Search snippet of openai.com: Ryan Lopopolo, February 11, 2026. The `openai/symphony` README links to it as "harness engineering". |
| (a) Repo layout (AGENTS.md, ARCHITECTURE.md, docs/design-docs/, docs/exec-plans/active, completed, tech-debt-tracker.md, docs/generated/, docs/product-specs/, docs/references/, PLANS.md ...) | PARTLY CONFIRMED (secondary only) | Not seen in the article itself. Several third-party write-ups and templates reproduce the same skeleton (AGENTS.md + ARCHITECTURE.md + `docs/` with `design-docs/`, `exec-plans/{active,completed}`, `tech-debt-tracker.md`, `product-specs/`, `generated/`). ai-playbooks review lists the `docs/` categories in prose. `docs/references/` and root `PLANS.md` were not individually confirmed by any source I opened. |
| (b) One big AGENTS.md failed; ~100-line AGENTS.md as table of contents | CONFIRMED (secondary + snippet) | Search snippet of the openai.com page: "We tried the "one big AGENTS.md" approach." ai-playbooks review: AGENTS.md is "(~100 lines)" and "functions as a table of contents pointing into a structured `docs/` tree." The Neuron explainer reports the same. |
| (c) Linters/CI validate docs; doc-gardening agent opens fix-up PRs | CONFIRMED (secondary) | ai-playbooks: "Doc freshness is enforced mechanically via linters, CI jobs, and a recurring "doc-gardening" agent." InfoQ: cross-linked design and architecture docs enforced with linters and CI validation. Search summary: the doc-gardening agent scans for stale documentation and opens fix-up pull requests. |
| (d) ~1M lines, ~1,500 PRs, ~five months, started with three engineers | CONFIRMED (snippet + secondary) | Search snippet of openai.com: roughly 1,500 pull requests opened and merged with a small team of three engineers driving Codex; "a million lines of code". InfoQ: "roughly a million lines of code", five-month internal experiment. Secondary summaries add that the team grew from three to seven (not verified against the article). |
| (e) Ephemeral lightweight plans for small changes vs execution plans with progress and decision logs checked in | NOT FOUND in anything I could open | No source I opened quotes this passage. ai-playbooks says only "Plans are first-class, checked-in artifacts." The claim is plausible and matches the Cookbook ExecPlans recipe (A5), but it is unverified here because the article is blocked. |

Secondary URLs:
- https://ai-playbooks.pages.dev/reviews/harness-engineering-leveraging-codex-in-an-agent-first-world (summary, evaluated 2026-05-07)
- https://www.infoq.com/news/2026/02/openai-harness-engineering-codex/
- https://www.theneuron.ai/explainer-articles/openais-harness-engineering-playbook-how-to-ship-1m-lines-of-code-without-writing-any/
- https://martinfowler.com/articles/exploring-gen-ai/harness-engineering.html (2026-04-02, Birgitta Böckeler; quotes the article's conclusion only)

## A2. Symphony (article + openai/symphony repo)

Article not opened (403): https://openai.com/index/open-source-codex-orchestration-symphony/ . Search snippet: 2026-04-27, by Alex Kotliarskyi, Victor Zhu, Zach Brock. Repo claims below are from the clone (primary).

| Sub-claim | Verdict | Evidence |
|---|---|---|
| Article exists, 2026-04-27 | CONFIRMED (snippet level) | Search snippet of openai.com; Help Net Security coverage dated 2026-04-28; IT Brief 2026-04-29. |
| Issue tracker (Linear) as unit of work | CONFIRMED, with an update | `SPEC.md` (2,312 lines) §1: "Symphony is a long-running automation service that continuously reads work from a configured issue tracker, creates an isolated workspace for each issue, and runs a coding agent session for that issue inside the workspace." README: "Symphony monitors a Linear board for work and spawns agents to handle the tasks." **Update:** the current repo is no longer Linear-only. `elixir/README.md`: "included adapters: Linear, GitHub Issues, Jira Cloud, Asana, and GitLab". |
| Per-issue isolated workspaces | CONFIRMED | `SPEC.md`: "It isolates agent execution in per-issue workspaces so agent commands run only inside per-issue workspace directories." |
| Repo-owned WORKFLOW.md | CONFIRMED | `SPEC.md`: "It keeps the workflow policy in-repo (`WORKFLOW.md`) so teams version the agent prompt and runtime settings with their code." and "Load runtime behavior from a repository-owned `WORKFLOW.md` contract." |
| SPEC.md | CONFIRMED | `SPEC.md`, 2,312 lines, "Status: Draft v1 (language-agnostic)". |
| Example WORKFLOW.md: single tracker comment "Codex Workpad" | CONFIRMED | `elixir/WORKFLOW.md` (329 lines): "Treat a single persistent Linear comment as the source of truth for progress." / "Use that single workpad comment for all progress and handoff notes; do not post separate "done"/summary comments." / "Search existing comments for a marker header: `## Codex Workpad`." |
| Example WORKFLOW.md: file separate issues for out-of-scope improvements | CONFIRMED | `elixir/WORKFLOW.md` lines 89-94: "When meaningful out-of-scope improvements are discovered during execution, file a separate Linear issue instead of expanding scope. The follow-up issue must include a clear title, description, and acceptance criteria, be placed in `Backlog`, be assigned to the same project as the current issue, link the current issue as `related`, and use `blockedBy` when the follow-up depends on the current issue." |
| Elixir implementation labelled experimental/preview | CONFIRMED | README: "Symphony is a low-key engineering preview for testing in trusted environments." and "Option 2. Use our experimental reference implementation". `elixir/README.md`: "Symphony Elixir is prototype software intended for evaluation only and is presented as-is. We recommend implementing your own hardened version based on `SPEC.md`." |
| First built inside an internal product repo, then extracted as a spec | PARTLY CONFIRMED (secondary only) | Not in the repo. IT Brief (2026-04-29) reports: an early prototype "ran in tmux and polled Linear while spawning sub-agents for new work"; later iterations were folded into an internal repository "designed to support agent-led development"; OpenAI then made it a standalone spec and "asked Codex to implement it in Elixir". Also: "it does not plan to maintain Symphony as a standalone product." "Internal *product* repo" specifically is not confirmed. |

URLs:
- https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/README.md
- https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/SPEC.md
- https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/elixir/WORKFLOW.md
- https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/elixir/README.md
- Secondary: https://itbrief.co.uk/story/openai-launches-symphony-for-coding-agent-workflows , https://the-decoder.com/openai-says-human-attention-is-the-bottleneck-so-it-built-a-system-to-let-agents-manage-themselves/ (2026-05-04)

Other repo facts: skills live in `.codex/skills/` (commit, debug, land, linear, pull, push, release); `elixir/AGENTS.md` is 76 lines; there is no root AGENTS.md or PLANS.md; no committed plan files (only `docs/symphony-smoke-*.md`).

## A3. "Using skills to accelerate OSS maintenance" + openai-agents-python / openai-agents-js

Article opened (primary): https://developers.openai.com/blog/skills-agents-sdk . Date and author (2026-03-09, Kazuhiro Sera) are shown on the mirror https://learn.chatgpt.com/blog/skills-agents-sdk .

| Sub-claim | Verdict | Evidence |
|---|---|---|
| Article exists, 2026-03-09 | CONFIRMED | Mirror shows March 9, 2026, Kazuhiro Sera. |
| Merged PRs 316 → 457 | CONFIRMED | "Between December 1, 2025 and February 28, 2026, the two repos merged 457 PRs, up from 316 in the previous three months". Per repo: Python 182 → 226, TypeScript 134 → 231. Comparison period 2025-09-01 to 2025-11-30. |
| AGENTS.md present, size | CONFIRMED | python: `AGENTS.md` 106 lines / 16,627 bytes. js: `AGENTS.md` 186 lines / 23,927 bytes. In both, `CLAUDE.md` is a symlink to `AGENTS.md`. Note the lines are very long: the files are short in line count but not in bytes. |
| PLANS.md present, size | CONFIRMED | python: `PLANS.md` 100 lines / 5,485 bytes. js: `PLANS.md` 146 lines / 14,243 bytes. |
| `.agents/skills/` | CONFIRMED | python (14): code-change-verification, docs-sync, examples-run-analysis, final-release-review, implementation-final-review, implementation-kickoff, implementation-strategy, maintainer-review, openai-knowledge, pr-draft-summary, release-candidate-prep, runtime-behavior-probe, sensitive-logging-audit, test-coverage-improver. js (15): changeset-validation, code-change-verification, docs-sync, examples-run-analysis, final-release-review, implementation-final-review, implementation-kickoff, implementation-strategy, maintainer-review, openai-knowledge, pnpm-upgrade, pr-draft-summary, runtime-behavior-probe, sensitive-logging-audit, test-coverage-improver. Both also have `.agents/references/`. **The current lists differ from the article's** (article: python had 8 including `examples-auto-run`; js added `changeset-validation`, `integration-tests`, `pnpm-upgrade`). |
| AGENTS.md restricts branch/commit/push/PR | CONFIRMED, and stricter than "without explicit permission" for push/PR | python `AGENTS.md` line 5: "Work in the current checkout and branch. Creating or switching branches or worktrees requires explicit approval for that action, including when a skill recommends it. Commit only when authorized; prefer small, focused commits with concise imperative messages. Never push, open a PR, or otherwise mutate GitHub." js `AGENTS.md` line 158: "Stay in the current checkout and branch unless a Git state change is explicitly authorized. ... Commit only when authorized, using Conventional Commits. Never push, open a PR, or otherwise mutate GitHub." So branch and commit need explicit authorization; push and PR are flatly prohibited. The article itself says nothing about these restrictions. |
| PLANS.md: when to write an ExecPlan | CONFIRMED | python `PLANS.md`: "Required for multi-step or multi-file work, new features, refactors, or tasks expected to take more than about an hour." / "Optional for trivial fixes (typos, small docs), but if you skip it for a substantial task, state the reason in your response." js `AGENTS.md` line 81: "When writing complex features or significant refactors, use an ExecPlan (as described in PLANS.md) from design to implementation. Store each ExecPlan file under `plans/` with a descriptive name". |
| PLANS.md sections (Progress, Decision Log, Outcomes & Retrospective) | CONFIRMED | python `PLANS.md` "Living Sections (must be present and maintained)": "Progress: checkbox list with timestamps", "Surprises & Discoveries", "Decision Log: each decision with rationale and date/author", "Outcomes & Retrospective: what was achieved, remaining gaps, and lessons learned." js skeleton has the same four sections. |
| Actual plan files or backlog committed? | CONTRADICTED (none committed) | No `plans/` directory or backlog file is tracked in either repo. `plans/` is git-ignored in both: python `.gitignore` lines 163-164 (`# execplans` / `plans/`), js `.gitignore` lines 19-20 (`# ExecPlans` / `plans/`). ExecPlans are local working files, not shared artifacts. |
| Article mentions PLANS.md / ExecPlans | NOT FOUND | The article does not mention PLANS.md or ExecPlans. |

URLs:
- https://github.com/openai/openai-agents-python/blob/64fbde5d02b42ae5f9db668eb0184cdb3fc9d775/AGENTS.md
- https://github.com/openai/openai-agents-python/blob/64fbde5d02b42ae5f9db668eb0184cdb3fc9d775/PLANS.md
- https://github.com/openai/openai-agents-python/blob/64fbde5d02b42ae5f9db668eb0184cdb3fc9d775/.gitignore
- https://github.com/openai/openai-agents-python/tree/64fbde5d02b42ae5f9db668eb0184cdb3fc9d775/.agents/skills
- https://github.com/openai/openai-agents-js/blob/8aeac0eb255dbdff9adcdc65a0eae638cbcea74f/AGENTS.md
- https://github.com/openai/openai-agents-js/blob/8aeac0eb255dbdff9adcdc65a0eae638cbcea74f/PLANS.md
- https://github.com/openai/openai-agents-js/blob/8aeac0eb255dbdff9adcdc65a0eae638cbcea74f/.gitignore
- https://github.com/openai/openai-agents-js/tree/8aeac0eb255dbdff9adcdc65a0eae638cbcea74f/.agents/skills

## A4. Five OpenAI materials

Existence, titles and dates:

| Material | Exists? | Date / author | Source |
|---|---|---|---|
| "Unlocking the Codex harness: how we built the App Server" | CONFIRMED (snippet level; page 403) | 2026-02-04, Celia Chen | https://openai.com/index/unlocking-the-codex-harness |
| "Codex as a platform: build on the open agent harness" | CONFIRMED (opened) | 2026-08-19, Nicolas Bonamy and Derrick Choi | https://developers.openai.com/blog/codex-as-a-platform (date on https://learn.chatgpt.com/blog/codex-as-a-platform) |
| "Rethinking skills and prompts for GPT-6 Astra" | CONFIRMED (opened) | Author Eric Provencher per The Decoder. **Date not shown on any page I opened**; The Decoder covered it on 2026-09-12, which is consistent with 2026-09-11 but does not prove it. | https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra |
| "Maintaining software with the GPT-6 family" | CONFIRMED (opened) | 2026-10-14, Rodrigo Roim | https://developers.openai.com/blog/maintaining-software-with-the-gpt-6-family (date on the learn.chatgpt.com mirror) |
| "Securing persistent agents like OpenClaw at OpenAI" | CONFIRMED (opened) | 2026-11-12, Kevin S Lin | https://developers.openai.com/blog/securing-persistent-agents-like-openclaw-at-openai (date on the learn.chatgpt.com mirror) |

Model names: "GPT-6 Astra", "GPT-6.1 Sol", "GPT-5.6 Sol" and "Luna" all appear in these OpenAI pages. They exist as named in the claim.

Content claims:

**(i) Long skill descriptions / always-loaded marginal docs / heavy verification for trivial changes are counterproductive with newer models — CONFIRMED**, source is "Rethinking skills and prompts for GPT-6 Astra":
- "many descriptions are far too long, and when you add too many skills, Codex starts shortening their descriptions to fit." / "The model ends up seeing less of each description, making it harder to know which skill to pick."
- "Requiring a stack of docs or a full repo map before every edit is excessive for a typo fix." / "Prompting the model to read files before every edit is a great way to burn context and slow work down."
- "Previous models needed encouragement to run tests and check their work." / "GPT-6 Astra does that on its own, so the same instructions can lead to unnecessary testing."
- Also: "you should frequently revisit each instruction and ask yourself whether it's still needed."
- Nuance: the testing point is about redundant test reminders causing unnecessary runs, not literally "heavy verification for trivial changes"; the "typo fix" example belongs to the mandatory-reading point.

**(ii) Evaluate a single AGENTS.md instruction by replaying the same task on the same repo state and model before/after — CONFIRMED**, source is "Maintaining software with the GPT-6 family", section "Improving agentic context". It is a suggested prompt to give Codex, not a reported experiment with results:
- "Replay that same prompt twice from the same repository snapshot and model:" (once with the instruction unchanged, once with only that instruction removed or fixed)
- "Compare task quality, agent behavior, tool calls, token usage, runtime, and cost."
- "Show the instruction and whether updating it helped."
- This is **not** in the "Rethinking skills" post. If the summary attributes it there, the attribution is wrong.

**(iii) Trusted control layer vs sandboxed agent runtime, credential broker, separate agent identity — CONFIRMED**, source is "Securing persistent agents like OpenClaw at OpenAI":
- "In order to secure persistent agents, we needed to isolate trusted deterministic logic from un-trusted LLM execution."
- "treat the gateway, the component that configured the agent, as trusted deterministic code" / "Agents, the environment they execute in, and the code they write are considered untrusted."
- "we manage secrets through a credential broker so secrets are not visible to the agent"
- Heading "Split agent identity from user identity"; "each agent has a unique identity that is associated with a ChatGPT Service Account"
- "For our OpenClaw deployment, we used the built-in sandbox from the codex harness."
- Also: LLM-based auto-review ("we reserve human attention for high value approvals") and "we log everything - every configuration change on the control plane and all turns from the agent."

"Codex as a platform" does **not** discuss AGENTS.md, skills, instruction evaluation, credentials or agent identity. It covers `codex exec` / Codex SDK / app-server and says the harness can "enforce configured sandbox and approval policies". "Unlocking the Codex harness" content was not opened; the snippet describes the App Server as a bidirectional JSON-RPC API, with nothing on (i)-(iii).

Secondary: https://the-decoder.com/gpt-6-astra-needs-leaner-prompts-and-fewer-guardrails-openai-recommends/ (2026-09-12)

## A5. Cookbook ExecPlans article

**CONFIRMED: archived.** https://developers.openai.com/cookbook/articles/codex_exec_plans — title "Using PLANS.md for multi-hour problem solving". Banner: "This recipe is archived and may reference outdated models or APIs." No date or author shown on the page.

What it says:
- Add a rule to `AGENTS.md` telling the agent when to write a plan, and a `PLANS.md` defining the plan. Suggested rule: "use an ExecPlan (as described in .agent/PLANS.md) from design to implementation."
- The PLANS.md is "very similar to one that has enabled Codex to work for more than seven hours from a single prompt." Recommends `gpt-5.2-codex`.
- "Every ExecPlan must be fully self-contained." / "it should always be possible to restart from _only_ the ExecPlan and no other work."
- Living sections Progress, Surprises & Discoveries, Decision Log, Outcomes & Retrospective "are not optional". "Every stopping point must be documented here." (Progress). "record decisions in a log in the spec for posterity".
- The js repo's `PLANS.md` is essentially this text (same headings and wording); the python repo's is a condensed rewrite.

---

# Group B

## B1. Copybara: importing external PRs back into the internal repo is fragile — PARTLY CONFIRMED

Supported by first-hand docs and user reports, but there is no general primary statement that it is "fragile". The evidence shows specific failure modes.

- OpenXLA "Copybara quirks" (project doc, Google-run repo): "PRs are not merged directly, they are imported to the Google internal repo where they undergo additional testing"; "sometimes seemingly normal changes can break internally in surprising way."; "there's no guarantee that the diff will be identical (for example, Copybara applies formatting on import)."; "Copybara won't mark the PR as merged, it will close the PR and separately apply a commit." https://openxla.org/xla/copybara
- google/copybara issue #107 "First time importing pull request from public to private" (2019-11-27, still open): "Copybara obviously cannot find parent commit."; using the latest master as parent overwrote newer private code with old public code. Maintainer: smart_prune "usage is not implemented for git.destination." A contributor later added it in PR #112. https://github.com/google/copybara/issues/107
- copybara-discuss, "Persistent issues with Copybara picking the wrong base" (2026-03-11): "This is usually the wrong behavior, and results in the first commit imported also undoing all changes since release." No maintainer reply visible. https://groups.google.com/g/copybara-discuss/c/_FKHC4VF3QM

Suggested wording for the report: PR import works but needs baseline tracking and reversible transforms; known problems are wrong-baseline imports, diffs that differ after import, and PRs shown as closed instead of merged.

## B2. History rewriting does not remove data from existing clones/forks/cached views — CONFIRMED

GitHub Docs, "Removing sensitive data from a repository": https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository
- "You cannot remove sensitive data from other users' clones of your repository"
- "If the commit that introduced the sensitive data exists in any forks, it will continue to be accessible there."
- "If you only rewrite your history and force push it, the commits with sensitive data may still be accessible elsewhere:" ... "Directly via their SHA-1 hashes in cached views on GitHub"
- "you can permanently remove cached views and references to the sensitive data in pull requests on GitHub by contacting us"
- "as a first step you need to revoke and/or rotate that secret."

## B3. Aikido "PromptPwnd" — CONFIRMED

Primary page opened: https://www.aikido.dev/blog/promptpwnd-github-actions-ai-agents — "PromptPwnd: Prompt Injection Vulnerabilities in GitHub Actions Using AI Agents", Rein Daelman, published 2025-12-04 (updated 2026-03-17).
- Mechanism: "Untrusted user-controlled strings (issue bodies, PR descriptions, commit messages) are inserted into LLM prompts." / "Untrusted user input → injected into prompts → AI agent executes privileged tools → secrets leaked or workflows manipulated."
- Affected: Gemini CLI, Claude Code Actions, OpenAI Codex Actions, GitHub AI Inference.
- "At least 5 Fortune 500 companies are impacted".
- Conditions: Claude Code Actions is exposed when `allowed_non_write_users: "*"` is set; Codex Actions needs both `allow-users: "*"` and a weakened `safety-strategy` (secure default `drop-sudo`); GitHub AI Inference is risky with `enable-github-mcp: true`. So for Claude and Codex this is a non-default configuration.

## B4. Linux kernel `Assisted-by` tag — CONFIRMED (dropped, and the removal is in mainline)

- Introduced: LWN, "The 2026 Maintainers Summit" (Jonathan Corbet, 2026-10-12): "Documentation/process/coding-assistants.rst was added to the 7.0 kernel" and it called for an Assisted-by tag. The Register dates the proposal to July 2025 and the doc to January 2026. https://lwn.net/Articles/1099594/
- Summit decision: LWN: "The requirement to add Assisted-by tags to patches created with LLMs will be removed, but maintainers still want to know about how a patch was created."; "a strong consensus in the room that the tag had outlived any purpose it may have had." The information "does not need to be recorded in the changelog"; suggestion to put it "into the cover letter instead." No replacement tag.
- Sasha Levin on the list: "The Maintainers Summit reached consensus to deprecate the Assisted-by Tag." / "Remove the documentation requiring it." (The Register, 2026-10-14) https://www.theregister.com/ai-and-ml/2026/10/14/linux-kernel-devs-drop_obligatory_confession_of_ai_tool_usage/5303140
- Merged? **Yes in mainline as of 2026-11-15.** In `torvalds/linux` @ `fa2933aac170`, `Documentation/process/coding-assistants.rst` is 77 lines with sections "Licensing and Legal Requirements", "Signed-off-by and Developer Certificate of Origin", "Procedure for finding and fixing bugs". There is no Attribution section, and `grep -rn "Assisted-by" Documentation/process` returns nothing. https://github.com/torvalds/linux/blob/fa2933aac170dd19c6a7f0d7b81a8f537e40915c/Documentation/process/coding-assistants.rst
- Caveats: (1) "mandatory" overstates the original text; secondary coverage says the doc said "should include", and enforcement was deliberately left out. (2) I did not identify the removing commit or which release it landed in (shallow clone). (3) What remains: "AI agents MUST NOT add Signed-off-by tags."

## B5. arXiv:2602.11988 — PARTLY CONFIRMED (numbers depend on the version; the current v3 is softer than v1)

"Evaluating AGENTS.md: Are Repository-Level Context Files Helpful for Coding Agents?" — Gloaguen, Mündler-Sasahara, Müller, Raychev, Vechev. v1 2026-02-12, v2 2026-06-23, v3 2026-09-29. Full text read at https://arxiv.org/html/2602.11988v3 (first 100,000 of 103,165 characters).

- v1 abstract: context files "tend to reduce task success rates compared to providing no repository context", "increasing inference cost by over 20%". https://arxiv.org/abs/2602.11988v1
- v3 abstract: "Surprisingly, we find that providing context files does not generally improve task success rates" while "increasing inference cost by over 20% on average".
- LLM-generated files (v3): about -0.5 points on SWE-bench Lite ("the average resolution rate is reduced by 0.5%") and about -2 points on the new benchmark; p-values 0.87 and 0.37, so not statistically significant.
- Developer-written files (v3): about +2.4 points on the new benchmark (p = 21%, not significant alone); significantly better than LLM-generated files (p = 3.8%).
- Cost (v3): LLM-generated +20% (SWE-bench Lite) and +23% (new benchmark), with +2.45 and +3.92 steps; developer-written +3.34 steps and "at most 19%" cost.
- Overviews: "Context files do not provide effective overviews." Overviews appear in 100% of Sonnet-4.5-generated and 99% of GPT-5.2-generated files but do not meaningfully reduce the steps to reach relevant files.
- Benchmark: v3 calls it **CTXbench** (138 instances, 12 repositories with developer-committed context files). Earlier versions and most coverage call it AGENTbench. Agents: Claude Code (Sonnet-4.5), Codex (GPT-5.2, GPT-5.1 mini), Qwen Code (Qwen3-30B-Coder).
- Recommendation: omit LLM-generated context files for now; human-written files should contain only what is not already documented (specific conventions) and be evaluated.

If the report says "context files reduce success rates", that is the v1 wording. v3 supports only "no general improvement, +20% or more cost; developer-written slightly better, LLM-generated slightly worse, neither significant alone". The widely quoted "+4% / -3%" style figures from v1 were not re-checked against v1's full text.

## B6. ESEM 2026: 85 plan files in 10 of 36,710 repositories — CONFIRMED

"An Exploratory Study of Agent Plans for Agentic AI Coding Tools in Open-Source Software" (Abubakar, Mohsenimofidi, Lulla, Zhang, Treude, Baltes, Galster), ESEM 2026, LIPIcs vol. 394, pp. 54:1-54:14. Abstract: "We screened 36,710 GitHub repositories belonging to engineered software projects" and "identified 85 Markdown plan files from 10 repositories." https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.ESEM.2026.54 . Only the abstract page was read, not the PDF, so the search method (which directories counted as plan files) is unverified.

## B7. Apiiro figures on `.claude/settings.local.json` — PARTLY CONFIRMED (secondary only; the "2,539 in 1,994" figure is not the settings.local.json count)

Apiiro's own post could not be opened (403): https://apiiro.com/blog/coding-agents-leaking-secrets-github-dont-ask-again (published 2026-11-05 per coverage). Figures below are from Let's Data Science (2026-11-07) and consistent across several other outlets:
- `.claude/settings.local.json` itself: 104,185 public copies in 103,617 repositories; **1,122 copies (1.1%) contain a real secret; 1,379 distinct secrets**; 63 organizations.
- Earlier versions of the file in git history: 734 more secrets across 509 repos. Forks: 211 forks of 74 repos carry the same secrets.
- **2,539 secrets in 1,994 repos is the combined total**, counting git history, the shared `.claude/settings.json` and saved agent transcripts.
- Gitleaks flagged 564 of the 1,122 files, TruffleHog 643, neither 215. Apiiro did not test whether secrets were still valid.
- Separate study, not Apiiro: GitGuardian (CSO Online, 2026-11-11) reports 31,088 distinct secrets in settings.local.json files across 23,276 public repos, 5,343 valid when detected.

Reconciliation: "2,539 secrets in 1,994 public repos" should not be described as secrets in `settings.local.json`. For that file alone the Apiiro numbers are 1,122 files / 1,379 secrets. GitGuardian's much larger number uses a different method (all pushed versions since January 2025).

Secondary URLs: https://letsdatascience.com/news/apiiro-finds-claude-code-approvals-leaking-2539-secrets-on-g-e4f20dbc , https://www.csoonline.com/article/4247336/claude-codes-dont-ask-again-button-has-a-secrets-spilling-problem.html

## B8. Claude Code project-file CVEs — CONFIRMED (mapping and fixed versions from Anthropic's advisories)

| Identifier | Issue | Affected / fixed | Severity | Published | URL |
|---|---|---|---|---|---|
| GHSA-ph6w-f82w-28w6 (**no CVE**: "No known CVE") | "Claude Code Vulnerable to Arbitrary Code Execution Due to Insufficient Startup Warning". The trust dialog "did not properly document that selecting "Yes, proceed" would allow Claude Code to execute files in the folder without additional confirmation." Fix was a clearer warning. Check Point ties this to hooks in `.claude/settings.json`. | < 1.0.87 / 1.0.87 | High, CVSS v4 8.7 | 2025-09-02 on the advisory page (Check Point says 2025-08-29) | https://github.com/anthropics/claude-code/security/advisories/GHSA-ph6w-f82w-28w6 |
| CVE-2025-59536 = GHSA-4fgq-fpq9-mr3g | "Command execution prior to Claude Code startup trust dialog": "Claude Code could be tricked to execute code contained in a project before the user accepted the startup trust dialog." Check Point ties this to the MCP consent bypass (`.mcp.json` / `enableAllProjectMcpServers`): "Anthropic fixed the bypass by ensuring that MCP servers cannot execute before user approval." | < 1.0.111 / 1.0.111 | High, CVSS v4 8.7 | 2025-10-03 | https://github.com/anthropics/claude-code/security/advisories/GHSA-4fgq-fpq9-mr3g |
| CVE-2026-21852 = GHSA-jh7p-qr78-84p7 | "Malicious repo configuration can trigger data leakage via environment configuration used before trust confirmation": a settings file setting `ANTHROPIC_BASE_URL` to an attacker endpoint made Claude Code "issue API requests before showing the trust prompt, including potentially leaking the user's API keys." | < 2.0.65 / 2.0.65 | Moderate, CVSS v4 5.3 | 2026-01-20 | https://github.com/anthropics/claude-code/security/advisories/GHSA-jh7p-qr78-84p7 |

The hooks / MCP labels for the first two come from Check Point Research, not from Anthropic's advisory text (which does not name hooks or MCP): https://research.checkpoint.com/2026/rce-and-api-token-exfiltration-through-claude-code-project-files-cve-2025-59536/ . NVD pages could not be read.

## B9. curl ended its bug bounty and moved to GitHub Private Vulnerability Reporting — PARTLY CONFIRMED (the move to GitHub was reversed after one month)

- Bounty ended: CONFIRMED. Daniel Stenberg, "The end of the curl bug-bounty" (2026-01-26): "It officially stops on January 31, 2026." Reason: AI slop reports; confirmed-vulnerability rate fell from above 15% to below 5% from 2025. Reports were to go to GitHub's private vulnerability reporting or security@curl.se. https://daniel.haxx.se/blog/2026/01/26/the-end-of-the-curl-bug-bounty/
- Move to GitHub: true for February 2026 only. "curl security moves again" (2026-02-25): reporting moved **back to HackerOne**: "Starting March 1st 2026, this is now (again) the official place to report security problems to the curl project." Reasons include that GitHub "sends the whole report over email/notification with no way to disable this", no way to publish invalid reports as such, the CVE field cannot be edited (curl is its own CNA), no team-only private comments, no labels, no blocking from an advisory. No bounty returns. https://daniel.haxx.se/blog/2026/02/25/curl-security-moves-again/

The report should say: bounty ended 2026-01-31; reporting went to GitHub PVR for about a month, then back to HackerOne (without bounty) from 2026-03-01.
