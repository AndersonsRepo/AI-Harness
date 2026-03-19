#!/usr/bin/env python3
"""Generate and install a scheduled task for a heartbeat task.

Usage: python3 generate-plist.py <task-name> [--install]

Cross-platform: generates launchd plist on macOS, schtasks XML on Windows.
Reads heartbeat-tasks/<task-name>.json for config.
"""

import json
import os
import sys

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")

sys.path.insert(0, TASKS_DIR)
from lib.platform import scheduler


def main():
    if len(sys.argv) < 2:
        print(f"Usage: generate-plist.py <task-name> [--install]")
        print(f"  Platform scheduler: {scheduler.name()}")
        sys.exit(1)

    task_name = sys.argv[1]
    install = "--install" in sys.argv

    config_path = os.path.join(TASKS_DIR, f"{task_name}.json")
    with open(config_path) as f:
        config = json.load(f)

    if install:
        try:
            result = scheduler.install(task_name, config, HARNESS_ROOT)
            print(f"Installed and loaded: {result}")
        except Exception as e:
            print(f"Install failed: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        print(scheduler.generate_config(task_name, config, HARNESS_ROOT))


if __name__ == "__main__":
    main()
