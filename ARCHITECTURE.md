# AI Harness — Architecture

This document explains how each component works and why it was built the way it was.

---

## 1. Discord Bot (`bridges/discord/bot.ts`)

The bot is a TypeScript application using [discord.js](https://discord.js.org/) v14. It connects to Discord, listens for messages, and routes them to Claude.

### Message Flow

```
Discord Message
    │
    ▼
messageCreate listener
    │
    ├── Bot message? → ignore
    ├── Not in ALLOWED_USER_IDS? → ignore
    ├── "/new" command? → clear session
    ├── "/status" command? → show session
    │
    ▼
Request Queue (one-at-a-time)
    │
    ▼
handleClaude()
    │
    ├── Show typing indicator
    ├── Build Claude CLI args (-p, --output-format json, --resume if session exists)
    ├── Generate unique temp file path
    ├── Spawn detached Python process (claude-runner.py)
    │       └── stdio: 'ignore', detached: true
    │
    ▼
Poll for temp file (every 1 second, up to 2 minutes)
    │
    ├── File appears → read JSON, parse response, reply in Discord
    ├── Timeout → reply with timeout message
    │
    ▼
Save session ID for future --resume
```

### Key Design Decisions

**One request at a time**: The bot uses a simple queue (`activeRequest` flag + `requestQueue` array). When Claude is processing a message, new messages get queued and the user sees a hourglass reaction. This prevents resource contention and keeps responses ordered.

**PID file guard**: On startup, the bot writes its PID to `.bot.pid`. If another instance tries to start, it checks if the old PID is still alive and exits if so. This prevents the duplicate-instance problem that caused message spam.

**Message splitting**: Discord has a 2000-character limit. The `splitMessage()` function breaks long responses at line boundaries and preserves code block formatting (reopening ``` blocks across chunks).

---

## 2. Claude Runner (`bridges/discord/claude-runner.py`)

This is the critical bridge between Node.js and Claude CLI.

### The Problem

Claude Code CLI is itself a Node.js/Bun application. When spawned from another Node.js process via `child_process.spawn()`, it hangs indefinitely. This is a [known bug](https://github.com/anthropics/claude-code/issues/771).

Even using Python as an intermediary doesn't fully solve it — Node.js's stdout pipe handling can still stall when reading from the Python process.

### The Solution

```
Node.js Bot                    Python Runner                  Claude CLI
    │                              │                              │
    ├── spawn(detached,            │                              │
    │   stdio:'ignore')            │                              │
    │   ─────────────────────►     │                              │
    │                              ├── subprocess.run()           │
    │                              │   (capture_output=True,      │
    │                              │    stdin=DEVNULL)             │
    │                              │   ─────────────────────►     │
    │                              │                              │
    │   (polling for file)         │       (waiting)              │   (processing)
    │                              │                              │
    │                              │   ◄─────────────────────     │
    │                              │   (stdout + stderr)          │
    │                              │                              │
    │                              ├── Write to .tmp file         │
    │                              ├── os.rename() → final file   │
    │                              │                              │
    │   (file detected!)           │                              │
    │   ◄──────────────────────    │                              │
    │   Read file, parse JSON      │                              │
    │   Reply in Discord           │                              │
```

### Clean Environment

Claude CLI uses environment variables (`CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT=cli`) to detect if it's running inside another Claude session. Since our bot runs from within a Claude Code context, these vars would cause a "Cannot be launched inside another Claude Code session" error.

The runner builds a minimal clean environment:
- `HOME` — needed for Claude to find auth tokens in `~/.claude/`
- `USER`, `PATH`, `SHELL`, `LANG` — standard POSIX vars
- `TERM=dumb` — no terminal formatting
- `SSH_AUTH_SOCK` — for git operations if needed

Everything else (including all `CLAUDE*` vars) is stripped.

### Atomic File Writes

To prevent the bot from reading a half-written file, the runner:
1. Writes to `<output_file>.tmp`
2. Uses `os.rename()` to atomically move it to the final path

`os.rename()` is atomic on the same filesystem, so the bot either sees the complete file or doesn't see it at all.

---

## 3. Session Store (`bridges/discord/session-store.ts`)

Maps Discord channel IDs to Claude session IDs, enabling multi-turn conversations.

```
sessions.json:
{
  "channel_123": {
    "sessionId": "abc-def-ghi",
    "createdAt": "2025-03-09T...",
    "lastUsed": "2025-03-09T..."
  }
}
```

When a user sends a message in a channel that has an existing session, the bot passes `--resume <sessionId>` to Claude, continuing the conversation. Use `/new` in Discord to clear a channel's session.

**Important**: The store path is computed lazily via `getStorePath()` (not a top-level constant) because the `.env` file is loaded by `dotenv.config()` after imports. A top-level constant would capture `HARNESS_ROOT` before it's populated.

---

## 4. Self-Improvement Engine

### How Learning Works

```
Interaction
    │
    ├── UserPromptSubmit hook → activator.sh
    │   └── Detects: corrections ("no, that's wrong"), feature requests ("I wish you could")
    │
    ├── PostToolUse hook → error-detector.sh
    │   └── Detects: non-zero exit codes, error patterns (Traceback, exception, etc.)
    │
    ▼
Log to learnings/ (LRN/ERR/FEAT entries with timestamps)
    │
    ▼
3+ recurrences across 2+ tasks within 30 days?
    │
    ├── Yes → Promote to CLAUDE.md (permanent behavior change)
    └── No  → Keep in learnings/ for reference
```

### Skill Extraction

When a reusable workflow emerges from the learnings, `extract-skill.sh` scaffolds a new skill:

```bash
./scripts/extract-skill.sh my-new-skill
# Creates: .claude/skills/my-new-skill/SKILL.md (with YAML frontmatter template)
```

---

## 5. Troubleshooting

### Bot sends multiple responses
Multiple bot instances are running. Kill all and restart:
```bash
pkill -9 -f "bot.ts"
sleep 2
rm -f bridges/discord/.bot.pid
npx tsx bot.ts > bot.log 2>&1 &
```

### "Claude exited with code 1"
Check the full error in bot.log — look for `[CLAUDE STDERR]` lines. Common causes:
- Claude CLI not authenticated (`claude --version` to check)
- Network issues
- Rate limiting

### Bot starts but no messages appear in logs
- Verify Message Content Intent is enabled in [Discord Developer Portal](https://discord.com/developers/applications)
- Check that `ALLOWED_USER_IDS` in `.env` includes your Discord user ID
- Enable Developer Mode in Discord (Settings → Advanced) to copy user/channel IDs

### "Bot already running" on startup
A previous instance didn't clean up its PID file:
```bash
rm bridges/discord/.bot.pid
```

### Claude response takes too long
The default timeout is 2 minutes. For complex prompts, Claude may need more time. The timeout is set in `claude-runner.py` (`timeout=120`).
