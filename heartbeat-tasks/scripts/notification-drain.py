#!/usr/bin/env python3
"""Notification drain is now handled by the Discord bot directly.

The bot polls pending-notifications.jsonl every 60 seconds via its
built-in drainNotifications() function in bot.ts.

This script exists only as a fallback — it checks if notifications
are piling up (bot might be down) and logs a warning.
"""

import os
import json

HARNESS_ROOT = os.environ.get("HARNESS_ROOT", "$HOME/.local/ai-harness")
NOTIFY_FILE = os.path.join(HARNESS_ROOT, "heartbeat-tasks", "pending-notifications.jsonl")


def main():
    if not os.path.exists(NOTIFY_FILE):
        print("No pending notifications — drain is clean")
        return

    with open(NOTIFY_FILE) as f:
        lines = [l.strip() for l in f.readlines() if l.strip()]

    if not lines:
        print("Notification file exists but is empty")
        os.remove(NOTIFY_FILE)
        return

    # If notifications are piling up, the bot might be down
    print(f"WARNING: {len(lines)} pending notification(s) not drained by bot")
    for line in lines:
        try:
            notif = json.loads(line)
            print(f"  - {notif.get('task', '?')} @ {notif.get('timestamp', '?')[:16]}")
        except json.JSONDecodeError:
            pass

    print("The Discord bot should drain these automatically every 60s.")
    print("If they persist, check bot health with /heartbeat logs health-check")


if __name__ == "__main__":
    main()
