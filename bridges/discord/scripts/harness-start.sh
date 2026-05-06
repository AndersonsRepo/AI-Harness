#!/usr/bin/env bash
# harness-start — Bring the AI Harness back online after harness-stop.
#
# Reverses harness-stop:
#   1. Re-enables all 38 com.aiharness.* LaunchAgents (un-does
#      `launchctl disable`).
#   2. Loads each plist into the user's launchd domain.
#   3. Kickstarts the Discord bot explicitly — the bot job is OnDemand,
#      so loading the plist alone does NOT start the process.
#   4. Verifies the bot is running and prints quick health info.

set -uo pipefail

LAUNCHD_DIR="$HOME/Library/LaunchAgents"
USER_GUI="gui/$(id -u)"
HARNESS_LINK="$HOME/.local/ai-harness"
BOT_LABEL="com.aiharness.discord-bot"

echo "[harness-start] Re-enabling com.aiharness.* LaunchAgents"
enabled=0
for plist in "$LAUNCHD_DIR"/com.aiharness.*.plist; do
  [ -e "$plist" ] || continue
  job=$(basename "$plist" .plist)
  launchctl enable "$USER_GUI/$job" >/dev/null 2>&1 && enabled=$((enabled+1)) || true
done
echo "[harness-start]   $enabled jobs enabled"

echo "[harness-start] Loading plists"
loaded=0
for plist in "$LAUNCHD_DIR"/com.aiharness.*.plist; do
  [ -e "$plist" ] || continue
  if launchctl load "$plist" 2>/dev/null; then
    loaded=$((loaded+1))
  fi
done
echo "[harness-start]   $loaded plists loaded"

echo "[harness-start] Kickstarting Discord bot"
launchctl kickstart -k "$USER_GUI/$BOT_LABEL" >/dev/null 2>&1 || \
  echo "[harness-start]   ⚠ kickstart failed — try: launchctl kickstart -k $USER_GUI/$BOT_LABEL"

# Give the bot a moment to boot.
sleep 4

bot_pid=$(pgrep -f "tsx.*bot-v2" | head -1 || true)
loaded_now=$(launchctl list | grep -c "com.aiharness" || true)

echo
echo "──────────────── Status ────────────────"
echo "Loaded com.aiharness LaunchAgents: $loaded_now"
if [ -n "$bot_pid" ]; then
  echo "Discord bot PID: $bot_pid"
  log="$HARNESS_LINK/bridges/discord/bot.log"
  if [ -f "$log" ]; then
    last_ready=$(grep "AI Harness Bot v2 ready" "$log" | tail -1 || true)
    if [ -n "$last_ready" ]; then
      echo "Last ready line: $last_ready"
    fi
  fi
  echo "✓ Harness is up."
  exit 0
else
  echo "⚠ Bot did not start. Check the log:"
  echo "    tail -30 $HARNESS_LINK/bridges/discord/bot.log"
  exit 1
fi
