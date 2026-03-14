#!/usr/bin/env python3
"""Generate a launchd plist for a heartbeat task.

Usage: python3 generate-plist.py <task-name> [--install]

Reads heartbeat-tasks/<task-name>.json and generates/installs the plist.
Supports both interval-based (schedule field) and cron-based (cron field) scheduling.
"""

import json
import os
import re
import subprocess
import sys

HOME = os.path.expanduser("~")
HARNESS_SYMLINK = os.path.join(HOME, ".local", "ai-harness")
PLIST_DIR = os.path.join(HOME, "Library", "LaunchAgents")
HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")


def parse_schedule_to_seconds(schedule: str) -> int:
    """Parse schedule string like '30m', '2h', '168h' to seconds."""
    m = re.match(r"^(\d+)(m|h)$", schedule.strip())
    if not m:
        raise ValueError(f"Invalid schedule format: {schedule} (expected e.g. '30m' or '2h')")
    value, unit = int(m.group(1)), m.group(2)
    return value * 60 if unit == "m" else value * 3600


def expand_range(s: str) -> list[int]:
    """Expand cron range like '1-5' to [1,2,3,4,5], or '*/6' to step values."""
    if s == "*":
        return []
    if s.startswith("*/"):
        # Step values — return empty (handled differently in launchd)
        return []
    parts = []
    for segment in s.split(","):
        if "-" in segment:
            start, end = segment.split("-", 1)
            parts.extend(range(int(start), int(end) + 1))
        else:
            parts.append(int(segment))
    return parts


def cron_to_calendar_intervals(cron_expr: str) -> list[dict]:
    """Convert a cron expression to launchd StartCalendarInterval dict(s).

    Format: minute hour day-of-month month day-of-week
    Supports: specific values, ranges (1-5), lists (1,3,5), * (any)
    Does NOT support: */N step notation (use interval scheduling instead)
    """
    fields = cron_expr.strip().split()
    if len(fields) != 5:
        raise ValueError(f"Cron expression must have 5 fields: '{cron_expr}'")

    minute_str, hour_str, dom_str, month_str, dow_str = fields

    # Parse each field
    minutes = expand_range(minute_str)
    hours = expand_range(hour_str)
    doms = expand_range(dom_str)
    months = expand_range(month_str)
    dows = expand_range(dow_str)

    # Build base dict with non-wildcard fields
    base = {}
    if len(minutes) == 1:
        base["Minute"] = minutes[0]
    if len(hours) == 1:
        base["Hour"] = hours[0]
    if len(doms) == 1:
        base["Day"] = doms[0]
    if len(months) == 1:
        base["Month"] = months[0]

    # If day-of-week has multiple values, create one dict per weekday
    if len(dows) > 1:
        intervals = []
        for dow in dows:
            entry = {**base, "Weekday": dow}
            intervals.append(entry)
        return intervals
    elif len(dows) == 1:
        base["Weekday"] = dows[0]

    # If multiple minutes or hours, create combinations
    if len(minutes) > 1:
        intervals = []
        for m in minutes:
            entry = {**base, "Minute": m}
            intervals.append(entry)
        return intervals

    if len(hours) > 1:
        intervals = []
        for h in hours:
            entry = {**base, "Hour": h}
            intervals.append(entry)
        return intervals

    return [base] if base else [{}]


def dict_to_plist_xml(d: dict, indent: int = 2) -> str:
    """Convert a dict to plist XML dict entries."""
    pad = "    " * indent
    lines = []
    for key, value in d.items():
        lines.append(f"{pad}<key>{key}</key>")
        lines.append(f"{pad}<integer>{value}</integer>")
    return "\n".join(lines)


def generate_plist(task_name: str) -> str:
    """Generate plist XML for a heartbeat task."""
    config_path = os.path.join(TASKS_DIR, f"{task_name}.json")
    with open(config_path) as f:
        config = json.load(f)

    label = f"com.aiharness.heartbeat.{task_name}"
    log_path = f"{HARNESS_SYMLINK}/heartbeat-tasks/logs/{task_name}.log"

    # Determine scheduling — support multiple config formats
    cron_expr = config.get("cron")
    schedule = config.get("schedule")
    interval_minutes = config.get("interval_minutes")

    # Convert interval_minutes to schedule string if present
    if not schedule and interval_minutes:
        mins = int(interval_minutes)
        schedule = f"{mins // 60}h" if mins >= 60 and mins % 60 == 0 else f"{mins}m"

    if cron_expr:
        intervals = cron_to_calendar_intervals(cron_expr)
        if len(intervals) == 1:
            schedule_xml = f"""    <key>StartCalendarInterval</key>
    <dict>
{dict_to_plist_xml(intervals[0])}
    </dict>"""
        else:
            entries = []
            for interval in intervals:
                entries.append(f"        <dict>\n{dict_to_plist_xml(interval, 3)}\n        </dict>")
            schedule_xml = f"""    <key>StartCalendarInterval</key>
    <array>
{chr(10).join(entries)}
    </array>"""
    elif schedule:
        seconds = parse_schedule_to_seconds(schedule)
        schedule_xml = f"""    <key>StartInterval</key>
    <integer>{seconds}</integer>"""
    else:
        raise ValueError(f"Task {task_name} has neither 'schedule' nor 'cron' field")

    plist = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>

    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/python3</string>
        <string>{HARNESS_SYMLINK}/heartbeat-tasks/heartbeat-runner.py</string>
        <string>{task_name}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>{HARNESS_SYMLINK}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>{HOME}</string>
    </dict>

{schedule_xml}

    <key>RunAtLoad</key>
    <false/>

    <key>StandardOutPath</key>
    <string>{log_path}</string>

    <key>StandardErrorPath</key>
    <string>{log_path}</string>

    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
"""
    return plist


def main():
    if len(sys.argv) < 2:
        print("Usage: generate-plist.py <task-name> [--install]")
        sys.exit(1)

    task_name = sys.argv[1]
    install = "--install" in sys.argv

    plist_xml = generate_plist(task_name)
    plist_path = os.path.join(PLIST_DIR, f"com.aiharness.heartbeat.{task_name}.plist")

    if install:
        # Unload if already loaded
        subprocess.run(["launchctl", "unload", plist_path], capture_output=True)
        # Write plist
        with open(plist_path, "w") as f:
            f.write(plist_xml)
        # Load
        result = subprocess.run(["launchctl", "load", plist_path], capture_output=True, text=True)
        if result.returncode == 0:
            print(f"Installed and loaded: {plist_path}")
        else:
            print(f"Written but load failed: {result.stderr}", file=sys.stderr)
            sys.exit(1)
    else:
        print(plist_xml)


if __name__ == "__main__":
    main()
