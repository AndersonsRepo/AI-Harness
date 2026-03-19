#!/usr/bin/env python3
"""Checks if the Discord bot is alive. Restarts via platform scheduler if dead."""

import subprocess
import os
import sys

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from lib.platform import proc, paths, scheduler, IS_MACOS

PID_FILE = os.path.join(HARNESS_ROOT, "bridges", "discord", ".bot.pid")
BOT_LABEL = "com.aiharness.discord-bot"


def is_process_alive(pid):
    """Check if a process with the given PID exists."""
    return proc.is_alive(pid)


def get_bot_status():
    """Check scheduler status for the bot service."""
    status = scheduler.status(BOT_LABEL)
    return status.pid, status.state


def restart_bot():
    """Restart the bot via platform scheduler."""
    if not scheduler.is_available():
        print(f"Scheduler ({scheduler.name()}) not available")
        return False

    # Try kickstart first (immediate restart without unload/load)
    if scheduler.kickstart(BOT_LABEL):
        print(f"Restarted bot via {scheduler.name()} kickstart")
        return True

    # Fallback: reload (unload + load)
    if scheduler.reload(BOT_LABEL):
        print(f"Restarted bot via {scheduler.name()} reload")
        return True

    print(f"Failed to restart bot via {scheduler.name()}")
    return False


def main():
    checks = []

    # Check 1: PID file
    if os.path.exists(PID_FILE):
        try:
            pid = int(open(PID_FILE).read().strip())
            alive = is_process_alive(pid)
            checks.append(f"PID file: {pid} ({'alive' if alive else 'DEAD'})")
            if not alive:
                # Clean up stale PID file
                os.remove(PID_FILE)
                checks.append("Cleaned up stale PID file")
        except (ValueError, IOError) as e:
            checks.append(f"PID file unreadable: {e}")
    else:
        checks.append("PID file: missing")

    # Check 2: Scheduler status
    sched_pid, sched_state = get_bot_status()
    checks.append(f"{scheduler.name()}: {sched_state}" + (f" (PID {sched_pid})" if sched_pid else ""))

    # Determine health
    pid_alive = os.path.exists(PID_FILE)  # we cleaned it up above if dead
    bot_healthy = pid_alive or sched_pid is not None

    if bot_healthy:
        print(f"Bot is healthy")
    else:
        print("Bot appears DOWN — attempting restart")
        restarted = restart_bot()
        checks.append(f"Restart: {'success' if restarted else 'FAILED'}")

    for check in checks:
        print(f"  {check}")

    # Check 3: Detect and reload stale heartbeat agents
    stale_reloaded = scheduler.reload_stale()
    if stale_reloaded:
        checks.append(f"Reloaded {len(stale_reloaded)} stale agent(s): {', '.join(stale_reloaded)}")
        print(f"  Reloaded {len(stale_reloaded)} stale agents: {', '.join(stale_reloaded)}")

    summary = "; ".join(checks)
    print(f"\nHealth: {'OK' if bot_healthy else 'RESTARTED'} — {summary}")


if __name__ == "__main__":
    main()
