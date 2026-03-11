# AI Harness — Architecture

A technical deep dive into every component, why it was built the way it was, and how the pieces connect.

---

## System Overview

```
Discord user
    |
    v
bot.ts (queue + command dispatch)
    |
    +---> task-runner.ts (submit -> spawn -> watch -> retry -> dead-letter)
    |         |
    |         +---> context-assembler.ts (deterministic context injection)
    |         |         |
    |         |         +---> embeddings.ts (Ollama hybrid search)
    |         |         +---> SQLite (projects, configs, tasks)
    |         |         +---> vault/ (learnings, knowledge)
    |         |
    |         +---> claude-runner.py (clean env, subprocess, atomic write)
    |         |         |
    |         |         +---> Claude CLI (claude -p --output-format json)
    |         |
    |         +---> file-watcher.ts (event-driven output detection)
    |
    +---> handoff-router.ts (inter-agent collaboration chains)
    |         |
    |         +---> context-assembler.ts (same daemon)
    |
    +---> subagent-manager.ts (background task lifecycle)
              |
              +---> context-assembler.ts (same daemon)
```

Every path through the system goes through the context assembler. The LLM always arrives pre-loaded with relevant knowledge.

---

## 1. Discord Bot (`bridges/discord/bot.ts`)

The bot is a TypeScript application using discord.js v14. It's the entry point for all user interaction.

### Message Flow

```
Discord Message
    |
    v
messageCreate listener
    |
    +-- Bot message? -> ignore
    +-- Not in ALLOWED_USER_IDS? -> ignore
    +-- Slash command? -> handle directly
    |
    v
Request Queue (one-at-a-time per channel)
    |
    v
handleClaude()
    |
    +-- Show typing indicator
    +-- Build Claude CLI args
    +-- Generate unique temp file path
    +-- Spawn via task-runner (detached Python process)
    +-- FileWatcher polls for output
    |
    v
Parse response -> split for Discord limits -> reply
Save session ID for --resume continuity
```

### Key Design Decisions

**One request at a time**: A queue per channel prevents resource contention. Queued requests get a hourglass reaction. This is simple and reliable — no need for a job queue system.

**PID file guard**: `.bot.pid` prevents duplicate instances. On startup, check if old PID is alive before proceeding.

**Stream-json polling**: For long responses, `stream-poller.ts` progressively parses `stream-json` output files, editing the Discord message with new content as it arrives (every 2 seconds).

---

## 2. Claude Runner (`bridges/discord/claude-runner.py`)

The critical bridge between Node.js and Claude CLI.

### The Problem

