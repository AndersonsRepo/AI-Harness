#!/usr/bin/env python3
"""Weekly per-role Claude vs Codex telemetry report.

Runs scripts/role-telemetry-report.ts over the last 7 days and posts
the result to a Discord channel via the heartbeat notification queue.
Pairs with the per-role telemetry CLI built in D5.2 Phase 1 — same
report, automated cadence so quality drift surfaces without manual
checks.
"""

import datetime
import json
import os
import subprocess
import sys

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
NOTIFY_FILE = os.path.join(TASKS_DIR, "pending-notifications.jsonl")
REPORT_SCRIPT = os.path.join(HARNESS_ROOT, "scripts", "role-telemetry-report.ts")


def notify(message: str, channel: str = "agent-stream") -> None:
    entry = {
        "task": "role-telemetry-weekly",
        "channel": channel,
        "summary": message,
        "timestamp": datetime.datetime.now().isoformat(),
    }
    os.makedirs(TASKS_DIR, exist_ok=True)
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")


def run_report() -> str:
    if not os.path.exists(REPORT_SCRIPT):
        return f"role-telemetry-report.ts not found at {REPORT_SCRIPT}"

    env = os.environ.copy()
    env["HARNESS_ROOT"] = HARNESS_ROOT
    try:
        result = subprocess.run(
            ["npx", "tsx", REPORT_SCRIPT, "--days", "7"],
            cwd=HARNESS_ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        return "role-telemetry-report timed out (>120s)"
    except FileNotFoundError:
        return "npx not found on PATH — install Node.js"

    if result.returncode != 0:
        return f"role-telemetry-report exited {result.returncode}\nstderr: {result.stderr.strip()[:500]}"

    return result.stdout.strip()


def main() -> int:
    report = run_report()
    if not report:
        print("empty report; skipping notification")
        return 0

    # Discord message limit is 2000 chars; the table rarely exceeds that for
    # a 7-day window but truncate defensively.
    body = report
    if len(body) > 1900:
        body = body[:1850] + "\n…(truncated, see CLI for full)"

    message = f"**Weekly role telemetry**\n```\n{body}\n```"
    notify(message)
    print(f"Queued report ({len(message)} chars) → #agent-stream")
    return 0


if __name__ == "__main__":
    sys.exit(main())
