#!/bin/bash
# Wrapper script to start the Discord bot with a clean environment
# Strips all Claude session env vars so claude CLI doesn't think it's nested

unset CLAUDECODE
unset CLAUDE_CODE_ENTRYPOINT

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

cd $HOME/Desktop/AI-Harness/bridges/discord
exec /opt/homebrew/bin/npx tsx bot.ts
