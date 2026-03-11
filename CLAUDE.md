# AI Harness — Agent Instructions

You are a self-improving personal AI agent for Anderson Edmond. You operate across Discord and iMessage, run background tasks on schedule, and continuously learn from every interaction.

## Core Principles

1. **Learn from every mistake** — Log errors, corrections, and knowledge gaps to `vault/learnings/`
2. **Promote recurring patterns** — When a learning recurs 3+ times, promote it to this file
3. **Build new skills** — When you discover a reusable workflow, extract it into a new skill
4. **Be concise** — Lead with the answer, skip filler
5. **Ask before destructive actions** — Never delete, force-push, or overwrite without confirmation

## Projects I Work On

- **Hey Lexxi** — Production app at https://app.heylexxi.com (Vercel + Supabase)
  - Path: `$HOME/Desktop/Hey-Lexxi-prod`
- **Mento** — Senior project mentorship platform (Next.js + Gemini + LightRAG)
  - Path: `$HOME/Desktop/Seniorproject/mento`

## Conventions

- TypeScript for all new code
- npm as package manager (pnpm is not installed)
- Always update documentation alongside code changes

## Memory System

- Agent memories are stored in `vault/` (Obsidian-compatible markdown vault)
- `vault/shared/` — cross-agent knowledge accessible by all agents
- `vault/agents/<name>/` — private working memory per agent
- `vault/learnings/` — individual learning/error/feature files with YAML frontmatter
- Each learning file uses `[[wikilinks]]` for cross-references
- The vault IS the source of truth for what this agent knows
- Obsidian app can visualize the vault (graph view, backlinks) but is not required

---

## Architecture Reference

This section contains verified knowledge about how this project works. If you're modifying AI Harness code, read this first.

### System Overview

```
Discord user → bot.ts (queue + command dispatch)
                 ↓
              task-runner.ts (submit → spawn → watch → retry)
                 ↓
              claude-runner.py (clean env, subprocess, atomic write)
                 ↓
              Claude CLI (`claude -p --output-format json`)
                 ↓
              Output file (.tmp → rename) → FileWatcher detects
                 ↓
              bot.ts (parse response, post to Discord)
```

### Data Layer

**SQLite** (`bridges/discord/harness.db`) — all bot operational state:
- `sessions` — channelId → sessionId mapping (compound keys for projects: `channelId:agentName`)
- `channel_configs` — per-channel agent/model/permission/tools settings
- `subagents` — background task tracking (spawn, status, PID)
- `projects` — project channel registration, handoff depth
- `task_queue` — bounded-step execution, retry state, PID tracking
- `dead_letter` — tasks that failed after all retry attempts
- WAL journal mode for crash safety

**Obsidian Vault** (`vault/`) — long-term agent knowledge/learnings. NOT operational state.

### Key Files

| File | Purpose |
|------|---------|
| `bridges/discord/bot.ts` | Main bot: queue, commands, task-runner integration, streaming |
| `bridges/discord/task-runner.ts` | Bounded-step execution, retry, dead-letter, crash recovery |
| `bridges/discord/db.ts` | SQLite singleton, schema, auto-migration from JSON |
| `bridges/discord/file-watcher.ts` | Event-driven file detection (fs.watch + fallback poll) |
| `bridges/discord/claude-runner.py` | Python wrapper: clean env, file output, timeout, streaming |
| `bridges/discord/session-store.ts` | Session CRUD (SQLite) |
| `bridges/discord/channel-config-store.ts` | Channel config CRUD (SQLite, JSON arrays) |
| `bridges/discord/process-registry.ts` | Subagent tracking (SQLite) |
| `bridges/discord/project-manager.ts` | Project CRUD, handoff depth, auto-adopt (SQLite) |
| `bridges/discord/subagent-manager.ts` | Background subagent spawn + FileWatcher per subagent |
| `bridges/discord/handoff-router.ts` | Inter-agent handoffs, context building, chain execution |
| `bridges/discord/stream-poller.ts` | Progressive stream-json parsing for live message editing |
| `bridges/discord/activity-stream.ts` | Discord embeds to #agent-stream channel |
| `.claude/agents/*.md` | Agent personalities (researcher, reviewer, builder, ops, commands) |

### Critical: Claude CLI Spawning Rules

These rules are hard-won from debugging. Violating any of them will cause silent failures.

1. **Strip CLAUDE* env vars** — Claude CLI sets `CLAUDECODE=1` and `CLAUDE_CODE_ENTRYPOINT=cli`. If these exist when spawning `claude -p`, it errors "Cannot be launched inside another Claude Code session." The `claude-runner.py` script handles this by building a clean env.

