#!/usr/bin/env python3
"""Session debrief — extract knowledge from recent Claude Code conversations.

Hybrid approach: deterministic code handles transcript extraction, dedup, file I/O,
and routing. The LLM handles the hard part — reading a conversation and deciding
what's worth remembering.

Usage:
    python3 session-debrief.py                    # Process most recent transcript
    python3 session-debrief.py --all              # Process all unprocessed transcripts
    python3 session-debrief.py --dry-run          # Show what would be extracted, don't write
    python3 session-debrief.py --transcript UUID  # Process a specific transcript
"""

import subprocess
import json
import os
import sys
import re
import hashlib
import argparse
import datetime
import glob

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
STATE_FILE = os.path.join(TASKS_DIR, "session-debrief.state.json")
VAULT_DIR = os.path.join(HARNESS_ROOT, "vault")
LEARNINGS_DIR = os.path.join(VAULT_DIR, "learnings")
KNOWLEDGE_DIR = os.path.join(VAULT_DIR, "shared", "project-knowledge")
PROJECTS_FILE = os.path.join(TASKS_DIR, "projects.json")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from lib.platform import paths
from lib.llm_provider import get_provider, get_default_model, LLMError

TRANSCRIPTS_DIR = os.environ.get(
    "CLAUDE_TRANSCRIPTS_DIR",
    os.path.join(paths.home(), ".claude", "projects")
)
CLAUDE_PATH = paths.claude_cli()

# Max chars of conversation to send to LLM for extraction
MAX_CONTEXT_CHARS = 25000
# Max messages to include
MAX_MESSAGES = 80


# ─── Transcript Extraction (Deterministic) ────────────────────────────

def find_transcripts(since_ts=None):
    """Find transcript .jsonl files, optionally filtered by modification time."""
    pattern = os.path.join(TRANSCRIPTS_DIR, "**", "*.jsonl")
    files = glob.glob(pattern, recursive=True)
    if since_ts:
        files = [f for f in files if os.path.getmtime(f) > since_ts]
    # Sort by modification time, newest first
    files.sort(key=os.path.getmtime, reverse=True)
    return files


def extract_conversation(transcript_path):
    """Extract user/assistant messages from a transcript JSONL.

    Returns a list of {role, text} dicts. Skips tool calls, progress,
    and system messages to keep the context focused on what was discussed.
    """
    messages = []
    try:
        with open(transcript_path) as f:
            for line in f:
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue

                msg_type = d.get("type")
                if msg_type not in ("user", "assistant"):
                    continue

                msg = d.get("message", {})
                if not isinstance(msg, dict):
                    continue

                content = msg.get("content", "")
                text = ""

                if isinstance(content, str):
                    text = content.strip()
                elif isinstance(content, list):
                    # Extract text blocks, skip tool_use/tool_result blocks
                    parts = []
                    for block in content:
                        if isinstance(block, dict):
                            if block.get("type") == "text":
                                parts.append(block.get("text", ""))
                            elif block.get("type") == "tool_use":
                                # Include tool name as brief context
                                tool = block.get("name", "?")
                                inp = block.get("input", {})
                                # For key tools, include a summary
                                if tool in ("Edit", "Write"):
                                    fp = inp.get("file_path", "")
                                    parts.append(f"[{tool}: {fp}]")
                                elif tool == "Bash":
                                    cmd = inp.get("command", "")[:100]
                                    parts.append(f"[Bash: {cmd}]")
                                else:
                                    parts.append(f"[{tool}]")
                    text = " ".join(parts).strip()

                if text and len(text) > 3:
                    messages.append({"role": msg_type, "text": text})

    except Exception as e:
        print(f"Error reading transcript: {e}", file=sys.stderr)

    return messages


