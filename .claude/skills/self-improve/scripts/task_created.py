#!/usr/bin/env python3
"""Hook: TaskCreated
Fires when a task is created in an Agent Teams session.
Logs task creation to Discord #agent-stream for visibility.
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
    try:
        hook_input = json.load(sys.stdin)
    except Exception:
        hook_input = {}

    task_description = get_value(
        hook_input,
        ("task_description",),
        ("task", "description"),
        ("task", "task_description"),
        ("task", "title"),
        ("description",),
    ) or ""
    assignee = coerce_name(get_value(
        hook_input,
        ("assignee",),
        ("task", "assignee"),
        ("assigned_to",),
        ("task", "assigned_to"),
        ("teammate",),
        ("agent",),
    )) or "unassigned"

    task_short = (task_description[:100] + "...") if len(task_description) > 100 else task_description
    diagnostic = (
        f" (payload shape: {payload_shape(hook_input)})"
        if assignee == "unassigned" or not task_description
        else ""
    )

    notify(
        "agent-stream",
        f"[Agent Teams] Task created → **{assignee}**: {task_short}{diagnostic}",
    )

    print(json.dumps({"suppressOutput": True}))


if __name__ == "__main__":
    main()
