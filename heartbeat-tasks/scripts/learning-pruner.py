#!/usr/bin/env python3
"""Learning pruner — archives stale/low-value vault learnings to reduce context bloat.

Runs daily. Deterministic — no LLM calls.

Rules:
1. Archive 'new' entries with priority 'low' older than 14 days
2. Archive 'new' entries with priority 'medium' older than 30 days
3. Archive 'resolved' entries older than 7 days (fix is in the code, learning served its purpose)
4. Never touch 'promoted' entries
5. Deduplicate: if two entries have the same title (after normalization), archive the older one
6. Report stats to Discord
"""

import os
import re
import json
import datetime
from pathlib import Path
from collections import defaultdict

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)

TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
NOTIFY_FILE = os.path.join(TASKS_DIR, "pending-notifications.jsonl")
VAULT_LEARNINGS = os.path.join(HARNESS_ROOT, "vault", "learnings")


def notify(message: str):
    entry = {
        "task": "learning-pruner",
        "channel": "notifications",
        "summary": message,
        "timestamp": datetime.datetime.now().isoformat(),
    }
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")


def parse_frontmatter(filepath: Path) -> dict | None:
    """Parse YAML frontmatter from a vault learning file."""
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

    fm["_path"] = filepath
    fm["_full_text"] = text
    return fm


def update_status(filepath: Path, old_status: str, new_status: str) -> bool:
    """Update status field in YAML frontmatter."""
    try:
        text = filepath.read_text(encoding="utf-8")
        updated = text.replace(f"status: {old_status}", f"status: {new_status}", 1)
        if updated != text:
            filepath.write_text(updated, encoding="utf-8")
            return True
    except Exception:
        pass
    return False


def normalize_title(title: str) -> str:
    """Normalize title for dedup comparison."""
    title = title.lower().strip()
    title = re.sub(r"[^a-z0-9\s]", "", title)
    title = re.sub(r"\s+", " ", title)
    return title


def main():
    if not os.path.isdir(VAULT_LEARNINGS):
        print("Vault learnings directory not found")
        return

    now = datetime.datetime.now()
    files = list(Path(VAULT_LEARNINGS).glob("*.md"))
    print(f"Scanning {len(files)} vault learnings...")

    # Parse all frontmatter
    entries = []
    for f in files:
        fm = parse_frontmatter(f)
        if fm:
            entries.append(fm)

    # Stats
    by_status = defaultdict(int)
    for e in entries:
        by_status[e.get("status", "unknown")] += 1
    print(f"Status breakdown: {dict(by_status)}")

    archived_count = 0
    dedup_count = 0
    reasons = defaultdict(int)

    # --- Rule 1-3: Age-based archival ---
    for e in entries:
        status = e.get("status", "")
        priority = e.get("priority", "medium")
        logged_str = e.get("logged", "")

        if status in ("promoted", "archived"):
            continue

        try:
            logged = datetime.datetime.fromisoformat(logged_str)
        except (ValueError, TypeError):
            continue

        age_days = (now - logged).days

        should_archive = False
        reason = ""

        if status == "resolved" and age_days > 7:
            should_archive = True
            reason = "resolved >7d"
        elif status == "new" and priority == "low" and age_days > 14:
            should_archive = True
            reason = "new/low >14d"
        elif status == "new" and priority == "medium" and age_days > 30:
            should_archive = True
            reason = "new/medium >30d"

        if should_archive:
            if update_status(e["_path"], status, "archived"):
                archived_count += 1
                reasons[reason] += 1

    # --- Rule 5: Deduplication ---
    title_groups = defaultdict(list)
    for e in entries:
        if e.get("status") == "archived":
            continue
        title = e.get("title", e.get("pattern-key", ""))
        if title:
            norm = normalize_title(title)
            if norm and len(norm) > 5:  # Skip very short titles
                title_groups[norm].append(e)

    for norm_title, group in title_groups.items():
        if len(group) < 2:
            continue

        # Sort by logged date, keep newest
        group.sort(key=lambda e: e.get("logged", ""), reverse=True)
        for dupe in group[1:]:  # Archive all but newest
            if dupe.get("status") in ("promoted", "archived"):
                continue
            if update_status(dupe["_path"], dupe["status"], "archived"):
                dedup_count += 1

    total_archived = archived_count + dedup_count

    # Report
    remaining = len(entries) - total_archived - by_status.get("archived", 0)
    msg_parts = [f"**Vault Pruning Complete**"]
    msg_parts.append(f"Scanned: {len(entries)} entries")

    if total_archived > 0:
        msg_parts.append(f"Archived: {total_archived} ({archived_count} stale, {dedup_count} duplicates)")
        if reasons:
            reason_str = ", ".join(f"{r}: {c}" for r, c in reasons.items())
            msg_parts.append(f"Reasons: {reason_str}")
    else:
        msg_parts.append("No entries to archive")

    msg_parts.append(f"Remaining active: ~{remaining}")
    message = "\n".join(msg_parts)

    if total_archived > 0:
        notify(message)

    print(message)


if __name__ == "__main__":
    main()
