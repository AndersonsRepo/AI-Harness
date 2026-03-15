#!/usr/bin/env python3
"""
Heartbeat script: Monitor lead enrichment progress.
Posts status to Discord and auto-disables when enrichment finishes.
"""
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

HARNESS_ROOT = Path(__file__).parent.parent.parent
PIPELINE_ROOT = Path.home() / "Desktop" / "lead_gen_pipeline"
STATUS_SCRIPT = PIPELINE_ROOT / "check_enrichment.py"
TASK_CONFIG = HARNESS_ROOT / "heartbeat-tasks" / "enrichment-monitor.json"
NOTIFICATIONS = HARNESS_ROOT / "pending-notifications.jsonl"


def notify(message, channel="lead-gen-pipeline"):
    with open(NOTIFICATIONS, "a") as f:
        f.write(json.dumps({"channel": channel, "message": message}) + "\n")


def main():
    # Run the status checker
    result = subprocess.run(
        [sys.executable, str(STATUS_SCRIPT)],
        capture_output=True, text=True, timeout=30
    )

    if result.returncode != 0:
        print(f"Status check failed: {result.stderr}")
        notify("Enrichment monitor: status check failed")
        return

    try:
        status = json.loads(result.stdout)
    except json.JSONDecodeError:
        # Read from file instead
        status_file = PIPELINE_ROOT / ".enrichment-status.json"
        if status_file.exists():
            status = json.loads(status_file.read_text())
        else:
            print("No status available")
            return

    running = status.get("running", False)
    emails = status.get("emails", 0)
    email_pct = status.get("email_pct", 0)
    fb = status.get("facebook_urls", 0)
    gmap = status.get("google_maps", 0)
    avg_score = status.get("avg_score", 0)
    total = status.get("total_leads", 0)

    if running:
        msg = (
            f"**Enrichment In Progress**\n"
            f"Emails: {emails}/{total} ({email_pct}%)\n"
            f"Facebook URLs: {fb} | Google Maps: {gmap}\n"
            f"Avg Score: {avg_score}"
        )
        notify(msg)
        print(msg)
    else:
        msg = (
            f"**Enrichment Complete**\n"
            f"Final: {emails}/{total} emails ({email_pct}%)\n"
            f"Facebook URLs: {fb} | Google Maps: {gmap}\n"
            f"Avg Score: {avg_score}\n"
            f"Auto-disabling enrichment-monitor task."
        )
        notify(msg)
        print(msg)

        # Auto-disable this heartbeat task
        if TASK_CONFIG.exists():
            config = json.loads(TASK_CONFIG.read_text())
            config["enabled"] = False
            TASK_CONFIG.write_text(json.dumps(config, indent=2))
            print("Task auto-disabled.")


if __name__ == "__main__":
    main()
