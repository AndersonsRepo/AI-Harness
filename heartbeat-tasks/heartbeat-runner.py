#!/usr/bin/env python3
"""Heartbeat task runner — reads task config, runs LLM prompt or script, writes state.

Usage: python3 heartbeat-runner.py <task-name>

Reads config from heartbeat-tasks/<task-name>.json
Writes state to heartbeat-tasks/<task-name>.state.json
Logs to heartbeat-tasks/logs/<task-name>.log
Optionally sends summary to Discord via webhook.

Per-task LLM provider routing: tasks can specify "provider" and "model" in their
JSON config. Scripts receive these as LLM_PROVIDER and LLM_MODEL env vars.
"""

import subprocess
import sys
import os
import json
import datetime
import traceback
import time

# Add lib/ to path for llm_provider imports
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

from lib.llm_provider import get_provider, LLMError
from lib.platform import paths

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
CLAUDE_RUNNER = os.path.join(HARNESS_ROOT, "bridges", "discord", "claude-runner.py")
PYTHON = paths.python()
CLAUDE_PATH = paths.claude_cli()


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
    """Load task state, merging with defaults to ensure required keys exist."""
    defaults = {
        "last_run": None,
        "last_result": None,
        "last_output_summary": None,
        "consecutive_failures": 0,
        "total_runs": 0,
    }
    state_path = os.path.join(TASKS_DIR, f"{task_name}.state.json")
    if os.path.exists(state_path):
        with open(state_path) as f:
            saved = json.load(f)
        # Merge: saved values override defaults, but defaults fill missing keys
        defaults.update(saved)
    return defaults


def save_state(task_name, state):
    """Atomic write of state file."""
    state_path = os.path.join(TASKS_DIR, f"{task_name}.state.json")
    tmp = state_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.rename(tmp, state_path)


def run_claude(prompt, allowed_tools=None, timeout=300, env_passthrough=None,
               provider_name=None, model=None):
    """Run an LLM with the given prompt. Returns (success, output_text).

    Uses the llm_provider abstraction so tasks can route to any provider.
    Falls back to claude-cli if no provider is specified.
    """
    try:
        provider = get_provider(provider_name)
        response = provider.complete(
            prompt,
            model=model,
            timeout=timeout,
            allowed_tools=allowed_tools,
            cwd=HARNESS_ROOT,
        )
        text = response.text.strip() if response.text else ""
        return True, text or "No output"
    except LLMError as e:
        return False, str(e)
    except Exception as e:
        return False, str(e)


def run_script(script_path, timeout=300, provider_name=None, model=None):
    """Run a local Python script. Returns (success, output_text).

    Passes LLM_PROVIDER and LLM_MODEL as env vars so scripts can use
    get_provider() to pick up the config-driven routing.
    """
    env = {
        **os.environ,
        "HARNESS_ROOT": HARNESS_ROOT,
    }
    # Inject provider routing — scripts read these via get_provider()
    if provider_name:
        env["LLM_PROVIDER"] = provider_name
    if model:
        env["LLM_MODEL"] = model

    try:
        result = subprocess.run(
            [PYTHON, script_path],
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
            env=env,
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

    # Check active hours — skip if outside configured window
    active_hours = config.get("activeHours")
    if active_hours:
        now = datetime.datetime.now()
        start_str = active_hours.get("start", "00:00")
        end_str = active_hours.get("end", "24:00")
        start_h, start_m = map(int, start_str.split(":"))
        end_h, end_m = map(int, end_str.split(":"))
        start_minutes = start_h * 60 + start_m
        end_minutes = end_h * 60 + end_m
        now_minutes = now.hour * 60 + now.minute
        if start_minutes < end_minutes:
            # Normal range (e.g., 08:00-22:00)
            if not (start_minutes <= now_minutes < end_minutes):
                log(task_name, f"Outside active hours ({start_str}-{end_str}), skipping")
                return
        else:
            # Overnight range (e.g., 22:00-06:00)
            if end_minutes <= now_minutes < start_minutes:
                log(task_name, f"Outside active hours ({start_str}-{end_str}), skipping")
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

    # Determine task type and provider routing
    task_type = config.get("type", "claude")
    timeout = config.get("timeout", 300)
    provider_name = config.get("provider")  # None = default (claude-cli)
    model = config.get("model")             # None = provider default

    if task_type == "script":
        script_path = os.path.join(TASKS_DIR, "scripts", config["script"])
        log(task_name, f"Running script: {script_path}")
        success, output = run_script(script_path, timeout,
                                     provider_name=provider_name, model=model)
    else:
        prompt = config["prompt"]
        allowed_tools = config.get("allowed_tools")
        env_passthrough = config.get("env_passthrough")
        provider_label = provider_name or "claude-cli"
        model_label = model or "default"
        log(task_name, f"Running {provider_label}/{model_label} with prompt: {prompt[:100]}...")
        success, output = run_claude(prompt, allowed_tools, timeout, env_passthrough,
                                     provider_name=provider_name, model=model)

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

    # Write to daily vault — skip no-change outputs to reduce noise
    summary = output[:1000] if output else "No output"
    no_change_phrases = ["no new", "no changes", "nothing to", "0 new", "already up to date", "no output"]
    is_noise = any(phrase in summary.lower() for phrase in no_change_phrases)
    if not is_noise:
        append_to_daily_vault(summary, task_name)

    # Discord notification — only on failure (scripts handle their own success notifications)
    if config.get("notify") == "discord" and not success:
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
