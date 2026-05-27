#!/usr/bin/env python3
"""Pre-compaction memory flush — runs session-debrief for the current project.
Triggered as a Stop hook when a Claude Code conversation ends.
Extracts learnings from the current transcript before context is lost.
"""

import os
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
from hook_common import resolve_harness_root

HARNESS_ROOT = resolve_harness_root(SCRIPT_DIR)


def main():
    # Add lib to path for platform module only when the hook actually runs.
    sys.path.insert(0, str(HARNESS_ROOT / "heartbeat-tasks"))
    from lib.platform import paths

    script = HARNESS_ROOT / "heartbeat-tasks" / "scripts" / "session-debrief.py"
    python = paths.python()

    # Run in background so it doesn't block the exit.
    try:
        subprocess.Popen(
            [python, str(script)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception:
        pass  # Don't block exit on failure


if __name__ == "__main__":
    main()
