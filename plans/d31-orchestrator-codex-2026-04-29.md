# D3.1 — Orchestrator → Codex (and Codex cost capture)

This plan is self-contained. A fresh session should be able to open it and start
executing without reading prior conversation. Background context lives in:

- `vault/learnings/LRN-20260429-007.md` — the D5.1 fix that unblocked this work
  (Codex MCP per-server approval-mode override + Codex-shaped telemetry parser)
- `vault/learnings/ERR-20260429-004.md` — superseded prior misdiagnosis; read
  the front-matter banner for context, skip the body

## Quick-start checklist for a fresh session

1. `cd /Users/andersonedmond/Desktop/AI-Harness-private-runtime`
2. `git status` → expect clean tree on `private/runtime-local`
3. `git log private/runtime-local..origin/main --oneline` → expect empty
   (main and private should both have D5.1 + D2.x; private has the two private
   canary scripts ahead)
4. Baseline test run:
   ```
   bridges/discord/node_modules/.bin/tsx --test bridges/discord/tests/*.test.ts
   ```
   Expect 205/205 (private) or 184/184 (main).
5. Read this whole plan before touching code. Especially the **Risk** section.

## Current state (2026-04-30 UTC)

**Branch heads:**
- `private/runtime-local`: `33fe225 Add D2.x canary script for reviewer + tester verification`
- `origin/main`: `6f78f8f D2.1 + D2.2: route reviewer and tester to Codex by default`

**D-track routing (`bridges/discord/role-policy.ts:getPreferredRuntimeForAgent`):**
- Codex: builder, codex-builder, researcher, education, reviewer, tester
- Claude: orchestrator (the only D-track holdout), and everyone else by default

**What works today on Codex (verified 2026-04-29 via canaries):**
- Single-agent spawns via `buildCodexConfig` + `codex-runner.py`
- MCP tool calls (vault, harness, projects) auto-approve per channel allowlist
- Telemetry parser counts `mcp_tool_call` + `command_execution` events,
  pulls authoritative token counts from `turn.completed.usage`

**What is *not* verified for Codex yet (the D3.1 risk surface):**
- `[HANDOFF:agent_name]` text-directive emission and parsing
- `mcp__harness__harness_handoff` tool invocation from Codex (vs. Claude's
  native handling)
- `[PARALLEL:agent1,agent2]` directive emission (orchestrator is the only
  agent that produces these)
- `[CREATE_CHANNEL:name --agent x "desc"]` directive
- `[CHAIN_COMPLETE]` debrief loop back to orchestrator
- Chain-result accumulation across runtime boundaries (Codex orchestrator →
  Claude/Codex specialist → back to Codex orchestrator for debrief)

## Decision: cost capture first, or D3.1 first?

Open as of 2026-04-29. Two options were on the table:

**Option 1 (velocity):** Ship D3.1 with current cost numbers. Codex spawns
report cost via Sonnet pricing in `bridges/discord/instance-monitor.ts:364`
(`inputCost = (estInput/1M) × 3`, `outputCost = (estOutput/1M) × 15`).
GPT-5.4 is roughly $1.25/$10 per MTok — Codex orchestrator runs would
over-report ~2.4× actual spend. Numbers are conservative, not catastrophic.

**Option 2 (recommended):** Wire Codex cost capture first. ~30–60 min:
add a Codex pricing table, branch `getCompletedSummary` on `instance.runtime`,
derive `estCostCents` from authoritative token counts. Bonus: retroactively
benefits the four roles already on Codex.

Pick one before starting the D3.1 implementation. The work below assumes
Option 2 is done first; if Option 1 wins, skip Phase 0.

## Phase 0 — Codex cost capture (Option 2 only)

**Goal:** `task_telemetry.est_cost_cents` reflects actual GPT-5.4 cost for
Codex spawns, not Sonnet pricing.

**Files to touch:**
- `bridges/discord/instance-monitor.ts` — `getCompletedSummary` (line ~349).
  Branch on `instance.runtime`. Pass through (or compute alongside) Codex
  pricing constants.
- (Optional, if you want the constants reusable) a small `pricing.ts` module
  with Claude/Codex pricing tables.

