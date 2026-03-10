# AI Harness — Build Plan

> A self-improving, persistently learning AI agent system built natively on Claude Code's skills v2 architecture. No OpenClaw dependency. Uses Discord as primary communication channel.

---

## Phase 1: Foundation — Project Scaffold & Core Memory System

### 1.1 Project Structure
```
AI-Harness/
├── CLAUDE.md                              # Agent personality, project knowledge, conventions
├── PLAN.md                                # This file
├── .claude/
│   ├── settings.json                      # Hooks, permissions, tool config
│   ├── skills/
│   │   ├── self-improve/                  # Phase 2
│   │   ├── find-skill/                    # Phase 4
│   │   └── heartbeat/                     # Phase 4
│   └── agents/
│       ├── researcher.md                  # Deep research subagent
│       └── reviewer.md                    # Code review subagent
├── bridges/
│   └── discord/                           # Phase 3
│       ├── package.json
│       ├── bot.ts                         # Discord bot using discord.js
│       └── session-store.ts              # Discord channel → Claude session mapping
├── learnings/
│   ├── LEARNINGS.md                       # Corrections, knowledge gaps, best practices
│   ├── ERRORS.md                          # Command failures, patterns
│   └── FEATURE_REQUESTS.md               # Capabilities requested
├── scripts/
│   ├── activator.sh                       # Hook: nudge to evaluate learnings
│   ├── error-detector.sh                 # Hook: catch bash failures
│   └── extract-skill.sh                  # Auto-generate skills from learnings
└── .gitignore
```

### 1.2 Tasks
- [ ] Create folder structure
- [ ] Write CLAUDE.md with agent personality, project conventions, and links to learnings
- [ ] Create .gitignore (node_modules, .env, *.log, .DS_Store)
- [ ] Initialize learnings/ with empty templates (LEARNINGS.md, ERRORS.md, FEATURE_REQUESTS.md)
- [ ] Set up .claude/settings.json with initial hook configuration

### 1.3 Key Decisions
- **Language**: TypeScript (matches your stack — Next.js, Mento, Hey Lexxi)
- **Package manager**: pnpm (lightweight, fast)
- **Node version**: 22+ (already have 23.11.0)

---

## Phase 2: Self-Improvement Engine

The core differentiator. Every interaction teaches the agent.

### 2.1 Skill: `self-improve`

**SKILL.md** — Auto-triggered skill (no `disable-model-invocation`) that activates when:
- A command fails unexpectedly
- User corrects Claude ("No, that's wrong...", "Actually...")
- A knowledge gap is discovered
- A better approach is found for a recurring task

**Behavior:**
1. Detect the event type (error, correction, knowledge gap, feature request)
2. Log it with structured metadata:
   - `LRN-YYYYMMDD-XXX` for learnings
   - `ERR-YYYYMMDD-XXX` for errors
   - `FEAT-YYYYMMDD-XXX` for feature requests
3. Search existing entries for recurring patterns (keyword match)
4. Link related entries via "See Also"
5. Increment recurrence count on matches
6. **Promotion rule**: When a pattern recurs 3+ times across 2+ distinct tasks within 30 days → promote to CLAUDE.md or specialized memory file

**Hook Integration (.claude/settings.json):**
```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "command": "./scripts/activator.sh"
    }],
    "PostToolUse": [{
      "matcher": "Bash",
      "command": "./scripts/error-detector.sh"
    }]
  }
}
```

### 2.2 Scripts
- **activator.sh**: Lightweight nudge (~50-100 tokens) reminding the agent to evaluate learnings after task completion
- **error-detector.sh**: Detects non-zero exit codes from Bash tool, triggers error logging
- **extract-skill.sh**: When a learning is verified + recurring + broadly useful → auto-generates a new SKILL.md in .claude/skills/

### 2.3 Promotion Targets
| Learning Type         | Target File   | Example                                    |
|-----------------------|---------------|--------------------------------------------|
| Behavioral patterns   | CLAUDE.md     | "Be concise, avoid disclaimers"            |
| Tool gotchas          | CLAUDE.md     | "Git push needs auth configured first"     |
| Project conventions   | CLAUDE.md     | "Always use pnpm, not npm"                 |
| Reusable workflows    | New skill     | Auto-extracted via extract-skill.sh         |

