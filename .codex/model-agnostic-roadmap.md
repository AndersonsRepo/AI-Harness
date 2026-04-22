# Model-Agnostic Runtime Roadmap

## Scope
This roadmap defines how AI Harness should evolve from a Claude-first system into a model-agnostic harness that can:
- use Claude for orchestration and planning by default
- delegate bounded implementation work to Codex
- operate in a full Codex-only degraded mode when Claude is unavailable

This plan intentionally does **not** rely on leaked or proprietary Claude Code internals. It is based on public documentation and public open-source projects only.

## Design Goals
- Keep `role` separate from `runtime`
- Make memory, context assembly, and telemetry runtime-neutral
- Support mixed-runtime teams first, then full fallback
- Treat Codex-only mode as a first-class operating mode, not an emergency hack

## Public Reference Patterns
### 1. Unified runtime/event layer
`harness.lol` shows the value of one CLI and one event format across multiple agent backends. AI Harness should do the same internally: one task model, one event schema, many runtimes.

### 2. Multi-engine sessions
`harnss` validates the usefulness of running Claude Code, Codex, and other agents side by side with separate state, history, and context per session.

### 3. One orchestrator, many specialists
OpenCastle’s public architecture matches the intended shape here: a coordinator plus specialist workers, with modular skills loaded per task.

### 4. Runtime core behind a stable protocol
OpenAI’s Codex App Server design is the strongest inspiration for the runtime layer: a stable client-facing protocol over a core agent loop with thread/session management and event streaming.

### 5. Plan vs Act model split
Cline’s public Plan/Act workflow strongly supports using a stronger planner model and a faster implementation model. This aligns with Claude-as-planner and Codex-as-builder.

### 6. Separate worker contexts
Anthropic’s subagent docs reinforce the importance of isolated worker contexts, tool restrictions, and cheaper or faster side-task models.

## Target End State
AI Harness should expose:
- `planner`
- `researcher`
- `builder`
- `reviewer`
- `tester`

Each role should be mappable to a runtime:
- normal mode: Claude for planner/researcher/reviewer, Codex for builder
- degraded mode: Codex for all roles

Agent prompts should become runtime-specific implementations of shared roles rather than the source of truth for system behavior.

## Core Abstractions To Add
### RuntimeAdapter
Each runtime should implement:
- `prepareInvocation()`
- `spawn()`
- `cancel()`
- `parseEvents()`
- `extractFinalMessage()`
- `extractSessionId()`
- `supportsResume()`
- `supportsStreaming()`
- `supportsFineGrainedTools()`
- `supportsSubagents()`

### RolePolicy
The router should decide:
- preferred runtime per role
- fallback order per role
- allowed runtimes per project/channel
- degraded-mode behavior

### Unified Event Model
Normalize runtime output into one internal stream:
- `session_start`
- `text_delta`
- `message`
- `tool_start`
- `tool_end`
- `result`
- `error`

This is the layer monitor UI, task history, and dead-letter handling should consume.

## Phase Plan
### Phase 1: Mixed-Runtime Main Path
- Finish runtime dispatch in `task-runner.ts`
- Route `runtime: codex` agents through `codex-runner.py`
- Persist runtime with session/task telemetry
- Show runtime in monitor UI and activity stream

### Phase 2: Runtime-Aware Routing
- Add project/channel runtime policy
- Set default policy:
  - Claude: planner, researcher, reviewer
  - Codex: builder
- Add explicit fallback order, such as `["claude", "codex"]`

### Phase 3: Stable Mixed-Runtime Orchestration
- Extend mixed-runtime support beyond the main queue into handoffs, subagents, and monitoring only where runtime boundaries are explicit
- Preserve canonical implementation artifacts across review/test chains so later agents verify the implementation output, not commentary
- Add runtime-aware telemetry and dead-letter handling as first-class behavior before broader refactors

### Phase 4: Runtime Control Plane
- Introduce a real `RuntimeAdapter` layer for Claude and Codex
- Normalize spawn, cancel, event parsing, session extraction, and capability reporting behind one internal runtime interface
- Keep the role/router layer above runtime selection
- Make runtime differences explicit rather than attempting to force feature parity

### Phase 5: Codex-Native Role Layer
- Add `.codex/agents/` and `.codex/playbooks/` as the Codex-native control plane
- Define Codex-native `planner`, `researcher`, `builder`, `reviewer`, and `tester` roles
- Build Codex-specific workflows for implementation, review, verification, and fallback mode
- Treat this as the prerequisite for reliable Codex-only operation

### Phase 6: Explicit Codex-Only Operating Mode
- Add a manual Codex-only mode that switches runtime policy to Codex for all roles
- Use Codex-native role docs and playbooks instead of Claude-oriented prompts
- Keep vault, embeddings, context assembly, and telemetry shared across runtimes
- Surface the mode explicitly in configuration and monitoring so degraded operation is visible, not silent

## Codex-Only Workstream
### Codex-native docs to create
- `.codex/agents/planner.md`
- `.codex/agents/researcher.md`
- `.codex/agents/builder.md`
- `.codex/agents/reviewer.md`
- `.codex/agents/tester.md`
- `.codex/playbooks/implementation.md`
- `.codex/playbooks/review.md`
- `.codex/playbooks/fallback-mode.md`

### Codex-native behavior guidance
Codex prompts should emphasize:
- bounded, well-scoped work
- explicit verification expectations
- strong file/path grounding
- deterministic handoff summaries
- minimal narrative, high signal

Codex should not be asked to imitate Claude. It should be optimized for the work it is strongest at and supported with more deterministic harness scaffolding where needed.

## Immediate Next Milestones
1. Ship mixed-runtime main queue support
2. Make runtime visible in monitoring and config
3. Stabilize artifact-preserving post-chain gates
4. Extend mixed-runtime behavior to orchestration paths deliberately
5. Introduce `RuntimeAdapter`
6. Build Codex-native role docs and manual Codex-only mode

## Sources
- Anthropic subagents: https://code.claude.com/docs/en/sub-agents
- Cline Plan/Act: https://docs.cline.bot/core-workflows/plan-and-act
- Cline model orchestration: https://docs.cline.bot/cline-cli/samples/model-orchestration
- Continue model roles: https://docs.continue.dev/customize/model-roles/intro
- OpenAI Codex CLI: https://developers.openai.com/codex/cli
- OpenAI Codex agent loop: https://openai.com/index/unrolling-the-codex-agent-loop/
- OpenAI Codex App Server: https://openai.com/index/unlocking-the-codex-harness/
- harnss: https://github.com/OpenSource03/harnss
- harness.lol: https://www.harness.lol/docs
- revfactory/harness: https://github.com/revfactory/harness
- OpenCastle: https://www.opencastle.dev/
