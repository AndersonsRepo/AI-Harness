#!/usr/bin/env python3
"""Heartbeat task runner — reads task config, runs claude -p, writes state.

Usage: python3 heartbeat-runner.py <task-name>

Reads config from heartbeat-tasks/<task-name>.json
Writes state to heartbeat-tasks/<task-name>.state.json
Logs to heartbeat-tasks/logs/<task-name>.log
Optionally sends summary to Discord via webhook.
"""

import subprocess
import sys
import os
import json
import datetime
import traceback

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    "$HOME/.local/ai-harness"
)
TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
CLAUDE_RUNNER = os.path.join(HARNESS_ROOT, "bridges", "discord", "claude-runner.py")
PYTHON = "/opt/homebrew/bin/python3"
CLAUDE_PATH = "$HOME/.local/bin/claude"


def log(task_name, msg):
    """Append timestamped message to task log file."""
    log_file = os.path.join(TASKS_DIR, "logs", f"{task_name}.log")
    ts = datetime.datetime.now().isoformat()
    line = f"[{ts}] {msg}\n"
    with open(log_file, "a") as f:
        f.write(line)
    print(line, end="")


def load_config(task_name):
    """Load task config JSON."""
    config_path = os.path.join(TASKS_DIR, f"{task_name}.json")
    with open(config_path) as f:
        return json.load(f)


def load_state(task_name):
    """Load task state, or return defaults if none exists."""
    state_path = os.path.join(TASKS_DIR, f"{task_name}.state.json")
    if os.path.exists(state_path):
        with open(state_path) as f:
            return json.load(f)
    return {
        "last_run": None,
        "last_result": None,
        "last_output_summary": None,
        "consecutive_failures": 0,
        "total_runs": 0,
    }


def save_state(task_name, state):
    """Atomic write of state file."""
    state_path = os.path.join(TASKS_DIR, f"{task_name}.state.json")
    tmp = state_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.rename(tmp, state_path)


def run_claude(prompt, allowed_tools=None, timeout=300, env_passthrough=None):
    """Run claude -p with the given prompt. Returns (success, output_text)."""
    claude_args = ["-p", "--dangerously-skip-permissions", "--output-format", "json"]
    if allowed_tools:
        claude_args.extend(["--allowedTools", ",".join(allowed_tools)])
    # Use -- to separate options from the prompt positional arg
    # (--allowedTools is variadic and will consume the prompt otherwise)
    claude_args.extend(["--", prompt])

    clean_env = {
        "HOME": os.environ.get("HOME", "$HOME"),
        "USER": os.environ.get("USER", "user"),
        "PATH": "$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        "SHELL": os.environ.get("SHELL", "/bin/zsh"),
        "LANG": os.environ.get("LANG", "en_US.UTF-8"),
        "TERM": "dumb",
        "HARNESS_ROOT": HARNESS_ROOT,
    }
    # Remove CLAUDECODE to avoid nested session detection
    clean_env.pop("CLAUDECODE", None)

    # Pass through integration env vars from task config
    if env_passthrough:
        for var in env_passthrough:
            val = os.environ.get(var)
            if val:
                clean_env[var] = val

    try:
        result = subprocess.run(
            [CLAUDE_PATH] + claude_args,
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
            env=clean_env,
            timeout=timeout,
            cwd=HARNESS_ROOT,
        )

        if result.returncode == 0:
            # Try to parse JSON output
            try:
                data = json.loads(result.stdout)
                # Claude JSON output has a "result" field with the text
                text = data.get("result", result.stdout)
            except (json.JSONDecodeError, TypeError):
                text = result.stdout
            return True, text.strip() if isinstance(text, str) else str(text)
        else:
            return False, f"Exit code {result.returncode}: {result.stderr}"

    except subprocess.TimeoutExpired:
        return False, f"Claude timed out after {timeout}s"
    except Exception as e:
        return False, str(e)


def run_script(script_path, timeout=300):
    """Run a local Python script. Returns (success, output_text)."""
    try:
        result = subprocess.run(
            [PYTHON, script_path],
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
            env={
                **os.environ,
                "HARNESS_ROOT": HARNESS_ROOT,
            },
            timeout=timeout,
            cwd=HARNESS_ROOT,
        )
        output = result.stdout.strip()
        if result.returncode == 0:
            return True, output or "Script completed successfully"
        else:
            return False, f"Exit code {result.returncode}: {result.stderr}"
    except subprocess.TimeoutExpired:
        return False, f"Script timed out after {timeout}s"
    except Exception as e:
        return False, str(e)