def trim_conversation(messages, max_chars=MAX_CONTEXT_CHARS, max_messages=MAX_MESSAGES):
    """Trim conversation to fit within context budget.

    Keeps first few messages (for context on what the session was about)
    and last messages (for what was concluded/learned).
    """
    if not messages:
        return []

    # If short enough, return all
    total = sum(len(m["text"]) for m in messages)
    if total <= max_chars and len(messages) <= max_messages:
        return messages

    # Keep first 10 messages + last N messages that fit
    head = messages[:10]
    head_chars = sum(len(m["text"]) for m in head)
    remaining_budget = max_chars - head_chars - 200  # 200 for separator

    tail = []
    for m in reversed(messages[10:]):
        if remaining_budget <= 0 or len(tail) >= (max_messages - 10):
            break
        remaining_budget -= len(m["text"])
        tail.insert(0, m)

    return head + [{"role": "system", "text": "--- [middle of conversation trimmed] ---"}] + tail


def format_conversation_for_llm(messages):
    """Format messages into a readable conversation string."""
    lines = []
    for m in messages:
        role = "USER" if m["role"] == "user" else "ASSISTANT" if m["role"] == "assistant" else "---"
        if role == "---":
            lines.append(m["text"])
        else:
            lines.append(f"[{role}]: {m['text']}")
    return "\n\n".join(lines)


def detect_projects_discussed(messages):
    """Deterministically detect which projects were discussed."""
    projects = load_projects()
    text_blob = " ".join(m["text"].lower() for m in messages)

    mentioned = []
    for name, cfg in projects.items():
        # Check for project name, path fragments, or repo name
        triggers = [name.lower()]
        path = cfg.get("path", "")
        if path:
            triggers.append(os.path.basename(path.rstrip("/")).lower())
        repo = cfg.get("repo", "")
        if repo:
            triggers.append(repo.split("/")[-1].lower())

        if any(t in text_blob for t in triggers):
            mentioned.append(name)

    return mentioned


# ─── Project & State Helpers ──────────────────────────────────────────

def load_projects():
    if not os.path.exists(PROJECTS_FILE):
        return {}
    with open(PROJECTS_FILE) as f:
        return json.load(f).get("projects", {})


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"processed_transcripts": [], "last_run": None, "total_learnings_created": 0}


def save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.rename(tmp, STATE_FILE)


# ─── Existing Knowledge Check (Deterministic) ────────────────────────

def load_existing_pattern_keys():
    """Get all pattern-keys already in the vault for dedup."""
    keys = set()
    if not os.path.exists(LEARNINGS_DIR):
        return keys
    for fname in os.listdir(LEARNINGS_DIR):
        if not fname.endswith(".md"):
            continue
        try:
            with open(os.path.join(LEARNINGS_DIR, fname)) as f:
                content = f.read(2000)  # frontmatter is always near the top
            match = re.search(r'^pattern-key:\s*(.+)$', content, re.MULTILINE)
            if match:
                keys.add(match.group(1).strip())
        except Exception:
            continue
    return keys


def load_existing_entries():
    """Load existing vault entries with metadata for semantic dedup.

    Returns a list of dicts with: file_path, pattern_key, title, tags, body_preview, status.
    """
    entries = []
    if not os.path.exists(LEARNINGS_DIR):
        return entries
    for fname in os.listdir(LEARNINGS_DIR):
        if not fname.endswith(".md"):
            continue
        try:
            fpath = os.path.join(LEARNINGS_DIR, fname)
            with open(fpath) as f:
                content = f.read(3000)

            # Skip archived entries — don't match against stale knowledge
            status_match = re.search(r'^status:\s*(.+)$', content, re.MULTILINE)
            if status_match and status_match.group(1).strip() == "archived":
                continue

            pk_match = re.search(r'^pattern-key:\s*(.+)$', content, re.MULTILINE)
            title_match = re.search(r'^# (.+)$', content, re.MULTILINE)
            tags_match = re.search(r'^tags:\s*\[(.+)\]$', content, re.MULTILINE)

            # Extract body (everything after frontmatter and title)
            body = re.sub(r'^---\n[\s\S]*?\n---\n*', '', content).strip()
            body = re.sub(r'^# .+\n*', '', body).strip()

            entries.append({
                "file_path": fpath,
                "pattern_key": pk_match.group(1).strip() if pk_match else "",
                "title": title_match.group(1).strip() if title_match else "",
                "tags": set(t.strip() for t in tags_match.group(1).split(",")) if tags_match else set(),
                "body_preview": body[:300],
                "status": status_match.group(1).strip() if status_match else "new",
            })
        except Exception:
            continue
    return entries


