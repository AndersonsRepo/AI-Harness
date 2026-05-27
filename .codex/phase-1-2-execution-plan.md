# Phase 1 and 2 Execution Plan

## Goal
Implement the first usable mixed-runtime version of AI Harness:
- Claude remains the default orchestrator/planner
- Codex can execute builder-style work on the main task path
- runtime choice becomes configurable at the channel/project level

This plan stops short of the full `RuntimeAdapter` refactor. It is meant to get the system working and observable before broader architectural cleanup.

## Phase 1: Mixed-Runtime Main Path

### Objective
Make `runtime: codex` agents actually run through the primary queue/task system.

### Primary Files
- `bridges/discord/task-runner.ts`
- `bridges/discord/agent-loader.ts`
- `bridges/discord/codex-config.ts`
- `bridges/discord/codex-runner.py`
- `bridges/discord/session-store.ts`
- `bridges/discord/db.ts`
- `bridges/discord/core-gateway.ts`
- `bridges/discord/instance-monitor.ts`
- `bridges/discord/monitor-ui.ts`

### Work Items
1. Runtime dispatch in `task-runner.ts`
- At spawn time, resolve agent runtime with `getAgentRuntime(agentName)`.
- If runtime is `claude`, keep the current path.
- If runtime is `codex`, use `buildCodexConfig()` and spawn `codex-runner.py`.
- Pass prompt to Codex the way `codex-config.ts` expects, including prompt file or stdin handling as needed.

2. Normalize task output handling in `task-runner.ts`
- Parse Claude results with `extractResponse()` / `extractSessionId()`.
- Parse Codex results with `extractCodexResponse()` / `extractCodexSessionId()`.
- Save sessions with the correct runtime tag via `setSession(sessionKey, sessionId, runtime)`.
- Ensure stale-session retry logic only applies to the matching runtime.

3. Add runtime visibility to task records and monitoring
- Add `runtime` to task monitoring payloads if it is not already surfaced.
- Include runtime in activity stream posts and monitor embeds.
- Make it obvious whether a task ran on Claude or Codex.

4. Verify continuation behavior
- Decide whether Codex should support multi-step continuation in Phase 1.
- If yes, use runtime-specific continuation prompts.
- If no, explicitly disable continuation for Codex tasks for now and mark them single-step.

5. Add focused tests
- Task-runner unit coverage for runtime dispatch.
- Session-store behavior for mixed Claude/Codex sessions on the same logical key.
- Response parsing tests for Codex runner output.

### Acceptance Criteria
- A channel assigned to `codex-builder` can submit a normal message and complete through the main queue.
- The resulting session is stored with `runtime = codex`.
- Monitor UI and logs show the runtime clearly.
- Claude behavior remains unchanged for existing agents.

## Phase 2: Runtime-Aware Routing

### Objective
Move from hardcoded special-case runtime selection to explicit policy.

### Primary Files
- `bridges/discord/channel-config-store.ts`
- `bridges/discord/project-manager.ts`
- `bridges/discord/core-commands.ts`
- `bridges/discord/bot.ts`
- `bridges/discord/core-gateway.ts`
- `bridges/discord/task-runner.ts`
- `bridges/discord/db.ts`

### Policy Model
Add runtime policy at two levels:
- channel-level override for immediate control
- project-level default for role-based workflows

Suggested fields:
- `runtime?: "claude" | "codex"`
- `runtime_fallback?: string[]`
- `role_runtime_policy?: JSON blob` on projects later if needed

Start simple:
- one explicit runtime override
- optional fallback order in a later patch if needed

### Work Items
1. Extend config storage
- Add `runtime` to `channel_configs`.
- Add `default_runtime` to `projects` if project-level policy is needed immediately.
- Update `db.ts` migrations.
- Update `channel-config-store.ts` and `project-manager.ts` types and serializers.

2. Expose runtime commands
- Add `/runtime <claude|codex>` for channel-level override.
- Add `/runtime clear`.
- Show runtime in `/config`.
- Optionally add `/project runtime <claude|codex>` if you want project-wide defaults in Phase 2.

3. Resolve effective runtime in one place
- In the main message path, derive runtime using:
  1. addressed/selected agent runtime metadata
  2. channel runtime override
  3. project default runtime
  4. agent metadata default
  5. fallback to Claude

The important rule:
- `agent` decides persona
- runtime policy may override which backend executes that persona only when explicitly configured

4. Define initial runtime policy
- Default:
  - `orchestrator`, `researcher`, `reviewer`, `education`, `ops`, `scheduler` -> Claude
  - `codex-builder` -> Codex
- No automatic cross-runtime fallback yet beyond explicit user/channel choice.

5. Add tests and command coverage
- `channel-config-store.ts` runtime persistence
- `/runtime` command behavior
- config rendering in `/config`
- effective runtime resolution in the main queue path

### Acceptance Criteria
- Runtime can be set per channel with a command and persists in SQLite.
- `/config` shows the runtime override.
- Normal messages in a Codex runtime channel run through Codex without changing agent identity semantics.
- Existing Claude channels continue to work with no user-visible regression.

## Rollout Order
1. Implement Phase 1 spawn/output/session support
2. Smoke test `codex-builder` on a dedicated channel
3. Add Phase 2 schema/config/commands
4. Validate mixed-runtime behavior on real channels
5. Only then begin `RuntimeAdapter` extraction

## Non-Goals For Phase 1 and 2
- Runtime-agnostic handoff chains
- Runtime-agnostic subagents
- Runtime-agnostic tmux parallel orchestration
- Full Codex-only fallback mode
- Codex-native planner/reviewer/tester prompts

Those belong to later phases once the main queue path is stable.
