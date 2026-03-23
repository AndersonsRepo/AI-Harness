# AI Harness — Agent Instructions

You are a self-improving personal AI agent for Anderson Edmond. You operate across Discord and iMessage, run background tasks on schedule, and continuously learn from every interaction.

## Core Principles

1. **Learn from every mistake** — Log errors, corrections, and knowledge gaps to `vault/learnings/`
2. **Promote recurring patterns** — When a learning recurs 3+ times, promote it to this file
3. **Build new skills** — When you discover a reusable workflow, extract it into a new skill
4. **Be concise** — Lead with the answer, skip filler
5. **Ask before destructive actions** — Never delete, force-push, or overwrite without confirmation
6. **Log discoveries proactively** — When you debug a tricky bug, discover a non-obvious behavior, or make an architecture decision, use `/learned` to log it. Don't wait for hooks.

## Session-End Knowledge Dump

Before context compaction or when a long conversation is winding down, write vault entries for anything significant learned this session. Check:

- **Bugs debugged** — Root cause + fix → `vault/learnings/ERR-*.md`
- **Architecture decisions** — What was decided and why → `vault/learnings/LRN-*.md`
- **Gotchas discovered** — Things that fail silently or are easy to get wrong → `vault/learnings/ERR-*.md`
- **Project context** — Facts about repos, APIs, stacks shared by the user → `vault/learnings/LRN-*.md`

Use `/learned` for each entry. Fill in ALL fields — no placeholders. If nothing significant was learned, skip this.

## Projects I Work On

Projects are registered in `heartbeat-tasks/projects.json` and their knowledge stored in `vault/shared/project-knowledge/`. The Project agent auto-scans any new codebase on first invocation — no manual configuration needed.

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

### Context Injection Daemon

Every Claude invocation gets a deterministic context block injected via `--append-system-prompt` **before the LLM sees the prompt**. The assembler queries SQLite + vault and builds a ~5000-token context window (~20,000 chars).

**Module**: `bridges/discord/context-assembler.ts`
**Injected at**: `task-runner.ts` (spawnTask), `handoff-router.ts` (executeHandoff), `subagent-manager.ts` (spawnSubagent)

Priority-ordered sections (trimmed if over budget):
1. Active project + channel config (600 chars)
2. Relevant learnings — hybrid: semantic + keyword + self-RAG relevance filter + graph neighbor expansion (12000 chars)
3. Project-specific knowledge (3000 chars)
4. Task history — last 5 (1200 chars)
5. Recent Outlook — last 24h email summary, watched sender alerts (800 chars)
5.2. Recent calendar — next 12h events from Calendar.app via osascript (600 chars)
5.5. Recent academic notes — course note counts, recent notes if in course channel (1200 chars)
6. Conventions + tool gotchas (2000 + 2000 chars)
7. Heartbeat status (800 chars)
8. Pending work — notifications, dead letters (600 chars)

**Semantic Search**: `bridges/discord/embeddings.ts` — Ollama + nomic-embed-text (768d, local, free). Embeddings stored in `vault/vault-embeddings.json`. Synced on bot startup and when files are written via MCP.

**MCP Vault Server**: `mcp-servers/mcp-vault/` — Registered as `vault` in `~/.claude/Config/mcp-config.json`. Tools: `vault_search`, `vault_read`, `vault_write`, `vault_list`, `vault_promote_candidates`, `vault_sync_embeddings`, `vault_stats`, `vault_graph`.

**MCP Harness Server**: `mcp-servers/mcp-harness/` — Registered as `harness` in `~/.claude/Config/mcp-config.json`. Tools: `harness_health`, `harness_digest`, `harness_heartbeat_list`, `harness_heartbeat_toggle`, `harness_heartbeat_run`, `harness_context_preview`, `harness_skills`, `harness_agents`, `harness_truncation_report`.