2. **Never spawn Claude CLI directly from Node.js** — Node.js `child_process` + Claude CLI = indefinite hang ([known bug](https://github.com/anthropics/claude-code/issues/771)). Always go through `claude-runner.py` which uses Python's `subprocess.run()`.

3. **File-based output, not pipes** — Even with Python intermediary, stdout pipes can stall. `claude-runner.py` writes to a `.tmp` file then atomically renames. Node.js detects the final file via FileWatcher.

4. **Always use `--` before the prompt** — Flags like `--append-system-prompt`, `--allowedTools`, `--disallowedTools` are variadic in Commander.js. They consume all subsequent positional args including the prompt. Fix: `claude -p --append-system-prompt "..." -- "prompt here"`

5. **Always use `--dangerously-skip-permissions`** — Without this, `claude -p` prompts for tool approval in the terminal, blocking headless execution. Safety is enforced via `--disallowedTools` guardrails instead.

6. **Detached + stdio ignore** — Spawn `claude-runner.py` with `{ detached: true, stdio: "ignore" }` and call `proc.unref()`. This prevents the parent process from blocking on the child.

7. **Session compound keys** — In project channels, each agent gets its own session via `channelId:agentName`. Regular channels just use `channelId`. See `getProjectSessionKey()` in `handoff-router.ts`.

### Store Pattern

All 4 store modules (`session-store.ts`, `channel-config-store.ts`, `process-registry.ts`, `project-manager.ts`) follow the same pattern:
- Import `getDb()` from `db.ts`
- No caching — SQLite WAL is fast enough for synchronous reads
- Same exported function signatures as the old JSON-based versions
- Array fields (`allowedTools`, `disallowedTools`, `agents`) stored as `JSON.stringify()`, parsed with `JSON.parse()` on read
- All use `INSERT ... ON CONFLICT DO UPDATE` for upserts where applicable

### File Watching Pattern

All file-based polling has been replaced with `FileWatcher` from `file-watcher.ts`:
- Watches the **directory** (not the file) because the file doesn't exist when the watcher starts
- `retryReadMs` delay (50-100ms) after `fs.watch` event — lets the atomic `.tmp → rename` complete
- Fallback poll (2-5s) as safety net for unreliable `fs.watch` (macOS FSEvents edge cases)
- `trackWatcher()` / `untrackWatcher()` / `stopAllWatchers()` for clean shutdown
- One watcher per output file (not one global poll)

### Task Runner Pattern

`task-runner.ts` manages bounded-step execution:
- `submitTask()` → inserts into `task_queue` with status `pending`
- `spawnTask()` → spawns Claude process, sets up FileWatcher, status → `running`
- On output: parse response, check for `[CONTINUE]` marker, either complete or spawn next step
- Retry: exponential backoff (5s, 25s, 125s), max 3 attempts
- Stale session error: auto-clear session, immediate retry (counts as attempt 1)
- After max attempts: move to `dead_letter` table, notify channel
- Crash recovery on startup: check PIDs of `running`/`waiting_continue` tasks, re-attach or retry

### Inter-Agent Communication

- Agents hand off work with `[HANDOFF:agent_name] description` at end of their output
- `bot.ts` detects the directive, `handoff-router.ts` builds context from last 15 messages, spawns target agent
- Chain continues until: no handoff in response, depth limit (default 5), error, or invalid agent
- Self-handoff and unknown-agent handoffs are blocked
- `[CREATE_CHANNEL:name --agent builder "description"]` creates new project channels

### Safety Guardrails

All Claude invocations include `--disallowedTools` blocking:
- `Bash(rm -rf:*)`, `Bash(git push --force:*)`, `Bash(git reset --hard:*)`
- `Bash(DROP:*)`, `Bash(DELETE FROM:*)`, `Bash(kill -9:*)`

These are applied in: `bot.ts`, `subagent-manager.ts`, `handoff-router.ts`, `task-runner.ts`.

### Testing

Run `HARNESS_ROOT=/path/to/AI-Harness npx tsx bridges/discord/test-upgrade.ts` to verify the data layer. See `.claude/skills/test-harness/SKILL.md` for the full test plan including manual Discord checks.

### Common Gotchas

- **PID file guard**: `.bot.pid` prevents duplicate instances. If bot crashes without cleanup, delete the file.
- **`--verbose` for stream-json**: `claude -p --output-format stream-json` requires `--verbose`. The `claude-runner.py` handles this.
- **LaunchAgent + TCC**: macOS blocks launchd-spawned processes from `~/Desktop`. Use symlink `~/.local/ai-harness → ~/Desktop/AI-Harness`.
- **Clean env ≠ no auth**: `env -i` strips Claude auth. Pass full env minus CLAUDE* vars instead.

---

## Promoted Learnings

<!-- Learnings that recur 3+ times get added here automatically -->
<!-- Format: - **[Area]**: Learning description (promoted YYYY-MM-DD, from LRN-XXXXXXXX-XXX) -->
