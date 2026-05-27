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


def run_ts_monitor(extra_args: list[str] | None = None) -> dict:
    """Invoke tier2-monitor.ts and return its JSON report.

    On a clean run, the report's `partial` field is False. On a crash mid-run,
    the TS monitor still leaves an incremental checkpoint at REPLAY_REPORT_FILE
    (written after each completed seed) — we read that and surface it with the
    `partial: true` flag preserved, so the scorecard can show "X of Y seeds
    completed before crash" rather than throwing the partial signal away.
    """
    fd, report_path = tempfile.mkstemp(prefix="replay-tier2-", suffix=".json")
    os.close(fd)
    try:
        cmd = ["npx", "tsx", str(TS_ENTRY)]
        if extra_args:
            cmd.extend(extra_args)
        env = {
            **os.environ,
            "HARNESS_ROOT": str(HARNESS_ROOT),
            "REPLAY_REPORT_FILE": report_path,
        }
        # Tier 2 is heavy. Cost-validation run on shape-01 at N=3 took ~4.6 min;
        # 10-seed × 3-run × 2-judge full matrix extrapolates to ~45-60 min.
        # Allow 90 min so a real Sunday run can complete; partial-checkpoint
        # behavior salvages anything that runs before the timer fires.
        result = subprocess.run(
            cmd,
            cwd=HARNESS_ROOT,
            capture_output=True,
            text=True,
            env=env,
            timeout=5400,
            check=False,
        )

        # Try to read the report file regardless of exit code — on crash we
        # may still have a partial checkpoint with completed-seed signal.
        report = None
        try:
            if os.path.exists(report_path) and os.path.getsize(report_path) > 0:
                with open(report_path) as f:
                    report = json.load(f)
        except (json.JSONDecodeError, OSError):
            report = None

        if result.returncode != 0:
            if report is None:
                raise RuntimeError(
                    f"tier2-monitor exit {result.returncode} and no parseable "
                    f"report on disk; stderr: {result.stderr[-1000:]}"
                )
            # Partial run survived to disk — flag it as partial regardless of
            # whatever the TS process said before crashing.
            report["partial"] = True
            report["crash_stderr_tail"] = result.stderr[-500:]
            return report

        if report is None:
            raise RuntimeError(
                f"tier2-monitor exited 0 but produced no parseable report; "
                f"stderr: {result.stderr[-500:]}"
            )
        return report
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

    partial = bool(report.get("partial"))
    lines: list[str] = []
    title = "Tier 2 Weekly Run"
    if partial:
        title += " (PARTIAL — process did not complete)"
    lines.append(f"# {title} — {now.isoformat(timespec='seconds')}")
    lines.append("")

    if partial:
        lines.append(
            "> ⚠ **Partial run.** The TS monitor crashed or timed out before all selected "
            "seeds completed. Results below are an incremental checkpoint and may not include "
            "every seed in the filter."
        )
        if report.get("crash_stderr_tail"):
            lines.append("")
            lines.append("```")
            lines.append("crash stderr tail:")
            lines.append(report["crash_stderr_tail"])
            lines.append("```")
        lines.append("")

    lines.append(f"- **Outcome**: `{report.get('outcome', 'unknown')}`")
    selected = report.get("selected_seed_count") or report.get("evaluated_seeds", 0)
    lines.append(
        f"- **Evaluated**: {report.get('evaluated_seeds', 0)} of {selected} selected "
        f"({report.get('total_seeds', 0)} total seeds in fixture)"
    )
    if report.get("seed_filter"):
        lines.append(f"- **Seed filter**: `{','.join(report['seed_filter'])}`")
    lines.append(f"- **Runs per seed**: Pass^{report.get('num_runs_per_seed', 3)}")
    lines.append(f"- **Harness version**: {report.get('harness_version', '?')}")
    lines.append(f"- **Rubric version**: {report.get('rubric_version', '?')}")
    cost = report.get("total_cost_usd")
    if cost is not None:
        lines.append(f"- **Total cost (reported)**: ${cost:.4f}")
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

        if s.get("candidate_paths"):
            lines.append("- candidate outputs (forensic inspection):")
            for cp in s["candidate_paths"]:
                lines.append(f"  - `{cp}`")

        cost_obj = s.get("cost") or {}
        if cost_obj:
            lines.append(
                f"- cost: agent ${cost_obj.get('agent_cost_usd', 0):.4f}, "
                f"judges ${cost_obj.get('judge_cost_usd', 0):.4f}, "
                f"total ${cost_obj.get('total_usd', 0):.4f}"
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
    cost = report.get("total_cost_usd")
    cost_str = f"  cost=${cost:.2f}" if cost is not None else ""
    partial_str = "  [PARTIAL]" if report.get("partial") else ""
    row = (
        f"\n{now.strftime('%Y-%m-%d %H:%M')}  "
        f"weekly   "
        f"v{report.get('harness_version', '?')}  "
        f"pass={pass_count}  "
        f"regress={regress_count}  "
        f"flaky={flaky_count}  "
        f"disagreement={disagreement_count}  "
        f"outcome={report.get('outcome', '?')}{cost_str}  "
        f"({len(evaluated)}/{len(seeds)} evaluated){partial_str}\n"
    )
    with open(TIMELINE_FILE, "a", encoding="utf-8") as f:
        f.write(row)


def parse_cli_args() -> dict:
    """Parse CLI flags so the wrapper can be invoked manually for testing.

    Recognized:
      --seed shape-01[,shape-02]   Restrict run to listed seeds.
    """
    args: dict = {}
    argv = sys.argv[1:]
    i = 0
    while i < len(argv):
        if argv[i] == "--seed" and i + 1 < len(argv):
            args["seed"] = argv[i + 1]
            i += 2
        else:
            i += 1
    return args


def main() -> int:
    cli = parse_cli_args()
    log("Starting tier-2 weekly run" + (f" (--seed {cli['seed']})" if "seed" in cli else ""))
    state = load_state()

    extra_args: list[str] = []
    if cli.get("seed"):
        extra_args = ["--seed", cli["seed"]]

    try:
        report = run_ts_monitor(extra_args)
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
