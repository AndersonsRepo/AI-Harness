#!/usr/bin/env python3
"""Live State Sync — deterministically refreshes vault/LIVE_STATE.md.

Reads infrastructure state from heartbeat configs, state files, task queue,
dead letters, and project registry. Preserves agent-written subjective
sections (focus, blockers, decisions) while keeping factual sections fresh.

This script is deterministic — no LLM calls. It reads source data and
writes markdown. Fast and free.

Usage:
    python3 live-state-sync.py           # Update LIVE_STATE.md
    python3 live-state-sync.py --dry-run # Show what would be written
"""

import json
import os
import sys
import re
import sqlite3
import datetime
import argparse

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
VAULT_DIR = os.path.join(HARNESS_ROOT, "vault")
LIVE_STATE_FILE = os.path.join(VAULT_DIR, "LIVE_STATE.md")
PROJECTS_FILE = os.path.join(TASKS_DIR, "projects.json")
DB_PATH = os.path.join(HARNESS_ROOT, "bridges", "discord", "harness.db")
NOTIFY_FILE = os.path.join(TASKS_DIR, "pending-notifications.jsonl")

STALE_HOURS = 48

# ─── Data Collection ──────────────────────────────────────────────────


def load_projects() -> dict:
    if not os.path.exists(PROJECTS_FILE):
        return {}
    with open(PROJECTS_FILE) as f:
        return json.load(f).get("projects", {})


def load_heartbeat_health() -> dict:
    """Scan heartbeat configs + state files for health summary."""
    failing = []
    stale = []
    healthy = 0
    disabled = 0
    total = 0
    now = datetime.datetime.now()

    if not os.path.exists(TASKS_DIR):
        return {"failing": [], "stale": [], "healthy": 0, "disabled": 0, "total": 0}

    for f in sorted(os.listdir(TASKS_DIR)):
        if not f.endswith(".json") or ".state" in f or f == "projects.json" or f.startswith("course-map"):
            continue

        total += 1
        name = f.replace(".json", "")

        try:
            with open(os.path.join(TASKS_DIR, f)) as fh:
                config = json.load(fh)
        except (json.JSONDecodeError, IOError):
            continue

        if not config.get("enabled", True):
            disabled += 1
            continue

        # Check state
        state_file = os.path.join(TASKS_DIR, f"{name}.state.json")
        if not os.path.exists(state_file):
            stale.append(name)
            continue

        try:
            with open(state_file) as sf:
                state = json.load(sf)
        except (json.JSONDecodeError, IOError):
            stale.append(name)
            continue

        failures = state.get("consecutive_failures", 0)
        last_run = state.get("last_run")

        if failures >= 2:
            failing.append(f"{name} ({failures} failures)")
        elif last_run:
            try:
                lr = datetime.datetime.fromisoformat(last_run.replace("Z", "+00:00"))
                if lr.tzinfo:
                    lr = lr.replace(tzinfo=None)
                age_hours = (now - lr).total_seconds() / 3600
                if age_hours > STALE_HOURS:
                    stale.append(name)
                else:
                    healthy += 1
            except (ValueError, TypeError):
                stale.append(name)
        else:
            stale.append(name)

    return {
        "failing": failing,
        "stale": stale,
        "healthy": healthy,
        "disabled": disabled,
        "total": total,
    }


def load_queue_stats() -> dict:
    """Read task queue and dead letter stats from SQLite."""
    stats = {"dead_letters": 0, "dead_queue": 0, "running": 0, "work_pending": 0, "work_evaluating": 0}

    if not os.path.exists(DB_PATH):
        return stats

    try:
        conn = sqlite3.connect(DB_PATH, timeout=5)
        conn.execute("PRAGMA journal_mode=WAL")

        # Dead letter count
        try:
            row = conn.execute("SELECT COUNT(*) FROM dead_letter").fetchone()
            stats["dead_letters"] = row[0] if row else 0
        except sqlite3.OperationalError:
            pass

        # Task queue dead + running
        try:
            for row in conn.execute("SELECT status, COUNT(*) FROM task_queue WHERE status IN ('dead', 'running') GROUP BY status"):
                if row[0] == "dead":
                    stats["dead_queue"] = row[1]
                elif row[0] == "running":
                    stats["running"] = row[1]
        except sqlite3.OperationalError:
            pass

        # Work queue pending + evaluating
        try:
            for row in conn.execute("SELECT status, COUNT(*) FROM work_queue WHERE status IN ('pending', 'gated', 'evaluating') GROUP BY status"):
                if row[0] in ("pending", "gated"):
                    stats["work_pending"] += row[1]
                elif row[0] == "evaluating":
                    stats["work_evaluating"] = row[1]
        except sqlite3.OperationalError:
            pass

        conn.close()
    except Exception:
        pass

    return stats


def check_bot_running() -> bool:
    """Check if the Discord bot PID file exists and process is alive."""
    pid_file = os.path.join(HARNESS_ROOT, "bridges", "discord", ".bot.pid")
    if not os.path.exists(pid_file):
        return False
    try:
        with open(pid_file) as f:
            pid = int(f.read().strip())
        os.kill(pid, 0)  # Check if process exists
        return True
    except (ValueError, ProcessLookupError, PermissionError, IOError):
        return False


# ─── LIVE_STATE.md Generation ─────────────────────────────────────────


