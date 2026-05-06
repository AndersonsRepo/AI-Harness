#!/usr/bin/env bash
# harness-stop — Cleanly stop all AI Harness activity.
#
# Use when you need a quiet machine (proctored tests, etc.). Effects:
#   - Disables and unloads all 38 com.aiharness.* LaunchAgents.
#     `disable` is durable: agents stay off across login/reboot until
#     harness-start re-enables them. Plain `unload` alone gets undone
#     by the next login.
#   - Kills the Discord bot (and its tsx wrapper).
#   - Kills any orphaned claude-runner.py / codex-runner.py /
#     heartbeat-runner.py subprocesses spawned by the bot.
#   - Removes the bot's stale PID file if present.
#
# What it does NOT touch:
#   - MCP servers attached to your live Claude Code session — those exit
#     on their own when you close Claude Code.
#   - Claude Code itself — close the IDE manually before a test.
#
# After this finishes, no AI Harness process makes any outbound API call
# and no com.aiharness LaunchAgent will fire on a schedule.

set -uo pipefail

LAUNCHD_DIR="$HOME/Library/LaunchAgents"
USER_GUI="gui/$(id -u)"
HARNESS_LINK="$HOME/.local/ai-harness"

echo "[harness-stop] Disabling and unloading com.aiharness.* LaunchAgents"
disabled=0
for plist in "$LAUNCHD_DIR"/com.aiharness.*.plist; do
  [ -e "$plist" ] || continue
  job=$(basename "$plist" .plist)
  launchctl disable "$USER_GUI/$job" >/dev/null 2>&1 && disabled=$((disabled+1)) || true
  launchctl unload "$plist" >/dev/null 2>&1 || true
done
echo "[harness-stop]   $disabled jobs disabled"

echo "[harness-stop] Killing bot processes"
bot_pids=$(pgrep -f "tsx.*bot-v2|node.*bot-v2" || true)
if [ -n "$bot_pids" ]; then
  echo "$bot_pids" | xargs -n1 kill 2>/dev/null || true
  echo "[harness-stop]   killed: $bot_pids"
fi

echo "[harness-stop] Killing orphaned runner subprocesses"
runner_pids=$(pgrep -f "claude-runner\.py|codex-runner\.py|heartbeat-runner\.py" || true)
if [ -n "$runner_pids" ]; then
  echo "$runner_pids" | xargs -n1 kill 2>/dev/null || true
  echo "[harness-stop]   killed: $runner_pids"
fi

if [ -e "$HARNESS_LINK/.bot.pid" ]; then
  rm -f "$HARNESS_LINK/.bot.pid"
  echo "[harness-stop] Removed stale .bot.pid"
fi

# Give launchd a moment to reflect.
sleep 2

# Verify.
loaded=$(launchctl list | grep -c "com.aiharness" || true)
live=$(pgrep -fc "tsx.*bot-v2|claude-runner\.py|codex-runner\.py|heartbeat-runner\.py" 2>/dev/null || echo 0)

echo
echo "──────────────── Status ────────────────"
echo "Loaded com.aiharness LaunchAgents: $loaded"
echo "Live harness processes:            $live"

if [ "$loaded" -eq 0 ] && [ "$live" -eq 0 ]; then
  echo "✓ All AI Harness activity stopped."
  exit 0
else
  echo "⚠ Some agents/processes still alive. Investigate:"
  echo "──"
  launchctl list | grep com.aiharness || true
  echo "──"
  ps aux | grep -E "tsx.*bot-v2|claude-runner\.py|codex-runner\.py|heartbeat-runner\.py" | grep -v grep || true
  exit 1
fi
