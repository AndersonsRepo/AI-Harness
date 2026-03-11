# AI Harness v2 — Deterministic Agentic Architecture

## Motivation

The current AI Harness works but relies too heavily on Claude to make decisions that should be deterministic: what context to load, where to route messages, when to check memory, and what safety rules to enforce. This plan restructures the system around a core principle: **deterministic infrastructure supporting non-deterministic AI**.

Inspired by a microservices-based agentic architecture (Dockerized, LLM-agnostic, push-based context injection, pgvector for semantic memory, MCP-first tooling).

---

## Phase 1: Deterministic Context Injection (The Daemon Layer)

**Problem**: Claude decides whether to read vault files, check learnings, or load project context. It might not.

**Solution**: `claude-runner.py` becomes a proper context daemon that assembles and injects context *before* Claude sees the prompt.

### 1.1 Context Assembler

Add a `context-assembler.py` module that:
- Receives the raw user prompt + channel metadata
- Queries SQLite for: active project, agent config, recent learnings, conversation phase
- Queries vault for: relevant learnings (keyword match → future: vector search)
- Builds a structured context block injected via `--append-system-prompt`
- The LLM never has to "remember" to check — it's always there

### 1.2 State Machine for Conversations

Replace implicit state (Claude guessing where we are) with explicit state tracking:
- States: `idle`, `planning`, `implementing`, `reviewing`, `debugging`, `waiting_input`
- Transitions triggered by deterministic signals (command parsed, tool output, user message pattern)
- Each state has a defined context template (what gets injected)
- Stored in SQLite per channel/session

### 1.3 Deterministic Routing

Replace `[HANDOFF:agent_name]` (LLM emits a string, bot parses it) with:
- Code-based intent classifier (regex/keyword first, LLM fallback only for ambiguous cases)
- Routing table: intent → agent, defined in config, not in prompts
- Agent selection is a code decision, not an LLM decision

**Deliverables**:
- `bridges/discord/context-assembler.ts` — context building module
- `bridges/discord/state-machine.ts` — conversation state tracking
- Updated `claude-runner.py` — injects assembled context
- Updated `handoff-router.ts` — deterministic routing with LLM fallback

---

## Phase 2: Semantic Memory (pgvector)

**Problem**: Vault search is keyword-based (grep). Claude has to decide what to search for and might miss relevant learnings.

**Solution**: Vector embeddings over vault entries, queried deterministically by the context assembler.

### 2.1 Embedding Pipeline

- On vault file create/update: generate embedding via local model (Ollama + nomic-embed-text) or cheap API (Voyage, OpenAI text-embedding-3-small)
- Store in SQLite with `sqlite-vss` extension (no separate Postgres needed) or upgrade to pgvector if scaling
- Embedding table: `(file_path, chunk_text, embedding, updated_at)`

### 2.2 Retrieval Integration

- Context assembler queries top-k relevant vault entries for every prompt
- No LLM involvement in retrieval — pure vector similarity
- Results injected into system prompt under "Relevant Knowledge:" section

### 2.3 Hybrid Search

- Vector search for semantic relevance
- Keyword search for exact matches (error codes, function names)
- Merge and deduplicate results

**Deliverables**:
- `bridges/discord/embeddings.ts` — embedding generation + storage
- Updated `context-assembler.ts` — vector retrieval integration
- Embedding update hook on vault file writes

---

## Phase 3: MCP-First Tool Architecture

**Problem**: Tools are scattered across skills (SKILL.md), heartbeat scripts (Python), and bot commands (TypeScript). Each new capability is built differently. Violates DRY.

**Solution**: Build reusable capabilities as MCP servers. Register once, available to every agent everywhere.

### 3.1 Custom MCP Servers to Build

| MCP Server | Purpose | Replaces |
|-----------|---------|----------|
| `mcp-vault` | Read/write/search vault entries | Vault grep in skills, manual file reads |
| `mcp-heartbeat` | List/run/pause/resume heartbeat tasks | `/heartbeat` skill + heartbeat-runner.py CLI |
| `mcp-projects` | CRUD projects, list channels, get status | `/project` bot commands |
| `mcp-notifications` | Send to Discord channels, manage queue | pending-notifications.jsonl + drain logic |

### 3.2 MCP Server Template

