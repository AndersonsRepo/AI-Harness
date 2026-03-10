import {
  Client,
  GatewayIntentBits,
  Partials,
  Message,
  TextChannel,
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";
import { spawn } from "child_process";
import { config } from "dotenv";
import { getSession, setSession, clearSession, validateSession } from "./session-store.js";
import {
  getChannelConfig,
  setChannelConfig,
  clearChannelConfig,
  listConfigs,
} from "./channel-config-store.js";
import {
  spawnSubagent,
  startPolling as startSubagentPolling,
  cancelSubagent,
  onSubagentComplete,
} from "./subagent-manager.js";
import { getRunning, getByChannel, cleanupStale } from "./process-registry.js";
import {
  initActivityStream,
  postAgentStart,
  postAgentComplete,
  postAgentError,
  type AgentActivity,
} from "./activity-stream.js";
import { StreamPoller } from "./stream-poller.js";
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
  closeProject,
  isProjectChannel,
  resetHandoffDepth,
  autoAdoptIfInCategory,
  adoptChannel,
  getProjectsCategoryName,
} from "./project-manager.js";
import {
  parseHandoff,
  parseCreateChannel,
  runHandoffChain,
  getProjectSessionKey,
} from "./handoff-router.js";
import {
  readFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
} from "fs";
import { join } from "path";

config();

// PID file to prevent multiple instances
const PID_FILE = join(import.meta.dirname || ".", ".bot.pid");
try {
  if (existsSync(PID_FILE)) {
    const oldPid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    try {
      process.kill(oldPid, 0);
      console.error(`Bot already running (PID ${oldPid}). Exiting.`);
      process.exit(1);
    } catch {
      // Old process is dead, continue
    }
  }
  writeFileSync(PID_FILE, String(process.pid));
  process.on("exit", () => {
    try {
      unlinkSync(PID_FILE);
    } catch {}
  });
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
} catch {}

// Extract the human-readable response from Claude's JSON output
function extractResponse(output: string): string | null {
  try {
    const jsonStart = output.indexOf('{"type"');
    if (jsonStart !== -1) {
      const jsonEnd = output.lastIndexOf("}") + 1;
      const parsed = JSON.parse(output.slice(jsonStart, jsonEnd));
      if (parsed.is_error) return `Error: ${parsed.result || "Unknown error"}`;
      const text = parsed.result || parsed.text || parsed.content;
      return text ? text.trim() : null;
    }
  } catch {}

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
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_PROCESSES || "5", 10);

// Global safety guardrails for all Claude invocations
const GLOBAL_DISALLOWED_TOOLS = [
  "Bash(rm -rf:*)",
  "Bash(git push --force:*)",
  "Bash(git reset --hard:*)",
  "Bash(DROP:*)",
  "Bash(DELETE FROM:*)",
  "Bash(kill -9:*)",
].join(",");

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

// --- Per-Channel Queue System ---
interface QueuedTask {
  execute: () => void;
  message: Message;
}

const channelQueues: Map<string, QueuedTask[]> = new Map();
const activeChannels: Set<string> = new Set();
const activeProcesses: Map<string, number> = new Map(); // channelId → PID
let globalRunningCount = 0;

function processChannelQueue(channelId: string): void {
  if (activeChannels.has(channelId)) return;
  if (globalRunningCount >= MAX_CONCURRENT) return;

  const queue = channelQueues.get(channelId);
  if (!queue || queue.length === 0) return;

  const task = queue.shift()!;
  activeChannels.add(channelId);
  globalRunningCount++;

  task.execute();
}

function releaseChannel(channelId: string): void {
  activeChannels.delete(channelId);
  activeProcesses.delete(channelId);
  globalRunningCount--;
  // Try to process this channel's next task
  processChannelQueue(channelId);
  // Try to unblock other channels that were waiting on global capacity
  for (const [queuedChannelId, queue] of channelQueues) {
    if (queue.length > 0 && !activeChannels.has(queuedChannelId)) {
      processChannelQueue(queuedChannelId);
    }
  }
}

