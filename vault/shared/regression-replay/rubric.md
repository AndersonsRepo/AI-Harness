---
version: 2
last_updated: 2026-04-25
changes_from_v1: PoLL judging, Pass^k consistency, 3pp noise floor, calibration anchors via Critique Shadowing
---

# Regression Replay Rubric

Pinned quality criteria for the LLM judge (tier 2) and the on-demand auditor agent (tier 3). Versioned in git — bumping `version` invalidates timeline comparisons across the boundary. The auditor must note version transitions in `timeline.md` so cross-version comparisons aren't accidentally apples-to-oranges.

## Verdicts the judge can return

For each agent's output in a chain, the judge returns one of:

- **`pass`** — output is at parity with the reference baseline. Same structure, comparable detail level, same retrieval signals, same handoff target.
- **`regress`** — clear quality drop. Examples: missing sections present in baseline, output truncated unexpectedly, wrong specialist routed to, dropped tool-call where one was needed, placeholder text (TODO, "I would..."), broken syntax in code output.
- **`unclear`** — different output, but quality is hard to compare. Examples: alternate phrasing of the same answer, different but reasonable code style, slight retrieval reordering with no obvious quality difference.

The judge is encouraged to use `unclear` liberally. False-pass is more dangerous than false-flag — a true regression marked unclear gets investigated; a regression marked pass is invisible.

## Panel-of-LLMs (PoLL) judging

Single-judge architecture is rejected. Self-preference bias on Claude-family output is too large to ignore when the judge is also Claude-family.

**Minimum panel:** 2 judges from disjoint vendor families.
- Judge A: Claude Sonnet (Anthropic)
- Judge B: Codex (OpenAI family via the `codex` CLI)

**Verdict aggregation:**
- Both `pass` → final verdict `pass`.
- Either `regress` → final verdict `regress` (block on regression).
- One `pass` and one `unclear` → final verdict `unclear` (flag for human review).
- Disagreement (one `pass`, one `regress`) → final verdict `disagreement` — surface the split in `timeline.md`, escalate to on-demand `/audit-quality` invocation.

The disagreement signal is itself valuable — it indicates the call is genuinely close, which is when bias dominates either direction. Don't paper over it with a tiebreaker.

**Optional third judge** (Haiku or another family) can be added for tier-3 auditor invocations on close calls. Not required for tier-2 routine runs.

## Pass^k consistency (not Pass@k)

Single-run replay hides flakiness. T=0 is empirically not deterministic — the same prompt at temperature 0 can produce different outputs even with `--seed` due to non-determinism in the inference path.

**Tier 2 cadence:** every seed runs minimum **3 times at T=0**. The score for the seed is **all-pass (Pass^3)**, not any-of-3.

