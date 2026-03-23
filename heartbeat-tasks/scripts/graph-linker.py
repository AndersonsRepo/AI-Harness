#!/usr/bin/env python3
"""Graph linker — builds knowledge graph edges between related vault learnings.

Runs daily. Fully deterministic — no LLM calls.

Edge creation rules:
1. Tag-based: 2+ shared tags → related_to (weight = Jaccard similarity)
2. Area + project: same area AND project → related_to (weight 0.5)
3. Pattern-key token overlap: 50%+ shared tokens → related_to (weight = overlap ratio)
4. Explicit related field: frontmatter `related` list → related_to (weight 1.0)
5. Supersession: frontmatter `superseded_by` → supersedes edge
"""

import os
import re
import json
import sqlite3
import datetime
from pathlib import Path
from itertools import combinations

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)

TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
NOTIFY_FILE = os.path.join(TASKS_DIR, "pending-notifications.jsonl")
VAULT_LEARNINGS = os.path.join(HARNESS_ROOT, "vault", "learnings")
DB_PATH = os.path.join(HARNESS_ROOT, "bridges", "discord", "harness.db")


def notify(message: str):
    entry = {
        "task": "graph-linker",
        "channel": "notifications",
        "summary": message,
        "timestamp": datetime.datetime.now().isoformat(),
    }
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")


def parse_frontmatter(filepath: Path) -> dict | None:
    """Parse YAML frontmatter without pyyaml. Handles scalar values and lists."""
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
    current_key = None

    for line in fm_text.splitlines():
        # List item (indented with -)
        if re.match(r"^\s+-\s+", line):
            if current_key is not None:
                item = re.sub(r"^\s+-\s+", "", line).strip()
                if current_key not in fm:
                    fm[current_key] = []
                if isinstance(fm[current_key], list):
                    fm[current_key].append(item)
            continue

        # Key: value line
        if ":" in line:
            key, _, val = line.partition(":")
            key = key.strip()
            val = val.strip()
            current_key = key

            # Inline list: [item1, item2, ...]
            inline_match = re.match(r"^\[(.*)\]$", val)
            if inline_match:
                inner = inline_match.group(1).strip()
                if inner:
                    fm[key] = [v.strip() for v in inner.split(",") if v.strip()]
                else:
                    fm[key] = []
            else:
                fm[key] = val
        else:
            current_key = None

    return fm


def jaccard_similarity(set_a: set, set_b: set) -> float:
    """Jaccard similarity between two sets."""
    if not set_a or not set_b:
        return 0.0
    intersection = set_a & set_b
    union = set_a | set_b
    return len(intersection) / len(union) if union else 0.0


def token_overlap_ratio(tokens_a: set, tokens_b: set) -> float:
    """Ratio of shared tokens to the smaller set's size."""
    if not tokens_a or not tokens_b:
        return 0.0
    intersection = tokens_a & tokens_b
    min_size = min(len(tokens_a), len(tokens_b))
    return len(intersection) / min_size if min_size else 0.0


def insert_edge(cursor: sqlite3.Cursor, source_id: str, target_id: str,
                relation: str, weight: float) -> bool:
    """Insert an edge, returning True if a new row was created."""
    try:
        cursor.execute(
            "INSERT OR IGNORE INTO learning_edges (source_id, target_id, relation, weight) "
            "VALUES (?, ?, ?, ?)",
            (source_id, target_id, relation, round(weight, 4))
        )
        return cursor.rowcount > 0
    except Exception:
        return False


def main():
    # Load all active learning entries
    learnings_dir = Path(VAULT_LEARNINGS)
    if not learnings_dir.exists():
        notify("Graph linker: vault/learnings directory not found")
        return

    entries = {}
    for md_file in sorted(learnings_dir.glob("*.md")):
        fm = parse_frontmatter(md_file)
        if fm is None:
            continue
        entry_id = fm.get("id", "")
        if not entry_id:
            continue
        status = fm.get("status", "")
        if status in ("archived", "superseded"):
            continue
        entries[entry_id] = fm

    if not entries:
        notify("Graph linker: no active entries found")
        return

    # Open database
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    cursor = conn.cursor()

    new_edges = 0
    entry_ids = list(entries.keys())

    # 1. Tag-based linking: pairs sharing 2+ tags
    for id_a, id_b in combinations(entry_ids, 2):
        tags_a = set(entries[id_a].get("tags", []) if isinstance(entries[id_a].get("tags"), list) else [])
        tags_b = set(entries[id_b].get("tags", []) if isinstance(entries[id_b].get("tags"), list) else [])
        shared = tags_a & tags_b
        if len(shared) >= 2:
            weight = jaccard_similarity(tags_a, tags_b)
            if insert_edge(cursor, id_a, id_b, "related_to", weight):
                new_edges += 1

    # 2. Area + project linking: same area AND project
    area_project_groups = {}
    for entry_id, fm in entries.items():
        area = fm.get("area", "")
        project = fm.get("project", "")
        if area and project:
            key = (area, project)
            area_project_groups.setdefault(key, []).append(entry_id)

    for group in area_project_groups.values():
        for id_a, id_b in combinations(group, 2):
            if insert_edge(cursor, id_a, id_b, "related_to", 0.5):
                new_edges += 1

    # 3. Pattern-key token overlap: 50%+ shared tokens
    pattern_keys = {}
    for entry_id, fm in entries.items():
        pk = fm.get("pattern-key", "")
        if pk:
            tokens = set(pk.split("-"))
            if tokens:
                pattern_keys[entry_id] = tokens

    pk_ids = list(pattern_keys.keys())
    for id_a, id_b in combinations(pk_ids, 2):
        ratio = token_overlap_ratio(pattern_keys[id_a], pattern_keys[id_b])
        if ratio >= 0.5:
            if insert_edge(cursor, id_a, id_b, "related_to", ratio):
                new_edges += 1

    # 4. Explicit related field
    for entry_id, fm in entries.items():
        related = fm.get("related", [])
        if not isinstance(related, list):
            continue
        for target_id in related:
            target_id = target_id.strip()
            if target_id and target_id in entries:
                if insert_edge(cursor, entry_id, target_id, "related_to", 1.0):
                    new_edges += 1

    # 5. Supersession edges
    for entry_id, fm in entries.items():
        superseded_by = fm.get("superseded_by", "")
        if superseded_by and superseded_by in entries:
            # supersedes edge: new entry → old entry
            if insert_edge(cursor, superseded_by, entry_id, "supersedes", 1.0):
                new_edges += 1

    conn.commit()

    # Count total edges
    cursor.execute("SELECT COUNT(*) FROM learning_edges")
    total_edges = cursor.fetchone()[0]
    conn.close()

    report = f"Graph linker: {new_edges} new edges created ({total_edges} total), {len(entries)} entries processed"
    notify(report)
    print(report)


if __name__ == "__main__":
    main()
