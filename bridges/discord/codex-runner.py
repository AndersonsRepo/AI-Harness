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
import resource
import subprocess
import sys
import threading


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

    try:
        if stream_dir:
            try:
                os.makedirs(stream_dir, exist_ok=True)
            except OSError:
                pass

        proc = subprocess.Popen(
            invocation,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=clean_env,
            cwd=cwd,
        )

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
            proc.stdin.write(prompt_bytes)
            proc.stdin.close()
        except BrokenPipeError:
            pass

        stdout_chunks = []
        for line in proc.stdout:
            stdout_chunks.append(line.decode("utf-8", errors="replace"))
            timer.cancel()
            timer = threading.Timer(timeout, watchdog)
            timer.start()

        timer.cancel()
        proc.wait(timeout=30)

        stderr_text = (proc.stderr.read() or b"").decode("utf-8", errors="replace")
        stdout_text = "".join(stdout_chunks)

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

        if timed_out[0]:
            write_result({
                "stdout": stdout_text,
                "stderr": (stderr_text + f"\nCodex timed out after {timeout} seconds").strip(),
                "returncode": 1,
                "threadId": thread_id,
                "lastMessage": last_message,
            })
        else:
            write_result({
                "stdout": stdout_text,
                "stderr": stderr_text,
                "returncode": proc.returncode if proc.returncode is not None else 1,
                "threadId": thread_id,
                "lastMessage": last_message,
            })

    except Exception as e:
        write_result({
            "stdout": "",
            "stderr": str(e),
            "returncode": 1,
            "threadId": None,
            "lastMessage": None,
        })
    finally:
        try:
            if os.path.exists(last_message_file):
                os.unlink(last_message_file)
        except OSError:
            pass


if __name__ == "__main__":
    main()