### 2.4 Tasks
- [ ] Write self-improve/SKILL.md with detection triggers and logging instructions
- [ ] Create learning entry templates (learning, error, feature request)
- [ ] Write activator.sh hook script
- [ ] Write error-detector.sh hook script
- [ ] Write extract-skill.sh for skill auto-generation
- [ ] Test the loop: make a deliberate mistake → verify it gets logged → correct it → verify learning logged → repeat 3x → verify promotion

---

## Phase 3: Discord Bridge (Primary Communication Channel)

### 3.1 Why Discord First
- No macOS permission headaches (FDA, TCC, Automation)
- Mature ecosystem: discord.js has 2M+ weekly npm downloads
- Multiple existing reference implementations
- Works from any device (phone, tablet, other computers)
- Threads map naturally to Claude Code sessions
- Rich formatting (embeds, code blocks, reactions)

### 3.2 Architecture
```
[Discord DM/Channel] → [discord.js bot] → [claude -p --output-format stream-json]
                                         ↓
                     [session-store.ts: channelId → sessionId mapping]
                                         ↓
                     [--resume <sessionId> for persistent conversations]
```

### 3.3 Key Design Decisions
- **Library**: discord.js (TypeScript, matches your stack)
- **Session persistence**: JSON file mapping Discord channel/thread IDs → Claude session IDs
- **Message handling**: Use `--resume` for follow-up messages in the same channel
- **Streaming**: `--output-format stream-json` → progressive message editing ("Thinking..." → final response)
- **Long responses**: Split at line boundaries preserving code blocks; upload as .md file if >4000 chars
- **Concurrency**: Queue system — one Claude process at a time to avoid rate limits
- **Security**: Whitelist your Discord user ID only — no one else can talk to your agent

### 3.4 Discord Bot Setup
1. Create application at https://discord.com/developers/applications
2. Enable MESSAGE_CONTENT privileged intent
3. Generate bot token → store in .env
4. Invite bot to a private server (just you)
5. Bot listens for DMs or messages in designated channels

### 3.5 Features
- `/ask <question>` — One-shot question (no session persistence)
- Regular messages — Persistent session per channel/thread
- `/new` — Start a fresh session
- `/status` — Check Claude Code status, token usage
- `/run <skill>` — Invoke a Claude Code skill remotely
- Typing indicator while Claude is processing
- Error messages with retry suggestions

### 3.6 Tasks
- [ ] Create Discord application and bot
- [ ] Initialize bridges/discord/ with package.json (discord.js, typescript, dotenv)
- [ ] Write bot.ts — message listener, Claude subprocess spawning, response splitting
- [ ] Write session-store.ts — persist channel→session mappings
- [ ] Add .env.example with required variables (DISCORD_TOKEN, ALLOWED_USER_IDS)
- [ ] Add process manager config (pm2 or launchd plist) for persistence
- [ ] Test: DM the bot → get a response → follow up → verify session continuity

---

## Phase 3.5: Memory Infrastructure — mem0 Semantic Memory Layer

### 3.5.1 Why mem0

Markdown files in `learnings/` work for human auditing, but they fail at scale:
- **Keyword search breaks** — "git push auth error" won't match "remote rejected because credentials expired"
- **Cross-agent blindness** — The researcher agent can't find what the Discord agent learned yesterday
- **No scoping** — Everything is flat files; no distinction between shared knowledge, per-agent knowledge, and session-ephemeral context

**mem0** solves this by adding a semantic memory layer on top. It stores memories as embeddings, supports scoped access (user/agent/session), and lets agents search by meaning rather than keywords.

### 3.5.2 Architecture

```
[Agent writes a learning]
        ↓
[Dual-write strategy]
  ├── learnings/*.md  ← human audit trail (existing system, unchanged)
  └── mem0 API        ← semantic search index (new)
        ↓
[mem0 stores embedding in ChromaDB via Ollama nomic-embed-text]
        ↓
[Any agent can search semantically: mem0.search("auth failures on push", agent_id=...)]
```

### 3.5.3 Stack — No Docker Required

| Component         | Role                        | Install                              |
|-------------------|-----------------------------|--------------------------------------|
| mem0ai            | Memory SDK                  | `pip install mem0ai`                 |
| Ollama            | Local embedding model host  | `brew install ollama`                |
| nomic-embed-text  | Embedding model (768-dim)   | `ollama pull nomic-embed-text`       |
| ChromaDB          | Vector store (embedded)     | Bundled with mem0ai (SQLite-backed)  |

