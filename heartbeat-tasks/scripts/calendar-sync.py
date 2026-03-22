#!/usr/bin/env python3
"""
Calendar Sync — syncs Outlook calendar events and notifies upcoming.

Runs every 2 hours. Fetches events for the next 48h, notifies on events
in the next 24h (deduped via notified_event_ids in state).
School events also go to #calendar channel.
"""

import os
import sys
import json
import datetime
import urllib.request
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oauth_helper import get_access_token

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
NOTIFY_FILE = os.path.join(TASKS_DIR, "pending-notifications.jsonl")
STATE_FILE = os.path.join(TASKS_DIR, "calendar-sync.state.json")

GRAPH_BASE = "https://graph.microsoft.com/v1.0"

SCHOOL_KEYWORDS = [
    "class", "lecture", "lab", "exam", "quiz", "office hours",
    "assignment", "homework", "midterm", "final", "recitation",
    "tutorial", "professor", "section",
]


def notify(message, channel="emails"):
    notification = {
        "task": "calendar-sync",
        "channel": channel,
        "summary": message,
        "timestamp": datetime.datetime.now().isoformat(),
    }
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(notification) + "\n")


def graph_get(path, token, params=None):
    import urllib.parse
    url = f"{GRAPH_BASE}{path}"
    if params:
        query = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
        url = f"{url}?{query}"

    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    })

    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"notified_event_ids": []}


def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def is_school_event(subject, organizer=""):
    """Check if event looks school-related."""
    text = f"{subject} {organizer}".lower()
    return any(kw in text for kw in SCHOOL_KEYWORDS)


def main():
    token = get_access_token("microsoft")
    state = load_state()
    notified_ids = set(state.get("notified_event_ids", []))

    now = datetime.datetime.utcnow()
    end_48h = now + datetime.timedelta(hours=48)
    notify_window = now + datetime.timedelta(hours=24)

    try:
        data = graph_get("/me/calendarview", token, {
            "startdatetime": now.isoformat() + "Z",
            "enddatetime": end_48h.isoformat() + "Z",
            "$select": "id,subject,start,end,location,organizer,isAllDay,isCancelled",
            "$orderby": "start/dateTime",
            "$top": "50",
        })
    except Exception as e:
        print(f"Error fetching calendar: {e}", file=sys.stderr)
        return

    events = data.get("value", [])
    print(f"Found {len(events)} events in next 48h")

    new_notifications = 0

    for event in events:
        event_id = event.get("id", "")
        subject = event.get("subject", "(no subject)")
        start_dt = event.get("start", {}).get("dateTime", "")
        end_dt = event.get("end", {}).get("dateTime", "")
        location = event.get("location", {}).get("displayName", "")
        organizer = event.get("organizer", {}).get("emailAddress", {}).get("name", "")
        cancelled = event.get("isCancelled", False)

        if cancelled:
            continue

        # Only notify for events in the next 24h
        try:
            event_start = datetime.datetime.fromisoformat(start_dt.replace("Z", ""))
            if event_start > notify_window:
                continue
        except (ValueError, TypeError):
            continue

        # Dedup
        if event_id in notified_ids:
            continue

        # Build notification
        loc_str = f" @ {location}" if location else ""
        time_str = start_dt[11:16] if "T" in start_dt else start_dt
        end_str = end_dt[11:16] if "T" in end_dt else end_dt

        msg = f"{subject}\n{time_str} → {end_str}{loc_str}\nOrganizer: {organizer}"

        # Determine channel
        school = is_school_event(subject, organizer)
        channel = "calendar" if school else "emails"

        notify(msg, channel=channel)
        notified_ids.add(event_id)
        new_notifications += 1

    # Prune old notified IDs (keep last 200)
    notified_list = list(notified_ids)
    if len(notified_list) > 200:
        notified_list = notified_list[-200:]

    state["notified_event_ids"] = notified_list
    state["last_run"] = datetime.datetime.now().isoformat()
    state["last_result"] = f"{len(events)} events found, {new_notifications} new notification(s)"
    save_state(state)

    print(f"Sent {new_notifications} new notification(s)")


if __name__ == "__main__":
    main()
