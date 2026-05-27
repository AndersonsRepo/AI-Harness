#!/usr/bin/env python3
"""Hook: TaskCompleted
Fires when a teammate marks a task as complete in an Agent Teams session.
Enforces quality standards, review gate for builder tasks, and notifies Discord.
"""

import json
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
from hook_common import coerce_name, get_value, payload_shape, resolve_harness_root

HARNESS_ROOT = resolve_harness_root(SCRIPT_DIR)
NOTIFY_FILE = HARNESS_ROOT / "heartbeat-tasks" / "pending-notifications.jsonl"

# Quality check patterns
TODO_PATTERN = re.compile(r"\b(TODO|FIXME|HACK|XXX)\b", re.I)
BARE_CATCH = re.compile(r"catch\s*\(\s*\)\s*\{?\s*\}", re.I)
PLACEHOLDER = re.compile(r"(placeholder|lorem ipsum|example\.com)", re.I)

# Builder agent name patterns (builder, builder-1, builder-2, etc.)
BUILDER_RE = re.compile(r"^builder(-\d+)?$", re.I)


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


def check_review_gate(teammate_name: str, task_description: str) -> str | None:
    """Enforce review gate: builder tasks need a reviewer follow-up."""
    if not BUILDER_RE.match(teammate_name):
        return None

    # Builder completed a task — remind lead to ensure review exists
    return (
        f"Builder teammate '{teammate_name}' completed an implementation task. "
        "REVIEW GATE: Ensure a dependent reviewer task exists for this work. "
        "In the Discord bot, this is auto-enforced by infrastructure. "
        "In Agent Teams, you must create or verify a reviewer task depends on this builder task. "
        "If no reviewer teammate is active, consider spawning one."
    )


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
        ("assignee",),
        ("task", "assignee"),
    )) or "unknown"
    task_description = get_value(
        hook_input,
        ("task_description",),
        ("task", "description"),
        ("task", "task_description"),
        ("task", "title"),
        ("description",),
    ) or ""
    task_result = get_value(
        hook_input,
        ("task_result",),
        ("result",),
        ("task", "result"),
        ("task", "output"),
    ) or ""

    # Run quality checks
    issues = check_quality(task_result)

    # Check review gate for builder tasks
    review_reminder = check_review_gate(teammate_name, task_description)

    # Build response
    context_parts = []

    if issues:
        context_parts.append(
            "Quality check found potential issues:\n"
            + "\n".join(f"  - {issue}" for issue in issues)
        )

    if review_reminder:
        context_parts.append(review_reminder)

    response = {}
    if context_parts:
        response["hookSpecificOutput"] = {
            "hookEventName": "TaskCompleted",
            "additionalContext": "\n\n".join(context_parts),
        }

    # Notify Discord on task completion for visibility
    task_short = (task_description[:80] + "...") if len(task_description) > 80 else task_description
    status = "with warnings" if issues else "successfully"
    diagnostic = (
        f" (payload shape: {payload_shape(hook_input)})"
        if teammate_name == "unknown" or not task_description
        else ""
    )
    notify(
        "agent-stream",
        f"[Agent Teams] **{teammate_name}** completed task {status}: {task_short}{diagnostic}",
    )

    if response:
        print(json.dumps(response))


if __name__ == "__main__":
    main()