**Upgrade path**: When memories exceed ~1000 entries, swap ChromaDB for Qdrant binary (`brew install qdrant`). mem0 supports both — just change the config.

### 3.5.4 Multi-Agent Memory Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        mem0 Memory Store                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Scope: user_id="anderson" (SHARED — all agents read/write)    │
│  ├── Promoted learnings, project conventions, tool gotchas      │
│  ├── Cross-project knowledge (Mento ↔ Hey Lexxi)               │
│  └── User preferences and corrections                           │
│                                                                  │
│  Scope: agent_id="researcher" (PRIVATE to researcher agent)    │
│  ├── Research methodology notes                                 │
│  ├── Source credibility ratings                                  │
│  └── In-progress investigation context                          │
│                                                                  │
│  Scope: agent_id="discord" (PRIVATE to Discord bridge agent)   │
│  ├── Conversation tone calibration                              │
│  ├── Message formatting preferences                             │
│  └── Channel-specific context                                   │
│                                                                  │
│  Scope: agent_id="reviewer" (PRIVATE to code review agent)     │
│  ├── Code style preferences per project                         │
│  ├── Common review findings                                     │
│  └── PR review history patterns                                 │
│                                                                  │
│  Scope: run_id="session-xyz" (EPHEMERAL — single session)      │
│  ├── Current task context                                       │
│  ├── Scratch findings (discarded after session ends)            │
│  └── Intermediate reasoning steps                               │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Agent IDs:**
| Agent       | agent_id     | Reads from shared? | Writes to shared? |
|-------------|--------------|---------------------|--------------------|
| Main        | `main`       | Yes                 | Yes                |
| Researcher  | `researcher` | Yes                 | Yes (findings)     |
| Reviewer    | `reviewer`   | Yes                 | Yes (patterns)     |
| Discord     | `discord`    | Yes                 | Yes (corrections)  |

**Communication flow**: Agents don't talk to each other directly. Instead:
1. Agent A writes findings to shared memory (`user_id="anderson"`)
2. Agent B searches shared memory semantically before starting work
3. This creates implicit coordination — the researcher's findings automatically inform the reviewer's decisions

### 3.5.5 MCP Integration

Use `mem0-mcp-selfhosted` to expose mem0 as an MCP server, giving Claude Code native tool access:

```json
// .claude/settings.json (mcpServers section)
{
  "mcpServers": {
    "mem0": {
      "command": "mem0-mcp-selfhosted",
      "args": ["--config", "./memory/mem0-config.yaml"]
    }
  }
}
```

This gives Claude Code tools like `mem0_add`, `mem0_search`, `mem0_update`, `mem0_delete` — accessible from any skill or agent.

### 3.5.6 Dual-Write Strategy

The existing markdown files in `learnings/` remain the source of truth for human review. mem0 is the search index.

```
[self-improve skill detects learning]
        ↓
  ├── 1. Write to learnings/LEARNINGS.md (existing behavior, unchanged)
  └── 2. mem0.add(learning_text, user_id="anderson", metadata={
              "source": "self-improve",
              "entry_id": "LRN-20260309-001",
              "type": "correction",
              "project": "mento"
          })
```

If mem0 is down or unavailable, the system degrades gracefully — markdown files still work, just without semantic search.

### 3.5.7 Tasks
- [ ] Install mem0ai: `pip install mem0ai`
- [ ] Install Ollama and pull embedding model: `ollama pull nomic-embed-text`
- [ ] Create `memory/mem0-config.yaml` with ChromaDB + Ollama settings
- [ ] Configure MCP server (`mem0-mcp-selfhosted`) in `.claude/settings.json`
- [ ] Create `scripts/migrate-learnings.py` — parse existing markdown entries and bulk-insert into mem0
- [ ] Update `self-improve` skill SKILL.md for dual-write (markdown + mem0)
- [ ] Add memory injection to `claude-runner.py` — query mem0 for relevant context before each task
- [ ] Define agent IDs and document scoping rules in CLAUDE.md
- [ ] Test cross-agent memory sharing: write from researcher → search from main → verify retrieval
- [ ] Test graceful degradation: stop Ollama → verify markdown-only fallback works

---

## Phase 4: Heartbeat & Scheduled Tasks

