#!/usr/bin/env python3
"""Regression-replay tier-2 weekly monitor — Pass^3 + PoLL judges.

Runs once per week (Sunday 02:00 by default). For each pinned seed:
  1. Spawns the seed's first agent N=3 times at T=0
  2. Judges each candidate vs baseline using PoLL (Sonnet + Codex)
  3. Aggregates per-run verdicts into Pass^3
Writes an extended scorecard to vault/shared/regression-replay/runs/ and
appends a tier-2 summary row to timeline.md.

Cost: ~$10-18 per run with the default 10-seed × 3-run × 2-judge matrix.
"""

import datetime
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HARNESS_ROOT = Path(
    os.environ.get(
        "HARNESS_ROOT",
        Path(__file__).resolve().parents[2],
    )
)
TASK_NAME = "regression-replay-weekly"
TASKS_DIR = HARNESS_ROOT / "heartbeat-tasks"
STATE_FILE = TASKS_DIR / f"{TASK_NAME}.state.json"
LOG_DIR = TASKS_DIR / "logs"
TS_ENTRY = (
    HARNESS_ROOT
    / "bridges"
    / "discord"
    / "tools"
    / "regression-replay"
    / "tier2-monitor.ts"
)
REPLAY_ROOT = HARNESS_ROOT / "vault" / "shared" / "regression-replay"
RUNS_DIR = REPLAY_ROOT / "runs"
TIMELINE_FILE = REPLAY_ROOT / "timeline.md"


def log(msg: str) -> None:
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


def run_ts_monitor() -> dict:
    fd, report_path = tempfile.mkstemp(prefix="replay-tier2-", suffix=".json")
    os.close(fd)
    try:
        cmd = ["npx", "tsx", str(TS_ENTRY)]
        env = {
            **os.environ,
            "HARNESS_ROOT": str(HARNESS_ROOT),
            "REPLAY_REPORT_FILE": report_path,
        }
        # Tier 2 is heavy — allow up to 30 min total wall time for 10 seeds × 3 runs × judging.
        result = subprocess.run(
            cmd,
            cwd=HARNESS_ROOT,
            capture_output=True,
            text=True,
            env=env,
            timeout=1800,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"tier2-monitor exit {result.returncode}: {result.stderr[-1000:]}"
            )
        try:
            with open(report_path) as f:
                return json.load(f)
        except (json.JSONDecodeError, FileNotFoundError) as e:
            raise RuntimeError(
                f"tier2-monitor did not produce a parseable report: {e}; stderr: {result.stderr[-500:]}"
            )
    finally:
        try:
            os.remove(report_path)
        except OSError:
            pass


def write_scorecard(report: dict) -> Path:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.datetime.now()
    fname = f"{now.strftime('%Y-%m-%d')}-weekly.md"
    path = RUNS_DIR / fname

    lines: list[str] = []
    lines.append(f"# Tier 2 Weekly Run — {now.isoformat(timespec='seconds')}")
    lines.append("")
    lines.append(f"- **Outcome**: `{report.get('outcome', 'unknown')}`")
    lines.append(
        f"- **Evaluated**: {report.get('evaluated_seeds', 0)} of {report.get('total_seeds', 0)} seeds"
    )
    lines.append(f"- **Runs per seed**: Pass^{report.get('num_runs_per_seed', 3)}")
    lines.append(f"- **Harness version**: {report.get('harness_version', '?')}")
    lines.append(f"- **Rubric version**: {report.get('rubric_version', '?')}")
    lines.append("")
    lines.append("## Per-seed results")
    lines.append("")

    seeds = report.get("seeds", []) or []
    for s in seeds:
        lines.append(f"### {s.get('seed_id')} — {s.get('shape')}")
        lines.append(f"- final: `{s.get('status')}`")
        passk = s.get("passk") or {}
        if passk:
            lines.append(
                f"- pass^{passk.get('total_runs', '?')}: "
                f"{passk.get('pass_count', 0)} pass, "
                f"{passk.get('regress_count', 0)} regress, "
                f"{passk.get('unclear_count', 0)} unclear, "
                f"{passk.get('disagreement_count', 0)} disagreement, "
                f"{passk.get('judge_failure_count', 0)} judge_failure"
            )
            lines.append(f"- reasoning: {passk.get('reasoning', '?')}")

        per_run = s.get("per_run_polls") or []
        if per_run:
            lines.append("- per-run PoLL outcomes:")
            for i, p in enumerate(per_run):
                judges = p.get("judges") or []
                judge_summary = ", ".join(
                    f"{j.get('judge')}={j.get('verdict')}" for j in judges
                )
                disagree = " ⚠ disagreement" if p.get("disagreement") else ""
                lines.append(
                    f"  - run {i + 1}: `{p.get('final')}` ({judge_summary}){disagree}"
                )

        if s.get("errors"):
            lines.append("- errors:")
            for e in s["errors"]:
                lines.append(f"  - {e}")
        if s.get("total_duration_ms"):
            secs = s["total_duration_ms"] / 1000.0
            lines.append(f"- total duration: {secs:.1f}s")
        lines.append("")

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def append_timeline_row(report: dict) -> None:
    if not TIMELINE_FILE.exists():
        return
    seeds = report.get("seeds") or []
    evaluated = [
        s
        for s in seeds
        if s.get("status")
        not in ("no_pin", "no_baseline_output", "skipped")
    ]

    pass_count = sum(1 for s in evaluated if s.get("status") == "pass")
    regress_count = sum(
        1 for s in evaluated if s.get("status") in ("regress", "flaky_regression")
    )
    flaky_count = sum(1 for s in evaluated if "flaky" in (s.get("status") or ""))

    disagreement_count = 0
    for s in evaluated:
        for p in s.get("per_run_polls") or []:
            if p.get("disagreement"):
                disagreement_count += 1

    now = datetime.datetime.now()
    row = (
        f"\n{now.strftime('%Y-%m-%d %H:%M')}  "
        f"weekly   "
        f"v{report.get('harness_version', '?')}  "
        f"pass={pass_count}  "
        f"regress={regress_count}  "
        f"flaky={flaky_count}  "
        f"disagreement={disagreement_count}  "
        f"outcome={report.get('outcome', '?')}  "
        f"({len(evaluated)}/{len(seeds)} evaluated)\n"
    )
    with open(TIMELINE_FILE, "a", encoding="utf-8") as f:
        f.write(row)


def main() -> int:
    log("Starting tier-2 weekly run")
    state = load_state()

    try:
        report = run_ts_monitor()
    except Exception as e:
        log(f"tier2-monitor failed: {e}")
        return 1

    scorecard = write_scorecard(report)
    append_timeline_row(report)

    state["last_run"] = datetime.datetime.now().isoformat()
    state["last_outcome"] = report.get("outcome", "unknown")
    save_state(state)

    log(
        f"Run complete: outcome={report.get('outcome')}, "
        f"evaluated={report.get('evaluated_seeds')}/{report.get('total_seeds')}, "
        f"scorecard={scorecard.name}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