Create a reusable scaffold:
```
mcp-servers/
├── template/           # Cookiecutter/scaffold for new servers
├── mcp-vault/          # Vault operations
├── mcp-heartbeat/      # Heartbeat management
├── mcp-projects/       # Project CRUD
└── mcp-notifications/  # Discord notifications
```

Each server:
- TypeScript (or Python), standalone, `npx`-able
- Registered in `~/.claude/Config/mcp-config.json`
- Available to Claude Code, the Discord bot, heartbeat tasks, and any future agent

### 3.3 MCP Registry

Central config listing all available MCP servers with:
- Name, description, capabilities
- Health check endpoint
- Version tracking

**Deliverables**:
- `mcp-servers/` directory with 4 custom MCP servers
- Updated `mcp-config.json` with new servers
- Skills simplified to use MCP tools instead of reimplementing logic

---

## Phase 4: LLM-Agnostic Routing (Cost Optimization)

**Problem**: Everything runs through Claude Opus/Sonnet. Simple tasks (classification, extraction, yes/no decisions) burn expensive tokens.

**Solution**: Route tasks to the cheapest capable model.

### 4.1 Model Router

- Task classification (deterministic): `simple` → local/cheap, `complex` → Claude
- Simple tasks: intent classification, entity extraction, yes/no validation, summarization
- Complex tasks: code generation, multi-step reasoning, creative work
- Local models via Ollama: Llama 3, Mistral, Phi-3 for lightweight tasks

### 4.2 Integration Points

- Heartbeat tasks that just parse/compare data → local model or pure code (no LLM)
- Vault search ranking → embeddings (no LLM)
- Intent classification in routing → local model
- Code review, feature implementation, research → Claude

### 4.3 Ollama Setup

- Install Ollama, pull `llama3:8b` and `nomic-embed-text`
- `model-router.ts` — routes based on task type
- Fallback to Claude if local model fails or confidence is low

**Deliverables**:
- `bridges/discord/model-router.ts`
- Ollama integration for cheap tasks
- Updated heartbeat scripts to skip LLM when pure code suffices

---

## Phase 5: Containerization (Optional, Future)

**Problem**: Everything runs as bare processes on macOS. Not portable, not independently restartable.

**Solution**: Docker Compose for service isolation.

### 5.1 Service Decomposition

```yaml
services:
  bot:          # Discord bot (TypeScript)
  daemon:       # Context assembler + state machine
  heartbeat:    # Cron-like task runner
  db:           # SQLite or Postgres+pgvector
  ollama:       # Local LLM inference
  mcp-vault:    # Vault MCP server
  mcp-notify:   # Notification MCP server
```

### 5.2 Benefits

- Click-deploy to cloud (Railway, Fly.io, home server)
- Independent restarts (bot crash doesn't kill heartbeat)
- Resource limits per service
- Reproducible environment (no "works on my machine")

### 5.3 Migration Path

- Start with Docker Compose locally
- Each service gets a Dockerfile
- Shared network for inter-service communication
- Volumes for persistent data (vault, db)

**Deliverables**:
- `docker-compose.yml`
- Dockerfiles per service
- Updated documentation

---

## Implementation Order

```
Phase 1 (Context Injection)     ← highest impact, fixes the core reliability issue
  ↓
Phase 3 (MCP Servers)           ← establishes the right tool architecture going forward
  ↓
Phase 2 (Semantic Memory)       ← enhances context quality
  ↓
Phase 4 (LLM-Agnostic Routing)  ← cost optimization
  ↓
Phase 5 (Containerization)      ← operational maturity (optional)
```

Phase 1 is the critical shift — it moves the system from "LLM decides everything" to "infrastructure decides, LLM executes." Everything else builds on that foundation.

---

## What Stays the Same

- Discord as primary interface
- Obsidian vault as knowledge store (source of truth)
- Skills v2 for user-invocable capabilities
- Hooks for passive learning capture
- LaunchAgent for scheduling (until Phase 5)

## What Changes

- Claude goes from **orchestrator** to **executor**
- Context injection goes from **pull** (LLM reads files) to **push** (daemon injects)
- Tools go from **scattered** (skills + scripts + commands) to **MCP-first**
- Memory goes from **keyword grep** to **semantic vector search**
- Routing goes from **LLM string parsing** to **deterministic code + LLM fallback**
