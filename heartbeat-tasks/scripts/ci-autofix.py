#!/usr/bin/env python3
"""CI Auto-Fix — polls GitHub Actions for failures and spawns builder to fix.

Checks all registered projects for failed CI runs, extracts failure logs,
and spawns Claude to attempt a fix on a new branch. Notifies Discord with
the fix branch and prompts user to review + merge.

Safety:
  - Never pushes to protected branches (main/master)
  - Creates fix branches: autofix/<run-id>-<short-desc>
  - Max 2 fix attempts per failed run
  - Tracks attempted run IDs in state file to prevent re-attempts
  - Skips PRs with "do-not-autofix" label
  - Prompts user to merge via Discord notification

Usage:
    python3 ci-autofix.py                    # Check all registered projects
    python3 ci-autofix.py --repo owner/repo  # Check one repo
    python3 ci-autofix.py --dry-run          # Show what would happen
"""

import subprocess
import json
import os
import sys
import re
import argparse
import datetime
import shutil
import tempfile

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
STATE_FILE = os.path.join(TASKS_DIR, "ci-autofix.state.json")
NOTIFY_FILE = os.path.join(TASKS_DIR, "pending-notifications.jsonl")
PROJECTS_FILE = os.path.join(TASKS_DIR, "projects.json")

GH_PATH = os.environ.get("GH_PATH", shutil.which("gh") or "gh")

# Limits
MAX_LOG_CHARS = 50000       # Max CI log chars to send to Claude
MAX_ATTEMPTS_PER_RUN = 2    # Max fix attempts per failed run
MAX_FIXES_PER_TICK = 3      # Max fixes to attempt per heartbeat tick
FIX_MARKER = "<!-- harness-ci-autofix -->"

# ─── Helpers ──────────────────────────────────────────────────────────


def notify(channel: str, message: str, repo: str = ""):
    """Write notification to pending-notifications.jsonl."""
    entry = {
        "task": "ci-autofix",
        "channel": channel,
        "summary": message,
        "timestamp": datetime.datetime.now().isoformat(),
    }
    if repo:
        entry["project"] = repo
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")


def load_state() -> dict:
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"attempted_runs": {}, "last_run": None, "total_fixes": 0, "total_failures": 0}


def save_state(state: dict):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.rename(tmp, STATE_FILE)


def gh_run(args: list[str], timeout: int = 60) -> subprocess.CompletedProcess:
    """Run a gh CLI command."""
    return subprocess.run(
        [GH_PATH] + args,
        capture_output=True, text=True, timeout=timeout,
    )


def clean_env_for_claude() -> dict[str, str]:
    """Build clean environment for Claude CLI (strip CLAUDE* vars)."""
    clean = {}
    for k, v in os.environ.items():
        if k.startswith("CLAUDE") and k != "CLAUDE_CLI_PATH":
            continue
        clean[k] = v
    return clean


def get_claude_path() -> str:
    """Resolve Claude CLI path."""
    configured = os.environ.get("CLAUDE_CLI_PATH")
    if configured:
        return configured
    found = shutil.which("claude")
    if found:
        return found
    for p in [
        os.path.expanduser("~/.claude/local/claude"),
        os.path.expanduser("~/.local/bin/claude"),
        "/usr/local/bin/claude",
    ]:
        if os.path.isfile(p):
            return p
    return "claude"


# ─── GitHub API ───────────────────────────────────────────────────────


def get_failed_runs(owner_repo: str, limit: int = 10) -> list[dict]:
    """Get recent failed workflow runs for a repo."""
    result = gh_run([
        "run", "list",
        "--repo", owner_repo,
        "--status", "failure",
        "--json", "databaseId,headBranch,event,name,conclusion,createdAt,url",
        "--limit", str(limit),
    ])
    if result.returncode != 0:
        print(f"  ERROR listing runs for {owner_repo}: {result.stderr.strip()}")
        return []
    try:
        runs = json.loads(result.stdout)
        # Filter out runs on protected branches
        return [r for r in runs if r.get("headBranch") not in ("main", "master")]
    except json.JSONDecodeError:
        print(f"  ERROR parsing runs for {owner_repo}")
        return []


def get_run_log(owner_repo: str, run_id: int) -> str:
    """Get failed job logs for a specific run."""
    result = gh_run([
        "run", "view", str(run_id),
        "--repo", owner_repo,
        "--log-failed",
    ], timeout=120)
    if result.returncode != 0:
        # Fallback: try regular log
        result = gh_run([
            "run", "view", str(run_id),
            "--repo", owner_repo,
            "--log",
        ], timeout=120)
        if result.returncode != 0:
            return f"Could not fetch logs: {result.stderr.strip()}"
    return result.stdout[:MAX_LOG_CHARS]


def get_pr_for_branch(owner_repo: str, branch: str) -> dict | None:
    """Get the PR associated with a branch, if any."""
    result = gh_run([
        "pr", "list",
        "--repo", owner_repo,
        "--head", branch,
        "--json", "number,title,labels,headRefName,url",
        "--limit", "1",
    ])
    if result.returncode != 0:
        return None
    try:
        prs = json.loads(result.stdout)
        return prs[0] if prs else None
    except (json.JSONDecodeError, IndexError):
        return None


