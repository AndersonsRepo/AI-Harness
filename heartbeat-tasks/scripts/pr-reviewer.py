#!/usr/bin/env python3
"""PR reviewer — reviews open PRs across configured repos using Claude.

Checks for unreviewed PRs (no harness review comment), reviews them with
Claude CLI using the reviewer agent persona, posts results as PR comments,
and auto-merges approved PRs.

Usage:
    python3 pr-reviewer.py                          # Review all configured repos
    python3 pr-reviewer.py --repo owner/repo        # Review one repo
    python3 pr-reviewer.py --repo owner/repo --pr 5 # Review one specific PR
    python3 pr-reviewer.py --dry-run                # Show what would happen
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
CONFIG_FILE = os.path.join(TASKS_DIR, "pr-review-config.json")
STATE_FILE = os.path.join(TASKS_DIR, "pr-review.state.json")
NOTIFY_FILE = os.path.join(TASKS_DIR, "pending-notifications.jsonl")

GH_PATH = os.environ.get("GH_PATH", shutil.which("gh") or "gh")

# Limits
MAX_DIFF_CHARS = 80000
MAX_COMMENT_CHARS = 65000
REVIEW_MARKER = "<!-- harness-pr-review -->"

# ─── Helpers ──────────────────────────────────────────────────────────


def notify(channel: str, message: str, repo: str = ""):
    """Write notification to pending-notifications.jsonl."""
    entry = {
        "task": "pr-review",
        "channel": channel,
        "summary": message,
        "timestamp": datetime.datetime.now().isoformat(),
    }
    if repo:
        entry["project"] = repo
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")


def load_config() -> dict:
    if not os.path.exists(CONFIG_FILE):
        print(f"ERROR: Config not found: {CONFIG_FILE}")
        sys.exit(1)
    with open(CONFIG_FILE) as f:
        return json.load(f)


def load_state() -> dict:
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"reviewed_prs": {}}


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
    # macOS common locations
    for p in [
        os.path.expanduser("~/.claude/local/claude"),
        os.path.expanduser("~/.local/bin/claude"),
        "/usr/local/bin/claude",
    ]:
        if os.path.isfile(p):
            return p
    return "claude"


# ─── PR Discovery ────────────────────────────────────────────────────


def list_open_prs(owner_repo: str) -> list[dict]:
    """Get open PRs for a repo."""
    result = gh_run([
        "pr", "list",
        "--repo", owner_repo,
        "--state", "open",
        "--json", "number,title,author,headRefName,baseRefName,url",
        "--limit", "20",
    ])
    if result.returncode != 0:
        print(f"  ERROR listing PRs for {owner_repo}: {result.stderr.strip()}")
        return []
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        print(f"  ERROR parsing PR list for {owner_repo}")
        return []


def pr_already_reviewed(owner_repo: str, pr_number: int) -> bool:
    """Check if we've already posted a review comment on this PR."""
    result = gh_run([
        "api", f"repos/{owner_repo}/issues/{pr_number}/comments",
        "--jq", ".[].body",
    ], timeout=30)
    if result.returncode != 0:
        return False
    # Check for our review marker in any comment
    return REVIEW_MARKER in result.stdout


# ─── PR Data Fetching ────────────────────────────────────────────────


def get_pr_diff(owner_repo: str, pr_number: int) -> str:
    """Get the diff for a PR."""
    result = gh_run(["pr", "diff", str(pr_number), "--repo", owner_repo], timeout=120)
    if result.returncode != 0:
        return ""
    return result.stdout[:MAX_DIFF_CHARS]


def get_pr_changed_files(owner_repo: str, pr_number: int) -> str:
    """Get changed file names for a PR."""
    result = gh_run(["pr", "diff", str(pr_number), "--repo", owner_repo, "--name-only"], timeout=30)
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


def get_pr_info(owner_repo: str, pr_number: int) -> dict:
    """Get PR metadata."""
    result = gh_run([
        "pr", "view", str(pr_number),
        "--repo", owner_repo,
        "--json", "title,body,author,headRefName,baseRefName",
    ], timeout=30)
    if result.returncode != 0:
        return {}
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {}


# ─── Claude Review ────────────────────────────────────────────────────


