---
title: Tool Gotchas
updated: 2025-03-10
scope: shared
---

# Tool Gotchas

## Claude CLI Spawning

- **NEVER spawn `claude` from Node.js `child_process`** — hangs indefinitely (GitHub issue #771). Use the Python file-based runner instead.
- **NEVER pass `CLAUDE*` env vars to spawned claude** — triggers "nested session" error. Strip all env vars starting with `CLAUDE` before spawning.
- **Claude auth requires `HOME` env var** — points to `~/.claude/` config directory. A fully clean env (`env -i`) causes "Not logged in".
- **Use `stdin=subprocess.DEVNULL`** when calling claude from Python — avoids TTY detection issues.
- **Atomic file writes** — Python runner must write to `.tmp` then `os.rename()` to final path to prevent partial reads during polling.

## Discord Bot

- **Only one bot instance at a time** — PID file guard at `bridges/discord/.bot.pid` prevents duplicate connections.
- **Discord messages > 2000 chars must be split** — use `splitMessage()` with code block preservation.
- **Session store path must be lazy** — `getStorePath()` function, not top-level const. `dotenv` loads after imports.

## macOS

- **LaunchAgent blocked by TCC on `~/Desktop`** — use symlink from `~/.local/ai-harness` to bypass TCC restriction. No Full Disk Access needed.
- **`nohup` or inline plist commands** work as alternatives to LaunchAgent for Desktop paths.