| Pass^3 result | Final per-seed verdict |
|---|---|
| 3-of-3 pass | `pass` |
| 2-of-3 pass, 1 unclear | `flaky_unclear` (record in timeline, don't block) |
| 2-of-3 pass, 1 regress | `flaky_regression` (block — intermittent regressions are still regressions) |
| ≤1 pass | `regress` |

Flakiness is itself a quality signal. A seed that drifts in and out of passing across runs indicates instability worth noting even if no single run is clearly broken.

**Cost implication:** N=3 runs × 2 PoLL judges = 6 judge calls per seed × 10 seeds = ~60 calls per weekly tier-2 run. Estimated cost ~$10-18/week.

## Noise floor

Apply a **3 percentage-point noise band** to all metric thresholds. Container memory caps, embedding model non-determinism, and retrieval ordering jitter all introduce ~3-6pp swings without any underlying quality change.

| Metric | Threshold | Noise band |
|---|---|---|
| Retrieval Jaccard vs baseline | regress < 0.7 | ambiguous 0.67-0.73 |
| Context-block size delta | regress > 5% | ambiguous 2-5% |
| Tool-call count delta | regress > 30% | ambiguous 20-30% |

In the ambiguous band, the verdict defaults to `unclear` — let the LLM judges decide.

## Calibration anchors (Critique Shadowing)

The judge sees few-shot examples drawn from `calibration/` directory. Each pair is one historical case where the user (principal expert) issued a clear critique on agent output. Format per pair file: `{id, context, candidate_output, your_critique, verdict, rationale}`.

The judge prompt includes:
1. The seed's input prompt and channel context.
2. The reference baseline output for the agent being judged.
3. The candidate (current) output for the same agent.
4. **3-5 calibration anchors** drawn from `calibration/` (rotated to match agent role: when judging a researcher, prefer researcher-related anchors).
5. This rubric.

Critique Shadowing reportedly reaches ~90% expert agreement vs ~60-70% for unanchored judges. Anchor selection matters — anchors should match the agent role being judged.

**Initial state:** `calibration/` is empty. The auditor's judge runs unanchored until you populate it organically from real task-quality corrections (see `calibration/README.md`). The auditor's verdicts before calibration is populated should be treated as lower-confidence.

## Per-agent criteria

### Orchestrator

- **pass**: emitted a plan, named correct specialists, no missed phases.
- **regress**: skipped delegation that the baseline used, named non-existent specialist, plan fragments visible in output (incomplete planning), looped back on itself.
- **unclear**: different but defensible plan structure (e.g., merged two phases into one).

### Researcher

- **pass**: retrieved learnings overlap baseline at Jaccard ≥ 0.7 (after noise band), output covers same topics, used Read/Grep/Glob tools.
- **regress**: retrieved set diverged dramatically (Jaccard < 0.5), output missing topic that baseline addressed, used Edit/Write (researcher should be read-only — flag CLI restriction failure).
- **unclear**: 0.5 ≤ Jaccard < 0.7 with comparable output, or different but valid retrieval angles.

### Builder

- **pass**: produced equivalent diff (same files touched, same intent), tests still pass, no broken syntax.
- **regress**: missing error handling present in baseline, dropped function/test, broken imports, placeholder text in code, syntax errors. Most severe: silent semantic change.
- **unclear**: stylistic difference (different but valid implementation), refactored same intent into different shape.

### Reviewer

- **pass**: identified the same major issues as baseline, didn't add false positives.
- **regress**: missed a baseline-flagged issue, raised concerns that don't apply, output dramatically shorter than baseline (incomplete review).
- **unclear**: different framing of same concerns, focus on different aspects.

### Codex builder (specifically)

Same as builder, plus:

- **regress**: output truncated mid-sentence (Codex one-shot ran out), prompt-file pattern broken (no prompt-file path in invocation), sandbox violation (used Edit when configured read-only).

## Chain-level signals

Beyond per-agent verdicts, the judge also evaluates:

- **Routing path**: did the chain use the same agents in the same order? `[orch → researcher → builder → reviewer]` vs `[orch → builder → reviewer]` is a routing change and should be flagged unless explainable.
- **Total turn count**: significantly more or fewer steps than baseline indicates loop or premature termination.
- **Did the review gate fire?**: builder output without reviewer following = REVIEW_GATE failure. Always regress.

## Pinned-harness re-baseline

When files in `pinned-harness.md` change, baselines must be regenerated. Otherwise harness changes (e.g., context-assembler refactor) get misattributed as model regressions. The harness version stamp accompanies every timeline entry; the auditor must compare baselines from the same harness version.

## What the judge should NOT do

- Decide a refactor's overall worth — that's the user's call.
- Compare against general best practices — only against the captured baseline for that seed's current pin.
- Use external knowledge (web search, other vaults) — only the materials provided in the comparison context.
- Generate code or fix issues — strictly evaluate.

## Judge output format

Each judge returns:

```json
{
  "verdict": "pass" | "regress" | "unclear",
  "reason": "<one sentence>",
  "evidence": "<specific quote or pointer to the divergence, max 200 chars>"
}
```

The PoLL aggregator combines two such returns and produces:

```json
{
  "judges": [{ "name": "sonnet", "verdict": "pass", ... }, { "name": "codex", "verdict": "unclear", ... }],
  "final_verdict": "unclear",
  "disagreement": false,
  "evidence_summary": "..."
}
```

## When to bump the rubric version

- New agent role added with criteria not covered above.
- Material change to verdict semantics (e.g., adding new verdict tier, changing PoLL aggregation rules).
- Adding new chain-level signals.
- Calibration anchor format changes.

Versioned bumps invalidate cross-version timeline comparisons — note the bump in the timeline header so the auditor doesn't compare apples-to-oranges.
