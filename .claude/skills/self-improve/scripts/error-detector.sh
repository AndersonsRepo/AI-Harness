#!/bin/bash
# Hook: PostToolUse (matcher: Bash)
# Auto-captures meaningful errors to vault/learnings/
# Writes the file directly instead of nudging Claude.

EXIT_CODE="$1"
STDOUT="$2"
STDERR="$3"

HARNESS_ROOT="${HARNESS_ROOT:-$HOME/Desktop/AI-Harness}"
VAULT_DIR="$HARNESS_ROOT/vault/learnings"

# --- Noise filtering ---
# Skip trivial/expected non-zero exits
[ -z "$EXIT_CODE" ] && exit 0
[ "$EXIT_CODE" = "0" ] && {
  # Check for error patterns in successful exits, but only severe ones
  if echo "$STDOUT$STDERR" | grep -qiE "(traceback|panic:|segfault|FATAL)"; then
    : # fall through to log
  else
    exit 0
  fi
}

ERROR_MSG="${STDERR:-$STDOUT}"

# Skip known noise patterns (grep no match, ls no files, git status clean, etc.)
if echo "$ERROR_MSG" | grep -qiE "^$"; then exit 0; fi
if echo "$ERROR_MSG" | grep -qiE "(No such file or directory$|no matches found|nothing to commit|Already up to date|Everything up-to-date)"; then exit 0; fi
# Skip deprecation warnings
if echo "$ERROR_MSG" | grep -qiE "^(\(node:\d+\) DeprecationWarning|warning:)" && [ "$EXIT_CODE" = "0" ]; then exit 0; fi
# Skip simple "command not found" for optional tools
if echo "$ERROR_MSG" | grep -qiE "(command not found)" && echo "$ERROR_MSG" | grep -qiE "(bun|pnpm|yarn|brew)"; then exit 0; fi
# Skip short errors (< 10 chars) — usually not informative
[ ${#ERROR_MSG} -lt 10 ] && exit 0

# --- Deduplication ---
# Hash the first 100 chars of error to avoid duplicate entries
ERROR_HASH=$(echo "$ERROR_MSG" | head -c 100 | md5 -q 2>/dev/null || echo "$ERROR_MSG" | head -c 100 | md5sum 2>/dev/null | cut -d' ' -f1)
DEDUP_FILE="$HARNESS_ROOT/vault/.error-hashes"
touch "$DEDUP_FILE"
if grep -q "$ERROR_HASH" "$DEDUP_FILE" 2>/dev/null; then
  # Already logged this error pattern — just nudge Claude
  echo "[SELF-IMPROVE] Recurring error (already logged). Check vault/learnings/ for existing entry."
  exit 0
fi
echo "$ERROR_HASH" >> "$DEDUP_FILE"
# Keep dedup file bounded (last 200 hashes)
tail -200 "$DEDUP_FILE" > "$DEDUP_FILE.tmp" && mv "$DEDUP_FILE.tmp" "$DEDUP_FILE"

# --- Write vault entry ---
mkdir -p "$VAULT_DIR"
TODAY=$(date +%Y%m%d)
NOW=$(date +%Y-%m-%dT%H:%M:%S)
TODAY_DASH=$(date +%Y-%m-%d)

# Find next sequence number for today
SEQ=1
while [ -f "$VAULT_DIR/ERR-${TODAY}-$(printf '%03d' $SEQ).md" ]; do
  SEQ=$((SEQ + 1))
done
SEQ_STR=$(printf '%03d' $SEQ)
ID="ERR-${TODAY}-${SEQ_STR}"

ERROR_SHORT=$(echo "$ERROR_MSG" | head -c 500)
# Extract a title from the error (first meaningful line)
TITLE=$(echo "$ERROR_MSG" | grep -iE "(error|failed|exception|traceback|fatal)" | head -1 | head -c 80)
[ -z "$TITLE" ] && TITLE=$(echo "$ERROR_MSG" | head -1 | head -c 80)

cat > "$VAULT_DIR/$ID.md" << ENTRY
---
id: $ID
logged: $NOW
type: error
severity: medium
status: new
category: runtime_error
area: general
agent: main
project: general
pattern-key: auto-captured-error
recurrence-count: 1
first-seen: $TODAY_DASH
last-seen: $TODAY_DASH
tags: [auto-captured, exit-code-$EXIT_CODE]
related: []
---

# $TITLE

## Command
Auto-captured by error-detector hook.

## Error
\`\`\`
$ERROR_SHORT
\`\`\`

## Exit Code
$EXIT_CODE

## Root Cause
(To be filled in when investigated)

## Fix
(To be filled in when resolved)
ENTRY

echo "[SELF-IMPROVE] Error auto-logged to vault/learnings/$ID.md — review and update root cause/fix when resolved."
exit 0
