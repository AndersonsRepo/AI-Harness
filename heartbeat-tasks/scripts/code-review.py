#!/usr/bin/env python3
"""Daily hybrid code review: deterministic static analysis + Claude deep analysis.

Phase 1 (deterministic): Static pattern matching for known bug signatures,
  spawn consistency, resource leaks, TODO/FIXME, config issues, git status.
Phase 2 (non-deterministic): Feed Phase 1 findings + recent git changes to
  Claude for deeper architectural analysis and prioritized fix plan.

Output: Plan file at vault/daily/code-review-YYYY-MM-DD.md + Discord summary.

Usage:
    python3 code-review.py                  # Full hybrid review
    python3 code-review.py --static-only    # Phase 1 only (no Claude)
    python3 code-review.py --quick          # Quick checks only (no git analysis)
"""

import subprocess
import json
import os
import sys
import re
import datetime

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
NOTIFY_FILE = os.path.join(TASKS_DIR, "pending-notifications.jsonl")
STATE_FILE = os.path.join(TASKS_DIR, "code-review.state.json")
VAULT_DIR = os.path.join(HARNESS_ROOT, "vault")
PLAN_DIR = os.path.join(VAULT_DIR, "daily")

DISCORD_DIR = os.path.join(HARNESS_ROOT, "bridges", "discord")
MCP_DIR = os.path.join(HARNESS_ROOT, "mcp-servers")
SCRIPTS_DIR = os.path.join(TASKS_DIR, "scripts")

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from lib.platform import paths
from lib.llm_provider import get_provider, get_default_model, LLMError

CLAUDE_PATH = paths.claude_cli()

# TypeScript source files to scan
TS_DIRS = [DISCORD_DIR, MCP_DIR]
PY_DIRS = [SCRIPTS_DIR]

# ─── Helpers ──────────────────────────────────────────────────────────

def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"last_run": None, "last_findings_count": 0, "known_issues": []}


def save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.rename(tmp, STATE_FILE)


def notify(title, body, channel="notifications"):
    entry = {
        "task": "code-review",
        "channel": channel,
        "summary": f"**{title}**\n{body}",
        "timestamp": datetime.datetime.now().isoformat(),
    }
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")


def find_files(dirs, extensions):
    """Find all files with given extensions in directories."""
    files = []
    for d in dirs:
        if not os.path.exists(d):
            continue
        for root, _, filenames in os.walk(d):
            # Skip node_modules and .tmp
            if "node_modules" in root or ".tmp" in root:
                continue
            for fname in filenames:
                if any(fname.endswith(ext) for ext in extensions):
                    files.append(os.path.join(root, fname))
    return files


