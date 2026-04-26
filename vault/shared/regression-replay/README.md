# Regression Replay

Quality-monitoring fixture for the multi-agent harness. Catches silent regressions in retrieval, handoff, or output quality that unit tests don't see.

See `plans/agent-regression-replay-2026-04-24.md` for full design rationale. See `rubric.md` for current judging criteria (v2).

## Layout

```
vault/shared/regression-replay/
├── README.md          ← this file
├── rubric.md          ← pinned quality criteria (v2: PoLL, Pass^k, noise floor)
├── pinned-harness.md  ← list of files whose changes trigger re-baseline
├── seeds/             ← shape definitions (stable forever; pins rotate inside them)
├── baselines/         ← reference outputs per pinned seed
├── calibration/       ← user-critique anchors for the judge (Critique Shadowing)
├── runs/              ← per-run scorecards: YYYY-MM-DD-HHMM-<sha>.md
└── timeline.md        ← rolling 90-day summary, sparkline-style
```

## Tiers

| Tier | Trigger | Cost | What runs | Output |
|---|---|---|---|---|
| **1. Commit check** | git commit touching watched paths | ~$0 | Structural metrics: retrieval-set Jaccard, context-block shape, output-shape. **No LLM.** | `runs/<date>-<sha>.md` short entry, timeline append |
| **2. Weekly deep audit** | Sunday 02:00 | ~$10-18 | Each seed runs **3× at T=0** (Pass^3). Per-agent **PoLL judging** (Sonnet + Codex). | `runs/<date>-weekly.md` scorecard with verdicts |
| **3. On-demand auditor** | `/audit-quality` skill | Variable | Read timeline, bisect to suspected window, run ad-hoc replays | Investigative report posted to channel |

Tier 1 catches obvious breakage within minutes of a commit. Tier 2 catches subtle quality drift across runs (Pass^k surfaces flakiness single-run misses). Tier 3 is your investigation path when something feels off.

## Tier 1 data source — Claude Code hooks bus

Architectural intent (implementation deferred): tier 1 subscribes to Claude Code's native hook events rather than parsing `task_telemetry`. Hook surface:

- `PreToolUse` — before any tool invocation; lets us count expected tools per chain.
- `PostToolUse` — emits `tool_use_id`, `duration_ms`, decision (`allow`/`deny`/`ask`/`defer`).
- `Stop` — emits at task completion; primary trigger for structural-metrics computation.
- `SubagentStop` — emits at subagent completion; lets us trace per-agent steps within a chain.

This is a Claude Code feature; we get it without instrumenting our own code. Codex runs already emit comparable JSONL events that the same subscriber can normalize. Output: structured trace events written to a queue file, drained by the tier-1 heartbeat into `runs/<date>-<sha>.md` entries plus a `timeline.md` line.

For the underlying hooks API: see Claude Code docs on settings.json hook configuration.

## Watched paths (tier 1 triggers)

The tier-1 heartbeat fires when any committed file matches:

- `bridges/discord/context-assembler.ts`
- `bridges/discord/embeddings.ts`
- `bridges/discord/handoff-router.ts`
- `bridges/discord/task-runner.ts`
- `bridges/discord/claude-config.ts`
- `bridges/discord/codex-config.ts`
- `bridges/discord/role-policy.ts`
- `bridges/discord/agent-loader.ts`
- `.claude/agents/*.md`

A subset of these (the *runners*) also trigger pinned-harness re-baseline — see `pinned-harness.md`.

Edit the watched-paths list in `heartbeat-tasks/regression-replay-monitor.json` (when that config is created) if you add a module that touches retrieval, dispatch, or context.

## Seeds — shape definitions, not concrete tasks

Seeds describe **task shapes** that recur across projects, not project-specific prompts. Shapes survive project rotation; the *current pin* (the specific input being replayed) rotates as your work changes.

Each seed file: `seeds/<shape-id>-<slug>.json`, containing:

- `id`, `shape`, `category`, `difficulty` (easy/medium/hard)
- `released_at` — date the shape was added; tier 2 refuses to score against models with training cutoff after this date (contamination defense).
- `source` — provenance of the current pin (`production-trace:<task_id>` | `synthetic` | `failure-mined`).
- `expected_agents` — which agents the chain should route through.
- `parameter_slots` — what fields the pin needs to fill in (e.g., `topic`, `module`, `project`).
- `current_pin` — `null` until first pin is captured. Once set: `{input_ref, captured_at, baseline_path}`.
- `rotation_policy` — when this pin should be refreshed (typically `quarterly_or_on_project_change`).

## Pin capture — opportunistic

For v1, pins are captured manually:
1. The next time you do a real task matching shape N, mark it as a candidate pin.
2. Copy the prompt + assembled context + chain outputs into `baselines/<shape-id>-<date>.json`.
3. Update the seed's `current_pin` to point at that baseline.
4. Old pin files stay in `baselines/` (archived, not deleted) so the timeline can interpret cross-pin transitions.

Future v2: a heartbeat or hook handler watches for `[CALIBRATION:]` directives in Discord and proposes pin candidates automatically.

## Run naming

`runs/YYYY-MM-DD-HHMM-<short-sha>.md` for tier 1 (one per commit).
`runs/YYYY-MM-DD-weekly.md` for tier 2 (one per Sunday).
`runs/YYYY-MM-DD-HHMM-audit.md` for tier 3 (one per /audit-quality invocation).

## Reading the timeline

`timeline.md` is the single-glance view. See `timeline.md` for current format spec.

When you notice "the agent feels off" → invoke `/audit-quality` and the auditor agent will start from the timeline, find the regressed window, and trace it.

## Why structural metrics first, LLM judge later

LLM-as-judge has known biases (position, verbosity, self-preference). Structural metrics (Jaccard, set diff, character counts, agent routing) are deterministic and cheap. Tier 1 catches obvious breakage. Tier 2 layers in nuanced judgment via PoLL (Panel-of-LLMs from disjoint vendor families) — bias mitigation is structural, not prompt-level. Tier 3 lets you investigate when the cheap signals say something's off but you want to know why.

## Pass^k vs Pass@k

We score on **Pass^k** (all-k-pass) at tier 2, not Pass@k (any-of-k pass). Frontier models drop from ~70% Pass^1 to <25% Pass^8 on production-style tasks. Pass@k hides intermittent regressions; Pass^k surfaces them.

## What this does NOT do

- Run on every commit automatically as a blocking gate (it's a backstop, not a CI gate).
- Catch regressions in domains our seeds don't cover.
- Replace your judgment for close calls — see `rubric.md` for what we ask the judges to be confident about vs flag as unclear.
- Score against models whose training cutoff is after the seed's `released_at` — contamination defense, refuses the run.

## Open follow-ups (not blocking v1)

- Auto-pin-detection from Discord conversations.
- Hook-bus subscriber implementation (tier 1 currently planned, not yet built).
- Adversarial evaluator (planner→generator→adversarial) for borderline cases at tier 3.
- Optional Phoenix/Langfuse OTel exporter for longitudinal observability.
