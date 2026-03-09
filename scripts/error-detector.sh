#!/bin/bash
# Hook: PostToolUse (matcher: Bash)
# Detects command failures and triggers error logging.

EXIT_CODE="$1"
STDOUT="$2"
STDERR="$3"

# Only trigger on non-zero exit codes
if [ "$EXIT_CODE" != "0" ] && [ -n "$EXIT_CODE" ]; then
  # Extract a short error summary (first 200 chars of stderr, or stdout if stderr is empty)
  ERROR_MSG="${STDERR:-$STDOUT}"
  ERROR_SHORT=$(echo "$ERROR_MSG" | head -c 200)

  echo "[SELF-IMPROVE] Command failed (exit code: $EXIT_CODE). Error: $ERROR_SHORT — Log this in learnings/ERRORS.md with the command that failed and root cause analysis."
  exit 0
fi

# Detect common error patterns even in successful exits (exit 0 but error in output)
if echo "$STDOUT$STDERR" | grep -qiE "(traceback|exception|error:|fatal:|panic:|segfault|permission denied|command not found)"; then
  ERROR_SHORT=$(echo "$STDOUT$STDERR" | grep -iE "(traceback|exception|error:|fatal:|panic:|segfault|permission denied|command not found)" | head -1 | head -c 200)
  echo "[SELF-IMPROVE] Error pattern detected in output: $ERROR_SHORT — Evaluate whether this should be logged in learnings/ERRORS.md."
  exit 0
fi

# No error — silent exit
exit 0