def _tokenize(text):
    """Split text into lowercase tokens for similarity comparison."""
    return set(re.findall(r'[a-z0-9]+', text.lower()))


def find_similar_entry(item, existing_entries):
    """Find an existing vault entry that's semantically similar to a new item.

    Uses a weighted score from three signals:
    1. Pattern-key token overlap (strongest — these are curated identifiers)
    2. Title token overlap (strong — captures the core concept)
    3. Tag overlap (supporting — confirms domain match)

    Returns (entry, score) if score >= 0.5, else (None, 0).
    """
    new_pk_tokens = _tokenize(item.get("pattern_key", ""))
    new_title_tokens = _tokenize(item.get("title", ""))
    new_tags = set(t.lower().strip() for t in item.get("tags", []))

    best_match = None
    best_score = 0

    for entry in existing_entries:
        # Pattern-key similarity (Jaccard)
        pk_tokens = _tokenize(entry["pattern_key"])
        pk_union = new_pk_tokens | pk_tokens
        pk_sim = len(new_pk_tokens & pk_tokens) / len(pk_union) if pk_union else 0

        # Title similarity (Jaccard)
        title_tokens = _tokenize(entry["title"])
        title_union = new_title_tokens | title_tokens
        title_sim = len(new_title_tokens & title_tokens) / len(title_union) if title_union else 0

        # Tag overlap (Jaccard)
        tag_union = new_tags | entry["tags"]
        tag_sim = len(new_tags & entry["tags"]) / len(tag_union) if tag_union else 0

        # Weighted score: pattern-key and title matter most
        score = (pk_sim * 0.4) + (title_sim * 0.4) + (tag_sim * 0.2)

        if score > best_score:
            best_score = score
            best_match = entry

    if best_score >= 0.5:
        return best_match, best_score
    return None, 0


def bump_recurrence(entry):
    """Increment recurrence-count and update last-seen on an existing vault entry."""
    fpath = entry["file_path"]
    try:
        with open(fpath) as f:
            content = f.read()

        # Bump recurrence-count
        content = re.sub(
            r'^(recurrence-count:\s*)(\d+)$',
            lambda m: f"{m.group(1)}{int(m.group(2)) + 1}",
            content, count=1, flags=re.MULTILINE,
        )

        # Update last-seen
        today = datetime.date.today().isoformat()
        content = re.sub(
            r'^(last-seen:\s*).+$',
            f"\\g<1>{today}",
            content, count=1, flags=re.MULTILINE,
        )

        tmp = fpath + ".tmp"
        with open(tmp, "w") as f:
            f.write(content)
        os.rename(tmp, fpath)
        return True
    except Exception as e:
        print(f"  Failed to bump recurrence for {fpath}: {e}", file=sys.stderr)
        return False


