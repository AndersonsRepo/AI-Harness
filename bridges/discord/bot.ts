import {
  Client,
  GatewayIntentBits,
  Partials,
  Message,
  TextChannel,
} from "discord.js";
import { spawn } from "child_process";
import { config } from "dotenv";
import { getSession, setSession, clearSession } from "./session-store.js";
import { readFileSync, existsSync, unlinkSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

config();

// PID file to prevent multiple instances
const PID_FILE = join(import.meta.dirname || ".", ".bot.pid");
try {
  if (existsSync(PID_FILE)) {
    const oldPid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    try {
      process.kill(oldPid, 0); // Check if process exists
      console.error(`Bot already running (PID ${oldPid}). Exiting.`);
      process.exit(1);
    } catch {
      // Old process is dead, continue
    }
  }
  writeFileSync(PID_FILE, String(process.pid));
  process.on("exit", () => { try { unlinkSync(PID_FILE); } catch {} });
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
} catch {}


// Extract the human-readable response from Claude's JSON output
function extractResponse(output: string): string | null {
  // Try JSON.parse first
  try {
    const jsonStart = output.indexOf('{"type"');
    if (jsonStart !== -1) {
      const jsonEnd = output.lastIndexOf('}') + 1;
      const parsed = JSON.parse(output.slice(jsonStart, jsonEnd));
      if (parsed.is_error) return `Error: ${parsed.result || "Unknown error"}`;
      const text = parsed.result || parsed.text || parsed.content;
      return text ? text.trim() : null;
    }
  } catch {}

  // Fallback: regex extract the "result" field
  const match = output.match(/"result"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (match) {
    return match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').trim();
  }

  return null;
}

function extractSessionId(output: string): string | null {
  const match = output.match(/"session_id"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";
const MAX_DISCORD_LENGTH = 1900;

if (!DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN is required in .env");
  process.exit(1);
}

if (ALLOWED_USER_IDS.length === 0) {
  console.error("ALLOWED_USER_IDS is required in .env");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// Track active requests to prevent concurrent Claude processes
let activeRequest = false;
const requestQueue: Array<() => void> = [];

function processQueue(): void {
  if (activeRequest || requestQueue.length === 0) return;
  const next = requestQueue.shift();
  if (next) next();
}

// Split long messages at line boundaries, preserving code blocks
function splitMessage(text: string): string[] {
  if (text.length <= MAX_DISCORD_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let inCodeBlock = false;
  let codeBlockLang = "";

  while (remaining.length > 0) {
    if (remaining.length <= MAX_DISCORD_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Find a good split point (line boundary before the limit)
    let splitAt = remaining.lastIndexOf("\n", MAX_DISCORD_LENGTH);
    if (splitAt === -1 || splitAt < MAX_DISCORD_LENGTH * 0.5) {
      splitAt = MAX_DISCORD_LENGTH;
    }

    let chunk = remaining.slice(0, splitAt);

    // Track code block state
    const codeBlockMatches = chunk.match(/```/g);
    if (codeBlockMatches && codeBlockMatches.length % 2 !== 0) {
      // Odd number of ``` means we're splitting inside a code block
      if (!inCodeBlock) {
        // Entering a code block — find the language
        const langMatch = chunk.match(/```(\w*)\n/);
        codeBlockLang = langMatch ? langMatch[1] : "";
        inCodeBlock = true;
        chunk += "\n```";
      } else {
        inCodeBlock = false;
      }
    }

    chunks.push(chunk);

    remaining = remaining.slice(splitAt).trimStart();

    // Re-open code block in next chunk if we split inside one
    if (inCodeBlock && remaining.length > 0) {
      remaining = `\`\`\`${codeBlockLang}\n${remaining}`;
    }
  }

  return chunks;
}

// Temp directory for Claude response files
const TEMP_DIR = join(HARNESS_ROOT, "bridges", "discord", ".tmp");
try { mkdirSync(TEMP_DIR, { recursive: true }); } catch {}

async function handleClaude(message: Message, userText: string): Promise<void> {
  const channelId = message.channel.id;

  // Show typing indicator
  const channel = message.channel;
  if ("sendTyping" in channel) {
    await (channel as TextChannel).sendTyping();
  }

  // Build claude command args
  const args = ["-p", "--output-format", "json"];

  // Check for existing session to resume
  const existingSession = getSession(channelId);
  if (existingSession) {
    args.push("--resume", existingSession);
  }

  // Add the user's message
  args.push(userText);

  // Use file-based output to avoid Node.js pipe stalling bug
  // Python writes Claude's response to a temp file, we poll for it
  const outputFile = join(TEMP_DIR, `response-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

  const pythonArgs = [
    `${HARNESS_ROOT}/bridges/discord/claude-runner.py`,
    outputFile,
    ...args,
  ];

  // Spawn detached so Node.js event loop doesn't interfere
  const proc = spawn("python3", pythonArgs, {
    cwd: HARNESS_ROOT,
    env: { ...process.env, HARNESS_ROOT },
    detached: true,
    stdio: "ignore",
  });

  proc.unref();

  console.log(`[CLAUDE] Spawned detached process, output file: ${outputFile}`);

  // Poll for the output file
  const startTime = Date.now();
  const TIMEOUT = 120_000;
  const POLL_INTERVAL = 1_000;

  const poll = async (): Promise<void> => {
    // Keep typing indicator alive
    if ("sendTyping" in channel) {
      (channel as TextChannel).sendTyping().catch(() => {});
    }

    if (existsSync(outputFile)) {
      try {
        const raw = readFileSync(outputFile, "utf-8");
        unlinkSync(outputFile); // Clean up

        const result = JSON.parse(raw);
        const { stdout, stderr, returncode } = result;

        console.log(`[CLAUDE] returncode: ${returncode}, stdout length: ${(stdout || "").length}`);
        if (stderr) console.error(`[CLAUDE STDERR] ${stderr.slice(0, 500)}`);

        if (returncode !== 0) {
          const errorMsg = stderr?.trim() || `Claude exited with code ${returncode}`;
          await message.reply(
            `Something went wrong:\n\`\`\`\n${errorMsg.slice(0, 500)}\n\`\`\``
          );
        } else {
          const responseText = extractResponse(stdout);
          const sessionId = extractSessionId(stdout);

          if (sessionId) {
            setSession(channelId, sessionId);
          }

          if (responseText) {
            const chunks = splitMessage(responseText);
            for (const chunk of chunks) {
              await message.reply(chunk);
            }
          } else {
            console.error("[PARSE ERROR] Raw stdout:", stdout.slice(0, 500));
            await message.reply("Got a response but couldn't parse it. Check logs.");
          }
        }
      } catch (err: any) {
        console.error("[FILE READ ERROR]", err.message);
        await message.reply("Error reading Claude's response. Check logs.");
      }

      activeRequest = false;
      processQueue();
      return;
    }

    // Check timeout
    if (Date.now() - startTime > TIMEOUT) {
      activeRequest = false;
      await message.reply("Claude timed out after 2 minutes.");
      // Clean up output file if it appears later
      setTimeout(() => { try { unlinkSync(outputFile); } catch {} }, 5000);
      processQueue();
      return;
    }

    // Continue polling
    setTimeout(poll, POLL_INTERVAL);
  };

  setTimeout(poll, POLL_INTERVAL);
}

// --- Notification Drain ---
// Polls pending-notifications.jsonl and sends heartbeat results to Discord channels
const NOTIFY_FILE = join(HARNESS_ROOT, "heartbeat-tasks", "pending-notifications.jsonl");
const NOTIFY_POLL_MS = 60_000; // every 60 seconds

async function drainNotifications(): Promise<void> {
  try {
    if (!existsSync(NOTIFY_FILE)) return;

    const raw = readFileSync(NOTIFY_FILE, "utf-8").trim();
    if (!raw) return;

    const lines = raw.split("\n").filter(Boolean);
    const failed: string[] = [];

    for (const line of lines) {
      try {
        const notif = JSON.parse(line);
        const channelName: string = notif.channel || "general";
        const task: string = notif.task || "unknown";
        const summary: string = notif.summary || "No summary";
        const ts: string = (notif.timestamp || "").slice(0, 16);

        // Find channel by name across all guilds
        let targetChannel: TextChannel | null = null;
        for (const guild of client.guilds.cache.values()) {
          const ch = guild.channels.cache.find(
            (c) => c.name === channelName && c.isTextBased() && c.type === 0
          );
          if (ch) {
            targetChannel = ch as TextChannel;
            break;
          }
        }

        if (!targetChannel) {
          console.log(`[NOTIFY] Channel '${channelName}' not found, skipping`);
          failed.push(line);
          continue;
        }

        const message = `**Heartbeat: ${task}** (${ts})\n${summary.slice(0, 1800)}`;
        await targetChannel.send(message);
        console.log(`[NOTIFY] Sent '${task}' to #${channelName}`);
      } catch (err: any) {
        console.error(`[NOTIFY] Failed to process: ${err.message}`);
        failed.push(line);
      }
    }

    // Rewrite with only failed entries, or delete if all sent
    if (failed.length > 0) {
      writeFileSync(NOTIFY_FILE, failed.join("\n") + "\n");
    } else {
      unlinkSync(NOTIFY_FILE);
    }
  } catch (err: any) {
    // Don't crash the bot for notification errors
    if (err.code !== "ENOENT") {
      console.error(`[NOTIFY] Error: ${err.message}`);
    }
  }
}

client.on("clientReady", () => {
  console.log(`AI Harness bot online as ${client.user?.tag}`);
  console.log(`Allowed users: ${ALLOWED_USER_IDS.join(", ")}`);
  console.log(`Working directory: ${HARNESS_ROOT}`);

  // Start notification drain polling
  setInterval(drainNotifications, NOTIFY_POLL_MS);
  console.log(`[NOTIFY] Polling every ${NOTIFY_POLL_MS / 1000}s`);
});

client.on("messageCreate", async (message: Message) => {
  console.log(`[MSG] from ${message.author.tag} (${message.author.id}): "${message.content}" | bot: ${message.author.bot}`);

  // Ignore bot messages
  if (message.author.bot) return;

  // Whitelist check
  if (!ALLOWED_USER_IDS.includes(message.author.id)) {
    console.log(`[BLOCKED] User ${message.author.id} not in allowed list: ${ALLOWED_USER_IDS}`);
    return;
  }

  const content = message.content.trim();
  if (!content) return;

  // Handle commands
  if (content === "/new") {
    const cleared = clearSession(message.channel.id);
    await message.reply(
      cleared
        ? "Session cleared. Next message starts a fresh conversation."
        : "No active session in this channel."
    );
    return;
  }

  if (content === "/status") {
    const session = getSession(message.channel.id);
    await message.reply(
      session
        ? `Active session: \`${session}\``
        : "No active session in this channel."
    );
    return;
  }

  // Queue the request
  const task = () => {
    activeRequest = true;
    handleClaude(message, content).catch(async (err) => {
      activeRequest = false;
      await message.reply(`Error: ${err.message}`);
      processQueue();
    });
  };

  if (activeRequest) {
    await message.react("⏳");
    requestQueue.push(task);
  } else {
    task();
  }
});

client.login(DISCORD_TOKEN);