function enqueueTask(channelId: string, task: QueuedTask): boolean {
  if (!channelQueues.has(channelId)) {
    channelQueues.set(channelId, []);
  }

  const isQueued = activeChannels.has(channelId) || globalRunningCount >= MAX_CONCURRENT;
  channelQueues.get(channelId)!.push(task);
  processChannelQueue(channelId);
  return isQueued;
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

    let splitAt = remaining.lastIndexOf("\n", MAX_DISCORD_LENGTH);
    if (splitAt === -1 || splitAt < MAX_DISCORD_LENGTH * 0.5) {
      splitAt = MAX_DISCORD_LENGTH;
    }

    let chunk = remaining.slice(0, splitAt);

    const codeBlockMatches = chunk.match(/```/g);
    if (codeBlockMatches && codeBlockMatches.length % 2 !== 0) {
      if (!inCodeBlock) {
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

    if (inCodeBlock && remaining.length > 0) {
      remaining = `\`\`\`${codeBlockLang}\n${remaining}`;
    }
  }

  return chunks;
}

// List available agent personalities
function listAgents(): string[] {
  const agentsDir = join(HARNESS_ROOT, ".claude", "agents");
  if (!existsSync(agentsDir)) return [];
  return readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(".md", ""));
}

// Read an agent's system prompt
function readAgentPrompt(name: string): string | null {
  const agentFile = join(HARNESS_ROOT, ".claude", "agents", `${name}.md`);
  if (!existsSync(agentFile)) return null;
  return readFileSync(agentFile, "utf-8");
}

// Temp directory for Claude response files
const TEMP_DIR = join(HARNESS_ROOT, "bridges", "discord", ".tmp");
try {
  mkdirSync(TEMP_DIR, { recursive: true });
} catch {}

// Streaming support
const STREAM_DIR = join(TEMP_DIR, "streams");
try {
  mkdirSync(STREAM_DIR, { recursive: true });
} catch {}

