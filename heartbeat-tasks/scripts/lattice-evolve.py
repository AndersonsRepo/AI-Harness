#!/usr/bin/env python3
"""Run one Lattice evolution generation."""

import subprocess
import os
import sys

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
LATTICE_DIR = os.path.join(HARNESS_ROOT, "projects", "lattice")
TSX_PATH = "/opt/homebrew/bin/npx"


def main():
    try:
        result = subprocess.run(
            [TSX_PATH, "tsx", "src/evolve.ts"],
            capture_output=True,
            text=True,
            timeout=60,
            cwd=LATTICE_DIR,
            env={
                **os.environ,
                "HARNESS_ROOT": HARNESS_ROOT,
            },
        )
        print(result.stdout)
        if result.stderr:
            print(result.stderr, file=sys.stderr)
        if result.returncode != 0:
            print(f"Exit code: {result.returncode}", file=sys.stderr)
            sys.exit(1)
    except subprocess.TimeoutExpired:
        print("Evolution timed out after 60s", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
