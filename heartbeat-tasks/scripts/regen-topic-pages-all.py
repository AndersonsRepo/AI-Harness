#!/usr/bin/env python3
"""Heartbeat wrapper: maintain vault/topics/*.md, then report missing pages.

heartbeat-runner.py invokes type=script tasks as bare `python3 <script>` with no
argv passthrough, so the periodic loop needs its own entry point (mirrors
regen-all-projects.py for project-knowledge).

Two passes:
  1. regen-topic-pages.py --all --auto → regenerate + APPLY only DIRTY topic
     pages (sources newer than last_synthesized_at). Clean pages cost $0.
     CAVEAT: auto-apply is only safe while sources are fresh. The model
     synthesizes blind and will repeat a stale source as a confident
     current-state fact (see the module docstring in regen-topic-pages.py + the
     "Freshness verification" section of .claude/skills/topic-page/SKILL.md).
     The durable fix is the planned pre-apply freshness gate; until it lands,
     old/dormant projects should be hand-verified, and diffs land in
     #notifications for eyeballing.
  2. regen-topic-pages.py --detect-missing → report projects that have
     accumulated enough state to warrant a page but don't have one. Report-only;
     the AI authors them via the /topic-page skill.
"""

from __future__ import annotations

import os
import subprocess
import sys

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
)
REGEN = os.path.join(HARNESS_ROOT, "heartbeat-tasks", "scripts", "regen-topic-pages.py")


def run(args: list[str]) -> int:
    return subprocess.run(
        [sys.executable, REGEN, *args],
        cwd=HARNESS_ROOT,
        env={**os.environ, "HARNESS_ROOT": HARNESS_ROOT},
    ).returncode


def main() -> int:
    rc = run(["--all", "--auto"])
    print("\n--- topic-page coverage scan ---", file=sys.stderr)
    rc |= run(["--detect-missing"])
    return rc


if __name__ == "__main__":
    sys.exit(main())
