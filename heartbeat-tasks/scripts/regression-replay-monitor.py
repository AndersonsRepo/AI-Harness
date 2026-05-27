#!/usr/bin/env python3
"""Regression-replay tier-1 monitor — commit-triggered structural-metrics check.

Runs the tier-1 TypeScript monitor (which re-runs context assembly for every
pinned seed and compares against baseline) when commits to watched paths are
detected. Writes a markdown scorecard per run and appends a row to the
timeline. Deterministic — no LLM calls.

State (persisted in heartbeat-tasks/regression-replay-monitor.state.json):
  last_run_sha:     git HEAD at last invocation; used to detect new commits
  last_outcome:     'ok' | 'noted' | 'flagged' | 'no_pins' | 'error'
  consecutive_failures: managed by heartbeat-runner

Designed to be invoked frequently (e.g., 30-60 min); idempotent if no
relevant commits land between invocations.
"""

import datetime
import json
import os
import subprocess
import sys
from pathlib import Path

HARNESS_ROOT = Path(
    os.environ.get(
        "HARNESS_ROOT",
        Path(__file__).resolve().parents[2],
    )
)
TASK_NAME = "regression-replay-monitor"
TASKS_DIR = HARNESS_ROOT / "heartbeat-tasks"
STATE_FILE = TASKS_DIR / f"{TASK_NAME}.state.json"
LOG_DIR = TASKS_DIR / "logs"
TS_ENTRY = (
    HARNESS_ROOT
    / "bridges"
    / "discord"
    / "tools"
    / "regression-replay"
    / "tier1-monitor.ts"
)
REPLAY_ROOT = HARNESS_ROOT / "vault" / "shared" / "regression-replay"
RUNS_DIR = REPLAY_ROOT / "runs"
TIMELINE_FILE = REPLAY_ROOT / "timeline.md"

WATCHED_PATHS = [
    "bridges/discord/context-assembler.ts",
    "bridges/discord/embeddings.ts",
    "bridges/discord/handoff-router.ts",
    "bridges/discord/task-runner.ts",
    "bridges/discord/claude-config.ts",
    "bridges/discord/codex-config.ts",
    "bridges/discord/role-policy.ts",
    "bridges/discord/agent-loader.ts",
]
WATCHED_GLOBS = [".claude/agents/"]  # prefix match

# Files whose changes also force a pinned-harness re-baseline (reported as a
# warning in the scorecard).
PINNED_HARNESS_PATHS = [
    "bridges/discord/claude-runner.py",
    "bridges/discord/codex-runner.py",
    "bridges/discord/context-assembler.ts",
    "bridges/discord/embeddings.ts",
    "bridges/discord/agent-loader.ts",
]


