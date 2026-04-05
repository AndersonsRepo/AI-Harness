#!/usr/bin/env python3
"""Hook: FileChanged (matcher: vault/**/*.md)
Triggers a single-file embedding re-sync when a vault file is written.
Keeps the embedding index fresh during interactive CLI sessions without
needing a full vault scan.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
HARNESS_ROOT = Path(os.environ.get("HARNESS_ROOT", SCRIPT_DIR.parent.parent.parent))


def main():
    # $FILE_PATH passed as argv[1]
    file_path = sys.argv[1] if len(sys.argv) > 1 else None
    if not file_path:
        sys.exit(0)

    fp = Path(file_path)
    if not fp.exists() or not fp.suffix == ".md":
        sys.exit(0)

    # Only act on vault files
    vault_dir = HARNESS_ROOT / "vault"
    try:
        fp.resolve().relative_to(vault_dir.resolve())
    except ValueError:
        sys.exit(0)

    # Check if Ollama is running (needed for embeddings)
    try:
        result = subprocess.run(
            ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "http://localhost:11434/api/tags"],
            capture_output=True, text=True, timeout=3
        )
        if result.stdout.strip() != "200":
            sys.exit(0)
    except Exception:
        sys.exit(0)

    # Write a marker file that the vault MCP server checks on next search
    dirty_dir = vault_dir / ".embedding-dirty"
    dirty_dir.mkdir(exist_ok=True)
    marker = dirty_dir / fp.name
    marker.write_text(str(fp.resolve()))

    print(json.dumps({"suppressOutput": True}))


if __name__ == "__main__":
    main()
