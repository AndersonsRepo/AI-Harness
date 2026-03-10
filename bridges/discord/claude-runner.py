#!/usr/bin/env python3
"""Runs claude CLI with a clean environment, writing output to a file.
Workaround for nested session detection and Node.js spawn stalling.
See: https://github.com/anthropics/claude-code/issues/771

Usage: python3 claude-runner.py <output_file> [claude args...]
Output is written to <output_file> instead of stdout to avoid
Node.js pipe stalling when this is spawned from a Node.js parent."""

import subprocess
import sys
import os
import json

def main():
    args = sys.argv[1:]
    if len(args) < 2:
        print(json.dumps({"error": "Usage: claude-runner.py <output_file> [claude args...]"}))
        sys.exit(1)

    output_file = args[0]
    claude_args = args[1:]

    claude_path = "$HOME/.local/bin/claude"
    cwd = os.environ.get("HARNESS_ROOT", "$HOME/Desktop/AI-Harness")

    clean_env = {
        "HOME": os.environ.get("HOME", "$HOME"),
        "USER": os.environ.get("USER", "user"),
        "PATH": "$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        "SHELL": os.environ.get("SHELL", "/bin/zsh"),
        "LANG": os.environ.get("LANG", "en_US.UTF-8"),
        "TERM": "dumb",
        "XDG_CONFIG_HOME": os.environ.get("XDG_CONFIG_HOME", ""),
        "SSH_AUTH_SOCK": os.environ.get("SSH_AUTH_SOCK", ""),
    }
    clean_env = {k: v for k, v in clean_env.items() if v}

    def write_result(data):
        """Atomic write: write to .tmp then rename to avoid partial reads."""
        tmp = output_file + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.rename(tmp, output_file)

    try:
        result = subprocess.run(
            [claude_path] + claude_args,
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
            env=clean_env,
            timeout=120,
            cwd=cwd,
        )

        write_result({
            "stdout": result.stdout or "",
            "stderr": result.stderr or "",
            "returncode": result.returncode,
        })

    except subprocess.TimeoutExpired:
        write_result({"stdout": "", "stderr": "Claude timed out after 120 seconds", "returncode": 1})
    except Exception as e:
        write_result({"stdout": "", "stderr": str(e), "returncode": 1})

if __name__ == "__main__":
    main()
