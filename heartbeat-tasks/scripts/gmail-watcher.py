#!/usr/bin/env python3
"""Gmail Watcher — monitors forwarded emails from Outlook via Gmail API.

Checks for new emails since last run, indexes them, and notifies
relevant Discord channels. Designed to work with Outlook→Gmail forwarding.

Runs every 15 minutes via launchd.
"""

import os
import sys
import json
import datetime
import sqlite3
import urllib.request
import urllib.error

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
STATE_FILE = os.path.join(TASKS_DIR, "gmail-watcher.state.json")
NOTIFY_FILE = os.path.join(TASKS_DIR, "pending-notifications.jsonl")
DB_PATH = os.path.join(HARNESS_ROOT, "bridges", "discord", "harness.db")

GMAIL_API_BASE = "https://www.googleapis.com/gmail/v1/users/me"


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"last_history_id": None, "last_run": None, "total_emails_indexed": 0}


def save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.rename(tmp, STATE_FILE)


def get_access_token():
    """Get a fresh Gmail access token from the OAuth store."""
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    row = db.execute("SELECT * FROM oauth_tokens WHERE provider = 'gmail'").fetchone()
    db.close()

    if not row:
        print("No Gmail tokens found. Run: npx tsx oauth-setup.ts gmail")
        sys.exit(1)

    expires_at = datetime.datetime.fromisoformat(row["expires_at"].replace("Z", "+00:00"))
    now = datetime.datetime.now(datetime.timezone.utc)

    if now < expires_at - datetime.timedelta(minutes=5):
        return row["access_token"]

    # Token expired — refresh it
    print("Refreshing Gmail access token...")
    client_id = os.environ.get("GMAIL_CLIENT_ID", "")
    client_secret = os.environ.get("GMAIL_CLIENT_SECRET", "")

    if not client_id or not client_secret:
        # Try loading from .env
        env_path = os.path.join(HARNESS_ROOT, "bridges", "discord", ".env")
        if os.path.exists(env_path):
            with open(env_path) as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("GMAIL_CLIENT_ID="):
                        client_id = line.split("=", 1)[1]
                    elif line.startswith("GMAIL_CLIENT_SECRET="):
                        client_secret = line.split("=", 1)[1]

    if not client_id or not client_secret:
        print("GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET not found")
        sys.exit(1)

    refresh_token = row["refresh_token"]

    # Check if refresh token is encrypted (contains : separators)
    if ":" in refresh_token and len(refresh_token.split(":")) == 3:
        # Encrypted — need to decrypt
        key_hex = os.environ.get("OAUTH_ENCRYPTION_KEY", "")
        if not key_hex:
            env_path = os.path.join(HARNESS_ROOT, "bridges", "discord", ".env")
            if os.path.exists(env_path):
                with open(env_path) as f:
                    for line in f:
                        if line.strip().startswith("OAUTH_ENCRYPTION_KEY="):
                            key_hex = line.strip().split("=", 1)[1]

        if key_hex and len(key_hex) == 64:
            try:
                from cryptography.hazmat.primitives.ciphers.aead import AESGCM
                parts = refresh_token.split(":")
                iv = bytes.fromhex(parts[0])
                tag = bytes.fromhex(parts[1])
                ciphertext = bytes.fromhex(parts[2])
                key = bytes.fromhex(key_hex)
                aesgcm = AESGCM(key)
                refresh_token = aesgcm.decrypt(iv, ciphertext + tag, None).decode("utf-8")
            except Exception as e:
                print(f"Failed to decrypt refresh token: {e}")
                sys.exit(1)

    data = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }).encode()

    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )

    try:
        with urllib.request.urlopen(req) as resp:
            token_data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"Token refresh failed: {e.code} {e.read().decode()}")
        sys.exit(1)

    # Save new access token
    new_expires = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=token_data["expires_in"])
    db = sqlite3.connect(DB_PATH)
    db.execute(
        "UPDATE oauth_tokens SET access_token = ?, expires_at = ?, updated_at = ? WHERE provider = 'gmail'",
        (token_data["access_token"], new_expires.isoformat(), datetime.datetime.now().isoformat()),
    )
    db.commit()
    db.close()

    return token_data["access_token"]


