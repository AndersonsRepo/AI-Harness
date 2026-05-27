#!/usr/bin/env python3
"""Hook: TeammateIdle
Fires when a teammate in an Agent Teams session goes idle.
Logs idle events and suggests reassignment for long stalls.
Notifies Discord #agent-stream for visibility.
"""

import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
from hook_common import coerce_name, get_value, payload_shape, resolve_harness_root

HARNESS_ROOT = resolve_harness_root(SCRIPT_DIR)
NOTIFY_FILE = HARNESS_ROOT / "heartbeat-tasks" / "pending-notifications.jsonl"


def notify(channel: str, message: str):
    """Append notification for Discord drain."""
    try:
        NOTIFY_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(NOTIFY_FILE, "a") as f:
            # Live drain (bot-v2 → DiscordTransport) reads the `summary` field and
            # resolves by exact channel name; include both for compatibility.
            f.write(json.dumps({"channel": channel, "summary": message, "message": message}) + "\n")
    except Exception:
        pass


def main():
    # Read hook input from stdin
    try:
        hook_input = json.load(sys.stdin)
    except Exception:
        hook_input = {}

    teammate_name = coerce_name(get_value(
        hook_input,
        ("teammate_name",),
        ("teammate",),
        ("agent",),
    )) or "unknown"
    idle_seconds = get_value(
        hook_input,
        ("idle_seconds",),
        ("idle", "seconds"),
        ("teammate", "idle_seconds"),
    ) or 0

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
                + (f" Payload shape: {payload_shape(hook_input)}." if teammate_name == "unknown" else "")
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
                + (f" Payload shape: {payload_shape(hook_input)}." if teammate_name == "unknown" else "")
            ),
        }

    if response:
        print(json.dumps(response))


if __name__ == "__main__":
    main()
