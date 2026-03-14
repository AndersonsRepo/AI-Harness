#!/usr/bin/env python3
"""Ingest GoodNotes PDF exports into vault as structured course notes.

For each new/unprocessed PDF under Cal Poly Pomona:
1. Determine course from folder path (deterministic)
2. Call Claude Sonnet to read the PDF and extract key concepts
3. Write structured markdown to vault/shared/course-notes/<course>/
4. Track ingestion state to avoid reprocessing

Runs as a heartbeat script every 4 hours.
"""

import os
import sys
import json
import subprocess
import datetime
import re

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
STATE_FILE = os.path.join(TASKS_DIR, "notes-ingest.state.json")
KNOWN_FILES_STATE = os.path.join(TASKS_DIR, "goodnotes-watch.state-files.json")
VAULT_DIR = os.path.join(HARNESS_ROOT, "vault", "shared", "course-notes")
NOTIFY_FILE = os.path.join(TASKS_DIR, "pending-notifications.jsonl")

# Max PDFs to process per run (cost control)
MAX_PER_RUN = 10

# Map GoodNotes folder names → vault directory names and Discord channels
COURSE_MAP = {
    "Numerical Methods": {
        "vault_dir": "numerical-methods",
        "channel": "numerical-methods",
        "display": "Numerical Methods",
    },
    "Intro To PHILOSOPHY": {
        "vault_dir": "philosophy",
        "channel": "philosophy",
        "display": "Intro to Philosophy",
    },
    "Systems Programming": {
        "vault_dir": "systems-programming",
        "channel": "systems-programming",
        "display": "Systems Programming (CS 2600)",
    },
    "Compters And Society": {
        "vault_dir": "comp-society",
        "channel": "comp-society",
        "display": "Computers and Society",
    },
}


def _find_google_drive():
    """Auto-detect the Google Drive CloudStorage mount."""
    cloud_dir = os.path.expanduser("~/Library/CloudStorage")
    if os.path.isdir(cloud_dir):
        for entry in os.listdir(cloud_dir):
            if entry.startswith("GoogleDrive-"):
                return os.path.join(cloud_dir, entry, "My Drive", "GoodNotes")
    return None


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            state = json.load(f)
        # Migrate: add failures tracking if missing
        if "failures" not in state:
            state["failures"] = {}
        return state
    return {"ingested": [], "failures": {}, "last_run": None}

MAX_FAILURES = 3  # Skip PDFs that fail this many times


def save_state(state):
    state["last_run"] = datetime.datetime.now().isoformat()
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.rename(tmp, STATE_FILE)


def notify(message, channel="goodnotes"):
    entry = {
        "task": "notes-ingest",
        "channel": channel,
        "summary": message,
        "timestamp": datetime.datetime.now().isoformat(),
    }
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")


def parse_course(rel_path):
    """Extract course info from GoodNotes relative path.

    Paths look like: Cal Poly Pomona/Numerical Methods/Notes/2-24.pdf
    Returns course map entry or None.
    """
    parts = rel_path.split("/")
    if len(parts) < 2:
        return None
    if "Cal Poly" not in parts[0]:
        return None
    folder_name = parts[1]
    return COURSE_MAP.get(folder_name)


def make_vault_filename(rel_path, course_info):
    """Generate a vault-friendly filename from the PDF path."""
    basename = os.path.splitext(os.path.basename(rel_path))[0]
    # Determine subfolder context (Notes, Homework, Discussions, etc.)
    parts = rel_path.split("/")
    subfolder = ""
    if len(parts) >= 3:
        # e.g., "Cal Poly Pomona/Numerical Methods/Notes/2-24.pdf" → subfolder = "notes"
        potential = parts[2].lower()
        if potential in ("notes", "homework", "discussions", "quizzes"):
            subfolder = potential + "-"

    # Clean up the basename for a filename
    clean = re.sub(r'[^\w\s-]', '', basename).strip()
    clean = re.sub(r'\s+', '-', clean).lower()
    return f"{subfolder}{clean}"


