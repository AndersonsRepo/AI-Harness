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

import subprocess
import sys
import os
import re
import json
import shutil
import signal
import threading
import time
import resource


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


# ─── Per-Agent Tool Policy ──────────────────────────────────────────
#
# Loaded from CODEX_TOOL_POLICY env (set by codex-config.ts). Mirrors the
# Claude --allowedTools/--disallowedTools enforcement that doesn't exist
# at the Codex CLI layer. We match `command_execution` and `mcp_tool_call`
# events; anything else (Codex built-in file/search/web) is governed by
# the sandbox flag instead and isn't visible here.


def _load_agent_tool_policy():
    """Parse the CODEX_TOOL_POLICY env var. Returns a dict with compiled
    regex patterns or None if unset / malformed."""
    raw = os.environ.get("CODEX_TOOL_POLICY")
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        sys.stderr.write(
            "[codex-runner] CODEX_TOOL_POLICY was set but not valid JSON; ignoring.\n"
        )
        return None
    if not isinstance(parsed, dict):
        return None
    mode = parsed.get("mode")
    if mode not in ("whitelist", "blacklist"):
        return None
    bash = parsed.get("bashPatterns") or []
    mcp = parsed.get("mcpPatterns") or []

    compiled_bash = []
    for entry in bash:
        if not isinstance(entry, dict):
            continue
        pid = entry.get("id") or "unknown"
        regex = entry.get("regex")
        if not isinstance(regex, str):
            continue
        flags = re.IGNORECASE if entry.get("caseInsensitive") else 0
        try:
            compiled_bash.append((pid, re.compile(regex, flags)))
        except re.error as e:
            sys.stderr.write(f"[codex-runner] Skipping invalid policy pattern {pid!r}: {e}\n")

    mcp_set = {m for m in mcp if isinstance(m, str)}
    return {"mode": mode, "bashPatterns": compiled_bash, "mcpPatterns": mcp_set}


def _classify_event(event):
    """Return ('bash', command_str) or ('mcp', tool_name) or None.

    Codex emits item.completed events for both shapes; we match them here
    so the call site doesn't need to re-derive the event taxonomy. Returns
    None for events that aren't tool calls (agent_message, turn.completed,
    etc.)."""
    if not isinstance(event, dict) or event.get("type") != "item.completed":
        return None
    item = event.get("item")
    if not isinstance(item, dict):
        return None
    item_type = str(item.get("type") or "")
    if item_type == "command_execution":
        cmd = item.get("command")
        return ("bash", cmd) if isinstance(cmd, str) else None
    if item_type == "mcp_tool_call":
        server = item.get("server") or "unknown"
        tool = item.get("tool") or "unknown"
        return ("mcp", f"mcp__{server}__{tool}")
    return None


def scan_for_policy_violation(line: str, policy):
    """Apply per-agent tool policy to one JSONL line.

    Returns (violation_id, detail) when the event is a tool call that
    violates the policy; None otherwise (including for non-tool-call
    events, malformed lines, or when policy is None).
    """
    if not policy:
        return None
    line = line.strip()
    if not line:
        return None
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        return None

    classified = _classify_event(event)
    if not classified:
        return None
    kind, value = classified
    mode = policy["mode"]

    if kind == "bash":
        matches = [pid for pid, pattern in policy["bashPatterns"] if pattern.search(value)]
        if mode == "blacklist":
            if matches:
                return (f"policy-blacklist-bash:{matches[0]}", value)
        else:  # whitelist
            if not matches:
                return ("policy-whitelist-bash:not-allowed", value)
        return None

    if kind == "mcp":
        in_set = value in policy["mcpPatterns"]
        if mode == "blacklist":
            if in_set:
                return (f"policy-blacklist-mcp:{value}", value)
        else:  # whitelist
            if not in_set:
                return (f"policy-whitelist-mcp:{value}", value)
        return None

    return None


# Flags accepted by `codex exec` but rejected by `codex exec resume`.
_EXEC_ONLY_VALUE_FLAGS = {
    "-s", "--sandbox",
    "-C", "--cd",
    "-p", "--profile",
    "--add-dir",
    "--output-schema",
    "--color",
    "--local-provider",
}
_EXEC_ONLY_BOOL_FLAGS = {"--oss"}


