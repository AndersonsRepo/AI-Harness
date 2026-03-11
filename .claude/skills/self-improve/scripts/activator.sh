#!/bin/bash
# Hook: UserPromptSubmit
# Lightweight nudge reminding the agent to evaluate learnings after interactions.
# Outputs a short system message that gets injected into context (~50 tokens).

PROMPT="$1"

# Detect correction patterns in user input
if echo "$PROMPT" | grep -qiE "(no,? that'?s (wrong|not)|actually[,.]|not like that|that'?s incorrect|you'?re wrong|wrong approach|that doesn'?t work|fix this|you made a mistake|you forgot)"; then
  echo '[SELF-IMPROVE] Correction detected in user message. Log this as a learning (category: correction) in vault/learnings/ following the SKILL.md template before proceeding.'
  exit 0
fi

# Detect feature request patterns
if echo "$PROMPT" | grep -qiE "(i wish you could|can you also|is there a way to|it would be nice if|can you learn to|add a feature|I need you to be able to)"; then
  echo '[SELF-IMPROVE] Feature request detected. Log this in vault/learnings/ as a FEAT entry following the SKILL.md template before proceeding.'
  exit 0
fi

# No special pattern detected — silent exit (no token cost)
exit 0
