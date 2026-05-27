#!/usr/bin/env python3
"""Vault reverification — samples N old learnings/week, asks the LLM whether
each one's claim still holds against current code/state.

Runs weekly. Each fire: 10 entries × 1 LLM call ≈ $0.50/week.

Selection criteria:
- age >= 30 days (recent entries are presumed correct)
- status in {new, active, confirmed} (skip already-stale, archived, promoted)
- not reverified in the last 60 days (state-tracked)
- citations present (so the LLM has anchors to ground its check against)
- recurrence-count DESC (high-impact first)

Outcome per entry:
- VALID → bump `last_verified_at` to today; entry stays as-is
- RECHECK → set `status: needs-reverify`, prepend TODO-VERIFY marker
- UNKNOWN → no change; next round will revisit

Pairs with `vault-freshness.py` (deterministic SHA-lint, daily) and
`session-debrief.py` (write-time citations + SHA, ad-hoc).
"""

import os
import sys
import json
import re
import argparse
import datetime
import tempfile
import subprocess
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from lib.platform import paths

CODE_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    CODE_ROOT
)

TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
NOTIFY_FILE = os.path.join(TASKS_DIR, "pending-notifications.jsonl")
VAULT_LEARNINGS = Path(HARNESS_ROOT) / "vault" / "learnings"
STATE_FILE = os.path.join(TASKS_DIR, "vault-reverify.script-state.json")
CLAUDE_RUNNER = os.path.join(CODE_ROOT, "bridges", "discord", "claude-runner.py")

BATCH_SIZE = 10
MIN_AGE_DAYS = 30
RECHECK_COOLDOWN_DAYS = 60

ALLOWED_STATUSES_FOR_REVERIFY = {"new", "active", "confirmed", "stale-citation", ""}

RECHECK_MARKER = "> TODO-VERIFY: weekly reverification flagged this claim. The cited code/state may have drifted; confirm before acting."

PROMPT_TEMPLATE = """You are a vault-entry reverification system. The vault is a knowledge base of patterns, gotchas, and decisions. Some entries become stale as code evolves. Your job: decide whether the claim in this entry still holds.

ENTRY:
{entry_text}

CITED FILES (current contents at HEAD):
{citation_excerpts}

Decide one of three outcomes:
- VALID — claim still holds. Code or world matches the entry.
- RECHECK — claim is contradicted, or the cited code has changed substantively in a way that suggests the claim no longer applies. Be conservative — only RECHECK when you have positive evidence of drift, not just absence of confirmation.
- UNKNOWN — insufficient evidence to decide. Default to this when in doubt.

Respond with ONLY one word: VALID, RECHECK, or UNKNOWN."""


def load_state() -> dict:
    if not os.path.exists(STATE_FILE):
        return {"last_run": None, "reverified": {}, "total_runs": 0}
    try:
        return json.load(open(STATE_FILE))
    except Exception:
        return {"last_run": None, "reverified": {}, "total_runs": 0}


def save_state(state: dict, dry_run: bool = False) -> None:
    if dry_run:
        return
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def notify(message: str, dry_run: bool = False) -> None:
    if dry_run:
        return
    entry = {
        "task": "vault-reverify",
        "channel": "notifications",
        "summary": message,
        "timestamp": datetime.datetime.now().isoformat(),
    }
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")


def parse_logged(s: str) -> datetime.datetime | None:
    """Parse a frontmatter timestamp; tolerate Z suffix and tz-aware values
    by normalizing to naive UTC."""
    if not s:
        return None
    try:
        s = s.strip().rstrip("Z").strip("\"'")
        dt = datetime.datetime.fromisoformat(s)
        if dt.tzinfo is not None:
            dt = dt.replace(tzinfo=None)
        return dt
    except Exception:
        return None


