#!/usr/bin/env bash
# harness-status — Read-only inspection of the AI Harness runtime state.
# Tells you in one screen whether the harness is on, off, or in a weird
# half-state. Useful before a test ("is it actually quiet right now?")
# and after harness-start ("did everything come up?").

set -uo pipefail

USER_GUI="gui/$(id -u)"
BOT_LABEL="com.aiharness.discord-bot"
HARNESS_LINK="$HOME/.local/ai-harness"

echo "──────────────── AI Harness — Status ────────────────"

# 1. LaunchAgents.
loaded=$(launchctl list | grep -c "com.aiharness" || true)
total_plists=$(ls "$HOME/Library/LaunchAgents"/com.aiharness.*.plist 2>/dev/null | wc -l | tr -d ' ')
echo "LaunchAgents: $loaded / $total_plists loaded"

# 2. Discord bot.
bot_pid=$(pgrep -f "tsx.*bot-v2" | head -1 || true)
if [ -n "$bot_pid" ]; then
  uptime=$(ps -p "$bot_pid" -o etime= 2>/dev/null | tr -d ' ' || echo "?")
  echo "Discord bot:  RUNNING (pid $bot_pid, uptime $uptime)"
else
  echo "Discord bot:  STOPPED"
fi

# 3. Runner subprocesses.
runner_count=$(pgrep -fc "claude-runner\.py|codex-runner\.py|heartbeat-runner\.py" 2>/dev/null || echo 0)
echo "Runner procs: $runner_count active"

# 4. Verdict.
if [ "$loaded" -eq 0 ] && [ -z "$bot_pid" ] && [ "$runner_count" -eq 0 ]; then
  echo "Verdict:      ✓ QUIET (no AI Harness activity)"
elif [ "$loaded" -eq "$total_plists" ] && [ -n "$bot_pid" ]; then
  echo "Verdict:      ✓ FULLY UP"
else
  echo "Verdict:      ⚠ MIXED — partial state"
fi

# 5. Optional log peek.
if [ "${1:-}" = "-v" ]; then
  log="$HARNESS_LINK/bridges/discord/bot.log"
  if [ -f "$log" ]; then
    echo
    echo "──── Last 5 bot.log lines ────"
    tail -5 "$log"
  fi
fi