def build_review_prompt(pr_info: dict, changed_files: str, diff: str, project_scope: str) -> str:
    """Build the review prompt for Claude."""
    title = pr_info.get("title", "Unknown")
    body = pr_info.get("body", "") or ""
    author = pr_info.get("author", {})
    author_login = author.get("login", "Unknown") if isinstance(author, dict) else str(author)
    head = pr_info.get("headRefName", "")
    base = pr_info.get("baseRefName", "")

    return f"""You are a senior code reviewer for the AYTM Harness PR review system.

## Project Context
{project_scope}

## Review Criteria
Evaluate this pull request on these dimensions:

1. **Cohesiveness** — Do the changes fit together logically? Are they well-scoped?
2. **Project Scope Accuracy** — Do the changes align with the project goals described above?
3. **Effectiveness** — Will these changes improve the project? Do they actually accomplish what the PR claims?
4. **Code Quality** — Correctness, no broken imports, proper error handling, secure patterns
5. **Build Safety** — Will this break the build? Check for type errors, missing exports, bad imports

## PR Details
- **Title**: {title}
- **Author**: {author_login}
- **Branch**: {head} → {base}
- **Description**: {body[:2000]}

## Changed Files
{changed_files}

## Diff
```diff
{diff}
```

## Response Format
Respond with EXACTLY this format:

VERDICT: APPROVE or REQUEST_CHANGES

## Review Summary
(1-2 sentence overall assessment)

## Critical Issues
(List any blocking issues, or 'None' if clean)

## Warnings
(List any concerns that aren't blocking, or 'None')

## Suggestions
(List any improvements, or 'None')

## Scope Check
(Does this align with the project scope? Brief assessment)

IMPORTANT: Only use VERDICT: REQUEST_CHANGES if there are genuine Critical Issues that would break the build, introduce bugs, or fundamentally misalign with the project. Style preferences and minor suggestions should NOT block a merge."""


def run_claude_review(prompt: str) -> str | None:
    """Run Claude CLI to review a PR. Returns the review text or None on failure."""
    claude_path = get_claude_path()
    clean = clean_env_for_claude()

    # Write prompt to temp file to avoid argument length limits
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
        f.write(prompt)
        prompt_file = f.name

    try:
        result = subprocess.run(
            [
                claude_path, "-p",
                "--output-format", "json",
                "--max-turns", "1",
                "--dangerously-skip-permissions",
            ],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=300,
            env=clean,
            cwd=HARNESS_ROOT,
        )
    except subprocess.TimeoutExpired:
        print("  ERROR: Claude CLI timed out after 300s")
        return None
    except FileNotFoundError:
        print(f"  ERROR: Claude CLI not found at {claude_path}")
        return None
    finally:
        os.unlink(prompt_file)

    if result.returncode != 0:
        stderr = result.stderr.strip()[:500]
        print(f"  ERROR: Claude CLI failed (exit {result.returncode}): {stderr}")
        return None

    # Parse JSON output
    try:
        data = json.loads(result.stdout)
        # Claude CLI JSON output has a "result" field with the text
        if isinstance(data, dict):
            return data.get("result", data.get("text", result.stdout))
        return result.stdout
    except json.JSONDecodeError:
        # Fallback: return raw stdout if not JSON
        return result.stdout.strip() if result.stdout.strip() else None


def parse_verdict(review_text: str) -> str:
    """Extract VERDICT from review text. Defaults to APPROVE if ambiguous."""
    match = re.search(r"VERDICT:\s*(APPROVE|REQUEST_CHANGES)", review_text, re.IGNORECASE)
    if match:
        return match.group(1).upper()
    return "APPROVE"


# ─── PR Actions ───────────────────────────────────────────────────────


def post_review_comment(owner_repo: str, pr_number: int, review_text: str, verdict: str) -> bool:
    """Post the review as a PR comment."""
    emoji = "✅" if verdict == "APPROVE" else "❌"
    verdict_label = "Approved" if verdict == "APPROVE" else "Changes Requested"

    body = f"""{REVIEW_MARKER}
## {emoji} AI Code Review — {verdict_label}

{review_text[:MAX_COMMENT_CHARS]}

---
*Reviewed by the AYTM Harness Reviewer Agent (Claude)*"""

    result = gh_run([
        "pr", "comment", str(pr_number),
        "--repo", owner_repo,
        "--body", body,
    ], timeout=30)

    if result.returncode != 0:
        print(f"  ERROR posting comment: {result.stderr.strip()}")
        return False
    return True


