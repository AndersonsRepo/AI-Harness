# Getting Started

This guide walks you through setting up your own AI Harness instance from scratch.

---

## Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| Node.js | 22+ | `node --version` |
| npm | 10+ | `npm --version` |
| Python | 3.10+ | `python3 --version` |
| Claude Code CLI | Latest | `claude --version` |
| Ollama | Latest | `ollama --version` |
| Discord Bot Token | — | [Developer Portal](https://discord.com/developers/applications) |

### Installing Claude Code CLI

```bash
# Install via npm
npm install -g @anthropic-ai/claude-code

# Authenticate
claude login
```

### Installing Ollama

```bash
# macOS
brew install ollama

# Start the server
ollama serve

# Pull the embedding model
ollama pull nomic-embed-text
```

---

## Step 1: Clone and Install

```bash
git clone https://github.com/AndersonsRepo/AI-Harness.git
cd AI-Harness

# Set your HARNESS_ROOT (add to ~/.zshrc or ~/.bashrc)
export HARNESS_ROOT="$(pwd)"
```

### Discord Bridge

```bash
cd bridges/discord
npm install
```

### MCP Servers

```bash
# Vault server (knowledge CRUD + semantic search)
cd ../../mcp-servers/mcp-vault
npm install
npx tsc

# Harness server (infrastructure observability)
cd ../mcp-harness
npm install
npx tsc
```

---

## Step 2: Configure Discord Bot

### Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" → name it "AI Harness" (or whatever you prefer)
3. Go to **Bot** → click "Add Bot"
4. Enable these **Privileged Gateway Intents**:
   - Message Content Intent
   - Server Members Intent
   - Presence Intent
5. Copy the **Bot Token**

### Invite to Your Server

1. Go to **OAuth2** → **URL Generator**
2. Select scopes: `bot`, `applications.commands`
3. Select permissions: `Send Messages`, `Read Message History`, `Manage Messages`, `Embed Links`, `Attach Files`, `Add Reactions`
4. Copy the generated URL and open it to invite the bot

### Configure Environment

```bash
cd bridges/discord
cp .env.example .env
```

Edit `.env`:

```bash
DISCORD_TOKEN=your-bot-token-here
ALLOWED_USER_IDS=your-discord-user-id
HARNESS_ROOT=/absolute/path/to/AI-Harness

# Optional: channel for agent activity stream
# STREAM_CHANNEL_ID=your-channel-id
```

**Finding your Discord user ID**: Enable Developer Mode in Discord settings → right-click your username → "Copy User ID".

---

## Step 3: Configure MCP Server

Add the vault MCP server to your Claude Code config:

**`~/.claude/Config/mcp-config.json`**:

```json
{
  "mcpServers": {
    "vault": {
      "command": "node",
      "args": ["/absolute/path/to/AI-Harness/mcp-servers/mcp-vault/dist/index.js"],
      "env": {
        "HARNESS_ROOT": "/absolute/path/to/AI-Harness"
      }
    }
  }
}
```

---

## Step 4: Initialize the Vault

The vault is created automatically on first run, but you can seed it:

```bash
# Create vault directories
mkdir -p vault/{learnings,shared/project-knowledge,shared/scouted,agents,daily}

# Verify Ollama is running and model is available
curl -s http://localhost:11434/api/tags | python3 -c "import sys,json; tags=json.load(sys.stdin); print([m['name'] for m in tags.get('models',[])])"
# Should include 'nomic-embed-text:latest'
```

---

## Step 5: Start the Bot

```bash
cd bridges/discord
HARNESS_ROOT=/absolute/path/to/AI-Harness npx tsx bot.ts
```

You should see:

```
[BOT] Logged in as AI Harness#1234
[BOT] PID file written: .bot.pid
[embeddings] Sync complete: +0 ~0 -0 (0 total)
[EMBEDDINGS] Watching: learnings/
[EMBEDDINGS] Watching: shared/
```

### Running as a Background Service (macOS)

For persistent operation, use a launchd plist:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.aiharness.discord-bot</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/npx</string>
        <string>tsx</string>
        <string>/path/to/AI-Harness/bridges/discord/bot.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/AI-Harness</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HARNESS_ROOT</key>
        <string>/path/to/AI-Harness</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>/Users/yourusername</string>
    </dict>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

Save to `~/Library/LaunchAgents/com.aiharness.discord-bot.plist`, then:

```bash
launchctl load ~/Library/LaunchAgents/com.aiharness.discord-bot.plist
```

> **macOS TCC Note**: launchd-spawned processes can't access `~/Desktop`, `~/Documents`, etc. due to TCC restrictions. Create a symlink from a TCC-exempt location: `ln -s ~/Desktop/AI-Harness ~/.local/ai-harness` and use the symlink path in your plist.

---

## Step 6: Set Up Heartbeat Tasks (Optional)

Heartbeat tasks are background jobs that run on a schedule via macOS launchd.

### Loading Tasks

Each task needs a LaunchAgent plist. The format follows the bot plist pattern, with `StartInterval` instead of `KeepAlive`:

```bash
# Load all heartbeat tasks
for plist in ~/Library/LaunchAgents/com.aiharness.heartbeat.*.plist; do
  launchctl load "$plist" 2>/dev/null
done

# Verify they're loaded
launchctl list | grep com.aiharness
```

### Creating Custom Tasks

1. Define the task in `heartbeat-tasks/<name>.json`:

```json
{
  "name": "my-task",
  "description": "What this task does",
  "type": "script",
  "script": "my-task.py",
  "schedule": "30m",
  "enabled": true,
  "notify": "discord",
  "discord_channel": "notifications",
  "timeout": 60
}
```

2. Write the implementation in `heartbeat-tasks/scripts/my-task.py`
3. Create a LaunchAgent plist (use `/heartbeat create my-task` for auto-generation)

---

## Step 7: Verify Everything Works

### Quick Health Check

Send a message in Discord to your bot. You should get a response within 10-30 seconds.

### Full System Check

In Claude Code (not Discord), run:

```
/health-report
```

This checks: bot process, database, heartbeat tasks, vault consistency, and truncation stats.

### Test the Learning Loop

1. Tell the bot something: "The API endpoint is at api.example.com/v2"
2. Check `vault/learnings/` for a new `LRN-*.md` file
3. Check `vault/vault-embeddings.json` for the new embedding
4. The next time you ask about the API, the context daemon should inject this knowledge

---

## Troubleshooting

### Bot Won't Start

**"Cannot open database"**: `HARNESS_ROOT` is not set or points to the wrong directory. The database lives at `$HARNESS_ROOT/bridges/discord/harness.db`.

**"Address already in use"**: Another bot instance is running. Check `.bot.pid` and kill the old process.

**"Cannot be launched inside another Claude Code session"**: The `CLAUDECODE` or `CLAUDE_CODE_ENTRYPOINT` environment variables are set. The bot must run outside of Claude Code, or `claude-runner.py` must strip these (it does by default).

### No Response from Bot

1. Check the bot is running: `ps aux | grep bot.ts`
2. Check logs: `tail -f /tmp/aiharness-bot.log` (or your configured log path)
3. Verify your Discord user ID is in `ALLOWED_USER_IDS`
4. Check Claude CLI is authenticated: `claude --version`

### Embeddings Not Working

1. Verify Ollama is running: `curl http://localhost:11434/api/tags`
2. Verify model is pulled: should include `nomic-embed-text`
3. Check the embedding store: `cat vault/vault-embeddings.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{len(d)} entries')"`

### Heartbeat Tasks Not Running

```bash
# Check if loaded
launchctl list | grep com.aiharness.heartbeat

# Check logs
tail heartbeat-tasks/logs/<task-name>.log

# Manual test run
HARNESS_ROOT=/path/to/AI-Harness python3 heartbeat-tasks/scripts/<task-name>.py
```

---

## Next Steps

- Read [Self-Improvement Loop](./SELF-IMPROVEMENT.md) to understand how the learning system works
- Read [Skills & Agents](./SKILLS-AND-AGENTS.md) to extend the system
- Use `/find-skill` to discover what's available
- Use `/health-report` to monitor system health
