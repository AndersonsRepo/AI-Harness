#!/usr/bin/env python3
"""Monitor the CS 2600 Systems Programming course website for updates.

Crawls a course website (URL from course-map.json) weekly,
detects new or changed content, summarizes updates, and writes
structured knowledge to the vault.

The website is a single-page site with all lecture content, exercises,
and the exam schedule embedded in section anchors.
"""

import os
import sys
import json
import hashlib
import datetime
import subprocess
import urllib.request
import urllib.error
import re

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
STATE_FILE = os.path.join(TASKS_DIR, "cs2600-watch.state.json")
NOTIFY_FILE = os.path.join(TASKS_DIR, "pending-notifications.jsonl")
VAULT_DIR = os.path.join(HARNESS_ROOT, "vault", "shared", "course-notes", "systems-programming")
CACHE_DIR = os.path.join(TASKS_DIR, ".cs2600-cache")
# Load course URL from config (gitignored)
_course_map_path = os.path.join(TASKS_DIR, "course-map.json")
if os.path.exists(_course_map_path):
    with open(_course_map_path) as _f:
        COURSE_URL = json.load(_f).get("cs2600_url", "")
else:
    COURSE_URL = ""
if not COURSE_URL:
    print("No cs2600_url in course-map.json — skipping")
    sys.exit(0)


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"last_hash": None, "last_run": None, "exam_schedule_written": False}


def save_state(state):
    state["last_run"] = datetime.datetime.now().isoformat()
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.rename(tmp, STATE_FILE)


def notify(message, channel="systems-programming"):
    entry = {
        "task": "cs2600-watch",
        "channel": channel,
        "summary": message,
        "timestamp": datetime.datetime.now().isoformat(),
    }
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")


