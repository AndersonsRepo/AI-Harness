#!/usr/bin/env python3
"""Hook: TeammateIdle
Fires when a teammate in an Agent Teams session goes idle.
Logs idle events and suggests reassignment for long stalls.
Notifies Discord #agent-stream for visibility.
"""

import json
import os
import sys
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
HARNESS_ROOT = Path(os.environ.get("HARNESS_ROOT", SCRIPT_DIR.parent.parent.parent))
NOTIFY_FILE = HARNESS_ROOT / "pending-notifications.jsonl"


def notify(channel: str, message: str):
    """Append notification for Discord drain."""
    try:
        with open(NOTIFY_FILE, "a") as f:
            f.write(json.dumps({"channel": channel, "message": message}) + "\n")
    except Exception:
        pass


def main():
    # Read hook input from stdin
    try:
        hook_input = json.load(sys.stdin)
    except Exception:
        hook_input = {}

    teammate_name = hook_input.get("teammate_name", "unknown")
    idle_seconds = hook_input.get("idle_seconds", 0)

    # Short idles are normal — only act on significant stalls
    if idle_seconds < 30:
        sys.exit(0)

    response = {}

    if idle_seconds >= 120:
        # Long stall — suggest reassignment
        response["hookSpecificOutput"] = {
            "hookEventName": "TeammateIdle",
            "additionalContext": (
                f"Teammate '{teammate_name}' has been idle for {idle_seconds}s. "
                "Consider: (1) sending them a status check message, "
                "(2) reassigning their current task to another teammate, or "
                "(3) shutting them down if their work is complete."
            ),
        }
        notify(
            "agent-stream",
            f"[Agent Teams] Teammate **{teammate_name}** idle for {idle_seconds}s — may need reassignment",
        )
    elif idle_seconds >= 30:
        # Medium stall — just inject context
        response["hookSpecificOutput"] = {
            "hookEventName": "TeammateIdle",
            "additionalContext": (
                f"Teammate '{teammate_name}' has been idle for {idle_seconds}s. "
                "They may be waiting for a dependency or stuck. "
                "Check if they need input or have a blocker."
            ),
        }

    if response:
        print(json.dumps(response))


if __name__ == "__main__":
    main()