def ingest_pdf(pdf_path, rel_path, course_info):
    """Call Claude Sonnet to read a PDF and extract structured notes."""
    vault_dir = os.path.join(VAULT_DIR, course_info["vault_dir"])
    os.makedirs(vault_dir, exist_ok=True)

    vault_filename = make_vault_filename(rel_path, course_info)
    vault_path = os.path.join(vault_dir, f"{vault_filename}.md")

    # Skip if already exists in vault
    if os.path.exists(vault_path):
        return vault_path

    # Determine content type from subfolder
    parts = rel_path.split("/")
    content_type = "lecture notes"
    if len(parts) >= 3:
        sub = parts[2].lower()
        if "homework" in sub or "hw" in sub:
            content_type = "homework"
        elif "discussion" in sub:
            content_type = "discussion"
        elif "quiz" in sub:
            content_type = "quiz preparation"

    prompt = f"""Use the Read tool to open this PDF file, then extract structured notes from it.

IMPORTANT: You MUST use the Read tool with this exact file path to read the PDF:
{pdf_path}

If the PDF is large (many pages), read it in chunks using the pages parameter (e.g., pages="1-10", then pages="11-20"). Maximum 10 pages per Read call to avoid memory issues.

This is {content_type} from a {course_info['display']} class. After reading the PDF, extract:
1. **Topic/Title** — what this covers
2. **Key Concepts** — main ideas, definitions, theorems
3. **Formulas/Equations** — any mathematical formulas (use LaTeX notation)
4. **Examples** — worked examples or practice problems
5. **Key Takeaways** — what a student should remember

Output as clean markdown. Be thorough but concise. If handwriting is unclear, note it as [UNCLEAR].
Do NOT include any meta-commentary — just the extracted content."""

    try:
        result = subprocess.run(
            [
                "claude", "-p",
                "--model", "sonnet",
                "--output-format", "json",
                "--dangerously-skip-permissions",
                "--allowedTools", "Read",
                "--max-turns", "15",
                "--", prompt,
            ],
            capture_output=True,
            text=True,
            timeout=600,
            env={k: v for k, v in os.environ.items() if not k.startswith("CLAUDE")},
        )

        if result.returncode != 0:
            print(f"  Claude error: {result.stderr[:200]}", file=sys.stderr)
            return None

        # Parse response
        try:
            output = json.loads(result.stdout)
            content = output.get("result", "")
        except json.JSONDecodeError:
            content = result.stdout

        if not content or len(content) < 50:
            print(f"  Empty or too short response for {rel_path}", file=sys.stderr)
            return None

        # Write vault entry with frontmatter
        frontmatter = f"""---
course: {course_info['display']}
source: {rel_path}
type: {content_type}
ingested: {datetime.datetime.now().strftime('%Y-%m-%d')}
---

"""
        with open(vault_path, "w") as f:
            f.write(frontmatter + content)

        return vault_path

    except subprocess.TimeoutExpired:
        print(f"  Timeout processing {rel_path}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"  Error: {e}", file=sys.stderr)
        return None


def main():
    drive_dir = _find_google_drive()
    if not drive_dir:
        print("Google Drive not found")
        sys.exit(1)

    # Load state
    state = load_state()
    ingested = set(state.get("ingested", []))

    # Load known files from goodnotes-watch
    if not os.path.exists(KNOWN_FILES_STATE):
        print("No goodnotes-watch state file — run goodnotes-watch first")
        sys.exit(0)

    with open(KNOWN_FILES_STATE) as f:
        known_files = json.load(f)

    # Filter to Cal Poly Pomona academic files only
    failures = state.get("failures", {})
    to_process = []
    for rel_path in sorted(known_files):
        if rel_path in ingested:
            continue
        # Skip PDFs that have failed too many times
        if failures.get(rel_path, 0) >= MAX_FAILURES:
            continue
        course_info = parse_course(rel_path)
        if not course_info:
            continue
        full_path = os.path.join(drive_dir, rel_path)
        if not os.path.exists(full_path):
            continue
        to_process.append((full_path, rel_path, course_info))

    if not to_process:
        print("All academic PDFs already ingested")
        save_state(state)
        return

    # Cap per run
    batch = to_process[:MAX_PER_RUN]
    print(f"Processing {len(batch)} of {len(to_process)} pending PDFs...")

    results = {"success": [], "failed": []}
    for full_path, rel_path, course_info in batch:
        print(f"  Ingesting: {rel_path}")
        vault_path = ingest_pdf(full_path, rel_path, course_info)
        if vault_path:
            ingested.add(rel_path)
            results["success"].append((rel_path, course_info))
            print(f"    → {os.path.basename(vault_path)}")
        else:
            failures[rel_path] = failures.get(rel_path, 0) + 1
            results["failed"].append(rel_path)
            remaining_tries = MAX_FAILURES - failures[rel_path]
            print(f"    → FAILED ({remaining_tries} retries left)")

    # Save state
    state["ingested"] = sorted(ingested)
    state["failures"] = failures
    save_state(state)

    # Notify per course
    if results["success"]:
        from collections import defaultdict
        by_course = defaultdict(list)
        for rel_path, course_info in results["success"]:
            by_course[course_info["channel"]].append(os.path.basename(rel_path))

        for channel, files in by_course.items():
            course_display = next(
                c["display"] for c in COURSE_MAP.values() if c["channel"] == channel
            )
            lines = [f"**{len(files)} note(s) ingested for {course_display}**\n"]
            for f in files:
                lines.append(f"  • {f}")
            lines.append(f"\nUse `/academics study <topic>` to generate study material.")
            notify("\n".join(lines), channel=channel)

    remaining = len(to_process) - len(batch)
    if remaining > 0:
        print(f"{remaining} PDFs remaining — will process on next run")

    print(f"Done: {len(results['success'])} ingested, {len(results['failed'])} failed")


if __name__ == "__main__":
    main()
