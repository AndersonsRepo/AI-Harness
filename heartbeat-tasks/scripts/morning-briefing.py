#!/usr/bin/env python3
"""Morning briefing — comprehensive daily intelligence digest.

Runs daily at 8:30 AM. Two-phase approach:
  Phase 1 (deterministic): Gather all data in ~10s
  Phase 2 (LLM synthesis): One call to prioritize and summarize

Data sources:
1. Calendar events (next 24h via osascript)
2. Canvas assignments (next 7 days via iCal)
3. Email intelligence (last 7 days — opportunities, deadlines, events)
4. Tracked events from DB (active internships, deadlines, career items)
5. System health (heartbeat, bot, dead letters)

Discovered events/opportunities are persisted to tracked_events table.
"""

import os
import sys
import re
import json
import glob
import uuid
import sqlite3
import signal
import subprocess
import datetime
import hashlib
from pathlib import Path

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from lib.llm_provider import get_provider, get_default_model, LLMError

TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
DB_PATH = os.path.join(HARNESS_ROOT, "bridges", "discord", "harness.db")
NOTIFY_FILE = os.path.join(TASKS_DIR, "pending-notifications.jsonl")
PID_FILE = os.path.join(HARNESS_ROOT, "bridges", "discord", ".bot.pid")
VAULT_LEARNINGS = os.path.join(HARNESS_ROOT, "vault", "learnings")

# Load .env
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

# Load course map
_course_map_path = os.path.join(TASKS_DIR, "course-map.json")
_course_data = {}
if os.path.exists(_course_map_path):
    with open(_course_map_path) as _f:
        _course_data = json.load(_f)
COURSE_MAP = _course_data.get("canvas", {})
_semester_end_str = _course_data.get("semester_end", "2026-12-31")
SEMESTER_END = datetime.datetime.strptime(_semester_end_str, "%Y-%m-%d")

# Email patterns for event/opportunity extraction
CAREER_PATTERNS = re.compile(
    r"\b(internship|intern|career fair|job fair|hiring|recruiter|"
    r"application|apply now|resume|interview|offer letter|"
    r"fellowship|co-?op|full.?time|part.?time)\b",
    re.IGNORECASE,
)
DEADLINE_PATTERNS = re.compile(
    r"\b(deadline|due date|due by|submit by|expires?|last day|"
    r"closes?|register by|RSVP by|application deadline)\b",
    re.IGNORECASE,
)
EVENT_PATTERNS = re.compile(
    r"\b(info session|workshop|hackathon|seminar|webinar|"
    r"orientation|networking|panel|open house|career fair|"
    r"meetup|conference|symposium|expo|showcase)\b",
    re.IGNORECASE,
)
URL_PATTERN = re.compile(r"https?://[^\s<>\"')\]]+")
EMAIL_PATTERN = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
# Date patterns like "March 15", "3/15", "April 8, 2026"
DATE_PATTERN = re.compile(
    r"\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
    r"Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|"
    r"Dec(?:ember)?)\s+\d{1,2}(?:,?\s*\d{4})?\b"
    r"|\b\d{1,2}/\d{1,2}(?:/\d{2,4})?\b",
    re.IGNORECASE,
)


def notify(message: str, channel: str = "notifications"):
    """Append notification to pending-notifications.jsonl."""
    entry = {
        "task": "morning-briefing",
        "channel": channel,
        "summary": message,
        "timestamp": datetime.datetime.now().isoformat(),
    }
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")


def get_db():
    """Open SQLite connection to harness.db."""
    if not os.path.exists(DB_PATH):
        return None
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# ===========================================================================
# DATA GATHERING (all deterministic, no LLM)
# ===========================================================================

def gather_calendar_events(hours: int = 24) -> list[dict]:
    """Fetch events from Calendar.app via AppleScript."""
    now = datetime.datetime.now()
    end = now + datetime.timedelta(hours=hours)

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