def merge_pr(owner_repo: str, pr_number: int) -> bool:
    """Auto-merge a PR via squash merge."""
    result = gh_run([
        "pr", "merge", str(pr_number),
        "--repo", owner_repo,
        "--squash",
    ], timeout=60)

    if result.returncode != 0:
        print(f"  ERROR merging PR: {result.stderr.strip()}")
        return False
    return True


def request_changes(owner_repo: str, pr_number: int, review_text: str) -> bool:
    """Post a GitHub review requesting changes."""
    body = "This PR has critical issues that need to be resolved before merging. See the detailed review comment above."
    result = gh_run([
        "api", f"repos/{owner_repo}/pulls/{pr_number}/reviews",
        "--method", "POST",
        "-f", "event=REQUEST_CHANGES",
        "-f", f"body={body}",
    ], timeout=30)

    if result.returncode != 0:
        print(f"  ERROR requesting changes: {result.stderr.strip()}")
        return False
    return True


# ─── Main Review Logic ────────────────────────────────────────────────


def review_pr(owner_repo: str, pr_number: int, repo_config: dict, dry_run: bool = False) -> dict:
    """Review a single PR. Returns result dict."""
    print(f"\n  Reviewing PR #{pr_number} in {owner_repo}...")

    # Get PR data
    pr_info = get_pr_info(owner_repo, pr_number)
    if not pr_info:
        return {"status": "error", "error": "Failed to get PR info"}

    changed_files = get_pr_changed_files(owner_repo, pr_number)
    diff = get_pr_diff(owner_repo, pr_number)
    if not diff:
        return {"status": "error", "error": "Failed to get PR diff (empty diff?)"}

    title = pr_info.get("title", "Unknown")
    project_scope = repo_config.get("project_scope", "No project scope provided.")
    auto_merge = repo_config.get("auto_merge", False)
    discord_channel = repo_config.get("discord_channel", "notifications")

    print(f"  Title: {title}")
    print(f"  Changed files: {len(changed_files.splitlines())}")
    print(f"  Diff size: {len(diff)} chars")

    # Build prompt and review
    prompt = build_review_prompt(pr_info, changed_files, diff, project_scope)

    if dry_run:
        print(f"  [DRY RUN] Would review with Claude ({len(prompt)} char prompt)")
        print(f"  [DRY RUN] auto_merge={auto_merge}")
        return {"status": "dry_run", "title": title, "prompt_size": len(prompt)}

    review_text = run_claude_review(prompt)
    if not review_text:
        return {"status": "error", "error": "Claude review failed"}

    verdict = parse_verdict(review_text)
    print(f"  Verdict: {verdict}")

    # Post review comment
    posted = post_review_comment(owner_repo, pr_number, review_text, verdict)
    if not posted:
        return {"status": "error", "error": "Failed to post review comment"}

    # Take action based on verdict
    merged = False
    if verdict == "APPROVE" and auto_merge:
        merged = merge_pr(owner_repo, pr_number)
        action = "approved and merged" if merged else "approved (merge failed)"
    elif verdict == "APPROVE":
        action = "approved (auto-merge disabled)"
    else:
        request_changes(owner_repo, pr_number, review_text)
        action = "changes requested"

    # Notify Discord
    emoji = "✅" if verdict == "APPROVE" else "❌"
    merge_note = " → merged" if merged else ""
    notify(
        discord_channel,
        f"{emoji} **PR #{pr_number}** in `{owner_repo}`: {title}\n"
        f"**Verdict:** {verdict}{merge_note}\n"
        f"[View PR](https://github.com/{owner_repo}/pull/{pr_number})",
        repo=owner_repo,
    )

    return {
        "status": "reviewed",
        "title": title,
        "verdict": verdict,
        "merged": merged,
        "action": action,
    }


