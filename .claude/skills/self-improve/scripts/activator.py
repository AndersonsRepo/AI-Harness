#!/usr/bin/env python3
"""Hook: UserPromptSubmit
Auto-captures learnings, corrections, feature requests, decisions,
preferences, and external knowledge to vault/learnings/
"""

import os
import re
import sys
from datetime import datetime
from pathlib import Path

# Resolve HARNESS_ROOT
SCRIPT_DIR = Path(__file__).resolve().parent
HARNESS_ROOT = Path(os.environ.get("HARNESS_ROOT", SCRIPT_DIR.parent.parent.parent))
VAULT_DIR = HARNESS_ROOT / "vault" / "learnings"

# Add scripts dir to path for dedup import
sys.path.insert(0, str(SCRIPT_DIR))
from dedup_learning import check_and_dedup

# Pattern categories: (compiled_regex, type, category, tags)
PATTERNS = [
    # 1. Corrections (highest priority)
    (
        re.compile(
            r"(no,? that.?s (wrong|not)|actually[,.]|not like that|that.?s incorrect|"
            r"you.?re wrong|wrong approach|that doesn.?t work|you made a mistake|"
            r"you forgot|stop doing that|don.?t do that|I told you|"
            r"that.?s not (right|how|what))",
            re.I,
        ),
        "LRN", "correction", "[auto-captured, correction]",
    ),
    # 2. Preferences & permanent instructions
    (
        re.compile(
            r"(always (do|use|make|run|put)|never (do|use|make|run|put)|from now on|"
            r"going forward|remember (that|to)|don.?t ever|stop (using|doing)|"
            r"prefer (to|using)|I like (it|when|to)|make sure you always|default to)",
            re.I,
        ),
        "LRN", "preference", "[auto-captured, preference, permanent]",
    ),
    # 3. Architecture decisions
    (
        re.compile(
            r"(let.?s (use|go with|keep|put|make|build|create|set up)|instead of|"
            r"keep (them|it|this) separate|should (be|go|live|run) (in|on|at|under)|"
            r"put (it|them|this) in|move (it|them|this) to|we.?ll use|"
            r"the approach should be|let.?s not use)",
            re.I,
        ),
        "LRN", "decision", "[auto-captured, architecture, decision]",
    ),
    # 4. External knowledge / factual info
    (
        re.compile(
            r"(the repo is|it.?s called|the url is|the api is|"
            r"the (path|port|endpoint|domain|server) is|it lives (at|in)|"
            r"it runs on|it.?s (hosted|deployed) (on|at)|the stack is|it uses)",
            re.I,
        ),
        "LRN", "external_knowledge", "[auto-captured, factual, project-context]",
    ),
    # 5. Feature requests
    (
        re.compile(
            r"(i wish you could|can you also|is there a way to|"
            r"it would be nice if|can you learn to|add a feature|"
            r"I need you to be able to|we should add|we need|"
            r"can we (add|build|create|set up|hook up|wire up)|"
            r"would be (useful|cool|nice|great) (to|if))",
            re.I,
        ),
        "FEAT", "feature_request", "[auto-captured, feature-request]",
    ),
    # 6. Bug reports / something broken
    (
        re.compile(
            r"(is (broken|not working|down|failing|crashing)|"
            r"doesn.?t (work|load|start|connect|respond)|"
            r"why (is it|isn.?t|does it|won.?t)|"
            r"it (keeps|just) (failing|crashing|hanging|timing out)|"
            r"something.?s wrong|can you fix|debug this|what happened to)",
            re.I,
        ),
        "ERR", "user_reported_bug", "[auto-captured, bug-report, user-reported]",
    ),
    # 7. Root cause / debugging insights
    (
        re.compile(
            r"(the (root cause|problem|issue|bug) (is|was)|it (turns out|was because)|"
            r"the reason (is|was)|found (the|a) bug|figured out why|"
            r"it.?s (because|due to)|that.?s (why|what.?s causing)|"
            r"the fix (is|was)|solved it)",
            re.I,
        ),
        "LRN", "discovery", "[auto-captured, debugging, root-cause]",
    ),
    # 8. TIL / surprising discoveries
    (
        re.compile(
            r"(I didn.?t know|TIL|turns out|apparently|"
            r"I just (found|learned|discovered|realized)|did you know|"
            r"interesting.*(that|how)|huh.*(so|it)|who knew|I was surprised)",
            re.I,
        ),
        "LRN", "discovery", "[auto-captured, discovery, til]",
    ),
    # 9. Workflow / process notes
    (
        re.compile(
            r"(the (way|trick|key) (to|is)|make sure (to|you)|don.?t forget to|"
            r"the (workflow|process|steps?) (is|are)|you have to|"
            r"important:? (that|to)|heads up|watch out for|"
            r"be careful (with|about)|gotcha)",
            re.I,
        ),
        "LRN", "gotcha", "[auto-captured, workflow, gotcha]",
    ),
]