def parse_existing_live_state() -> dict:
    """Parse existing LIVE_STATE.md to preserve agent-written content.

    Returns a dict of section_name -> content for sections we should preserve.
    """
    preserved = {}

    if not os.path.exists(LIVE_STATE_FILE):
        return preserved

    with open(LIVE_STATE_FILE) as f:
        content = f.read()

    # Sections we preserve (agent-written, subjective):
    # - Active Projects (per-project focus, blockers, status — agents update these)
    # - Priorities
    # - Recent Decisions
    # - Courses
    preserve_sections = {"Active Projects", "Priorities", "Recent Decisions", "Courses"}

    current_section = None
    current_lines = []

    for line in content.split("\n"):
        if line.startswith("## "):
            if current_section and current_section in preserve_sections:
                preserved[current_section] = "\n".join(current_lines).strip()
            current_section = line[3:].strip()
            current_lines = []
        else:
            current_lines.append(line)

    # Don't forget last section
    if current_section and current_section in preserve_sections:
        preserved[current_section] = "\n".join(current_lines).strip()

    return preserved


def build_live_state() -> str:
    """Build the full LIVE_STATE.md content."""
    preserved = parse_existing_live_state()
    heartbeat = load_heartbeat_health()
    queue = load_queue_stats()
    bot_alive = check_bot_running()

    lines = [
        "# Live State",
        "",
        "> This file is the single source of truth for what's happening right now.",
        "> Agents update it during sessions. The context assembler injects relevant",
        "> sections based on keyword matching and resolves [[wikilinks]] to pull in",
        "> deeper context on demand.",
        ">",
        "> Keep entries short. Use [[wikilinks]] to reference detailed knowledge.",
        "> Sections with no recent updates should be marked stale or removed.",
        "",
    ]

    # Active Projects — preserve agent-written content
    lines.append("## Active Projects")
    lines.append("")
    if "Active Projects" in preserved:
        lines.append(preserved["Active Projects"])
    else:
        # Generate from projects.json if no existing content
        projects = load_projects()
        for name, config in projects.items():
            lines.append(f"### {name.replace('-', ' ').title()}")
            lines.append(f"- **Status**: Unknown — needs agent update")
            lines.append(f"- **Links**: [[{name}.md]]")
            lines.append("")
    lines.append("")

    # Priorities — preserve agent-written
    lines.append("## Priorities")
    lines.append("")
    if "Priorities" in preserved:
        lines.append(preserved["Priorities"])
    else:
        lines.append("1. (No priorities set — agent should update this)")
    lines.append("")

    # Infrastructure Health — deterministic, always regenerated
    lines.append("## Infrastructure Health")
    lines.append("")
    lines.append(f"- **Bot**: {'Running' if bot_alive else 'Not running (no PID or process dead)'}")

    hb_parts = []
    if heartbeat["failing"]:
        hb_parts.append(f"{len(heartbeat['failing'])} failing ({', '.join(heartbeat['failing'][:5])})")
    if heartbeat["stale"]:
        hb_parts.append(f"{len(heartbeat['stale'])} stale >48h")
    hb_parts.append(f"{heartbeat['healthy']} healthy")
    if heartbeat["disabled"]:
        hb_parts.append(f"{heartbeat['disabled']} disabled")
    lines.append(f"- **Heartbeats**: {', '.join(hb_parts)} (of {heartbeat['total']} total)")

    queue_parts = []
    if queue["dead_letters"]:
        queue_parts.append(f"{queue['dead_letters']} dead letters")
    if queue["dead_queue"]:
        queue_parts.append(f"{queue['dead_queue']} dead queue entries")
    if queue["running"]:
        queue_parts.append(f"{queue['running']} running")
    if queue_parts:
        lines.append(f"- **Task queue**: {', '.join(queue_parts)}")

    work_parts = []
    if queue["work_pending"]:
        work_parts.append(f"{queue['work_pending']} pending")
    if queue["work_evaluating"]:
        work_parts.append(f"{queue['work_evaluating']} evaluating")
    if work_parts:
        lines.append(f"- **Work queue**: {', '.join(work_parts)}")

    lines.append(f"- **Links**: [[LRN-heartbeat-auto-pause]] [[LRN-oauth-token-refresh]]")
    lines.append(f"- **Last synced**: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append("")

    # Courses — preserve agent-written
    lines.append("## Courses (Spring 2026)")
    lines.append("")
    if "Courses" in preserved:
        lines.append(preserved["Courses"])
    else:
        lines.append("- **Numerical Methods**: [[numerical-methods/]]")
        lines.append("- **Philosophy**: [[philosophy/]]")
        lines.append("- **Systems Programming (CS 2600)**: [[systems-programming/]]")
        lines.append("- **Computers and Society**: [[comp-society/]]")
    lines.append("")

    # Recent Decisions — preserve agent-written
    lines.append("## Recent Decisions")
    lines.append("")
    if "Recent Decisions" in preserved:
        lines.append(preserved["Recent Decisions"])
    else:
        lines.append("- (No decisions recorded — agents should update this)")
    lines.append("")

    return "\n".join(lines)


# ─── Main ─────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Live State Sync")
    parser.add_argument("--dry-run", action="store_true", help="Show output without writing")
    args = parser.parse_args()

    content = build_live_state()

    if args.dry_run:
        print(content)
        print(f"\n--- Would write {len(content)} chars to {LIVE_STATE_FILE}")
        return

    # Atomic write
    tmp = LIVE_STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        f.write(content)
    os.rename(tmp, LIVE_STATE_FILE)

    print(f"Updated {LIVE_STATE_FILE} ({len(content)} chars)")
    print(f"  Bot: {'running' if check_bot_running() else 'not running'}")
    hb = load_heartbeat_health()
    print(f"  Heartbeats: {hb['healthy']} healthy, {len(hb['failing'])} failing, {len(hb['stale'])} stale")


if __name__ == "__main__":
    main()
