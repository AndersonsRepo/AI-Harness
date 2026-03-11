#!/usr/bin/env python3
"""Detect new GoodNotes PDF exports."""

import os
import json
import datetime
import glob

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
STATE_FILE = os.path.join(TASKS_DIR, "goodnotes-watch.state-files.json")
NOTIFY_FILE = os.path.join(TASKS_DIR, "pending-notifications.jsonl")
EXPORT_DIR = os.path.join(
    os.path.expanduser("~/Library/CloudStorage/GoogleDrive-" + os.environ.get("GOOGLE_DRIVE_ACCOUNT", "")),
    "My Drive", "GoodNotes",
)
# Fallback: manual exports
MANUAL_EXPORT_DIR = os.path.expanduser("~/Documents/GoodNotes-Export")


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


def scan_dir(directory):
    """Return set of PDF basenames in a directory (recursively)."""
    files = set()
    if not os.path.isdir(directory):
        return files
    for root, _, filenames in os.walk(directory):
        for f in filenames:
            if f.lower().endswith(".pdf"):
                # Include relative path from base dir for uniqueness
                rel = os.path.relpath(os.path.join(root, f), directory)
                files.add(rel)
    return files


def main():
    current_files = set()
    current_files |= scan_dir(EXPORT_DIR)
    current_files |= scan_dir(MANUAL_EXPORT_DIR)

    if not current_files:
        dirs = f"{EXPORT_DIR}, {MANUAL_EXPORT_DIR}"
        print(f"No PDFs found in: {dirs}")

    known_files = load_known_files()

    new_files = current_files - known_files
    if new_files:
        for f in sorted(new_files):
            print(f"New export detected: {f}")

        # Group by folder for clean display
        from collections import defaultdict
        grouped = defaultdict(list)
        for f in sorted(new_files):
            folder = os.path.dirname(f) or "Root"
            name = os.path.basename(f)
            grouped[folder].append(name)

        lines = [f"**{len(new_files)} new export(s) detected**\n"]
        for folder, files in sorted(grouped.items()):
            if folder != "Root":
                lines.append(f"**{folder}/**")
            for name in files:
                lines.append(f"  \u2022 {name}")
            lines.append("")  # blank line between groups

        notify("\n".join(lines).strip())
    else:
        print("No new exports detected")

    # Update state with all current files
    save_known_files(current_files)


if __name__ == "__main__":
    main()
