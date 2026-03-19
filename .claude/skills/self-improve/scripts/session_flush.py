#!/usr/bin/env python3
"""Pre-compaction memory flush — runs session-debrief for the current project.
Triggered as a Stop hook when a Claude Code conversation ends.
Extracts learnings from the current transcript before context is lost.
"""

import os
import subprocess
import sys
from pathlib import Path

HARNESS_ROOT = Path(os.environ.get("HARNESS_ROOT", Path.home() / "Desktop" / "AI-Harness"))

# Add lib to path for platform module
sys.path.insert(0, str(HARNESS_ROOT / "heartbeat-tasks"))
from lib.platform import paths

SCRIPT = HARNESS_ROOT / "heartbeat-tasks" / "scripts" / "session-debrief.py"
PYTHON = paths.python()

# Run in background so it doesn't block the exit
try:
    subprocess.Popen(
        [PYTHON, str(SCRIPT)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
except Exception:
    pass  # Don't block exit on failure