def decide_conflict_action(new_item, existing_entry, score):
    """Decide whether a new learning should UPDATE (supersede), BUMP, or NOOP an existing entry.

    Uses an LLM call to make the decision based on content comparison.
    Falls back to BUMP if LLM fails.
    """
    # High similarity (>0.8) with identical pattern-key → almost certainly a duplicate → BUMP
    if score > 0.8:
        return "BUMP"

    # For moderate similarity (0.5-0.8), ask the LLM
    existing_body = existing_entry.get("body_preview", "")
    new_body = new_item.get("body", "")

    # Load full body if preview is short
    if len(existing_body) < 100:
        try:
            with open(existing_entry["file_path"]) as f:
                content = f.read()
            # Extract body after frontmatter
            parts = content.split("---", 2)
            if len(parts) >= 3:
                existing_body = parts[2].strip()[:500]
        except Exception:
            pass

    prompt = (
        f"Compare these two knowledge entries and decide the action:\n\n"
        f"EXISTING ENTRY (ID: {existing_entry.get('pattern_key', '?')}):\n"
        f"Title: {existing_entry.get('title', '?')}\n"
        f"Body: {existing_body}\n\n"
        f"NEW ENTRY:\n"
        f"Title: {new_item.get('title', '?')}\n"
        f"Body: {new_body}\n\n"
        f"Choose exactly one action:\n"
        f"- UPDATE: The new entry supersedes the old one (new info, correction, or better understanding)\n"
        f"- BUMP: Same knowledge, just confirming it's still relevant (increment recurrence)\n"
        f"- NOOP: The new entry adds nothing — skip it entirely\n\n"
        f"Respond with ONLY one word: UPDATE, BUMP, or NOOP"
    )

    try:
        llm = get_provider()
        response = llm.complete(prompt, model=get_default_model(), timeout=30, max_turns=1)
        action = response.text.strip().upper()
        if action in ("UPDATE", "BUMP", "NOOP"):
            return action
    except Exception as e:
        print(f"  Conflict resolution LLM failed: {e}", file=sys.stderr)

    return "BUMP"  # Safe fallback


def mark_superseded(entry, new_id):
    """Mark an existing vault entry as superseded by a new entry."""
    fpath = entry["file_path"]
    try:
        with open(fpath) as f:
            content = f.read()

        # Update status
        content = re.sub(
            r'^(status:\s*).+$',
            f"\\g<1>superseded",
            content, count=1, flags=re.MULTILINE,
        )

        # Add superseded_by and superseded_at fields
        today = datetime.date.today().isoformat()
        # Insert after status line
        content = re.sub(
            r'^(status:\s*superseded)$',
            f"\\1\nsuperseded_by: {new_id}\nsuperseded_at: {today}",
            content, count=1, flags=re.MULTILINE,
        )

        tmp = fpath + ".tmp"
        with open(tmp, "w") as f:
            f.write(content)
        os.rename(tmp, fpath)

        # Also insert a supersedes edge in the knowledge graph
        _insert_graph_edge(new_id, entry.get("pattern_key", ""), "supersedes")

        return True
    except Exception as e:
        print(f"  Failed to mark superseded: {fpath}: {e}", file=sys.stderr)
        return False


def _insert_graph_edge(source_id, target_id, relation, weight=1.0):
    """Insert an edge into the learning_edges table."""
    db_path = os.path.join(HARNESS_ROOT, "bridges", "discord", "harness.db")
    if not os.path.exists(db_path):
        return
    try:
        import sqlite3
        db = sqlite3.connect(db_path)
        db.execute(
            "INSERT OR IGNORE INTO learning_edges (source_id, target_id, relation, weight) VALUES (?, ?, ?, ?)",
            (source_id, target_id, relation, weight),
        )
        db.commit()
        db.close()
    except Exception:
        pass


def next_learning_id(prefix="LRN"):
    """Generate the next available learning ID for today."""
    today = datetime.date.today().strftime("%Y%m%d")
    existing = []
    if os.path.exists(LEARNINGS_DIR):
        for fname in os.listdir(LEARNINGS_DIR):
            if fname.startswith(f"{prefix}-{today}-"):
                try:
                    num = int(fname.split("-")[-1].replace(".md", ""))
                    existing.append(num)
                except ValueError:
                    pass
    next_num = max(existing, default=0) + 1
    return f"{prefix}-{today}-{next_num:03d}"


# ─── LLM Knowledge Extraction ────────────────────────────────────────