def read_file(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except Exception:
        return ""


# ─── Checks ──────────────────────────────────────────────────────────

def check_todo_fixme(files):
    """Find TODO, FIXME, HACK, XXX comments that indicate incomplete work."""
    findings = []
    pattern = re.compile(r'\b(TODO|FIXME|HACK|XXX|WORKAROUND)\b[:\s]*(.*)', re.IGNORECASE)
    for fpath in files:
        content = read_file(fpath)
        for i, line in enumerate(content.splitlines(), 1):
            # Skip this script itself
            if fpath.endswith("code-review.py"):
                continue
            match = pattern.search(line)
            if match:
                tag = match.group(1).upper()
                msg = match.group(2).strip()[:100]
                relpath = os.path.relpath(fpath, HARNESS_ROOT)
                findings.append({
                    "severity": "low",
                    "file": relpath,
                    "line": i,
                    "issue": f"{tag}: {msg}",
                    "category": "incomplete-work",
                })
    return findings


def check_unhandled_async(ts_files):
    """Find async calls without await or .catch() in TypeScript files."""
    findings = []
    # Pattern: function call that returns promise but isn't awaited or caught
    # This is a heuristic — catches common patterns
    patterns = [
        (re.compile(r'(?<!await\s)(?<!return\s)(?:db|getDb)\(\)\.prepare\('), "SQLite call without error handling"),
        (re.compile(r'\.send\([^)]*\)\s*;(?!.*\.catch)'), "Discord send without .catch()"),
    ]
    for fpath in ts_files:
        content = read_file(fpath)
        relpath = os.path.relpath(fpath, HARNESS_ROOT)
        for i, line in enumerate(content.splitlines(), 1):
            for pattern, desc in patterns:
                if pattern.search(line):
                    # Check if already inside try/catch by looking at context
                    start = max(0, i - 10)
                    context = "\n".join(content.splitlines()[start:i])
                    if "try {" in context or ".catch" in line:
                        continue
                    findings.append({
                        "severity": "medium",
                        "file": relpath,
                        "line": i,
                        "issue": desc,
                        "category": "error-handling",
                    })
    return findings


def check_spawn_consistency(ts_files):
    """Verify all Claude spawn paths pass PROJECT_CWD and HARNESS_ROOT consistently."""
    findings = []
    spawn_pattern = re.compile(r'spawn\(\s*"python3"')

    for fpath in ts_files:
        content = read_file(fpath)
        relpath = os.path.relpath(fpath, HARNESS_ROOT)
        lines = content.splitlines()

        for i, line in enumerate(lines, 1):
            if spawn_pattern.search(line):
                # Check surrounding ~15 lines for env and cwd
                context = "\n".join(lines[max(0, i-5):min(len(lines), i+15)])

                if "HARNESS_ROOT" not in context:
                    findings.append({
                        "severity": "high",
                        "file": relpath,
                        "line": i,
                        "issue": "Claude spawn missing HARNESS_ROOT in env",
                        "category": "spawn-consistency",
                    })

                if "claude-runner.py" in context and "PROJECT_CWD" not in context and "getProject" not in content:
                    findings.append({
                        "severity": "medium",
                        "file": relpath,
                        "line": i,
                        "issue": "Claude spawn may be missing PROJECT_CWD support",
                        "category": "spawn-consistency",
                    })
    return findings


def check_resource_leaks(ts_files):
    """Check for potential resource leaks: watchers started but not tracked, processes not unref'd."""
    findings = []
    for fpath in ts_files:
        content = read_file(fpath)
        relpath = os.path.relpath(fpath, HARNESS_ROOT)

        # Check for FileWatcher.start() without trackWatcher
        if "new FileWatcher" in content and "trackWatcher" not in content and "file-watcher" not in fpath:
            findings.append({
                "severity": "medium",
                "file": relpath,
                "line": 0,
                "issue": "FileWatcher created but trackWatcher not imported — watcher won't be cleaned up on shutdown",
                "category": "resource-leak",
            })

        # Check for spawn without unref
        if "spawn(" in content and "proc.unref()" not in content and "child_process" in content:
            findings.append({
                "severity": "medium",
                "file": relpath,
                "line": 0,
                "issue": "Process spawned but never unref'd — may prevent clean shutdown",
                "category": "resource-leak",
            })
    return findings


def check_env_dependencies(py_files):
    """Check Python scripts for missing env var fallbacks."""
    findings = []
    for fpath in py_files:
        content = read_file(fpath)
        relpath = os.path.relpath(fpath, HARNESS_ROOT)

        # Check for os.environ[] without .get() (will crash if missing)
        pattern = re.compile(r'os\.environ\[(["\'])(\w+)\1\]')
        for i, line in enumerate(content.splitlines(), 1):
            match = pattern.search(line)
            if match:
                var_name = match.group(2)
                findings.append({
                    "severity": "medium",
                    "file": relpath,
                    "line": i,
                    "issue": f"os.environ['{var_name}'] will crash if not set — use os.environ.get() with fallback",
                    "category": "env-safety",
                })
    return findings


def check_git_status():
    """Check for uncommitted changes and stale work."""
    findings = []
    try:
        result = subprocess.run(
            ["git", "status", "--porcelain"],
            capture_output=True, text=True, cwd=HARNESS_ROOT, timeout=10
        )
        changed = [l for l in result.stdout.strip().splitlines() if l.strip()]
        if len(changed) > 10:
            findings.append({
                "severity": "medium",
                "file": "repo",
                "line": 0,
                "issue": f"{len(changed)} uncommitted changes — consider committing or stashing",
                "category": "git-hygiene",
            })

        # Check for uncommitted .ts/.py files in critical dirs
        critical_uncommitted = [
            l for l in changed
            if any(l.strip().endswith(ext) for ext in [".ts", ".py"])
            and any(d in l for d in ["bridges/", "mcp-servers/", "heartbeat-tasks/"])
        ]
        if critical_uncommitted:
            files_list = ", ".join(l.strip().split()[-1] for l in critical_uncommitted[:5])
            findings.append({
                "severity": "high",
                "file": "repo",
                "line": 0,
                "issue": f"Uncommitted changes in critical files: {files_list}",
                "category": "git-hygiene",
            })
    except Exception as e:
        findings.append({
            "severity": "low",
            "file": "git",
            "line": 0,
            "issue": f"Git status check failed: {e}",
            "category": "git-hygiene",
        })
    return findings


def check_config_consistency():
    """Verify heartbeat task configs are valid and consistent."""
    findings = []
    config_files = [
        f for f in os.listdir(TASKS_DIR)
        if f.endswith(".json") and ".state" not in f and "vercel-state" not in f
        and f not in ("projects.json", "projects.example.json")
        and not f.startswith("course-map")
    ]

    for fname in config_files:
        fpath = os.path.join(TASKS_DIR, fname)
        try:
            with open(fpath) as f:
                config = json.load(f)

            # Check required fields (name and enabled are always required;
            # type and schedule are optional for built-in/interval tasks)
            for field in ["name", "enabled"]:
                if field not in config:
                    findings.append({
                        "severity": "high",
                        "file": f"heartbeat-tasks/{fname}",
                        "line": 0,
                        "issue": f"Missing required field '{field}' in heartbeat config",
                        "category": "config",
                    })

            # Check script exists if type is script
            if config.get("type") == "script":
                script = config.get("script", "")
                script_path = os.path.join(SCRIPTS_DIR, script)
                if script and not os.path.exists(script_path):
                    findings.append({
                        "severity": "high",
                        "file": f"heartbeat-tasks/{fname}",
                        "line": 0,
                        "issue": f"Script '{script}' not found at {script_path}",
                        "category": "config",
                    })

        except json.JSONDecodeError as e:
            findings.append({
                "severity": "critical",
                "file": f"heartbeat-tasks/{fname}",
                "line": 0,
                "issue": f"Invalid JSON: {e}",
                "category": "config",
            })
    return findings


# ─── Phase 2: Claude Analysis ─────────────────────────────────────────

def get_recent_git_changes():
    """Get git diff and recent commit log for context."""
    changes = {}
    try:
        result = subprocess.run(
            ["git", "log", "--oneline", "-10"],
            capture_output=True, text=True, cwd=HARNESS_ROOT, timeout=10
        )
        changes["recent_commits"] = result.stdout.strip()
    except Exception:
        changes["recent_commits"] = "(unavailable)"

    try:
        result = subprocess.run(
            ["git", "diff", "--stat"],
            capture_output=True, text=True, cwd=HARNESS_ROOT, timeout=10
        )
        changes["uncommitted_diff_stat"] = result.stdout.strip()
    except Exception:
        changes["uncommitted_diff_stat"] = "(unavailable)"

    return changes


def run_claude_analysis(findings, git_changes):
    """Phase 2: Feed static findings to Claude for deeper analysis and plan generation."""
    today = datetime.date.today().isoformat()

    # Build the findings summary for Claude
    findings_text = ""
    for f in findings[:50]:  # Cap at 50 to stay within prompt limits
        findings_text += f"- [{f['severity'].upper()}] {f['file']}:{f['line']} — {f['issue']} (category: {f['category']})\n"

    prompt = f"""You are reviewing the AI Harness codebase. Today is {today}.

## Phase 1 Static Analysis Results

{len(findings)} findings detected by deterministic static checks:

{findings_text if findings_text else "No static findings detected."}

## Recent Git Activity

Recent commits:
{git_changes.get('recent_commits', 'N/A')}

Uncommitted changes:
{git_changes.get('uncommitted_diff_stat', 'None')}

## Your Task

Based on the static findings above AND your own analysis of the codebase, produce a **prioritized fix plan** in this exact format:

```markdown
---
date: {today}
type: code-review
status: pending
---

# Code Review Plan — {today}

## Summary
(2-3 sentence overview of codebase health)

## Priority Fixes

### P0 — Fix Today (safety/correctness)
- [ ] (description with file:line)

### P1 — Fix This Week (functionality)
- [ ] (description with file:line)

### P2 — Fix When Convenient (quality)
- [ ] (description with file:line)

## Observations
(Any architectural concerns, patterns you notice, or suggestions not tied to specific findings)
```

Focus on functional bugs and safety issues, not style. If the static checks found nothing new, focus your own analysis on the most critical files: bot.ts, task-runner.ts, handoff-router.ts, and claude-runner.py.

Output ONLY the markdown plan — no preamble, no explanation."""

    try:
        llm = get_provider()
        response = llm.complete(
            prompt, model=get_default_model(), timeout=150,
            max_turns=15, cwd=HARNESS_ROOT,
        )
        text = response.text.strip()
        if not text:
            return None, "LLM returned empty result"
        return text, None

    except LLMError as e:
        return None, str(e)
    except Exception as e:
        return None, str(e)


def save_plan_file(plan_content):
    """Save the review plan to vault/daily/code-review-YYYY-MM-DD.md."""
    os.makedirs(PLAN_DIR, exist_ok=True)
    today = datetime.date.today().isoformat()
    plan_path = os.path.join(PLAN_DIR, f"code-review-{today}.md")

    # Atomic write
    tmp = plan_path + ".tmp"
    with open(tmp, "w") as f:
        f.write(plan_content)
    os.rename(tmp, plan_path)

    return plan_path


# ─── Main ─────────────────────────────────────────────────────────────

def main():
    quick = "--quick" in sys.argv
    static_only = "--static-only" in sys.argv

    ts_files = find_files(TS_DIRS, [".ts"])
    py_files = find_files(PY_DIRS, [".py"])
    all_files = ts_files + py_files

    print(f"[Phase 1] Scanning {len(ts_files)} TypeScript + {len(py_files)} Python files...")

    # ── Phase 1: Deterministic Static Analysis ──
    all_findings = []

    all_findings.extend(check_todo_fixme(all_files))
    all_findings.extend(check_unhandled_async(ts_files))
    all_findings.extend(check_spawn_consistency(ts_files))
    all_findings.extend(check_resource_leaks(ts_files))
    all_findings.extend(check_env_dependencies(py_files))
    all_findings.extend(check_config_consistency())

    if not quick:
        all_findings.extend(check_git_status())

    # Sort by severity
    severity_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    all_findings.sort(key=lambda f: severity_order.get(f["severity"], 99))

    # Deduplicate against known issues from last run
    state = load_state()
    known_hashes = set(state.get("known_issues", []))

    new_findings = []
    current_hashes = []
    for f in all_findings:
        h = f"{f['file']}:{f['category']}:{f['issue'][:50]}"
        current_hashes.append(h)
        if h not in known_hashes:
            new_findings.append(f)

    # Build severity summary
    by_severity = {}
    for f in all_findings:
        by_severity.setdefault(f["severity"], []).append(f)

    severity_parts = []
    for sev in ["critical", "high", "medium", "low"]:
        count = len(by_severity.get(sev, []))
        if count:
            severity_parts.append(f"**{sev.upper()}**: {count}")

    total = len(all_findings)
    new_count = len(new_findings)

    print(f"[Phase 1] Complete: {total} findings ({new_count} new)")
    for f in all_findings:
        icon = {"critical": "!!!", "high": "!!", "medium": "!", "low": "."}[f["severity"]]
        print(f"  [{icon}] {f['file']}:{f['line']} — {f['issue']}")

    # ── Phase 2: Claude Deep Analysis ──
    plan_path = None
    claude_error = None

    if not static_only:
        print(f"\n[Phase 2] Running Claude analysis (model: sonnet)...")
        git_changes = get_recent_git_changes()
        plan_content, claude_error = run_claude_analysis(all_findings, git_changes)

        if plan_content:
            plan_path = save_plan_file(plan_content)
            print(f"[Phase 2] Plan saved to {plan_path}")
        else:
            print(f"[Phase 2] Claude analysis failed: {claude_error}")

    # ── Notify Discord ──
    lines = [f"**Daily Code Review** — {datetime.date.today()}"]
    lines.append(f"Scanned {len(all_files)} files | {' | '.join(severity_parts) if severity_parts else 'Clean'}")
    lines.append(f"Findings: {total} total, {new_count} new")

    # Show new high/critical findings
    important_new = [f for f in new_findings if f["severity"] in ("critical", "high")]
    if important_new:
        lines.append("\n**New issues requiring attention:**")
        for f in important_new[:10]:
            lines.append(f"- [{f['severity'].upper()}] `{f['file']}:{f['line']}` — {f['issue']}")

    if new_count > len(important_new) and new_count > 0:
        remaining = new_count - len(important_new)
        if remaining > 0:
            lines.append(f"\n*+{remaining} lower-severity finding(s)*")

    # Phase 2 status
    if plan_path:
        lines.append(f"\n**Fix plan generated** → `{os.path.relpath(plan_path, HARNESS_ROOT)}`")
        lines.append("Review the plan and tell me which items to fix.")
    elif claude_error:
        lines.append(f"\n*Claude analysis skipped: {claude_error[:100]}*")

    # Always notify (it's a daily morning report)
    notify("Daily Code Review", "\n".join(lines))
    print("\n" + "\n".join(lines))

    # Update state
    state["last_run"] = datetime.datetime.now().isoformat()
    state["last_findings_count"] = total
    state["new_findings_count"] = new_count
    state["known_issues"] = current_hashes
    state["last_plan"] = plan_path
    save_state(state)

    return 0 if not by_severity.get("critical") else 1


if __name__ == "__main__":
    sys.exit(main())
