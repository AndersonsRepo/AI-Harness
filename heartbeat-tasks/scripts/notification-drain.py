#!/usr/bin/env python3
"""Notification drain is now handled by the Discord bot directly.

The bot polls pending-notifications.jsonl every 60 seconds via its
built-in drainNotifications() function in bot.ts.

This script exists only as a fallback — it checks if notifications
are piling up (bot might be down) and logs a warning.
"""

import os
import json

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
NOTIFY_FILES = [
    os.path.join(HARNESS_ROOT, "heartbeat-tasks", "pending-notifications.jsonl"),
    os.path.join(HARNESS_ROOT, "pending-notifications.jsonl"),
]


def main():
    total = 0
    for notify_file in NOTIFY_FILES:
        if not os.path.exists(notify_file):
            continue

        with open(notify_file) as f:
            lines = [l.strip() for l in f.readlines() if l.strip()]

        if not lines:
            os.remove(notify_file)
            continue

        total += len(lines)
        print(f"WARNING: {len(lines)} pending notification(s) in {notify_file}")
        for line in lines:
            try:
                notif = json.loads(line)
                task = notif.get("task") or notif.get("source", "?")
                ts = notif.get("timestamp", "?")[:16] if notif.get("timestamp") else "?"
                print(f"  - {task} @ {ts}")
            except json.JSONDecodeError:
                pass

    if total == 0:
        print("No pending notifications — drain is clean")
    else:
        print(f"\n{total} total pending. The Discord bot should drain these every 60s.")
        print("If they persist, check bot health with /heartbeat logs health-check")


if __name__ == "__main__":
    main()
