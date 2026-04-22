# AI Harness Memory System

## Purpose
AI Harness does not rely on chat memory alone. It builds deterministic long-term memory around Claude using vault files, embeddings, SQLite telemetry, and pre-invocation context assembly.

## Main Components
- `vault/learnings/*.md` — canonical LRN/ERR/FEAT entries with YAML frontmatter
- `vault/shared/` — cross-project knowledge, conventions, scouted reports, course notes
- `vault/vault-embeddings.json` — local embedding index for vault content
- `bridges/discord/context-assembler.ts` — deterministic context injection before each spawn
- `bridges/discord/embeddings.ts` — embedding generation, hybrid search, temporal decay
- `bridges/discord/promotion-handler.ts` — promotion of recurring learnings into `CLAUDE.md`
- `heartbeat-tasks/scripts/session-debrief.py` — transcript-to-learning extraction

## Ingestion Paths
- Claude hooks in `.claude/settings.json`
  - `UserPromptSubmit` runs the self-improve activator
  - `PostToolUse` for `Bash` captures meaningful command failures
  - `Stop` flushes session context
- Explicit capture via `.claude/skills/learned/SKILL.md`
- MCP writes through `mcp-servers/mcp-vault/index.ts`
- Scheduled transcript extraction via `session-debrief.py`

## Dedup and Promotion
- Primary dedup key is `pattern-key`
- Repeated matches increment `recurrence-count` and update `last-seen`
- At `recurrence-count >= 3`, entries become promotion candidates
- Approved candidates are appended to `CLAUDE.md`, making them always-present instead of only retrievable

## Retrieval Model
- Hybrid retrieval combines semantic similarity with keyword matching
- Temporal decay favors recent learnings; shared knowledge is treated as evergreen
- `context-assembler.ts` injects relevant learnings, project knowledge, `LIVE_STATE.md`, conventions, gotchas, and task state into the next Claude invocation
- Wikilinks in `LIVE_STATE.md` are resolved selectively when prompt keywords overlap

## Maintenance Jobs
- `learning-pruner.py` archives stale or low-value entries
- `learning-compressor.py` adds `compressed:` summaries to older verbose learnings
- `graph-linker.py` builds `learning_edges` relationships across entries
- vault retrieval hits are stored in SQLite and used for pruning decisions

## Practical Rule for Codex
When work depends on historical repo knowledge, check the memory system before assuming context is only in code. The authoritative sources are `vault/`, `.claude/` hooks and skills, and the retrieval pipeline in `bridges/discord/`.