WHY_MAP = {
    "correction": "Corrections indicate knowledge gaps or bad habits that need fixing.",
    "preference": "User preferences should be remembered permanently to avoid repeating mistakes.",
    "decision": "Architecture decisions shape the system and should be documented for consistency.",
    "external_knowledge": "Factual information about projects/services prevents future confusion.",
}


def classify_prompt(prompt: str) -> tuple[str, str, str] | None:
    """Returns (entry_type, category, tags) or None if no match."""
    for regex, etype, category, tags in PATTERNS:
        if regex.search(prompt):
            return (etype, category, tags)
    return None


def sanitize_prompt(prompt: str) -> str:
    """Truncate and redact secrets from prompt."""
    short = prompt[:300].replace("`", "\\`")
    return re.sub(
        r"(key|token|password|secret)\s*[:=]\s*\S+",
        r"\1=REDACTED",
        short,
        flags=re.I,
    )


def next_id(vault_dir: Path, prefix: str, today_str: str) -> str:
    """Find next available sequence number for today."""
    seq = 1
    while (vault_dir / f"{prefix}-{today_str}-{seq:03d}.md").exists():
        seq += 1
    return f"{prefix}-{today_str}-{seq:03d}"


def write_entry(entry_type: str, category: str, tags: str, prompt: str) -> str:
    """Write a vault learning entry. Returns the entry ID."""
    VAULT_DIR.mkdir(parents=True, exist_ok=True)

    now = datetime.now()
    today_str = now.strftime("%Y%m%d")
    today_dash = now.strftime("%Y-%m-%d")
    timestamp = now.strftime("%Y-%m-%dT%H:%M:%S")

    entry_id = next_id(VAULT_DIR, entry_type, today_str)
    prompt_short = sanitize_prompt(prompt)
    why = WHY_MAP.get(category, "Captured for future reference.")

    if entry_type == "LRN":
        content = f"""---
id: {entry_id}
logged: {timestamp}
type: learning
priority: medium
status: new
category: {category}
area: general
agent: main
project: general
pattern-key: auto-{category}
recurrence-count: 1
first-seen: {today_dash}
last-seen: {today_dash}
tags: {tags}
related: []
---

# {category}: auto-captured

## User said
> {prompt_short}

## What was learned
(Claude should fill this in after processing the user's message)

## Why it matters
{why}
"""
    elif entry_type == "FEAT":
        content = f"""---
id: {entry_id}
logged: {timestamp}
type: feature
status: requested
complexity: medium
area: general
agent: main
project: general
pattern-key: user-feature-request
recurrence-count: 1
first-seen: {today_dash}
last-seen: {today_dash}
tags: {tags}
related: []
---

# Feature request: auto-captured

## User said
> {prompt_short}

## Requested capability
(Claude should fill this in after processing the user's message)

## Skill candidate
Maybe -- evaluate after implementation.
"""
    elif entry_type == "ERR":
        content = f"""---
id: {entry_id}
logged: {timestamp}
type: error
severity: medium
status: new
category: {category}
area: general
agent: main
project: general
pattern-key: user-reported-bug
recurrence-count: 1
first-seen: {today_dash}
last-seen: {today_dash}
tags: {tags}
related: []
---

# Bug report: auto-captured

## User said
> {prompt_short}

## Root Cause
(Claude should fill this in after investigating)

## Fix
(Claude should fill this in after resolving)
"""
    else:
        return ""

    (VAULT_DIR / f"{entry_id}.md").write_text(content)
    return entry_id


def main():
    prompt = sys.argv[1] if len(sys.argv) > 1 else ""
    if not prompt:
        sys.exit(0)

    result = classify_prompt(prompt)
    if result is None:
        sys.exit(0)

    entry_type, category, tags = result

    # Dedup check
    tags_csv = tags.strip("[]").replace(", ", ",")
    pattern_key = f"auto-{category}" if entry_type == "LRN" else {
        "FEAT": "user-feature-request",
        "ERR": "user-reported-bug",
    }.get(entry_type, f"auto-{category}")

    action, _match_id = check_and_dedup(str(VAULT_DIR), pattern_key, category, tags_csv)
    if action == "skip":
        sys.exit(0)

    entry_id = write_entry(entry_type, category, tags, prompt)
    if entry_id:
        print(
            f"[SELF-IMPROVE] Auto-logged to vault/learnings/{entry_id}.md "
            f"-- Update this entry with specifics as you process the user's request."
        )


if __name__ == "__main__":
    main()
