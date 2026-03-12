#!/usr/bin/env python3
"""Poll GitHub repos for new events and notify Discord channels.

Watches for: pushes, PRs (opened/closed/merged), and issues (opened/closed).
Uses `gh` CLI for API access. Reads repos from heartbeat-tasks/projects.json.
"""

import subprocess
import json
import os
import sys
import datetime

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
STATE_FILE = os.path.join(TASKS_DIR, "github-watch.state.json")
NOTIFY_FILE = os.path.join(TASKS_DIR, "pending-notifications.jsonl")
PROJECTS_FILE = os.path.join(TASKS_DIR, "projects.json")
GH_PATH = os.environ.get("GH_PATH", "/opt/homebrew/bin/gh")


def load_watched_repos():
    """Load repo -> channel mapping from projects.json."""
    if not os.path.exists(PROJECTS_FILE):
        print("No projects.json found. Copy projects.example.json and configure.", file=sys.stderr)
        return {}
    with open(PROJECTS_FILE) as f:
        data = json.load(f)
    repos = {}
    for name, cfg in data.get("projects", {}).items():
        repo = cfg.get("repo")
        channel = cfg.get("discord_channel", name)
        if repo:
            repos[repo] = channel
    return repos


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {}


def save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.rename(tmp, STATE_FILE)


def notify(channel, message, repo):
    notification = {
        "task": "github-watch",
        "channel": channel,
        "summary": message,
        "timestamp": datetime.datetime.now().isoformat(),
        "repo": repo,
    }
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(notification) + "\n")


def gh_api(endpoint):
    """Call GitHub API via gh CLI. Returns parsed JSON or None."""
    try:
        result = subprocess.run(
            [GH_PATH, "api", endpoint],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            print(f"gh api error for {endpoint}: {result.stderr}", file=sys.stderr)
            return None
        return json.loads(result.stdout) if result.stdout.strip() else None
    except (subprocess.TimeoutExpired, json.JSONDecodeError) as e:
        print(f"Error calling gh api {endpoint}: {e}", file=sys.stderr)
        return None


def check_pushes(repo, channel, repo_state):
    """Check for new commits on default branch."""
    last_sha = repo_state.get("last_push_sha")
    commits = gh_api(f"/repos/{repo}/commits?per_page=5")
    if not commits or not isinstance(commits, list):
        return

    latest = commits[0]
    latest_sha = latest["sha"]

    if last_sha and latest_sha != last_sha:
        # Find how many new commits
        new_count = 0
        for c in commits:
            if c["sha"] == last_sha:
                break
            new_count += 1
        else:
            new_count = len(commits)

        author = latest["commit"]["author"]["name"]
        msg = latest["commit"]["message"].split("\n")[0][:80]
        url = latest["html_url"]

        if new_count == 1:
            notify(channel, f"**Push** by {author}: `{msg}`\n{url}", repo)
        else:
            notify(channel, f"**{new_count} new commits** — latest by {author}: `{msg}`\n{url}", repo)
        print(f"  {new_count} new push(es) detected")

    repo_state["last_push_sha"] = latest_sha


def check_prs(repo, channel, repo_state):
    """Check for new or updated PRs."""
    last_pr_updated = repo_state.get("last_pr_updated")
    prs = gh_api(f"/repos/{repo}/pulls?state=all&sort=updated&direction=desc&per_page=10")
    if not prs or not isinstance(prs, list):
        return

    seen_ids = set(repo_state.get("seen_pr_ids", []))
    new_seen = set()

    for pr in prs:
        pr_id = pr["number"]
        new_seen.add(pr_id)
        updated = pr["updated_at"]

        if last_pr_updated and updated <= last_pr_updated:
            continue

        title = pr["title"][:80]
        user = pr["user"]["login"]
        state = pr["state"]
        merged = pr.get("merged_at") is not None
        url = pr["html_url"]

        if pr_id not in seen_ids:
            # New PR
            notify(channel, f"**PR #{pr_id} opened** by {user}: {title}\n{url}", repo)
            print(f"  New PR #{pr_id}: {title}")
        elif merged:
            notify(channel, f"**PR #{pr_id} merged**: {title}\n{url}", repo)
            print(f"  PR #{pr_id} merged")
        elif state == "closed":
            notify(channel, f"**PR #{pr_id} closed**: {title}\n{url}", repo)
            print(f"  PR #{pr_id} closed")

    if prs:
        repo_state["last_pr_updated"] = prs[0]["updated_at"]
    repo_state["seen_pr_ids"] = list(new_seen)


def check_issues(repo, channel, repo_state):
    """Check for new or closed issues."""
    last_issue_updated = repo_state.get("last_issue_updated")
    items = gh_api(f"/repos/{repo}/issues?state=all&sort=updated&direction=desc&per_page=10&filter=all")
    if not items or not isinstance(items, list):
        return

    # Filter out PRs (GitHub API returns PRs in issues endpoint)
    issues = [i for i in items if "pull_request" not in i]

    seen_ids = set(repo_state.get("seen_issue_ids", []))
    new_seen = set()

    for issue in issues:
        issue_id = issue["number"]
        new_seen.add(issue_id)
        updated = issue["updated_at"]

        if last_issue_updated and updated <= last_issue_updated:
            continue

        title = issue["title"][:80]
        user = issue["user"]["login"]
        state = issue["state"]
        url = issue["html_url"]

        if issue_id not in seen_ids:
            notify(channel, f"**Issue #{issue_id} opened** by {user}: {title}\n{url}", repo)
            print(f"  New issue #{issue_id}: {title}")
        elif state == "closed":
            notify(channel, f"**Issue #{issue_id} closed**: {title}\n{url}", repo)
            print(f"  Issue #{issue_id} closed")

    if issues:
        repo_state["last_issue_updated"] = issues[0]["updated_at"]
    repo_state["seen_issue_ids"] = list(new_seen)


def main():
    watched_repos = load_watched_repos()
    if not watched_repos:
        print("No repos configured. Add projects to heartbeat-tasks/projects.json")
        return

    state = load_state()
    notifications_before = 0
    if os.path.exists(NOTIFY_FILE):
        with open(NOTIFY_FILE) as f:
            notifications_before = len(f.readlines())

    for repo, channel in watched_repos.items():
        print(f"Checking {repo} → #{channel}")
        repo_key = repo.replace("/", "_")
        repo_state = state.get(repo_key, {})

        check_pushes(repo, channel, repo_state)
        check_prs(repo, channel, repo_state)
        check_issues(repo, channel, repo_state)

        state[repo_key] = repo_state

    save_state(state)

    # Count new notifications
    notifications_after = 0
    if os.path.exists(NOTIFY_FILE):
        with open(NOTIFY_FILE) as f:
            notifications_after = len(f.readlines())
    new_count = notifications_after - notifications_before
    print(f"Done. {new_count} new notification(s) queued.")


if __name__ == "__main__":
    main()
