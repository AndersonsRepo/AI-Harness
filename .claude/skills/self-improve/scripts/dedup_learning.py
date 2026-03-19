"""Shared deduplication logic for vault learnings.

Called by activator.py and error_detector.py before creating new entries.

Usage:
    from dedup_learning import check_and_dedup
    action, match_id = check_and_dedup(vault_dir, pattern_key, category, tags_csv)
    # action: "new" or "skip"
    # match_id: ID of matched entry (when action == "skip")
"""

import os
import re
from datetime import date
from pathlib import Path


def check_and_dedup(
    vault_dir: str, pattern_key: str, category: str, tags_csv: str
) -> tuple[str, str]:
    """Check for duplicate vault entries. Returns (action, match_id)."""
    if not os.path.isdir(vault_dir):
        return ("new", "")

    generic_keys = {"auto-captured-error", "user-reported-bug", "user-feature-request"}

    # Strategy 1: Match by pattern-key (most precise)
    if pattern_key and pattern_key not in generic_keys:
        for fp in Path(vault_dir).glob("*.md"):
            content = fp.read_text(errors="replace")
            if re.search(rf"^pattern-key: {re.escape(pattern_key)}$", content, re.M):
                return _increment_recurrence(str(fp), content)

    # Strategy 2: Match by category + overlapping tags
    if category and tags_csv:
        tags = [t.strip() for t in tags_csv.split(",") if t.strip()]
        match_threshold = 2
        for fp in Path(vault_dir).glob("*.md"):
            content = fp.read_text(errors="replace")
            if not re.search(rf"^category: {re.escape(category)}$", content, re.M):
                continue
            tag_match = re.search(r"^tags:(.*)$", content, re.M)
            if not tag_match:
                continue
            tag_line = tag_match.group(1).lower()
            match_count = sum(1 for t in tags if t.lower() in tag_line)
            if match_count >= match_threshold:
                return _increment_recurrence(str(fp), content)

    return ("new", "")


def _increment_recurrence(filepath: str, content: str) -> tuple[str, str]:
    """Bump recurrence count and last-seen date on an existing entry."""
    today = date.today().isoformat()

    # Extract current count
    m = re.search(r"^recurrence-count:\s*(\d+)", content, re.M)
    current = int(m.group(1)) if m else 1
    new_count = current + 1

    # Extract ID
    id_match = re.search(r"^id:\s*(.+)$", content, re.M)
    match_id = id_match.group(1).strip() if id_match else ""

    # Update fields
    content = re.sub(
        r"^recurrence-count:.*$", f"recurrence-count: {new_count}", content, flags=re.M
    )
    content = re.sub(r"^last-seen:.*$", f"last-seen: {today}", content, flags=re.M)
    content = re.sub(r"^status: new$", "status: recurring", content, flags=re.M)

    Path(filepath).write_text(content)
    print(
        f"[SELF-IMPROVE] Recurring pattern ({match_id}, count: {new_count}). Updated existing entry."
    )
    return ("skip", match_id)
