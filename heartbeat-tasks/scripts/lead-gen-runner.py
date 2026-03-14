#!/usr/bin/env python3
"""Lead Generation Pipeline — Heartbeat Runner

Runs the lead-gen pipeline on a rotating schedule. Each invocation processes
a batch of niche×city combos rather than the full matrix, spreading costs
and runtime across multiple heartbeat cycles.

Rotation strategy:
  - Maintains a pointer to the next batch in state file
  - Each run processes 1 niche × all cities (or a subset)
  - Full rotation through all niches takes ~1 week at 12h intervals
"""

import json
import os
import sys
import subprocess
import datetime

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
STATE_FILE = os.path.join(TASKS_DIR, "lead-gen-pipeline.state.json")
NOTIFY_FILE = os.path.join(HARNESS_ROOT, "pending-notifications.jsonl")
PIPELINE_DIR = os.path.expanduser("~/Desktop/lead_gen_pipeline")


def load_state():
    """Load rotation state."""
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"niche_index": 0, "last_run": None, "runs_completed": 0}


def save_state(state):
    """Save rotation state."""
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def notify(title, message, channel="lead-gen-pipeline"):
    """Write a notification for the bot to pick up."""
    entry = {
        "task": "lead-gen-pipeline",
        "channel": channel,
        "summary": f"**{title}**\n{message}",
        "timestamp": datetime.datetime.now().isoformat(),
    }
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")


def get_niches():
    """Get niche list from config."""
    try:
        sys.path.insert(0, PIPELINE_DIR)
        import config
        return [n["name"] for n in config.NICHES]
    except Exception as e:
        print(f"Failed to load config: {e}", file=sys.stderr)
        return []


def main():
    state = load_state()
    niches = get_niches()

    if not niches:
        print("No niches configured")
        notify("Pipeline Error", "No niches configured in lead_gen_pipeline/config.py")
        return

    # Pick the next niche in rotation
    idx = state["niche_index"] % len(niches)
    niche = niches[idx]

    print(f"Running pipeline for niche: {niche} (index {idx}/{len(niches)})")

    # Run the pipeline for this niche
    try:
        result = subprocess.run(
            [
                sys.executable, "pipeline.py",
                "--niche", niche,
                "--dry-run",  # Start with dry-run until Stripe is configured
                "--notify",
            ],
            cwd=PIPELINE_DIR,
            capture_output=True,
            text=True,
            timeout=1500,  # 25 min timeout
        )

        if result.returncode == 0:
            # Parse stats from last_run_stats.json
            stats_path = os.path.join(PIPELINE_DIR, "output", "last_run_stats.json")
            stats_msg = ""
            if os.path.exists(stats_path):
                with open(stats_path) as f:
                    stats = json.load(f)
                stats_msg = (
                    f"**{niche}** pipeline complete\n"
                    f"Leads: {stats.get('total_leads', 0)} new, "
                    f"{stats.get('returning_leads', 0)} returning\n"
                    f"Emails: {stats.get('total_emails', 0)}\n"
                    f"Avg score: {stats.get('avg_score', 0)}\n"
                    f"Files: {stats.get('total_files', 0)}\n"
                    f"Time: {stats.get('elapsed_seconds', 0):.0f}s"
                )
            else:
                stats_msg = f"**{niche}** pipeline completed (no stats file)"

            print(stats_msg)
            # Notification is handled by pipeline.py --notify flag
        else:
            error_msg = result.stderr[-500:] if result.stderr else "Unknown error"
            print(f"Pipeline failed: {error_msg}", file=sys.stderr)
            notify("Pipeline Failed", f"**{niche}** failed:\n```\n{error_msg}\n```")

    except subprocess.TimeoutExpired:
        print(f"Pipeline timed out for {niche}", file=sys.stderr)
        notify("Pipeline Timeout", f"**{niche}** timed out after 25 minutes")
    except Exception as e:
        print(f"Pipeline error: {e}", file=sys.stderr)
        notify("Pipeline Error", f"**{niche}** error: {e}")

    # Advance rotation
    state["niche_index"] = idx + 1
    state["last_run"] = datetime.datetime.now().isoformat()
    state["last_niche"] = niche
    state["runs_completed"] = state.get("runs_completed", 0) + 1
    save_state(state)

    print(f"Next niche: {niches[(idx + 1) % len(niches)]}")


if __name__ == "__main__":
    main()