**Research before writing code:**
- Check current OpenAI pricing for `gpt-5.4` and `gpt-5.4-codex-max` (the
  Codex CLI default model is whatever `~/.codex/config.toml` says — current
  is `model = "gpt-5.4"`). Pricing is per million tokens; cached input
  tokens are cheaper. `turn.completed.usage` includes `cached_input_tokens`
  separately — use it.
- Note: Codex CLI doesn't emit `total_cost_usd` directly (per the
  regression-replay v2 follow-up notes in LIVE_STATE). Derivation from
  token counts is the only path until Codex adds it upstream.

**Acceptance:**
- New unit test in `tests/codex-mcp-approval.test.ts` (or a new file): given
  a synthetic `turn.completed.usage` payload, `getCompletedSummary` returns
  cost computed from Codex pricing, not Sonnet.
- Existing tests stay green.
- E2E spot-check: re-run `bridges/discord/tests/d51-canary.ts` and confirm
  `task_telemetry.est_cost_cents` for the canary row is plausibly Codex-priced.

## Phase 1 — Read before you change

Before adding orchestrator to the Codex routing list, understand the chain
machinery. **Read these files in this order:**

1. `bridges/discord/handoff-router.ts` — the heart of chain execution.
   Specifically: `executeHandoff`, `runHandoffChain`, `parseParallelDirective`,
   `REVIEW_GATE`, `resolveHandoffRuntime`. Note where chain entries are
   accumulated and how the chain log is fed back to the orchestrator at
   `[CHAIN_COMPLETE]`.

2. `mcp-servers/mcp-harness/index.ts` — `harness_handoff` tool. Writes a
   row to `handoff_queue`, the bot drains it. Verify the tool definition
   doesn't depend on Claude-specific tool-call shapes.

3. `bridges/discord/bot.ts` — handoff directive parsing. Search for
   `[HANDOFF:` and `parseParallelDirective`. Verify the regex/parser
   matches text the model actually emits, not stream-json shapes.

4. `bridges/discord/codex-config.ts` — orchestrator's tool restrictions
   in `agent-loader.ts:AGENT_TOOL_RESTRICTIONS["orchestrator"]` (disallowed:
   Edit/Write/NotebookEdit/git-commit/git-push/npm/npx). Confirm
   `agentAllowsWrite("orchestrator")` returns false → Codex sandbox will
   downgrade to read-only. **This is intentional.**

5. `vault/learnings/LRN-20260426-052.md` (handoff-as-tool refactor) — the
   `[HANDOFF:]` directive was promoted to a first-class MCP tool because
   Claude's tool-trained model preferred Agent calls over text directives.
   Codex may have the same bias; this is a known risk.

## Phase 2 — Implement D3.1 routing

Single-line change in `bridges/discord/role-policy.ts`. Add `"orchestrator"`
to the if-condition in `getPreferredRuntimeForAgent`. Update the role-policy,
runtime, and handoff-router tests to flip orchestrator from Claude to Codex.
Now there is no "Claude-default sentinel" role left for those tests — pick
a different agent (e.g. `ops` or `project`) as the new sentinel, or drop the
"defaults to Claude" assertion entirely if no role still does.

**Acceptance:** 205+ tests still pass; orchestrator routes to Codex by
default in role-policy + runtime + handoff-router tests.

## Phase 3 — Canary (the real work)

A single-spawn canary like `d51-canary.ts` is **not sufficient** for D3.1.
Orchestrator's value is delegation. Build a chain canary that exercises
the full path:

**Canary script: `bridges/discord/tests/d31-canary.ts`** (private; hardcoded
paths/channel as before)

The canary should:
1. Spawn orchestrator/codex against the ai-harness channel
   (`1499234537090322443`) with a prompt that requires delegation, e.g.
   "Delegate the following work to the researcher: find the most recent
   `codex` learning in the vault. Then summarize what they report back."
2. Confirm the orchestrator emits a handoff (either `[HANDOFF:researcher]`
   text or `mcp__harness__harness_handoff` tool call). Read the JSONL stdout
   — look for either an `agent_message` containing the directive substring
   or an `mcp_tool_call` with `tool === "harness_handoff"`.
3. Confirm the handoff actually fires through `executeHandoff`. Easiest
   path: instead of going through `task-runner`, manually invoke
   `executeHandoff` with the orchestrator's response, and assert the chain
   continues to a researcher spawn that calls vault MCP.