EXTRACTION_PROMPT = """You are a knowledge extraction system. Distill this conversation into actionable knowledge worth remembering for future sessions.

CONVERSATION:
{conversation}

PROJECTS DISCUSSED: {projects}
EXISTING PATTERN KEYS (do NOT duplicate these): {existing_keys}
EXISTING ENTRY TITLES (reuse similar pattern-keys if the concept overlaps): {existing_titles}

QUALITY BAR: Only extract knowledge that would change how you approach future work. Skip trivial observations, routine operations, and things obvious from reading the code. Ask: "If I encounter this situation again in 3 months, what do I wish I knew?"

Respond with ONLY a JSON array. Each item must have these fields:
- "type": "learning" or "error"
- "title": short descriptive title (max 10 words)
- "pattern_key": unique kebab-case identifier (check it's not in the existing keys list)
- "area": one of "infra", "architecture", "security", "dependency-management", "ui", "api", "database", "testing", "deployment", "ai-ml"
- "project": project name if specific to one, or "ai-harness" if general
- "tags": array of 3-5 relevant tags
- "body": 1-2 sentences max. Format: "WHAT happened/was decided. WHY it matters / HOW to apply it." No filler, no context that's obvious from the title.
- "severity": for errors only — "critical", "high", "medium", "low"
- "priority": for learnings only — "critical", "medium", "low"

What to extract:
1. **Root causes** — Why something broke, not just that it broke (type: error)
2. **Decisions with tradeoffs** — What was chosen AND what was rejected (type: learning)
3. **Non-obvious gotchas** — Things that fail silently or waste time if you don't know (type: error)
4. **Reusable patterns** — Approaches that solved a class of problems, not just one instance (type: learning)

What to SKIP:
- Facts derivable from reading the code or git history
- Routine operations (ran tests, restarted service, updated dependency)
- Architecture that's already documented in CLAUDE.md
- Anything where the "body" would just restate the "title"

If nothing meets this bar, return an empty array: []

IMPORTANT: Return ONLY valid JSON. No markdown, no explanation, just the array."""


def extract_knowledge_via_llm(conversation_text, projects, existing_keys, existing_entries, timeout=120):
    """Send conversation to Claude for knowledge extraction. Returns parsed JSON."""
    existing_titles = [e["title"] for e in existing_entries if e["title"]][:50]
    prompt = EXTRACTION_PROMPT.format(
        conversation=conversation_text,
        projects=", ".join(projects) if projects else "none detected",
        existing_keys=", ".join(list(existing_keys)[:50]) if existing_keys else "none",
        existing_titles=", ".join(existing_titles) if existing_titles else "none",
    )

    try:
        llm = get_provider()
        response = llm.complete(prompt, model=get_default_model(), timeout=timeout, cwd=HARNESS_ROOT)
        text = response.text.strip()

        # Extract JSON array from response (LLM may wrap it in markdown)
        if text.startswith("```"):
            text = re.sub(r'^```(?:json)?\s*', '', text)
            text = re.sub(r'\s*```$', '', text)

        items = json.loads(text)
        if not isinstance(items, list):
            return []
        return items

    except LLMError as e:
        print(f"LLM extraction failed: {e}", file=sys.stderr)
        return []
    except (json.JSONDecodeError, Exception) as e:
        print(f"Failed to parse extraction output: {e}", file=sys.stderr)
        return []


# ─── Write Knowledge to Vault (Deterministic) ────────────────────────

