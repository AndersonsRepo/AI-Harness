# Plan: Context Injection Daemon

## What This Is

A deterministic layer that assembles and injects relevant context into every Claude invocation — before the LLM sees the prompt. The LLM never has to decide what to look up. It always receives a curated context window.

## Why It Matters

Today, Claude decides whether to check the vault, which project this relates to, and what past mistakes are relevant. Sometimes it does, sometimes it doesn't. This is non-deterministic. A context daemon makes it deterministic — every call gets the right context, every time.

## Where It Hooks In

The entire system funnels through one bottleneck: **`spawnTask()` in `task-runner.ts` (line 208)**. This is where Claude CLI args are assembled. Every regular message, every handoff, every subagent goes through here or a near-identical pattern in `handoff-router.ts` and `subagent-manager.ts`.

The injection point is **before the `--append-system-prompt` args are finalized** — currently line 223 in task-runner.ts. Today it loads the agent .md file. The daemon adds a second `--append-system-prompt` block with assembled context.

```
Current flow:
  user message → submitTask() → spawnTask() → [agent .md loaded] → claude-runner.py → Claude

New flow:
  user message → submitTask() → spawnTask() → [agent .md loaded]
                                              → [context-assembler queries & builds]
                                              → claude-runner.py → Claude
```

## Architecture

### Single new module: `bridges/discord/context-assembler.ts`

One function, one job:

```typescript
async function assembleContext(params: {
  channelId: string;
  prompt: string;
  agentName: string;
  sessionKey: string;
  taskId: string;
}): Promise<string>
```

Returns a formatted context block that gets injected via `--append-system-prompt`.

It does NOT touch claude-runner.py. It does NOT change the spawn mechanism. It only builds a string that gets appended to the existing args array.

---

## What Gets Injected

The context block has fixed sections. Each section is populated by a deterministic query — no LLM involved.

```
[CONTEXT — assembled by daemon]

## Active Project
Name: Hey Lexxi
Description: Production app at app.client-project.com
Agents: ops, builder, reviewer
Current agent: ops

## Channel State
Last 3 tasks: success, success, failed ("timeout after 300s")
Handoff depth: 0/5
Session: active (resumed)

## Relevant Knowledge
- [LRN-20260309-001] Claude CLI hangs when spawned from Node.js — use python wrapper
- [ERR-20260311-001] --allowedTools is variadic — always use -- separator before prompt
- [convention] Always update documentation alongside code changes

## Recent Activity
- Deploy monitor: Hey Lexxi READY (2h ago)
- Vault backup: 3 new learnings committed (6h ago)
- Last human message in this channel: 45min ago

## Pending Work
- 2 notifications queued for #calendar
- 1 dead-letter task (id: 7, channel: #general, error: "timeout")
```

---

## Implementation Steps

### Step 1: Context Assembler Module

**File**: `bridges/discord/context-assembler.ts`

**Data sources** (all deterministic queries):

| Section | Source | Query |
|---------|--------|-------|
| Active Project | `projects` SQLite table | `getProject(channelId)` — already exists |
| Channel Config | `channel_configs` SQLite table | `getChannelConfig(channelId)` — already exists |
| Task History | `task_queue` SQLite table | Last 5 tasks for this channel: status, error, timestamps |
| Dead Letters | `dead_letter` SQLite table | Any dead letters for this channel |
| Relevant Learnings | `vault/learnings/*.md` files | Keyword match: extract tags/pattern-keys from prompt, match against YAML frontmatter |
| Shared Knowledge | `vault/shared/project-knowledge/{project}.md` | Load if project is known |
| Conventions | `vault/shared/conventions.md` | Always load (small file) |
| Tool Gotchas | `vault/shared/tool-gotchas.md` | Always load (small file) |
| Recent Heartbeats | `heartbeat-tasks/*.state.json` | Latest status of relevant tasks |
| Pending Notifications | `pending-notifications.jsonl` | Count + summary |

**Keyword extraction** (deterministic, no LLM):
```typescript
function extractKeywords(prompt: string): string[] {
  // 1. Split on whitespace, lowercase
  // 2. Remove stopwords
  // 3. Match against known tags from vault learnings
  // 4. Match against known project names
  // 5. Match against known error patterns (from tool-gotchas.md)
  return matchedKeywords;
}
```

**Vault search** (keyword-based now, vector-based later):
```typescript
function searchVault(keywords: string[], limit: number = 5): VaultEntry[] {
  // 1. List vault/learnings/*.md
  // 2. Parse YAML frontmatter (tags, pattern-key, type, status)
  // 3. Score by keyword overlap with tags + pattern-key
  // 4. Return top-k entries with summary
}
```

