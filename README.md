# AI Harness

**A self-improving AI agent system that gets smarter every time you use it.**

AI Harness wraps Claude Code in a persistent infrastructure layer — Discord bot interface, recursive learning pipeline, semantic memory, scheduled background tasks, and inter-agent collaboration — so that every interaction teaches the system something it remembers forever.

> Built by [Anderson Edmond](https://github.com/AndersonsRepo) as a personal AI infrastructure project. The system manages multiple production projects, handles academic tracking, monitors deployments, and evolves its own capabilities over time.

---

## Why This Exists

Claude Code is powerful, but it forgets everything between sessions. Every conversation starts from zero. AI Harness solves this by building deterministic infrastructure *around* the LLM:

- **Memory that persists** — An Obsidian-compatible knowledge vault with semantic search
- **Mistakes that stick** — Errors and corrections auto-logged, deduplicated, and promoted to permanent instructions after recurring 3+ times
- **Skills that grow** — Reusable workflows extracted into standalone skill files
- **Agents that collaborate** — Specialized personalities (builder, researcher, reviewer, ops) that hand off work to each other
- **Background autonomy** — 13 scheduled tasks running via macOS launchd: deployment monitoring, assignment reminders, vault maintenance, and more

The core philosophy: **the LLM handles language; deterministic infrastructure handles everything else** — memory retrieval, context assembly, routing, scheduling, and state management.

---

## Architecture

```
                          Discord
                            |
                     +------v------+
                     |   bot.ts    |  Queue, commands, streaming
                     +------+------+
                            |
              +-------------+-------------+
              |             |             |
        task-runner    handoff-router  subagent-mgr
              |             |             |
              +------+------+------+------+
                     |             |
              context-assembler   embeddings.ts
              (deterministic)     (Ollama + nomic-embed-text)
                     |             |
              +------v------+------v------+
              |         SQLite            |
              |     (sessions, tasks,     |
              |      projects, config)    |
              +---------------------------+
              |     Obsidian Vault        |
              |  (learnings, knowledge,   |
              |   agent memory, daily)    |
              +---------------------------+
                            |
              +---------------------------+
              |       MCP Servers         |
              |  mcp-vault (7 tools)      |
              |  mcp-harness (9 tools)    |
              +---------------------------+
```

### The Self-Improvement Loop

```
User interacts with Claude
  -> Hooks auto-capture learnings, errors, corrections
    -> Dedup engine increments recurrence (not duplicates)
      -> Embeddings generated (Ollama, 768d vectors)
        -> Next invocation: context daemon injects relevant knowledge
          -> Claude performs better, avoids past mistakes
            -> Recurrence hits 3+ -> promoted to CLAUDE.md
              -> ALL future invocations benefit permanently
```

This is a **closed feedback loop**: the system literally rewrites its own instructions based on observed patterns.

### Key Design Decisions

| Decision | Why |
|----------|-----|
| **Python subprocess for Claude CLI** | Node.js-to-Node.js spawning [hangs indefinitely](https://github.com/anthropics/claude-code/issues/771). Python's `subprocess.run()` doesn't. |
| **File-based output (not pipes)** | Even with Python, stdout pipes stall. Atomic `.tmp` -> rename + FileWatcher eliminates this. |
| **SQLite for operational state** | WAL mode, single-file, zero config. Fast enough for synchronous reads without caching. |
| **Obsidian vault for knowledge** | Human-readable markdown with YAML frontmatter. Works with Obsidian's graph view. Not a database — a knowledge base. |
| **Deterministic context injection** | The LLM never decides what to look up. A daemon assembles ~5000 tokens of relevant context before every invocation. |
| **Local embeddings (Ollama)** | Free, fast on Apple Silicon, no API calls. nomic-embed-text: 768 dimensions, 8K context window. |

---

## Features

### Discord Bot Interface
- Message routing with request queue (no race conditions)
- Live streaming responses with progressive message editing
- Multi-channel support with per-channel configuration
- Project channels with agent assignment and handoff chains
- 14+ slash commands for task management, vault queries, health checks

### Skill System (15 Skills)
Skills are reusable, structured capabilities with YAML frontmatter:

| Skill | Description | Key Feature |
|-------|-------------|-------------|
| `/github` | PR, issue, and repo management | Uses `gh` CLI |
| `/vercel` | Deployment monitoring for production apps | Confirmation required for deploys |
| `/supabase` | Safe database queries with SQL guardrails | Blocks DROP/DELETE/ALTER |
| `/academics` | Canvas LMS + GoodNotes academic tracking | PDF reading, due date alerts |
| `/scout` | Evaluate URLs and tech against all projects | Writes scouting reports to vault |
| `/learned` | Explicitly capture mid-conversation knowledge | Writes complete vault entries |
| `/heartbeat` | Manage scheduled background tasks | LaunchAgent CRUD |
| `/health-report` | System health: bot, DB, heartbeat, vault, truncation | One-command diagnostics |
| `/vault-query` | Search and analyze the knowledge base | Stats, promotions, tags |
| `/digest` | Summarize learnings for a date range | Daily/weekly rollups |
| `/review-changes` | Code review for uncommitted changes | Runs in isolated fork |
| `/find-skill` | Discover or create new skills | Auto-scaffolding |
| `/test-harness` | Automated + manual test checklist | Changed-file detection |
| `self-improve` | Auto-triggered on errors and corrections | Hook-driven |
| `doc-on-success` | Auto-update docs after confirmed changes | Git-diff aware |

### Agent System (6 Core + Custom)
Specialized personalities that hand off work to each other:

- **Builder** — Implementation-focused, writes production code
- **Researcher** — Deep investigation, read-only exploration
- **Reviewer** — Code review with security and quality focus
- **Ops** — Infrastructure, deployment, database operations
- **Commands** — Helps users navigate bot capabilities
- **Project** — Auto-configures for any codebase via MCP tools + living knowledge files

The Project agent reads from `vault/shared/project-knowledge/<name>.md` — a living document updated by `project_scan` (initial scan) and `session-debrief` (ongoing learnings). Each knowledge file has a **Conventions** section where recurring project-specific patterns are promoted automatically. Custom agents only exist for projects with compliance/safety requirements (e.g., Hey Lexxi for HIPAA).

Agents communicate via `[HANDOFF:agent_name]` directives with depth limits and safety checks.

### Background Tasks (13 Heartbeat Jobs)
All managed via macOS launchd (`~/Library/LaunchAgents/`):

| Task | Interval | Purpose |
|------|----------|---------|
| health-check | 10 min | System health monitoring |
| notification-drain | 5 min | Deliver pending notifications to Discord |
| deploy-monitor | 30 min | Watch Vercel deployments for failures |
| session-cleanup | 1 hr | Clean stale sessions |
| goodnotes-watch | 1 hr | Detect new GoodNotes PDF exports |
| assignment-reminder | 12 hr | Canvas LMS due date alerts |
| daily-digest | 24 hr | Learning summary |
| promotion-check | 24 hr | Surface learnings ready for promotion |
| github-watch | Periodic | Monitor repo activity (disabled — replaced by webhooks + repo-scanner) |
| repo-scanner | 6 hr | Security/hygiene scan: secrets, debug artifacts, .env, large files, npm audit |
| session-debrief | 3 hr | Extract knowledge from Claude Code transcripts (hybrid LLM + deterministic dedup) |
| learning-pruner | 7 days | Clean low-value learnings |
| vault-backup | Periodic | Vault integrity backup |
| lattice-evolve | Periodic | Generative art evolution |

### Semantic Search & Embeddings
- **Model**: nomic-embed-text via Ollama (768-dimensional, local, free)
- **Hybrid search**: 70% semantic similarity + 30% keyword matching
- **Auto-indexing**: fs.watch on vault directories with 3-second debounce
- **Storage**: JSON file (brute-force cosine similarity is sub-millisecond for <1000 entries)
- **Upgrade path**: sqlite-vec when vault exceeds 500 files

### MCP Servers (3 Custom)

#### MCP Vault Server (`mcp-vault`)
Custom Model Context Protocol server exposing the vault as 7 tools:

| Tool | Purpose |
|------|---------|
| `vault_search` | Semantic + keyword hybrid search |
| `vault_read` | Read full vault entry content |
| `vault_write` | Create entries with dedup (pattern-key matching) |
| `vault_list` | Filter by type, status, area, tag |
| `vault_promote_candidates` | Find learnings ready for promotion |
| `vault_sync_embeddings` | Full re-index of vault embeddings |
| `vault_stats` | Vault analytics |

#### MCP Harness Server (`mcp-harness`)
Infrastructure observability server exposing 9 tools for system health and diagnostics:

| Tool | Purpose |
|------|---------|
| `harness_health` | System health: bot PID, DB tables, heartbeat states, vault stats, truncation metrics |
| `harness_digest` | Learning summaries by date range with category breakdown |
| `harness_heartbeat_list` | All tasks with config, state, and launchd status |
| `harness_heartbeat_toggle` | Enable/disable a heartbeat task |
| `harness_heartbeat_run` | Manually execute a script-type task |
| `harness_context_preview` | Keyword extraction + vault search preview for a prompt |
| `harness_skills` | List all skills with frontmatter metadata |
| `harness_agents` | List all agents with descriptions and skill routing |
| `harness_truncation_report` | Detailed truncation stats and recent events |

#### MCP Projects Server (`mcp-projects`)
Centralized project management server exposing 6 tools:

| Tool | Purpose |
|------|---------|
| `project_list` | List all registered projects with metadata |
| `project_register` | Add/update a project in the registry |
| `project_scan` | Auto-scan a project directory and generate knowledge file |
| `project_context` | Get combined registry + knowledge data for context injection |
| `project_remove` | Unregister a project (keeps knowledge file) |
| `project_scan_security` | Run repo security scanner — checks for secrets, debug artifacts, .env files, large files, npm vulnerabilities |

### Truncation Monitor
All truncation operations are wrapped with observability:
- Smart boundary-aware truncation (paragraphs > headings > sentences > word boundaries)
- Structure damage detection (unclosed code blocks, broken tables)
- Discord messages split into multiple sends instead of hard-truncated
- JSONL event logging with severity classification (benign/significant/critical)
- LLM is notified when injected learnings are significantly truncated

### Safety Guardrails
Every Claude invocation includes `--disallowedTools` blocking destructive commands:
- `rm -rf`, `git push --force`, `git reset --hard`
- `DROP`, `DELETE FROM`, `kill -9`
- Supabase skill blocks all DDL and unqualified writes
- Deploy and rollback operations require explicit user confirmation

---

## Quick Start

### Prerequisites
- **Node.js 22+** and **npm**
- **Python 3.10+**
- **Claude Code CLI** installed and authenticated (`claude --version`)
- **Ollama** with nomic-embed-text (`ollama pull nomic-embed-text`)
- **Discord bot token** ([Developer Portal](https://discord.com/developers/applications))

### Setup

```bash
git clone https://github.com/AndersonsRepo/AI-Harness.git
cd AI-Harness

# Install Discord bridge dependencies
cd bridges/discord
npm install
cp .env.example .env
# Edit .env: add DISCORD_TOKEN, ALLOWED_USER_IDS, HARNESS_ROOT

# Install MCP vault server
cd ../../mcp-servers/mcp-vault
npm install
npx tsc

# Start Ollama (for semantic search)
ollama serve &
ollama pull nomic-embed-text

# Start the bot
cd ../../bridges/discord
HARNESS_ROOT=/path/to/AI-Harness npx tsx bot.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | Yes | Discord bot token |
| `ALLOWED_USER_IDS` | Yes | Comma-separated Discord user IDs |
| `HARNESS_ROOT` | Yes | Absolute path to AI-Harness root |
| `STREAM_CHANNEL_ID` | No | Discord channel for agent activity stream |
| `OLLAMA_URL` | No | Ollama API URL (default: `http://localhost:11434`) |

### Load Heartbeat Tasks

```bash
# Load all scheduled tasks
for plist in ~/Library/LaunchAgents/com.aiharness.heartbeat.*.plist; do
  launchctl load "$plist"
done
```

---

## Project Structure

```
AI-Harness/
├── bridges/discord/           # Discord bot + all core infrastructure
│   ├── bot.ts                 # Main: queue, commands, task dispatch, streaming
│   ├── task-runner.ts         # Bounded-step execution, retry, dead-letter
│   ├── claude-runner.py       # Python subprocess bridge to Claude CLI
│   ├── context-assembler.ts   # Deterministic context injection daemon
│   ├── embeddings.ts          # Ollama embedding pipeline + hybrid search
│   ├── truncation-monitor.ts  # Smart truncation with observability
│   ├── handoff-router.ts      # Inter-agent handoff chains
│   ├── subagent-manager.ts    # Background subagent lifecycle
│   ├── db.ts                  # SQLite singleton (WAL mode)
│   ├── session-store.ts       # Channel -> session mapping
│   ├── channel-config-store.ts # Per-channel agent/model config
│   ├── project-manager.ts     # Project CRUD + handoff depth
│   ├── process-registry.ts    # Subagent tracking
│   ├── file-watcher.ts        # Event-driven output detection
│   ├── stream-poller.ts       # Progressive stream-json parsing
│   ├── activity-stream.ts     # Discord embeds for #agent-stream
│   └── promotion-handler.ts   # Learning -> CLAUDE.md promotion
│
├── mcp-servers/
│   ├── mcp-vault/             # MCP server for vault operations
│   │   └── index.ts           # 7 tools: search, read, write, list, promote, sync, stats
│   ├── mcp-harness/           # MCP server for infrastructure observability
│   │   └── index.ts           # 9 tools: health, digest, heartbeat, context, skills, agents, truncation
│   └── mcp-projects/          # MCP server for project management
│       └── index.ts           # 6 tools: list, register, scan, context, remove, scan_security
│
├── .claude/
│   ├── skills/                # 15 skill definitions (SKILL.md + supporting scripts)
│   ├── agents/                # 6 core + 1 custom (client-project for HIPAA). Project knowledge lives in vault.
│   └── settings.json          # Hook configuration (activator + error-detector)
│
├── heartbeat-tasks/           # Background task definitions + scripts
│   ├── *.json                 # Task configs (schedule, type, notify channel)
│   ├── projects.example.json  # Template for project registration (copy to projects.json)
│   ├── scripts/*.py           # Task implementations (read from projects.json)
│   ├── heartbeat-runner.py    # Task executor with state tracking
│   └── logs/                  # Per-task log files
│
├── vault/                     # Obsidian-compatible knowledge vault
│   ├── learnings/             # Individual LRN/ERR/FEAT entries
│   ├── shared/                # Cross-agent knowledge
│   │   ├── project-knowledge/ # Auto-generated by Project agent (gitignored)
│   │   └── scouted/           # Tech evaluation reports
│   ├── agents/                # Per-agent working memory
│   └── daily/                 # Daily activity notes
│
├── CLAUDE.md                  # Agent instructions + promoted learnings
├── ARCHITECTURE.md            # Technical deep dive (this project)
└── docs/                      # Extended documentation
    ├── SELF-IMPROVEMENT.md    # The recursive learning loop explained
    ├── SKILLS-AND-AGENTS.md   # Skill system + agent personalities
    └── GETTING-STARTED.md     # Detailed setup guide
```

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| AI | Claude Code CLI (Opus 4.6) | Language model |
| Bot | discord.js 14, TypeScript 5 | Discord interface |
| Bridge | Python 3, subprocess | Claude CLI spawning |
| Database | better-sqlite3 (WAL mode) | Operational state |
| Knowledge | Obsidian vault (Markdown + YAML) | Long-term memory |
| Embeddings | Ollama + nomic-embed-text | Semantic search |
| Protocol | MCP (Model Context Protocol) | Tool exposure |
| Scheduling | macOS launchd | Background tasks |
| Monitoring | Custom truncation monitor | Observability |

---

## Documentation

| Document | Audience |
|----------|----------|
| [Architecture Deep Dive](./ARCHITECTURE.md) | Engineers wanting to understand internals |
| [Self-Improvement Loop](./docs/SELF-IMPROVEMENT.md) | Understanding the recursive learning system |
| [Skills & Agents](./docs/SKILLS-AND-AGENTS.md) | Extending the skill and agent systems |
| [Getting Started](./docs/GETTING-STARTED.md) | Setting up your own instance |

---

## What Makes This Different

Most AI agent frameworks focus on prompt chaining or tool use. AI Harness focuses on **infrastructure that makes the AI better over time**:

1. **Closed learning loop** — Not just logging errors, but deduplicating them, tracking recurrence, and promoting patterns into permanent instructions. The system literally rewrites its own `CLAUDE.md`.

2. **Deterministic context injection** — The LLM never decides what to remember. A daemon assembles relevant context from SQLite + semantic search and injects it before every invocation. The AI receives knowledge; it doesn't search for it.

3. **Multi-agent collaboration** — Not just routing to different prompts, but structured handoff chains with depth limits, context passing, and per-agent session isolation.

4. **Observable truncation** — Every truncation in the system is monitored, logged, and reported. When content is cut, the LLM is told explicitly and given tools to fetch the full version.

5. **Background autonomy** — 13 scheduled tasks run independently: monitoring deployments, checking assignments, pruning the vault, draining notifications. The system works while you sleep.

---

## License

MIT — see [LICENSE](./LICENSE).