def write_vault_entry(item, existing_keys, supersedes=None):
    """Write a single learning/error to the vault. Returns the ID or None if skipped."""
    pattern_key = item.get("pattern_key", "")
    if not pattern_key or pattern_key in existing_keys:
        return None  # Skip duplicates

    entry_type = item.get("type", "learning")
    prefix = "ERR" if entry_type == "error" else "LRN"
    entry_id = next_learning_id(prefix)
    today = datetime.date.today().isoformat()
    now = datetime.datetime.now().isoformat()

    tags = item.get("tags", [])
    tags_str = ", ".join(tags)

    lines = [
        "---",
        f"id: {entry_id}",
        f"logged: {now}",
        f"type: {entry_type}",
    ]

    if entry_type == "error":
        lines.append(f"severity: {item.get('severity', 'medium')}")
    else:
        lines.append(f"priority: {item.get('priority', 'medium')}")

    lines.extend([
        "status: new",
        f"category: best_practice",
        f"area: {item.get('area', 'infra')}",
        "agent: session-debrief",
        f"project: {item.get('project', 'ai-harness')}",
        f"pattern-key: {pattern_key}",
        "recurrence-count: 1",
        f"first-seen: {today}",
        f"last-seen: {today}",
        f"tags: [{tags_str}]",
        "related: []",
    ])

    if supersedes:
        lines.append(f"supersedes: {supersedes}")

    lines.append("---")
        "",
        f"# {item.get('title', 'Untitled')}",
        "",
        item.get("body", ""),
        "",
    ])

    os.makedirs(LEARNINGS_DIR, exist_ok=True)
    file_path = os.path.join(LEARNINGS_DIR, f"{entry_id}.md")
    with open(file_path, "w") as f:
        f.write("\n".join(lines))

    return entry_id


def append_to_project_knowledge(project_name, items):
    """Append session learnings to a project's knowledge file.

    Also checks for recurring project-specific patterns and promotes them
    to the Conventions section when they recur 2+ times.
    """
    knowledge_file = os.path.join(KNOWLEDGE_DIR, f"{project_name}.md")
    if not os.path.exists(knowledge_file):
        return  # Don't create new knowledge files — use project_scan for that

    project_items = [i for i in items if i.get("project") == project_name]
    if not project_items:
        return

    content = ""
    with open(knowledge_file, "r") as f:
        content = f.read()

    # Append session learnings
    today = datetime.date.today().isoformat()
    section = f"\n## Session Learnings ({today})\n\n"
    for item in project_items:
        section += f"- **{item.get('title', '?')}**: {item.get('body', '').split('.')[0]}.\n"

    with open(knowledge_file, "a") as f:
        f.write(section)

    # Check for recurring patterns → promote to Conventions
    promote_recurring_to_conventions(project_name, content)


def promote_recurring_to_conventions(project_name, knowledge_content):
    """Scan vault learnings for recurring project-specific patterns.

    When a pattern-key for this project has recurrence-count >= 2,
    and it's not already in the Conventions section, add it.
    """
    if not os.path.exists(LEARNINGS_DIR):
        return

    # Find the Conventions section in the knowledge file
    conventions_match = re.search(r'^## Conventions\s*\n(.*?)(?=\n## |\Z)', knowledge_content, re.MULTILINE | re.DOTALL)
    if not conventions_match:
        return  # No conventions section to write to

    existing_conventions = conventions_match.group(1).lower()

    # Find recurring project-specific learnings
    new_conventions = []
    for fname in os.listdir(LEARNINGS_DIR):
        if not fname.endswith(".md"):
            continue
        try:
            fpath = os.path.join(LEARNINGS_DIR, fname)
            with open(fpath) as f:
                entry = f.read(3000)

            # Check it's for this project
            proj_match = re.search(r'^project:\s*(.+)$', entry, re.MULTILINE)
            if not proj_match or proj_match.group(1).strip() != project_name:
                continue

            # Check recurrence
            rec_match = re.search(r'^recurrence-count:\s*(\d+)$', entry, re.MULTILINE)
            if not rec_match or int(rec_match.group(1)) < 2:
                continue

            # Get the title
            title_match = re.search(r'^# (.+)$', entry, re.MULTILINE)
            if not title_match:
                continue
            title = title_match.group(1).strip()

            # Check it's not already in conventions
            if title.lower() in existing_conventions:
                continue

            # Get pattern-key to check conventions more broadly
            pk_match = re.search(r'^pattern-key:\s*(.+)$', entry, re.MULTILINE)
            if pk_match and pk_match.group(1).strip().lower().replace("-", " ") in existing_conventions:
                continue

            # Extract a one-line summary from the body
            body = re.sub(r'^---\n[\s\S]*?\n---\n*', '', entry).strip()
            body = re.sub(r'^# .+\n*', '', body).strip()
            first_sentence = body.split('.')[0].strip() if body else title
            if len(first_sentence) > 120:
                first_sentence = first_sentence[:117] + "..."

            new_conventions.append(f"- {first_sentence}")

        except Exception:
            continue

    if not new_conventions:
        return

    # Append to conventions section
    knowledge_file = os.path.join(KNOWLEDGE_DIR, f"{project_name}.md")
    with open(knowledge_file, "r") as f:
        content = f.read()

    # Find the placeholder text and replace, or append after ## Conventions
    placeholder = "*No conventions yet. These are populated automatically as project-specific patterns are discovered across sessions.*"
    if placeholder in content:
        content = content.replace(placeholder, "\n".join(new_conventions))
    else:
        # Append after the existing conventions
        insert_point = content.find("## Conventions")
        if insert_point == -1:
            return
        # Find end of conventions section
        next_section = re.search(r'\n## ', content[insert_point + 15:])
        if next_section:
            pos = insert_point + 15 + next_section.start()
        else:
            pos = len(content)
        content = content[:pos].rstrip() + "\n" + "\n".join(new_conventions) + "\n" + content[pos:]

    with open(knowledge_file, "w") as f:
        f.write(content)

    print(f"  Promoted {len(new_conventions)} convention(s) for {project_name}", file=sys.stderr)


