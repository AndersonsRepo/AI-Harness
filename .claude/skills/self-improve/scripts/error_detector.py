#!/usr/bin/env python3
"""Hook: PostToolUse (matcher: Bash)
Auto-captures meaningful errors to vault/learnings/
Writes the file directly instead of nudging Claude.
"""

import hashlib
import os
import re
import sys
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
HARNESS_ROOT = Path(os.environ.get("HARNESS_ROOT", SCRIPT_DIR.parent.parent.parent))
VAULT_DIR = HARNESS_ROOT / "vault" / "learnings"

sys.path.insert(0, str(SCRIPT_DIR))
from dedup_learning import check_and_dedup

# Known noise patterns to skip
NOISE_PATTERNS = re.compile(
    r"(No such file or directory$|no matches found|nothing to commit|"
    r"Already up to date|Everything up-to-date)",
    re.I,
)
DEPRECATION_RE = re.compile(r"^(\(node:\d+\) DeprecationWarning|warning:)", re.I)
OPTIONAL_TOOLS_RE = re.compile(r"(bun|pnpm|yarn|brew)", re.I)
SEVERE_IN_SUCCESS_RE = re.compile(r"(traceback|panic:|segfault|FATAL)", re.I)


def main():
    exit_code = sys.argv[1] if len(sys.argv) > 1 else ""
    stdout = sys.argv[2] if len(sys.argv) > 2 else ""
    stderr = sys.argv[3] if len(sys.argv) > 3 else ""

    if not exit_code:
        sys.exit(0)

    if exit_code == "0":
        # Check for error patterns in successful exits, but only severe ones
        if not SEVERE_IN_SUCCESS_RE.search(stdout + stderr):
            sys.exit(0)

    error_msg = stderr or stdout

    # Noise filtering
    if not error_msg or len(error_msg) < 10:
        sys.exit(0)
    if NOISE_PATTERNS.search(error_msg):
        sys.exit(0)
    if DEPRECATION_RE.search(error_msg) and exit_code == "0":
        sys.exit(0)
    if "command not found" in error_msg.lower() and OPTIONAL_TOOLS_RE.search(error_msg):
        sys.exit(0)

    # Hash-based dedup (last 200 error signatures)
    error_hash = hashlib.md5(error_msg[:100].encode()).hexdigest()
    dedup_file = HARNESS_ROOT / "vault" / ".error-hashes"
    dedup_file.touch(exist_ok=True)
    existing = dedup_file.read_text().splitlines()
    if error_hash in existing:
        print("[SELF-IMPROVE] Recurring error (already logged). Check vault/learnings/ for existing entry.")
        sys.exit(0)
    existing.append(error_hash)
    # Keep bounded (last 200)
    dedup_file.write_text("\n".join(existing[-200:]) + "\n")

    # Vault dedup check
    error_tags = f"auto-captured,exit-code-{exit_code}"
    action, _match_id = check_and_dedup(
        str(VAULT_DIR), "auto-captured-error", "runtime_error", error_tags
    )
    if action == "skip":
        sys.exit(0)

    # Write vault entry
    VAULT_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now()
    today_str = now.strftime("%Y%m%d")
    today_dash = now.strftime("%Y-%m-%d")
    timestamp = now.strftime("%Y-%m-%dT%H:%M:%S")

    seq = 1
    while (VAULT_DIR / f"ERR-{today_str}-{seq:03d}.md").exists():
        seq += 1
    entry_id = f"ERR-{today_str}-{seq:03d}"

    error_short = error_msg[:500]
    # Extract title from error
    title_match = re.search(r"(error|failed|exception|traceback|fatal)", error_msg, re.I)
    if title_match:
        title_line = error_msg[: error_msg.find("\n", title_match.start())]
        title = title_line[title_match.start() : title_match.start() + 80].strip()
    else:
        title = error_msg.split("\n")[0][:80]

    content = f"""---
id: {entry_id}
logged: {timestamp}
type: error
severity: medium
status: new
category: runtime_error
area: general
agent: main
project: general
pattern-key: auto-captured-error
recurrence-count: 1
first-seen: {today_dash}
last-seen: {today_dash}
tags: [auto-captured, exit-code-{exit_code}]
related: []
---

# {title}

## Command
Auto-captured by error-detector hook.

## Error
```
{error_short}
```

## Exit Code
{exit_code}

## Root Cause
(To be filled in when investigated)

## Fix
(To be filled in when resolved)
"""

    (VAULT_DIR / f"{entry_id}.md").write_text(content)
    print(
        f"[SELF-IMPROVE] Error auto-logged to vault/learnings/{entry_id}.md "
        f"— review and update root cause/fix when resolved."
    )


if __name__ == "__main__":
    main()
