#!/usr/bin/env python3
"""Learning compressor — compress verbose vault learnings into compact summaries.

Scans vault/learnings/ for entries that are verbose (>800 chars body), at least
7 days old, with status 'new', and no existing compressed field. Sends each to
an LLM to produce a 150-250 char summary, then inserts `compressed: "..."` into
the file's YAML frontmatter.

The compressed field is used by context-assembler for more efficient context
injection — full body for recent/high-priority learnings, compressed text for
older ones.

Usage:
    python3 learning-compressor.py              # Compress qualifying entries
    python3 learning-compressor.py --dry-run    # Show what would be compressed, don't write
"""

import os
import sys
import json
import datetime
from pathlib import Path

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)

# LLM provider — defaults to claude-cli, overridable via LLM_PROVIDER env var
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from lib.llm_provider import get_provider, get_default_model, LLMError

TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
NOTIFY_FILE = os.path.join(TASKS_DIR, "pending-notifications.jsonl")
STATE_FILE = os.path.join(TASKS_DIR, "learning-compressor.state.json")
VAULT_LEARNINGS = os.path.join(HARNESS_ROOT, "vault", "learnings")

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

# Max entries to compress per run (cost control)
MAX_PER_RUN = 20
# Min body length (chars) to qualify for compression
MIN_BODY_CHARS = 800
# Min age (days) before compressing — give entries time to be useful in full form
MIN_AGE_DAYS = 7

COMPRESS_PROMPT = (
    "Compress this technical learning to 150-250 chars. "
    "Keep: the specific technical fact, the root cause/fix, and any code/config identifiers. "
    "Drop: context narrative, examples, verbose explanation. "
    "Output ONLY the compressed text, nothing else."
)


# ─── Helpers ──────────────────────────────────────────────────────────

def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"last_run": None, "total_compressed": 0, "runs": 0}


def save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.rename(tmp, STATE_FILE)


def notify(message: str):
    entry = {
        "task": "learning-compressor",
        "channel": "notifications",
        "summary": message,
        "timestamp": datetime.datetime.now().isoformat(),
    }
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")


def parse_frontmatter(filepath: Path) -> dict | None:
    """Parse YAML frontmatter from a vault learning file.

    Returns dict with frontmatter fields plus:
      _path: Path object
      _full_text: raw file content
      _fm_end: char offset of the closing '---' line
      _body: text after frontmatter
    """
    try:
        text = filepath.read_text(encoding="utf-8")
    except Exception:
        return None

    if not text.startswith("---"):
        return None

    end = text.find("---", 3)
    if end == -1:
        return None

    fm_text = text[3:end].strip()
    fm = {}
    for line in fm_text.splitlines():
        if ":" in line:
            key, _, val = line.partition(":")
            fm[key.strip()] = val.strip()

    # Find the actual closing --- position (end of the line)
    closing_newline = text.find("\n", end)
    body_start = closing_newline + 1 if closing_newline != -1 else end + 3

    fm["_path"] = filepath
    fm["_full_text"] = text
    fm["_fm_end"] = end  # position of closing ---
    fm["_body"] = text[body_start:]
    return fm


def insert_compressed_field(filepath: Path, compressed_text: str) -> bool:
    """Insert compressed: "..." line into frontmatter before the closing ---."""
    try:
        text = filepath.read_text(encoding="utf-8")
    except Exception:
        return False

    if not text.startswith("---"):
        return False

    end = text.find("---", 3)
    if end == -1:
        return False

    # Escape quotes in the compressed text
    escaped = compressed_text.replace('"', '\\"')
    insert_line = f'compressed: "{escaped}"\n'

    # Insert before the closing ---
    updated = text[:end] + insert_line + text[end:]
    try:
        filepath.write_text(updated, encoding="utf-8")
        return True
    except Exception:
        return False


