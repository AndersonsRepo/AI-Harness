---
name: heartbeat
description: Creates and manages scheduled background tasks using macOS launchd.
user-invocable: true
argument-hint: "<create|list|pause|resume|delete|run|logs> [name] [options]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - Edit
---

# Heartbeat — Scheduled Task Manager

Create, list, pause, and delete recurring background tasks that run Claude on a schedule.

## Live LaunchAgent Status
!`launchctl list | grep com.aiharness.heartbeat 2>/dev/null || echo "(no heartbeat agents loaded)"`

## Commands

- `/heartbeat create <name> "<prompt>" --interval <minutes>` — Create a new scheduled task
- `/heartbeat list` — Show all heartbeat tasks and their status
- `/heartbeat pause <name>` — Disable a task without deleting it
- `/heartbeat resume <name>` — Re-enable a paused task
- `/heartbeat delete <name>` — Remove a task and its plist
- `/heartbeat run <name>` — Run a task immediately (one-shot, don't wait for schedule)
- `/heartbeat logs <name>` — Show recent output from a task

## How It Works

Each heartbeat task is a macOS LaunchAgent that runs `claude -p` on a schedule via the Python runner.

```
launchd (interval timer)
    │
    └── python3 heartbeat-runner.py <task-name>
            │
            ├── Read task config from heartbeat-tasks/<task-name>.json
            ├── Read state from heartbeat-tasks/<task-name>.state.json
            ├── Run: claude -p "<prompt>" --output-format json
            │       (via claude-runner.py with clean env)
            ├── Write result to state file
            ├── Write summary to vault/daily/<date>.md (append)
            └── If notify=discord: send summary to Discord channel
```

## Task Config Format

Each task is defined in `heartbeat-tasks/<task-name>.json`:

```json
{
  "name": "daily-digest",
  "prompt": "Read all files in vault/learnings/ with today's date. Summarize what was learned, any patterns approaching promotion (recurrence-count >= 2), and any quick-win feature requests. Write the summary to vault/daily/<today>.md.",
  "interval_minutes": 1440,
  "notify": "discord",
  "discord_channel": "general",
  "allowed_tools": ["Read", "Write", "Glob", "Grep"],
  "enabled": true,
  "created": "2025-03-10T09:00:00"
}
```

## State Format

Each task maintains state in `heartbeat-tasks/<task-name>.state.json`:

```json
{
  "last_run": "2025-03-10T09:00:00",
  "last_result": "success",
  "last_output_summary": "3 new learnings, 1 pattern approaching promotion",
  "consecutive_failures": 0,
  "total_runs": 42
}
```

## Creating a Heartbeat Task

When the user runs `/heartbeat create`, do the following:

### Step 1: Create Task Config
Write the task JSON to `heartbeat-tasks/<name>.json`.

### Step 2: Create LaunchAgent Plist
Generate a plist at `~/Library/LaunchAgents/com.aiharness.heartbeat.<name>.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.aiharness.heartbeat.<name></string>

    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/python3</string>
        <string>$HOME/.local/ai-harness/heartbeat-tasks/heartbeat-runner.py</string>
        <string><name></string>
    </array>

    <key>WorkingDirectory</key>
    <string>$HOME/.local/ai-harness</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>

    <key>StartInterval</key>
    <integer><!-- interval_minutes * 60 --></integer>

    <key>RunAtLoad</key>
    <false/>

    <key>StandardOutPath</key>
    <string>$HOME/.local/ai-harness/heartbeat-tasks/logs/<name>.log</string>

    <key>StandardErrorPath</key>
    <string>$HOME/.local/ai-harness/heartbeat-tasks/logs/<name>.log</string>

    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
```

**Important**: Use the symlink path (`~/.local/ai-harness`) not the Desktop path, to avoid TCC issues. When generating the plist, replace `$HOME` with the user's actual home directory (e.g., `/Users/yourusername`), since launchd plist files do not expand environment variables.

### Step 3: Load the Plist
```bash
launchctl load ~/Library/LaunchAgents/com.aiharness.heartbeat.<name>.plist
```

## Pausing / Resuming

- **Pause**: `launchctl unload <plist>` and set `enabled: false` in task config
- **Resume**: `launchctl load <plist>` and set `enabled: true` in task config

## Deleting

1. `launchctl unload <plist>`
2. Delete the plist file
3. Delete the task config and state files
4. Optionally archive logs

## Error Handling

- If a task fails 3 consecutive times, auto-pause it and notify via Discord
- Log all failures to the task's state file and log file
- The heartbeat runner should never crash — wrap everything in try/except

## Built-in Tasks

These tasks come pre-configured with AI Harness:

### daily-digest
- **Interval**: Once per day (1440 minutes)
- **Prompt**: Summarize today's vault learnings, check for promotion candidates, list quick-win feature requests
- **Output**: `vault/daily/YYYY-MM-DD.md`
- **Notify**: Discord

### session-cleanup
- **Interval**: Once per day (1440 minutes)
- **Prompt**: Check `bridges/discord/sessions.json` for sessions older than 7 days and remove them
- **Output**: State file only
- **Notify**: None