def gmail_api(endpoint, token, params=None):
    """Make a Gmail API request."""
    url = f"{GMAIL_API_BASE}/{endpoint}"
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)

    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})

    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"Gmail API error ({endpoint}): {e.code} {body[:200]}")
        return None


def notify(summary, channel="emails"):
    """Write a notification for the Discord bot to pick up."""
    entry = {
        "task": "gmail-watcher",
        "channel": channel,
        "summary": summary,
        "timestamp": datetime.datetime.now().isoformat(),
    }
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")


def main():
    state = load_state()
    token = get_access_token()

    # First run: backfill last 30 days. Subsequent runs: last 24h (covers missed runs/gaps).
    is_first_run = state.get("total_emails_indexed", 0) < 20
    if is_first_run:
        query = "newer_than:30d"
        max_results = 200
        print("First run detected — backfilling last 30 days")
    else:
        query = "newer_than:1d"
        max_results = 50
    result = gmail_api("messages", token, {"q": query, "maxResults": max_results})

    if not result or "messages" not in result:
        print("No new messages")
        state["last_run"] = datetime.datetime.now().isoformat()
        save_state(state)
        return

    messages = result["messages"]
    new_count = 0
    summaries = []

    # Index into email_index table
    db = sqlite3.connect(DB_PATH)

    for msg_stub in messages:
        msg_id = msg_stub["id"]

        # Check if already indexed
        existing = db.execute(
            "SELECT message_id FROM email_index WHERE message_id = ?", (msg_id,)
        ).fetchone()
        if existing:
            continue

        # Fetch full message
        msg_data = gmail_api(f"messages/{msg_id}", token, {"format": "metadata", "metadataHeaders": ["Subject", "From", "Date"]})
        if not msg_data:
            continue

        # Parse headers
        headers = {h["name"].lower(): h["value"] for h in msg_data.get("payload", {}).get("headers", [])}
        subject = headers.get("subject", "(no subject)")
        from_header = headers.get("from", "unknown")
        date = headers.get("date", "")

        # Parse sender
        sender_name = from_header
        sender_email = from_header
        if "<" in from_header:
            parts = from_header.split("<")
            sender_name = parts[0].strip().strip('"')
            sender_email = parts[1].strip(">")

        # Get snippet
        snippet = msg_data.get("snippet", "")

        # Index the email
        try:
            db.execute(
                """INSERT OR IGNORE INTO email_index
                (message_id, subject, sender_name, sender_email, received_at, snippet, indexed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (msg_id, subject, sender_name, sender_email,
                 datetime.datetime.now().isoformat(), snippet[:500],
                 datetime.datetime.now().isoformat()),
            )
            new_count += 1
            summaries.append(f"**{sender_name}**: {subject}")
        except Exception as e:
            print(f"Failed to index {msg_id}: {e}")

    db.commit()

    # Check watched senders against newly indexed emails (no extra API calls)
    watched = db.execute("SELECT email, label, discord_channel FROM watched_senders").fetchall()
    if watched and new_count > 0:
        recent = db.execute(
            "SELECT sender_email, sender_name, subject FROM email_index ORDER BY indexed_at DESC LIMIT ?",
            (new_count,),
        ).fetchall()
        for sender_email, sender_name, subject in recent:
            for w_email, w_label, w_channel in watched:
                if w_email.lower() in sender_email.lower():
                    notify(f"**{w_label}** sent an email: {subject}", w_channel or "emails")

    db.close()

    # Notify if new emails found
    if new_count > 0:
        summary_text = f"**{new_count} new email(s) indexed**\n" + "\n".join(summaries[:10])
        if len(summaries) > 10:
            summary_text += f"\n... and {len(summaries) - 10} more"
        notify(summary_text)
        print(f"Indexed {new_count} new emails")
    else:
        print("No new emails to index")

    state["last_run"] = datetime.datetime.now().isoformat()
    state["total_emails_indexed"] = state.get("total_emails_indexed", 0) + new_count
    save_state(state)


if __name__ == "__main__":
    main()
