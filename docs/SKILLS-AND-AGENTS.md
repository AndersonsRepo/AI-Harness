# Skills & Agents

AI Harness uses two complementary systems for structured capabilities: **Skills** (reusable workflows) and **Agents** (specialized personalities). Skills define *what* can be done; agents define *how* it's done.

---

## Skills

Skills are Claude Code's mechanism for reusable, structured capabilities. Each skill lives at `.claude/skills/<name>/SKILL.md` with YAML frontmatter controlling behavior.

### Anatomy of a Skill

```yaml
---
name: vault-query
description: Search and analyze the vault knowledge base.
user-invocable: true
argument-hint: "<search|stats|promotions|by-tag> [args]"
context: fork
agent: researcher
model: sonnet
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---

# Vault Query

Instructions for the skill go here...
```

### Frontmatter Fields

| Field | Purpose | Example |
|-------|---------|---------|
| `name` | Skill identifier | `vault-query` |
| `description` | What it does (shown in listings) | "Search the vault knowledge base" |
| `user-invocable` | Can users trigger it with `/name`? | `true` / `false` |
| `argument-hint` | Usage hint shown in skill list | `"<search\|stats> [args]"` |
| `context: fork` | Run in isolated subagent (protects main conversation) | Used by read-only skills |
| `agent` | Route to a specific agent personality | `researcher`, `ops`, `reviewer` |
| `model` | Override the default model | `sonnet` for cheaper tasks |
| `allowed-tools` | Restrict which tools the skill can use | `[Read, Bash, Glob, Grep]` |
| `disable-model-invocation` | Prevent auto-triggering | Used by review-changes |

### Live Data Injection (`!command`)

Skills can inject live shell output into their instructions using `!command` syntax:

```markdown
## Live System State
!`ps aux | grep bot.ts | grep -v grep`
!`launchctl list | grep com.aiharness`
```

When the skill is invoked, the `!command` lines are replaced with their output. This gives the LLM real-time data without requiring it to run commands itself.

### All Skills

#### User-Invocable Skills

| Skill | Context | Agent | Model | Description |
|-------|---------|-------|-------|-------------|
| `/github` | fork | ops | default | GitHub PR/issue/repo management via `gh` CLI |
| `/vercel` | — | — | sonnet | Vercel deployment management (deploy/rollback need confirmation) |
| `/supabase` | fork | ops | default | Safe DB queries with SQL whitelist (no DELETEs) |
| `/academics` | fork | researcher | default | Canvas LMS + GoodNotes academic tracking |
| `/scout` | fork | researcher | sonnet | Evaluate URLs/tech against all projects |
| `/learned` | — | — | default | Explicit mid-conversation learning capture |
| `/heartbeat` | — | — | default | LaunchAgent management for scheduled tasks |
| `/health-report` | fork | ops | sonnet | System diagnostics: bot, DB, heartbeat, vault, truncation |
| `/vault-query` | fork | — | sonnet | Vault search: stats, promotions, by-tag, free-form |
| `/digest` | fork | — | sonnet | Summarize learnings for a date range |
| `/review-changes` | fork | reviewer | default | Code review for uncommitted changes |
| `/find-skill` | fork | researcher | default | Discover existing skills or scaffold new ones |
| `/test-harness` | — | — | default | Test checklist after code changes |

#### Auto-Triggered Skills (Not User-Invocable)

| Skill | Trigger | Description |
|-------|---------|-------------|
| `self-improve` | Hooks (activator.sh, error-detector.sh) | Logs learnings, errors, corrections to vault |
| `doc-on-success` | After confirmed changes | Updates project documentation |

### Creating New Skills

```bash
# Scaffold a new skill with v2 frontmatter template
./scripts/extract-skill.sh my-new-skill
```

Or use `/find-skill create <name>` to have Claude scaffold it interactively.

---

## Agents

Agents are specialized personalities defined in `.claude/agents/<name>.md`. They provide focused expertise and behavioral guidelines for different types of work.

### How Agents Are Used

1. **Channel assignment**: Set a channel's default agent with `/config agent builder`
2. **Skill routing**: Skills specify `agent: researcher` to route to that personality
3. **Handoff chains**: Agents pass work to each other via `[HANDOFF:agent_name]`
4. **Project channels**: Each project can assign different agents to different channels

### Agent Profiles

#### Builder
**Focus**: Implementation. Writing production-ready code that follows existing patterns.
- Reads existing code before modifying
- Follows established conventions in the repo
- Prefers editing existing files over creating new ones
- Writes tests alongside features

#### Researcher
**Focus**: Investigation. Deep exploration without making changes.
- Read-only by default (`context: fork` skills use this)
- Thorough: checks multiple files, traces call chains
- Reports findings with file paths and line numbers
- Used by: `/find-skill`, `/academics`, `/scout`

#### Reviewer
**Focus**: Code quality. Security, performance, and correctness analysis.
- Reviews diffs, not just new code
- Checks for OWASP top 10 vulnerabilities
- Evaluates error handling and edge cases
- Used by: `/review-changes`

#### Ops
**Focus**: Infrastructure. Deployment, database, monitoring.
- Careful with destructive operations
- Checks system state before making changes
- Prefers reversible actions
- Used by: `/github`, `/supabase`, `/health-report`

#### Commands
**Focus**: User assistance. Helping navigate the bot's capabilities.
- Knows all available commands and skills
- Provides usage examples
- Suggests relevant skills for user's needs

#### Project-Specific Agents
**Hey-Lexxi**, **Mento**, **LightRAG**, **Lattice** — each has deep context about their respective projects: tech stack, file structure, deployment process, common issues.

### Inter-Agent Handoffs

Agents can delegate work to each other:

```
[HANDOFF:builder] Please implement the database migration we discussed
```

**Handoff rules:**
- Maximum chain depth: 5 (configurable per project)
- Self-handoffs are blocked
- Unknown agent names are rejected
- Each agent in the chain gets its own session (compound key: `channelId:agentName`)
- Context from the last 15 messages is passed to the target agent

**Handoff flow:**
```
researcher analyzes problem
  -> [HANDOFF:builder] implement the fix
    -> builder writes code
      -> [HANDOFF:reviewer] review my changes
        -> reviewer approves or requests changes
```

### Channel Creation

Agents can create new project channels:

```
[CREATE_CHANNEL:api-refactor --agent builder "Refactoring the API layer"]
```

This creates a new Discord channel with the specified agent assigned.

---

## Extending the System

### Adding a New Skill

1. Create `.claude/skills/<name>/SKILL.md` with YAML frontmatter
2. Write instructions in the body (markdown)
3. Add `!command` lines for live data injection if needed
4. Add supporting scripts in the skill directory if needed
5. Update CLAUDE.md's skill table

### Adding a New Agent

1. Create `.claude/agents/<name>.md` with the personality description
2. Add the agent name to the list of available agents
3. Optionally create project-specific context in `vault/shared/project-knowledge/<name>.md`

### Adding a New Heartbeat Task

1. Create `heartbeat-tasks/<name>.json` with task config
2. Create `heartbeat-tasks/scripts/<name>.py` with task implementation
3. Use `/heartbeat create` or manually create a LaunchAgent plist
4. Load with `launchctl load ~/Library/LaunchAgents/com.aiharness.heartbeat.<name>.plist`
