#!/usr/bin/env python3
"""Runs `codex exec` with a clean environment, writing output to a file.

Parallel to claude-runner.py. Produces the same output-file JSON contract so
task-runner.ts can dispatch to either runtime with a single switch.

Usage:
  codex-runner.py <output_file> [--timeout N] [--session-id UUID]
                  [--stream-dir PATH] [--prompt-file PATH] [codex-exec args...]

The prompt is read from --prompt-file if provided, otherwise from stdin.
Node callers should prefer --prompt-file so they can spawn this script
detached with stdio: "ignore" (same pattern as claude-runner.py).

If --session-id is provided, resumes the previous codex session; otherwise
starts a fresh one.

Output file shape (matches claude-runner except for id key name):
  {"stdout": <JSONL event stream>, "stderr": <stderr>, "returncode": N,
   "threadId": <extracted thread/session UUID or null>,
   "lastMessage": <final agent text or null>}
"""

import json
import os
import re
import resource
import signal
import subprocess
import sys
import threading
import time


# Substrings that mark a Codex stderr as transient and worth retrying.
# Mirrors claude-runner.py's heuristic — Codex shells out to ChatGPT's
# backend so the same upstream pressure-points (429s, 5xx, network resets)
# apply. Lowercased; matched against stderr_text.lower().
_TRANSIENT_STDERR_SIGNALS = (
    "429",
    "rate limit",
    "503",
    "502",
    "500",
    "overloaded",
    "connection",
    "econnreset",
    "socket hang up",
    "timeout",
)


def _resolve_backoff_delays():
    """Return the per-retry sleep schedule. CODEX_RETRY_DELAYS (a JSON list of
    numbers) overrides the default for tests so the suite isn't gated on
    real-world 5s/15s/45s waits."""
    default = [5, 15, 45]
    raw = os.environ.get("CODEX_RETRY_DELAYS")
    if not raw:
        return default
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        sys.stderr.write(
            "[codex-runner] CODEX_RETRY_DELAYS was set but not valid JSON; using defaults.\n"
        )
        return default
    if not isinstance(parsed, list) or not all(isinstance(x, (int, float)) for x in parsed):
        sys.stderr.write(
            "[codex-runner] CODEX_RETRY_DELAYS must be a JSON list of numbers; using defaults.\n"
        )
        return default
    return [float(x) for x in parsed]


# Kept in sync with bridges/discord/safety.ts DESTRUCTIVE_BASH_PATTERNS.
# If CODEX_SAFETY_PATTERNS is set in the environment (normal path — set by
# codex-config.ts), that JSON wins; this list is a fallback for manual
# invocations so the runner is never unguarded.
_DEFAULT_PATTERNS = [
    {"id": "rm-rf", "regex": r"\brm\s+(-[rRfF]+|--recursive|--force)"},
    {"id": "git-push-force", "regex": r"\bgit\s+push\s+(--force|-f\b)"},
    {"id": "git-reset-hard", "regex": r"\bgit\s+reset\s+--hard\b"},
    {"id": "kill-9", "regex": r"\bkill\s+-9\b"},
    {"id": "pkill-9", "regex": r"\bpkill\s+-9\b"},
    {"id": "drop-table", "regex": r"\bDROP\s+TABLE\b", "caseInsensitive": True},
    {"id": "delete-from", "regex": r"\bDELETE\s+FROM\b", "caseInsensitive": True},
]


def _load_safety_patterns():
    raw = os.environ.get("CODEX_SAFETY_PATTERNS")
    patterns = _DEFAULT_PATTERNS
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                patterns = parsed
        except json.JSONDecodeError:
            sys.stderr.write(
                "[codex-runner] CODEX_SAFETY_PATTERNS was set but not valid JSON; using defaults.\n"
            )

    compiled = []
    for p in patterns:
        if not isinstance(p, dict):
            continue
        regex = p.get("regex")
        pid = p.get("id") or regex or "unknown"
        if not isinstance(regex, str):
            continue
        flags = re.IGNORECASE if p.get("caseInsensitive") else 0
        try:
            compiled.append((pid, re.compile(regex, flags)))
        except re.error as e:
            sys.stderr.write(f"[codex-runner] Skipping invalid pattern {pid!r}: {e}\n")
    return compiled


