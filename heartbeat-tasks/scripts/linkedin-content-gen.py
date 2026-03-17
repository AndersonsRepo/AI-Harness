#!/usr/bin/env python3
"""LinkedIn Content Generator — auto-generates post drafts from project activity, learnings, and academics.

Sources:
1. Project updates — recent git commits across registered projects
2. Technical insights — vault learnings from the past week
3. Academic highlights — CS/tech course notes (excludes non-technical courses)
4. Custom topics — picked up from a topic queue file

Generates a draft, stores it in linkedin_posts with an approval token,
and notifies #linkedin for user approval via !approve / !reject.

Runs weekly (or on-demand via /heartbeat run).
"""

import os
import sys
import json
import datetime
import subprocess
import sqlite3
import random
import secrets

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
NOTIFY_FILE = os.path.join(TASKS_DIR, "pending-notifications.jsonl")
STATE_FILE = os.path.join(TASKS_DIR, "linkedin-content-gen.state.json")
DB_PATH = os.path.join(HARNESS_ROOT, "bridges", "discord", "harness.db")
VAULT_DIR = os.path.join(HARNESS_ROOT, "vault")
TOPIC_QUEUE = os.path.join(TASKS_DIR, "linkedin-topics.txt")

# Load .env for Claude CLI auth
_env_path = os.path.join(HARNESS_ROOT, "bridges", "discord", ".env")
if os.path.exists(_env_path):
    with open(_env_path) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _key, _val = _line.split("=", 1)
                if _key not in os.environ:
                    os.environ[_key] = _val

# CS/tech courses only — exclude non-technical courses from academic highlights
TECH_COURSES = ["numerical-methods", "systems-programming", "comp-society"]

# Post types with weights for random selection
POST_TYPES = [
    ("project_update", 3),   # Most common
    ("technical_insight", 3),
    ("academic_highlight", 2),
    ("custom_topic", 1),     # Only if topics queued
]


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"last_run": None, "posts_generated": 0, "last_topics": []}


def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def notify(message, channel="linkedin"):
    entry = {
        "task": "linkedin-content-gen",
        "channel": channel,
        "summary": message,
        "timestamp": datetime.datetime.now().isoformat(),
    }
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")


def store_draft(topic, content, signals=None):
    """Store a draft in the linkedin_posts table with an approval token."""
    db = sqlite3.connect(DB_PATH)
    post_id = f"post-{int(datetime.datetime.now().timestamp()):x}"
    token = secrets.token_hex(16)

    db.execute(
        "INSERT INTO linkedin_posts (id, status, topic, content, signals, approval_token) VALUES (?, 'pending_approval', ?, ?, ?, ?)",
        (post_id, topic, content, json.dumps(signals) if signals else None, token),
    )
    db.commit()
    db.close()

    # Notify Discord
    preview = content[:300] + "..." if len(content) > 300 else content
    notify(
        f"**New LinkedIn Post Draft**\n\n"
        f"**Topic:** {topic}\n\n"
        f"{preview}\n\n"
        f"To approve: `!approve {token}`\n"
        f"To reject: `!reject {token}`"
    )

    return post_id, token


# ─── Signal Gathering ─────────────────────────────────────────────────

def gather_git_signals():
    """Get recent meaningful git commits across registered projects."""
    signals = []
    projects_path = os.path.join(TASKS_DIR, "projects.json")
    if not os.path.exists(projects_path):
        return signals

    with open(projects_path) as f:
        data = json.load(f)

    projects = data.get("projects", data) if isinstance(data, dict) else data

    for proj_name, proj in (projects.items() if isinstance(projects, dict) else enumerate(projects)):
        if isinstance(proj, str):
            continue
        path = proj.get("path", "").replace("$HOME", os.path.expanduser("~")).replace("$HARNESS_ROOT", HARNESS_ROOT)
        if not os.path.isdir(path):
            continue

        try:
            result = subprocess.run(
                ["git", "log", "--oneline", "--since=7 days ago", "--no-merges", "-10"],
                capture_output=True, text=True, timeout=10, cwd=path,
            )
            if result.returncode == 0 and result.stdout.strip():
                commits = result.stdout.strip().split("\n")
                signals.append({
                    "type": "git",
                    "project": proj_name if isinstance(proj_name, str) else proj.get("name", "unknown"),
                    "commits": commits[:5],
                })
        except Exception:
            pass

    return signals


