---
name: handoff
description: Extract current or specified session transcript into a text digest for pasting into a new session.
user-invocable: true
argument-hint: "[channel-id | session-uuid | --list]"
context: fork
model: sonnet
allowed-tools:
  - Read
  - Bash
  - Write
---

# Session Handoff

Preserve context across session boundaries by extracting the conversation into a portable digest.

## When to use
- Session poisoned by oversized images (dimension > 2000px)
- Session has gotten very long and context quality is degrading
- User explicitly wants to start fresh without losing context
- Preparing to switch channels or projects

## Current sessions
!`python3 heartbeat-tasks/scripts/extract-session.py --list 2>&1 | head -20`

## Steps

1. **Parse `$ARGUMENTS`**:
   - No args → use the most recent session from the list above
   - `--list` → show the list and stop (done above)
   - Looks like a UUID (has dashes, >20 chars) → treat as session ID
   - Otherwise → treat as channel ID

2. **Run extraction**:

       python3 heartbeat-tasks/scripts/extract-session.py <session-or-channel>

   This writes `vault/shared/<channel-or-session>-digest.md` and prints the output path.

3. **Read the digest file** with Read tool.

4. **Generate TL;DR**. Analyze the digest and produce a compact recap (~150-300 words) with these sections:
   - **Project**: what codebase/project this session was about
   - **Just completed**: most recent accomplishments (last 5-10 turns)
   - **Current issue / where stuck**: what was being worked on when the session ended
   - **Next steps**: concrete investigation or action items
   - **Full digest**: path to the saved digest file for retrieval

5. **Output the TL;DR** in a fenced code block so the user can copy-paste it into the new session.

## Output format

```
## Handoff Summary

Extracted X turns from session <short-id>
Saved to: vault/shared/<label>-digest.md

### Paste this into your new session:

```
[CONTEXT RECAP — prior session handed off]

## Project
<1-2 lines>

## Just completed
- bullet
- bullet

## Current issue
<description>

## Next steps
1. ...
2. ...

Full conversation digest: vault/shared/<label>-digest.md
```
```