def fetch_page():
    """Fetch the course page HTML."""
    try:
        req = urllib.request.Request(
            COURSE_URL,
            headers={"User-Agent": "AI-Harness-CS2600-Watch/1.0"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        print(f"Failed to fetch page: {e}", file=sys.stderr)
        return None


def content_hash(html):
    """Hash the page content (excluding timestamps/dynamic elements)."""
    # Strip whitespace variations for stable hashing
    cleaned = re.sub(r'\s+', ' ', html).strip()
    return hashlib.sha256(cleaned.encode()).hexdigest()[:16]


def extract_day_sections(html):
    """Extract individual day/lecture sections from the HTML."""
    # The page uses anchor-based navigation — each day has a heading
    # Pattern: <h2 id="day-N"> or similar heading patterns
    days = []
    # Split on day headings (h2/h3 with "Day" in them)
    day_pattern = re.compile(r'<h[23][^>]*>.*?Day\s+(\d+).*?</h[23]>', re.IGNORECASE | re.DOTALL)
    matches = list(day_pattern.finditer(html))

    for i, match in enumerate(matches):
        day_num = match.group(1)
        start = match.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(html)
        section_html = html[start:end]
        # Strip HTML tags for text content
        text = re.sub(r'<[^>]+>', ' ', section_html)
        text = re.sub(r'\s+', ' ', text).strip()
        days.append({"day": int(day_num), "text": text[:2000]})

    return days


def write_exam_schedule():
    """Write the known exam schedule to vault."""
    os.makedirs(VAULT_DIR, exist_ok=True)
    schedule_path = os.path.join(VAULT_DIR, "exam-schedule.md")

    content = """---
course: Systems Programming (CS 2600)
type: exam-schedule
source: {url}
updated: {date}
---

# CS 2600 Systems Programming — Exam Schedule

## Grade Breakdown
- Quizzes (3): 25%
- Midterms (2): 35%
- Final Exam: 40%

**All exams: closed book, closed notes, no internet, no collaboration. Canvas-based, one question at a time, no backtracking.**

## Upcoming Assessments

| Assessment | Date | Coverage |
|------------|------|----------|
| Quiz 2 | Tue Mar 24 | Days 12-18: find, loops, sed/awk, C basics (types, printf, sizeof) |
| Midterm 2 | Tue Apr 21 | Days 12-26: C programming (types through linked lists) |
| Quiz 3 | Tue May 5 | Days 26-30: linked lists, pointers, networking, sockets |
| Final Exam | Tue May 12, 5:00-6:50 PM | Cumulative (everything) |

## Past Assessments
| Assessment | Date | Status |
|------------|------|--------|
| Quiz 1 | Tue Feb 17 | COMPLETED |
| Midterm 1 | Tue Mar 3 | COMPLETED |

## Topics by Module

### Module 1 — Unix Fundamentals (Days 1-12, covered by M1)
Unix history, shells, file system, basic commands (ls, cd, mkdir, touch, cat, less, man, cp, mv, rm), tmux, text editors (vi, emacs, nano), file globbing, permissions (chmod), shell scripting (variables, echo, date, command substitution, positional params, read), I/O redirection, pipes, text processing (cut, tr, wc, head, tail, grep), find, sleep, conditionals, loops

### Module 2 — C Programming (Days 15-26, covered by M2)
sed, awk, process management, gcc compilation, printf, data types, sizeof, variables/scope, operators, control flow, arrays, strings, functions/prototypes, structures, header files, multi-file compilation, getchar/fgets, string conversions, file I/O (fopen/fclose/fread/fwrite/fprintf/fscanf), lseek, unlink, fchmod, pointers, pointer arithmetic, pass-by-reference, linked lists (malloc/free, insert/traverse/delete)

### Module 3 — Networking (Days 29-30, covered by Q3 + Final)
IP addresses, ports, gateways, TCP vs UDP, clients/servers, protocols, encryption, firewalls, NAT, C socket programming (socket, connect, bind, listen, accept, send/recv, htons/ntohs), HTTP client implementation

## Study Notes
- Code must compile and run on CPP Unix (`login.cpp.edu`), not your local machine
- No textbook required — the course website is the only material
- Practice exercises are ungraded but are the primary study resource
- One make-up quiz available on final exam day (missed quizzes only)
""".format(date=datetime.datetime.now().strftime('%Y-%m-%d'))

    with open(schedule_path, "w") as f:
        f.write(content)
    return schedule_path


def summarize_changes(html, state):
    """Use Claude to summarize what's new on the page."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    cache_path = os.path.join(CACHE_DIR, "page.html")

    # Save current page
    with open(cache_path, "w") as f:
        f.write(html)

    prompt = f"""Read this CS 2600 Systems Programming course website HTML and identify what content is available.

File: {cache_path}

Today's date is {datetime.datetime.now().strftime('%Y-%m-%d')}.

Focus on:
1. Any lecture content for upcoming or recent class days
2. New practice exercises or examples
3. Any schedule changes or announcements
4. Topics that will be covered on upcoming exams

Output a concise markdown summary of what's currently on the page, focusing on the most recent and upcoming content. Include specific topics, code examples mentioned, and exercise names."""

    try:
        result = subprocess.run(
            [
                "claude", "-p",
                "--model", "sonnet",
                "--output-format", "json",
                "--dangerously-skip-permissions",
                "--", prompt,
            ],
            capture_output=True,
            text=True,
            timeout=120,
            env={k: v for k, v in os.environ.items() if not k.startswith("CLAUDE")},
        )

        if result.returncode != 0:
            return None

        try:
            output = json.loads(result.stdout)
            return output.get("result", "")
        except json.JSONDecodeError:
            return result.stdout

    except Exception as e:
        print(f"Claude summarization failed: {e}", file=sys.stderr)
        return None


def main():
    state = load_state()

    # Fetch the page
    print(f"Fetching {COURSE_URL}...")
    html = fetch_page()
    if not html:
        print("Failed to fetch page")
        sys.exit(1)

    print(f"Page fetched: {len(html)} bytes")

    # Check if content changed
    current_hash = content_hash(html)
    changed = current_hash != state.get("last_hash")

    # Always write exam schedule on first run
    if not state.get("exam_schedule_written"):
        schedule_path = write_exam_schedule()
        print(f"Wrote exam schedule: {schedule_path}")
        state["exam_schedule_written"] = True

    if not changed and state.get("last_hash"):
        print("No content changes detected")
        save_state(state)
        return

    print("Content changed — summarizing...")

    # Summarize changes
    summary = summarize_changes(html, state)
    if summary:
        # Write summary to vault
        os.makedirs(VAULT_DIR, exist_ok=True)
        date_str = datetime.datetime.now().strftime('%Y-%m-%d')
        vault_path = os.path.join(VAULT_DIR, f"web-update-{date_str}.md")

        frontmatter = f"""---
course: Systems Programming (CS 2600)
type: web-update
source: {COURSE_URL}
crawled: {date_str}
---

"""
        with open(vault_path, "w") as f:
            f.write(frontmatter + summary)
        print(f"Wrote update: {vault_path}")

        # Notify
        notify_msg = f"**CS 2600 Website Update Detected**\n\n{summary[:1500]}"
        if len(summary) > 1500:
            notify_msg += "\n\n*(Truncated — full summary in vault)*"
        notify(notify_msg)

    state["last_hash"] = current_hash
    save_state(state)
    print("Done")


if __name__ == "__main__":
    main()
