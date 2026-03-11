# Self-Improvement System

The self-improvement loop is the core differentiator of AI Harness. It's a closed feedback system where every interaction teaches the agent something, and recurring lessons become permanent knowledge.

---

## The Loop

```
                    +-----------------------+
                    |   User Interaction    |
                    +-----------+-----------+
                                |
                    +-----------v-----------+
                    |   Hook Detection      |
                    |  activator.sh (9 patterns)
                    |  error-detector.sh    |
                    +-----------+-----------+
                                |
                    +-----------v-----------+
                    |   Deduplication       |
                    |  dedup-learning.sh    |
                    |  pattern-key match    |
                    |  tag overlap (>= 2)   |
                    +-----------+-----------+
                           /         \
                     new entry    duplicate found
                         |              |
                  create file    increment recurrence
                  in vault/      update last-seen
                  learnings/     status: recurring
                         |              |
                    +----v--------------v----+
                    |   Auto-Embedding       |
                    |  fs.watch detects file  |
                    |  Ollama generates 768d  |
                    |  vector, stores in JSON |
                    +----------+-------------+
                               |
                    +----------v-------------+
                    |  Context Injection      |
                    |  (next invocation)      |
                    |  hybrid search: 70%     |
                    |  semantic + 30% keyword |
                    |  ~5000 tokens injected  |
                    +----------+-------------+
                               |
                    +----------v-------------+
                    |  Promotion Check        |
                    |  recurrence >= 3?       |
                    |  -> candidate list      |
                    |  -> Discord notification |
                    |  -> user approves       |
                    |  -> appended to CLAUDE.md
                    +--------------------------+
```

---

## Stage 1: Capture

Two hooks fire on every interaction, configured in `.claude/settings.json`:

### `activator.sh` (UserPromptSubmit)

Fires when you send any message. Pattern-matches against 9 categories:

| Priority | Category | Example Trigger |
|----------|----------|-----------------|
| 1 | **Correction** | "No, that's wrong", "actually...", "you forgot" |
| 2 | **Preference** | "Always use...", "never do...", "from now on" |
| 3 | **Architecture decision** | "Let's use...", "put it in...", "instead of" |
| 4 | **External knowledge** | "The repo is...", "the API is at...", "it runs on" |
| 5 | **Feature request** | "Can you also...", "I wish you could...", "we should add" |
| 6 | **Bug report** | "Is broken", "doesn't work", "why won't it" |
| 7 | **Root cause** | "The problem was...", "it turns out...", "the fix is" |
| 8 | **TIL / discovery** | "I didn't know...", "TIL", "turns out" |
| 9 | **Workflow gotcha** | "The trick is...", "watch out for...", "don't forget to" |

Each match creates a vault entry with appropriate type (`LRN`, `ERR`, `FEAT`), category, and tags.

### `error-detector.sh` (PostToolUse[Bash])

Fires after every Bash command. Captures meaningful errors while filtering noise:

**Filtered out (silent exit):**
- Exit code 0 (unless contains FATAL/traceback/panic/segfault)
- Empty stderr
- Known noise: "No such file", "nothing to commit", "Already up to date"
- Deprecation warnings on exit code 0
- "command not found" for optional tools (bun, pnpm, yarn)
- Error messages shorter than 10 characters

**Captured:**
- Non-zero exit with meaningful stderr
- Successful exits containing severe error patterns

Each captured error is hashed (first 100 chars) for deduplication. If the hash was seen before, the existing entry is referenced instead of creating a new one.

### MCP `vault_write` Tool

Claude can also explicitly write learnings via the MCP vault server. The `/learned` skill triggers this for mid-conversation knowledge capture. Same dedup logic applies — if a matching `pattern-key` already exists, recurrence is incremented.

---

## Stage 2: Deduplication

The `dedup-learning.sh` script (sourced by both hooks and the MCP server) prevents duplicate entries using two strategies:

### Strategy 1: Pattern-Key Match (Precise)

Every vault entry has a `pattern-key` field (e.g., `sqlite-wal-mode-required`, `node-to-node-spawn-hang`). Before creating a new entry, the script scans all existing entries for an exact `pattern-key` match.

If found: increment `recurrence-count`, update `last-seen`, change status from `new` to `recurring`.

### Strategy 2: Category + Tag Overlap (Fuzzy)

For entries with generic pattern-keys (e.g., `auto-captured-error`), the script checks for category match + at least 2 overlapping tags.

Example: A new `correction` entry with tags `[auto-captured, correction]` matches an existing entry with `category: correction` and `tags: [auto-captured, correction, permanent]` because 2 tags overlap.

### Recurrence-Count Lifecycle

```
count: 1  →  status: new        (just captured)
count: 2  →  status: recurring  (seen again)
count: 3+ →  promotion candidate (ready for CLAUDE.md)
```

---

## Stage 3: Embedding & Indexing

When a new vault file is created or modified:

