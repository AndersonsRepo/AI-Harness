#!/usr/bin/env python3
"""Enhanced Canvas assignment reminder with course routing, quiz study guides, and homework help.

Features:
1. Daily morning summary → #calendar (overview of all upcoming events)
2. Course-specific notifications → #numerical-methods, #philosophy, etc.
3. Quiz detection → spawns education agent for study guide generation
4. Homework helper → posts scaffolded guidance for upcoming assignments

Runs daily at 8:00 AM via launchd.
"""

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
STATE_FILE = os.path.join(TASKS_DIR, "assignment-reminder.state.json")
ICAL_URL = os.environ.get("CANVAS_ICAL_URL", "")
if not ICAL_URL:
    print("CANVAS_ICAL_URL not set — skipping")
    sys.exit(0)

# Canvas course code → Discord channel + display name
COURSE_MAP = {
    "26S_CS3010": {
        "channel": "numerical-methods",
        "display": "Numerical Methods",
        "vault_dir": "numerical-methods",
    },
    "26S_PHL2010": {
        "channel": "philosophy",
        "display": "Intro to Philosophy",
        "vault_dir": "philosophy",
    },
    "26S_CS3750W": {
        "channel": "comp-society",
        "display": "Computers and Society",
        "vault_dir": "comp-society",
    },
    "26S_CS2600": {
        "channel": "systems-programming",
        "display": "Systems Programming",
        "vault_dir": "systems-programming",
    },
}

# Patterns that indicate a quiz or exam
QUIZ_PATTERNS = re.compile(
    r"\b(quiz|q\s*\d|exam|midterm|final|test|blue\s*book)\b", re.IGNORECASE
)

# Patterns that indicate homework/assignments (not quizzes)
HOMEWORK_PATTERNS = re.compile(
    r"\b(assignment|homework|hw|problem set|lab|project|paper|proposal|discussion|db\s)\b",
    re.IGNORECASE,
)


def notify(message, channel="calendar", task="assignment-reminder"):
    """Write a notification to pending-notifications.jsonl."""
    notification = {
        "task": task,
        "channel": channel,
        "summary": message,
        "timestamp": datetime.datetime.now().isoformat(),
    }
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(notification) + "\n")


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"notified_events": {}, "study_guides_generated": []}


def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def parse_ical_datetime(dt_str):
    """Parse an iCal DTSTART/DTEND value."""
    dt_str = dt_str.strip()
    if dt_str.endswith("Z"):
        dt_str = dt_str[:-1]
    try:
        return datetime.datetime.strptime(dt_str[:15], "%Y%m%dT%H%M%S")
    except ValueError:
        try:
            return datetime.datetime.strptime(dt_str[:8], "%Y%m%d")
        except ValueError:
            return None


def extract_course(summary):
    """Extract course code from Canvas summary like 'Q 2 [26S_PHL2010.04-1]'."""
    match = re.search(r"\[(\w+_\w+)", summary)
    if match:
        raw_code = match.group(1)
        # Match against COURSE_MAP keys (prefix match to handle section numbers)
        for code_prefix, info in COURSE_MAP.items():
            if raw_code.startswith(code_prefix):
                return code_prefix, info
    return None, None


def extract_event_name(summary):
    """Get the assignment/event name without the course code bracket."""
    return re.sub(r"\s*\[.*?\]\s*$", "", summary).strip()


def fetch_all_events():
    """Fetch iCal feed and return all future events within 7 days."""
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
    window = now + datetime.timedelta(days=7)

    raw_events = data.split("BEGIN:VEVENT")
    upcoming = []

    for ev in raw_events[1:]:
        summary_match = re.search(r"SUMMARY:(.*)", ev)
        dtstart_match = re.search(r"DTSTART[^:]*:(.*)", ev)
        desc_match = re.search(r"DESCRIPTION:(.*?)(?=\n[A-Z])", ev, re.DOTALL)

        if not summary_match or not dtstart_match:
            continue

        name = summary_match.group(1).strip()
        dt = parse_ical_datetime(dtstart_match.group(1))
        description = desc_match.group(1).strip() if desc_match else ""
        # Clean up iCal line folding
        description = re.sub(r"\n ", "", description)

        if dt and now <= dt <= window:
            course_code, course_info = extract_course(name)
            event_name = extract_event_name(name)
            upcoming.append({
                "dt": dt,
                "name": event_name,
                "full_summary": name,
                "course_code": course_code,
                "course_info": course_info,
                "description": description,
                "is_quiz": bool(QUIZ_PATTERNS.search(event_name)),
                "is_homework": bool(HOMEWORK_PATTERNS.search(event_name)),
            })

    upcoming.sort(key=lambda x: x["dt"])
    return upcoming, None


