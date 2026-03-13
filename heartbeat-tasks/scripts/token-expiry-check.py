#!/usr/bin/env python3
"""
Token Expiry Check — heartbeat script

Checks all OAuth tokens in the database and notifies Discord
when any token is expiring within 7 days. For tokens without
refresh capability, this is the only warning before re-auth is needed.

Schedule: every 24h
"""

import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

HARNESS_ROOT = os.environ.get("HARNESS_ROOT", ".")
DB_PATH = os.path.join(HARNESS_ROOT, "bridges", "discord", "harness.db")
NOTIFY_FILE = os.path.join(HARNESS_ROOT, "heartbeat-tasks", "pending-notifications.jsonl")
STATE_FILE = os.path.join(HARNESS_ROOT, "heartbeat-tasks", "token-expiry-check.state.json")

WARN_DAYS = 7  # Notify when token expires within this many days


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"last_notified": {}}


def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def notify(summary: str):
    entry = json.dumps({
        "task": "token-expiry",
        "channel": "notifications",
        "summary": summary,
        "timestamp": datetime.now().isoformat(),
    })
    with open(NOTIFY_FILE, "a") as f:
        f.write(entry + "\n")


def main():
    if not os.path.exists(DB_PATH):
        print(f"Database not found: {DB_PATH}")
        return

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    try:
        rows = conn.execute(
            "SELECT provider, expires_at, refresh_token, scopes FROM oauth_tokens"
        ).fetchall()
    except sqlite3.OperationalError:
        print("oauth_tokens table does not exist yet")
        return
    finally:
        conn.close()

    if not rows:
        print("No OAuth tokens found")
        return

    state = load_state()
    now = datetime.now(timezone.utc)
    alerts = []

    for row in rows:
        provider = row["provider"]
        expires_at_str = row["expires_at"]
        refresh_token = row["refresh_token"]
        has_refresh = refresh_token and refresh_token != "none"

        try:
            # Parse ISO datetime (may or may not have timezone)
            expires_at_str_clean = expires_at_str.replace("Z", "+00:00")
            if "+" not in expires_at_str_clean and "T" in expires_at_str_clean:
                expires_at = datetime.fromisoformat(expires_at_str_clean).replace(tzinfo=timezone.utc)
            else:
                expires_at = datetime.fromisoformat(expires_at_str_clean)
        except (ValueError, TypeError):
            alerts.append(f"**{provider}**: Could not parse expiry date `{expires_at_str}`")
            continue

        days_left = (expires_at - now).total_seconds() / 86400

        if days_left <= 0:
            status = "EXPIRED"
            emoji = "🔴"
        elif days_left <= WARN_DAYS:
            status = f"expires in {days_left:.1f} days"
            emoji = "🟡"
        else:
            # Token is fine
            print(f"{provider}: {days_left:.0f} days remaining — OK")
            # Clear any previous notification tracking
            state["last_notified"].pop(provider, None)
            continue

        # Check if we already notified today for this provider
        last_notified = state["last_notified"].get(provider, "")
        today = now.strftime("%Y-%m-%d")
        if last_notified == today:
            print(f"{provider}: Already notified today, skipping")
            continue

        refresh_note = ""
        if has_refresh:
            refresh_note = " (has refresh token — will auto-refresh)"
        else:
            refresh_note = " (**no refresh token** — manual re-auth required)"

        action = ""
        if not has_refresh:
            action = f"\n\nRe-authenticate: `cd ~/Desktop/AI-Harness/bridges/discord && npx tsx oauth-setup.ts {provider}`"

        alerts.append(f"{emoji} **{provider}** — {status}{refresh_note}{action}")
        state["last_notified"][provider] = today

    if alerts:
        summary = "**OAuth Token Expiry Warning**\n\n" + "\n\n".join(alerts)
        notify(summary)
        print(f"Sent {len(alerts)} expiry alert(s)")
    else:
        print("All tokens OK")

    save_state(state)


if __name__ == "__main__":
    main()
