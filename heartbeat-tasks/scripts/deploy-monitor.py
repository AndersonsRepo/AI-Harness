#!/usr/bin/env python3
"""Monitor Hey Lexxi Vercel deployments for failures."""

import subprocess
import json
import os
import sys
import datetime

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
STATE_FILE = os.path.join(TASKS_DIR, "deploy-monitor.vercel-state.json")
NOTIFY_FILE = os.path.join(TASKS_DIR, "pending-notifications.jsonl")
PROJECT_DIR = os.environ.get("HEY_LEXXI_DIR", os.path.join(os.environ.get("HOME", ""), "Desktop", "Hey-Lexxi-prod"))


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"last_status": None, "last_url": None}


def save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.rename(tmp, STATE_FILE)


def notify(message):
    notification = {
        "task": "deploy-monitor",
        "channel": "general",
        "summary": message,
        "timestamp": datetime.datetime.now().isoformat(),
    }
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(notification) + "\n")


def get_latest_deployment():
    """Get the latest deployment status from Vercel."""
    try:
        result = subprocess.run(
            ["vercel", "list", "--cwd", PROJECT_DIR, "-F", "json"],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            return None, None

        # vercel outputs status text before JSON — find the JSON object
        stdout = result.stdout
        json_start = stdout.find("{")
        if json_start == -1:
            json_start = stdout.find("[")
        if json_start == -1:
            return None, None
        data = json.loads(stdout[json_start:])
        deployments = data if isinstance(data, list) else data.get("deployments", [])
        if not deployments:
            return None, None

        latest = deployments[0]
        status = latest.get("state", latest.get("readyState", "unknown"))
        url = latest.get("url", "unknown")
        return status, url
    except Exception as e:
        print(f"Error fetching deployments: {e}", file=sys.stderr)
        return None, None


def main():
    prev = load_state()
    status, url = get_latest_deployment()

    if status is None:
        print("Could not fetch deployment status")
        return

    print(f"Latest deployment: {url} — status: {status}")

    prev_status = prev.get("last_status")

    # Notify on failure
    if status in ("ERROR", "FAILED", "CANCELED") and prev_status != status:
        notify(f"Hey Lexxi deployment FAILED: {url} (status: {status})")
        print("ALERT: Deployment failure detected, notification sent")

    # Notify on recovery
    if status == "READY" and prev_status in ("ERROR", "FAILED", "CANCELED"):
        notify(f"Hey Lexxi deployment recovered: {url} is now READY")
        print("RECOVERY: Deployment recovered, notification sent")

    save_state({"last_status": status, "last_url": url})


if __name__ == "__main__":
    main()
