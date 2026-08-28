---
name: evidence-led-lp-studio
description: Research-first landing page strategy and HTML prototyping workflow grounded in current domain evidence rather than generic model priors.
---

# Evidence-led LP Studio

## Mission

Create landing-page strategy and prototypes from current, case-specific evidence. Do not jump directly to copy or visual design.

The workflow is:

`brief -> blind-pain-research -> market-research -> synthesis -> positioning -> message -> design -> prototype -> qa`

If an upstream assumption changes, mark downstream work stale and redo it.

## Non-negotiable rules

1. Do not treat competitor usage as performance proof.
2. Separate `observation`, `interpretation`, and `hypothesis`.
3. Every important strategy/design decision must reference current-project evidence or be explicitly labeled as an assumption.
4. Do not fabricate product facts, customer logos, testimonials, benchmarks, adoption numbers, or performance claims.
5. Claims used in final copy must exist in `00-brief/claim-ledger.yaml` or be clearly marked as placeholders.
6. Minimum three alternatives are required for positioning, message architecture, and visual communication.
7. Alternatives must represent materially different persuasion hypotheses, not cosmetic variants.
8. Treat `traffic source x target x ad promise x conversion` as the unit of LP strategy.
9. Do not imitate a single competitor. Identify category conventions first, then decide what to follow and what to differentiate.
10. Before moving to a new stage, check the stage gate in `references/stage-gates.md`.

## Start

Read, in order:

1. `<project>/00-brief/brief.yaml`
2. `<project>/00-brief/product-facts.yaml`
3. `<project>/00-brief/claim-ledger.yaml`
4. `<project>/workflow-state.yaml`
5. `references/evidence-policy.md`
6. `references/stage-gates.md`

If mandatory brief fields are missing, fill only what can be established from available evidence. Put unresolved items under `open_questions`; do not silently invent them.

## Stage 1 — Blind Pain Research

Before competitor-positioning research, investigate the target's real work and pains independently of the proposed solution.

### Anti-confirmation-bias rule
Give the pain researcher only the target role/organization, situation/job, market, and conversion context. Do not prime it with product mechanisms, preferred positioning, feature names, or the founder's problem statement.

Research recurring jobs/triggers, failures, confusion, delay, rework, coordination cost, distrust, current workarounds, substitute tools, user language, frequency/severity signals, who feels vs buys, and counterexamples.

Prefer first-person/community evidence, practitioner writing, customer stories, reviews and observed workflows over competitor marketing claims.

Create `10-pain-research/source-register.csv`, `evidence.jsonl`, `pain-clusters.yaml`, and `findings.md`.

Cluster pains before scoring product fit. A pain may become the primary LP entry point only with external evidence beyond the product brief, or when explicitly labeled `product-derived hypothesis`.

## Stage 2 — Market & Competitor Research

Research at least these source classes where available:

- direct competitors
- adjacent solutions
- current substitute behavior
- analogous products with similar trust/complexity/conversion difficulty
- counterexamples that break category conventions
- ads and corresponding landing pages when traceable

Aim for evidence saturation, not a fixed count. As a default starting point, gather 12–20 LPs and 20–40 ads, with direct competitors <= 50% of the LP sample.

For each meaningful observation write a JSONL record conforming to `schemas/observation.schema.json`.

Do not write a best-practice conclusion yet.

## Stage 3 — Synthesis & Analysis

Analyze persuasion structure, not merely UI components.

For each source identify when possible:

- who
- situation
- problem framing
- promise
- mechanism
- proof
- objections handled
- offer
- friction
- persuasion sequence
- visual role
- ad-to-LP message match

Produce:

- `20-analysis/pattern-matrix.csv`
- `20-analysis/category-fingerprint.yaml`
- `20-analysis/findings.md`

Explicitly distinguish:

- category conventions
- meaningful variation
- white space / underused positions
- unsupported performance assumptions

## Stage 4 — Positioning

Create at least 3 materially different options.

Each option should start from a different externally evidenced problem framing when evidence supports it.

Each option must include:

- target and context
- pain cluster / trigger
- evidence strength for that pain
- category frame
- core problem
- promise
- unique mechanism
- reason to believe
- conventions to follow
- elements to differentiate
- evidence refs
- assumptions
- risks
- testable hypothesis

Useful option archetypes are Category Fluent, Mechanism Differentiated, and Reframed, but do not force them if evidence suggests better alternatives.

Stop for selection before proceeding.

## Stage 5 — Message Strategy Diversification

Before writing copy, generate materially different message strategies. This is an upstream strategic choice, not a tone/copy variation.

Candidate strategy types include:
- Pain-led — start from a strongly evidenced current problem.
- Job-led — start from the job the target is trying to accomplish.
- Outcome-led — start from the desired future state.
- Mechanism-led — start from a distinctive way the product works.
- Category-reframe — change how the problem/category is understood.
- Alternative-led — contrast against the current workaround or substitute.

Do not mechanically generate all six. Select at least 3 strategy types that are genuinely supported by the pain research, product evidence, audience awareness, and competitive context.

