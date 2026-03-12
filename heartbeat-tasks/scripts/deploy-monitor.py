#!/usr/bin/env python3
"""Monitor Vercel deployments for failures.

Reads project list from heartbeat-tasks/projects.json and checks
all projects with vercel_project: true.
"""

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
PROJECTS_FILE = os.path.join(TASKS_DIR, "projects.json")


def load_projects():
    """Load projects with vercel_project: true from projects.json."""
    if not os.path.exists(PROJECTS_FILE):
        print("No projects.json found. Copy projects.example.json and configure.", file=sys.stderr)
        return {}
    with open(PROJECTS_FILE) as f:
        data = json.load(f)
    return {
        name: cfg for name, cfg in data.get("projects", {}).items()
        if cfg.get("vercel_project")
    }


def resolve_path(path_str):
    """Resolve $HOME and $HARNESS_ROOT in path strings."""
    path_str = path_str.replace("$HOME", os.environ.get("HOME", ""))
    path_str = path_str.replace("$HARNESS_ROOT", HARNESS_ROOT)
    return path_str


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {}


def save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.rename(tmp, STATE_FILE)


def notify(message):
    notification = {
        "task": "deploy-monitor",
        "channel": "notifications",
        "summary": message,
        "timestamp": datetime.datetime.now().isoformat(),
    }
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(notification) + "\n")


def get_latest_deployment(project_dir):
    """Get the latest deployment status from Vercel."""
    try:
        result = subprocess.run(
            ["vercel", "list", "--cwd", project_dir, "-F", "json"],
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
    projects = load_projects()
    if not projects:
        print("No Vercel projects configured.")
        return

    state = load_state()

    for name, cfg in projects.items():
        project_dir = resolve_path(cfg["path"])
        print(f"Checking {name} ({project_dir})...")

        status, url = get_latest_deployment(project_dir)
        if status is None:
            print(f"  Could not fetch deployment status for {name}")
            continue

        print(f"  Latest: {url} — status: {status}")

        proj_state = state.get(name, {})
        prev_status = proj_state.get("last_status")

        # Notify on failure
        if status in ("ERROR", "FAILED", "CANCELED") and prev_status != status:
            notify(f"{name} deployment FAILED: {url} (status: {status})")
            print("  ALERT: Deployment failure detected, notification sent")

        # Notify on recovery
        if status == "READY" and prev_status in ("ERROR", "FAILED", "CANCELED"):
            notify(f"{name} deployment recovered: {url} is now READY")
            print("  RECOVERY: Deployment recovered, notification sent")

        state[name] = {"last_status": status, "last_url": url}

    save_state(state)


if __name__ == "__main__":
    main()
