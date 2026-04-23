#!/bin/bash
# Wrapper script to start the Discord bot with a clean environment
# Strips all Claude session env vars so claude CLI doesn't think it's nested

unset CLAUDECODE
unset CLAUDE_CODE_ENTRYPOINT

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd "$(dirname "$0")"
HARNESS_ROOT="${HARNESS_ROOT:-$(cd ../.. && pwd)}"
export HARNESS_ROOT
exec /opt/homebrew/bin/npx tsx bot.ts
