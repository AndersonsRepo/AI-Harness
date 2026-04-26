---
harness_version: 1
last_updated: 2026-04-25
---

# Pinned Harness — Re-Baseline Triggers

When any file in this list changes, baselines must be regenerated. Otherwise harness changes (e.g., a context-assembler refactor) get misattributed as model regressions.

This is the principle from the colleague's eval framework: "Don't pretend the harness is invisible — Anthropic's August 2025 'Claude got dumber' incident traced to harness changes, not weights. Treat your harness as a versioned artifact."

## Files that trigger pinned-harness re-baseline

These are the **runners and assemblers** — the code that materially shapes what the model sees, not just dispatching it.

| File | Why it's pinned |
|---|---|
| `bridges/discord/claude-runner.py` | Shapes the Claude CLI invocation, retry loop, env scrubbing — changes to this can shift model behavior without any prompt changes |
| `bridges/discord/codex-runner.py` | Same role for Codex; shapes spawn args, retry, sandbox enforcement, prompt-file delivery |
| `bridges/discord/context-assembler.ts` | The deterministic context-injection daemon; changes to ordering, sectioning, or retrieval directly change what the agent sees |
| `bridges/discord/embeddings.ts` | Hybrid-retrieval pipeline (semantic + keyword + self-RAG + graph expansion); changes here change which learnings get retrieved |
| `bridges/discord/agent-loader.ts` | Loads agent metadata + tool restrictions; changes here can silently shift sandbox or capability boundaries |

## Files that trigger tier-1 (cheap structural-metrics) but not full re-baseline

These touch dispatch and routing but don't change the per-agent prompt content. Tier 1 still runs to detect regressions; tier 2 baselines remain valid.

| File | What it changes |
|---|---|
| `bridges/discord/handoff-router.ts` | Inter-agent routing, chain context propagation |
| `bridges/discord/task-runner.ts` | Spawn dispatch, FileWatcher wiring, telemetry |
| `bridges/discord/claude-config.ts` | Build args/env for Claude (but not the prompt content) |
| `bridges/discord/codex-config.ts` | Build args/env for Codex (but not the prompt content) |
| `bridges/discord/role-policy.ts` | Runtime selection per agent role |
| `.claude/agents/*.md` | Agent system prompts and metadata |

If a refactor touches both categories (e.g., changes context-assembler AND handoff-router), treat it as a full re-baseline trigger.

## Re-baseline procedure

When a pinned-harness file changes:

1. **Bump `harness_version`** in this file's frontmatter (1 → 2 → 3...).
2. **Run all 10 seeds** under the new harness version, capture outputs as new baselines:
   - `baselines/<shape-id>-<date>-h<version>.json`
3. **Update each seed's `current_pin.baseline_path`** to point at the new baseline file.
4. **Archive old baselines** (don't delete) so the auditor can interpret cross-version transitions.
5. **Append a marker entry to `timeline.md`**:
   ```
   2026-XX-XX HH:MM  HARNESS_VERSION_BUMP  v1 → v2  ← context-assembler refactor (commit abc1234)
   ```
6. **Note the harness version bump** in the next weekly tier-2 scorecard so the auditor knows comparisons crossed a boundary.

## When NOT to bump harness version

- Bug fixes that don't change behavior (e.g., fixing a typo in a comment).
- Refactors that preserve the exact same prompt text and dispatch shape.
- Documentation changes.

If unsure, bump. Cross-version comparisons aren't dangerous — they're just less directly informative. Missing a bump is worse: a real harness change gets attributed to the model.

## Detection in tier 1

The tier-1 heartbeat should:
- On commit touching pinned-harness files: emit a warning that re-baseline is recommended.
- Refuse to score the affected commit's tier-1 metrics against the old baseline (it's an apples-to-oranges comparison).
- Surface the commit on `timeline.md` with a `harness_change=true` flag.

## Current pinned harness version

**v1** — initial state, baseline 2026-04-25.

Bump entries appended below as harness changes ship.
