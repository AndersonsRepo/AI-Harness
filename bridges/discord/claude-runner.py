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

    def write_result(data):
        """Atomic write: write to .tmp then rename to avoid partial reads."""
        tmp = output_file + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.rename(tmp, output_file)

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

            chunk_num = 0
            all_stdout = []

            def read_stderr(p, container):
                container.append(p.stderr.read())

            stderr_container = []
            stderr_thread = threading.Thread(target=read_stderr, args=(proc, stderr_container))
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

            if timed_out[0]:
                write_result({
                    "stdout": "\n".join(all_stdout),
                    "stderr": f"Claude timed out after {timeout} seconds (streaming)",
                    "returncode": 1,
                })
            else:
                # Write final aggregated result (backward compat)
                write_result({
                    "stdout": "\n".join(all_stdout),
                    "stderr": stderr_text,
                    "returncode": proc.returncode if proc.returncode is not None else 1,
                })

        except subprocess.TimeoutExpired:
            proc.kill()
            write_result({"stdout": "", "stderr": f"Claude timed out after {timeout} seconds", "returncode": 1})
        except Exception as e:
            write_result({"stdout": "", "stderr": str(e), "returncode": 1})

    else:
        # Non-streaming mode: with retry on transient errors (429, 5xx, network)
        max_retries = 3
        backoff_delays = [5, 15, 45]  # seconds

        for attempt in range(max_retries + 1):
            try:
                result = subprocess.run(
                    [claude_path] + claude_args,
                    capture_output=True,
                    text=True,
                    stdin=subprocess.DEVNULL,
                    env=clean_env,
                    timeout=timeout,
                    cwd=cwd,
                )

                # Check for transient errors worth retrying
                is_transient = False
                if result.returncode != 0 and attempt < max_retries:
                    stderr_lower = (result.stderr or "").lower()
                    if any(s in stderr_lower for s in ["429", "rate limit", "503", "502", "500", "overloaded", "connection", "econnreset", "timeout"]):
                        is_transient = True

                if is_transient:
                    delay = backoff_delays[attempt]
                    sys.stderr.write(f"[claude-runner] Transient error (attempt {attempt + 1}/{max_retries + 1}), retrying in {delay}s: {result.stderr[:100]}\n")
                    time.sleep(delay)
                    continue

                write_result({
                    "stdout": result.stdout or "",
                    "stderr": result.stderr or "",
                    "returncode": result.returncode,
                })
                break

            except subprocess.TimeoutExpired:
                if attempt < max_retries:
                    delay = backoff_delays[attempt]
                    sys.stderr.write(f"[claude-runner] Timeout (attempt {attempt + 1}/{max_retries + 1}), retrying in {delay}s\n")
                    time.sleep(delay)
                    continue
                write_result({"stdout": "", "stderr": f"Claude timed out after {timeout} seconds ({max_retries + 1} attempts)", "returncode": 1})
                break
            except Exception as e:
                write_result({"stdout": "", "stderr": str(e), "returncode": 1})
                break

if __name__ == "__main__":
    main()