async function handleClaude(
  message: Message,
  userText: string,
  isRetry: boolean = false
): Promise<void> {
  const channelId = message.channel.id;

  // Show typing indicator
  const channel = message.channel;
  if ("sendTyping" in channel) {
    await (channel as TextChannel).sendTyping();
  }

  // Unique ID for this request (used for temp files)
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Build claude command args
  const args = ["-p", "--output-format", "json", "--dangerously-skip-permissions"];

  // Apply channel config
  const channelConfig = getChannelConfig(channelId);

  // Agent personality — pass as system prompt append
  const agentName = channelConfig?.agent;
  if (agentName) {
    const agentPrompt = readAgentPrompt(agentName);
    if (agentPrompt) {
      args.push("--append-system-prompt", agentPrompt);
    }
  }

  // Permission mode
  if (channelConfig?.permissionMode) {
    args.push("--permission-mode", channelConfig.permissionMode);
  }

  // Model override
  if (channelConfig?.model) {
    args.push("--model", channelConfig.model);
  }

  // Global safety guardrails
  args.push("--disallowedTools", GLOBAL_DISALLOWED_TOOLS);

  // Channel-specific allowed tools
  if (channelConfig?.allowedTools?.length) {
    args.push("--allowedTools", channelConfig.allowedTools.join(","));
  }

  // Channel-specific disallowed tools (append to global)
  if (channelConfig?.disallowedTools?.length) {
    args.push("--disallowedTools", channelConfig.disallowedTools.join(","));
  }

  // Check for existing session to resume
  // Project channels use compound keys (channelId:agentName)
  const project = getProject(channelId);
  const sessionKey =
    project && agentName
      ? getProjectSessionKey(channelId, agentName)
      : channelId;
  const existingSession = getSession(sessionKey);
  if (existingSession) {
    args.push("--resume", existingSession);
  }

  // Add the user's message (-- separator prevents flags from consuming it)
  args.push("--", userText);

  // Streaming: set up stream directory for this request
  const streamDir = join(STREAM_DIR, requestId);
  const outputFile = join(TEMP_DIR, `response-${requestId}.json`);

  const pythonArgs = [
    `${HARNESS_ROOT}/bridges/discord/claude-runner.py`,
    outputFile,
    "--stream-dir",
    streamDir,
    ...args,
  ];

  const proc = spawn("python3", pythonArgs, {
    cwd: HARNESS_ROOT,
    env: { ...process.env, HARNESS_ROOT },
    detached: true,
    stdio: "ignore",
  });
  proc.unref();

  console.log(`[CLAUDE] Spawned PID ${proc.pid}, channel: ${channelId}, agent: ${agentName || "default"}`);

  // Post to activity stream
  const activity: AgentActivity = {
    channelId,
    agent: agentName || "default",
    prompt: userText,
    startedAt: Date.now(),
  };
  postAgentStart(activity).then((msgId) => {
    if (msgId) activity.streamMessageId = msgId;
  });

  // Set up streaming message updates
  let streamMessage: Message | null = null;
  let lastStreamText = "";

  const streamPoller = new StreamPoller(streamDir, async (text, toolInfo) => {
    try {
      const displayText = toolInfo
        ? `${text}\n\n*${toolInfo}*`
        : text || "Thinking...";
      const truncated =
        displayText.length > MAX_DISCORD_LENGTH
          ? displayText.slice(-MAX_DISCORD_LENGTH)
          : displayText;

      if (truncated === lastStreamText) return;
      lastStreamText = truncated;

      if (!streamMessage) {
        streamMessage = await message.reply(truncated || "Thinking...");
      } else {
        await streamMessage.edit(truncated);
      }
    } catch (err: any) {
      // Rate limited or message deleted — ignore
    }
  });

  streamPoller.start();

  // Track active process for /stop command
  activeProcesses.set(channelId, proc.pid!);

  // Poll for the output file (no timeout — use /stop to cancel)
  const POLL_INTERVAL = 1_000;

  const poll = async (): Promise<void> => {
    if ("sendTyping" in channel) {
      (channel as TextChannel).sendTyping().catch(() => {});
    }

    if (existsSync(outputFile)) {
      streamPoller.stop();

      try {
        const raw = readFileSync(outputFile, "utf-8");
        unlinkSync(outputFile);

        const result = JSON.parse(raw);
        const { stdout, stderr, returncode } = result;

        console.log(
          `[CLAUDE] returncode: ${returncode}, stdout length: ${(stdout || "").length}`
        );
        if (stderr) console.error(`[CLAUDE STDERR] ${stderr.slice(0, 500)}`);

        // Check for stale session error and retry
        if (
          returncode !== 0 &&
          !isRetry &&
          stderr?.includes("session") &&
          (stderr?.includes("not found") || stderr?.includes("expired"))
        ) {
          console.log(`[CLAUDE] Stale session detected, clearing and retrying`);
          validateSession(sessionKey);
          releaseChannel(channelId);
          await handleClaude(message, userText, true);
          return;
        }

        if (returncode !== 0) {
          const errorMsg =
            stderr?.trim() || `Claude exited with code ${returncode}`;
          const errorReply = `Something went wrong:\n\`\`\`\n${errorMsg.slice(0, 500)}\n\`\`\``;
          postAgentError(activity, errorMsg).catch(() => {});
          if (streamMessage) {
            await streamMessage.edit(errorReply);
          } else {
            await message.reply(errorReply);
          }
        } else {
          const responseText = extractResponse(stdout);
          const sessionId = extractSessionId(stdout);

          if (sessionId) {
            setSession(sessionKey, sessionId);
          }

          if (responseText) {
            // Check for [CREATE_CHANNEL:name] directive in agent output
            const createDir = parseCreateChannel(responseText);
            if (createDir && message.guild) {
              try {
                const newProject = await createProject(
                  message.guild,
                  createDir.channelName,
                  createDir.description || `Created by ${agentName || "agent"}`,
                  createDir.agent ? [createDir.agent, ...["researcher", "reviewer", "builder", "ops"].filter(a => a !== createDir.agent)] : undefined
                );
                // Strip the directive from the response before posting
                const cleanResponse = responseText.replace(
                  /\[CREATE_CHANNEL\s*:\s*[\w-]+(?:\s+--agent\s+\w+)?(?:\s+"[^"]*")?\]/i,
                  `*(Created project channel <#${newProject.channelId}>)*`
                );
                const chunks = splitMessage(cleanResponse);
                if (streamMessage) {
                  await streamMessage.edit(chunks[0]);
                  for (let i = 1; i < chunks.length; i++) {
                    await message.reply(chunks[i]);
                  }
                } else {
                  for (const chunk of chunks) {
                    await message.reply(chunk);
                  }
                }
                releaseChannel(channelId);
                return;
              } catch (err: any) {
                console.error(`[CREATE_CHANNEL] Failed: ${err.message}`);
                // Fall through to normal response handling
              }
            }

            // Check for handoff in project channels
            if (project && agentName && parseHandoff(responseText)) {
              // Post the pre-handoff text, then run the handoff chain
              const handoff = parseHandoff(responseText)!;
              if (handoff.preHandoffText) {
                const preChunks = splitMessage(
                  `**${agentName.charAt(0).toUpperCase() + agentName.slice(1)}:** ${handoff.preHandoffText}`
                );
                if (streamMessage) {
                  await streamMessage.edit(preChunks[0]);
                  for (let i = 1; i < preChunks.length; i++) {
                    await (channel as TextChannel).send(preChunks[i]);
                  }
                } else {
                  for (const chunk of preChunks) {
                    await (channel as TextChannel).send(chunk);
                  }
                }
              } else if (streamMessage) {
                await streamMessage.delete().catch(() => {});
              }
              // Release channel before handoff chain (it manages its own spawns)
              releaseChannel(channelId);
              await runHandoffChain(
                channel as TextChannel,
                agentName,
                responseText
              );
              return;
            }

            const chunks = splitMessage(responseText);
            if (streamMessage) {
              // Edit the streaming message with the first chunk
              await streamMessage.edit(chunks[0]);
              for (let i = 1; i < chunks.length; i++) {
                await message.reply(chunks[i]);
              }
            } else {
              for (const chunk of chunks) {
                await message.reply(chunk);
              }
            }
          } else {
            console.error("[PARSE ERROR] Raw stdout:", stdout.slice(0, 500));
            const errMsg = "Got a response but couldn't parse it. Check logs.";
            if (streamMessage) {
              await streamMessage.edit(errMsg);
            } else {
              await message.reply(errMsg);
            }
          }
        }

        // Post completion to activity stream
        const streamResult = extractResponse(stdout || "") || "Completed";
        postAgentComplete(activity, streamResult).catch(() => {});
      } catch (err: any) {
        console.error("[FILE READ ERROR]", err.message);
        await message.reply("Error reading Claude's response. Check logs.");
        postAgentError(activity, err.message || "File read error").catch(() => {});
      }

      // Clean up stream directory
      try {
        const files = readdirSync(streamDir);
        for (const f of files) unlinkSync(join(streamDir, f));
        unlinkSync(streamDir);
      } catch {}

      releaseChannel(channelId);
      return;
    }

    setTimeout(poll, POLL_INTERVAL);
  };

  setTimeout(poll, POLL_INTERVAL);
}

// --- Command Handler ---

async function handleCommand(message: Message, content: string): Promise<boolean> {
  const channelId = message.channel.id;

  // /stop — kill the active Claude process in this channel
  if (content === "/stop") {
    const pid = activeProcesses.get(channelId);
    if (!pid) {
      await message.reply("Nothing running in this channel.");
      return true;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
    activeProcesses.delete(channelId);
    releaseChannel(channelId);
    await message.reply("Stopped the active request.");
    return true;
  }

  // /new — clear session
  if (content === "/new") {
    const cleared = clearSession(channelId);
    await message.reply(
      cleared
        ? "Session cleared. Next message starts a fresh conversation."
        : "No active session in this channel."
    );
    return true;
  }

  // /status — show session info
  if (content === "/status") {
    const session = getSession(channelId);
    await message.reply(
      session
        ? `Active session: \`${session}\``
        : "No active session in this channel."
    );
    return true;
  }

  // /agents — list available agent personalities
  if (content === "/agents") {
    const agents = listAgents();
    if (agents.length === 0) {
      await message.reply("No agent personalities found.");
    } else {
      await message.reply(
        `**Available agents:**\n${agents.map((a) => `• \`${a}\``).join("\n")}`
      );
    }
    return true;
  }

  // /agent clear — remove agent override
  if (content === "/agent clear") {
    const cfg = getChannelConfig(channelId);
    if (cfg?.agent) {
      setChannelConfig(channelId, { agent: undefined });
      await message.reply("Agent cleared. Channel will use default behavior.");
    } else {
      await message.reply("No agent set on this channel.");
    }
    return true;
  }

  // /agent create <name> "<description>" — create a new agent
  const createMatch = content.match(
    /^\/agent\s+create\s+(\w+)\s+"([^"]+)"$/
  );
  if (createMatch) {
    const [, name, description] = createMatch;
    const agentsDir = join(HARNESS_ROOT, ".claude", "agents");
    try {
      mkdirSync(agentsDir, { recursive: true });
    } catch {}
    const agentFile = join(agentsDir, `${name}.md`);
    if (existsSync(agentFile)) {
      await message.reply(`Agent \`${name}\` already exists.`);
      return true;
    }
    const template = `# ${name.charAt(0).toUpperCase() + name.slice(1)} Agent\n\n${description}\n\n## Behavior\n- Follow the description above\n- Be thorough and precise\n\n## Default Tools\nAll tools available. Destructive Bash commands are blocked by guardrails.\n`;
    writeFileSync(agentFile, template);
    await message.reply(`Agent \`${name}\` created.`);
    return true;
  }

  // /agent <name> — set channel agent
  const agentMatch = content.match(/^\/agent\s+(\w+)$/);
  if (agentMatch) {
    const name = agentMatch[1];
    const available = listAgents();
    if (!available.includes(name)) {
      await message.reply(
        `Agent \`${name}\` not found. Available: ${available.map((a) => `\`${a}\``).join(", ") || "none"}`
      );
      return true;
    }
    setChannelConfig(channelId, { agent: name });
    await message.reply(`Channel agent set to \`${name}\`.`);
    return true;
  }

  // /model <name> — set channel model override
  const modelMatch = content.match(/^\/model\s+(.+)$/);
  if (modelMatch) {
    const model = modelMatch[1].trim();
    setChannelConfig(channelId, { model });
    await message.reply(`Channel model set to \`${model}\`.`);
    return true;
  }

  // /config — show current channel config
  if (content === "/config") {
    const cfg = getChannelConfig(channelId);
    const session = getSession(channelId);
    if (!cfg && !session) {
      await message.reply("No configuration set for this channel.");
      return true;
    }
    const lines: string[] = ["**Channel Config:**"];
    if (cfg?.agent) lines.push(`• Agent: \`${cfg.agent}\``);
    if (cfg?.model) lines.push(`• Model: \`${cfg.model}\``);
    if (cfg?.permissionMode)
      lines.push(`• Permission mode: \`${cfg.permissionMode}\``);
    if (session) lines.push(`• Session: \`${session}\``);
    if (cfg?.allowedTools?.length)
      lines.push(`• Allowed tools: ${cfg.allowedTools.join(", ")}`);
    if (cfg?.disallowedTools?.length)
      lines.push(`• Disallowed tools: ${cfg.disallowedTools.join(", ")}`);
    await message.reply(lines.join("\n"));
    return true;
  }

  // /spawn [--agent <name>] <description> — spawn a background subagent
  const spawnMatch = content.match(
    /^\/spawn\s+(?:--agent\s+(\w+)\s+)?(.+)$/s
  );
  if (spawnMatch) {
    const [, agentOverride, description] = spawnMatch;
    const entry = spawnSubagent({
      channelId,
      description,
      agent: agentOverride,
    });
    if (!entry) {
      await message.reply(
        `At capacity (${MAX_CONCURRENT} concurrent processes). Try again later.`
      );
    } else {
      await message.reply(
        `Subagent spawned: \`${entry.id}\`\nAgent: ${entry.agent || "default"}\nTask: ${description.slice(0, 200)}`
      );
    }
    return true;
  }

  // /tasks — list running subagents
  if (content === "/tasks") {
    const running = getRunning();
    if (running.length === 0) {
      await message.reply("No running subagents.");
    } else {
      const lines = running.map(
        (e) =>
          `• \`${e.id}\` (${e.agent || "default"}) — ${e.description.slice(0, 80)}`
      );
      await message.reply(`**Running subagents (${running.length}):**\n${lines.join("\n")}`);
    }
    return true;
  }

  // /cancel <id> — cancel a running subagent
  const cancelMatch = content.match(/^\/cancel\s+(\S+)$/);
  if (cancelMatch) {
    const cancelled = cancelSubagent(cancelMatch[1]);
    await message.reply(
      cancelled
        ? `Subagent \`${cancelMatch[1]}\` cancelled.`
        : `Subagent \`${cancelMatch[1]}\` not found or not running.`
    );
    return true;
  }

  // /channel create <name> [--agent <agentName>] — create a new Discord channel
  const channelCreateMatch = content.match(
    /^\/channel\s+create\s+(\S+)(?:\s+--agent\s+(\w+))?$/
  );
  if (channelCreateMatch) {
    const [, name, agentName] = channelCreateMatch;
    const guild = message.guild;
    if (!guild) {
      await message.reply("This command only works in a server.");
      return true;
    }
    try {
      const newChannel = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        reason: `Created by AI Harness bot`,
      });
      if (agentName) {
        setChannelConfig(newChannel.id, { agent: agentName });
      }
      await message.reply(
        `Channel <#${newChannel.id}> created${agentName ? ` with agent \`${agentName}\`` : ""}.`
      );
    } catch (err: any) {
      await message.reply(`Failed to create channel: ${err.message}`);
    }
    return true;
  }

  // /project create <name> "description" — create a project channel
  const projectCreateMatch = content.match(
    /^\/project\s+create\s+(\w[\w-]*)\s+"([^"]+)"$/
  );
  if (projectCreateMatch) {
    const [, name, description] = projectCreateMatch;
    const guild = message.guild;
    if (!guild) {
      await message.reply("This command only works in a server.");
      return true;
    }
    try {
      const project = await createProject(guild, name, description);
      await message.reply(
        `Project created: <#${project.channelId}>\nAgents: ${project.agents.join(", ")}\nDescription: ${description}`
      );
    } catch (err: any) {
      await message.reply(`Failed to create project: ${err.message}`);
    }
    return true;
  }

  // /project list — list active projects
  if (content === "/project list") {
    const projects = listProjects();
    if (projects.length === 0) {
      await message.reply("No active projects.");
    } else {
      const lines = projects.map(
        (p) =>
          `• <#${p.channelId}> — ${p.description.slice(0, 80)} (agents: ${p.agents.join(", ")})`
      );
      await message.reply(`**Active projects (${projects.length}):**\n${lines.join("\n")}`);
    }
    return true;
  }

  // /project agents <agent1,agent2,...> — set project agents for this channel
  const projectAgentsMatch = content.match(
    /^\/project\s+agents\s+([\w,]+)$/
  );
  if (projectAgentsMatch) {
    const agents = projectAgentsMatch[1].split(",").map((a) => a.trim());
    const project = getProject(channelId);
    if (!project) {
      await message.reply("This channel is not a project channel.");
      return true;
    }
    const available = listAgents();
    const invalid = agents.filter((a) => !available.includes(a));
    if (invalid.length > 0) {
      await message.reply(
        `Unknown agents: ${invalid.join(", ")}. Available: ${available.join(", ")}`
      );
      return true;
    }
    updateProject(channelId, { agents });
    await message.reply(`Project agents updated: ${agents.join(", ")}`);
    return true;
  }

  // /project adopt ["description"] — register this channel as a project
  const adoptMatch = content.match(/^\/project\s+adopt(?:\s+"([^"]+)")?$/);
  if (adoptMatch) {
    const project = getProject(channelId);
    if (project) {
      await message.reply("This channel is already a project.");
      return true;
    }
    const ch = message.channel;
    if (!("name" in ch)) {
      await message.reply("This command only works in a server text channel.");
      return true;
    }
    const textCh = ch as TextChannel;
    const adopted = adoptChannel(
      channelId,
      textCh.name,
      textCh.parentId,
      message.guild?.id || "",
      adoptMatch[1] || undefined
    );
    await message.reply(
      `Channel adopted as project \`${adopted.name}\`.\nAgents: ${adopted.agents.join(", ")}\nDescription: ${adopted.description}`
    );
    return true;
  }

  // /project close — archive project channel
  if (content === "/project close") {
    const guild = message.guild;
    if (!guild) {
      await message.reply("This command only works in a server.");
      return true;
    }
    const closed = await closeProject(guild, channelId);
    if (closed) {
      await message.reply("Project closed and channel archived.");
    } else {
      await message.reply("This channel is not a project channel.");
    }
    return true;
  }

  // /help — list all commands
  if (content === "/help") {
    await message.reply(
      `**Available commands:**
• \`/stop\` — Kill the active request in this channel
• \`/new\` — Clear session, start fresh conversation
• \`/status\` — Show current session info
• \`/agent <name>\` — Set channel agent personality
• \`/agent clear\` — Remove agent override
• \`/agent create <name> "description"\` — Create a new agent
• \`/agents\` — List available agent personalities
• \`/model <name>\` — Set channel model override
• \`/config\` — Show current channel configuration
• \`/spawn [--agent <name>] <task>\` — Spawn a background subagent
• \`/tasks\` — List running subagents
• \`/cancel <id>\` — Cancel a running subagent
• \`/channel create <name> [--agent <name>]\` — Create a new channel
• \`/project create <name> "description"\` — Create a project channel
• \`/project adopt ["description"]\` — Register this channel as a project
• \`/project list\` — List active projects
• \`/project agents <a1,a2,...>\` — Set project agents
• \`/project close\` — Archive project channel
*Channels under the Projects category are auto-adopted on first message.*
*Agents can create channels with \`[CREATE_CHANNEL:name]\` in their output.*
• \`/help\` — Show this help message`
    );
    return true;
  }

  return false;
}

