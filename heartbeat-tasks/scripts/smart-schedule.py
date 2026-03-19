#!/usr/bin/env python3
"""Smart scheduling heartbeat — detects calendar gaps, suggests study blocks.

Runs every 3h during active hours (07:00-23:00).
1. Reads today + tomorrow events from Calendar.app via osascript
2. Finds free blocks of 1h+
3. Cross-references with Canvas assignments due within 3 days
4. Writes suggestions to pending-notifications.jsonl → #calendar
"""

import os
import sys
import json
import subprocess
import datetime
from pathlib import Path

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)

TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
NOTIFY_FILE = os.path.join(TASKS_DIR, "pending-notifications.jsonl")

# Load .env for CANVAS_ICAL_URL
_env_path = os.path.join(HARNESS_ROOT, "bridges", "discord", ".env")
if os.path.exists(_env_path):
    with open(_env_path) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _key, _val = _line.split("=", 1)
                if _key not in os.environ:
                    os.environ[_key] = _val

ICAL_URL = os.environ.get("CANVAS_ICAL_URL", "")


def notify(channel: str, message: str):
    """Append notification to pending-notifications.jsonl."""
    entry = {
        "task": "smart-schedule",
        "channel": channel,
        "summary": message,
        "timestamp": datetime.datetime.now().isoformat(),
    }
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")


def get_calendar_events(start: datetime.datetime, end: datetime.datetime) -> list[dict]:
    """Fetch events from Calendar.app via AppleScript."""
    script = f"""
on makeDate(y, m, d, h, mn, s)
    set dt to current date
    set year of dt to y
    set month of dt to m
    set day of dt to d
    set hours of dt to h
    set minutes of dt to mn
    set seconds of dt to s
    return dt
end makeDate

set startD to makeDate({start.year}, {start.month}, {start.day}, {start.hour}, {start.minute}, 0)
set endD to makeDate({end.year}, {end.month}, {end.day}, {end.hour}, {end.minute}, 0)

tell application "Calendar"
    set output to {{}}
    repeat with cal in calendars
        set calName to name of cal as text
        tell cal
            set evts to (every event whose start date >= startD and start date < endD)
            repeat with evt in evts
                try
                    set evtSummary to summary of evt as text
                    set evtStart to start date of evt as text
                    set evtEnd to end date of evt as text
                    set evtAllDay to allday event of evt as text
                    set end of output to (evtSummary & "||" & evtStart & "||" & evtEnd & "||" & evtAllDay & "||" & calName)
                end try
            end repeat
        end tell
    end repeat
    set AppleScript's text item delimiters to "%%REC%%"
    return output as text
end tell
"""
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            print(f"AppleScript error: {result.stderr.strip()}")
            return []
    except subprocess.TimeoutExpired:
        print("AppleScript timed out")
        return []

    events = []
    for line in result.stdout.strip().split("%%REC%%"):
        line = line.strip()
        if not line:
            continue
        parts = line.split("||")
        if len(parts) < 5:
            continue
        try:
            # Parse AppleScript date format: "Wednesday, March 19, 2026 at 3:00:00 PM"
            start_str = parts[1].strip().replace(" at ", " ")
            end_str = parts[2].strip().replace(" at ", " ")
            from dateutil import parser as dateparser
            evt_start = dateparser.parse(start_str)
            evt_end = dateparser.parse(end_str)
        except Exception:
            continue
        events.append({
            "summary": parts[0].strip(),
            "start": evt_start,
            "end": evt_end,
            "allDay": parts[3].strip() == "true",
            "calendar": parts[4].strip(),
        })
    return events


def find_free_blocks(
    events: list[dict],
    day_start: datetime.datetime,
    day_end: datetime.datetime,
    min_gap_minutes: int = 60,
) -> list[dict]:
    """Find free time blocks between events."""
    # Filter out all-day events and sort
    timed = sorted(
        [e for e in events if not e["allDay"]],
        key=lambda e: e["start"],
    )

    blocks = []
    cursor = day_start

    for evt in timed:
        if evt["start"] > cursor:
            gap = (evt["start"] - cursor).total_seconds() / 60
            if gap >= min_gap_minutes:
                blocks.append({
                    "start": cursor,
                    "end": evt["start"],
                    "minutes": int(gap),
                })
        if evt["end"] > cursor:
            cursor = evt["end"]

    # Check gap after last event
    if day_end > cursor:
        gap = (day_end - cursor).total_seconds() / 60
        if gap >= min_gap_minutes:
            blocks.append({
                "start": cursor,
                "end": day_end,
                "minutes": int(gap),
            })

    return blocks


