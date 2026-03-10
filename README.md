# AI Harness

A self-improving, persistently learning AI agent system built on Claude Code's skills v2 architecture. Talk to Claude through Discord, and it learns from every interaction.

## What It Does

AI Harness connects Claude to Discord so you can chat with it like a teammate. Behind the scenes, it:

- **Remembers conversations** per Discord channel (session persistence)
- **Learns from mistakes** — errors, corrections, and knowledge gaps get logged automatically
- **Promotes patterns** — when the same lesson appears 3+ times, it gets baked into Claude's permanent instructions
- **Generates new skills** — reusable workflows get extracted into standalone skill files

## How It Works (High Level)

```
You (Discord) → Bot → Python Runner → Claude CLI → Response → Bot → You (Discord)
```

1. You send a message in Discord
2. The bot receives it via discord.js
3. It spawns a **detached Python process** that runs Claude CLI with a clean environment
4. Claude processes your message (with full project context from CLAUDE.md)
5. Python writes the JSON response to a temp file
6. The bot polls for that file, parses out the human-readable text, and replies in Discord

### Why Python? Why a temp file?

Claude CLI is a Node.js app. When you try to spawn it from another Node.js process (like our Discord bot), it hangs indefinitely — a [known bug](https://github.com/anthropics/claude-code/issues/771). Python's `subprocess.run()` doesn't have this issue, so we use Python as a bridge.

But even with Python as an intermediary, Node.js's pipe handling can stall when connected to the Python process's stdout. The solution: Python writes output to a temp file, and Node.js polls for it. No pipes, no stalling.

## Project Structure

```
AI-Harness/
├── CLAUDE.md                    # Claude's personality & project instructions
├── PLAN.md                      # 6-phase build plan
├── README.md                    # You are here
│
├── bridges/discord/             # Discord integration
│   ├── bot.ts                   # Discord bot (message handling, Claude spawning)
│   ├── claude-runner.py         # Python wrapper for Claude CLI
│   ├── session-store.ts         # Channel → session mapping (for conversation continuity)
│   ├── .env                     # Bot token & config (gitignored)
│   └── test-runner.sh           # End-to-end tests for the runner
│
├── .claude/                     # Claude Code configuration
│   ├── settings.json            # Hook configuration
│   └── skills/
│       └── self-improve/        # Auto-learning skill
│           └── SKILL.md
│
├── learnings/                   # Self-improvement logs
│   ├── LEARNINGS.md             # Knowledge gaps & corrections
│   ├── ERRORS.md                # Command failures & patterns
│   └── FEATURE_REQUESTS.md      # Requested capabilities
│
└── scripts/                     # Automation hooks
    ├── activator.sh             # Detects corrections & feature requests
    ├── error-detector.sh        # Catches bash failures
    └── extract-skill.sh         # Scaffolds new skills from learnings
```

## Quick Start

### Prerequisites
- Node.js 22+
- Python 3
- Claude Code CLI installed and authenticated (`claude --version`)
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))

### Setup

```bash
cd bridges/discord
npm install

# Create .env from template
cp .env.example .env
# Edit .env with your Discord bot token, allowed user IDs, and project root path
```

### Run

```bash
cd bridges/discord
npx tsx bot.ts > bot.log 2>&1 &
tail -f bot.log
```

The bot has a PID file guard — if you accidentally try to start a second instance, it will exit automatically.

### Discord Commands

| Command | Description |
|---------|-------------|
| `/new` | Clear the current conversation session |
| `/status` | Show the active session ID |
| *(any message)* | Send to Claude and get a response |

## Architecture Deep Dive

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed technical documentation of each component.

## Build Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | Foundation | Done |
| 2 | Self-Improvement Engine | Done |
| 3 | Discord Bridge | Done |
| 4 | Heartbeat & Scheduled Tasks | Not started |
| 5 | Skill Discovery | Not started |
| 6 | Emergent Behavior Loop | Not started |

See [PLAN.md](./PLAN.md) for full details on each phase.
