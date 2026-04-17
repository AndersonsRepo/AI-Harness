#!/usr/bin/env python3
"""UserPromptSubmit hook: nudge user to run /handoff when they mention starting fresh."""

import json
import re
import sys

PATTERNS = [
    r"start(?:ing)?\s+(?:a\s+)?new\s+session",
    r"start\s+fresh",
    r"new\s+chat",
    r"have\s+to\s+restart",
    r"compact\s+this",
    r"session\s+is\s+too\s+long",
]

COMBINED = re.compile("|".join(PATTERNS), re.IGNORECASE)

NUDGE = (
    "💡 Tip: Run `/handoff` before starting fresh — "
    "it extracts this session into a portable digest you can paste into the new one."
)

def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, Exception):
        return

    prompt = data.get("prompt", "") or data.get("user_prompt", "") or ""
    if COMBINED.search(prompt):
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": NUDGE,
            }
        }))

if __name__ == "__main__":
    main()