def has_skip_label(pr: dict) -> bool:
    """Check if PR has a label that should skip auto-fix."""
    skip_labels = {"do-not-autofix", "no-autofix", "manual-fix"}
    pr_labels = {l.get("name", "").lower() for l in pr.get("labels", [])}
    return bool(pr_labels & skip_labels)


def get_pr_diff(owner_repo: str, pr_number: int) -> str:
    """Get the diff for a PR."""
    result = gh_run(["pr", "diff", str(pr_number), "--repo", owner_repo], timeout=120)
    if result.returncode != 0:
        return ""
    return result.stdout[:MAX_LOG_CHARS]


# ─── Fix Logic ────────────────────────────────────────────────────────


def classify_failure(log: str) -> str:
    """Classify the type of CI failure from logs."""
    log_lower = log.lower()
    if any(kw in log_lower for kw in ["eslint", "lint", "prettier", "formatting"]):
        return "lint"
    if any(kw in log_lower for kw in ["tsc", "type error", "ts(", "typescript"]):
        return "type-error"
    if any(kw in log_lower for kw in ["test", "jest", "vitest", "mocha", "assert"]):
        return "test-failure"
    if any(kw in log_lower for kw in ["build", "compile", "webpack", "vite", "esbuild"]):
        return "build-error"
    if any(kw in log_lower for kw in ["npm install", "package", "dependency", "module not found"]):
        return "dependency"
    return "unknown"


def attempt_fix(
    owner_repo: str,
    run: dict,
    pr: dict | None,
    log: str,
    project_path: str,
    dry_run: bool = False,
) -> bool:
    """Attempt to fix a CI failure using Claude."""
    run_id = run["databaseId"]
    branch = run["headBranch"]
    failure_type = classify_failure(log)

    print(f"  Attempting fix for run {run_id} on {branch} ({failure_type})")

    if dry_run:
        print(f"  [DRY RUN] Would attempt {failure_type} fix on {branch}")
        return True

    # Build fix branch name
    short_type = failure_type.replace("-", "")[:10]
    fix_branch = f"autofix/{run_id}-{short_type}"

    # Build context for Claude
    diff_context = ""
    if pr:
        diff_context = get_pr_diff(owner_repo, pr["number"])
        if diff_context:
            diff_context = f"\n\n## PR Diff\n```\n{diff_context[:20000]}\n```"

    prompt = f"""You are fixing a CI failure in the {owner_repo} repository.

## Branch
{branch}

## Failure Type
{failure_type}

## CI Failure Log
```
{log[:30000]}
```
{diff_context}

## Instructions
1. First, checkout the branch: git checkout {branch}
2. Create a fix branch: git checkout -b {fix_branch}
3. Read the failing files and understand the error
4. Make ONLY the minimum changes needed to fix the CI failure
5. Do NOT refactor, clean up, or improve code beyond what's needed for the fix
6. Commit with message: "fix(ci): auto-fix {failure_type} in {branch}"
7. Push the fix branch: git push origin {fix_branch}

IMPORTANT: Only fix what's broken. Do not modify anything else. If you cannot fix it after examining the code, explain why and exit."""

    claude_path = get_claude_path()
    clean_env = clean_env_for_claude()
    clean_env["HARNESS_ROOT"] = HARNESS_ROOT

    try:
        result = subprocess.run(
            [
                claude_path, "-p",
                "--output-format", "json",
                "--dangerously-skip-permissions",
                "--allowedTools", "Read,Write,Edit,Grep,Glob,Bash",
                "--max-turns", "20",
                "--", prompt,
            ],
            capture_output=True,
            text=True,
            timeout=300,  # 5 minute timeout
            cwd=project_path,
            env=clean_env,
            stdin=subprocess.DEVNULL,
        )

        if result.returncode != 0:
            print(f"  Claude exited with code {result.returncode}")
            return False

        # Check if a fix branch was actually pushed
        check = gh_run(["api", f"repos/{owner_repo}/branches/{fix_branch}"])
        if check.returncode == 0:
            print(f"  Fix branch {fix_branch} pushed successfully")
            return True
        else:
            print(f"  Fix branch {fix_branch} was not pushed — fix may have failed")
            return False

    except subprocess.TimeoutExpired:
        print(f"  Claude timed out after 300s")
        return False
    except Exception as e:
        print(f"  Error running Claude: {e}")
        return False


# ─── Main ─────────────────────────────────────────────────────────────


def get_registered_repos() -> dict[str, dict]:
    """Load registered projects with GitHub repos."""
    if not os.path.exists(PROJECTS_FILE):
        return {}
    with open(PROJECTS_FILE) as f:
        data = json.load(f)
    repos = {}
    for name, config in data.get("projects", {}).items():
        if config.get("repo"):
            repos[name] = config
    return repos


def resolve_project_path(config: dict) -> str:
    """Resolve $HOME and $HARNESS_ROOT in project paths."""
    path = config.get("path", "")
    path = path.replace("$HOME", os.path.expanduser("~"))
    path = path.replace("$HARNESS_ROOT", HARNESS_ROOT)
    return path


