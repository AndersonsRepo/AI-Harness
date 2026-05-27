#!/bin/bash
# Stop all AI Harness heartbeat LaunchAgents (does NOT touch the bot).
# Iterates every ~/Library/LaunchAgents/com.aiharness.heartbeat.*.plist
# and bootouts each one. Counts and reports.
#
# Usage:
#   ./scripts/stop-heartbeats.sh

set -euo pipefail

DOMAIN="gui/$(id -u)"
LA_DIR="$HOME/Library/LaunchAgents"
PATTERN="com.aiharness.heartbeat.*.plist"

stopped=0
skipped=0
for plist in "$LA_DIR"/$PATTERN; do
  [ -e "$plist" ] || { echo "No heartbeat plists found in $LA_DIR"; exit 0; }
  label=$(basename "$plist" .plist)
  if launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then
    launchctl bootout "$DOMAIN/$label" 2>&1 | sed "s|^|$label: |" || true
    stopped=$((stopped + 1))
  else
    skipped=$((skipped + 1))
  fi
done

echo "Stopped: $stopped heartbeat(s)"
echo "Already stopped: $skipped"