def get_upcoming_assignments(days: int = 3) -> list[dict]:
    """Fetch upcoming Canvas assignments from ICS feed."""
    if not ICAL_URL:
        return []
    try:
        import urllib.request
        with urllib.request.urlopen(ICAL_URL, timeout=15) as resp:
            ics_text = resp.read().decode("utf-8")
    except Exception as e:
        print(f"Failed to fetch Canvas ICS: {e}")
        return []

    now = datetime.datetime.now()
    cutoff = now + datetime.timedelta(days=days)
    assignments = []

    # Simple ICS parsing for VEVENT blocks
    in_event = False
    event = {}
    for line in ics_text.splitlines():
        line = line.strip()
        if line == "BEGIN:VEVENT":
            in_event = True
            event = {}
        elif line == "END:VEVENT":
            in_event = False
            if "dtstart" in event and "summary" in event:
                try:
                    dt_str = event["dtstart"]
                    if "T" in dt_str:
                        dt = datetime.datetime.strptime(dt_str[:15], "%Y%m%dT%H%M%S")
                    else:
                        dt = datetime.datetime.strptime(dt_str[:8], "%Y%m%d")
                    if now <= dt <= cutoff:
                        assignments.append({
                            "summary": event["summary"],
                            "due": dt,
                        })
                except Exception:
                    pass
        elif in_event and ":" in line:
            key, _, val = line.partition(":")
            # Handle parameters like DTSTART;VALUE=DATE:20260320
            key = key.split(";")[0].lower()
            if key in ("summary", "dtstart", "dtend"):
                event[key] = val

    assignments.sort(key=lambda a: a["due"])
    return assignments


def main():
    now = datetime.datetime.now()

    # Today + tomorrow window
    today_start = now.replace(hour=8, minute=0, second=0, microsecond=0)
    if now.hour >= 8:
        today_start = now  # Don't suggest blocks in the past
    today_end = now.replace(hour=22, minute=0, second=0, microsecond=0)

    tomorrow = now + datetime.timedelta(days=1)
    tomorrow_start = tomorrow.replace(hour=8, minute=0, second=0, microsecond=0)
    tomorrow_end = tomorrow.replace(hour=22, minute=0, second=0, microsecond=0)

    # Fetch events for today + tomorrow
    events = get_calendar_events(today_start, tomorrow_end)
    print(f"Found {len(events)} calendar events")

    today_events = [e for e in events if e["start"].date() == now.date()]
    tomorrow_events = [e for e in events if e["start"].date() == tomorrow.date()]

    today_blocks = find_free_blocks(today_events, today_start, today_end)
    tomorrow_blocks = find_free_blocks(tomorrow_events, tomorrow_start, tomorrow_end)

    # Get upcoming assignments
    assignments = get_upcoming_assignments(days=3)
    print(f"Found {len(assignments)} upcoming assignments (next 3 days)")

    # Build notification
    parts = []

    if today_blocks:
        block_lines = []
        for b in today_blocks:
            block_lines.append(
                f"  {b['start'].strftime('%I:%M %p')} — {b['end'].strftime('%I:%M %p')} ({b['minutes']} min)"
            )
        parts.append(f"**Free blocks today:**\n" + "\n".join(block_lines))

    if tomorrow_blocks:
        block_lines = []
        for b in tomorrow_blocks[:5]:  # Limit to 5
            block_lines.append(
                f"  {b['start'].strftime('%I:%M %p')} — {b['end'].strftime('%I:%M %p')} ({b['minutes']} min)"
            )
        parts.append(f"**Free blocks tomorrow:**\n" + "\n".join(block_lines))

    if assignments:
        assignment_lines = []
        for a in assignments:
            due_str = a["due"].strftime("%a %b %d, %I:%M %p") if a["due"].hour > 0 else a["due"].strftime("%a %b %d")
            assignment_lines.append(f"  {a['summary']} — due {due_str}")
        parts.append(f"**Upcoming assignments (next 3 days):**\n" + "\n".join(assignment_lines))

    if not parts:
        print("No schedule suggestions to report")
        return

    message = "\n\n".join(parts)
    notify("calendar", message)
    print(f"Notification sent to #calendar")
    print(message)


if __name__ == "__main__":
    main()
