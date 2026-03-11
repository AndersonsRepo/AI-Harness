#!/usr/bin/env python3
"""Detect new GoodNotes PDF exports."""

import os
import json
import datetime
import glob

HARNESS_ROOT = os.environ.get("HARNESS_ROOT", "$HOME/.local/ai-harness")
TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
STATE_FILE = os.path.join(TASKS_DIR, "goodnotes-watch.state-files.json")
NOTIFY_FILE = os.path.join(TASKS_DIR, "pending-notifications.jsonl")
EXPORT_DIR = os.path.expanduser("~/Documents/GoodNotes-Export")


def load_known_files():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return set(json.load(f))
    return set()


def save_known_files(files):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(sorted(files), f, indent=2)
    os.rename(tmp, STATE_FILE)


def notify(message):
    notification = {
        "task": "goodnotes-watch",
        "channel": "general",
        "summary": message,
        "timestamp": datetime.datetime.now().isoformat(),
    }
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(notification) + "\n")


def main():
    if not os.path.isdir(EXPORT_DIR):
        print(f"Export directory does not exist: {EXPORT_DIR}")
        return

    current_files = set(
        os.path.basename(p) for p in glob.glob(os.path.join(EXPORT_DIR, "*.pdf"))
    )
    known_files = load_known_files()

    new_files = current_files - known_files
    if new_files:
        for f in sorted(new_files):
            print(f"New export detected: {f}")
        names = ", ".join(sorted(new_files))
        notify(f"New GoodNotes export(s): {names}")
    else:
        print("No new exports detected")

    # Update state with all current files
    save_known_files(current_files)


if __name__ == "__main__":
    main()