### 4.1 Architecture

Use macOS `launchd` (native, reliable) + `claude -p` for scheduled background tasks.

```
[launchd plist] → runs every N minutes → [claude -p "task prompt" --allowedTools ...]
                                         ↓
                     [writes results to learnings/ or sends via Discord]
```

### 4.2 Skill: `heartbeat`

A meta-skill for creating and managing scheduled tasks:
```
/heartbeat create "Scrape trending AI repos" --interval 30m
/heartbeat list
/heartbeat pause <name>
/heartbeat delete <name>
```

Generates launchd plist files in ~/Library/LaunchAgents/ with the right claude -p invocations.

### 4.3 Shared State Between Runs
Each heartbeat task writes to a state file so the next run knows what happened:
```
~/.claude/heartbeat-state/
├── <task-name>.json    # { lastRun, result, lastError, consecutiveFailures }
```

### 4.4 Tasks
- [ ] Write heartbeat/SKILL.md with launchd plist generation logic
- [ ] Create launchd plist template
- [ ] Write state management helpers
- [ ] Test: create a heartbeat → verify plist generated → verify it runs on schedule

---

## Phase 5: Skill Discovery & Auto-Generation

### 5.1 Skill: `find-skill`

When you ask "how do I do X" or "is there a way to...", instead of just failing:
1. Search existing skills in .claude/skills/ for keyword matches
2. **Search mem0 semantically** for related learnings, past solutions, and cross-agent findings (replaces grep-based search of learnings/ files)
3. Fall back to grep-based search of learnings/ if mem0 is unavailable
4. If nothing found, suggest building a new skill and draft a SKILL.md scaffold

> **mem0 upgrade (Phase 3.5):** The find-skill search is dramatically improved by semantic memory. Asking "how do I deploy" will match learnings about "Vercel push", "git remote setup", and "CI/CD pipeline" — connections that keyword grep would miss entirely.

**SKILL.md frontmatter:**
```yaml
---
name: find-skill
description: Discovers existing skills or creates new ones when the user asks for capabilities that don't exist. Triggers on "how do I", "is there a skill", "can you", "I wish you could".
---
```

### 5.2 Tasks
- [ ] Write find-skill/SKILL.md
- [ ] Test: ask for a nonexistent capability → verify it searches existing skills → verify it offers to create one

---

## Phase 6: Emergent Behavior & Intelligence Loop

This is where it gets interesting. The system creates compounding returns:

### 6.1 The Positive Feedback Loop
```
You use Claude → mistakes happen → errors logged automatically
              → you correct it → learnings logged automatically
              → dual-write to markdown + mem0 (Phase 3.5)
              → patterns recur → learnings promoted to CLAUDE.md
              → Claude gets smarter → fewer mistakes
              → you ask for new things → feature requests logged
              → find-skill searches mem0 semantically → finds related solutions
              → or builds a new skill → new skill created
              → Claude can do more → you use it more → cycle continues
```

> **Semantic memory supercharges this loop.** Without mem0, pattern detection relies on keyword matching and manual review. With mem0, the agent discovers connections across agents, projects, and time — a correction in Mento informs behavior in Hey Lexxi without explicit rules.

### 6.2 Emergent Behaviors to Cultivate
- **Self-optimization**: Agent notices it's using inefficient approaches and creates better skills
- **Proactive suggestions**: After enough learnings, agent starts anticipating your needs
- **Cross-project knowledge**: Learnings from Mento improve Hey Lexxi work and vice versa — powered by mem0 shared memory scope (`user_id="anderson"`)
- **Cross-agent learning**: The reviewer agent benefits from the researcher's findings without explicit handoff — both read/write to shared mem0 memory
- **Skill ecosystem growth**: Each new skill compounds with existing ones
- **Model routing**: Agent learns which tasks need Opus vs Sonnet vs Haiku and auto-routes

### 6.3 Guardrails
- All promotions to CLAUDE.md require your approval (logged, not auto-applied)
- Skills auto-generated by extract-skill.sh start with `disable-model-invocation: true`
- Daily learning digest sent via Discord — review what it learned
- Maximum skill count cap to prevent bloat
- Regular pruning: archive stale learnings older than 90 days

### 6.4 Tasks
- [ ] Implement promotion approval workflow (Discord message: "Promote this learning? Y/N")
- [ ] Create daily digest skill that summarizes new learnings
- [ ] Build skill pruning/archival logic
- [ ] Document the emergent behavior patterns as they develop

