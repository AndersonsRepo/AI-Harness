#!/usr/bin/env python3
"""Checks if the Discord bot is alive. Restarts via platform scheduler if dead.

Also probes locally-registered MCP servers via `claude mcp list` and notifies
Discord on transitions (new failure or recovery). Backstop for the silent-
failure pattern logged in
vault/learnings/ERR-mcp-servers-not-built-after-worktree-creation-2026-04-25.
"""

import datetime
import hashlib
import json
import plistlib
import re
import shutil
import sqlite3
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

TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
NOTIFY_FILE = os.path.join(HARNESS_ROOT, "bridges", "discord", "pending-notifications.jsonl")
MCP_STATE_FILE = os.path.join(TASKS_DIR, "health-check.state.json")

# Phase F chat-render soak monitor (runtime-abstraction plan). Watches the
# rendered general-chat path for anomalies; alert-only, self-disables when the
# `chat` flag is off. Remove this + the Check 5 block once Phase G lands.
BOT_LOG = os.path.join(HARNESS_ROOT, "bridges", "discord", "bot.log")
DB_PATH = os.path.join(HARNESS_ROOT, "bridges", "discord", "harness.db")
BOT_PLIST = os.path.expanduser("~/Library/LaunchAgents/com.aiharness.discord-bot.plist")
RENDER_SITE_RE = re.compile(r"renderContext|buildClaudeConfigFromContext|buildCodexConfigFromContext|contextToClaudeOpts|RENDER_PARITY MISMATCH", re.I)
ERR_TOKEN_RE = re.compile(r"error|exception|throw|MISMATCH|cannot read|is not a function|undefined", re.I)


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


def _resolve_claude_cli():
    """Find the `claude` executable. launchd's PATH is sparse."""
    candidate = shutil.which("claude")
    if candidate:
        return candidate
    for path in (
        os.path.expanduser("~/.local/bin/claude"),
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
    ):
        if os.path.exists(path):
            return path
    return None


def check_mcp_servers():
    """
    Run `claude mcp list` and return failed *locally-registered* MCP servers.

    Filters to entries whose command path contains 'mcp-servers/' (i.e. our own
    Node servers under the repo). Remote SSE/HTTP servers and third-party
    stdio servers (codex, context7) are skipped — transient remote failures
    are not actionable from a heartbeat script.

    Returns (failed: list[str], note: str | None). `note` carries diagnostics
    when the probe itself couldn't run (no claude CLI, timeout, etc.).
    """
    claude = _resolve_claude_cli()
    if not claude:
        return [], "claude CLI not found on PATH"

    try:
        result = subprocess.run(
            [claude, "mcp", "list"],
            capture_output=True,
            text=True,
            timeout=20,
        )
    except subprocess.TimeoutExpired:
        return [], "claude mcp list timed out (>20s)"
    except OSError as e:
        return [], f"claude mcp list failed: {e}"

    if result.returncode != 0:
        return [], f"claude mcp list exit {result.returncode}: {result.stderr.strip()[:200]}"

    failed = []
    for line in result.stdout.splitlines():
        # Lines look like:
        #   vault: node /…/mcp-servers/mcp-vault/dist/index.js - ✓ Connected
        # or:
        #   vault: node /…/mcp-servers/mcp-vault/dist/index.js - ✗ Failed to connect
        if "mcp-servers/" not in line:
            continue
        if ":" not in line:
            continue
        name = line.split(":", 1)[0].strip()
        if not name:
            continue
        if "Failed to connect" in line or "✗" in line:
            failed.append(name)
    return sorted(failed), None


def _load_mcp_state():
    try:
        with open(MCP_STATE_FILE, "r") as f:
            return json.load(f)
    except (IOError, ValueError):
        return {}


def _save_mcp_state(state):
    try:
        with open(MCP_STATE_FILE, "w") as f:
            json.dump(state, f, indent=2)
    except IOError as e:
        print(f"  Warning: could not write {MCP_STATE_FILE}: {e}")


def notify(title, body, channel="notifications"):
    entry = {
        "task": "health-check",
        "channel": channel,
        "summary": f"**{title}**\n{body}",
        "timestamp": datetime.datetime.now().isoformat(),
    }
    try:
        with open(NOTIFY_FILE, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except IOError as e:
        print(f"  Warning: could not write {NOTIFY_FILE}: {e}")


def _tail_lines(path, nbytes=200_000):
    """Read roughly the last nbytes of a (possibly large) log without loading it all."""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - nbytes))
            return f.read().decode("utf-8", "replace").splitlines()
    except IOError:
        return []


def _render_flag():
    """Current HARNESS_RENDER_CONTEXT from the bot's launchd plist."""
    try:
        with open(BOT_PLIST, "rb") as f:
            pl = plistlib.load(f)
        return pl.get("EnvironmentVariables", {}).get("HARNESS_RENDER_CONTEXT", "") or ""
    except Exception:
        return ""


