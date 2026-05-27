#!/usr/bin/env python3
"""Vault freshness — deterministic SHA-lint over vault learnings.

Runs daily. No LLM calls.

For each vault learning that has citations with `blob_sha`, check whether the
cited file's current HEAD blob SHA still matches. If it doesn't, the citation
is pointing at code that has changed — flag the entry by setting
`status: stale-citation` and prepending a `> TODO-VERIFY` blockquote to the
body. The next reverification heartbeat (weekly, LLM-assisted) decides whether
the underlying claim is still true.

This pairs with `session-debrief.py`'s write-time SHA capture (added 2026-05-06).
"""

import os
import sys
import json
import re
import argparse
import datetime
import subprocess
from pathlib import Path

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)

TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
NOTIFY_FILE = os.path.join(TASKS_DIR, "pending-notifications.jsonl")
VAULT_LEARNINGS = Path(HARNESS_ROOT) / "vault" / "learnings"

STALE_MARKER = "> TODO-VERIFY: citation blob SHA changed since this entry was written; the cited file may no longer support the claim. Re-check before relying on it."


def notify(message: str, dry_run: bool = False):
    if dry_run:
        return
    entry = {
        "task": "vault-freshness",
        "channel": "notifications",
        "summary": message,
        "timestamp": datetime.datetime.now().isoformat(),
    }
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")


def git_blob_sha(path: str) -> str | None:
    """Current blob SHA at HEAD, or None if untracked or git fails."""
    try:
        r = subprocess.run(
            ["git", "-C", HARNESS_ROOT, "rev-parse", f"HEAD:{path}"],
            capture_output=True, text=True, timeout=5,
        )
        return r.stdout.strip() if r.returncode == 0 else None
    except Exception:
        return None


def parse_frontmatter(text: str) -> tuple[dict | None, str, str]:
    """Return (parsed_frontmatter, raw_frontmatter_block, body).

    parsed_frontmatter is a flat dict of top-level YAML keys. Citations are
    extracted into a list of dicts under the special key `_citations`.
    """
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.DOTALL)
    if not m:
        return None, "", text
    raw_fm, body = m.group(1), m.group(2)

    fm: dict = {}
    citations: list[dict] = []
    current_citation: dict | None = None
    in_citations_block = False

    for line in raw_fm.splitlines():
        if not line.strip():
            continue

        # Top-level scalar key
        top = re.match(r"^([a-zA-Z_][\w-]*)\s*:\s*(.*)$", line)
        if top and not line.startswith(" "):
            key, val = top.group(1), top.group(2).strip()
            in_citations_block = (key == "citations")
            current_citation = None
            if in_citations_block:
                continue  # block items follow on indented lines
            # Strip surrounding quotes if any
            if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                val = val[1:-1]
            fm[key] = val
            continue

        # Inside citations block
        if in_citations_block:
            list_item = re.match(r"^\s*-\s*path:\s*(.*)$", line)
            if list_item:
                if current_citation:
                    citations.append(current_citation)
                p = list_item.group(1).strip().strip('"').strip("'")
                current_citation = {"path": p}
                continue
            sub = re.match(r"^\s+([a-zA-Z_][\w-]*)\s*:\s*(.*)$", line)
            if sub and current_citation is not None:
                k, v = sub.group(1), sub.group(2).strip().strip('"').strip("'")
                current_citation[k] = v
                continue

    if current_citation:
        citations.append(current_citation)
    if citations:
        fm["_citations"] = citations
    return fm, raw_fm, body