def review_repo(repo_config: dict, state: dict, dry_run: bool = False,
                single_pr: int | None = None) -> list[dict]:
    """Review all unreviewed PRs for a single repo."""
    owner_repo = repo_config["owner_repo"]
    print(f"\n{'='*60}")
    print(f"Repo: {owner_repo}")
    print(f"{'='*60}")

    results = []

    if single_pr is not None:
        # Review a specific PR regardless of review status
        prs_to_review = [{"number": single_pr}]
    else:
        # List open PRs
        open_prs = list_open_prs(owner_repo)
        if not open_prs:
            print("  No open PRs found.")
            return results

        print(f"  Found {len(open_prs)} open PR(s)")

        # Filter to unreviewed PRs
        prs_to_review = []
        for pr in open_prs:
            pr_num = pr["number"]
            # Check state cache first
            state_key = f"{owner_repo}#{pr_num}"
            if state_key in state.get("reviewed_prs", {}):
                print(f"  PR #{pr_num}: already reviewed (state cache)")
                continue
            # Check GitHub comments
            if pr_already_reviewed(owner_repo, pr_num):
                print(f"  PR #{pr_num}: already reviewed (comment marker)")
                # Cache it
                state.setdefault("reviewed_prs", {})[state_key] = {
                    "reviewed_at": datetime.datetime.now().isoformat(),
                    "source": "marker_detected",
                }
                continue
            prs_to_review.append(pr)

        if not prs_to_review:
            print("  All PRs already reviewed.")
            return results

    # Review each PR
    for pr in prs_to_review:
        pr_num = pr["number"]
        try:
            result = review_pr(owner_repo, pr_num, repo_config, dry_run=dry_run)
            result["pr_number"] = pr_num
            result["repo"] = owner_repo
            results.append(result)

            # Update state
            if result.get("status") == "reviewed":
                state_key = f"{owner_repo}#{pr_num}"
                state.setdefault("reviewed_prs", {})[state_key] = {
                    "reviewed_at": datetime.datetime.now().isoformat(),
                    "verdict": result.get("verdict"),
                    "merged": result.get("merged", False),
                }
        except Exception as e:
            print(f"  ERROR reviewing PR #{pr_num}: {e}")
            results.append({
                "pr_number": pr_num,
                "repo": owner_repo,
                "status": "error",
                "error": str(e),
            })

    return results


# ─── Entry Point ──────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Review open PRs with Claude")
    parser.add_argument("--repo", help="Review PRs for a specific owner/repo only")
    parser.add_argument("--pr", type=int, help="Review a specific PR number (requires --repo)")
    parser.add_argument("--dry-run", action="store_true", help="Show what would happen without posting")
    args = parser.parse_args()

    if args.pr and not args.repo:
        parser.error("--pr requires --repo")

    config = load_config()
    state = load_state()
    all_results = []

    repos = config.get("repos", [])
    if args.repo:
        repos = [r for r in repos if r["owner_repo"] == args.repo]
        if not repos:
            # Allow ad-hoc repo review not in config
            repos = [{
                "owner_repo": args.repo,
                "project_scope": "No project scope configured. Review for general code quality.",
                "discord_channel": "notifications",
                "auto_merge": False,
            }]

    for repo_config in repos:
        try:
            results = review_repo(
                repo_config, state,
                dry_run=args.dry_run,
                single_pr=args.pr,
            )
            all_results.extend(results)
        except Exception as e:
            print(f"ERROR processing {repo_config['owner_repo']}: {e}")

    # Save state
    if not args.dry_run:
        state["last_run"] = datetime.datetime.now().isoformat()
        save_state(state)

    # Summary
    print(f"\n{'='*60}")
    print("Summary")
    print(f"{'='*60}")
    reviewed = [r for r in all_results if r.get("status") == "reviewed"]
    errors = [r for r in all_results if r.get("status") == "error"]
    dry_runs = [r for r in all_results if r.get("status") == "dry_run"]

    if dry_runs:
        print(f"  Would review: {len(dry_runs)} PR(s)")
    if reviewed:
        approved = sum(1 for r in reviewed if r.get("verdict") == "APPROVE")
        changes = sum(1 for r in reviewed if r.get("verdict") == "REQUEST_CHANGES")
        merged = sum(1 for r in reviewed if r.get("merged"))
        print(f"  Reviewed: {len(reviewed)} PR(s)")
        print(f"  Approved: {approved} | Changes requested: {changes} | Merged: {merged}")
    if errors:
        print(f"  Errors: {len(errors)}")
        for e in errors:
            print(f"    - PR #{e.get('pr_number', '?')} in {e.get('repo', '?')}: {e.get('error', '?')}")
    if not all_results:
        print("  No PRs to review.")


if __name__ == "__main__":
    main()