def parse_frontmatter(text: str) -> tuple[dict, str, str] | None:
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.DOTALL)
    if not m:
        return None
    raw_fm, body = m.group(1), m.group(2)

    fm: dict = {"_citations": []}
    current: dict | None = None
    in_block = False
    for line in raw_fm.splitlines():
        if not line.strip():
            continue
        top = re.match(r"^([a-zA-Z_][\w-]*)\s*:\s*(.*)$", line)
        if top and not line.startswith(" "):
            key, val = top.group(1), top.group(2).strip().strip('"').strip("'")
            in_block = (key == "citations")
            current = None
            if not in_block:
                fm[key] = val
            continue
        if in_block:
            li = re.match(r"^\s*-\s*path:\s*(.*)$", line)
            if li:
                if current:
                    fm["_citations"].append(current)
                current = {"path": li.group(1).strip().strip('"').strip("'")}
                continue
            sub = re.match(r"^\s+([a-zA-Z_][\w-]*)\s*:\s*(.*)$", line)
            if sub and current is not None:
                current[sub.group(1)] = sub.group(2).strip().strip('"').strip("'")
    if current:
        fm["_citations"].append(current)
    return fm, raw_fm, body


def serialize_frontmatter(fm: dict) -> str:
    canonical = [
        "id", "logged", "type", "severity", "priority", "status",
        "needs_reverify_at", "last_verified_at", "stale_detected_at",
        "superseded_by", "superseded_at", "category", "area", "agent",
        "project", "pattern-key", "recurrence-count", "first-seen",
        "last-seen", "tags", "related", "verified_at_sha", "supersedes",
    ]
    lines = []
    written = set()
    for k in canonical:
        if k in fm and not k.startswith("_"):
            lines.append(f"{k}: {fm[k]}")
            written.add(k)
    for k, v in fm.items():
        if k.startswith("_") or k in written:
            continue
        lines.append(f"{k}: {v}")
    if fm.get("_citations"):
        lines.append("citations:")
        for c in fm["_citations"]:
            lines.append(f"  - path: {c.get('path', '')}")
            for k in ("lines", "evidence", "blob_sha"):
                if c.get(k):
                    lines.append(f"    {k}: {c[k]}")
    return "\n".join(lines)


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


def fetch_citation_excerpts(citations: list[dict], max_chars_per_file: int = 800) -> str:
    """Read the current HEAD content of each cited path. Bounded to keep
    LLM cost predictable. Returns a string formatted for the prompt."""
    parts = []
    for c in citations[:5]:
        path = c.get("path", "").strip()
        if not path:
            continue
        try:
            r = subprocess.run(
                ["git", "-C", HARNESS_ROOT, "show", f"HEAD:{path}"],
                capture_output=True, text=True, timeout=5,
            )
            if r.returncode != 0:
                parts.append(f"--- {path} ---\n[file not found at HEAD]\n")
                continue
            content = r.stdout
            if c.get("lines"):
                # Best-effort line slice; tolerate odd formats.
                m = re.match(r"^\s*(\d+)\s*[-–]\s*(\d+)\s*$", str(c["lines"]))
                if m:
                    start, end = int(m.group(1)), int(m.group(2))
                    lines = content.splitlines()
                    content = "\n".join(lines[max(0, start - 1):end])
            if len(content) > max_chars_per_file:
                content = content[:max_chars_per_file] + "\n[...truncated]"
            parts.append(f"--- {path} ---\n{content}\n")
        except Exception as e:
            parts.append(f"--- {path} ---\n[read error: {e}]\n")
    return "\n".join(parts) if parts else "[no citations]"


def select_candidates(state: dict) -> list[Path]:
    """Pick BATCH_SIZE entries due for reverification."""
    now = datetime.datetime.now()
    reverified = state.get("reverified", {})
    candidates = []

    for entry_file in VAULT_LEARNINGS.glob("*.md"):
        try:
            text = entry_file.read_text(encoding="utf-8")
        except Exception:
            continue
        parsed = parse_frontmatter(text)
        if not parsed:
            continue
        fm, _, _ = parsed

        status = (fm.get("status") or "").strip()
        if status not in ALLOWED_STATUSES_FOR_REVERIFY:
            continue
        # Need citations to do anything useful.
        if not fm.get("_citations"):
            continue
        logged = parse_logged(fm.get("logged", ""))
        if not logged:
            continue
        age_days = (now - logged).days
        # MIN_AGE_DAYS spares recent entries from churn-y reverification, but
        # stale-citation entries are already known-problematic — rescue them
        # ASAP rather than waiting 30 days for the floor to clear.
        if status != "stale-citation" and age_days < MIN_AGE_DAYS:
            continue

        # Cooldown check
        last = reverified.get(entry_file.stem)
        if last:
            last_dt = parse_logged(last)
            if last_dt and (now - last_dt).days < RECHECK_COOLDOWN_DAYS:
                continue

        try:
            recurrence = int(fm.get("recurrence-count", "1"))
        except Exception:
            recurrence = 1

        candidates.append((recurrence, age_days, entry_file))

    # Highest recurrence first, then oldest
    candidates.sort(key=lambda x: (-x[0], -x[1]))
    return [c[2] for c in candidates[:BATCH_SIZE]]