def gather_learning_signals():
    """Get recent vault learnings from the past week."""
    signals = []
    learnings_dir = os.path.join(VAULT_DIR, "learnings")
    if not os.path.isdir(learnings_dir):
        return signals

    cutoff = datetime.datetime.now() - datetime.timedelta(days=7)

    for f in sorted(os.listdir(learnings_dir), reverse=True)[:20]:
        if not f.endswith(".md"):
            continue
        filepath = os.path.join(learnings_dir, f)
        try:
            stat = os.stat(filepath)
            mtime = datetime.datetime.fromtimestamp(stat.st_mtime)
            if mtime < cutoff:
                continue

            with open(filepath) as fh:
                content = fh.read()

            # Extract title from frontmatter
            title = ""
            for line in content.split("\n"):
                if line.startswith("title:"):
                    title = line.split(":", 1)[1].strip()
                    break
                if line.startswith("pattern-key:"):
                    title = line.split(":", 1)[1].strip()
                    break

            if title:
                signals.append({
                    "type": "learning",
                    "id": f.replace(".md", ""),
                    "title": title,
                    "snippet": content[:300],
                })
        except Exception:
            pass

    return signals[:5]


def gather_academic_signals():
    """Get recent course notes from tech courses only."""
    signals = []
    notes_dir = os.path.join(VAULT_DIR, "shared", "course-notes")
    if not os.path.isdir(notes_dir):
        return signals

    for course in TECH_COURSES:
        course_dir = os.path.join(notes_dir, course)
        if not os.path.isdir(course_dir):
            continue

        # Get most recent notes
        notes = sorted(
            [f for f in os.listdir(course_dir) if f.endswith(".md")],
            key=lambda f: os.path.getmtime(os.path.join(course_dir, f)),
            reverse=True,
        )[:3]

        for note_file in notes:
            filepath = os.path.join(course_dir, note_file)
            try:
                with open(filepath) as fh:
                    content = fh.read()[:500]
                signals.append({
                    "type": "academic",
                    "course": course,
                    "note": note_file.replace(".md", ""),
                    "snippet": content,
                })
            except Exception:
                pass

    return signals[:3]


def get_custom_topic():
    """Read and consume a topic from the queue file."""
    if not os.path.exists(TOPIC_QUEUE):
        return None

    with open(TOPIC_QUEUE) as f:
        topics = [l.strip() for l in f.readlines() if l.strip()]

    if not topics:
        return None

    topic = topics[0]
    # Remove consumed topic
    with open(TOPIC_QUEUE, "w") as f:
        f.write("\n".join(topics[1:]) + "\n" if len(topics) > 1 else "")

    return topic


def pick_post_type(signals):
    """Pick a post type based on available signals."""
    available = []
    git_signals = [s for s in signals if s["type"] == "git"]
    learning_signals = [s for s in signals if s["type"] == "learning"]
    academic_signals = [s for s in signals if s["type"] == "academic"]
    custom_topic = get_custom_topic()

    if git_signals:
        available.append(("project_update", 3, git_signals))
    if learning_signals:
        available.append(("technical_insight", 3, learning_signals))
    if academic_signals:
        available.append(("academic_highlight", 2, academic_signals))
    if custom_topic:
        available.append(("custom_topic", 1, [{"type": "custom", "topic": custom_topic}]))

    if not available:
        return None, None

    # Weighted random selection
    total = sum(w for _, w, _ in available)
    r = random.random() * total
    cumulative = 0
    for post_type, weight, type_signals in available:
        cumulative += weight
        if r <= cumulative:
            return post_type, type_signals

    return available[0][0], available[0][2]


# ─── Content Generation ──────────────────────────────────────────────

