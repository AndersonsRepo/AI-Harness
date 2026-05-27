#!/usr/bin/env python3
"""Write a notification to pending-notifications.jsonl safely.

Usage:
    python3 heartbeat-tasks/scripts/send-notification.py --channel <channel> --source <source> --message <message>
    echo "multi-line message" | python3 heartbeat-tasks/scripts/send-notification.py --channel <channel> --source <source>

Handles multi-line messages correctly by using json.dumps() to escape newlines.
"""

import argparse
import json
import os
import sys
from datetime import datetime

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
NOTIFY_FILE = os.path.join(HARNESS_ROOT, "heartbeat-tasks", "pending-notifications.jsonl")


def main():
    parser = argparse.ArgumentParser(description="Write a notification safely")
    parser.add_argument("--channel", required=True, help="Discord channel name")
    parser.add_argument("--source", required=True, help="Source task name")
    parser.add_argument("--message", help="Notification message (or pipe via stdin)")
    args = parser.parse_args()

    message = args.message
    if not message:
        if not sys.stdin.isatty():
            message = sys.stdin.read().strip()
        else:
            print("Error: provide --message or pipe text via stdin", file=sys.stderr)
            sys.exit(1)

    if not message:
        sys.exit(0)

    entry = {
        "task": args.source,
        "channel": args.channel,
        "summary": message,
        "timestamp": datetime.now().isoformat(),
    }

    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    print(f"Notification written to {args.channel}")


if __name__ == "__main__":
    main()