def generate_morning_summary(events):
    """Build the daily morning summary for #calendar."""
    today = datetime.datetime.now().date()

    # Group by day
    by_day = {}
    for ev in events:
        day = ev["dt"].date()
        delta = (day - today).days
        if delta == 0:
            label = "Today"
        elif delta == 1:
            label = "Tomorrow"
        else:
            label = ev["dt"].strftime("%A %b %d")
        by_day.setdefault(label, []).append(ev)

    lines = ["**Good morning! Here's your week ahead:**\n"]

    for label, day_events in by_day.items():
        lines.append(f"**{label}**")
        for ev in day_events:
            time_str = ev["dt"].strftime("%I:%M %p").lstrip("0")
            course_tag = f" [{ev['course_info']['display']}]" if ev["course_info"] else ""
            icon = ""
            if ev["is_quiz"]:
                icon = "QUIZ: "
            elif ev["is_homework"]:
                icon = "DUE: "
            lines.append(f"  {icon}{ev['name']} — {time_str}{course_tag}")
        lines.append("")

    # Count urgent items
    urgent = [e for e in events if (e["dt"].date() - today).days <= 1]
    if urgent:
        quiz_count = sum(1 for e in urgent if e["is_quiz"])
        hw_count = sum(1 for e in urgent if e["is_homework"])
        if quiz_count:
            lines.append(f"**Heads up:** {quiz_count} quiz{'es' if quiz_count > 1 else ''} in the next 48h!")
        if hw_count:
            lines.append(f"**Due soon:** {hw_count} assignment{'s' if hw_count > 1 else ''} in the next 48h")

    return "\n".join(lines)


def generate_course_notification(course_info, course_events):
    """Build a notification for a specific course channel."""
    lines = [f"**Upcoming for {course_info['display']}:**\n"]
    for ev in course_events:
        time_str = ev["dt"].strftime("%a %b %d %I:%M %p").lstrip("0")
        icon = ""
        if ev["is_quiz"]:
            icon = "QUIZ "
        elif ev["is_homework"]:
            icon = "DUE "
        lines.append(f"  {icon}**{ev['name']}** — {time_str}")
        if ev["description"]:
            # Truncate long descriptions
            desc = ev["description"][:200]
            if len(ev["description"]) > 200:
                desc += "..."
            lines.append(f"    {desc}")
    return "\n".join(lines)


def generate_study_guide(event, course_info):
    """Spawn Claude to generate a study guide for an upcoming quiz."""
    vault_dir = os.path.join(
        HARNESS_ROOT, "vault", "shared", "course-notes", course_info["vault_dir"]
    )

    # List available notes for context
    notes_list = []
    if os.path.isdir(vault_dir):
        for f in sorted(os.listdir(vault_dir)):
            if f.endswith(".md"):
                notes_list.append(f)

    notes_context = ", ".join(notes_list[-10:]) if notes_list else "no notes found"

    prompt = (
        f"Anderson has a quiz coming up:\n"
        f"  Course: {course_info['display']}\n"
        f"  Quiz: {event['name']}\n"
        f"  Date: {event['dt'].strftime('%A %B %d at %I:%M %p')}\n"
        f"  Description: {event['description'][:500]}\n\n"
        f"Recent course notes in vault: {notes_context}\n\n"
        f"Generate a concise study guide for this quiz. Structure it as:\n"
        f"1. **Key Concepts** — the must-know topics (check vault notes first)\n"
        f"2. **Quick Review** — 1-2 sentence summaries of each key concept\n"
        f"3. **Practice Questions** — 5 questions in the style of this course\n"
        f"4. **Tips** — study strategies for the time remaining\n\n"
        f"Keep it under 1500 characters. Be direct and focused."
    )

    try:
        result = subprocess.run(
            [
                "claude", "-p",
                "--model", "sonnet",
                "--max-turns", "3",
                "--dangerously-skip-permissions",
                "--", prompt,
            ],
            capture_output=True, text=True, timeout=120,
            env={k: v for k, v in os.environ.items() if not k.startswith("CLAUDE")},
        )
        if result.returncode == 0 and result.stdout.strip():
            # Parse JSON output
            try:
                output = json.loads(result.stdout)
                return output.get("result", result.stdout.strip())
            except json.JSONDecodeError:
                return result.stdout.strip()
    except Exception as e:
        print(f"Study guide generation failed: {e}", file=sys.stderr)

    return None


