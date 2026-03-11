#!/usr/bin/env python3
"""Check Canvas iCal feed for events due in the next 3 days."""

import os
import sys
import json
import datetime
import re
import subprocess

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
NOTIFY_FILE = os.path.join(TASKS_DIR, "pending-notifications.jsonl")
ICAL_URL = os.environ.get(
    "CANVAS_ICAL_URL",
    "https://canvas.cpp.edu/feeds/calendars/user_QLrf3pCggBFhQ11G1idoAp7Qp1TmNY4OegHPAUe7.ics",
)


def notify(message):
    notification = {
        "task": "assignment-reminder",
        "channel": "general",
        "summary": message,
        "timestamp": datetime.datetime.now().isoformat(),
    }
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(notification) + "\n")


def parse_ical_datetime(dt_str):
    """Parse an iCal DTSTART/DTEND value."""
    dt_str = dt_str.strip()
    # Remove trailing Z and parse
    if dt_str.endswith("Z"):
        dt_str = dt_str[:-1]
    try:
        return datetime.datetime.strptime(dt_str[:15], "%Y%m%dT%H%M%S")
    except ValueError:
        try:
            return datetime.datetime.strptime(dt_str[:8], "%Y%m%d")
        except ValueError:
            return None


def fetch_and_parse():
    """Fetch iCal feed and return events due in next 3 days."""
    try:
        result = subprocess.run(
            ["curl", "-s", ICAL_URL],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            return None, f"curl failed: {result.stderr}"
        data = result.stdout
    except Exception as e:
        return None, str(e)

    now = datetime.datetime.now()
    window = now + datetime.timedelta(days=3)

    events = data.split("BEGIN:VEVENT")
    upcoming = []

    for ev in events[1:]:
        summary_match = re.search(r"SUMMARY:(.*)", ev)
        dtstart_match = re.search(r"DTSTART[^:]*:(.*)", ev)

        if not summary_match or not dtstart_match:
            continue

        name = summary_match.group(1).strip()
        dt = parse_ical_datetime(dtstart_match.group(1))

        if dt and now <= dt <= window:
            upcoming.append((dt, name))

    upcoming.sort(key=lambda x: x[0])
    return upcoming, None


def main():
    events, error = fetch_and_parse()

    if error:
        print(f"Error fetching Canvas feed: {error}", file=sys.stderr)
        return

    if not events:
        print("No Canvas events in the next 3 days")
        return

    lines = [f"Canvas events due in the next 3 days ({len(events)}):"]
    for dt, name in events:
        lines.append(f"  {dt.strftime('%a %b %d %I:%M %p')} — {name}")

    summary = "\n".join(lines)
    print(summary)
    notify(summary)


if __name__ == "__main__":
    main()
