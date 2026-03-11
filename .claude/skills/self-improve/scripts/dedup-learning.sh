#!/bin/bash
# Shared deduplication logic for vault learnings.
# Called by activator.sh and error-detector.sh before creating new entries.
#
# Usage: source dedup-learning.sh
#        check_and_dedup "$PATTERN_KEY" "$CATEGORY" "$TAGS_CSV"
#
# Returns via global vars:
#   DEDUP_ACTION="new"     — no match found, create new entry
#   DEDUP_ACTION="skip"    — match found, recurrence incremented, skip creation
#   DEDUP_MATCH_ID         — ID of matched entry (when action=skip)

HARNESS_ROOT="${HARNESS_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}"
VAULT_DIR="$HARNESS_ROOT/vault/learnings"

DEDUP_ACTION="new"
DEDUP_MATCH_ID=""

check_and_dedup() {
  local PATTERN_KEY="$1"
  local CATEGORY="$2"
  local TAGS_CSV="$3"

  DEDUP_ACTION="new"
  DEDUP_MATCH_ID=""

  [ ! -d "$VAULT_DIR" ] && return 0

  # Strategy 1: Match by pattern-key (most precise)
  if [ -n "$PATTERN_KEY" ] && [ "$PATTERN_KEY" != "auto-captured-error" ] && [ "$PATTERN_KEY" != "user-reported-bug" ] && [ "$PATTERN_KEY" != "user-feature-request" ]; then
    for file in "$VAULT_DIR"/*.md; do
      [ ! -f "$file" ] && continue
      if grep -q "^pattern-key: $PATTERN_KEY$" "$file" 2>/dev/null; then
        increment_recurrence "$file"
        return 0
      fi
    done
  fi

  # Strategy 2: Match by category + overlapping tags
  # Only for auto-captured entries (generic pattern-keys)
  if [ -n "$CATEGORY" ] && [ -n "$TAGS_CSV" ]; then
    local MATCH_THRESHOLD=2  # Need at least 2 matching tags
    for file in "$VAULT_DIR"/*.md; do
      [ ! -f "$file" ] && continue

      # Check same category
      if ! grep -q "^category: $CATEGORY$" "$file" 2>/dev/null; then
        continue
      fi

      # Count overlapping tags
      local TAG_LINE
      TAG_LINE=$(grep "^tags:" "$file" 2>/dev/null)
      [ -z "$TAG_LINE" ] && continue

      local MATCH_COUNT=0
      IFS=',' read -ra TAG_ARRAY <<< "$TAGS_CSV"
      for tag in "${TAG_ARRAY[@]}"; do
        tag=$(echo "$tag" | xargs)  # trim whitespace
        if echo "$TAG_LINE" | grep -qi "$tag"; then
          MATCH_COUNT=$((MATCH_COUNT + 1))
        fi
      done

      if [ "$MATCH_COUNT" -ge "$MATCH_THRESHOLD" ]; then
        increment_recurrence "$file"
        return 0
      fi
    done
  fi

  # No match — caller should create new entry
  DEDUP_ACTION="new"
}

increment_recurrence() {
  local FILE="$1"
  local TODAY_DASH
  TODAY_DASH=$(date +%Y-%m-%d)

  # Extract current recurrence-count
  local CURRENT_COUNT
  CURRENT_COUNT=$(grep "^recurrence-count:" "$FILE" | sed 's/recurrence-count: *//')
  CURRENT_COUNT=${CURRENT_COUNT:-1}
  local NEW_COUNT=$((CURRENT_COUNT + 1))

  # Extract the ID for logging
  DEDUP_MATCH_ID=$(grep "^id:" "$FILE" | sed 's/id: *//')

  # Update recurrence-count
  sed -i '' "s/^recurrence-count: .*/recurrence-count: $NEW_COUNT/" "$FILE"

  # Update last-seen
  sed -i '' "s/^last-seen: .*/last-seen: $TODAY_DASH/" "$FILE"

  # If status was "new", bump to "recurring"
  if grep -q "^status: new$" "$FILE"; then
    sed -i '' "s/^status: new$/status: recurring/" "$FILE"
  fi

  DEDUP_ACTION="skip"
  echo "[SELF-IMPROVE] Recurring pattern (${DEDUP_MATCH_ID}, count: $NEW_COUNT). Updated existing entry."
}