set startD to makeDate({now.year}, {now.month}, {now.day}, {now.hour}, {now.minute}, 0)
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
                    set evtLoc to ""
                    try
                        set evtLoc to location of evt as text
                    end try
                    set end of output to (evtSummary & "||" & evtStart & "||" & evtEnd & "||" & evtAllDay & "||" & calName & "||" & evtLoc)
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
            capture_output=True, text=True, timeout=20
        )
        if result.returncode != 0:
            print(f"AppleScript error: {result.stderr.strip()[:100]}")
            return []
    except (subprocess.TimeoutExpired, FileNotFoundError):
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
            "location": parts[5].strip() if len(parts) > 5 and parts[5].strip() != "missing value" else "",
        })

    events.sort(key=lambda e: e["start"])
    return events


def gather_canvas_assignments(days: int = 7) -> list[dict]:
    """Fetch upcoming Canvas assignments from iCal feed."""
    if not ICAL_URL:
        return []
    try:
        result = subprocess.run(
            ["curl", "-s", ICAL_URL],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode != 0:
            return []
        data = result.stdout
    except Exception:
        return []

    now = datetime.datetime.now()
    cutoff = now + datetime.timedelta(days=days)
    assignments = []

    raw_events = data.split("BEGIN:VEVENT")
    for ev in raw_events[1:]:
        summary_match = re.search(r"SUMMARY:(.*)", ev)
        dtstart_match = re.search(r"DTSTART[^:]*:(.*)", ev)
        desc_match = re.search(r"DESCRIPTION:(.*?)(?=\n[A-Z])", ev, re.DOTALL)

        if not summary_match or not dtstart_match:
            continue

        name = summary_match.group(1).strip()
        dt_str = dtstart_match.group(1).strip()
        description = desc_match.group(1).strip() if desc_match else ""
        description = re.sub(r"\n ", "", description)

        # Parse date
        is_utc = dt_str.endswith("Z")
        if is_utc:
            dt_str = dt_str[:-1]
        try:
            if "T" in dt_str:
                dt = datetime.datetime.strptime(dt_str[:15], "%Y%m%dT%H%M%S")
                if is_utc:
                    dt = dt.replace(tzinfo=datetime.timezone.utc).astimezone().replace(tzinfo=None)
            else:
                dt = datetime.datetime.strptime(dt_str[:8], "%Y%m%d")
        except ValueError:
            continue

        if now <= dt <= cutoff and dt <= SEMESTER_END:
            # Extract course info
            course_code = None
            course_info = None
            code_match = re.search(r"\[(\w+_\w+)", name)
            if code_match:
                raw_code = code_match.group(1)
                for prefix, info in COURSE_MAP.items():
                    if raw_code.startswith(prefix):
                        course_code = prefix
                        course_info = info
                        break

            event_name = re.sub(r"\s*\[.*?\]\s*$", "", name).strip()
            is_quiz = bool(re.search(r"\b(quiz|q\s*\d|exam|midterm|final|test)\b", event_name, re.IGNORECASE))
            is_homework = bool(re.search(r"\b(assignment|homework|hw|problem set|lab|project|paper|discussion)\b", event_name, re.IGNORECASE))

            assignments.append({
                "name": event_name,
                "full_summary": name,
                "dt": dt,
                "description": description[:300],
                "course_code": course_code,
                "course_info": course_info,
                "is_quiz": is_quiz,
                "is_homework": is_homework,
            })

    assignments.sort(key=lambda a: a["dt"])
    return assignments


def gather_email_intelligence(days: int = 7) -> dict:
    """Scan indexed emails for actionable items — careers, deadlines, events."""
    db = get_db()
    if not db:
        return {"career": [], "deadline": [], "event": [], "total_24h": 0, "by_sender": []}

    result = {"career": [], "deadline": [], "event": [], "total_24h": 0, "by_sender": []}

    try:
        # Recent email counts (24h)
        day_cutoff = (datetime.datetime.now() - datetime.timedelta(hours=24)).isoformat()
        result["total_24h"] = db.execute(
            "SELECT COUNT(*) FROM email_index WHERE indexed_at > ?", (day_cutoff,)
        ).fetchone()[0]

        result["by_sender"] = [
            {"name": r["sender_name"], "count": r["cnt"]}
            for r in db.execute(
                "SELECT sender_name, COUNT(*) as cnt FROM email_index WHERE indexed_at > ? GROUP BY sender_name ORDER BY cnt DESC LIMIT 8",
                (day_cutoff,)
            ).fetchall()
        ]

        # Actionable emails (7 days)
        week_cutoff = (datetime.datetime.now() - datetime.timedelta(days=days)).isoformat()
        rows = db.execute(
            "SELECT message_id, subject, sender_name, sender_email, snippet, received_at "
            "FROM email_index WHERE indexed_at > ? ORDER BY received_at DESC LIMIT 200",
            (week_cutoff,)
        ).fetchall()

        for row in rows:
            subject = row["subject"] or ""
            snippet = row["snippet"] or ""
            combined = f"{subject} {snippet}"

            # Extract URLs and contacts from snippet
            urls = URL_PATTERN.findall(combined)
            contacts = EMAIL_PATTERN.findall(combined)
            # Filter out the sender's own email
            contacts = [c for c in contacts if c != row["sender_email"]]
            dates_found = DATE_PATTERN.findall(combined)

            item = {
                "message_id": row["message_id"],
                "subject": subject,
                "sender": row["sender_name"],
                "sender_email": row["sender_email"],
                "snippet": snippet[:200],
                "received": row["received_at"],
                "urls": urls[:3],
                "contacts": contacts[:2],
                "dates": dates_found[:2],
            }

            if CAREER_PATTERNS.search(combined):
                item["category"] = "career"
                result["career"].append(item)
            elif DEADLINE_PATTERNS.search(combined):
                item["category"] = "deadline"
                result["deadline"].append(item)
            elif EVENT_PATTERNS.search(combined):
                item["category"] = "event"
                result["event"].append(item)

        db.close()
    except Exception as e:
        print(f"Email intelligence error: {e}", file=sys.stderr)
        try:
            db.close()
        except Exception:
            pass

    return result


def persist_discovered_events(email_intel: dict):
    """Save newly discovered events/opportunities to tracked_events table."""
    db = get_db()
    if not db:
        return 0

    new_count = 0
    try:
        for category, items in [("career", email_intel["career"]),
                                 ("deadline", email_intel["deadline"]),
                                 ("event", email_intel["event"])]:
            cat_label = "internship" if category == "career" else category
            for item in items[:10]:  # Cap per category
                # Dedup by source_id (email message_id)
                existing = db.execute(
                    "SELECT id FROM tracked_events WHERE source_id = ?",
                    (item["message_id"],)
                ).fetchone()
                if existing:
                    continue

                event_id = str(uuid.uuid4())[:8]

                # Try to parse a due date from extracted dates
                due_date = None
                for d in item.get("dates", []):
                    try:
                        from dateutil import parser as dateparser
                        parsed = dateparser.parse(d, fuzzy=True)
                        if parsed and parsed > datetime.datetime.now():
                            due_date = parsed.strftime("%Y-%m-%d")
                            break
                    except Exception:
                        continue

                db.execute(
                    """INSERT INTO tracked_events
                       (id, source, source_id, category, title, description,
                        due_date, apply_link, contact_name, contact_email, organization)
                       VALUES (?, 'email', ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        event_id,
                        item["message_id"],
                        cat_label,
                        item["subject"],
                        item["snippet"][:300],
                        due_date,
                        item["urls"][0] if item.get("urls") else None,
                        item["contacts"][0].split("@")[0] if item.get("contacts") else None,
                        item["contacts"][0] if item.get("contacts") else None,
                        item["sender"],
                    ),
                )
                new_count += 1

        db.commit()
        db.close()
    except Exception as e:
        print(f"Event persistence error: {e}", file=sys.stderr)
        try:
            db.close()
        except Exception:
            pass

    return new_count


def gather_tracked_events() -> list[dict]:
    """Get all active tracked events from the database."""
    db = get_db()
    if not db:
        return []
    try:
        rows = db.execute(
            """SELECT id, category, title, description, event_date, due_date,
                      location, apply_link, contact_name, contact_email, organization,
                      source, discovered_at, status
               FROM tracked_events
               WHERE status IN ('active', 'upcoming')
               ORDER BY
                 CASE WHEN due_date IS NOT NULL THEN due_date ELSE '9999-12-31' END ASC,
                 discovered_at DESC
               LIMIT 30""",
        ).fetchall()
        db.close()
        return [dict(r) for r in rows]
    except Exception as e:
        print(f"Tracked events error: {e}", file=sys.stderr)
        try:
            db.close()
        except Exception:
            pass
        return []


def expire_old_events():
    """Mark tracked events with past due dates as expired."""
    db = get_db()
    if not db:
        return
    try:
        today = datetime.datetime.now().strftime("%Y-%m-%d")
        db.execute(
            "UPDATE tracked_events SET status = 'expired', updated_at = datetime('now') "
            "WHERE status = 'active' AND due_date IS NOT NULL AND due_date < ?",
            (today,)
        )
        db.commit()
        db.close()
    except Exception:
        try:
            db.close()
        except Exception:
            pass


def check_system_health() -> dict:
    """Quick system health summary."""
    health = {"heartbeat": "", "bot": "", "dead_letters": ""}

    # Heartbeat tasks
    state_files = glob.glob(os.path.join(TASKS_DIR, "*.state.json"))
    failures = 0
    for sf in state_files:
        try:
            with open(sf) as f:
                state = json.load(f)
            if state.get("consecutive_failures", 0) > 0:
                failures += 1
        except Exception:
            pass
    total = len(state_files)
    health["heartbeat"] = f"{total - failures}/{total} healthy" + (f", {failures} failing" if failures else "")

    # Bot
    if os.path.exists(PID_FILE):
        try:
            pid = int(open(PID_FILE).read().strip())
            os.kill(pid, 0)
            health["bot"] = "running"
        except (ProcessLookupError, ValueError, IOError):
            health["bot"] = "DOWN"
    else:
        health["bot"] = "PID missing"

    # Dead letters
    db = get_db()
    if db:
        try:
            cutoff = (datetime.datetime.now() - datetime.timedelta(days=7)).isoformat()
            count = db.execute(
                "SELECT COUNT(*) FROM dead_letter WHERE created_at > ?", (cutoff,)
            ).fetchone()[0]
            db.close()
            health["dead_letters"] = f"{count} this week" if count > 0 else "none"
        except Exception:
            health["dead_letters"] = "check failed"
            try:
                db.close()
            except Exception:
                pass

    return health


# ===========================================================================
# FORMATTING (deterministic — builds the raw briefing)
# ===========================================================================

def format_deterministic_briefing(
    calendar_events: list[dict],
    assignments: list[dict],
    email_intel: dict,
    tracked: list[dict],
    health: dict,
) -> str:
    """Build a structured text briefing from gathered data."""
    now = datetime.datetime.now()
    today = now.date()
    sections = []

    # -- Calendar --
    if calendar_events:
        lines = []
        for ev in calendar_events:
            time_str = "all day" if ev["allDay"] else ev["start"].strftime("%I:%M %p").lstrip("0")
            loc = f" @ {ev['location']}" if ev.get("location") else ""
            lines.append(f"  {time_str} — {ev['summary']}{loc} ({ev['calendar']})")
        sections.append("CALENDAR (next 24h):\n" + "\n".join(lines))
    else:
        sections.append("CALENDAR: No events in the next 24h")

    # -- Assignments --
    if assignments:
        lines = []
        for a in assignments:
            days_until = (a["dt"].date() - today).days
            day_label = "TODAY" if days_until == 0 else f"in {days_until}d" if days_until <= 2 else a["dt"].strftime("%a %b %d")
            tag = ""
            if a["is_quiz"]:
                tag = " [QUIZ]"
            elif a["is_homework"]:
                tag = " [HW]"
            course = f" ({a['course_info']['display']})" if a.get("course_info") else ""
            lines.append(f"  {a['name']}{tag}{course} — due {day_label} {a['dt'].strftime('%I:%M %p').lstrip('0')}")
        sections.append("ASSIGNMENTS (next 7 days):\n" + "\n".join(lines))

    # -- Email intelligence --
    email_lines = []
    if email_intel["career"]:
        email_lines.append("  Career/Internships:")
        for e in email_intel["career"][:5]:
            urls = f" | Link: {e['urls'][0]}" if e.get("urls") else ""
            email_lines.append(f"    {e['subject']} (from {e['sender']}){urls}")
    if email_intel["deadline"]:
        email_lines.append("  Deadlines:")
        for e in email_intel["deadline"][:5]:
            dates = f" | Date: {e['dates'][0]}" if e.get("dates") else ""
            email_lines.append(f"    {e['subject']} (from {e['sender']}){dates}")
    if email_intel["event"]:
        email_lines.append("  Events/Workshops:")
        for e in email_intel["event"][:5]:
            urls = f" | Link: {e['urls'][0]}" if e.get("urls") else ""
            email_lines.append(f"    {e['subject']} (from {e['sender']}){urls}")
    if email_lines:
        sections.append("FROM YOUR INBOX:\n" + "\n".join(email_lines))

    # -- Tracked opportunities --
    active_tracked = [t for t in tracked if t["category"] in ("internship", "career")]
    deadline_tracked = [t for t in tracked if t["category"] == "deadline"]
    event_tracked = [t for t in tracked if t["category"] == "event"]

    tracked_lines = []
    if active_tracked:
        tracked_lines.append("  Internships/Career:")
        for t in active_tracked[:5]:
            due = f" | Due: {t['due_date']}" if t.get("due_date") else ""
            link = f" | Apply: {t['apply_link']}" if t.get("apply_link") else ""
            contact = f" | Contact: {t['contact_email']}" if t.get("contact_email") else ""
            tracked_lines.append(f"    {t['title']}{due}{link}{contact}")
    if deadline_tracked:
        tracked_lines.append("  Upcoming Deadlines:")
        for t in deadline_tracked[:5]:
            due = f" | Due: {t['due_date']}" if t.get("due_date") else ""
            tracked_lines.append(f"    {t['title']} (from {t['organization']}){due}")
    if event_tracked:
        tracked_lines.append("  Tracked Events:")
        for t in event_tracked[:5]:
            date = f" | Date: {t['event_date'] or t['due_date']}" if (t.get("event_date") or t.get("due_date")) else ""
            loc = f" | Location: {t['location']}" if t.get("location") else ""
            tracked_lines.append(f"    {t['title']}{date}{loc}")
    if tracked_lines:
        sections.append("TRACKED OPPORTUNITIES:\n" + "\n".join(tracked_lines))

    # -- System health (condensed) --
    sections.append(
        f"SYSTEM: Bot {health['bot']} | Tasks {health['heartbeat']} | "
        f"Dead letters: {health['dead_letters']} | "
        f"Emails (24h): {email_intel['total_24h']}"
    )

    return "\n\n".join(sections)


# ===========================================================================
# LLM SYNTHESIS (one short call)
# ===========================================================================

def synthesize_with_llm(raw_briefing: str) -> str | None:
    """Ask LLM to prioritize and create actionable morning summary."""
    prompt = (
        "You are Anderson's morning briefing assistant. Below is raw data about his day.\n"
        "Create a concise, prioritized morning briefing for Discord. Format rules:\n"
        "- Use **bold** for section headers and important items\n"
        "- Lead with the most urgent/time-sensitive items\n"
        "- For career/internship items, always include the apply link if available\n"
        "- For deadlines, calculate and show how many days remain\n"
        "- Suggest specific time blocks for studying if there's a quiz/exam coming up\n"
        "- If there are internship opportunities, highlight them prominently\n"
        "- Keep total output under 1800 characters (Discord limit)\n"
        "- Be direct, no filler phrases\n\n"
        f"Today is {datetime.datetime.now().strftime('%A, %B %d, %Y')}.\n\n"
        f"--- RAW DATA ---\n{raw_briefing}\n--- END ---"
    )

    try:
        llm = get_provider()
        response = llm.complete(prompt, model=get_default_model(), timeout=90, max_turns=1)
        text = response.text.strip()
        if text and len(text) >= 100:
            return text
    except (LLMError, Exception) as e:
        print(f"LLM synthesis failed (falling back to raw): {e}", file=sys.stderr)

    return None


# ===========================================================================
# MAIN
# ===========================================================================

def main():
    now = datetime.datetime.now()
    print(f"Morning briefing starting at {now.isoformat()}")

    # Phase 0: Expire old tracked events
    expire_old_events()

    # Phase 1: Gather all data (deterministic, ~10s)
    print("Gathering calendar events...")
    calendar_events = gather_calendar_events(hours=24)
    print(f"  {len(calendar_events)} calendar events")

    print("Gathering Canvas assignments...")
    assignments = gather_canvas_assignments(days=7)
    print(f"  {len(assignments)} assignments")

    print("Scanning emails for intelligence...")
    email_intel = gather_email_intelligence(days=7)
    career_count = len(email_intel["career"])
    deadline_count = len(email_intel["deadline"])
    event_count = len(email_intel["event"])
    print(f"  {career_count} career, {deadline_count} deadline, {event_count} event emails")

    print("Persisting discovered events...")
    new_events = persist_discovered_events(email_intel)
    print(f"  {new_events} new events tracked")

    print("Loading tracked opportunities...")
    tracked = gather_tracked_events()
    print(f"  {len(tracked)} active tracked events")

    print("Checking system health...")
    health = check_system_health()

    # Build raw briefing
    raw_briefing = format_deterministic_briefing(
        calendar_events, assignments, email_intel, tracked, health
    )

    # Phase 2: LLM synthesis (optional, one call)
    print("Synthesizing with LLM...")
    synthesized = synthesize_with_llm(raw_briefing)

    if synthesized:
        message = synthesized
        print("LLM synthesis succeeded")
    else:
        # Fallback: use raw deterministic output with a header
        date_str = now.strftime("%A, %B %d, %Y")
        message = f"**MORNING BRIEFING — {date_str}**\n\n{raw_briefing}"
        if len(message) > 1900:
            message = message[:1900] + "\n\n*...truncated*"
        print("Using deterministic fallback")

    # Post to Discord
    notify(message, channel="notifications")

    # Also post tracked opportunities summary to #emails if there are new ones
    if new_events > 0:
        opp_lines = []
        for t in tracked:
            if t["category"] in ("internship", "career"):
                link = f"\n    Apply: {t['apply_link']}" if t.get("apply_link") else ""
                contact = f"\n    Contact: {t['contact_email']}" if t.get("contact_email") else ""
                due = f" (deadline: {t['due_date']})" if t.get("due_date") else ""
                opp_lines.append(f"  **{t['title']}**{due}{link}{contact}")
        if opp_lines:
            opp_msg = f"**New opportunities discovered** ({new_events} new):\n" + "\n".join(opp_lines[:8])
            notify(opp_msg, channel="emails")

    print(f"\nBriefing complete. Output:\n{message}")


if __name__ == "__main__":
    main()