def _parse_claude_json_stdout(stdout: str) -> str:
    stdout = stdout.strip()
    if not stdout:
        return ""
    try:
        obj = json.loads(stdout)
        if isinstance(obj, dict):
            return (obj.get("result") or obj.get("response") or obj.get("text") or "").strip()
    except Exception:
        pass
    return stdout


def call_llm(prompt: str, timeout: int = 60) -> str | None:
    """Call Claude via the harness runner/output-file contract."""
    if not os.path.exists(CLAUDE_RUNNER):
        print(f"  LLM error: runner not found at {CLAUDE_RUNNER}", file=sys.stderr)
        return None

    fd, output_file = tempfile.mkstemp(prefix="vault-reverify-", suffix=".json")
    os.close(fd)
    env = os.environ.copy()
    env["HARNESS_ROOT"] = CODE_ROOT
    env["PROJECT_CWD"] = HARNESS_ROOT
    cmd = [
        paths.python(),
        CLAUDE_RUNNER,
        output_file,
        "--timeout",
        str(timeout),
        "-p",
        "--output-format",
        "json",
        "--model",
        "sonnet",
        "--dangerously-skip-permissions",
        "--",
        prompt,
    ]
    try:
        subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout + 45,
            cwd=CODE_ROOT,
            env=env,
        )
        with open(output_file, encoding="utf-8") as f:
            result = json.load(f)
        if result.get("returncode") != 0:
            stderr = (result.get("stderr") or "").strip()
            print(f"  LLM error: {stderr[:200]}", file=sys.stderr)
            return None
        return _parse_claude_json_stdout(result.get("stdout", ""))
    except Exception as e:
        print(f"  LLM exception: {e}", file=sys.stderr)
        return None
    finally:
        try:
            os.unlink(output_file)
        except OSError:
            pass


def reverify_one(entry_file: Path) -> str:
    """Returns the outcome: VALID, RECHECK, UNKNOWN, or ERROR."""
    text = entry_file.read_text(encoding="utf-8")
    parsed = parse_frontmatter(text)
    if not parsed:
        return "ERROR"
    fm, _, body = parsed

    citations = fm.get("_citations") or []
    excerpts = fetch_citation_excerpts(citations)
    entry_for_prompt = f"id: {fm.get('id', entry_file.stem)}\ntitle: {body.split(chr(10))[0] if body else ''}\n\n{body[:2000]}"

    prompt = PROMPT_TEMPLATE.format(
        entry_text=entry_for_prompt,
        citation_excerpts=excerpts,
    )

    response = call_llm(prompt)
    if not response:
        return "ERROR"

    # Pull the first matching keyword
    upper = response.upper()
    for outcome in ("RECHECK", "VALID", "UNKNOWN"):
        if outcome in upper:
            return outcome
    return "UNKNOWN"