def _strip_exec_only_flags(args):
    out = []
    i = 0
    while i < len(args):
        a = args[i]
        if a in _EXEC_ONLY_VALUE_FLAGS:
            i += 2
            continue
        if "=" in a and a.split("=", 1)[0] in _EXEC_ONLY_VALUE_FLAGS:
            i += 1
            continue
        if a in _EXEC_ONLY_BOOL_FLAGS:
            i += 1
            continue
        out.append(a)
        i += 1
    return out


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

    # Resolution order: explicit env override → $PATH lookup → personal-machine fallback.
    # The $PATH middle step lets public-template clones work when codex is
    # installed via the standard installer (which puts it on PATH) instead of
    # the private personal-machine layout.
    codex_path = (
        os.environ.get("CODEX_CLI_PATH")
        or shutil.which("codex")
        or os.path.expanduser("~/.local/codex-cli/node_modules/.bin/codex")
    )
    cwd = os.environ.get("PROJECT_CWD", harness_root)

    # Codex needs CODEX_HOME for auth (refresh tokens). Default ~/.codex.
    clean_env = plat_env.clean_env(
        passthrough=["XDG_CONFIG_HOME", "SSH_AUTH_SOCK", "CODEX_HOME", "CODEX_RUNNER_PATH"]
    )
    if os.environ.get("CODEX_RUNNER_PATH"):
        clean_env["PATH"] = os.environ["CODEX_RUNNER_PATH"]

    # Shell default RLIMIT_FSIZE (50MB on some setups) is smaller than codex's
    # session/log writes. Mirrors ~/.local/bin/codex-mcp.sh.
    try:
        resource.setrlimit(resource.RLIMIT_FSIZE, (resource.RLIM_INFINITY, resource.RLIM_INFINITY))
    except (ValueError, OSError):
        pass

    last_message_file = output_file + ".last"

    # Compose invocation. `-` as the prompt arg tells codex to read from stdin.
    if session_id:
        # `codex exec resume` inherits sandbox/cwd/profile from the original
        # session and rejects the exec-only flags that set them. Strip them
        # from codex_args so Clap does not fail with "unexpected argument".
        resume_args = _strip_exec_only_flags(codex_args)
        invocation = [codex_path, "exec", "resume", session_id] + resume_args + ["--output-last-message", last_message_file, "-"]
    else:
        invocation = [codex_path, "exec"] + codex_args + ["--output-last-message", last_message_file, "-"]

    if prompt_file:
        try:
            with open(prompt_file, "rb") as f:
                prompt_bytes = f.read()
        except OSError as e:
            # Fall back to stdin so manual invocations still work
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
        """Scan codex --json event stream for the session/thread id.

        Codex emits events of various shapes; check common keys at top level
        and under 'msg'. Return the first match.
        """
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
        """Extract text from common Codex event payload shapes."""
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
        """Scan codex event stream for the final agent message text."""
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

    stream_counter = [0]

    if stream_dir:
        try:
            os.makedirs(stream_dir, exist_ok=True)
        except OSError:
            pass

    def write_stream_chunk(line: str):
        """Mirror each Codex JSONL stdout event into StreamPoller chunks."""
        if not stream_dir:
            return
        stripped = line.strip()
        if not stripped:
            return
        try:
            event = json.loads(stripped)
        except json.JSONDecodeError:
            return
        stream_counter[0] += 1
        chunk_path = os.path.join(stream_dir, f"chunk-{stream_counter[0]}.json")
        tmp_path = chunk_path + ".tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(event, f)
            os.rename(tmp_path, chunk_path)
        except OSError:
            try:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
            except OSError:
                pass

    safety_patterns = _load_safety_patterns()
    tool_policy = _load_agent_tool_policy()
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
            write_stream_chunk(decoded)
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

            # Per-agent tool policy. The global destructive-pattern scan is
            # the floor; this is the per-role cap (parity with Claude's
            # AGENT_TOOL_RESTRICTIONS via --allowedTools/--disallowedTools).
            policy_hit = scan_for_policy_violation(decoded, tool_policy)
            if policy_hit:
                safety_violation[0] = policy_hit
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