def log(msg: str) -> None:
    """Append timestamped message to task log file."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_file = LOG_DIR / f"{TASK_NAME}.log"
    ts = datetime.datetime.now().isoformat()
    line = f"[{ts}] {msg}\n"
    with open(log_file, "a") as f:
        f.write(line)
    if not os.environ.get("__LAUNCHED_BY_LAUNCHD"):
        print(line, end="")


def load_state() -> dict:
    if STATE_FILE.exists():
        with open(STATE_FILE) as f:
            return json.load(f)
    return {}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".json.tmp")
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_FILE)


def git(*args: str) -> str:
    """Run a git command in HARNESS_ROOT, return stripped stdout."""
    result = subprocess.run(
        ["git", *args],
        cwd=HARNESS_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"git {' '.join(args)} failed: {result.stderr.strip()}"
        )
    return result.stdout.strip()


def changed_files_since(sha: str) -> list[str]:
    """Return list of file paths changed between sha and HEAD."""
    if not sha:
        return []
    diff = git("diff", "--name-only", f"{sha}..HEAD")
    return [line for line in diff.splitlines() if line]


def matches_watched(path: str) -> bool:
    if path in WATCHED_PATHS:
        return True
    for prefix in WATCHED_GLOBS:
        if path.startswith(prefix) and path.endswith(".md"):
            return True
    return False


def matches_pinned_harness(path: str) -> bool:
    return path in PINNED_HARNESS_PATHS


def run_ts_monitor() -> dict:
    """Invoke the TypeScript tier-1 monitor and return its parsed output.

    context-assembler logs to stdout during truncation, so we can't share
    stdout with the report. Pass a temp file path via REPLAY_REPORT_FILE;
    the monitor writes the JSON envelope there atomically.
    """
    import tempfile

    fd, report_path = tempfile.mkstemp(prefix="replay-report-", suffix=".json")
    os.close(fd)
    try:
        cmd = ["npx", "tsx", str(TS_ENTRY)]
        env = {
            **os.environ,
            "HARNESS_ROOT": str(HARNESS_ROOT),
            "REPLAY_REPORT_FILE": report_path,
        }
        result = subprocess.run(
            cmd,
            cwd=HARNESS_ROOT,
            capture_output=True,
            text=True,
            env=env,
            timeout=300,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"tier1-monitor exit {result.returncode}: {result.stderr[-500:]}"
            )
        try:
            with open(report_path) as f:
                return json.load(f)
        except (json.JSONDecodeError, FileNotFoundError) as e:
            raise RuntimeError(
                f"tier1-monitor did not produce a parseable report: {e}; stderr: {result.stderr[-500:]}"
            )
    finally:
        try:
            os.remove(report_path)
        except OSError:
            pass


def short_sha(sha: str) -> str:
    return sha[:7] if sha else "-"


def write_scorecard(
    sha: str,
    triggered_by: list[str],
    pinned_harness_change: bool,
    report: dict,
) -> Path:
    """Write a markdown scorecard for this run to runs/."""
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.datetime.now()
    fname = f"{now.strftime('%Y-%m-%d-%H%M')}-{short_sha(sha)}.md"
    path = RUNS_DIR / fname

    lines: list[str] = []
    lines.append(f"# Tier 1 Run — {now.isoformat(timespec='seconds')}")
    lines.append("")
    lines.append(f"- **Commit**: `{sha}`")
    lines.append(
        f"- **Outcome**: `{report.get('outcome', 'unknown')}`"
    )
    lines.append(
        f"- **Pinned seeds**: {report.get('pinned_seeds', 0)} of {report.get('total_seeds', 0)}"
    )
    lines.append(
        f"- **Harness version**: {report.get('harness_version', '?')}"
    )
    lines.append(
        f"- **Rubric version**: {report.get('rubric_version', '?')}"
    )
    if pinned_harness_change:
        lines.append("")
        lines.append(
            "> ⚠ **Pinned-harness file changed in this commit window.** "
            "Re-baseline recommended; comparisons in this run may be apples-to-oranges."
        )
    lines.append("")
    lines.append("## Triggered by")
    for f in triggered_by:
        marker = " ← pinned-harness" if matches_pinned_harness(f) else ""
        lines.append(f"- `{f}`{marker}")
    lines.append("")

    seeds = report.get("seeds", []) or []
    if seeds:
        lines.append("## Per-seed results")
        lines.append("")
        for s in seeds:
            lines.append(f"### {s.get('seed_id')} — {s.get('shape')}")
            status = s.get("status")
            lines.append(f"- status: `{status}`")
            if status == "no_pin":
                lines.append("- (no pin yet — capture via pin-capture.ts)")
            elif status == "error":
                lines.append(f"- error: `{s.get('error', '?')}`")
            else:
                delta = s.get("delta") or {}
                metrics = s.get("metrics") or {}
                lines.append(
                    f"- pin captured: {s.get('pin_captured_at', '?')}"
                )
                lines.append(
                    f"- jaccard: {delta.get('jaccard', '?')} ({delta.get('jaccardBand', '?')})"
                )
                lines.append(
                    f"- size delta: {delta.get('sizeDeltaPct', 0):.2f}% "
                    f"({delta.get('sizeBand', '?')}); "
                    f"current={metrics.get('contextSize', '?')} chars"
                )
                added = delta.get("retrievedAdded") or []
                removed = delta.get("retrievedRemoved") or []
                if added:
                    lines.append(f"- retrieved added: {', '.join(added[:5])}{'...' if len(added) > 5 else ''}")
                if removed:
                    lines.append(f"- retrieved removed: {', '.join(removed[:5])}{'...' if len(removed) > 5 else ''}")
            lines.append("")

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def append_timeline_row(sha: str, report: dict, pinned_harness_change: bool) -> None:
    """Append a single line to timeline.md describing this run."""
    if not TIMELINE_FILE.exists():
        return
    seeds = report.get("seeds") or []
    pinned = [s for s in seeds if s.get("status") not in ("no_pin", "error")]
    if pinned:
        avg_jaccard = sum(
            (s.get("delta") or {}).get("jaccard", 0) for s in pinned
        ) / len(pinned)
        avg_size_delta = sum(
            (s.get("delta") or {}).get("sizeDeltaPct", 0) for s in pinned
        ) / len(pinned)
        retrieval_str = f"{avg_jaccard:.2f}"
        size_str = f"{avg_size_delta:+.1f}%"
    else:
        retrieval_str = "-"
        size_str = "-"

    now = datetime.datetime.now()
    flag = " (harness changed!)" if pinned_harness_change else ""
    row = (
        f"\n{now.strftime('%Y-%m-%d %H:%M')}  "
        f"{short_sha(sha):<8} "
        f"commit  v{report.get('harness_version', '?')}  "
        f"retrieval={retrieval_str}  "
        f"ctx_delta={size_str}  "
        f"outcome={report.get('outcome', '?')}  "
        f"({len(pinned)} pinned){flag}\n"
    )

    # Insert after the "## Timeline" header by appending; rotation handled by
    # a separate weekly job (not yet built).
    with open(TIMELINE_FILE, "a", encoding="utf-8") as f:
        f.write(row)


def main() -> int:
    state = load_state()
    last_sha = state.get("last_run_sha")

    try:
        head_sha = git("rev-parse", "HEAD")
    except RuntimeError as e:
        log(f"FATAL: could not read git HEAD: {e}")
        return 1

    # Cold start — no prior SHA, just record current and exit.
    if not last_sha:
        log(
            f"Cold start. Recording current HEAD {short_sha(head_sha)}; will compare on next run."
        )
        state["last_run_sha"] = head_sha
        state["last_outcome"] = "cold_start"
        save_state(state)
        return 0

    # Same SHA — nothing new to evaluate.
    if last_sha == head_sha:
        log(f"No new commits since {short_sha(last_sha)}; skipping.")
        return 0

    # Find changed files in the window.
    try:
        changed = changed_files_since(last_sha)
    except RuntimeError as e:
        log(f"git diff failed (last_sha may have been rebased away): {e}; resetting baseline.")
        state["last_run_sha"] = head_sha
        save_state(state)
        return 0

    triggered_by = [f for f in changed if matches_watched(f)]
    if not triggered_by:
        log(
            f"{len(changed)} files changed in window; none watched. Advancing to {short_sha(head_sha)}."
        )
        state["last_run_sha"] = head_sha
        state["last_outcome"] = "no_relevant_commits"
        save_state(state)
        return 0

    pinned_harness_change = any(matches_pinned_harness(f) for f in triggered_by)
    log(
        f"Watched files changed since {short_sha(last_sha)}: {', '.join(triggered_by)}"
        + (" [pinned-harness change]" if pinned_harness_change else "")
    )

    try:
        report = run_ts_monitor()
    except Exception as e:
        log(f"tier1-monitor failed: {e}")
        return 1

    scorecard_path = write_scorecard(
        head_sha, triggered_by, pinned_harness_change, report
    )
    append_timeline_row(head_sha, report, pinned_harness_change)

    log(
        f"Run complete: outcome={report.get('outcome')}, "
        f"pinned_seeds={report.get('pinned_seeds')}/{report.get('total_seeds')}, "
        f"scorecard={scorecard_path.name}"
    )

    state["last_run_sha"] = head_sha
    state["last_outcome"] = report.get("outcome", "unknown")
    save_state(state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
