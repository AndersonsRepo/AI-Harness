#!/usr/bin/env python3
"""Checks if the Discord bot is alive. Restarts via launchctl if dead."""

import subprocess
import os
import signal

HARNESS_ROOT = os.environ.get("HARNESS_ROOT", "$HOME/.local/ai-harness")
PID_FILE = os.path.join(HARNESS_ROOT, "bridges", "discord", ".bot.pid")
PLIST_LABEL = "com.aiharness.discord-bot"


def is_process_alive(pid):
    """Check if a process with the given PID exists."""
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def get_launchctl_status():
    """Check launchd status for the bot service."""
    result = subprocess.run(
        ["launchctl", "list", PLIST_LABEL],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return None, "not loaded"

    # Parse the output for PID and status
    for line in result.stdout.split("\n"):
        line = line.strip()
        if '"PID"' in line:
            try:
                pid = int(line.split("=")[1].strip().rstrip(";"))
                return pid, "running"
            except (ValueError, IndexError):
                pass
    return None, "loaded but not running"


def restart_bot():
    """Restart the bot via launchctl."""
    plist_path = os.path.expanduser(
        f"~/Library/LaunchAgents/{PLIST_LABEL}.plist"
    )

    # Try kickstart first (restarts without unload/load cycle)
    result = subprocess.run(
        ["launchctl", "kickstart", "-k", f"gui/{os.getuid()}/{PLIST_LABEL}"],
        capture_output=True, text=True,
    )
    if result.returncode == 0:
        print("Restarted bot via launchctl kickstart")
        return True

    # Fallback: unload + load
    subprocess.run(["launchctl", "unload", plist_path], capture_output=True)
    result = subprocess.run(
        ["launchctl", "load", plist_path],
        capture_output=True, text=True,
    )
    if result.returncode == 0:
        print("Restarted bot via unload/load")
        return True

    print(f"Failed to restart bot: {result.stderr}")
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

    # Check 2: launchctl status
    lc_pid, lc_status = get_launchctl_status()
    checks.append(f"launchctl: {lc_status}" + (f" (PID {lc_pid})" if lc_pid else ""))

    # Determine health
    pid_alive = os.path.exists(PID_FILE)  # we cleaned it up above if dead
    bot_healthy = pid_alive or lc_pid is not None

    if bot_healthy:
        print(f"Bot is healthy")
    else:
        print("Bot appears DOWN — attempting restart")
        restarted = restart_bot()
        checks.append(f"Restart: {'success' if restarted else 'FAILED'}")

    for check in checks:
        print(f"  {check}")

    summary = "; ".join(checks)
    print(f"\nHealth: {'OK' if bot_healthy else 'RESTARTED'} — {summary}")


if __name__ == "__main__":
    main()