1. **`fs.watch`** in `watchVaultForEmbeddings()` detects the change (3-second debounce to avoid duplicate events)
2. **`embedFile()`** reads the file, strips YAML frontmatter, truncates to 6000 chars
3. **Ollama** generates a 768-dimensional embedding via `nomic-embed-text`
4. The normalized vector + 200-char preview is stored in `vault/vault-embeddings.json`

Full re-sync happens on bot startup via `syncEmbeddings()`. Cache invalidation uses a simple content hash — unchanged files keep their existing embeddings.

### Indexed Directories

| Directory | Contents |
|-----------|----------|
| `vault/learnings/` | Individual LRN/ERR/FEAT entries |
| `vault/shared/` | Cross-agent knowledge |
| `vault/shared/project-knowledge/` | Per-project context |
| `vault/shared/scouted/` | Tech evaluation reports |
| `vault/agents/` | Per-agent working memory |
| `vault/daily/` | Daily activity notes |

---

## Stage 4: Context Injection

The **context assembler** (`context-assembler.ts`) is a deterministic daemon that runs before every Claude invocation. It does not use the LLM — it's pure infrastructure.

### How It Works

1. Extract keywords from the user's prompt (stopword-filtered)
2. Run **hybrid search**: 70% cosine similarity on embeddings + 30% keyword match on file content
3. Filter results to score > 0.3
4. Load full file content for high-relevance results (up to 1200 chars each)
5. Assemble all sections within a ~5000 token budget
6. Inject via `--append-system-prompt` before Claude sees the prompt

### Section Priority & Budget

| Priority | Section | Max Chars | What's Included |
|----------|---------|-----------|-----------------|
| 1 | Active project | 600 | Project name, agents, handoff depth |
| 2 | Relevant learnings | 8000 | Top 5 hybrid search results with full content |
| 3 | Project knowledge | 3000 | Per-project context files |
| 4 | Task history | 1200 | Last 5 tasks (status, errors, agent) |
| 5 | Conventions | 2000 | Coding standards, patterns |
| 6 | Tool gotchas | 2000 | Known pitfalls |
| 7 | Heartbeat status | 800 | Background task health |
| 8 | Pending work | 600 | Notifications, dead letters |

### Truncation Awareness

When learnings are truncated >30%, the LLM sees:

```
> Warning: 2 learning(s) were significantly truncated (>30% content lost).
> Use vault_read to fetch full content for any entry you need details from.
```

This lets the LLM self-correct by calling `vault_read` via MCP.

### Injection Points

Context is injected at all three spawn points:
- `task-runner.ts` → `spawnTask()`
- `handoff-router.ts` → `executeHandoff()`
- `subagent-manager.ts` → `spawnSubagent()`

---

## Stage 5: Promotion

When `recurrence-count` reaches 3+, the learning becomes a **promotion candidate**.

### Automated Discovery

The `promotion-check` heartbeat (runs every 24 hours) calls `getPromotionCandidates()` which scans all vault entries for:
- `recurrence-count >= 3`
- `status` is not `promoted` or `archived`

Matching entries are posted to Discord for human review.

### Human Approval

The user responds with `approve <id>` or `reject <id>`.

### On Approval (`approveLearning()`)

1. Extract the key insight from the "What was learned" section
2. Format as: `- **[area]**: insight (promoted YYYY-MM-DD, from LRN-XXXXXXXX-XXX)`
3. Append to the `## Promoted Learnings` section of `CLAUDE.md`
4. Set vault entry status to `promoted`

### Why This Matters

`CLAUDE.md` is loaded into **every** Claude invocation globally — not retrieved by search, but always present in the system prompt. A promoted learning goes from "sometimes surfaced when relevant" to "always known." This is the mechanism by which the system permanently rewrites its own behavior.

---

## Vault Entry Format

Every learning follows this structure:

```yaml
---
id: LRN-20260311-001
logged: 2026-03-11T14:30:00Z
type: learning
priority: medium
status: recurring
category: best_practice
area: infra
agent: main
project: ai-harness
pattern-key: sqlite-wal-mode-required
recurrence-count: 3
first-seen: 2026-03-09
last-seen: 2026-03-11
tags: [sqlite, database, performance]
related: [ERR-20260309-002]
---

# SQLite requires WAL mode for concurrent reads

## What happened
Bot crashed when two heartbeat tasks tried to read the database simultaneously.

## What was learned
SQLite in default journal mode locks the entire database on writes.
WAL (Write-Ahead Logging) mode allows concurrent readers with a single writer.
Always initialize with `PRAGMA journal_mode=WAL`.

## Why it matters
Every component reads the database — sessions, configs, tasks, projects.
Without WAL, any write blocks all reads, causing timeouts under load.
```

---

## Observability

### Truncation Monitor

All truncation across the system is tracked:
- `context-log/truncation-events.jsonl` — every truncation event with source, severity, % lost
- `context-log/truncation-stats.json` — rolling statistics per source
- Critical events (>60% lost) emit stderr warnings
- `/health-report` includes truncation analysis

### Context Log

Every assembled context block is logged:
- `context-log/YYYY-MM-DD.jsonl` — task ID, channel, agent, section count, char count
- Enables post-hoc analysis of what knowledge was available for each invocation