def main():
    parser = argparse.ArgumentParser(description="CI Auto-Fix")
    parser.add_argument("--repo", help="Only check this repo (owner/repo)")
    parser.add_argument("--dry-run", action="store_true", help="Show what would happen")
    args = parser.parse_args()

    state = load_state()
    repos = get_registered_repos()

    if not repos:
        print("No registered repos found")
        return

    # Filter to specific repo if requested
    if args.repo:
        repos = {k: v for k, v in repos.items() if v.get("repo") == args.repo}
        if not repos:
            print(f"Repo {args.repo} not found in projects.json")
            return

    fixes_attempted = 0
    fixes_succeeded = 0
    total_failures_found = 0

    for project_name, config in repos.items():
        owner_repo = config["repo"]
        project_path = resolve_project_path(config)
        discord_channel = config.get("discord_channel", "heartbeat-status")

        if not os.path.isdir(project_path):
            print(f"Skipping {project_name}: path {project_path} not found")
            continue

        print(f"\nChecking {owner_repo}...")
        failed_runs = get_failed_runs(owner_repo)

        if not failed_runs:
            print(f"  No failed runs")
            continue

        for run in failed_runs:
            run_id = str(run["databaseId"])
            branch = run["headBranch"]

            # Skip if already attempted
            run_key = f"{owner_repo}:{run_id}"
            attempts = state["attempted_runs"].get(run_key, {})
            if attempts.get("count", 0) >= MAX_ATTEMPTS_PER_RUN:
                continue
            if attempts.get("fixed", False):
                continue

            total_failures_found += 1

            # Check for skip label on associated PR
            pr = get_pr_for_branch(owner_repo, branch)
            if pr and has_skip_label(pr):
                print(f"  Skipping run {run_id} — PR has skip label")
                continue

            # Rate limit
            if fixes_attempted >= MAX_FIXES_PER_TICK:
                print(f"  Hit fix limit ({MAX_FIXES_PER_TICK}) for this tick")
                break

            # Get failure logs
            print(f"  Run {run_id} on branch {branch}: {run['name']}")
            log = get_run_log(owner_repo, int(run_id))
            failure_type = classify_failure(log)

            # Attempt fix
            fixes_attempted += 1
            success = attempt_fix(
                owner_repo, run, pr, log, project_path,
                dry_run=args.dry_run,
            )

            # Update state
            state["attempted_runs"][run_key] = {
                "count": attempts.get("count", 0) + 1,
                "fixed": success,
                "failure_type": failure_type,
                "branch": branch,
                "last_attempt": datetime.datetime.now().isoformat(),
            }

            if success:
                fixes_succeeded += 1
                fix_branch = f"autofix/{run_id}-{failure_type.replace('-', '')[:10]}"
                pr_url = pr["url"] if pr else f"https://github.com/{owner_repo}/tree/{fix_branch}"

                # Notify Discord — prompt user to review and merge
                notify(
                    discord_channel,
                    f"**CI Auto-Fix** ({owner_repo})\n"
                    f"Fixed `{failure_type}` failure on `{branch}`\n"
                    f"Fix branch: `{fix_branch}`\n"
                    f"PR: {pr_url}\n\n"
                    f"**Please review the fix and merge to main when ready.**\n"
                    f"To merge: `gh pr create --repo {owner_repo} --head {fix_branch} --base {branch} --title 'fix(ci): auto-fix {failure_type}' && gh pr merge --auto`",
                    repo=owner_repo,
                )
            else:
                if attempts.get("count", 0) + 1 >= MAX_ATTEMPTS_PER_RUN:
                    notify(
                        discord_channel,
                        f"**CI Auto-Fix Failed** ({owner_repo})\n"
                        f"Could not fix `{failure_type}` on `{branch}` after {MAX_ATTEMPTS_PER_RUN} attempts.\n"
                        f"Manual intervention needed.\n"
                        f"Run: {run.get('url', run_id)}",
                        repo=owner_repo,
                    )

    # Update state
    state["last_run"] = datetime.datetime.now().isoformat()
    state["total_fixes"] = state.get("total_fixes", 0) + fixes_succeeded
    state["total_failures"] = state.get("total_failures", 0) + (fixes_attempted - fixes_succeeded)

    # Clean old entries (>7 days)
    cutoff = (datetime.datetime.now() - datetime.timedelta(days=7)).isoformat()
    state["attempted_runs"] = {
        k: v for k, v in state["attempted_runs"].items()
        if v.get("last_attempt", "") > cutoff
    }

    save_state(state)

    # Summary
    print(f"\n--- CI Auto-Fix Summary ---")
    print(f"Failures found: {total_failures_found}")
    print(f"Fixes attempted: {fixes_attempted}")
    print(f"Fixes succeeded: {fixes_succeeded}")

    if fixes_succeeded > 0 and not args.dry_run:
        notify(
            "heartbeat-status",
            f"CI Auto-Fix: {fixes_succeeded}/{fixes_attempted} fixes applied across {len(repos)} repos. "
            f"Check project channels for merge prompts.",
        )


if __name__ == "__main__":
    main()