// --- Notification Drain ---
const NOTIFY_FILE = join(
  HARNESS_ROOT,
  "heartbeat-tasks",
  "pending-notifications.jsonl"
);
const NOTIFY_POLL_MS = 60_000;

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
          console.log(
            `[NOTIFY] Channel '${channelName}' not found, skipping`
          );
          failed.push(line);
          continue;
        }

        const msg = `**Heartbeat: ${task}** (${ts})\n${summary.slice(0, 1800)}`;
        await targetChannel.send(msg);
        console.log(`[NOTIFY] Sent '${task}' to #${channelName}`);
      } catch (err: any) {
        console.error(`[NOTIFY] Failed to process: ${err.message}`);
        failed.push(line);
      }
    }

    if (failed.length > 0) {
      writeFileSync(NOTIFY_FILE, failed.join("\n") + "\n");
    } else {
      unlinkSync(NOTIFY_FILE);
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.error(`[NOTIFY] Error: ${err.message}`);
    }
  }
}

// --- Bot Events ---

client.on("clientReady", () => {
  console.log(`AI Harness bot online as ${client.user?.tag}`);
  console.log(`Allowed users: ${ALLOWED_USER_IDS.join(", ")}`);
  console.log(`Working directory: ${HARNESS_ROOT}`);
  console.log(`Max concurrent processes: ${MAX_CONCURRENT}`);

  // Initialize activity stream
  initActivityStream(client);

  // Start subagent polling
  startSubagentPolling();

  // Clean up stale subagents from previous runs
  const cleaned = cleanupStale();
  if (cleaned > 0) console.log(`[SUBAGENT] Cleaned up ${cleaned} stale entries`);

  // Set up subagent completion notifications
  onSubagentComplete(async (entry, result) => {
    try {
      const ch = client.channels.cache.get(entry.parentChannelId);
      if (ch && ch.isTextBased()) {
        const status = entry.status === "completed" ? "completed" : "failed";
        const preview = result.slice(0, 300);
        const streamNote = process.env.STREAM_CHANNEL_ID
          ? `\nFull result in <#${process.env.STREAM_CHANNEL_ID}>`
          : "";
        await (ch as TextChannel).send(
          `**Subagent \`${entry.id}\` ${status}** (${entry.agent || "default"})\n${preview}${result.length > 300 ? "..." : ""}${streamNote}`
        );
      }
    } catch (err: any) {
      console.error(`[SUBAGENT] Failed to notify channel: ${err.message}`);
    }
  });

  // Start notification drain polling
  setInterval(drainNotifications, NOTIFY_POLL_MS);
  console.log(`[NOTIFY] Polling every ${NOTIFY_POLL_MS / 1000}s`);
});