**Session Debrief**: `heartbeat-tasks/scripts/session-debrief.py` — Runs every 3h. Reads Claude Code transcripts (`.claude/projects/.../*.jsonl`), extracts conversation text (deterministic), sends to Claude Sonnet for knowledge extraction (non-deterministic), then writes vault entries with pattern-key dedup (deterministic). Also appends learnings to relevant `vault/shared/project-knowledge/<name>.md` files. Uses `--model sonnet` for cost efficiency. Includes **conflict resolution**: when a new learning matches an existing entry (by pattern-key or title), an LLM call decides UPDATE (overwrite), BUMP (update timestamp), or NOOP (skip). Superseded entries get `status: superseded` + `superseded_by`/`superseded_at` fields and a `supersedes` edge in `learning_edges`.

**MCP Projects Server**: `mcp-servers/mcp-projects/` — Registered as `projects` in `~/.claude/Config/mcp-config.json`. Tools: `project_list`, `project_register`, `project_scan`, `project_context`, `project_remove`, `project_scan_security`. Manages the project registry (`heartbeat-tasks/projects.json`) and generates knowledge files in `vault/shared/project-knowledge/`. Security scanning delegates to `heartbeat-tasks/scripts/repo-scanner.py`.

**MCP Outlook Server**: `mcp-servers/mcp-outlook/` — Registered as `outlook` in MCP config. Tools: `outlook_emails`, `outlook_email_read`, `outlook_calendar`, `outlook_senders`, `outlook_summary`. Queries `email_index` SQLite table (fast) and Graph API (live). Auto-refreshes Microsoft OAuth tokens.

**MCP LinkedIn Server**: `mcp-servers/mcp-linkedin/` — Registered as `linkedin` in MCP config. Tools: `linkedin_draft`, `linkedin_post`, `linkedin_history`, `linkedin_profile`. Draft→approve→publish flow with single-use approval tokens. Publishes to LinkedIn REST API.

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
- `schema_version` — migration tracking (current: v10)
- `sessions` — channelId → sessionId mapping (compound keys for projects: `channelId:agentName`)
- `channel_configs` — per-channel agent/model/permission/tools settings
- `subagents` — background task tracking (spawn, status, PID)
- `projects` — project channel registration, handoff depth
- `task_queue` — bounded-step execution, retry state, PID tracking
- `dead_letter` — tasks that failed after all retry attempts
- `oauth_tokens` — Microsoft + LinkedIn OAuth tokens (refresh token AES-256-GCM encrypted)
- `email_index` — cached Outlook emails (indexed by sender, date, project)
- `watched_senders` — email alert triggers with label and project association
- `linkedin_posts` — draft→approve→publish flow with single-use approval tokens
- `task_telemetry` — per-task metrics (tools, cost, duration, loops)
- `parallel_tasks` — tmux parallel group tracking (group_id, agent, status, result, tmux_window)
- `tracked_events` — persistent calendar/career/deadline events discovered from emails (categories: internship, career, deadline, event, assignment, meeting; fields: apply_link, contact_name, contact_email, location, organization)
- `retrieval_hits` — per-spawn log of which vault learnings were retrieved (learning_path, agent, channel_id, task_id, score, match_type). Used by learning-pruner for zero-hit archival.
- `learning_edges` — knowledge graph relations between vault entries (source_id, target_id, relation: supersedes/related_to/contradicts/depends_on, weight)
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
| `bridges/discord/handoff-router.ts` | Inter-agent handoffs, context building, chain execution, parallel directive detection |
| `bridges/discord/tmux-session.ts` | tmux CLI wrapper for parallel agent orchestration (session/window lifecycle) |
| `bridges/discord/tmux-orchestrator.ts` | Parallel agent spawning, group tracking, result aggregation |
| `bridges/discord/stream-poller.ts` | Progressive stream-json parsing for live message editing |
| `bridges/discord/activity-stream.ts` | Discord embeds to #agent-stream channel |
| `bridges/discord/context-assembler.ts` | Deterministic context injection daemon |
| `bridges/discord/embeddings.ts` | Ollama embedding pipeline + hybrid search |
| `mcp-servers/mcp-vault/index.ts` | MCP server for vault CRUD + semantic search |
| `mcp-servers/mcp-harness/index.ts` | MCP server for infrastructure observability (9 tools) |
| `mcp-servers/mcp-projects/index.ts` | MCP server for project management + security scanning (6 tools) |
| `mcp-servers/mcp-outlook/index.ts` | MCP server for Outlook email + calendar (5 tools) |
| `mcp-servers/mcp-calendar/index.ts` | MCP server for Calendar CRUD + ICS import + free block detection (8 tools) |
| `mcp-servers/mcp-linkedin/index.ts` | MCP server for LinkedIn post draft/approve/publish (4 tools) |
| `bridges/discord/oauth-store.ts` | OAuth token CRUD + AES-256-GCM encryption + auto-refresh |
| `bridges/discord/oauth-setup.ts` | One-time interactive OAuth flow for Microsoft + LinkedIn |
| `heartbeat-tasks/scripts/oauth_helper.py` | Python OAuth helper for heartbeat scripts |
| `bridges/discord/agent-loader.ts` | Shared agent loading, tool restriction definitions |
| `.claude/agents/*.md` | Agent personalities (orchestrator, researcher, reviewer, builder, ops, commands, project, education) |
| `heartbeat-tasks/scripts/session-debrief.py` | Knowledge extraction from Claude Code transcripts + conflict resolution |
| `heartbeat-tasks/scripts/repo-scanner.py` | Security scanning for registered projects |
| `heartbeat-tasks/scripts/notes-ingest.py` | GoodNotes PDF → vault course notes pipeline |
| `heartbeat-tasks/scripts/smart-schedule.py` | Calendar gap detection + Canvas assignment cross-reference + email event scanning |
| `heartbeat-tasks/scripts/cs2600-watch.py` | Weekly CS 2600 website crawler |
| `heartbeat-tasks/scripts/learning-pruner.py` | Archive stale/duplicate/zero-hit vault learnings (deterministic, no LLM) |
| `heartbeat-tasks/scripts/learning-compressor.py` | LLM-compress verbose vault entries to 150-250 char summaries |
| `heartbeat-tasks/scripts/graph-linker.py` | Build knowledge graph edges between vault entries (tag overlap, area match, supersession) |
| `heartbeat-tasks/scripts/morning-briefing.py` | Comprehensive morning intelligence: calendar + Canvas + email + tracked events + LLM synthesis |

