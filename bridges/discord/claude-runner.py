#!/usr/bin/env python3
"""Runs claude CLI with a clean environment, writing output to a file.
Workaround for nested session detection and Node.js spawn stalling.
See: https://github.com/anthropics/claude-code/issues/771

Usage: python3 claude-runner.py <output_file> [--timeout <seconds>] [--stream-dir <path>] [claude args...]
Output is written to <output_file> instead of stdout to avoid
Node.js pipe stalling when this is spawned from a Node.js parent.

Options:
  --timeout <seconds>   Override default 120s timeout
  --stream-dir <path>   Write stream-json events as numbered chunk files"""

import subprocess
import sys
import os
import json
import signal
import threading
import time

def main():
    args = sys.argv[1:]
    if len(args) < 2:
        print(json.dumps({"error": "Usage: claude-runner.py <output_file> [--timeout N] [--stream-dir path] [claude args...]"}))
        sys.exit(1)

    output_file = args[0]
    remaining = args[1:]

    # Parse our own flags before passing the rest to claude
    timeout = 1800
    stream_dir = None

    while remaining:
        if remaining[0] == "--timeout" and len(remaining) > 1:
            timeout = int(remaining[1])
            remaining = remaining[2:]
        elif remaining[0] == "--stream-dir" and len(remaining) > 1:
            stream_dir = remaining[1]
            remaining = remaining[2:]
        else:
            break

    claude_args = remaining

    harness_root = os.environ.get("HARNESS_ROOT", os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

    # Import platform module for cross-platform path/env resolution
    sys.path.insert(0, os.path.join(harness_root, "heartbeat-tasks"))
    from lib.platform import paths, env as plat_env

    claude_path = paths.claude_cli()
    # PROJECT_CWD allows spawning Claude in a project's directory instead of HARNESS_ROOT
    cwd = os.environ.get("PROJECT_CWD", harness_root)

    clean_env = plat_env.clean_env(passthrough=["XDG_CONFIG_HOME", "SSH_AUTH_SOCK", "CLAUDE_RUNNER_PATH"])
    # Allow explicit PATH override for backwards compat
    if os.environ.get("CLAUDE_RUNNER_PATH"):
        clean_env["PATH"] = os.environ["CLAUDE_RUNNER_PATH"]

    # State tracked across signal-handler boundary. Closure captures these
    # nonlocal so the handler can observe whether we've already written a
    # final result (avoid clobbering a successful run with a cancel envelope)
    # and which Popen child is in flight (so we can terminate it).
    state = {
        "active_proc": None,   # current subprocess.Popen, or None between attempts
        "completed": False,    # True once write_result has been called with final result
        "cancelled": False,    # True once a SIGTERM/SIGINT was received
    }

    def write_result(data):
        """Atomic write: write to .tmp then rename to avoid partial reads."""
        tmp = output_file + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.rename(tmp, output_file)

    def handle_cancel_signal(signum, _frame):
        """SIGTERM/SIGINT handler.

        Behavior:
          - Mark the run as cancelled so retry loops don't fire next attempt.
          - Terminate the in-flight Popen child if any (best-effort).
          - If write_result hasn't been called yet, write a cancellation
            envelope so the Node-side FileWatcher sees a final result and
            doesn't time out waiting for the .tmp → rename atomic write.
            If write_result HAS been called with a successful result, do
            not overwrite it — cancellation can't undo work already done.
          - Exit 128 + signum (POSIX convention: 143 for SIGTERM).
        """
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
                    "cancelled": True,
                })
                state["completed"] = True
            except Exception:
                # Last-resort: don't propagate write failures from the handler.
                pass
        # os._exit (not sys.exit) so we don't block on pending stdio reads,
        # background threads, or finally-block cleanup. Signal cancellation
        # is abnormal shutdown — emergency exit is the right tool.
        os._exit(128 + signum)

    signal.signal(signal.SIGTERM, handle_cancel_signal)
    signal.signal(signal.SIGINT, handle_cancel_signal)

    if stream_dir:
        # Streaming mode: run with stream-json output, write chunks to files
        os.makedirs(stream_dir, exist_ok=True)

        # Replace --output-format json with stream-json for streaming
        # Claude CLI requires --verbose with stream-json in --print mode
        streaming_args = ["--verbose"]
        i = 0
        while i < len(claude_args):
            if claude_args[i] == "--output-format" and i + 1 < len(claude_args):
                streaming_args.append("--output-format")
                streaming_args.append("stream-json")
                i += 2
            else:
                streaming_args.append(claude_args[i])
                i += 1

        try:
            proc = subprocess.Popen(
                [claude_path] + streaming_args,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL,
                env=clean_env,
                cwd=cwd,
            )
            state["active_proc"] = proc

            chunk_num = 0
            all_stdout = []

            def read_stderr(p, container):
                container.append(p.stderr.read())

            stderr_container = []
            stderr_thread = threading.Thread(target=read_stderr, args=(proc, stderr_container))
            stderr_thread.daemon = True  # don't block sys.exit() in signal handler
            stderr_thread.start()

            # Enforce timeout on streaming stdout reads via a watchdog thread.
            # Timer resets on each stdout line so active-but-slow streams aren't killed.
            timed_out = [False]
            def watchdog():
                timed_out[0] = True
                try:
                    proc.kill()
                except OSError:
                    pass

            timer = threading.Timer(timeout, watchdog)
            timer.daemon = True  # don't block sys.exit() in signal handler
            timer.start()

            try:
                for line in proc.stdout:
                    decoded = line.decode("utf-8", errors="replace").strip()
                    if not decoded:
                        continue
                    all_stdout.append(decoded)

                    # Reset watchdog on each output line (active stream = not stalled)
                    timer.cancel()
                    timer = threading.Timer(timeout, watchdog)
                    timer.daemon = True
                    timer.start()

                    # Write chunk file for the stream poller
                    try:
                        chunk_file = os.path.join(stream_dir, f"chunk-{chunk_num:04d}.json")
                        parsed = json.loads(decoded)
                        with open(chunk_file, "w") as f:
                            json.dump(parsed, f)
                        chunk_num += 1
                    except (json.JSONDecodeError, IOError):
                        pass
            finally:
                timer.cancel()

            proc.wait(timeout=30)
            stderr_thread.join(timeout=5)
            stderr_text = stderr_container[0].decode("utf-8", errors="replace") if stderr_container else ""

            state["active_proc"] = None
            if timed_out[0]:
                write_result({
                    "stdout": "\n".join(all_stdout),
                    "stderr": f"Claude timed out after {timeout} seconds (streaming)",
                    "returncode": 1,
                })
                state["completed"] = True
            else:
                # Write final aggregated result (backward compat)
                write_result({
                    "stdout": "\n".join(all_stdout),
                    "stderr": stderr_text,
                    "returncode": proc.returncode if proc.returncode is not None else 1,
                })
                state["completed"] = True

        except subprocess.TimeoutExpired:
            proc.kill()
            state["active_proc"] = None
            write_result({"stdout": "", "stderr": f"Claude timed out after {timeout} seconds", "returncode": 1})
            state["completed"] = True
        except Exception as e:
            state["active_proc"] = None
            write_result({"stdout": "", "stderr": str(e), "returncode": 1})
            state["completed"] = True

    else:
        # Non-streaming mode: with retry on transient errors (429, 5xx, network).
        # Uses Popen + .communicate() rather than subprocess.run() so a
        # module-level reference to the in-flight process is available
        # for signal-handler-driven cancellation (see _active_proc below;
        # phase-B follow-up).
        max_retries = 3
        backoff_delays = [5, 15, 45]  # seconds

        for attempt in range(max_retries + 1):
            if state["cancelled"]:
                # Signal handler already wrote a cancellation envelope and
                # called sys.exit, but defense-in-depth in case we're
                # somehow re-entered via a non-handler path.
                break
            try:
                proc = subprocess.Popen(
                    [claude_path] + claude_args,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=clean_env,
                    cwd=cwd,
                    text=True,
                )
                state["active_proc"] = proc

                try:
                    stdout, stderr = proc.communicate(timeout=timeout)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    # Drain pipes after kill so file descriptors close cleanly.
                    try:
                        proc.communicate(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass
                    state["active_proc"] = None
                    raise

                state["active_proc"] = None
                returncode = proc.returncode

                # Check for transient errors worth retrying
                is_transient = False
                if returncode != 0 and attempt < max_retries:
                    stderr_lower = (stderr or "").lower()
                    if any(s in stderr_lower for s in ["429", "rate limit", "503", "502", "500", "overloaded", "connection", "econnreset", "timeout"]):
                        is_transient = True

                if is_transient:
                    delay = backoff_delays[attempt]
                    sys.stderr.write(f"[claude-runner] Transient error (attempt {attempt + 1}/{max_retries + 1}), retrying in {delay}s: {stderr[:100]}\n")
                    time.sleep(delay)
                    if state["cancelled"]:
                        break
                    continue

                write_result({
                    "stdout": stdout or "",
                    "stderr": stderr or "",
                    "returncode": returncode,
                })
                state["completed"] = True
                break

            except subprocess.TimeoutExpired:
                if attempt < max_retries:
                    delay = backoff_delays[attempt]
                    sys.stderr.write(f"[claude-runner] Timeout (attempt {attempt + 1}/{max_retries + 1}), retrying in {delay}s\n")
                    time.sleep(delay)
                    if state["cancelled"]:
                        break
                    continue
                write_result({"stdout": "", "stderr": f"Claude timed out after {timeout} seconds ({max_retries + 1} attempts)", "returncode": 1})
                state["completed"] = True
                break
            except Exception as e:
                state["active_proc"] = None
                write_result({"stdout": "", "stderr": str(e), "returncode": 1})
                state["completed"] = True
                break

if __name__ == "__main__":
    main()