def _extract_commands(event):
    """Pull candidate command strings out of a Codex JSONL event.

    Codex emits exec/shell events under a few different shapes depending
    on its version; we check top-level and nested `msg` for any of the
    usual keys. Returns a list of strings to pattern-match.
    """
    if not isinstance(event, dict):
        return []

    candidates = []
    sources = [event]
    msg = event.get("msg")
    if isinstance(msg, dict):
        sources.append(msg)

    for src in sources:
        for key in ("command", "cmd", "argv", "arguments", "shell_command"):
            value = src.get(key)
            if isinstance(value, str):
                candidates.append(value)
            elif isinstance(value, list):
                parts = [v for v in value if isinstance(v, str)]
                if parts:
                    candidates.append(" ".join(parts))
    return candidates


def scan_for_destructive(line: str, compiled_patterns):
    """Scan a single JSONL line for destructive command patterns.

    Returns (pattern_id, matched_command) on first hit; None otherwise.
    Exposed as a module-level function so unit tests can exercise the
    logic without spawning a real Codex.
    """
    line = line.strip()
    if not line:
        return None
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        return None

    for command in _extract_commands(event):
        for pid, pattern in compiled_patterns:
            if pattern.search(command):
                return (pid, command)
    return None


def main():
    args = sys.argv[1:]
    if len(args) < 1:
        print(json.dumps({
            "error": "Usage: codex-runner.py <output_file> [--timeout N] [--session-id UUID] [--stream-dir PATH] [codex args...]"
        }))
        sys.exit(1)

    output_file = args[0]
    remaining = args[1:]

    timeout = 1800
    session_id = None
    stream_dir = None
    prompt_file = None

    while remaining:
        if remaining[0] == "--timeout" and len(remaining) > 1:
            timeout = int(remaining[1])
            remaining = remaining[2:]
        elif remaining[0] == "--session-id" and len(remaining) > 1:
            session_id = remaining[1]
            remaining = remaining[2:]
        elif remaining[0] == "--stream-dir" and len(remaining) > 1:
            stream_dir = remaining[1]
            remaining = remaining[2:]
        elif remaining[0] == "--prompt-file" and len(remaining) > 1:
            prompt_file = remaining[1]
            remaining = remaining[2:]
        else:
            break

    codex_args = remaining

    harness_root = os.environ.get(
        "HARNESS_ROOT",
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    )
    sys.path.insert(0, os.path.join(harness_root, "heartbeat-tasks"))
    from lib.platform import env as plat_env  # type: ignore

    codex_path = os.environ.get("CODEX_CLI_PATH") or os.path.expanduser(
        "~/.local/codex-cli/node_modules/.bin/codex"
    )
    cwd = os.environ.get("PROJECT_CWD", harness_root)

    clean_env = plat_env.clean_env(
        passthrough=["XDG_CONFIG_HOME", "SSH_AUTH_SOCK", "CODEX_HOME", "CODEX_RUNNER_PATH"]
    )
    if os.environ.get("CODEX_RUNNER_PATH"):
        clean_env["PATH"] = os.environ["CODEX_RUNNER_PATH"]

    try:
        resource.setrlimit(resource.RLIMIT_FSIZE, (resource.RLIM_INFINITY, resource.RLIM_INFINITY))
    except (ValueError, OSError):
        pass

    last_message_file = output_file + ".last"

    if session_id:
        invocation = [codex_path, "exec", "resume", session_id] + codex_args + ["--output-last-message", last_message_file, "-"]
    else:
        invocation = [codex_path, "exec"] + codex_args + ["--output-last-message", last_message_file, "-"]

    if prompt_file:
        try:
            with open(prompt_file, "rb") as f:
                prompt_bytes = f.read()
        except OSError as e:
            sys.stderr.write(f"[codex-runner] Failed to read --prompt-file {prompt_file}: {e}\n")
            prompt_bytes = sys.stdin.buffer.read()
    else:
        prompt_bytes = sys.stdin.buffer.read()

    def write_result(data):
        tmp = output_file + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.rename(tmp, output_file)

    # Signal-handler state. See claude-runner.py for the same pattern.
    state = {
        "active_proc": None,
        "completed": False,
        "cancelled": False,
    }

    def handle_cancel_signal(signum, _frame):
        state["cancelled"] = True
        proc = state["active_proc"]
        if proc is not None:
            try:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        try:
                            proc.kill()
                        except OSError:
                            pass
            except OSError:
                pass
        if not state["completed"]:
            try:
                write_result({
                    "stdout": "",
                    "stderr": f"cancelled by signal {signum}",
                    "returncode": 128 + signum,
                    "threadId": None,
                    "lastMessage": None,
                    "cancelled": True,
                })
                state["completed"] = True
            except Exception:
                pass
        # os._exit (not sys.exit) so we don't block on pending stdio reads,
        # background threads, or finally-block cleanup. Signal cancellation
        # is abnormal shutdown — emergency exit is the right tool.
        os._exit(128 + signum)

    signal.signal(signal.SIGTERM, handle_cancel_signal)
    signal.signal(signal.SIGINT, handle_cancel_signal)

    def extract_thread_id(jsonl: str):
        for line in jsonl.split("\n"):
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(ev, dict):
                for key in ("thread_id", "threadId", "session_id", "sessionId", "conversation_id", "conversationId"):
                    if isinstance(ev.get(key), str):
                        return ev[key]
                msg = ev.get("msg")
                if isinstance(msg, dict):
                    for key in ("thread_id", "threadId", "session_id", "sessionId", "conversation_id", "conversationId"):
                        if isinstance(msg.get(key), str):
                            return msg[key]
        return None

    def collect_text(value):
        if isinstance(value, str):
            return value.strip() or None
        if isinstance(value, list):
            parts = []
            for item in value:
                text = collect_text(item)
                if text:
                    parts.append(text)
            return "\n".join(parts).strip() or None
        if not isinstance(value, dict):
            return None

        for key in ("text", "result", "message", "content", "last_agent_message", "response", "item"):
            text = collect_text(value.get(key))
            if text:
                return text

        if isinstance(value.get("output"), list):
            text = collect_text(value["output"])
            if text:
                return text

        return None

    def extract_last_message(jsonl: str):
        last = None
        for line in jsonl.split("\n"):
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(ev, dict):
                continue
            msg = ev.get("msg") if isinstance(ev.get("msg"), dict) else None
            for source in (ev, msg or {}):
                t = source.get("type") or ""
                if any(k in str(t).lower() for k in ("message", "agent", "final", "complete", "result")):
                    text = collect_text(source)
                    if text:
                        last = text
                        break
        return last

    if stream_dir:
        # Created for compat; Stage 1 does not write chunks here.
        try:
            os.makedirs(stream_dir, exist_ok=True)
        except OSError:
            pass

    safety_patterns = _load_safety_patterns()
    backoff_delays = _resolve_backoff_delays()
    max_retries = len(backoff_delays)

    def run_attempt():
        """Run codex once. Returns (result_dict, retryable_bool).

        result_dict matches the final write_result shape (stdout, stderr,
        returncode, threadId, lastMessage, optional safetyViolation).
        Safety violations are never retryable; transient stderr signals and
        watchdog timeouts are.
        """
        proc = subprocess.Popen(
            invocation,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=clean_env,
            cwd=cwd,
        )
        state["active_proc"] = proc

        timed_out = [False]

        def watchdog():
            timed_out[0] = True
            try:
                proc.kill()
            except OSError:
                pass

        timer = threading.Timer(timeout, watchdog)
        # daemon=True so a SIGTERM-driven sys.exit() in the signal handler
        # doesn't block waiting for the timer thread to fire.
        timer.daemon = True
        timer.start()

        try:
            proc.stdin.write(prompt_bytes)
            proc.stdin.close()
        except BrokenPipeError:
            pass

        safety_violation = [None]  # (pattern_id, command) if tripped
        stdout_chunks = []
        for line in proc.stdout:
            decoded = line.decode("utf-8", errors="replace")
            stdout_chunks.append(decoded)
            # Each line resets the watchdog — active stream is not stalled.
            timer.cancel()
            timer = threading.Timer(timeout, watchdog)
            timer.start()

            # Inspect for destructive shell commands the Claude path would
            # have blocked via --disallowedTools. If matched, kill the
            # subprocess immediately so the command can't complete.
            hit = scan_for_destructive(decoded, safety_patterns)
            if hit:
                safety_violation[0] = hit
                try:
                    proc.kill()
                except OSError:
                    pass
                break

        timer.cancel()
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except OSError:
                pass

        state["active_proc"] = None
        stderr_text = (proc.stderr.read() or b"").decode("utf-8", errors="replace")
        stdout_text = "".join(stdout_chunks)

        if safety_violation[0]:
            pid, cmd = safety_violation[0]
            stderr_text = (
                stderr_text
                + f"\n[codex-runner] SAFETY VIOLATION ({pid}): killed subprocess before executing: {cmd[:300]}"
            ).strip()

        thread_id = extract_thread_id(stdout_text)
        last_message = None
        try:
            with open(last_message_file, "r", encoding="utf-8") as f:
                text = f.read().strip()
                if text:
                    last_message = text
        except OSError:
            pass
        if not last_message:
            last_message = extract_last_message(stdout_text)

        if safety_violation[0]:
            return ({
                "stdout": stdout_text,
                "stderr": stderr_text,
                "returncode": 1,
                "threadId": thread_id,
                "lastMessage": last_message,
                "safetyViolation": {
                    "id": safety_violation[0][0],
                    "command": safety_violation[0][1],
                },
            }, False)

        if timed_out[0]:
            return ({
                "stdout": stdout_text,
                "stderr": (stderr_text + f"\nCodex timed out after {timeout} seconds").strip(),
                "returncode": 1,
                "threadId": thread_id,
                "lastMessage": last_message,
            }, True)

        rc = proc.returncode if proc.returncode is not None else 1
        is_transient = False
        if rc != 0:
            stderr_lower = (stderr_text or "").lower()
            if any(s in stderr_lower for s in _TRANSIENT_STDERR_SIGNALS):
                is_transient = True

        return ({
            "stdout": stdout_text,
            "stderr": stderr_text,
            "returncode": rc,
            "threadId": thread_id,
            "lastMessage": last_message,
        }, is_transient)

    try:
        last_result = None
        for attempt in range(max_retries + 1):
            if state["cancelled"]:
                # Signal handler already wrote the cancellation envelope and
                # called sys.exit. Defense-in-depth in case we're somehow
                # re-entered via a non-handler path.
                break
            # Strip prior attempt's last_message_file so a transient first try
            # can't leak its agent text into the retry's lastMessage.
            try:
                if os.path.exists(last_message_file):
                    os.unlink(last_message_file)
            except OSError:
                pass

            try:
                result, retryable = run_attempt()
            except Exception as e:
                # Mirrors claude-runner: spawn-level exceptions are treated as
                # terminal, not transient. Write an error result and stop.
                last_result = {
                    "stdout": "",
                    "stderr": str(e),
                    "returncode": 1,
                    "threadId": None,
                    "lastMessage": None,
                }
                break

            last_result = result
            if retryable and attempt < max_retries:
                delay = backoff_delays[attempt]
                preview = (result.get("stderr") or "")[:120].replace("\n", " ")
                sys.stderr.write(
                    f"[codex-runner] Transient error (attempt {attempt + 1}/{max_retries + 1}), "
                    f"retrying in {delay}s: {preview}\n"
                )
                time.sleep(delay)
                if state["cancelled"]:
                    break
                continue
            break

        if last_result is not None and not state["completed"]:
            write_result(last_result)
            state["completed"] = True
    except Exception as e:
        if not state["completed"]:
            write_result({
                "stdout": "",
                "stderr": str(e),
                "returncode": 1,
                "threadId": None,
                "lastMessage": None,
            })
            state["completed"] = True
    finally:
        try:
            if os.path.exists(last_message_file):
                os.unlink(last_message_file)
        except OSError:
            pass


if __name__ == "__main__":
    main()
