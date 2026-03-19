#!/bin/bash
# Start AI Harness Bot v2 (Gateway + DiscordTransport architecture)
# Usage: ./start-bot-v2.sh
#
# To switch the launchd plist to use v2:
#   Edit ~/Library/LaunchAgents/com.aiharness.discord-bot.plist
#   Change bot.ts → bot-v2.ts in ProgramArguments

cd "$(dirname "$0")"
HARNESS_ROOT="${HARNESS_ROOT:-$(cd ../.. && pwd)}"
export HARNESS_ROOT

echo "Starting AI Harness Bot v2..."
echo "  HARNESS_ROOT=$HARNESS_ROOT"
exec npx tsx bot-v2.ts