def generate_homework_help(event, course_info):
    """Spawn Claude to generate homework scaffolding for an upcoming assignment."""
    prompt = (
        f"Anderson has an assignment due soon:\n"
        f"  Course: {course_info['display']}\n"
        f"  Assignment: {event['name']}\n"
        f"  Due: {event['dt'].strftime('%A %B %d at %I:%M %p')}\n"
        f"  Description: {event['description'][:500]}\n\n"
        f"Give a brief, actionable breakdown to help him get started:\n"
        f"1. **What's being asked** — restate the core task in plain language\n"
        f"2. **Approach** — 3-4 concrete steps to complete it\n"
        f"3. **Watch out for** — common pitfalls for this type of work\n\n"
        f"Keep it under 800 characters. Be direct, no filler."
    )

    try:
        result = subprocess.run(
            [
                "claude", "-p",
                "--model", "sonnet",
                "--max-turns", "3",
                "--dangerously-skip-permissions",
                "--", prompt,
            ],
            capture_output=True, text=True, timeout=120,
            env={k: v for k, v in os.environ.items() if not k.startswith("CLAUDE")},
        )
        if result.returncode == 0 and result.stdout.strip():
            try:
                output = json.loads(result.stdout)
                return output.get("result", result.stdout.strip())
            except json.JSONDecodeError:
                return result.stdout.strip()
    except Exception as e:
        print(f"Homework help generation failed: {e}", file=sys.stderr)

    return None


def main():
    events, error = fetch_all_events()

    if error:
        print(f"Error fetching Canvas feed: {error}", file=sys.stderr)
        return

    if not events:
        print("No Canvas events in the next 7 days")
        return

    state = load_state()
    today_str = datetime.datetime.now().strftime("%Y-%m-%d")

    # --- 1. Morning summary → #calendar ---
    summary = generate_morning_summary(events)
    print(summary)
    notify(summary, channel="calendar")

    # --- 2. Course-specific notifications ---
    by_course = {}
    for ev in events:
        if ev["course_code"] and ev["course_info"]:
            by_course.setdefault(ev["course_code"], []).append(ev)

    for course_code, course_events in by_course.items():
        course_info = course_events[0]["course_info"]
        course_msg = generate_course_notification(course_info, course_events)
        notify(course_msg, channel=course_info["channel"])
        print(f"  → Routed {len(course_events)} events to #{course_info['channel']}")

    # --- 3. Quiz detection + study guide ---
    today = datetime.datetime.now().date()
    for ev in events:
        if not ev["is_quiz"] or not ev["course_info"]:
            continue

        days_until = (ev["dt"].date() - today).days
        if days_until > 3:
            continue

        # Dedup: don't regenerate study guides we already posted
        event_key = f"{ev['full_summary']}_{ev['dt'].strftime('%Y%m%d')}"
        if event_key in state.get("study_guides_generated", []):
            print(f"  Study guide already sent for: {ev['name']}")
            continue

        print(f"  Generating study guide for: {ev['name']} ({days_until} days away)")
        guide = generate_study_guide(ev, ev["course_info"])
        if guide:
            guide_msg = (
                f"**Study Guide: {ev['name']}**\n"
                f"*{ev['dt'].strftime('%A %B %d')} — {days_until} day{'s' if days_until != 1 else ''} away*\n\n"
                f"{guide}"
            )
            notify(guide_msg, channel=ev["course_info"]["channel"], task="study-guide")
            state.setdefault("study_guides_generated", []).append(event_key)
            print(f"  → Study guide posted to #{ev['course_info']['channel']}")

    # --- 4. Homework helper ---
    for ev in events:
        if not ev["is_homework"] or not ev["course_info"]:
            continue

        days_until = (ev["dt"].date() - today).days
        if days_until > 2:
            continue

        event_key = f"hw_{ev['full_summary']}_{ev['dt'].strftime('%Y%m%d')}"
        if event_key in state.get("notified_events", {}):
            continue

        if not ev["description"]:
            continue

        print(f"  Generating homework help for: {ev['name']} ({days_until} days away)")
        help_text = generate_homework_help(ev, ev["course_info"])
        if help_text:
            help_msg = (
                f"**Homework Helper: {ev['name']}**\n"
                f"*Due {ev['dt'].strftime('%A %B %d')}*\n\n"
                f"{help_text}"
            )
            notify(help_msg, channel=ev["course_info"]["channel"], task="homework-helper")
            state.setdefault("notified_events", {})[event_key] = today_str
            print(f"  → Homework help posted to #{ev['course_info']['channel']}")

    # Clean up old state entries (>14 days old)
    if "notified_events" in state:
        cutoff = (today - datetime.timedelta(days=14)).strftime("%Y-%m-%d")
        state["notified_events"] = {
            k: v for k, v in state["notified_events"].items()
            if v >= cutoff
        }
    if "study_guides_generated" in state:
        # Keep last 50 entries
        state["study_guides_generated"] = state["study_guides_generated"][-50:]

    save_state(state)
    print(f"\nDone — {len(events)} events processed")


if __name__ == "__main__":
    main()
