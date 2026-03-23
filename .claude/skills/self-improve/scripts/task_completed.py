#!/usr/bin/env python3
"""Hook: TaskCompleted
Fires when a teammate marks a task as complete in an Agent Teams session.
Enforces quality standards and notifies Discord for visibility.
"""

import json
import os
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
HARNESS_ROOT = Path(os.environ.get("HARNESS_ROOT", SCRIPT_DIR.parent.parent.parent))
NOTIFY_FILE = HARNESS_ROOT / "pending-notifications.jsonl"

# Quality check patterns
TODO_PATTERN = re.compile(r"\b(TODO|FIXME|HACK|XXX)\b", re.I)
BARE_CATCH = re.compile(r"catch\s*\(\s*\)\s*\{?\s*\}", re.I)
PLACEHOLDER = re.compile(r"(placeholder|lorem ipsum|example\.com)", re.I)


def notify(channel: str, message: str):
    """Append notification for Discord drain."""
    try:
        with open(NOTIFY_FILE, "a") as f:
            f.write(json.dumps({"channel": channel, "message": message}) + "\n")
    except Exception:
        pass


def check_quality(task_result: str) -> list[str]:
    """Run lightweight quality checks on the task result text."""
    issues = []
    if TODO_PATTERN.search(task_result):
        issues.append("Task result contains TODO/FIXME/HACK markers — ensure all work is complete")
    if BARE_CATCH.search(task_result):
        issues.append("Code contains empty catch blocks — errors should be handled or logged")
    if PLACEHOLDER.search(task_result):
        issues.append("Result may contain placeholder text — verify all values are real")
    return issues


def main():
    # Read hook input from stdin
    try:
        hook_input = json.load(sys.stdin)
    except Exception:
        hook_input = {}

    teammate_name = hook_input.get("teammate_name", "unknown")
    task_description = hook_input.get("task_description", "")
    task_result = hook_input.get("task_result", "")

    # Run quality checks
    issues = check_quality(task_result)

    response = {}

    if issues:
        feedback = "Quality check found potential issues:\n" + "\n".join(
            f"  - {issue}" for issue in issues
        )
        response["hookSpecificOutput"] = {
            "hookEventName": "TaskCompleted",
            "additionalContext": feedback,
        }

    # Notify Discord on task completion for visibility
    task_short = (task_description[:80] + "...") if len(task_description) > 80 else task_description
    status = "with warnings" if issues else "successfully"
    notify(
        "agent-stream",
        f"[Agent Teams] **{teammate_name}** completed task {status}: {task_short}",
    )

    if response:
        print(json.dumps(response))


if __name__ == "__main__":
    main()
