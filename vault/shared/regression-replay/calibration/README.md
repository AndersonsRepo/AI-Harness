# Calibration Anchors

Few-shot examples drawn from your past task-quality critiques. The PoLL judges (Sonnet + Codex) see 3-5 of these per evaluation as anchors — the practice is called **Critique Shadowing** and reportedly reaches ~90% expert agreement vs ~60-70% for unanchored judges.

## Purpose

The judges compare candidate output against a baseline — but "what counts as regress vs unclear" is genuinely subjective at the margins. Calibration anchors show the judges *your* historical decisions on similar margins. Without them, the judge falls back to its own training-derived priors, which drift from your actual standards.

## When this gets populated

Each pair is captured **organically**, in the moment. The trigger is any time you notice agent output that's wrong, off-target, or worth correcting:

- Builder produced a diff that missed an edge case you had to point out
- Researcher retrieved learnings that weren't actually relevant to your prompt
- Reviewer raised a concern that didn't apply
- Orchestrator routed to the wrong specialist
- Output was *fine technically* but failed in tone/voice/style/compactness

Capture timing: ideally within minutes. Critique fidelity decays fast.

## Capture format

Create a new pair file in this directory: `pair-NNN-<short-slug>.json`. Three-digit zero-padded index for stable sort, slug describes what the critique is about.

```json
{
  "id": "pair-001",
  "captured_at": "2026-04-25",
  "agent_role": "researcher | builder | reviewer | orchestrator | codex-builder | education",
  "shape": "<which shape this pair calibrates, e.g. 'shape-03-production-debugging-investigation'>",
  "context": "<original prompt + any relevant channel context — what the agent was asked to do>",
  "candidate_output": "<the actual output the agent produced (truncated to ~2000 chars if very long)>",
  "your_critique": "<what specifically was wrong, in your own words>",
  "verdict": "regress | unclear",
  "rationale": "<why this verdict, what the agent should have done instead>"
}
```

## Verdict guidance

- **`regress`** — the output had a clear quality drop. Use this for cases where you'd reject the output and ask for a redo.
- **`unclear`** — the output was different than what you wanted but not obviously wrong. Useful anchor for "this is the kind of edge case I want the judges to flag, not silently pass."

Don't use this directory for `pass` examples — calibration anchors are most useful at the margins between regress and unclear. Pass examples are implicit in the baselines.

## Target size

15-20 pairs is the practical sweet spot. Coverage matters more than volume:

| Agent role | Target pairs |
|---|---|
| researcher | 3-4 |
| builder | 3-4 |
| reviewer | 2-3 |
| orchestrator | 2-3 |
| codex-builder | 2-3 |
| education | 1-2 |

If you have one role with 10 pairs and another with 0, the judges are well-calibrated for the one and uncalibrated for the other.

## How the judges use anchors

When evaluating a candidate output, the judge prompt selects 3-5 anchors weighted by:

1. Agent role match (researcher anchors when judging a researcher).
2. Shape match (shape-03 anchors when judging a shape-03 seed).
3. Recency (newer pairs preferred).

Anchors are presented to the judge as: `Here are critiques the principal expert has issued on similar outputs. Use these to calibrate your verdict.`

## Cohen's κ tracking (optional, light-touch)

Periodically (manually, no automation needed for v1):

1. Pick 5-10 anchors at random.
2. Have the judge rate each one without knowing it's a calibration pair.
3. Compute Cohen's κ between judge's verdicts and your recorded verdicts.
4. If κ < 0.5 over a sample, the judges have drifted — either rubric is stale, calibration set is too small, or the model itself has shifted. Investigate.

Not a v1 requirement. Document if/when you decide to start tracking.

## Initial state

Empty. Populated organically as you correct agent output during real use.

If you want to backfill a few pairs from prior conversations, the natural sources are:
- Discord channel conversations where you said "no, that's not what I meant"
- Vault entries tagged `correction` or `feedback`
- ERR-* vault entries that document a bug the agent missed initially

Backfilling is optional — organic capture is the default.

## Stage 4 requirement: frictionless capture via the auditor agent

The auditor agent (Stage 4 in the regression-replay build plan) **must expose a `capture_calibration_pair` capability**. Mechanism: when the user issues a correction in conversation (e.g., "no, the researcher should have surfaced LRN-foo here"), the auditor can be invoked to:

1. Read the prior agent output from the channel context.
2. Capture the user's critique verbatim.
3. Propose verdict + rationale (user can edit before commit).
4. Write a new pair file in this directory with a generated id.

Without this, organic capture relies on the user manually creating JSON files mid-correction — high friction, low likelihood of actually happening. Stage 4 design must treat calibration capture as a first-class auditor capability, not an afterthought.

Optional v3: a hook handler watches Discord for explicit `[CALIBRATION:]` directives and triggers auto-capture without requiring the auditor agent invocation.
