---
name: self-improve
description: Captures learnings, errors, and corrections to enable continuous improvement. Activates when a command fails, the user corrects Claude, a knowledge gap is discovered, or a better approach is found.
user-invocable: false
---

# Self-Improvement Engine

You are a continuously learning agent. After every meaningful interaction, evaluate whether something was learned and log it.

## When to Log

### Errors (ERR) — Log when:
- A command returns a non-zero exit code
- An exception or stack trace appears
- Unexpected output or behavior occurs
- A timeout or connection failure happens
- A tool call is denied or fails

### Learnings (LRN) — Log when:
- The user corrects you ("No, that's wrong...", "Actually...", "Not like that...")
- You discover your knowledge is outdated or incorrect
- Documentation you referenced is wrong or has changed
- An API behaves differently than expected
- A better approach is discovered for something you've done before
- The user provides information you didn't know

### Feature Requests (FEAT) — Log when:
- The user asks for a capability that doesn't exist
- You realize a skill would make a recurring task easier
- The user says "I wish you could..." or "Can you..."

## How to Log

### Error Entry Format
Append to `learnings/ERRORS.md`:

```markdown
### ERR-YYYYMMDD-XXX
- **Logged**: YYYY-MM-DDTHH:MM:SS
- **Severity**: low | medium | high | critical
- **Status**: new | investigating | resolved | wont_fix
- **Command**: The command or operation that failed
- **Error**: "Actual error message or output"
- **Environment**: Relevant context (OS, tool version, project)
- **Root Cause**: What went wrong (fill in when resolved)
- **Fix**: How it was fixed (fill in when resolved)
- **See Also**: Links to related ERR/LRN entries
```

### Learning Entry Format
Append to `learnings/LEARNINGS.md`:

```markdown
### LRN-YYYYMMDD-XXX
- **Logged**: YYYY-MM-DDTHH:MM:SS
- **Priority**: low | medium | high | critical
- **Status**: pending | resolved | promoted
- **Category**: correction | knowledge_gap | best_practice
- **Area**: frontend | backend | infra | tools | docs | config | general
- **Pattern-Key**: short-kebab-case-identifier (for recurring pattern matching)
- **Recurrence-Count**: 1
- **First-Seen**: YYYY-MM-DD
- **Last-Seen**: YYYY-MM-DD

**What happened**: Description of the situation
**What was learned**: The actual insight or correction
**Why it matters**: Impact or consequence of not knowing this

- **See Also**: Links to related LRN/ERR entries
```

### Feature Request Format
Append to `learnings/FEATURE_REQUESTS.md`:

```markdown
### FEAT-YYYYMMDD-XXX
- **Logged**: YYYY-MM-DDTHH:MM:SS
- **Status**: requested | in_progress | built | wont_build
- **Complexity**: simple | medium | complex
- **Requested capability**: What the user wants
- **User context**: Why they want it
- **Suggested implementation**: How it could be built
- **Skill candidate**: yes | no (could this become a reusable skill?)
```

## Recurring Pattern Detection

Before creating a new entry:
1. Read the relevant log file (LEARNINGS.md, ERRORS.md, or FEATURE_REQUESTS.md)
2. Search for entries with matching keywords or Pattern-Key
3. If a match is found:
   - Add a "See Also" link on both entries
   - Increment `Recurrence-Count` on the original
   - Update `Last-Seen` date on the original
   - Do NOT create a duplicate entry
4. If no match, create a new entry

## Promotion Rules

When a learning meets ALL of these criteria, flag it for promotion:
- `Recurrence-Count` >= 3
- Occurred across 2+ distinct tasks
- Within a 30-day window (`Last-Seen` - `First-Seen` <= 30 days)

**Promotion process:**
1. Change Status to `promoted`
2. Append the learning to the `## Promoted Learnings` section of `CLAUDE.md`
3. Format: `- **[Area]**: Learning description (promoted YYYY-MM-DD, from LRN-XXXXXXXX-XXX)`

**Important**: Always ask the user for approval before promoting. Say:
> "I've noticed a recurring pattern: [description]. This has come up [N] times. Should I promote this to CLAUDE.md so I always remember it?"

## Skill Extraction

When a learning is valuable enough to become a reusable skill, it qualifies if:
- It has 2+ "See Also" links to related entries
- Status is `resolved` with a verified working fix
- It required non-obvious debugging to discover
- It's broadly applicable across projects

To extract, create a new SKILL.md in `.claude/skills/<skill-name>/` with:
- `disable-model-invocation: true` (user must opt-in to new auto-generated skills)
- Clear description of what the skill does
- The learned workflow as step-by-step instructions

Always ask the user before creating a new skill.

## Daily Digest

When invoked with `/self-improve digest` or at the end of a long session, summarize:
- New entries added today (count by type)
- Any patterns approaching promotion threshold
- Any feature requests that could be built quickly
