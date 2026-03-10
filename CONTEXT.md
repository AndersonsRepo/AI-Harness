# AI Harness — Agent Context

> Machine-readable project state. Updated after every confirmed change.
> Last updated: 2025-03-10

## System Map

| Component | Entry Point | Status | Dependencies |
|-----------|-------------|--------|--------------|
| Discord bot | `bridges/discord/bot.ts` | active | claude-runner.py, session-store.ts, discord.js, dotenv |
| Claude runner | `bridges/discord/claude-runner.py` | active | claude CLI (`~/.local/bin/claude`), Python 3 |
| Session store | `bridges/discord/session-store.ts` | active | fs (Node built-in) |
| Self-improve skill | `.claude/skills/self-improve/SKILL.md` | active | vault/learnings/, CLAUDE.md |
| Obsidian vault | `vault/` | active | Structured markdown files with YAML frontmatter |
| Doc-on-success skill | `.claude/skills/doc-on-success/SKILL.md` | active | README.md, ARCHITECTURE.md, CONTEXT.md |
| Activator hook | `scripts/activator.sh` | active | .claude/settings.json (UserPromptSubmit) |
| Error detector hook | `scripts/error-detector.sh` | active | .claude/settings.json (PostToolUse:Bash) |
| Skill extractor | `scripts/extract-skill.sh` | active | .claude/skills/ |
| LaunchAgent | `~/Library/LaunchAgents/com.aiharness.discord-bot.plist` | inactive | npx, tsx, bot.ts |

## Interfaces

### bot.ts → claude-runner.py
- Spawn: `python3 claude-runner.py <output_file> -p --output-format json [--resume <session_id>] <user_message>`
- Spawn mode: `detached: true`, `stdio: 'ignore'`
- Output file schema: `{ stdout: string, stderr: string, returncode: number }`
- stdout contains Claude's JSON: `{ type, subtype, is_error, result, session_id, ... }`
- Polling: 1s interval, 120s timeout
- Temp files: `bridges/discord/.tmp/response-<timestamp>-<random>.json`

### bot.ts → session-store.ts
- `getSession(channelId: string): string | null` — returns Claude session ID
- `setSession(channelId: string, sessionId: string): void` — persists session
- `clearSession(channelId: string): boolean` — removes session
- `listSessions(): SessionMap` — all active sessions
- Storage: `bridges/discord/sessions.json` (path resolved lazily via `getStorePath()`)

### bot.ts → Discord
- Events: `clientReady`, `messageCreate`
- Commands: `/new` (clear session), `/status` (show session)
- Message splitting: `splitMessage()` at 1900 chars, preserves code blocks
- Typing indicator: re-sent during polling

### claude-runner.py → claude CLI
- Invocation: `subprocess.run([claude_path] + args, capture_output=True, text=True, stdin=DEVNULL, env=clean_env, timeout=120)`
- Clean env: HOME, USER, PATH, SHELL, LANG, TERM=dumb, SSH_AUTH_SOCK (no CLAUDE* vars)
- Atomic output: writes to `<file>.tmp` then `os.rename()` to final path

### Hooks (settings.json)
- `UserPromptSubmit` → `bash ./scripts/activator.sh "$PROMPT"` (detects corrections, feature requests)
- `PostToolUse[Bash]` → `bash ./scripts/error-detector.sh "$EXIT_CODE" "$STDOUT" "$STDERR"` (detects failures)

### vault/ structure
- `vault/shared/` — cross-agent knowledge (conventions, gotchas, project knowledge)
- `vault/agents/<name>/` — private working memory per agent (researcher, discord, reviewer)
- `vault/learnings/` — individual `.md` files per learning/error/feature with YAML frontmatter
- `vault/daily/` — daily digest notes
- All vault files use `[[wikilinks]]` for cross-references
- Each learning file has frontmatter: id, type, status, tags, pattern-key, recurrence-count, related

## Constraints & Gotchas

- NEVER spawn `claude` directly from Node.js child_process → hangs indefinitely (issue #771)
- NEVER pass CLAUDE* env vars to spawned claude process → "nested session" error
- NEVER use stdout pipes between Node.js and the Python runner → stalls even with Python intermediary
- Session store path MUST use `getStorePath()` function (not top-level const) → dotenv loads after imports
- Only ONE bot instance at a time → PID file guard at `bridges/discord/.bot.pid`
- Discord messages > 2000 chars → must use `splitMessage()` with code block preservation
- Claude runner MUST pass `stdin=subprocess.DEVNULL` → avoids TTY detection issues
- Claude runner MUST use atomic writes (.tmp + rename) → prevents partial file reads during polling
- Claude auth requires `HOME` env var → points to `~/.claude/` config directory
- LaunchAgent blocked by macOS TCC on Desktop paths → use `nohup` or inline plist commands instead
- Bot `.env` must contain DISCORD_TOKEN, ALLOWED_USER_IDS, HARNESS_ROOT
- Vault learning files MUST have YAML frontmatter with required fields (id, type, status, tags, pattern-key)
- Vault files are never deleted — mark status as `archived` instead

## File Quick Reference

| Path | Purpose |
|------|---------|
| `CLAUDE.md` | Agent personality, conventions, promoted learnings |
| `PLAN.md` | 6-phase build plan |
| `README.md` | Human-readable project overview |
| `ARCHITECTURE.md` | Human-readable technical deep dive |
| `CONTEXT.md` | This file — AI-optimized project state |
| `bridges/discord/.env` | Secrets (gitignored): DISCORD_TOKEN, ALLOWED_USER_IDS, HARNESS_ROOT |
| `bridges/discord/.env.example` | Template for .env |
| `learnings/LEARNINGS.md` | Legacy — knowledge gaps, corrections (kept for backward compat) |
| `learnings/ERRORS.md` | Legacy — command failures (kept for backward compat) |
| `learnings/FEATURE_REQUESTS.md` | Legacy — requested capabilities (kept for backward compat) |
| `vault/` | Obsidian-compatible memory vault (source of truth for agent knowledge) |
| `vault/shared/conventions.md` | Coding standards and project conventions |
| `vault/shared/tool-gotchas.md` | Known tool/CLI/API issues |
| `vault/shared/project-knowledge/` | Per-project context (mento.md, client-project.md) |
| `vault/learnings/*.md` | Individual learning/error/feature files with YAML frontmatter |

## Change Log

| Date | Type | Description | Commit |
|------|------|-------------|--------|
| 2025-03-09 | infrastructure | Initial scaffold — CLAUDE.md, PLAN.md, learnings/, .gitignore | 2c2f1b9 |
| 2025-03-09 | feature | Self-improvement engine — skills, hooks, scripts | b11e768 |
| 2025-03-09 | feature | Discord bridge bot — bot.ts, session-store.ts, .env.example | 2f52d00 |
| 2025-03-09 | bugfix | File-based Claude runner, PID guard, session store path fix | cc621e6 |
| 2025-03-09 | docs | README.md + ARCHITECTURE.md | 2e9b246 |
| 2025-03-10 | feature | Phase 3.5: Obsidian vault memory layer — vault structure, self-improve rewired, PLAN.md updated | — |