def find_qualifying_entries() -> list[dict]:
    """Find vault learnings that qualify for compression."""
    if not os.path.isdir(VAULT_LEARNINGS):
        return []

    now = datetime.datetime.now()
    qualifying = []

    for filepath in Path(VAULT_LEARNINGS).glob("*.md"):
        fm = parse_frontmatter(filepath)
        if fm is None:
            continue

        # Must have a status representing a live entry. `new` was the
        # original convention; later curated entries use `active`.
        if fm.get("status", "") not in ("new", "active"):
            continue

        # Must not already have a compressed field
        if "compressed" in fm:
            continue

        # Must be older than MIN_AGE_DAYS. Older entries use `logged`;
        # newer curated entries use `created`.
        logged_str = fm.get("logged") or fm.get("created") or ""
        try:
            logged = datetime.datetime.fromisoformat(logged_str)
        except (ValueError, TypeError):
            continue

        age_days = (now - logged).days
        if age_days < MIN_AGE_DAYS:
            continue

        # Body must be > MIN_BODY_CHARS
        body = fm.get("_body", "")
        if len(body.strip()) <= MIN_BODY_CHARS:
            continue

        fm["_age_days"] = age_days
        qualifying.append(fm)

    # Sort by age descending (oldest first — most benefit from compression)
    qualifying.sort(key=lambda e: e.get("_age_days", 0), reverse=True)
    return qualifying[:MAX_PER_RUN]


def compress_entry(llm, body: str) -> str | None:
    """Send body text to LLM for compression. Returns compressed text or None."""
    prompt = f"{COMPRESS_PROMPT}\n\n---\n\n{body}"
    try:
        result = llm.complete(prompt, model="sonnet", timeout=60)
        text = result.text.strip() if hasattr(result, "text") else str(result).strip()
        # Sanity check: result should be 100-500 chars (allow some tolerance)
        if 50 <= len(text) <= 500:
            return text
        print(f"  WARNING: LLM returned {len(text)} chars, skipping")
        return None
    except LLMError as e:
        print(f"  LLM error: {e}")
        return None
    except Exception as e:
        print(f"  Unexpected error: {e}")
        return None


# ─── Main ─────────────────────────────────────────────────────────────

def main():
    dry_run = "--dry-run" in sys.argv

    entries = find_qualifying_entries()
    print(f"Found {len(entries)} qualifying entries for compression")

    if not entries:
        print("Nothing to compress")
        return

    if dry_run:
        print("\n--- DRY RUN ---")
        for e in entries:
            name = e["_path"].name
            body_len = len(e["_body"].strip())
            age = e.get("_age_days", "?")
            print(f"  {name}: {body_len} chars, {age}d old")
        print(f"\nWould compress {len(entries)} entries")
        return

    llm = get_provider()
    state = load_state()
    compressed_count = 0
    failed_count = 0

    for e in entries:
        name = e["_path"].name
        body = e["_body"].strip()
        print(f"Compressing {name} ({len(body)} chars, {e.get('_age_days', '?')}d old)...")

        compressed = compress_entry(llm, body)
        if compressed is None:
            failed_count += 1
            continue

        if insert_compressed_field(e["_path"], compressed):
            compressed_count += 1
            print(f"  OK: {compressed[:80]}...")
        else:
            failed_count += 1
            print(f"  FAILED to write frontmatter")

    # Update state
    state["last_run"] = datetime.datetime.now().isoformat()
    state["total_compressed"] = state.get("total_compressed", 0) + compressed_count
    state["runs"] = state.get("runs", 0) + 1
    state["last_compressed_count"] = compressed_count
    state["last_failed_count"] = failed_count
    save_state(state)

    # Report
    msg_parts = ["**Learning Compressor Complete**"]
    msg_parts.append(f"Compressed: {compressed_count}/{len(entries)} entries")
    if failed_count > 0:
        msg_parts.append(f"Failed: {failed_count}")
    msg_parts.append(f"Lifetime total: {state['total_compressed']}")
    message = "\n".join(msg_parts)

    if compressed_count > 0:
        notify(message)

    print(message)


if __name__ == "__main__":
    main()
