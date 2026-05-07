---
id: TOPIC-ai-harness
type: topic
topic: ai-harness
status: active
generated_at: 2026-04-29T20:32:24-07:00
generated_from: ["plans/context-assembly-cache-2026-04-24.md", "plans/d31-orchestrator-codex-2026-04-29.md", "plans/whats-next-2026-04-27.md"]
compressed: "AI Harness is the multi-agent runtime project; the current checked-in synthesis centers on Codex orchestration, deterministic context assembly, and closing the handoff and replay loop."
---

# AI Harness

## Current State
- The multi-agent harness chain went from "dormant — orchestrator always reaches for native Agent" to "shipped real code to a real branch via builder + reviewer + tester gates" across this arc. Three architectural refactors landed on private/runtime-local: Source: `plans/whats-next-2026-04-27.md`.
- private/runtime-local: 33fe225 Add D2.x canary script for reviewer + tester verification; origin/main: 6f78f8f D2.1 + D2.2: route reviewer and tester to Codex by default; Codex: builder, codex-builder, researcher, education, reviewer, tester. Source: `plans/d31-orchestrator-codex-2026-04-29.md`.

## Key Architecture
- The context plan splits assembly into three layers: stable system context, prompt-dependent retrieved learnings, and a volatile tail. Only the stable layer is a safe cache target. Source: `plans/context-assembly-cache-2026-04-24.md`.
- The design constraint is retrieval correctness: cache reuse must never flatten prompt-specific learning selection into a channel-wide default. Source: `plans/context-assembly-cache-2026-04-24.md`.

## Known Gotchas
- Orchestrator changes are high-risk because that role runs in nearly every project channel and it is the only role that emits handoff, parallel, create-channel, and chain-complete directives. Source: `plans/d31-orchestrator-codex-2026-04-29.md`.
- Today's context-assembler runs hybrid retrieval keyed off the user's prompt. The "retrieved learnings" section (~2000 of the ~5000 tokens) is prompt-dependent — different prompts in the same channel get different learnings. Source: `plans/context-assembly-cache-2026-04-24.md`.

## Active Decisions
- The explicit sequencing call is whether to wire accurate Codex cost capture first or accept conservative over-reporting and move directly into the orchestrator-on-Codex migration. Source: `plans/d31-orchestrator-codex-2026-04-29.md`.
- No `vault/learnings/` entries are checked into this worktree for `ai-harness`, so the MVP source of truth is the explicit plan set above plus any runtime-only context supplied outside git.

## Open Follow-ups
- A1. Multi-agent chain replay — Why: Original motivation for Option B.
- A2. Validate `harness_handoff` tool path actually works — Why: Env propagation fix (e4343ef) landed AFTER the chain that shipped — the orchestrator on that run chose the text fallback (queue stayed empty).
- A3. Cherry-pick template-safe parts to public `main` — Why: Per CLAUDE.md's public/private workflow.

## Sources
- `plans/context-assembly-cache-2026-04-24.md`
- `plans/d31-orchestrator-codex-2026-04-29.md`
- `plans/whats-next-2026-04-27.md`
