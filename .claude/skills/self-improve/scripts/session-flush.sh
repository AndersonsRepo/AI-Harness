#!/bin/bash
# Pre-compaction memory flush — runs session-debrief for the current project
# Triggered as a Stop hook when a Claude Code conversation ends.
# Extracts learnings from the current transcript before context is lost.

HARNESS_ROOT="${HARNESS_ROOT:-$HOME/Desktop/AI-Harness}"
PYTHON="/opt/homebrew/bin/python3"
SCRIPT="$HARNESS_ROOT/heartbeat-tasks/scripts/session-debrief.py"

# Run in background so it doesn't block the exit
nohup "$PYTHON" "$SCRIPT" > /dev/null 2>&1 &
