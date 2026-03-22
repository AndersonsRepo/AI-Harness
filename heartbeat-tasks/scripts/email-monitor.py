#!/usr/bin/env python3
"""
Email Monitor — indexes new emails from Outlook via Graph API.

Runs every 15 minutes. For each new email:
  1. Insert into email_index table
  2. Check against watched_senders → notify Discord #outlook
  3. Match against active projects → set matched_project

State: last_check timestamp persisted in email-monitor.state.json
"""

import os
import sys
import json
import sqlite3
import datetime
import urllib.request
import urllib.error

# Add scripts dir to path for oauth_helper
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oauth_helper import get_access_token

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
DB_PATH = os.path.join(HARNESS_ROOT, "bridges", "discord", "harness.db")
NOTIFY_FILE = os.path.join(TASKS_DIR, "pending-notifications.jsonl")
STATE_FILE = os.path.join(TASKS_DIR, "email-monitor.state.json")
PROJECTS_FILE = os.path.join(TASKS_DIR, "projects.json")

GRAPH_BASE = "https://graph.microsoft.com/v1.0"


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def notify(message, channel="emails"):
    notification = {
        "task": "email-monitor",
        "channel": channel,
        "summary": message,
        "timestamp": datetime.datetime.now().isoformat(),
    }
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(notification) + "\n")


def graph_get(path, token, params=None):
    """Make an authenticated GET request to Graph API."""
    url = f"{GRAPH_BASE}{path}"
    if params:
        query = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
        url = f"{url}?{query}"

    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    })

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        raise RuntimeError(f"Graph API {path} failed ({e.code}): {body[:500]}")


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {}


def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def load_projects():
    """Load project names and keywords for matching."""
    if not os.path.exists(PROJECTS_FILE):
        return []
    try:
        with open(PROJECTS_FILE) as f:
            return json.load(f)
    except Exception:
        return []


def match_project(subject, sender_email, conn):
    """Try to match an email to a project."""
    # Check watched senders first
    row = conn.execute(
        "SELECT project FROM watched_senders WHERE email = ?", (sender_email.lower(),)
    ).fetchone()
    if row and row["project"]:
        return row["project"]

    # Check project names/keywords against subject
    projects = load_projects()
    subject_lower = subject.lower()
    for p in projects:
        name = p.get("name", "").lower()
        if name and name in subject_lower:
            return p["name"]
        for kw in p.get("keywords", []):
            if kw.lower() in subject_lower:
                return p["name"]

    return None


def main():
    token = get_access_token("microsoft")
    conn = get_db()
    state = load_state()

    # Determine last check time (default: 1 hour ago)
    last_check = state.get("last_check")
    if not last_check:
        last_check = (datetime.datetime.utcnow() - datetime.timedelta(hours=1)).isoformat() + "Z"

    print(f"Checking emails since {last_check}")

    # Fetch new emails
    import urllib.parse
    try:
        data = graph_get("/me/messages", token, {
            "$filter": f"receivedDateTime ge {last_check}",
            "$top": "50",
            "$select": "id,conversationId,subject,from,receivedDateTime,bodyPreview,hasAttachments,importance,isRead",
            "$orderby": "receivedDateTime desc",
        })
    except Exception as e:
        print(f"Error fetching emails: {e}", file=sys.stderr)
        return

    messages = data.get("value", [])
    print(f"Found {len(messages)} new email(s)")

    new_count = 0
    watched_alerts = []

    for msg in messages:
        msg_id = msg["id"]
        sender_email = (msg.get("from", {}).get("emailAddress", {}).get("address") or "unknown").lower()
        sender_name = msg.get("from", {}).get("emailAddress", {}).get("name") or sender_email
        subject = msg.get("subject", "(no subject)")
        received = msg.get("receivedDateTime", "")
        snippet = (msg.get("bodyPreview") or "")[:500]
        has_attachments = 1 if msg.get("hasAttachments") else 0
        importance = msg.get("importance", "normal")
        is_read = 1 if msg.get("isRead") else 0

        # Skip if already indexed
        existing = conn.execute(
            "SELECT message_id FROM email_index WHERE message_id = ?", (msg_id,)
        ).fetchone()
        if existing:
            continue

        # Match project
        matched_project = match_project(subject, sender_email, conn)

        # Insert into index
        conn.execute(
            """INSERT INTO email_index
               (message_id, conversation_id, subject, sender_name, sender_email,
                received_at, snippet, has_attachments, importance, is_read, folder, matched_project)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbox', ?)""",
            (msg_id, msg.get("conversationId"), subject, sender_name, sender_email,
             received, snippet, has_attachments, importance, is_read, matched_project),
        )
        new_count += 1

        # Check watched senders
        watched = conn.execute(
            "SELECT label, discord_channel FROM watched_senders WHERE email = ?",
            (sender_email,)
        ).fetchone()
        if watched:
            watched_alerts.append({
                "label": watched["label"],
                "sender": sender_name,
                "email": sender_email,
                "subject": subject,
                "channel": watched["discord_channel"],
            })

    conn.commit()

    # Send watched sender notifications
    for alert in watched_alerts:
        notify(
            f"[{alert['label'].upper()}] {alert['sender']} <{alert['email']}>\n"
            f"Subject: {alert['subject']}",
            channel=alert["channel"],
        )

    conn.close()

    # Update state
    state["last_check"] = datetime.datetime.utcnow().isoformat() + "Z"
    state["last_run"] = datetime.datetime.now().isoformat()
    state["last_result"] = f"Indexed {new_count} new email(s), {len(watched_alerts)} watched sender alert(s)"
    save_state(state)

    print(f"Indexed {new_count} new email(s)")
    if watched_alerts:
        print(f"Sent {len(watched_alerts)} watched sender alert(s)")


if __name__ == "__main__":
    main()