For each strategy state:
- target and triggering situation
- strategy type
- starting idea
- intended reader inference
- evidence supporting the choice
- product truth that makes it credible
- likely advantage
- comprehension risk
- competitive-overlap risk

The alternatives must differ in **where persuasion begins**, not merely wording or tone.

Select one strategy before Copy Development.

## Stage 6 — Message & Information Architecture

For the selected positioning, create at least 3 architectures.

Each must include:

- intended target state
- hero message
- sub-message
- primary CTA
- section sequence
- purpose of each section
- proof placement
- objection handling
- form/CTA friction strategy
- why the sequence should work for this target
- evidence refs
- assumptions
- metrics to validate after launch

Stop for selection before visual exploration.

## Stage 7 — Copy Development

Copy is not where meaning is invented. Copy is the final compression of a message whose meaning is already established.

### Optimization objective

Do **not** optimize for brevity by default.

Optimize for:

`clarity × relevance × specificity × credibility ÷ cognitive load`

Memorability and brand character are secondary constraints. There is no obligation to reach the shortest or most slogan-like rung.

### 7.1 Copy Ladder

Never jump directly from positioning to a stylish headline. Build and retain these rungs:

1. **Product Truth** — precise, non-promotional description of what the product actually does.
2. **Customer Value** — translate that truth into the user's work and benefit.
3. **Plain Message** — concise enough for a landing page but still explicit and self-contained.
4. **Persuasive Copy** — improve rhythm, memorability and motivation without losing required meaning.
5. **Brand Copy** — optional maximum compression. Use only if prior knowledge and the rest of the Hero Message Unit make the meaning recoverable.

At every compression step record what information was removed. Reject a rung when `core_meaning_loss = high`.

### 7.2 Reader Prior Knowledge / Unknown Product Test

Before deciding how far to compress, estimate:

```yaml
reader_prior_knowledge:
  product: none | low | medium | high
  category: none | low | medium | high
  problem: none | low | medium | high
  terminology: none | low | medium | high
```

The lower the prior knowledge, the more explicit the Hero must be.

For an unknown product or low-familiarity category:
- do not imitate the information density of established consumer brands;
- do not rely on a headline whose meaning exists only after reading the rest of the page;
- keep concrete domain anchors;
- explicitly communicate enough of category/action/outcome to orient the reader.

Principle:

> Do not imitate the information density of an established brand unless the audience possesses equivalent prior knowledge.

### 7.3 Hero Message Unit

Design and evaluate the Hero as one communication unit:

- Eyebrow — optional category/context anchor
- Headline — primary proposition
- Subheadline — scope, mechanism, qualification or differentiation
- Visual — product/workflow proof, not decoration
- CTA — clear next action
- Optional proof — only when supported

Assign an explicit communication job to each element. The headline does not need to carry every fact, but the **unit as a whole must make the product legible**.

Prefer a real product interaction or workflow as the visual when it can prove the message.

### 7.4 Blind 5-second Comprehension Gate

The authoring agent must not grade its own understanding.

Give a separate comprehension auditor **only the Hero Message Unit as a first-time visitor would see it**. Do not provide:
- PRD/product brief
- positioning rationale
- Copy Ladder
- intended answers
- creator commentary

Ask the auditor to infer:

1. Who is this for?
2. What kind of product/service is it?
3. What can the user do with it?
4. What becomes easier or better?
5. What seems different from the current alternative?
6. What should the visitor do next?

Compare observed answers with the intended information requirements.

A Hero passes when:
- at least 3 of the first 4 answers materially match the intended meaning;
- no critical false inference is introduced;
- unsupported claims = 0;
- `core_meaning_loss != high`;
- the amount of explicit information is appropriate for reader prior knowledge.

Failure sends the work back to the appropriate Copy Ladder rung. Do not merely decorate or rephrase a failed headline.

### 7.5 Information requirements

Before generating Hero copy, state the 5–7 facts/inferences a first-time visitor should leave the first viewport understanding. Mark each as:
- must understand in Hero
- helpful in Hero
- can wait

The Hero Message Unit is evaluated against these requirements, not against generic notions of elegance.


## Stage 8 — Visual Communication

For the selected message architecture, create at least 3 distinct visual communication directions.

Each direction must define:

- visual anchor
- attention hierarchy
- typography role
- imagery/product UI role
- density and whitespace strategy
- motion role, if any
- relationship to category conventions
- what is deliberately differentiated
- why this target should understand/trust it
- imitation risk
- implementation cost

Then produce responsive HTML prototypes for all three directions.

Do not make three color variants of the same layout.

## Stage 9 — QA

Run four reviews:

- Evidence QA
- Conversion QA
- Visual QA
- Technical QA

Use `references/stage-gates.md` as the checklist.

Any claim without support blocks approval unless visibly marked placeholder.

## Revision policy

If a user says a proposal misses the strategic intent, first identify which assumption failed:

- blind pain research coverage
- market research coverage
- synthesis / analysis
- positioning
- message architecture
- visual direction

Revisit the earliest failed stage, not merely the current visual output.

Use `scripts/revisit_stage.py` so downstream stages become stale.
