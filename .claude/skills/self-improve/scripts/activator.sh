#!/bin/bash
# Hook: UserPromptSubmit
# Auto-captures learnings, corrections, feature requests, decisions,
# preferences, and external knowledge to vault/learnings/

PROMPT="$1"
HARNESS_ROOT="${HARNESS_ROOT:-$HOME/Desktop/AI-Harness}"
VAULT_DIR="$HARNESS_ROOT/vault/learnings"

TYPE=""
CATEGORY=""
TAGS=""

# --- 1. Corrections (highest priority) ---
if echo "$PROMPT" | grep -qiE "(no,? that.?s (wrong|not)|actually[,.]|not like that|that.?s incorrect|you.?re wrong|wrong approach|that doesn.?t work|you made a mistake|you forgot|stop doing that|don.?t do that|I told you|that.?s not (right|how|what))"; then
  TYPE="LRN"
  CATEGORY="correction"
  TAGS="[auto-captured, correction]"

# --- 2. Preferences & permanent instructions ---
elif echo "$PROMPT" | grep -qiE "(always (do|use|make|run|put)|never (do|use|make|run|put)|from now on|going forward|remember (that|to)|don.?t ever|stop (using|doing)|prefer (to|using)|I like (it|when|to)|make sure you always|default to)"; then
  TYPE="LRN"
  CATEGORY="preference"
  TAGS="[auto-captured, preference, permanent]"

# --- 3. Architecture decisions ---
elif echo "$PROMPT" | grep -qiE "(let.?s (use|go with|keep|put|make|build|create|set up)|instead of|keep (them|it|this) separate|should (be|go|live|run) (in|on|at|under)|put (it|them|this) in|move (it|them|this) to|we.?ll use|the approach should be|let.?s not use)"; then
  TYPE="LRN"
  CATEGORY="decision"
  TAGS="[auto-captured, architecture, decision]"

# --- 4. External knowledge / factual info ---
elif echo "$PROMPT" | grep -qiE "(the repo is|it.?s called|the url is|the api is|the (path|port|endpoint|domain|server) is|it lives (at|in)|it runs on|it.?s (hosted|deployed) (on|at)|the stack is|it uses)"; then
  TYPE="LRN"
  CATEGORY="external_knowledge"
  TAGS="[auto-captured, factual, project-context]"

# --- 5. Feature requests ---
elif echo "$PROMPT" | grep -qiE "(i wish you could|can you also|is there a way to|it would be nice if|can you learn to|add a feature|I need you to be able to|we should add|we need|can we (add|build|create|set up|hook up|wire up)|would be (useful|cool|nice|great) (to|if))"; then
  TYPE="FEAT"
  CATEGORY="feature_request"
  TAGS="[auto-captured, feature-request]"

# --- 6. Bug reports / something broken ---
elif echo "$PROMPT" | grep -qiE "(is (broken|not working|down|failing|crashing)|doesn.?t (work|load|start|connect|respond)|why (is it|isn.?t|does it|won.?t)|it (keeps|just) (failing|crashing|hanging|timing out)|something.?s wrong|can you fix|debug this|what happened to)"; then
  TYPE="ERR"
  CATEGORY="user_reported_bug"
  TAGS="[auto-captured, bug-report, user-reported]"

else
  # No special pattern -- silent exit
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

# Sanitize prompt (first 300 chars, redact secrets)
PROMPT_SHORT=$(echo "$PROMPT" | head -c 300 | sed 's/`/\\`/g' | sed -E 's/(key|token|password|secret)[[:space:]]*[:=][[:space:]]*[^ ]+/\1=REDACTED/gi')

# Compute "why it matters" before the heredoc
case "$CATEGORY" in
  correction) WHY="Corrections indicate knowledge gaps or bad habits that need fixing.";;
  preference) WHY="User preferences should be remembered permanently to avoid repeating mistakes.";;
  decision) WHY="Architecture decisions shape the system and should be documented for consistency.";;
  external_knowledge) WHY="Factual information about projects/services prevents future confusion.";;
  *) WHY="Captured for future reference.";;
esac

if [ "$TYPE" = "LRN" ]; then
  cat > "$VAULT_DIR/$ID.md" <<ENTRY
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
pattern-key: auto-${CATEGORY}
recurrence-count: 1
first-seen: $TODAY_DASH
last-seen: $TODAY_DASH
tags: $TAGS
related: []
---

# ${CATEGORY}: auto-captured

## User said
> $PROMPT_SHORT

## What was learned
(Claude should fill this in after processing the user's message)

## Why it matters
$WHY
ENTRY

elif [ "$TYPE" = "FEAT" ]; then
  cat > "$VAULT_DIR/$ID.md" <<ENTRY
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
tags: $TAGS
related: []
---

# Feature request: auto-captured

## User said
> $PROMPT_SHORT

## Requested capability
(Claude should fill this in after processing the user's message)

## Skill candidate
Maybe -- evaluate after implementation.
ENTRY

elif [ "$TYPE" = "ERR" ]; then
  cat > "$VAULT_DIR/$ID.md" <<ENTRY
---
id: $ID
logged: $NOW
type: error
severity: medium
status: new
category: $CATEGORY
area: general
agent: main
project: general
pattern-key: user-reported-bug
recurrence-count: 1
first-seen: $TODAY_DASH
last-seen: $TODAY_DASH
tags: $TAGS
related: []
---

# Bug report: auto-captured

## User said
> $PROMPT_SHORT

## Root Cause
(Claude should fill this in after investigating)

## Fix
(Claude should fill this in after resolving)
ENTRY
fi

echo "[SELF-IMPROVE] Auto-logged to vault/learnings/$ID.md -- Update this entry with specifics as you process the user's request."
exit 0
