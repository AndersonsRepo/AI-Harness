#!/bin/bash
# Hook: UserPromptSubmit
# Auto-captures corrections and feature requests to vault/learnings/
# Writes the file directly instead of nudging Claude.

PROMPT="$1"
HARNESS_ROOT="${HARNESS_ROOT:-$HOME/Desktop/AI-Harness}"
VAULT_DIR="$HARNESS_ROOT/vault/learnings"

# --- Detect correction patterns ---
if echo "$PROMPT" | grep -qiE "(no,? that'?s (wrong|not)|actually[,.]|not like that|that'?s incorrect|you'?re wrong|wrong approach|that doesn'?t work|fix this|you made a mistake|you forgot|stop doing that|don'?t do that|I told you)"; then
  TYPE="LRN"
  CATEGORY="correction"
  TITLE="User correction"
  BODY_HEADER="## What happened"
  BODY_CONTENT="User corrected the agent's approach."
  BODY_SECTION="## What was learned"
  BODY_INSIGHT="(Claude should fill this in after processing the correction)"
elif echo "$PROMPT" | grep -qiE "(i wish you could|can you also|is there a way to|it would be nice if|can you learn to|add a feature|I need you to be able to|we should add|we need)"; then
  TYPE="FEAT"
  CATEGORY="feature_request"
  TITLE="Feature request"
  BODY_HEADER="## Requested capability"
  BODY_CONTENT="User requested a new capability."
  BODY_SECTION="## User context"
  BODY_INSIGHT="(To be filled in)"
else
  # No special pattern — silent exit
  exit 0
fi

# --- Write vault entry ---
mkdir -p "$VAULT_DIR"
TODAY=$(date +%Y%m%d)
NOW=$(date +%Y-%m-%dT%H:%M:%S)
TODAY_DASH=$(date +%Y-%m-%d)

SEQ=1
while [ -f "$VAULT_DIR/${TYPE}-${TODAY}-$(printf '%03d' $SEQ).md" ]; do
  SEQ=$((SEQ + 1))
done
SEQ_STR=$(printf '%03d' $SEQ)
ID="${TYPE}-${TODAY}-${SEQ_STR}"

# Sanitize prompt for vault (first 300 chars, no secrets)
PROMPT_SHORT=$(echo "$PROMPT" | head -c 300 | sed 's/[`]/\\`/g')

if [ "$TYPE" = "LRN" ]; then
  cat > "$VAULT_DIR/$ID.md" << ENTRY
---
id: $ID
logged: $NOW
type: learning
priority: medium
status: new
category: $CATEGORY
area: general
agent: main
project: general
pattern-key: user-correction
recurrence-count: 1
first-seen: $TODAY_DASH
last-seen: $TODAY_DASH
tags: [auto-captured, correction]
related: []
---

# $TITLE

$BODY_HEADER
$BODY_CONTENT

## User said
> $PROMPT_SHORT

$BODY_SECTION
$BODY_INSIGHT

## Why it matters
Corrections indicate knowledge gaps or bad habits that need fixing.
ENTRY
else
  cat > "$VAULT_DIR/$ID.md" << ENTRY
---
id: $ID
logged: $NOW
type: feature
status: requested
complexity: medium
area: general
agent: main
project: general
pattern-key: user-feature-request
recurrence-count: 1
first-seen: $TODAY_DASH
last-seen: $TODAY_DASH
tags: [auto-captured, feature-request]
related: []
---

# $TITLE

$BODY_HEADER
$BODY_CONTENT

## User said
> $PROMPT_SHORT

$BODY_SECTION
$BODY_INSIGHT

## Skill candidate
Maybe — evaluate after implementation.
ENTRY
fi

echo "[SELF-IMPROVE] Auto-logged to vault/learnings/$ID.md — Update this entry with specifics as you process the user's request."
exit 0
