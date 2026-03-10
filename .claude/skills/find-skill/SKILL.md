---
name: find-skill
description: Discovers existing skills or creates new ones when the user asks for capabilities that don't exist. Triggers on "how do I", "is there a skill", "can you", "I wish you could", "is there a way to".
user-invocable: true
---

# Skill Discovery & Auto-Generation

When the user asks for a capability, search for it before saying "I can't". If nothing exists, offer to build it.

## Usage

- `/find-skill <query>` — Search for a skill or vault knowledge matching the query
- Also triggers automatically on phrases like "how do I...", "is there a way to...", "can you...", "I wish you could..."

## Search Strategy

Execute these steps in order. Stop as soon as a strong match is found.

### Step 1: Search Existing Skills

Search `.claude/skills/` for matching SKILL.md files:

1. Use `Glob` to list all `.claude/skills/*/SKILL.md` files
2. Read each SKILL.md and check if:
   - The `name` or `description` in frontmatter matches the query keywords
   - The body content addresses the user's need
3. If a match is found, tell the user:
   > "There's already a skill for that: **<name>** — <description>"
   > Then explain how to use it.

### Step 2: Search Vault Learnings

Search `vault/learnings/` for related knowledge:

1. Use `Grep` to search `vault/learnings/*.md` for the query keywords
2. Also search by likely tags: extract keywords from the query and search for them in frontmatter `tags:` lines
3. If matches are found, summarize the relevant learnings:
   > "I don't have a dedicated skill for that, but I found related knowledge in the vault:"
   > - List matching entries with their titles and key insights
   > - If a learning has `status: resolved` and a working fix, present the solution

### Step 3: Search Vault Shared Knowledge

Search `vault/shared/` for conventions, tool gotchas, or project knowledge:

1. Use `Grep` to search `vault/shared/**/*.md` for query keywords
2. Present any matching conventions or known gotchas

### Step 4: Search Heartbeat Tasks

Check if there's an existing heartbeat task that addresses the need:

1. Use `Glob` to list `heartbeat-tasks/*.json` files
2. Read configs and check if any task's `prompt` or `name` relates to the query

### Step 5: Offer to Build a New Skill

If no matches found in any of the above:

1. Tell the user:
   > "I don't have a skill for that yet. Want me to create one?"

2. If the user agrees, scaffold a new SKILL.md:

```markdown
---
name: <kebab-case-name>
description: <one-line description of what the skill does>
user-invocable: true
---

# <Skill Name>

## What it does
<Description of the capability>

## Steps
1. <Step-by-step instructions for the skill>

## Example usage
`/skill-name <args>`
```

3. Write the file to `.claude/skills/<name>/SKILL.md`
4. Also log a FEAT entry in `vault/learnings/` using the self-improve format:
   - `type: feature`
   - `status: built`
   - Link to the new skill in the body

### Step 6: Log Feature Request (if user declines)

If the user doesn't want a skill built right now:

1. Log a FEAT entry in `vault/learnings/` with:
   - `status: requested`
   - The user's original query as the "Requested capability"
   - `tags` extracted from the query for future searchability

This ensures the request is discoverable if someone asks for something similar later.

## Search Tips

- When extracting keywords from the user's query, strip common words ("how", "do", "I", "the", "is", "there", "a", "way", "to", "can", "you")
- Search for both the exact phrase and individual keywords
- Consider synonyms: "schedule" ↔ "heartbeat" ↔ "cron", "memory" ↔ "vault" ↔ "learnings", "deploy" ↔ "push" ↔ "release"
- Frontmatter `tags` and `pattern-key` are the most reliable search targets in vault files
