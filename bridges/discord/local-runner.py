#!/usr/bin/env python3
"""Runs a local Ollama chat completion, writing output to a file.

The third runtime (Phase H of the runtime-abstraction plan). Parallel to
claude-runner.py / codex-runner.py, producing the SAME output-file JSON
contract so task-runner.ts dispatches to it with a single switch — but it is
not a CLI; it POSTs to a local OpenAI-style endpoint (Ollama).

Usage:
  local-runner.py <output_file> [--timeout N] [--stream-dir PATH]
                  --payload-file <path>

The payload file is JSON written by the ollama adapter:
  {"system": <str>, "user": <str>, "model": <str>, "endpoint": <str>}

Output file shape (matches claude/codex runners):
  {"stdout": <reply text>, "stderr": <err>, "returncode": N,
   "lastMessage": <reply text or null>, "model": <model>}

The model is downloaded out of band (`ollama pull <model>`). Until then this
runner exits non-zero with a clear stderr (connection refused / model not
found) rather than hanging — so an opt-in local spawn fails loudly, never
silently.
"""

import json
import os
import resource
import sys
import urllib.error
import urllib.request


def _raise_fsize_limit():
    """Defensive: lift any inherited RLIMIT_FSIZE so a long reply can't EFBIG."""
    try:
        resource.setrlimit(resource.RLIMIT_FSIZE, (resource.RLIM_INFINITY, resource.RLIM_INFINITY))
    except (ValueError, OSError):
        pass


def _parse_args(argv):
    out = {"output_file": None, "timeout": 300, "payload_file": None, "stream_dir": None}
    if not argv:
        raise SystemExit("local-runner.py: <output_file> required")
    out["output_file"] = argv[0]
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == "--timeout":
            out["timeout"] = int(argv[i + 1]); i += 2
        elif a == "--payload-file":
            out["payload_file"] = argv[i + 1]; i += 2
        elif a == "--stream-dir":
            out["stream_dir"] = argv[i + 1]; i += 2  # accepted for parity; unused
        else:
            i += 1
    if not out["payload_file"]:
        raise SystemExit("local-runner.py: --payload-file required")
    return out


def _write_envelope(output_file, envelope):
    """Atomic write: .tmp then rename (FileWatcher detects the final file)."""
    tmp = output_file + ".tmp"
    with open(tmp, "w") as f:
        json.dump(envelope, f)
    os.rename(tmp, output_file)


def main():
    _raise_fsize_limit()
    args = _parse_args(sys.argv[1:])

    try:
        with open(args["payload_file"]) as f:
            payload = json.load(f)
    except (IOError, ValueError) as e:
        _write_envelope(args["output_file"], {
            "stdout": "", "stderr": f"payload file unreadable: {e}",
            "returncode": 2, "lastMessage": None, "model": None,
        })
        return

    model = payload.get("model") or "qwen3:8b"
    endpoint = (payload.get("endpoint") or "http://localhost:11434").rstrip("/")

    messages = []
    if payload.get("system"):
        messages.append({"role": "system", "content": payload["system"]})
    messages.append({"role": "user", "content": payload.get("user", "")})

    body = json.dumps({"model": model, "messages": messages, "stream": False}).encode("utf-8")
    req = urllib.request.Request(
        f"{endpoint}/api/chat", data=body,
        headers={"Content-Type": "application/json"}, method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=args["timeout"]) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        content = (data.get("message") or {}).get("content", "")
        _write_envelope(args["output_file"], {
            "stdout": content, "stderr": "", "returncode": 0,
            "lastMessage": content, "model": model,
        })
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8")[:300]
        except Exception:
            pass
        # 404 → model not pulled. Make that actionable.
        hint = f" — run `ollama pull {model}`" if e.code == 404 else ""
        _write_envelope(args["output_file"], {
            "stdout": "", "stderr": f"Ollama HTTP {e.code}{hint}: {detail}",
            "returncode": 1, "lastMessage": None, "model": model,
        })
    except urllib.error.URLError as e:
        _write_envelope(args["output_file"], {
            "stdout": "",
            "stderr": f"Ollama unreachable at {endpoint} ({e.reason}). Is `ollama serve` running?",
            "returncode": 1, "lastMessage": None, "model": model,
        })
    except Exception as e:  # noqa: BLE001 — never leave the watcher hanging
        _write_envelope(args["output_file"], {
            "stdout": "", "stderr": f"local-runner error: {e}",
            "returncode": 1, "lastMessage": None, "model": model,
        })


if __name__ == "__main__":
    main()