def generate_post(post_type, signals):
    """Use Claude to generate a LinkedIn post from the signals."""

    signal_text = json.dumps(signals, indent=2)

    prompts = {
        "project_update": f"""Write a LinkedIn post about recent software engineering work. Here are the signals (git commits and project activity):

{signal_text}

Guidelines:
- Professional but authentic tone — this is a CS student and aspiring software engineer
- Focus on what was built, what problem it solves, and what was learned
- Include 1-2 specific technical details that show depth
- End with a question or call to action to drive engagement
- Use line breaks for readability (LinkedIn doesn't render markdown)
- 150-250 words. No hashtags overload (3 max, at the end)
- Don't be generic — reference the specific work""",

        "technical_insight": f"""Write a LinkedIn post sharing a technical insight or lesson learned. Here are the signals (recent learnings):

{signal_text}

Guidelines:
- Share a specific technical lesson, not generic advice
- "Here's what I learned when X happened..." format works well
- Include the problem, the discovery, and the takeaway
- Professional but conversational — this is a CS student sharing real experience
- 150-250 words. 3 hashtags max at the end
- Make it useful to other engineers/students""",

        "academic_highlight": f"""Write a LinkedIn post connecting academic CS concepts to real-world engineering. Here are recent course notes:

{signal_text}

Guidelines:
- Bridge the gap between coursework and practical engineering
- "In my [course] class, we covered [concept] — here's why it matters for [real application]..."
- Show how academic knowledge applies to software engineering
- Professional tone — this is a CS student demonstrating applied understanding
- 150-250 words. 3 hashtags max at the end
- Don't sound like a textbook — make it relatable""",

        "custom_topic": f"""Write a LinkedIn post about the following topic:

{signals[0].get('topic', 'software engineering')}

Guidelines:
- Professional but authentic — written by a CS student and aspiring software engineer
- Include personal perspective or experience where relevant
- 150-250 words. 3 hashtags max at the end
- End with a question or insight to drive engagement""",
    }

    prompt = prompts.get(post_type, prompts["technical_insight"])

    try:
        clean_env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE")}
        clean_env["HOME"] = os.environ.get("HOME", "")
        clean_env["PATH"] = os.environ.get("PATH", "")

        result = subprocess.run(
            [
                os.path.join(os.environ.get("HOME", ""), ".local", "bin", "claude"),
                "-p", "--model", "sonnet",
                "--max-turns", "3",
                "--dangerously-skip-permissions",
                "--", prompt,
            ],
            capture_output=True, text=True, timeout=120,
            env=clean_env,
            stdin=subprocess.DEVNULL,
        )

        if result.returncode == 0 and result.stdout.strip():
            try:
                data = json.loads(result.stdout)
                return data.get("result", result.stdout.strip())
            except json.JSONDecodeError:
                return result.stdout.strip()
    except Exception as e:
        print(f"Content generation failed: {e}", file=sys.stderr)

    return None


# ─── Main ─────────────────────────────────────────────────────────────

def main():
    state = load_state()

    # Gather all signals
    print("Gathering signals...")
    all_signals = []
    all_signals.extend(gather_git_signals())
    all_signals.extend(gather_learning_signals())
    all_signals.extend(gather_academic_signals())

    print(f"  Git signals: {sum(1 for s in all_signals if s['type'] == 'git')}")
    print(f"  Learning signals: {sum(1 for s in all_signals if s['type'] == 'learning')}")
    print(f"  Academic signals: {sum(1 for s in all_signals if s['type'] == 'academic')}")

    # Pick post type
    post_type, type_signals = pick_post_type(all_signals)
    if not post_type:
        print("No signals available for post generation")
        return

    print(f"  Selected type: {post_type}")

    # Generate content
    print("Generating post content...")
    content = generate_post(post_type, type_signals)
    if not content:
        print("Failed to generate content")
        return

    # Clean up content — remove any markdown formatting Claude might add
    content = content.strip()
    if content.startswith('"') and content.endswith('"'):
        content = content[1:-1]

    # Create topic string
    topic_map = {
        "project_update": "Project Update",
        "technical_insight": "Technical Insight",
        "academic_highlight": "Academic Highlight",
        "custom_topic": "Custom Topic",
    }
    topic = topic_map.get(post_type, "Update")

    # Store draft for approval
    post_id, token = store_draft(topic, content, type_signals)
    print(f"Draft created: {post_id}")
    print(f"Approval token: {token}")
    print(f"Content preview: {content[:200]}...")

    # Update state
    state["last_run"] = datetime.datetime.now().isoformat()
    state["posts_generated"] = state.get("posts_generated", 0) + 1
    state["last_topics"].append({
        "type": post_type,
        "topic": topic,
        "date": datetime.datetime.now().strftime("%Y-%m-%d"),
    })
    # Keep last 20 topics
    state["last_topics"] = state["last_topics"][-20:]
    save_state(state)

    print(f"Done — draft posted to #linkedin for approval")


if __name__ == "__main__":
    main()
