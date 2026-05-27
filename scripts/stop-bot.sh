#!/bin/bash
# Stop the AI Harness Discord bot via launchd.
# Cleanly bootouts the bot's LaunchAgent so launchd will not respawn it
# until you run start-harness.sh (or restart-bot.sh).
#
# Usage:
#   ./scripts/stop-bot.sh

set -euo pipefail

LABEL="com.aiharness.discord-bot"
DOMAIN="gui/$(id -u)"

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  echo "Stopping bot ($LABEL)..."
  launchctl bootout "$DOMAIN/$LABEL" 2>&1 || true
  echo "Bot stopped."
else
  echo "Bot is not loaded."
fi
