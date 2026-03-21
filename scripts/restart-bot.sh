#!/bin/bash
# Restart the AI Harness Discord bot via launchd
# Works regardless of bot state — no dependency on the bot process being responsive
#
# Usage:
#   ./scripts/restart-bot.sh          — restart bot
#   ./scripts/restart-bot.sh status   — check if bot is running

LABEL="com.aiharness.discord-bot"

case "${1:-restart}" in
  status)
    pid=$(launchctl list | grep "$LABEL" | awk '{print $1}')
    if [ "$pid" != "-" ] && [ -n "$pid" ]; then
      echo "Bot is running (PID $pid)"
    else
      echo "Bot is not running"
    fi
    ;;
  restart)
    echo "Restarting bot..."
    launchctl kickstart -k "gui/$(id -u)/$LABEL"
    sleep 3
    pid=$(launchctl list | grep "$LABEL" | awk '{print $1}')
    if [ "$pid" != "-" ] && [ -n "$pid" ]; then
      echo "Bot restarted (PID $pid)"
    else
      echo "Bot failed to start — check: tail -20 ~/.local/ai-harness/bridges/discord/bot.log"
    fi
    ;;
  stop)
    echo "Stopping bot..."
    launchctl kill SIGTERM "gui/$(id -u)/$LABEL"
    echo "Bot stopped"
    ;;
  *)
    echo "Usage: restart-bot.sh [restart|stop|status]"
    ;;
esac