# ─── Main ─────────────────────────────────────────────────────────────

def process_transcript(transcript_path, existing_keys, existing_entries, dry_run=False):
    """Process a single transcript. Returns list of created IDs."""
    transcript_id = os.path.basename(transcript_path).replace(".jsonl", "")
    print(f"Processing: {transcript_id}", file=sys.stderr)

    # 1. Extract conversation (deterministic)
    messages = extract_conversation(transcript_path)
    if len(messages) < 5:
        print(f"  Skipping — too short ({len(messages)} messages)", file=sys.stderr)
        return []

    # 2. Detect projects (deterministic)
    projects = detect_projects_discussed(messages)
    print(f"  Projects: {projects or 'none'}", file=sys.stderr)

    # 3. Trim and format (deterministic)
    trimmed = trim_conversation(messages)
    conversation_text = format_conversation_for_llm(trimmed)
    print(f"  Context: {len(conversation_text)} chars from {len(trimmed)} messages", file=sys.stderr)

    if dry_run:
        print(f"  [DRY RUN] Would send {len(conversation_text)} chars to LLM", file=sys.stderr)
        return []

    # 4. LLM extraction (non-deterministic — the one LLM step)
    items = extract_knowledge_via_llm(conversation_text, projects, existing_keys, existing_entries)
    print(f"  LLM extracted: {len(items)} items", file=sys.stderr)

    if not items:
        return []

    # 5. Write to vault — dedup + conflict resolution against existing entries
    created = []
    for item in items:
        # Check for semantic similarity with existing entries
        match, score = find_similar_entry(item, existing_entries)
        if match:
            # P2: Decide action via conflict resolution
            action = decide_conflict_action(item, match, score)

            if action == "NOOP":
                print(f"  Skipped (NOOP): '{item.get('title', '?')}' — adds nothing to "
                      f"'{match.get('title', '?')}' (score={score:.2f})", file=sys.stderr)
                existing_keys.add(item.get("pattern_key", ""))
                continue
            elif action == "BUMP":
                bumped = bump_recurrence(match)
                if bumped:
                    print(f"  Bumped: {os.path.basename(match['file_path'])} "
                          f"(score={score:.2f}, matched '{item.get('title', '?')}')", file=sys.stderr)
                    existing_keys.add(item.get("pattern_key", ""))
                continue
            elif action == "UPDATE":
                # Write the new entry, then mark the old one as superseded
                entry_id = write_vault_entry(item, existing_keys, supersedes=match.get("pattern_key"))
                if entry_id:
                    mark_superseded(match, entry_id)
                    created.append(entry_id)
                    existing_keys.add(item.get("pattern_key", ""))
                    print(f"  Updated: {entry_id} supersedes {os.path.basename(match['file_path'])} "
                          f"(score={score:.2f})", file=sys.stderr)
                continue

        entry_id = write_vault_entry(item, existing_keys)
        if entry_id:
            created.append(entry_id)
            existing_keys.add(item.get("pattern_key", ""))
            # Add new entry to existing_entries so subsequent items can match against it
            existing_entries.append({
                "file_path": os.path.join(LEARNINGS_DIR, f"{entry_id}.md"),
                "pattern_key": item.get("pattern_key", ""),
                "title": item.get("title", ""),
                "tags": set(t.lower().strip() for t in item.get("tags", [])),
                "body_preview": item.get("body", "")[:300],
                "status": "new",
            })
            print(f"  Created: {entry_id} — {item.get('title', '?')}", file=sys.stderr)

    # 6. Append to project knowledge files (deterministic)
    for project in projects:
        append_to_project_knowledge(project, items)

    return created


