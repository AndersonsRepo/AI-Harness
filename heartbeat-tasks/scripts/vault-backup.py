#!/usr/bin/env python3
"""Auto-commits vault changes if any tracked/trackable files have been modified.
Only commits if there are real, non-gitignored changes in vault/."""

import subprocess
import os
import datetime

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)


def run(cmd, **kwargs):
    """Run a command and return (returncode, stdout)."""
    result = subprocess.run(
        cmd, capture_output=True, text=True, cwd=HARNESS_ROOT, **kwargs
    )
    return result.returncode, result.stdout.strip()


def main():
    # Check for vault changes (staged + unstaged + untracked in vault/)
    rc, status = run(["git", "status", "--porcelain", "vault/"])

    if not status:
        print("No vault changes to commit")
        return

    changed_files = [line.strip() for line in status.split("\n") if line.strip()]
    print(f"Vault changes detected: {len(changed_files)} file(s)")
    for f in changed_files:
        print(f"  {f}")

    # Stage vault changes only (respects .gitignore)
    rc, out = run(["git", "add", "vault/"])
    if rc != 0:
        print(f"ERROR: git add failed: {out}")
        return

    # Check if there's actually anything staged after .gitignore filtering
    rc, diff = run(["git", "diff", "--cached", "--name-only"])
    if not diff:
        print("Nothing staged after git add (all changes are gitignored)")
        # Reset staging area to avoid partial state
        run(["git", "reset", "HEAD", "--quiet"])
        return

    staged_files = [f for f in diff.split("\n") if f.strip()]
    print(f"Staged for commit: {len(staged_files)} file(s)")

    # Commit
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    msg = f"vault: auto-backup ({now}, {len(staged_files)} file(s))"

    rc, out = run(["git", "commit", "-m", msg])
    if rc == 0:
        print(f"Committed: {msg}")
    else:
        print(f"Commit failed: {out}")


if __name__ == "__main__":
    main()