**Token budget**: The assembled context should target ~1000-2000 tokens. Each section has a max length. If total exceeds budget, lower-priority sections are trimmed.

Priority order (highest first):
1. Active project + channel config (always include)
2. Relevant learnings (up to 5)
3. Shared knowledge for this project
4. Task history (last 3)
5. Conventions + tool gotchas
6. Recent heartbeats
7. Pending work

### Step 2: Hook Into task-runner.ts

**File**: `bridges/discord/task-runner.ts`

In `spawnTask()`, after the agent .md is loaded (line 232) and before the spawn (line 273):

```typescript
// Existing: agent personality injection
const agentPrompt = readFileSync(agentPath, "utf-8");
args.push("--append-system-prompt", agentPrompt);

// NEW: context injection
const context = await assembleContext({
  channelId: task.channel_id,
  prompt: task.prompt,
  agentName,
  sessionKey,
  taskId,
});
if (context) {
  args.push("--append-system-prompt", context);
}
```

That's it. One function call, one arg push. The rest of `spawnTask()` is unchanged.

### Step 3: Hook Into handoff-router.ts

Same pattern. In `executeHandoff()`, after the agent prompt is loaded (line 230) and before spawn:

```typescript
const context = await assembleContext({
  channelId: channel.id,
  prompt: handoffMessage,
  agentName: toAgent,
  sessionKey: `${channel.id}:${toAgent}`,
  taskId: "handoff",
});
if (context) {
  args.push("--append-system-prompt", context);
}
```

### Step 4: Hook Into subagent-manager.ts

Same pattern for background subagents.

### Step 5: Logging & Observability

Add a `context-log/` directory that saves each assembled context block with timestamp and task ID. This lets you:
- Debug what context Claude actually received
- Measure relevance (did the injected learnings help?)
- Tune keyword extraction and priority ordering

```typescript
function logContext(taskId: string, context: string): void {
  const logDir = join(HARNESS_ROOT, "context-log");
  mkdirSync(logDir, { recursive: true });
  const file = join(logDir, `${new Date().toISOString().slice(0,10)}.jsonl`);
  appendFileSync(file, JSON.stringify({ taskId, timestamp: Date.now(), context }) + "\n");
}
```

Add `context-log/` to `.gitignore`.

---

## What This Does NOT Do

- Does NOT change `claude-runner.py` — spawn mechanism stays the same
- Does NOT add a new process/container — it's a module imported by task-runner
- Does NOT require vector embeddings yet — keyword search is the starting point
- Does NOT replace agent .md files — it supplements them
- Does NOT change the Discord bot interface — users notice nothing
- Does NOT require new npm packages — uses existing `better-sqlite3` + `fs`

## What Changes for Claude

Claude goes from:
> "I'm an ops agent. Here's a user message. I should probably check the vault... let me search... hmm, what's relevant..."

To:
> "I'm an ops agent. The daemon tells me this is the Hey Lexxi project, there are 2 relevant past learnings about CLI spawning, the last deploy succeeded 2h ago, and there's a dead-letter task I should mention. Here's the user message."

The LLM's job gets simpler and more focused. It spends tokens on the actual task instead of on figuring out what it should know.

---

## Future Upgrades (Not in This Plan)

These build on the daemon but are separate work:

1. **Vector search** — Replace keyword matching with embeddings (sqlite-vss or pgvector). Same `searchVault()` interface, better results.
2. **Conversation state machine** — Track `idle/planning/implementing/reviewing/debugging` per channel. Include state in context block so Claude knows the phase.
3. **Feedback loop** — When Claude uses an injected learning in its response, bump that learning's recurrence count. Automatic promotion signal.
4. **MCP server** — Extract context-assembler into an MCP server so any agent (not just Discord bot) can query it.

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `bridges/discord/context-assembler.ts` | **New** — the entire daemon module |
| `bridges/discord/task-runner.ts` | **Modify** — add assembleContext() call in spawnTask() |
| `bridges/discord/handoff-router.ts` | **Modify** — add assembleContext() call in executeHandoff() |
| `bridges/discord/subagent-manager.ts` | **Modify** — add assembleContext() call in spawn |
| `.gitignore` | **Modify** — add context-log/ |
| `CLAUDE.md` | **Modify** — document the context injection system |

## Testing Strategy

1. **Unit**: Call `assembleContext()` with mock params, verify output format
2. **Integration**: Send a message in a known project channel, check context-log to see what was injected
3. **Comparison**: Same prompt with and without daemon — compare response quality
4. **Regression**: Existing bot commands and skills should work identically (daemon only adds, never removes)

## Estimated Scope

- `context-assembler.ts`: ~200-300 lines
- Modifications to 3 existing files: ~15 lines each
- Total new code: ~350 lines
- No new dependencies
- No infrastructure changes
