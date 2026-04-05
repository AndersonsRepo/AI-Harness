#!/usr/bin/env python3
"""Hook: TaskCreated
Fires when a task is created in an Agent Teams session.
Logs task creation to Discord #agent-stream for visibility.
"""

import json
import os
import sys
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
    try:
        hook_input = json.load(sys.stdin)
    except Exception:
        hook_input = {}

    task_description = hook_input.get("task_description", "")
    assignee = hook_input.get("assignee", "unassigned")

    task_short = (task_description[:100] + "...") if len(task_description) > 100 else task_description

    notify(
        "agent-stream",
        f"[Agent Teams] Task created → **{assignee}**: {task_short}",
    )

    print(json.dumps({"suppressOutput": True}))


if __name__ == "__main__":
    main()