def check_chat_render_path(state):
    """Soak monitor for the Phase F chat-rendered path. Alert-only-on-anomaly:
    a render-path exception in bot.log, or a spike of non-trivial task failures
    since the last run. Self-disables when the chat flag is off. Fully guarded —
    must never break the bot-liveness check above it."""
    flag = _render_flag()
    if "chat" not in flag and "all" not in flag:
        return "render: chat off (legacy path)"

    alerts = []

    # (a) Render-path exceptions in recent log lines, deduped across runs by a
    #     STABLE hash (md5 — Python's hash() is per-process salted).
    seen = set(state.get("render_alerted", []))
    log_hits = []
    for ln in _tail_lines(BOT_LOG):
        if RENDER_SITE_RE.search(ln) and ERR_TOKEN_RE.search(ln) and "RENDER_PARITY] match" not in ln:
            h = hashlib.md5(ln.strip().encode("utf-8", "replace")).hexdigest()[:12]
            if h not in seen:
                log_hits.append(ln.strip()[:200])
                seen.add(h)
    if log_hits:
        alerts.append("render-path errors in bot.log:\n" + "\n".join(f"  • {h}" for h in log_hits[:3]))
    state["render_alerted"] = list(seen)[-300:]

    # (b) Non-trivial task failures since last check (chat path = all spawnTask
    #     spawns; exclude routine signal-15 cancellations / stale-session retries).
    last = state.get("render_last_check")
    fail_count, samples = 0, []
    try:
        con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
        if last:
            rows = con.execute(
                "SELECT id, substr(COALESCE(last_error,''),1,80) FROM task_queue "
                "WHERE status IN ('failed','dead') AND updated_at > ? "
                "AND COALESCE(last_error,'') NOT LIKE '%signal 15%' "
                "AND COALESCE(last_error,'') NOT LIKE '%Cancelled%' "
                "AND COALESCE(last_error,'') NOT LIKE '%Stale session%'",
                (last,),
            ).fetchall()
            fail_count = len(rows)
            samples = [f"{r[0]}: {r[1]}" for r in rows[:3]]
        con.close()
    except sqlite3.Error:
        pass
    state["render_last_check"] = datetime.datetime.utcnow().isoformat()
    if fail_count >= 5:  # a handful is normal; a spike is the signal
        alerts.append(f"{fail_count} non-trivial task failures since last check:\n" +
                      "\n".join(f"  • {s}" for s in samples))

    if alerts:
        notify("⚠️ Chat-render path anomaly (Phase F soak)",
               "\n\n".join(alerts) +
               "\n\nRollback: set HARNESS_RENDER_CONTEXT=subagent in the bot plist + bootout/bootstrap. "
               "See plans/runtime-abstraction-completion-2026-05-26.md.")
    return f"render(chat): {fail_count} task-failures, {len(log_hits)} log-errors since last check"


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

    # Check 4: Local MCP server connectivity. Notify only on transitions so
    # we don't spam #notifications every 10 minutes when something breaks.
    failed_mcp, mcp_err = check_mcp_servers()
    state = _load_mcp_state()
    prev_failed = set(state.get("failed_mcp", []))
    curr_failed = set(failed_mcp)

    if mcp_err:
        checks.append(f"MCP probe: {mcp_err}")
        print(f"  MCP probe: {mcp_err}")
    elif curr_failed:
        checks.append(f"MCP failed ({len(curr_failed)}): {', '.join(sorted(curr_failed))}")
        print(f"  MCP failed: {', '.join(sorted(curr_failed))}")
    else:
        checks.append("MCP: all local servers ✓")

    new_failures = curr_failed - prev_failed
    recovered = prev_failed - curr_failed
    if new_failures or recovered:
        lines = []
        if new_failures:
            lines.append(f"❌ Failing: {', '.join(sorted(new_failures))}")
        if recovered:
            lines.append(f"✅ Recovered: {', '.join(sorted(recovered))}")
        still_down = curr_failed & prev_failed
        if still_down:
            lines.append(f"Still down: {', '.join(sorted(still_down))}")
        lines.append("\nFix: `cd ~/Desktop/AI-Harness-private-runtime && ./scripts/bootstrap-mcp-servers.sh`")
        notify("MCP server status changed", "\n".join(lines))

    # Check 5: Phase F chat-rendered path soak monitor. Guarded — a bug here
    # must never take down the liveness/restart logic above.
    try:
        render_status = check_chat_render_path(state)
        checks.append(render_status)
        print(f"  {render_status}")
    except Exception as e:  # noqa: BLE001
        print(f"  render check error (non-fatal): {e}")

    state["failed_mcp"] = sorted(curr_failed)
    state["last_mcp_check"] = datetime.datetime.now().isoformat()
    _save_mcp_state(state)

    summary = "; ".join(checks)
    print(f"\nHealth: {'OK' if bot_healthy else 'RESTARTED'} — {summary}")


if __name__ == "__main__":
    main()