def send_discord_notification(config, summary):
    """Send a summary to Discord via the bot's webhook or channel post.

    For now, writes to a notification file that the Discord bot can pick up.
    Future: direct Discord webhook integration.
    """
    notify_file = os.path.join(TASKS_DIR, "pending-notifications.jsonl")
    notification = {
        "task": config["name"],
        "channel": config.get("discord_channel", "general"),
        "summary": summary,
        "timestamp": datetime.datetime.now().isoformat(),
    }
    with open(notify_file, "a") as f:
        f.write(json.dumps(notification) + "\n")


def append_to_daily_vault(summary, task_name):
    """Append task summary to today's daily vault note."""
    today = datetime.date.today().strftime("%Y-%m-%d")
    daily_dir = os.path.join(HARNESS_ROOT, "vault", "daily")
    os.makedirs(daily_dir, exist_ok=True)
    daily_file = os.path.join(daily_dir, f"{today}.md")

    ts = datetime.datetime.now().strftime("%H:%M")

    if not os.path.exists(daily_file):
        header = f"---\ndate: {today}\ntype: daily\n---\n\n# Daily Log — {today}\n\n"
        with open(daily_file, "w") as f:
            f.write(header)

    with open(daily_file, "a") as f:
        f.write(f"\n## [{ts}] Heartbeat: {task_name}\n\n{summary}\n")


def run_task(task_name):
    """Main task execution logic."""
    log(task_name, f"Starting heartbeat task: {task_name}")

    # Load config
    try:
        config = load_config(task_name)
    except FileNotFoundError:
        log(task_name, f"ERROR: Config not found: {task_name}.json")
        return
    except json.JSONDecodeError as e:
        log(task_name, f"ERROR: Invalid config JSON: {e}")
        return

    # Check if enabled
    if not config.get("enabled", True):
        log(task_name, "Task is disabled, skipping")
        return

    # Load state
    state = load_state(task_name)

    # Check consecutive failures — auto-pause at 3
    if state["consecutive_failures"] >= 3:
        log(task_name, "Auto-paused: 3 consecutive failures. Use /heartbeat resume to re-enable.")
        config["enabled"] = False
        config_path = os.path.join(TASKS_DIR, f"{task_name}.json")
        with open(config_path, "w") as f:
            json.dump(config, f, indent=2)
        if config.get("notify") == "discord":
            send_discord_notification(config, f"Task '{task_name}' auto-paused after 3 consecutive failures.")
        return

    # Determine task type
    task_type = config.get("type", "claude")
    timeout = config.get("timeout", 300)

    if task_type == "script":
        script_path = os.path.join(TASKS_DIR, "scripts", config["script"])
        log(task_name, f"Running script: {script_path}")
        success, output = run_script(script_path, timeout)
    else:
        prompt = config["prompt"]
        allowed_tools = config.get("allowed_tools")
        env_passthrough = config.get("env_passthrough")
        log(task_name, f"Running claude with prompt: {prompt[:100]}...")
        success, output = run_claude(prompt, allowed_tools, timeout, env_passthrough)

    # Re-load state after execution — scripts may have updated the state file
    # (e.g. github-watch.py saves SHAs). We merge runner metadata on top.
    state = load_state(task_name)

    now = datetime.datetime.now().isoformat()
    state["last_run"] = now
    state["total_runs"] = state.get("total_runs", 0) + 1

    if success:
        state["last_result"] = "success"
        state["consecutive_failures"] = 0
        # Truncate summary for state file
        state["last_output_summary"] = output[:500] if output else "No output"
        log(task_name, f"Success: {output[:200]}")
    else:
        state["last_result"] = "failure"
        state["consecutive_failures"] = state.get("consecutive_failures", 0) + 1
        state["last_output_summary"] = f"FAILED: {output[:500]}"
        log(task_name, f"FAILED: {output[:200]}")

    save_state(task_name, state)

    # Write to daily vault
    summary = output[:1000] if output else "No output"
    append_to_daily_vault(summary, task_name)

    # Discord notification
    if config.get("notify") == "discord" and success:
        send_discord_notification(config, summary)

    log(task_name, "Task complete")


def main():
    if len(sys.argv) < 2:
        print("Usage: heartbeat-runner.py <task-name>")
        sys.exit(1)

    task_name = sys.argv[1]

    try:
        run_task(task_name)
    except Exception:
        # Never crash — log the error
        log(task_name, f"UNHANDLED ERROR:\n{traceback.format_exc()}")
        # Still try to update state
        try:
            state = load_state(task_name)
            state["last_run"] = datetime.datetime.now().isoformat()
            state["last_result"] = "crash"
            state["consecutive_failures"] = state.get("consecutive_failures", 0) + 1
            state["last_output_summary"] = f"CRASH: {traceback.format_exc()[:500]}"
            save_state(task_name, state)
        except Exception:
            pass


if __name__ == "__main__":
    main()