client.on("messageCreate", async (message: Message) => {
  console.log(
    `[MSG] from ${message.author.tag} (${message.author.id}): "${message.content}" | bot: ${message.author.bot}`
  );

  if (message.author.bot) return;

  if (!ALLOWED_USER_IDS.includes(message.author.id)) {
    console.log(
      `[BLOCKED] User ${message.author.id} not in allowed list: ${ALLOWED_USER_IDS}`
    );
    return;
  }

  const content = message.content.trim();
  if (!content) return;

  // Handle commands first
  if (content.startsWith("/")) {
    const handled = await handleCommand(message, content);
    if (handled) return;
    // If not a recognized command, fall through to Claude
  }

  // Auto-adopt channels under the Projects category
  const channelId = message.channel.id;
  if (
    !getProject(channelId) &&
    "parent" in message.channel &&
    message.channel.parent &&
    message.channel.parent.name.toLowerCase() ===
      getProjectsCategoryName().toLowerCase()
  ) {
    const ch = message.channel as TextChannel;
    const adopted = autoAdoptIfInCategory(
      channelId,
      ch.name,
      ch.parentId,
      message.guild?.id || ""
    );
    if (adopted) {
      console.log(`[PROJECT] Auto-adopted #${ch.name} as project "${adopted.name}"`);
      await message.reply(
        `Auto-registered as project \`${adopted.name}\` (in Projects category). Agents: ${adopted.agents.join(", ")}`
      );
    }
  }

  // For project channels: reset handoff depth on human message
  // and route to addressed agent if specified (e.g., "builder: do X")
  const project = getProject(channelId);
  if (project) {
    resetHandoffDepth(channelId);

    // Check if user is addressing a specific agent ("agent: message")
    const agentAddressMatch = content.match(/^(\w+)\s*:\s*(.+)$/s);
    if (agentAddressMatch) {
      const [, addressedAgent, agentMessage] = agentAddressMatch;
      if (project.agents.includes(addressedAgent.toLowerCase())) {
        setChannelConfig(channelId, { agent: addressedAgent.toLowerCase() });
        updateProject(channelId, { activeAgent: addressedAgent.toLowerCase() });
      }
    }
  }

  // Enqueue the Claude request
  const task: QueuedTask = {
    message,
    execute: () => {
      handleClaude(message, content).catch(async (err) => {
        await message.reply(`Error: ${err.message}`);
        releaseChannel(channelId);
      });
    },
  };

  const wasQueued = enqueueTask(channelId, task);
  if (wasQueued) {
    await message.react("⏳");
  }
});

client.login(DISCORD_TOKEN);
