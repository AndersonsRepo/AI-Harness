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

config();

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

  return new Promise((resolve) => {
    const proc = spawn("claude", args, {
      cwd: HARNESS_ROOT,
      env: { ...process.env, TERM: "dumb" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      // Re-send typing indicator every 5s for long operations
      if ("sendTyping" in channel) {
        (channel as TextChannel).sendTyping().catch(() => {});
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", async (code) => {
      activeRequest = false;

      if (code !== 0 || !stdout.trim()) {
        const errorMsg = stderr.trim() || `Claude exited with code ${code}`;
        await message.reply(
          `Something went wrong:\n\`\`\`\n${errorMsg.slice(0, 500)}\n\`\`\``
        );
        resolve();
        processQueue();
        return;
      }

      try {
        const result = JSON.parse(stdout);

        // Extract session ID for future --resume
        if (result.session_id) {
          setSession(channelId, result.session_id);
        }

        // Extract the response text
        let responseText =
          result.result ||
          result.text ||
          result.content ||
          "No response from Claude.";

        // Send response, splitting if needed
        const chunks = splitMessage(responseText);
        for (const chunk of chunks) {
          await message.reply(chunk);
        }
      } catch {
        // If JSON parsing fails, send raw output
        const chunks = splitMessage(stdout);
        for (const chunk of chunks) {
          await message.reply(chunk);
        }
      }

      resolve();
      processQueue();
    });

    proc.on("error", async (err) => {
      activeRequest = false;
      await message.reply(
        `Failed to start Claude: ${err.message}\n\nIs \`claude\` installed and in your PATH?`
      );
      resolve();
      processQueue();
    });
  });
}

client.on("clientReady", () => {
  console.log(`AI Harness bot online as ${client.user?.tag}`);
  console.log(`Allowed users: ${ALLOWED_USER_IDS.join(", ")}`);
  console.log(`Working directory: ${HARNESS_ROOT}`);
});

client.on("messageCreate", async (message: Message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  // Whitelist check
  if (!ALLOWED_USER_IDS.includes(message.author.id)) return;

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
