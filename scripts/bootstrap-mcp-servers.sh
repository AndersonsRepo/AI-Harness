#!/bin/bash
# Builds every MCP server in mcp-servers/. Run this after creating a fresh
# worktree, after pulling changes that touch MCP server source, or any time
# `claude mcp list` shows a local server as ✗ Failed to connect.
#
# Usage:
#   ./scripts/bootstrap-mcp-servers.sh [--check]
#
# --check    only report which servers need rebuilding; no install or build.
#            Exits 0 if all servers are built, 1 if any are missing.
#
# Background:
# `~/.claude.json` registers each local MCP server as
# `node <repo>/mcp-servers/<name>/dist/index.js`. When a fresh worktree is
# created, `index.ts` is present but `node_modules/` and `dist/` aren't —
# the servers silently fail at session init and Claude logs `"failed"` in
# the init JSON without surfacing it. See
# vault/learnings/ERR-mcp-servers-not-built-after-worktree-creation-2026-04-25.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVERS_DIR="$REPO_ROOT/mcp-servers"

if [ ! -d "$SERVERS_DIR" ]; then
  echo "ERROR: $SERVERS_DIR does not exist"
  exit 1
fi

CHECK_ONLY=0
if [ "${1:-}" = "--check" ]; then
  CHECK_ONLY=1
fi

needs_build=()
built=()
for server_dir in "$SERVERS_DIR"/*/; do
  name="$(basename "$server_dir")"
  # Only consider directories that look like MCP server packages.
  if [ ! -f "$server_dir/package.json" ] || [ ! -f "$server_dir/index.ts" ]; then
    continue
  fi
  if [ -f "$server_dir/dist/index.js" ]; then
    built+=("$name")
  else
    needs_build+=("$name")
  fi
done

if [ "$CHECK_ONLY" = "1" ]; then
  echo "MCP servers built: ${#built[@]}"
  for n in "${built[@]}"; do echo "  ✓ $n"; done
  if [ "${#needs_build[@]}" -gt 0 ]; then
    echo "MCP servers MISSING dist/index.js: ${#needs_build[@]}"
    for n in "${needs_build[@]}"; do echo "  ✗ $n"; done
    exit 1
  fi
  echo "All MCP servers built."
  exit 0
fi

if [ "${#needs_build[@]}" -eq 0 ]; then
  echo "All MCP servers already built. Nothing to do."
  echo "(Pass --check to verify without rebuilding, or delete dist/ to force.)"
  exit 0
fi

echo "Building ${#needs_build[@]} MCP server(s): ${needs_build[*]}"
echo

for name in "${needs_build[@]}"; do
  server_dir="$SERVERS_DIR/$name"
  echo "=== $name ==="

  if [ ! -d "$server_dir/node_modules" ]; then
    echo "  installing deps..."
    (cd "$server_dir" && npm install --silent 2>&1 | tail -3)
  fi

  echo "  building..."
  (cd "$server_dir" && npm run build 2>&1 | tail -3)

  if [ ! -f "$server_dir/dist/index.js" ]; then
    echo "  ERROR: build did not produce dist/index.js"
    exit 1
  fi
  size=$(stat -f '%z' "$server_dir/dist/index.js" 2>/dev/null || stat -c '%s' "$server_dir/dist/index.js")
  echo "  ✓ dist/index.js ($size bytes)"
  echo
done

echo "Done. Run 'claude mcp list' to confirm all servers report ✓ Connected."