def main():
    parser = argparse.ArgumentParser(description="Session debrief — extract knowledge from transcripts")
    parser.add_argument("--all", action="store_true", help="Process all unprocessed transcripts")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be extracted without writing")
    parser.add_argument("--transcript", help="Process a specific transcript UUID")
    args = parser.parse_args()

    state = load_state()
    processed = set(state.get("processed_transcripts", []))
    existing_entries = load_existing_entries()
    existing_keys = set(e["pattern_key"] for e in existing_entries if e["pattern_key"])

    # Find transcripts to process
    if args.transcript:
        matches = glob.glob(os.path.join(TRANSCRIPTS_DIR, "**", f"{args.transcript}.jsonl"), recursive=True)
        if not matches:
            print(f"Transcript not found: {args.transcript}")
            return
        transcripts = [matches[0]]
    elif args.all:
        transcripts = find_transcripts()
        # Filter out already processed
        transcripts = [t for t in transcripts
                       if os.path.basename(t).replace(".jsonl", "") not in processed]
    else:
        # Just the most recent unprocessed
        all_transcripts = find_transcripts()
        transcripts = []
        for t in all_transcripts:
            tid = os.path.basename(t).replace(".jsonl", "")
            if tid not in processed:
                transcripts = [t]
                break
        if not transcripts and all_transcripts:
            # All processed — grab the most recent anyway if modified since last run
            last_run = state.get("last_run")
            if last_run:
                last_ts = datetime.datetime.fromisoformat(last_run).timestamp()
                recent = find_transcripts(since_ts=last_ts)
                if recent:
                    transcripts = [recent[0]]

    if not transcripts:
        print("No unprocessed transcripts found.", file=sys.stderr)
        return

    print(f"Found {len(transcripts)} transcript(s) to process", file=sys.stderr)

    total_created = []
    for transcript_path in transcripts:
        tid = os.path.basename(transcript_path).replace(".jsonl", "")
        created = process_transcript(transcript_path, existing_keys, existing_entries, dry_run=args.dry_run)
        total_created.extend(created)

        if not args.dry_run:
            processed.add(tid)

    # Update state
    if not args.dry_run:
        state["processed_transcripts"] = list(processed)
        state["last_run"] = datetime.datetime.now().isoformat()
        state["total_learnings_created"] = state.get("total_learnings_created", 0) + len(total_created)
        save_state(state)

    # Summary
    print(f"\nDone. Created {len(total_created)} vault entries from {len(transcripts)} transcript(s).")
    for entry_id in total_created:
        print(f"  {entry_id}")


if __name__ == "__main__":
    main()