### Critical: Claude CLI Spawning Rules

These rules are hard-won from debugging. Violating any of them will cause silent failures.

1. **Strip CLAUDE* env vars** — Claude CLI sets `CLAUDECODE=1` and `CLAUDE_CODE_ENTRYPOINT=cli`. If these exist when spawning `claude -p`, it errors "Cannot be launched inside another Claude Code session." The `claude-runner.py` script handles this by building a clean env.

2. **Never spawn Claude CLI directly from Node.js** — Node.js `child_process` + Claude CLI = indefinite hang ([known bug](https://github.com/anthropics/claude-code/issues/771)). Always go through `claude-runner.py` which uses Python's `subprocess.run()`.

3. **File-based output, not pipes** — Even with Python intermediary, stdout pipes can stall. `claude-runner.py` writes to a `.tmp` file then atomically renames. Node.js detects the final file via FileWatcher.

4. **Always use `--` before the prompt** — Flags like `--append-system-prompt`, `--allowedTools`, `--disallowedTools` are variadic in Commander.js. They consume all subsequent positional args including the prompt. Fix: `claude -p --append-system-prompt "..." -- "prompt here"`

5. **Always use `--dangerously-skip-permissions`** — Without this, `claude -p` prompts for tool approval in the terminal, blocking headless execution. Safety is enforced via `--disallowedTools` guardrails instead.

6. **Detached + stdio ignore** — Spawn `claude-runner.py` with `{ detached: true, stdio: "ignore" }` and call `proc.unref()`. This prevents the parent process from blocking on the child.

7. **Session compound keys** — In project channels, each agent gets its own session via `channelId:agentName`. Regular channels just use `channelId`. See `getProjectSessionKey()` in `handoff-router.ts`.

### Notification Routing Pattern

Heartbeat scripts write to `pending-notifications.jsonl`. The bot's `drainNotifications()` reads the `"channel"` field and resolves it by name against Discord guild channels. **Each script's `notify()` function must set the correct channel name** — the `discord_channel` field in heartbeat JSON configs is metadata only, not used by the drain logic.

Channel mapping: goodnotes-watch → `goodnotes`, assignment-reminder → `calendar`, deploy-monitor → `notifications`, repo-scanner → `notifications`, email-monitor → `emails`, calendar-sync → `calendar`, cs2600-watch → `systems-programming`, notes-ingest → per-course channel (numerical-methods, philosophy, systems-programming, comp-society), code-review → `notifications`, lead-gen-pipeline → `notifications`.

### GitHub Webhooks

GitHub→Discord webhooks are configured natively on each repo (not via code). Events (push, PR, issues, release) go to project-specific channels under the "Github" Discord category. This replaced the `github-watch.py` polling script.

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

- **Sequential**: Agents hand off work with `[HANDOFF:agent_name] description` at end of their output
- `bot.ts` detects the directive, `handoff-router.ts` builds context from last 15 messages, spawns target agent
- Chain continues until: no handoff in response, depth limit (default 5), error, or invalid agent
- Self-handoff and unknown-agent handoffs are blocked
- `[CREATE_CHANNEL:name --agent builder "description"]` creates new project channels
- **Parallel**: Orchestrator uses `[PARALLEL:agent1,agent2]` with `## agent` headers for per-agent task descriptions
- Each parallel agent runs in its own tmux window + detached subprocess
- Results collected via FileWatchers, aggregated as `[PARALLEL_COMPLETE]` back to orchestrator
- Max 4 parallel agents per group, counts against `MAX_CONCURRENT_PROCESSES`

### tmux Parallel Orchestration

**Module**: `bridges/discord/tmux-orchestrator.ts` + `bridges/discord/tmux-session.ts`

A single tmux session named `harness` hosts per-agent windows. Windows named `{agent}-{shortId}`.

**Flow:**
1. Orchestrator outputs `[PARALLEL:researcher,builder]` with per-agent task descriptions
2. `parseParallelDirective()` extracts agents + tasks
3. `spawnParallelGroup()` creates tmux windows, spawns processes, sets up FileWatchers
4. Each agent runs independently; results stored in `parallel_tasks` table
5. When all complete, `onGroupComplete` fires → builds `[PARALLEL_COMPLETE]` prompt
6. Orchestrator receives aggregated results and continues (handoff or another parallel batch)

**Discord commands**: `/tmux [list|attach|capture <window>|kill <window|groupId>]`

**Data**: `parallel_tasks` SQLite table (group_id, task_id, agent, tmux_window, status, result)

### Orchestrator Agent

The orchestrator is the default agent for new project channels. It plans work, delegates to specialists, and captures learnings.

**Flow:** User message → orchestrator plans phases → hands off to specialist → chain executes → review gate → orchestrator debrief

- **Tool restrictions**: Cannot Edit, Write, NotebookEdit, or run git commit/push/npm commands. Enforced at CLI level via `--disallowedTools`.
- **Debrief**: When a chain started by the orchestrator completes (2+ agents participated), `invokeOrchestratorDebrief()` in `bot.ts` sends `[CHAIN_COMPLETE]` with a chain summary back to the orchestrator. The orchestrator extracts learnings via `vault_write` and posts a summary.
- **Chain log**: `ChainResult` with `ChainEntry[]` accumulates each agent's (truncated) response during a handoff chain. Used for structured context injection and debrief.

### Agent Tool Restrictions

Defined in `bridges/discord/agent-loader.ts` (`AGENT_TOOL_RESTRICTIONS`). Applied deterministically at spawn time — the LLM cannot override them.

| Agent | Restriction | Tools |
|-------|------------|-------|
| `orchestrator` | disallowed | Edit, Write, NotebookEdit, git commit/push, npm/npx |
| `researcher` | allowed (whitelist) | Read, Grep, Glob, WebSearch, WebFetch, cat/ls/find/wc/head/tail, vault MCP (read-only), projects MCP (read-only) |
| `reviewer` | allowed (whitelist) | Read, Grep, Glob, cat/ls, git diff/log/show |
| `education` | allowed (whitelist) | Read, Grep, Glob, cat/ls/curl/python3, vault MCP (search/read/list) |
| `builder` | global guardrails only | All tools |
| `ops` | global guardrails only | All tools |
| `project` | global guardrails only | All tools |

### Review Gate

Deterministic review injection defined in `handoff-router.ts` (`REVIEW_GATE` map). After a handoff chain terminates:

- If the **final agent** is `builder` and `reviewer` has NOT already participated in the chain → auto-inject a reviewer handoff
- The reviewer gets the builder's output and produces a quality review
- This is infrastructure-enforced — the builder cannot skip review regardless of LLM output

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
- **HARNESS_ROOT required**: Always set `HARNESS_ROOT=/path/to/AI-Harness` when starting the bot. Without it, `db.ts` resolves `./bridges/discord/harness.db` relative to cwd, which fails if cwd is `bridges/discord/`.
- **Google Drive CloudStorage latency**: `~/Library/CloudStorage/GoogleDrive-*/` is a virtual filesystem. `os.walk()` can take 60-90s with many files. Set heartbeat timeouts accordingly (goodnotes-watch uses 120s).
- **Heartbeat auto-pause**: 3 consecutive failures auto-disables a task. Reset by setting `consecutive_failures: 0` and `enabled: true` in both the `.state.json` and task `.json` config.
- **Superseded learnings**: Context assembler skips entries with `status: superseded`. Session-debrief sets this status during conflict resolution. Check `superseded_by` field for the replacement entry.
- **Active hours**: Heartbeat configs can include `"activeHours": {"start": "07:00", "end": "23:00"}` to skip overnight runs. Checked by `heartbeat-runner.py` before execution.
- **Cron scheduling**: Heartbeat configs can use `"cron": "0 8 * * 1-5"` (5-field expression) instead of `"schedule": "12h"` for exact-time scheduling. Use `heartbeat-tasks/scripts/generate-plist.py <name> --install` to generate and install the plist with `StartCalendarInterval`.
- **API cooldown**: `task-runner.ts` tracks consecutive API failures. After 3 failures, tasks pause for 5 minutes with a Discord notification. Auto-resumes when cooldown expires.
- **Retry with backoff**: `claude-runner.py` retries transient errors (429, 5xx, connection resets) up to 3 times with 5s/15s/45s delays before reporting failure.
- **Loop detection**: `task-runner.ts` tracks the last 30 tool calls per task. If the same tool+args pattern repeats 4+ times, the task is killed with a warning.
- **Temporal decay**: Embedding search scores decay with a 30-day half-life (`score × e^(-λ × age)`). Files under `shared/` and `agents/` are exempt (evergreen).
- **Pre-compaction flush**: A `Stop` hook runs `session-debrief.py` when a Claude Code conversation ends, capturing learnings before context is lost.

---

## Skills System (v2)

Skills are Claude Code's mechanism for reusable, structured capabilities. Each skill lives at `.claude/skills/<name>/SKILL.md` with YAML frontmatter.

### Available Skills

| Skill | Invocable | Key Features |
|-------|-----------|-------------|
| `self-improve` | No (auto-triggered) | Logs learnings/errors/features to vault; inline execution (needs conversation context) |
| `heartbeat` | `/heartbeat` | LaunchAgent management; `!command` injects live launchd status |
| `find-skill` | `/find-skill` | Skill/vault search; `context: fork` + `agent: researcher` (read-only) |
| `doc-on-success` | No (auto-triggered) | Doc updates after confirmed changes; `model: sonnet`; `!command` injects git diff/log |
| `test-harness` | `/test-harness` | Automated + manual test checklist; `!command` injects changed files |
| `vault-query` | `/vault-query` | CLI vault search (stats, promotions, by-tag, free-form); `context: fork` + `model: sonnet` |
| `health-report` | `/health-report` | System health checks (bot, db, heartbeat, vault); `context: fork` + `agent: ops` |
| `security-audit` | `/security-audit` | Security posture check (credentials, git, heartbeat, config drift); `context: fork` + `agent: ops` + `model: sonnet` |
| `review-changes` | `/review-changes` | Code review for uncommitted changes; `context: fork` + `agent: reviewer` |
| `digest` | `/digest` | On-demand learning summaries with date ranges; `context: fork` + `model: sonnet` |
| `github` | `/github` | GitHub PR/issue/repo management via `gh` CLI; `context: fork` + `agent: ops` |
| `vercel` | `/vercel` | Vercel deployment management; `model: sonnet` |
| `academics` | `/academics` | Canvas LMS + GoodNotes academic tracking; `context: fork` + `agent: researcher` |
| `supabase` | `/supabase` | Safe Supabase DB queries with SQL guardrails; `context: fork` + `agent: ops` |
| `scout` | `/scout` | URL/tech evaluation against all projects; `context: fork` + `agent: researcher` + `model: sonnet` |
| `learned` | `/learned` | Explicit mid-conversation learning capture with full context; writes complete vault entries |

### Skills v2 Features Used

- **`allowed-tools`** — restricts which tools a skill can use
- **`context: fork`** — runs skill in isolated subagent (used by read-only skills: find-skill, vault-query, health-report, review-changes, digest)
- **`agent`** — routes to a specific agent type (researcher, ops, reviewer)
- **`model: sonnet`** — cheaper model for formulaic tasks (doc updates, vault queries, health checks)
- **`!command`** — live shell data injection (launchd status, git diff, changed files, process list)
- **`argument-hint`** — shows usage hint in skill list
- **`disable-model-invocation`** — prevents auto-triggering (review-changes)
- **Supporting files** — templates in `self-improve/templates/`, hook scripts in `self-improve/scripts/`

### Hook Scripts (Global)

Hooks live in `.claude/settings.json` (NOT skill-scoped) because they must fire on every interaction:
- `UserPromptSubmit` → `.claude/skills/self-improve/scripts/activator.sh` (detects corrections, feature requests)
- `PostToolUse[Bash]` → `.claude/skills/self-improve/scripts/error-detector.sh` (detects command failures)
- `Stop` → `.claude/skills/self-improve/scripts/session-flush.sh` (pre-compaction knowledge capture)

### Creating New Skills

Run `./scripts/extract-skill.sh <name>` to scaffold a new skill with v2 frontmatter template.

---

## Integrations

| Integration | Skill | Heartbeat | MCP Server | Safety |
|-------------|-------|-----------|------------|--------|
| GitHub | `/github` | — | github-server | fork, confirmation for merges |
| Vercel | `/vercel` | deploy-monitor (30m) | — | confirmation for deploy/rollback |
| Supabase | `/supabase` | — | supabase (postgres) | fork, SQL whitelist, no DELETEs |
| Canvas+GoodNotes | `/academics` | assignment-reminder (12h), goodnotes-watch (1h), notes-ingest (4h) | canvas | fork, read-only |
| CS 2600 Website | `/academics` | cs2600-watch (168h) | — | read-only crawl |
| Gmail | — | gmail-watcher (15m) | — | OAuth2, readonly scope, forwarded email indexing |
| Outlook | — | email-monitor (15m), calendar-sync (2h) | outlook (5 tools) | OAuth token encryption, auto-refresh |
| Calendar (iCloud) | — | smart-schedule (3h) | calendar (8 tools) | confirm gate on delete, read-only for researcher/education |
| LinkedIn | — | — | linkedin (4 tools) | approval token flow, !approve/!reject in Discord |

### Internal Heartbeat Tasks

| Task | Schedule | Purpose |
|------|----------|---------|
| session-debrief | 3h | Extract learnings from Claude Code transcripts → vault (with conflict resolution) |
| session-cleanup | 24h | Clean stale sessions (>7d) and old dead letters (>30d) |
| health-check | 6h | Bot process, DB, launchd status checks |
| daily-digest | 24h | Summarize vault activity and learnings |
| code-review | 12h | Automated code review of registered projects |
| lead-gen-pipeline | 12h | Lead generation scanning |
| smart-schedule | 3h | Calendar gap detection, study block suggestions, assignment alerts |
| repo-scanner | 6h | Security scanning (secrets, debug artifacts, npm audit) |
| learning-pruner | 24h | Archive stale/duplicate/zero-hit vault learnings (deterministic Python) |
| learning-compressor | 24h | LLM-compress verbose entries to 150-250 chars (active 02:00-06:00) |
| graph-linker | 24h | Build knowledge graph edges between vault entries |
| morning-briefing | 08:30 daily | Comprehensive intelligence digest: calendar + Canvas + email + tracked events |
| promotion-check | 12h | Detect recurring learnings for CLAUDE.md promotion |
| gmail-watcher | 15m | Monitor forwarded Outlook emails via Gmail API |
| notification-drain | 5m | Drain pending-notifications.jsonl → Discord |
| vault-backup | 24h | Auto-commit vault changes to git |
| token-expiry-check | 24h | Warn about expiring OAuth tokens |
| lattice-evolve | 1h | Autonomous lattice evolution cycle |

### Outlook Integration

**MCP Server**: `mcp-servers/mcp-outlook/` — Registered as `outlook` in MCP config.
**Tools**: `outlook_emails` (search indexed + live), `outlook_email_read` (full email by ID), `outlook_calendar` (calendar view with school tagging), `outlook_senders` (watched sender CRUD), `outlook_summary` (structured digest for context injection).

**Heartbeat Scripts**:
- `email-monitor.py` (15m) — indexes new emails, checks watched senders, matches projects, alerts to `#emails`
- `calendar-sync.py` (2h) — syncs 48h calendar window, notifies upcoming 24h events, school events to `#calendar`

**Context Injection**: `recentOutlook` section in `context-assembler.ts` (priority 5, 800 chars) — last 24h email summary (by sender, unread count), watched sender alerts. Always-on for every agent.

**Data**: `email_index` table (cached emails), `watched_senders` table (alert triggers).

### Calendar Integration

**MCP Server**: `mcp-servers/mcp-calendar/` — Registered as `calendar` in MCP config.
**Tools**: `calendar_list` (list calendars), `calendar_events` (events in date range), `calendar_create` (create event), `calendar_update` (update by UID), `calendar_delete` (delete by UID with confirm gate), `calendar_search` (text search), `calendar_import_ics` (parse public ICS feeds), `calendar_suggest_blocks` (find free time blocks).

**Backend**: AppleScript (`osascript`) → Calendar.app → iCloud sync → iPhone. Backend selected via `CALENDAR_BACKEND` env var (default: `applescript`). Future: `google` (Phase 4), `outlook` (Phase 5).

**AppleScript Gotchas**:
- Calendar objects have `name` but NOT `uid` or `id` — use name as identifier
- Event objects have `uid` — works for CRUD by UID
- `location`/`description` can return `missing value` — must check before coercing to text
- Multi-line descriptions break newline-delimited output — use `%%REC%%` delimiter + `cleanText()` helper
- Date setting must use component-by-component approach (locale-independent)
- First `osascript` call triggers macOS Automation permission dialog

**Heartbeat**: `smart-schedule.py` (3h, active 07:00-23:00) — detects free blocks, cross-references Canvas assignments, notifies `#calendar`.

**Context Injection**: `recentCalendar` section in `context-assembler.ts` (priority 5.2, 600 chars) — next 12h events via direct `osascript` call.

**Agent Restrictions**: Read tools (`calendar_list`, `calendar_events`, `calendar_search`) whitelisted for researcher + education agents. CRUD tools available to builder, ops, project.

### LinkedIn Integration

**MCP Server**: `mcp-servers/mcp-linkedin/` — Registered as `linkedin` in MCP config.
**Tools**: `linkedin_draft` (store draft + approval token → notify `#linkedin`), `linkedin_post` (publish with approval token), `linkedin_history` (query post history), `linkedin_profile` (authenticated user info).

**Approval Flow**: Agent generates content → `linkedin_draft` stores with random approval token → notification to `#linkedin` → user types `!approve <token>` or `!reject <token>` → bot publishes or rejects. Token is single-use and random.

**Data**: `linkedin_posts` table (draft/pending_approval/approved/published/rejected states).

### Academic Integration

**Vault Structure**: `vault/shared/course-notes/<course>/` — structured markdown extracted from GoodNotes PDFs.

| Course | Vault Dir | Discord Channel | Agent |
|--------|-----------|-----------------|-------|
| Numerical Methods | `numerical-methods/` | `#numerical-methods` | education |
| Intro to Philosophy | `philosophy/` | `#philosophy` | education |
| Systems Programming (CS 2600) | `systems-programming/` | `#systems-programming` | education |
| Computers and Society | `comp-society/` | `#comp-society` | education |

**Notes Ingestion Pipeline** (`notes-ingest.py`, 4h):
- Reads new PDFs from goodnotes-watch state → calls Claude Sonnet with `--allowedTools Read --max-turns 15` → writes structured vault markdown
- COURSE_MAP maps GoodNotes folder names → vault dirs and Discord channels
- Max 10 PDFs per run (cost control), failure tracking with MAX_FAILURES = 3

**CS 2600 Website Crawler** (`cs2600-watch.py`, weekly):
- Fetches course website (URL from `course-map.json`), content-hash diff, Claude Sonnet summary
- Maintains exam schedule in `vault/shared/course-notes/systems-programming/exam-schedule.md`

**Education Agent**: Read-only tutor assigned to all course channels. Searches vault notes before answering, generates practice questions, checks Canvas for deadlines. Tool-restricted to Read, Grep, Glob, curl, python3, and vault MCP.

**Context Injection**: `recentAcademic` section (priority 5.5, 1200 chars) — note counts per course, and if in a course channel, lists the 5 most recent notes. Uses `COURSE_CHANNEL_MAP` in `context-assembler.ts`.

### Auto-Created Discord Channels

On bot startup, `bot.ts` ensures these channels exist:

**School Category**:
- `#calendar` — Canvas iCal feed (assignments, events, due dates)
- `#goodnotes` — GoodNotes PDF export notifications
- `#emails` — Email alerts, calendar notifications
- `#numerical-methods` — Numerical Methods course (education agent auto-assigned)
- `#philosophy` — Intro to Philosophy course (education agent auto-assigned)
- `#systems-programming` — Systems Programming CS 2600 (education agent auto-assigned)
- `#comp-society` — Computers and Society (education agent auto-assigned)

**Top-level**:
- `#linkedin` — LinkedIn post drafts, approvals, confirmations

Course channels auto-assign the `education` agent via `setChannelConfig()` on creation or first startup detection.

### OAuth Infrastructure

**Token Store**: `bridges/discord/oauth-store.ts` — CRUD + AES-256-GCM encryption for refresh tokens + auto-refresh for Microsoft and LinkedIn.

**Setup**: `npx tsx oauth-setup.ts microsoft` / `npx tsx oauth-setup.ts linkedin` — one-time interactive OAuth flow (temp HTTP server on `:3847`, browser auth, token exchange).

**Python Helper**: `heartbeat-tasks/scripts/oauth_helper.py` — self-contained module for heartbeat scripts to get valid access tokens with auto-refresh.

**DB Tables** (v2 migration): `oauth_tokens` (provider, encrypted refresh token, access token, scopes, expiry).

---

## Cost-Sensitive Tools

**Brightdata MCP** — Every call to `mcp__brightdata__*` tools costs real money (scraping credits). **Always ask the user for confirmation before using Brightdata tools.** Explain what you're about to scrape and why. Never use Brightdata in loops, bulk operations, or speculative searches without explicit approval.

---

## Promoted Learnings

<!-- Learnings that recur 3+ times get added here automatically -->
<!-- Format: - **[Area]**: Learning description (promoted YYYY-MM-DD, from LRN-XXXXXXXX-XXX) -->