Claude Code CLI is a Node.js application. Spawning it from another Node.js process via `child_process.spawn()` hangs indefinitely — a [known bug](https://github.com/anthropics/claude-code/issues/771). Even with Python as an intermediary, stdout pipes can stall.

### The Solution

```
Node.js Bot                    Python Runner                  Claude CLI
    |                              |                              |
    +-- spawn(detached,            |                              |
    |   stdio:'ignore')            |                              |
    |   ----------------------->   |                              |
    |                              +-- subprocess.run()           |
    |                              |   (capture_output=True)      |
    |                              |   ----------------------->   |
    |                              |                              |
    |   (FileWatcher waiting)      |   (blocking wait)            |  (processing)
    |                              |                              |
    |                              |   <-----------------------   |
    |                              |                              |
    |                              +-- Write JSON to .tmp file    |
    |                              +-- Atomic rename .tmp -> .out |
    |                              |                              |
    |   FileWatcher fires!         |                              |
    |   <-----------               |                              |
    |                              |                              |
    v                              v                              v
Parse JSON response           Process exits                  Done
```

**Three critical rules:**
1. Strip `CLAUDE*` env vars — prevents "Cannot be launched inside another Claude Code session"
2. File-based output — no pipes between any processes
3. Detached + stdio:ignore — parent never blocks on child

### Environment Sanitization

```python
clean_env = {k: v for k, v in os.environ.items()
             if not k.startswith("CLAUDE")}
```

This preserves authentication (API keys, tokens) while removing the variables that trigger Claude CLI's nested-session detection.

---

## 3. Context Injection Daemon (`bridges/discord/context-assembler.ts`)

The daemon that makes the system smart. Purely deterministic — no LLM involved.

### How It Works

Before every Claude invocation, the daemon:

1. Queries SQLite for active project, channel config, task history
2. Extracts keywords from the user's prompt (stopword-filtered)
3. Runs hybrid search: 70% cosine similarity + 30% keyword match
4. Assembles a ~5000 token context block from priority-ordered sections
5. Injects via `--append-system-prompt`

### Why Deterministic?

The LLM never decides what to remember or look up. This is intentional:

- **Predictable**: Same query always produces same context (modulo vault changes)
- **Debuggable**: Context logs show exactly what was injected for each invocation
- **Fast**: No LLM call for retrieval — just SQLite queries and vector math
- **Reliable**: Fail-open design — if context assembly fails, the spawn proceeds without it

### Token Budget

Total: ~20,000 chars (~5,000 tokens). Learnings get 40% of the budget because they're the most valuable.

---

## 4. Semantic Search (`bridges/discord/embeddings.ts`)

### Embedding Pipeline

```
Vault file created/modified
    |
    v
fs.watch detects change (3s debounce)
    |
    v
Read file, strip YAML frontmatter
    |
    v
Send to Ollama (nomic-embed-text, 768 dimensions)
    |
    v
Normalize vector (unit length for cosine similarity)
    |
    v
Store in vault-embeddings.json
```

### Hybrid Search

```
Query: "why does the bot hang when spawning Claude?"
    |
    +---> Semantic: embed query, compute cosine similarity with all vectors
    +---> Keyword: extract ["bot", "hang", "spawning", "claude"], match against file content
    |
    v
Merge: score = (semantic * 0.7) + (keyword * 0.3)
    |
    v
Filter: score > 0.3
    |
    v
Return top 5 results with match type labels
```

### Why Local Embeddings?

- **Free**: No API costs, no rate limits
- **Fast**: nomic-embed-text runs in ~10ms on Apple Silicon
- **Private**: Vault content never leaves the machine
- **Good enough**: 768 dimensions captures semantic meaning well for <1000 documents

### Storage Decision

JSON file with brute-force cosine similarity. For <1000 entries, this takes sub-millisecond. The upgrade path (sqlite-vec) is documented but unnecessary at current scale.

---

## 5. Task Runner (`bridges/discord/task-runner.ts`)

Manages bounded-step execution with retry logic and dead-letter fallback.

### Lifecycle

```
submitTask() -> INSERT into task_queue (status: pending)
    |
    v
spawnTask() -> spawn claude-runner.py, status: running
    |
    v
FileWatcher detects output
    |
    +-- Parse response
    +-- Check for [CONTINUE] marker
    |
    +-- Has [CONTINUE]? -> increment step, spawn next step
    |
    +-- No [CONTINUE]? -> status: completed, post to Discord
    |
    +-- Error? -> retry with exponential backoff
    |       (5s, 25s, 125s, max 3 attempts)
    |
    +-- Max retries? -> move to dead_letter table, notify channel
```

### Crash Recovery

On startup, the task runner checks for tasks stuck in `running` or `waiting_continue` status. For each:

1. Check if the PID is still alive
2. If alive: re-attach FileWatcher
3. If dead: reset status, attempt retry

---

## 6. Inter-Agent Handoffs (`bridges/discord/handoff-router.ts`)

Agents collaborate by handing off work to each other.

### Handoff Protocol

```
Agent A completes work, outputs:
  "Here's my analysis of the problem. [HANDOFF:builder] Please implement this fix."
    |
    v
bot.ts detects [HANDOFF:builder] directive
    |
    v
handoff-router.ts:
  1. Validate: target agent exists? not self-handoff? under depth limit?
  2. Build context: last 15 messages + project state
  3. Inject daemon context
  4. Spawn target agent with handoff message
    |
    v
Builder agent receives:
  "researcher has handed off to you with this request: Please implement this fix."
  + full conversation context
  + daemon-assembled knowledge
```

### Safety

- **Depth limit**: Default 5, configurable per project
- **Self-handoff blocked**: Agent can't hand off to itself
- **Unknown agents rejected**: Only registered agents can be targets
- **Session isolation**: Each agent in a chain gets its own session via compound key `channelId:agentName`

---

## 7. Data Layer

### SQLite (`bridges/discord/harness.db`)

All operational state in a single WAL-mode database:

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `sessions` | Channel → session mapping | channelId, sessionId |
| `channel_configs` | Per-channel settings | channelId, agent, model, permissions, tools |
| `subagents` | Background task tracking | id, status, PID, agent, startedAt |
| `projects` | Project channel registration | channelId, name, agents, handoffDepth |
| `task_queue` | Bounded-step execution | id, channelId, status, stepCount, retryCount |
| `dead_letter` | Failed tasks | id, channelId, error, attempts |

**Store pattern**: All 4 store modules follow the same design — import `getDb()`, no caching (WAL is fast enough), array fields stored as JSON strings, upserts via `INSERT ... ON CONFLICT DO UPDATE`.

### Obsidian Vault (`vault/`)

Long-term knowledge in human-readable markdown with YAML frontmatter:

```
vault/
├── learnings/           # LRN-*, ERR-*, FEAT-* entries
├── shared/              # Cross-agent knowledge
│   ├── conventions.md   # Coding standards
│   ├── tool-gotchas.md  # Known pitfalls
│   ├── project-knowledge/  # Per-project context
│   └── scouted/         # Tech evaluation reports
├── agents/              # Per-agent working memory
└── daily/               # Daily activity notes
```

The vault is NOT a database. It's a knowledge base designed for both machine retrieval (semantic search + frontmatter queries) and human browsing (Obsidian graph view, wikilinks).

---

## 8. MCP Vault Server (`mcp-servers/mcp-vault/index.ts`)

A Model Context Protocol server that exposes the vault as structured tools over JSON-RPC via stdio.

### Tools

| Tool | Input | Output |
|------|-------|--------|
| `vault_search` | query string, optional keywords | Ranked results with scores and match types |
| `vault_read` | entry ID | Full file content |
| `vault_write` | ID, type, title, tags, patternKey, body | Created file path (with dedup) |
| `vault_list` | optional filters (type, status, tag, area) | Filtered entry list |
| `vault_promote_candidates` | — | Entries with recurrence >= 3 |
| `vault_sync_embeddings` | — | Sync stats (added, updated, removed) |
| `vault_stats` | — | Entry counts, status breakdown |

### Dedup in `vault_write`

Before creating a new entry, the server scans all existing entries for a matching `pattern-key`. If found, it increments `recurrence-count` and updates `last-seen` instead of creating a duplicate. This is the same logic used by the shell hooks (`dedup-learning.sh`).

> **Critical**: Never use `console.log` in an MCP stdio server — it corrupts the JSON-RPC stream. All logging goes through `console.error`.

---

## 9. Truncation Monitor (`bridges/discord/truncation-monitor.ts`)

Every truncation in the system is monitored for data loss.

### Smart Truncation

Instead of hard `text.slice(0, limit)`, the monitor:

1. Identifies a cut zone (last 15% of the limit)
2. Searches for natural boundaries: paragraph break > heading > sentence end > line break > word boundary
3. Detects structure damage: unclosed code blocks, broken YAML frontmatter, mid-table cuts
4. Auto-closes damaged structures (e.g., adds closing ``` for unclosed code blocks)
5. Logs the event with severity, % lost, and preview of cut content

### Severity Levels

| Level | Threshold | Action |
|-------|-----------|--------|
| Benign | < 30% lost | Log only |
| Significant | 30-60% lost | Log + notify LLM in context |
| Critical | > 60% lost | Log + stderr warning + notify LLM |

### Discord Integration

- **Messages**: `splitForDiscord()` splits into multiple sends instead of truncating
- **Embeds**: `truncateForEmbed()` returns overflow for file attachment
- **Context**: LLM is told when learnings are truncated with guidance to use `vault_read`

---

## 10. File Watching (`bridges/discord/file-watcher.ts`)

Event-driven output detection replaces all polling:

- Watches the **directory** (not the file) because the file doesn't exist when the watcher starts
- `retryReadMs` delay (50-100ms) after `fs.watch` event — lets atomic `.tmp → rename` complete
- Fallback poll (2-5s) as safety net for unreliable `fs.watch` (macOS FSEvents edge cases)
- `trackWatcher()` / `untrackWatcher()` / `stopAllWatchers()` for clean shutdown
- One watcher per output file (not one global poll)

---

## Common Gotchas

These are hard-won lessons from building the system:

| Gotcha | Impact | Fix |
|--------|--------|-----|
| Node.js spawning Node.js (Claude CLI) | Indefinite hang | Use Python subprocess bridge |
| `CLAUDECODE=1` env var in child process | "Cannot launch inside another session" | Strip all CLAUDE* env vars |
| `stdout` pipe stalling | Process appears to hang | File-based output with atomic rename |
| `--append-system-prompt` consuming the prompt | Prompt disappears | Always use `--` separator before the prompt |
| macOS TCC blocking launchd access to ~/Desktop | "Operation not permitted" | Use symlink from ~/.local/ |
| `HARNESS_ROOT` not set | Database path resolves wrong | Always set explicitly in env |
| `console.log` in MCP stdio server | JSON-RPC stream corruption | Use `console.error` for logging |
| `fs.watch` duplicate events | Double-processing files | Debounce with 3-second window |
