# AI Harness

**A self-improving AI agent system that gets smarter every time you use it.**

AI Harness wraps Claude Code in a persistent infrastructure layer — Discord bot interface, recursive learning pipeline, semantic memory, 21+ scheduled background tasks, real-time agent monitoring, and inter-agent collaboration — so that every interaction teaches the system something it remembers forever.

> Built by [Anderson Edmond](https://github.com/AndersonsRepo) as a personal AI infrastructure project. The system manages multiple production projects, handles academic tracking, monitors deployments, and evolves its own capabilities over time.

---

## Why This Exists

Claude Code is powerful, but it forgets everything between sessions. Every conversation starts from zero. AI Harness solves this by building deterministic infrastructure *around* the LLM:

- **Memory that persists** — An Obsidian-compatible knowledge vault with semantic search and temporal decay
- **Mistakes that stick** — Errors and corrections auto-logged, deduplicated, and promoted to permanent instructions after recurring 3+ times
- **Skills that grow** — 16 reusable workflows extracted into standalone skill files
- **Agents that collaborate** — 9 specialized personalities (builder, researcher, reviewer, ops, education, and more) that hand off work to each other with review gates
- **Background autonomy** — 21+ scheduled tasks running via macOS launchd: deployment monitoring, assignment reminders, email watching, vault maintenance, and more
- **Real-time monitoring** — Live Discord embeds showing every Claude instance's tool calls, thinking, cost, and intervention buttons (Kill/Redirect/Inject/Pause)
- **Transport-agnostic core** — Gateway abstraction separates orchestration from Discord, enabling future iMessage/web adapters

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
              (deterministic)     (Ollama + nomic-embed-text
                     |             + temporal decay)
              +------v------+------v------+
              |         SQLite            |
              |     (sessions, tasks,     |
              |    projects, telemetry)   |
              +---------------------------+
              |     Obsidian Vault        |
              |  (learnings, knowledge,   |
              |   course notes, daily)    |
              +---------------------------+
                            |
              +---------------------------+
              |       MCP Servers         |
              |  mcp-vault (7 tools)      |
              |  mcp-harness (10 tools)   |
              |  mcp-projects (6 tools)   |
              |  mcp-outlook (5 tools)    |
              |  mcp-linkedin (4 tools)   |
              +---------------------------+
```

### The Self-Improvement Loop

```
User interacts with Claude
  -> Hooks auto-capture learnings, errors, corrections
    -> Dedup engine increments recurrence (not duplicates)
      -> Embeddings generated (Ollama, 768d vectors, temporal decay)
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
| **Transport-agnostic gateway** | Core orchestration separated from Discord specifics. Same engine can serve iMessage, web, or other transports. |
| **Retry with backoff** | Transient API errors (429, 5xx) are retried 3x with exponential backoff before failing. |

---

## Features

### Real-Time Agent Monitor (`#monitor` channel)
Live-updating Discord embeds for every running Claude instance:
- **Thinking preview** — See what Claude is reasoning about between tool calls
- **Tool call thread** — Timestamped log of every tool invocation with actual commands
- **Cost tracking** — Token estimates with color alerts (yellow at $0.50, red at $1.00)
- **Stale detection** — Warning when an instance goes idle for 60+ seconds
- **Intervention buttons** — Kill, Redirect (to different agent), Inject (guidance via modal), Pause/Resume
- **Completion summaries** — Persistent one-line summary when embeds auto-delete

### Discord Bot Interface
- Message routing with per-channel task queue (no race conditions)
- Live streaming responses with progressive message editing
- Multi-channel support with per-channel agent/model configuration
- Project channels with agent assignment and handoff chains
- 20+ commands for task management, vault queries, health checks
- Orphaned task recovery — responses still delivered after bot restart

### Gateway Abstraction (Transport-Agnostic Core)
The orchestration engine is fully decoupled from Discord:
- **`core-types.ts`** — `TransportAdapter` interface, `GatewayMessage`, `PendingTaskEntry`
- **`core-gateway.ts`** — Task queue, stream polling, output routing, notification drain, telemetry
- **`core-commands.ts`** — 20+ commands as pure functions returning `CommandResult`
- **`discord-transport.ts`** — Discord adapter implementing `TransportAdapter`
- **139 tests** across 4 test suites validating the abstraction

### Skill System (16 Skills)
Skills are reusable, structured capabilities with YAML frontmatter:

| Skill | Description | Key Feature |
|-------|-------------|-------------|
| `/github` | PR, issue, and repo management | Uses `gh` CLI |
| `/vercel` | Deployment monitoring for production apps | Confirmation required for deploys |
| `/supabase` | Safe database queries with SQL guardrails | Blocks DROP/DELETE/ALTER |
| `/academics` | Canvas LMS + GoodNotes academic tracking | PDF reading, due date alerts, study guides |
| `/scout` | Evaluate URLs and tech against all projects | Writes scouting reports to vault |
| `/learned` | Explicitly capture mid-conversation knowledge | Writes complete vault entries |
| `/heartbeat` | Manage scheduled background tasks | LaunchAgent CRUD, cron expressions |
| `/health-report` | System health: bot, DB, heartbeat, vault, truncation | One-command diagnostics |
| `/security-audit` | Security posture: credentials, git, heartbeat, config | Automated self-assessment |
| `/vault-query` | Search and analyze the knowledge base | Stats, promotions, tags |
| `/digest` | Summarize learnings for a date range | Daily/weekly rollups |
| `/review-changes` | Code review for uncommitted changes | Runs in isolated fork |
| `/find-skill` | Discover or create new skills | Auto-scaffolding |
| `/test-harness` | Automated + manual test checklist | Changed-file detection |
| `self-improve` | Auto-triggered on errors and corrections | Hook-driven |
| `doc-on-success` | Auto-update docs after confirmed changes | Git-diff aware |

### Agent System (9 Agents)
Specialized personalities that hand off work to each other:

| Agent | Role | Tool Restrictions |
|-------|------|-------------------|
| **Orchestrator** | Plans work, delegates to specialists, captures learnings | Cannot edit/write code |
| **Builder** | Implementation-focused, writes production code | All tools |
| **Researcher** | Deep investigation, read-only exploration | Read-only whitelist |
| **Reviewer** | Code review with security and quality focus | Read-only + git |
| **Education** | Course-specific tutor grounded in lecture notes | Read-only + vault |
| **Ops** | Infrastructure, deployment, database operations | All tools |
| **Project** | Auto-configures for any codebase via scanning | All tools |
| **Commands** | Helps users navigate bot capabilities | Limited |
| **Hey Lexxi** | Domain-specific (HIPAA compliance) | Custom |

**Review Gate**: When a builder agent finishes work, a reviewer agent is automatically injected if one hasn't participated in the chain. This is infrastructure-enforced — the LLM cannot skip review.

**Orchestrator Debrief**: When a multi-agent chain completes, the orchestrator extracts learnings and posts a structured summary.

### Academic Intelligence
- **Per-course Discord channels** — `#numerical-methods`, `#philosophy`, `#systems-programming`, `#comp-society`
- **Notes ingestion** — GoodNotes PDFs → Claude Sonnet → structured vault markdown (every 4h)
- **Education agent** — Read-only tutor that searches vault notes before answering
- **Assignment reminders** — Canvas iCal parsing, course routing, quiz study guide generation (daily at 8am)
- **CS 2600 website crawler** — Weekly crawl with content-hash diffing
- **Email scanning** — Gmail watcher indexes forwarded emails, surfaces career/internship/deadline keywords
- **Context injection** — Course note counts and recent notes injected into agent context when in a course channel

### Background Tasks (21+ Heartbeat Jobs)
All managed via macOS launchd with active hours, cron expressions, and failure auto-pause:

| Task | Schedule | Purpose |
|------|----------|---------|
| notification-drain | 5 min | Deliver pending notifications to Discord |
| gmail-watcher | 15 min | Monitor forwarded emails via Gmail API |
| deploy-monitor | 30 min | Watch Vercel deployments for failures |
| goodnotes-watch | 1 hr | Detect new GoodNotes PDF exports |
| lattice-evolve | 1 hr | Generative art evolution |
| calendar-sync | 2 hr | Sync Outlook calendar events |
| session-debrief | 3 hr | Extract knowledge from Claude Code transcripts |
| notes-ingest | 4 hr | GoodNotes PDF → vault course notes pipeline |
| health-check | 6 hr | System health monitoring |
| repo-scanner | 6 hr | Security scan: secrets, debug artifacts, npm audit |
| assignment-reminder | Daily 8am | Canvas due dates + email event scanning + study guides |
| daily-digest | Daily 10am | Learning summary |
| code-review | 12 hr | Automated code review of registered projects |
| lead-gen-pipeline | 12 hr | Lead generation scanning |
| promotion-check | 12 hr | Surface learnings ready for CLAUDE.md promotion |
| learning-pruner | 24 hr | Archive stale/duplicate learnings |
| session-cleanup | 24 hr | Clean stale sessions and old dead letters |
| vault-backup | 24 hr | Auto-commit vault changes to git |
| token-expiry-check | 24 hr | Warn about expiring OAuth tokens |
| cs2600-watch | Weekly | CS 2600 website crawler |

Features: **active hours** (skip overnight), **cron expressions** (`"0 8 * * 1-5"`), **retry with backoff**, **auto-pause after 3 failures**, **noise reduction** (only notify on meaningful changes).

### Semantic Search & Embeddings
- **Model**: nomic-embed-text via Ollama (768-dimensional, local, free)
- **Hybrid search**: 70% semantic similarity + 30% keyword matching
- **Temporal decay**: 30-day half-life — recent learnings rank higher (evergreen files exempt)
- **Auto-indexing**: fs.watch on vault directories with 3-second debounce
- **Storage**: JSON file (brute-force cosine similarity is sub-millisecond for <1000 entries)

### MCP Servers (5 Custom)

| Server | Tools | Purpose |
|--------|-------|---------|
| **mcp-vault** | 7 | Vault CRUD + semantic search + embedding sync |
| **mcp-harness** | 10 | Health, digest, heartbeat management, telemetry, context preview |
| **mcp-projects** | 6 | Project registry, auto-scanning, security scanning |
| **mcp-outlook** | 5 | Outlook email search, calendar, watched senders |
| **mcp-linkedin** | 4 | Post drafting, approval flow, publishing |

### Reliability Features
- **Retry with backoff** — Claude CLI retries transient errors (429, 5xx) 3x with 5/15/45s delays
- **API cooldown** — After 3 consecutive failures, tasks pause for 5 minutes with Discord notification
- **Loop detection** — Kills tasks repeating the same tool call 4+ times
- **Crash recovery** — On restart, re-attaches to alive Claude processes and registers them with the monitor
- **Orphan task recovery** — Tasks that survive a bot restart still deliver responses to the original channel
- **Pre-compaction flush** — Stop hook runs session-debrief when a conversation ends

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

# Install MCP servers
cd ../../mcp-servers/mcp-vault && npm install
cd ../mcp-harness && npm install
cd ../mcp-projects && npm install

# Start Ollama (for semantic search)
ollama serve &
ollama pull nomic-embed-text

# Start the bot
cd ../../bridges/discord
HARNESS_ROOT=/path/to/AI-Harness npx tsx bot.ts
```

### Load Heartbeat Tasks

```bash
# Generate and install all heartbeat plists
for config in heartbeat-tasks/*.json; do
  name=$(basename "$config" .json)
  [[ "$name" == *.state* || "$name" == "projects" ]] && continue
  python3 heartbeat-tasks/scripts/generate-plist.py "$name" --install
done
```

### Run Tests

```bash
cd bridges/discord

# All test suites (139 tests)
HARNESS_ROOT=../.. npx tsx test-discord-transport.ts
HARNESS_ROOT=../.. npx tsx --test tests/types.test.ts tests/gateway.test.ts tests/commands.test.ts tests/handoff-adapter.test.ts
```

---

## Project Structure

```
AI-Harness/
├── bridges/discord/           # Discord bot + core infrastructure
│   ├── bot.ts                 # Main: queue, commands, task dispatch, streaming
│   ├── task-runner.ts         # Bounded-step execution, retry, dead-letter, loop detection
│   ├── claude-runner.py       # Python subprocess bridge with retry + backoff
│   ├── core-types.ts          # Transport-agnostic types (TransportAdapter, GatewayMessage)
│   ├── core-gateway.ts        # Gateway orchestration engine (transport-agnostic)
│   ├── core-commands.ts       # 20+ command handlers as pure functions
│   ├── discord-transport.ts   # Discord adapter implementing TransportAdapter
│   ├── context-assembler.ts   # Deterministic context injection daemon
│   ├── embeddings.ts          # Ollama embeddings + hybrid search + temporal decay
│   ├── instance-monitor.ts    # Real-time Claude instance tracking
│   ├── monitor-ui.ts          # Discord embeds + buttons + threads for monitoring
│   ├── monitor-interventions.ts # Kill/Redirect/Inject/Pause handlers
│   ├── handoff-router.ts      # Inter-agent handoff chains + review gate
│   ├── stream-poller.ts       # Progressive stream-json parsing
│   ├── db.ts                  # SQLite singleton (WAL mode, v3 schema)
│   └── tests/                 # Unit + integration tests (57 tests)
│
├── mcp-servers/
│   ├── mcp-vault/             # 7 tools: search, read, write, list, promote, sync, stats
│   ├── mcp-harness/           # 10 tools: health, digest, heartbeat, telemetry, context
│   ├── mcp-projects/          # 6 tools: list, register, scan, context, remove, security
│   ├── mcp-outlook/           # 5 tools: emails, read, calendar, senders, summary
│   └── mcp-linkedin/          # 4 tools: draft, post, history, profile
│
├── .claude/
│   ├── skills/                # 16 skill definitions
│   ├── agents/                # 9 agent personalities
│   └── settings.json          # Hooks: activator, error-detector, session-flush
│
├── heartbeat-tasks/           # 21+ background task configs + scripts
│   ├── *.json                 # Task configs (schedule/cron, activeHours, notify)
│   ├── scripts/*.py           # Task implementations
│   ├── scripts/generate-plist.py # Plist generator (interval + cron support)
│   └── heartbeat-runner.py    # Task executor with state tracking + noise reduction
│
├── vault/                     # Obsidian-compatible knowledge vault
│   ├── learnings/             # Individual LRN/ERR/FEAT entries
│   ├── shared/
│   │   ├── project-knowledge/ # Auto-generated project knowledge
│   │   ├── course-notes/      # Academic notes (4 courses)
│   │   └── scouted/           # Tech evaluation reports
│   ├── agents/                # Per-agent working memory
│   └── daily/                 # Daily activity notes
│
└── CLAUDE.md                  # Agent instructions + promoted learnings
```

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| AI | Claude Code CLI (Opus 4.6) | Language model |
| Bot | discord.js 14, TypeScript 5 | Discord interface |
| Bridge | Python 3, subprocess | Claude CLI spawning with retry |
| Database | better-sqlite3 (WAL mode, v3) | Operational state + telemetry |
| Knowledge | Obsidian vault (Markdown + YAML) | Long-term memory |
| Embeddings | Ollama + nomic-embed-text | Semantic search with temporal decay |
| Protocol | MCP (Model Context Protocol) | Tool exposure (5 servers, 32 tools) |
| Scheduling | macOS launchd | Background tasks (cron + interval) |
| Monitoring | Custom instance monitor | Real-time agent observability |
| OAuth | Google + Microsoft + LinkedIn | Email, calendar, social integrations |
| Testing | Node.js test runner | 139 tests across 4 suites |

---

## What Makes This Different

Most AI agent frameworks focus on prompt chaining or tool use. AI Harness focuses on **infrastructure that makes the AI better over time**:

1. **Closed learning loop** — Not just logging errors, but deduplicating them, tracking recurrence, and promoting patterns into permanent instructions. The system literally rewrites its own `CLAUDE.md`.

2. **Deterministic context injection** — The LLM never decides what to remember. A daemon assembles relevant context from SQLite + semantic search and injects it before every invocation. The AI receives knowledge; it doesn't search for it.

3. **Real-time observability** — Every running Claude instance has a live Discord embed showing tool calls, thinking, cost estimates, and intervention buttons. You can kill, redirect, or inject guidance into any running agent.

4. **Transport-agnostic gateway** — The orchestration core has zero Discord imports. A typed `TransportAdapter` interface means the same engine can serve Discord, iMessage, a web UI, or any other transport. 139 tests validate the abstraction.

5. **Multi-agent collaboration with review gates** — Not just routing to different prompts, but structured handoff chains with depth limits, automatic code review injection, orchestrator debriefs, and per-agent session isolation.

6. **Background autonomy** — 21+ scheduled tasks run independently: monitoring deployments, checking assignments, scanning emails, pruning the vault, draining notifications. The system works while you sleep.

---

## License

MIT — see [LICENSE](./LICENSE).
