#!/usr/bin/env python3
"""Heartbeat wrapper: runs regen-project-knowledge.py over every project.

heartbeat-runner.py invokes type=script tasks as bare `python3 <script>` with
no argv passthrough, so the periodic --all --auto loop needs its own entry
point. This is that entry point — nothing more.

Skips projects with fewer than --min-entries vault entries to avoid generating
thin/noisy pages for newly-registered projects that haven't accumulated learning
coverage yet.
"""

from __future__ import annotations

import os
import subprocess
import sys

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
)
REGEN_SCRIPT = os.path.join(
    HARNESS_ROOT, "heartbeat-tasks", "scripts", "regen-project-knowledge.py"
)

MIN_ENTRIES = 3


def main() -> int:
    cmd = [
        sys.executable,
        REGEN_SCRIPT,
        "--all",
        "--auto",
        "--min-entries", str(MIN_ENTRIES),
    ]
    result = subprocess.run(
        cmd,
        cwd=HARNESS_ROOT,
        env={**os.environ, "HARNESS_ROOT": HARNESS_ROOT},
    )
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