def serialize_frontmatter(fm: dict) -> str:
    """Serialize the frontmatter dict back to a YAML block. Preserves order
    by recognizing canonical key order, then writes anything else after."""
    canonical_order = [
        "id", "logged", "type", "severity", "priority", "status",
        "superseded_by", "superseded_at", "category", "area", "agent",
        "project", "pattern-key", "recurrence-count", "first-seen",
        "last-seen", "tags", "related", "verified_at_sha",
        "stale_detected_at", "supersedes",
    ]
    lines = []
    written = set()
    for k in canonical_order:
        if k in fm and not k.startswith("_"):
            lines.append(f"{k}: {fm[k]}")
            written.add(k)
    # Any unknown top-level keys (preserve them at the end)
    for k, v in fm.items():
        if k.startswith("_") or k in written:
            continue
        lines.append(f"{k}: {v}")
    # Citations block (if present)
    if fm.get("_citations"):
        lines.append("citations:")
        for c in fm["_citations"]:
            path = c.get("path", "")
            lines.append(f"  - path: {path}")
            for k in ("lines", "evidence", "blob_sha"):
                if c.get(k):
                    lines.append(f"    {k}: {c[k]}")
    return "\n".join(lines)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Detect vault entries with stale citation SHAs.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run selection/reporting without rewriting vault entries or notifications.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None):
    args = parse_args(argv)
    if not VAULT_LEARNINGS.exists():
        print(f"Vault learnings dir not found: {VAULT_LEARNINGS}")
        return 0

    # Verify git is reachable
    head = subprocess.run(
        ["git", "-C", HARNESS_ROOT, "rev-parse", "HEAD"],
        capture_output=True, text=True, timeout=5,
    )
    if head.returncode != 0:
        print(f"git unavailable in {HARNESS_ROOT} — skipping freshness lint")
        return 0

    today = datetime.date.today().isoformat()
    scanned = 0
    with_citations = 0
    flagged = 0
    skipped_already_stale = 0
    examples: list[str] = []

    for entry_file in sorted(VAULT_LEARNINGS.glob("*.md")):
        scanned += 1
        try:
            text = entry_file.read_text(encoding="utf-8")
        except Exception:
            continue

        fm, raw_fm, body = parse_frontmatter(text)
        if not fm:
            continue
        citations = fm.get("_citations") or []
        if not citations:
            continue
        with_citations += 1

        status = (fm.get("status") or "").strip()
        # Skip if already known-stale or out-of-scope.
        if status in ("stale-citation", "needs-reverify", "superseded", "promoted", "archived"):
            if status == "stale-citation":
                skipped_already_stale += 1
            continue

        # Check each citation's blob SHA against HEAD.
        any_stale = False
        for c in citations:
            path = c.get("path", "").strip()
            recorded = (c.get("blob_sha") or "").strip()
            if not path or not recorded:
                continue
            current = git_blob_sha(path)
            if current is None:
                # Cited path no longer in repo — definitely stale.
                any_stale = True
                break
            if current != recorded:
                any_stale = True
                break

        if not any_stale:
            continue

        # Mark as stale and rewrite the file.
        fm["status"] = "stale-citation"
        fm["stale_detected_at"] = today

        # Prepend marker (avoid double-prepending if somehow re-run).
        new_body = body
        if STALE_MARKER not in new_body:
            new_body = STALE_MARKER + "\n\n" + body.lstrip()

        new_fm_str = serialize_frontmatter(fm)
        new_text = f"---\n{new_fm_str}\n---\n{new_body}"

        try:
            if not args.dry_run:
                entry_file.write_text(new_text, encoding="utf-8")
            flagged += 1
            if len(examples) < 5:
                examples.append(entry_file.stem)
        except Exception as e:
            print(f"  failed to rewrite {entry_file.name}: {e}", file=sys.stderr)

    flagged_label = "Would flag stale" if args.dry_run else "Newly flagged stale"
    header = "**Vault Freshness Lint (dry-run)**" if args.dry_run else "**Vault Freshness Lint**"
    summary = (
        f"{header}\n"
        f"Scanned: {scanned} entries ({with_citations} with citations)\n"
        f"{flagged_label}: {flagged}\n"
        f"Already stale (skipped): {skipped_already_stale}"
    )
    if examples:
        summary += "\n\nExamples:\n" + "\n".join(f"  - {e}" for e in examples)

    print(summary)
    if flagged > 0:
        notify(summary, dry_run=args.dry_run)

    return 0


if __name__ == "__main__":
    sys.exit(main())