---

## Build Order & Dependencies

```
Phase 1 (Foundation) ──────────────────────────────────┐
    ↓                                                   │
Phase 2 (Self-Improvement) ──── depends on Phase 1    │
    ↓                                                   │
Phase 3 (Discord Bridge) ────── depends on Phase 1    │
    ↓                                                   │
Phase 3.5 (Memory / mem0) ──── depends on Phase 2     │
    ↓                          (needs self-improve      │
    │                           for dual-write)         │
Phase 4 (Heartbeat) ──────────  depends on Phase 3    │
    ↓                                                   │
Phase 5 (Skill Discovery) ──── depends on Phase 2     │
    │                          + Phase 3.5              │
    │                          (semantic search)        │
    ↓                                                   │
Phase 6 (Emergent Loop) ────── depends on all above   │
```

**Estimated effort**: Phases 1-3 in a weekend. Phase 3.5 in an afternoon (pip install + config + migration script). Phase 4-5 in a second session. Phase 6 ongoing.

---

## Future Options (Not Currently Planned)

These can be added later once the core system is solid:

### iMessage Bridge
- Secondary communication channel using `imsg` CLI by Steipete
- Requires Full Disk Access + Automation permissions on macOS
- Architecture: `imsg watch --json` → `claude -p` → `imsg send`
- Must run as persistent Terminal process (FDA doesn't propagate to LaunchAgents)
- Reference: [imsg CLI](https://github.com/steipete/imsg)

### Project-Specific Monitors
- **monitor-lexxi**: Uptime checks on https://app.heylexxi.com, Vercel deploy status, Supabase health (15 min interval)
- **mento-tracker**: Daily dev progress reports — git log, open TODOs, test results
- Both would use the heartbeat system (Phase 4) + Discord alerts

---

## Tech Stack Summary

| Component          | Technology                                      |
|--------------------|-------------------------------------------------|
| AI Engine          | Claude Code CLI (`claude -p`, `--resume`)        |
| Skills Framework   | Claude Code Skills v2 (SKILL.md + frontmatter)  |
| Hooks              | Claude Code hooks (UserPromptSubmit, PostToolUse)|
| Discord Bridge     | discord.js + TypeScript                          |
| Semantic Memory    | mem0ai (multi-agent memory with scoping)         |
| Vector Store       | ChromaDB (embedded) → Qdrant (at scale)          |
| Embeddings         | Ollama + nomic-embed-text (local, 768-dim)       |
| Memory MCP         | mem0-mcp-selfhosted (MCP server for Claude Code) |
| Scheduling         | macOS launchd                                    |
| Process Manager    | pm2 or launchd                                   |
| Session Storage    | Local JSON files                                 |
| Learning Storage   | Structured Markdown + mem0 (dual-write)          |
| Version Control    | Git                                              |

---

## References & Inspiration

- [pskoett/self-improving-agent](https://clawhub.ai/pskoett/self-improving-agent) — Self-improvement skill architecture
- [JimLiuxinghai/find-skills](https://clawhub.ai/JimLiuxinghai/find-skills) — Skill discovery pattern
- [Claude Code Skills v2 Docs](https://code.claude.com/docs/en/skills) — Official skills documentation
- [moazbuilds/claudeclaw](https://github.com/moazbuilds/claudeclaw) — Lightweight Claude Code agent plugin
- [claude-code-discord-bridge](https://github.com/ebibibi/claude-code-discord-bridge) — Reference Discord bridge
- [claude-pipe](https://github.com/georgi/claude-pipe) — Minimal Discord+Telegram bridge
- [imsg CLI](https://github.com/steipete/imsg) — iMessage programmatic access
- Reddit thread: "Honest review about OpenClaw vs Claude Code after a month" — Community validation of DIY approach
- [mem0ai](https://github.com/mem0ai/mem0) — Multi-agent semantic memory layer
- [mem0-mcp-selfhosted](https://github.com/ryaker/mem0-mcp-selfhosted) — MCP server for mem0 integration with Claude Code
- [Ollama](https://ollama.ai) — Local model runner for embeddings (nomic-embed-text)
- [ChromaDB](https://www.trychroma.com) — Embedded vector database (SQLite-backed, no Docker)