def apply_outcome(entry_file: Path, outcome: str, today: str, *, dry_run: bool = False) -> None:
    if outcome not in ("VALID", "RECHECK"):
        return
    text = entry_file.read_text(encoding="utf-8")
    parsed = parse_frontmatter(text)
    if not parsed:
        return
    fm, _, body = parsed

    if outcome == "VALID":
        fm["last_verified_at"] = today
        # If this was a stale-citation rescue, flip status back to "active"
        # so the entry rejoins the active corpus instead of auto-archiving.
        if (fm.get("status") or "").strip() == "stale-citation":
            fm["status"] = "active"
            fm.pop("stale_detected_at", None)
        # Bump each citation's blob_sha to current HEAD so vault-freshness
        # doesn't re-flag this entry on its next run (the LLM just confirmed
        # the claim holds against current code).
        for c in fm.get("_citations", []):
            path = (c.get("path") or "").strip()
            if not path:
                continue
            current = git_blob_sha(path)
            if current:
                c["blob_sha"] = current
        # Also bump top-level verified_at_sha to current HEAD commit so the
        # next freshness run starts from a clean baseline.
        try:
            head_rev = subprocess.run(
                ["git", "-C", HARNESS_ROOT, "rev-parse", "HEAD"],
                capture_output=True, text=True, timeout=5,
            )
            if head_rev.returncode == 0:
                fm["verified_at_sha"] = head_rev.stdout.strip()
        except Exception:
            pass
    elif outcome == "RECHECK":
        fm["status"] = "needs-reverify"
        fm["needs_reverify_at"] = today
        if RECHECK_MARKER not in body:
            body = RECHECK_MARKER + "\n\n" + body.lstrip()

    new_fm = serialize_frontmatter(fm)
    new_text = f"---\n{new_fm}\n---\n{body}"
    if not dry_run:
        entry_file.write_text(new_text, encoding="utf-8")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Reverify older vault learnings against current code/state.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run candidate selection/reporting without rewriting entries, notifications, or state.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not VAULT_LEARNINGS.exists():
        print(f"Vault learnings dir not found: {VAULT_LEARNINGS}")
        return 0

    head = subprocess.run(
        ["git", "-C", HARNESS_ROOT, "rev-parse", "HEAD"],
        capture_output=True, text=True, timeout=5,
    )
    if head.returncode != 0:
        print("git unavailable — skipping reverification")
        return 0

    state = load_state()
    today = datetime.date.today().isoformat()
    candidates = select_candidates(state)

    if not candidates:
        header = "**Vault Reverification (dry-run)**" if args.dry_run else "**Vault Reverification**"
        msg = f"{header}\nNo candidates due — vault is freshly cited or all eligible entries within cooldown."
        print(msg)
        return 0

    verb = "Dry-run reverifying" if args.dry_run else "Reverifying"
    print(f"{verb} {len(candidates)} candidate(s)")
    counts = {"VALID": 0, "RECHECK": 0, "UNKNOWN": 0, "ERROR": 0}
    flagged: list[str] = []

    for entry_file in candidates:
        print(f"  {entry_file.stem}...", end=" ", flush=True)
        outcome = reverify_one(entry_file)
        counts[outcome] = counts.get(outcome, 0) + 1
        print(outcome)
        apply_outcome(entry_file, outcome, today, dry_run=args.dry_run)
        # Track that we reverified this entry today (cooldown)
        if outcome != "ERROR" and not args.dry_run:
            state["reverified"][entry_file.stem] = datetime.datetime.now().isoformat()
        if outcome == "RECHECK":
            flagged.append(entry_file.stem)

    if not args.dry_run:
        state["last_run"] = datetime.datetime.now().isoformat()
        state["total_runs"] = state.get("total_runs", 0) + 1
    save_state(state, dry_run=args.dry_run)

    header = "**Vault Reverification Dry Run (weekly)**" if args.dry_run else "**Vault Reverification (weekly)**"
    recheck_label = "Would flag for recheck" if args.dry_run else "Flagged for recheck"
    summary = (
        f"{header}\n"
        f"Checked: {len(candidates)} entries\n"
        f"Still valid: {counts['VALID']}\n"
        f"{recheck_label}: {counts['RECHECK']}\n"
        f"Inconclusive: {counts['UNKNOWN']}\n"
        f"Errors: {counts['ERROR']}"
    )
    if flagged:
        flagged_header = "Would flag" if args.dry_run else "Flagged"
        summary += f"\n\n{flagged_header}:\n" + "\n".join(f"  - {f}" for f in flagged)

    print("\n" + summary)
    if counts["RECHECK"] > 0 or counts["ERROR"] > 0:
        notify(summary, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