4. Confirm `[CHAIN_COMPLETE]` debrief reaches the orchestrator (look for a
   second orchestrator turn after the researcher turn ends).

**Failure modes to expect and check for explicitly:**
- Codex's reasoning model may inline the handoff *intent* without emitting
  the directive ("I would now delegate to the researcher..." instead of
  `[HANDOFF:researcher]`). If this happens, the chain never starts. Check
  the orchestrator's agent prompt — may need to strengthen the directive
  instruction for Codex specifically.
- Codex may prefer the `mcp__harness__harness_handoff` tool over the text
  directive (this is actually *good* — it's the trained-on path). Per
  LRN-20260426-052 this is the design intent. Verify `harness_handoff` is
  in the channel's `allowed_mcps` (default baseline includes harness).
- `executeHandoff` builds a chain context from the last 15 messages of the
  channel. Codex's session is separate from Claude's; chain context might
  be missing the orchestrator's plan if session-key resolution doesn't
  match. Look at `getProjectSessionKey` in `handoff-router.ts`.
- Codex orchestrator → Claude reviewer / Codex tester crossings: the chain
  log accumulates entries from both runtimes. If response extraction
  (`extractCodexResponse` vs `extractResponse`) returns different shapes,
  the chain log might be malformed.

**Pass criteria:**
- Orchestrator emits a parseable handoff directive or `harness_handoff`
  tool call (rc=0)
- The handoff routes to the correct specialist
- The specialist completes with vault MCP usage (mcp_tool_call event,
  status=completed, no "user cancelled")
- `[CHAIN_COMPLETE]` reaches the orchestrator
- Total chain depth ≤ 3 (no runaway loops)

## Phase 4 — Live verification (optional but recommended)

Before declaring D3.1 shipped:

1. Restart the bot to load the new role-policy:
   `launchctl kickstart -k gui/$(id -u)/com.aiharness.discord-bot`
2. Send a real Discord message in `<#1499234537090322443>`:
   "Plan a quick task: ask the researcher to find the most recent
   regression-replay learning, then summarize."
3. Watch `bot.log` and `#agent-stream`. Expect:
   - Orchestrator/codex spawn (not orchestrator/claude)
   - Researcher spawn after handoff
   - Chain debrief on the orchestrator
4. Check `task_telemetry` rows for both spawns — costs should look
   reasonable for both runtimes (Phase 0 prerequisite if you went with
   Option 2).

## Risk assessment

Highest-risk migration of the D-track. Reasons:

- **Spawn frequency:** orchestrator runs in nearly every project channel.
  A regression here breaks more chains than D1.1, D1.2, D2.1, D2.2 combined.
- **Chain semantics:** orchestrator is the *only* role that produces
  `[HANDOFF:]`, `[PARALLEL:]`, `[CREATE_CHANNEL:]`, `[CHAIN_COMPLETE]`.
  Codex hasn't been validated against any of these directives.
- **Cross-runtime crossings:** Codex orchestrator → Claude specialist
  → Codex orchestrator debrief is unverified end-to-end. The hand-built
  test in `tests/runtime.test.ts` mocks runtimes — it doesn't exercise
  real chain logic.
- **Tool-whitelist enforcement gap (carried over from D2.x):** Codex has
  no `--disallowedTools` equivalent. Orchestrator's whitelist forbids
  Edit/Write/git-commit/git-push, but those are enforced for Claude only.
  Read-only sandbox blocks workspace edits, but git operations via shell
  could theoretically still happen. Audit the agent prompt and consider
  whether read-only is enough.

**Rollback plan:** if D3.1 lands and chains break in production, revert
the role-policy change with one commit:
```
git revert <D3.1 commit>
```
The role-policy is the only code path that needs to change; everything
else is additive.

## Out of scope (carry forward as v2 follow-ups)

- Tool-whitelist structural enforcement under Codex (per-channel MCP
  scoping is the closest analog today; better would be a
  `disallowed_tools`-equivalent at the codex-runner.py level).
- Frontmatter refactor of `.claude/agents/*.md` permissions
  (Item 3 from prior recap; independent of D3.1).
- Multi-agent chain replay in regression-replay (currently only the
  first agent is replayed).
- Codex builder seed (shape-10) worktree pattern.
