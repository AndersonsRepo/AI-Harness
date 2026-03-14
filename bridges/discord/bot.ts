import {
  Client,
  GatewayIntentBits,
  Partials,
  Message,
  TextChannel,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
} from "discord.js";
import { spawn } from "child_process";
import { config } from "dotenv";
import { getSession, setSession, clearSession, clearChannelSessions, validateSession } from "./session-store.js";
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
  type ChainResult,
} from "./handoff-router.js";
import { listAgentNames, readAgentPrompt as loadAgentPrompt } from "./agent-loader.js";
import {
  readFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
} from "fs";
import { join } from "path";
import {
  approveLearning,
  rejectLearning,
  getVaultStats,
} from "./promotion-handler.js";
import { getDb, closeDb } from "./db.js";
import { FileWatcher, trackWatcher, untrackWatcher, stopAllWatchers } from "./file-watcher.js";
import {
  submitTask,
  spawnTask,
  getTask,
  getGlobalRunningCount,
  getRunningCountForChannel,
  getTaskPidForChannel,
  cancelChannelTasks,
  onTaskOutput,
  onTaskDeadLetter,
  recoverCrashedTasks,
  pruneDeadLetters,
  listDeadLetters,
  retryDeadLetter,
  extractResponse,
  extractSessionId,
  type TaskRecord,
  type DeadLetterRecord,
} from "./task-runner.js";
import { syncEmbeddings, watchVaultForEmbeddings, stopEmbeddingWatchers } from "./embeddings.js";

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
    stopAllWatchers();
    stopEmbeddingWatchers();
    closeDb();
  });
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
} catch {}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";
const MAX_DISCORD_LENGTH = 1900;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_PROCESSES || "5", 10);

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

// --- Per-Channel Queue System (backed by task_queue) ---
interface QueuedTask {
  execute: () => void;
  message: Message;
}

const channelQueues: Map<string, QueuedTask[]> = new Map();
const activeChannels: Set<string> = new Set();

// Track stream pollers and stream messages for active tasks
const activeStreamPollers: Map<string, StreamPoller> = new Map(); // taskId → StreamPoller
const activeStreamMessages: Map<string, Message> = new Map(); // taskId → Discord stream message

function processChannelQueue(channelId: string): void {
  if (activeChannels.has(channelId)) return;
  if (getGlobalRunningCount() >= MAX_CONCURRENT) return;

  const queue = channelQueues.get(channelId);
  if (!queue || queue.length === 0) return;

  const task = queue.shift()!;
  activeChannels.add(channelId);

  task.execute();
}

function releaseChannel(channelId: string): void {
  activeChannels.delete(channelId);
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

  const isQueued = activeChannels.has(channelId) || getGlobalRunningCount() >= MAX_CONCURRENT;
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

// Alias imports to match existing usage
function listAgents(): string[] {
  return listAgentNames();
}

function readAgentPrompt(name: string): string | null {
  return loadAgentPrompt(name);
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

// --- Task Runner Output Handler ---
// This is called by task-runner.ts when a task completes or fails
// We need to map task IDs back to Discord messages

interface PendingTaskContext {
  message: Message;
  channelId: string;
  userText: string;
  agentName?: string;
  streamDir: string;
  isRetry: boolean;
  activity: AgentActivity;
}

const pendingTaskContexts: Map<string, PendingTaskContext> = new Map();

onTaskOutput(async (taskId, response, error, sessionId, raw) => {
  const ctx = pendingTaskContexts.get(taskId);
  if (!ctx) return;

  const task = getTask(taskId);
  const isComplete = task?.status === "completed" || task?.status === "dead";
  const isContinuation = task && task.step_count > 1 && !isComplete;

  // Stop stream poller if task is done
  if (isComplete) {
    const poller = activeStreamPollers.get(taskId);
    if (poller) {
      poller.stop();
      activeStreamPollers.delete(taskId);
    }
  }

  // For continuation steps, send the full intermediate response then let it keep going
  if (isContinuation && response) {
    const streamMessage = activeStreamMessages.get(taskId);
    const channel = ctx.message.channel as TextChannel;
    const chunks = splitMessage(response);
    const continuationNote = `\n\n*Continuing... (step ${task!.step_count})*`;

    try {
      if (streamMessage) {
        // Edit stream message with first chunk, send rest as follow-ups
        await streamMessage.edit(chunks[0] + (chunks.length === 1 ? continuationNote : ""));
        for (let i = 1; i < chunks.length; i++) {
          const suffix = i === chunks.length - 1 ? continuationNote : "";
          await channel.send(chunks[i] + suffix);
        }
        // Clear stream message ref so next step creates a fresh one
        activeStreamMessages.delete(taskId);
      }
    } catch {}
    return;
  }

  // Task is finished (completed or dead)
  pendingTaskContexts.delete(taskId);
  const streamMessage = activeStreamMessages.get(taskId);
  activeStreamMessages.delete(taskId);

  // Clean up stream directory
  try {
    const files = readdirSync(ctx.streamDir);
    for (const f of files) unlinkSync(join(ctx.streamDir, f));
    unlinkSync(ctx.streamDir);
  } catch {}

  if (error && !response) {
    const errorReply = `Something went wrong:\n\`\`\`\n${error.slice(0, 500)}\n\`\`\``;
    postAgentError(ctx.activity, error).catch(() => {});
    if (streamMessage) {
      await streamMessage.edit(errorReply);
    } else {
      await ctx.message.reply(errorReply);
    }
    releaseChannel(ctx.channelId);
    return;
  }

  if (response) {
    const { message, channelId } = ctx;
    const project = getProject(channelId);
    const agentName = ctx.agentName;
    const channel = message.channel;

    // Check for [CREATE_CHANNEL:name] directive
    const createDir = parseCreateChannel(response);
    if (createDir && message.guild) {
      try {
        const newProject = await createProject(
          message.guild,
          createDir.channelName,
          createDir.description || `Created by ${agentName || "agent"}`,
          createDir.agent ? [createDir.agent, ...["researcher", "reviewer", "builder", "ops"].filter(a => a !== createDir.agent)] : undefined
        );
        const cleanResponse = response.replace(
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
        postAgentComplete(ctx.activity, response).catch(() => {});
        releaseChannel(channelId);
        return;
      } catch (err: any) {
        console.error(`[CREATE_CHANNEL] Failed: ${err.message}`);
      }
    }

    // Check for handoff in project channels
    if (project && agentName && parseHandoff(response)) {
      const handoff = parseHandoff(response)!;
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
      releaseChannel(channelId);
      const chainResult = await runHandoffChain(
        channel as TextChannel,
        agentName,
        response,
        { originAgent: agentName }
      );

      // If orchestrator started the chain and there were multiple agents, trigger debrief
      if (agentName === "orchestrator" && chainResult.entries.length > 1) {
        await invokeOrchestratorDebrief(channel as TextChannel, chainResult);
      }

      postAgentComplete(ctx.activity, response).catch(() => {});
      return;
    }

    // Normal response — cap at 5 messages to prevent raw doc dumps
    const MAX_RESPONSE_MESSAGES = 5;
    const chunks = splitMessage(response);
    const cappedChunks = chunks.slice(0, MAX_RESPONSE_MESSAGES);
    const wasCapped = chunks.length > MAX_RESPONSE_MESSAGES;

    if (streamMessage) {
      await streamMessage.edit(cappedChunks[0]);
      for (let i = 1; i < cappedChunks.length; i++) {
        await message.reply(cappedChunks[i]);
      }
    } else {
      for (const chunk of cappedChunks) {
        await message.reply(chunk);
      }
    }
    if (wasCapped) {
      await message.reply(`*(Response truncated — ${chunks.length - MAX_RESPONSE_MESSAGES} additional messages omitted. Ask me to continue or be more specific.)*`);
    }

    postAgentComplete(ctx.activity, response).catch(() => {});
  } else {
    console.error("[PARSE ERROR] No response text from task output");
    const errMsg = "Got a response but couldn't parse it. Check logs.";
    if (streamMessage) {
      await streamMessage.edit(errMsg);
    } else {
      await ctx.message.reply(errMsg);
    }
    postAgentError(ctx.activity, "Parse error").catch(() => {});
  }

  releaseChannel(ctx.channelId);
});

onTaskDeadLetter(async (record: DeadLetterRecord) => {
  try {
    const ch = client.channels.cache.get(record.channel_id);
    if (ch && ch.isTextBased()) {
      await (ch as TextChannel).send(
        `**Task failed permanently** after ${record.attempts} attempts.\nError: \`${record.error.slice(0, 300)}\`\nTask ID: \`${record.task_id}\`\nUse \`/retry ${record.id}\` to re-enqueue.`
      );
    }
  } catch (err: any) {
    console.error(`[DEAD-LETTER] Failed to notify channel: ${err.message}`);
  }
});

// --- Orchestrator Debrief ---
// After a chain started by the orchestrator completes, invoke the orchestrator
// one more time with [CHAIN_COMPLETE] to extract learnings and summarize.

async function invokeOrchestratorDebrief(
  channel: TextChannel,
  chainResult: ChainResult
): Promise<void> {
  // Build structured summary from chain entries (deterministic — just concatenation)
  const summaryLines: string[] = ["[CHAIN_COMPLETE]", "", "## Chain Summary", ""];
  for (const entry of chainResult.entries) {
    summaryLines.push(`### ${entry.agent}`);
    summaryLines.push(entry.response);
    summaryLines.push("");
  }
  const summary = summaryLines.join("\n");

  // Submit as a new task to orchestrator
  const taskId = submitTask({
    channelId: channel.id,
    prompt: summary,
    agent: "orchestrator",
    sessionKey: getProjectSessionKey(channel.id, "orchestrator"),
    maxSteps: 3, // Debrief shouldn't need many steps
    maxAttempts: 1, // Don't retry debriefs
  });

  const spawnResult = await spawnTask(taskId);
  if (!spawnResult) {
    console.error("[DEBRIEF] Failed to spawn orchestrator debrief task");
    return;
  }

  // Store context so the normal onTaskOutput flow posts the debrief to Discord.
  // Use a synthetic "message" that supports .reply() via the channel.
  const syntheticMessage = {
    channel,
    reply: (content: any) => channel.send(content),
  } as unknown as Message;

  const activity: AgentActivity = {
    channelId: channel.id,
    agent: "orchestrator",
    prompt: "[CHAIN_COMPLETE] debrief",
    startedAt: Date.now(),
  };

  pendingTaskContexts.set(taskId, {
    message: syntheticMessage,
    channelId: channel.id,
    userText: "[CHAIN_COMPLETE]",
    agentName: "orchestrator",
    streamDir: spawnResult.streamDir,
    isRetry: false,
    activity,
  });

  console.log(`[DEBRIEF] Orchestrator debrief spawned as ${taskId}`);
}

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

  // Determine agent and session key
  const channelConfig = getChannelConfig(channelId);
  const agentName = channelConfig?.agent;

  const project = getProject(channelId);
  const sessionKey =
    project && agentName
      ? getProjectSessionKey(channelId, agentName)
      : channelId;

  // Submit task to the task runner
  const taskId = submitTask({
    channelId,
    prompt: userText,
    agent: agentName || undefined,
    sessionKey,
  });

  // Set up streaming
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const streamDir = join(STREAM_DIR, requestId);

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

  // Store context for the task output handler
  pendingTaskContexts.set(taskId, {
    message,
    channelId,
    userText,
    agentName: agentName || undefined,
    streamDir,
    isRetry,
    activity,
  });

  // Spawn the task (this creates the process and FileWatcher)
  const spawnResult = await spawnTask(taskId);

  if (!spawnResult) {
    pendingTaskContexts.delete(taskId);
    await message.reply("Failed to spawn Claude process.");
    releaseChannel(channelId);
    return;
  }

  // Set up streaming message updates using the task's stream dir
  let streamMessage: Message | null = null;
  let lastStreamText = "";

  const streamPoller = new StreamPoller(spawnResult.streamDir, async (text, toolInfo) => {
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
        activeStreamMessages.set(taskId, streamMessage);
      } else {
        await streamMessage.edit(truncated);
      }
    } catch (err: any) {
      // Rate limited or message deleted — ignore
    }
  });

  activeStreamPollers.set(taskId, streamPoller);
  streamPoller.start();

  // Keep typing indicator alive
  const typingInterval = setInterval(() => {
    const task = getTask(taskId);
    if (!task || task.status === "completed" || task.status === "dead" || task.status === "failed") {
      clearInterval(typingInterval);
      return;
    }
    if ("sendTyping" in channel) {
      (channel as TextChannel).sendTyping().catch(() => {});
    }
  }, 8000);
}

// --- Command Handler ---

async function handleCommand(message: Message, content: string): Promise<boolean> {
  const channelId = message.channel.id;

  // /stop — kill the active task in this channel
  if (content === "/stop") {
    const pid = getTaskPidForChannel(channelId);
    if (!pid) {
      await message.reply("Nothing running in this channel.");
      return true;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
    cancelChannelTasks(channelId);
    releaseChannel(channelId);
    await message.reply("Stopped the active request.");
    return true;
  }

  // /new — clear session (handles compound keys for project channels)
  if (content === "/new") {
    const cleared = clearChannelSessions(channelId);
    await message.reply(
      cleared > 0
        ? `Cleared ${cleared} session(s). Next message starts a fresh conversation.`
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
    const template = `# ${name.charAt(0).toUpperCase() + name.slice(1)} Agent\n\n${description}\n\n## Behavior\n- Follow the description above\n- Be thorough and precise\n- If your work is not complete and you need to continue, end your response with [CONTINUE]. If you are done, do not include this marker.\n\n## Default Tools\nAll tools available. Destructive Bash commands are blocked by guardrails.\n`;
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
    const entry = await spawnSubagent({
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

  // /approve <id> — approve a vault learning for promotion
  const approveMatch = content.match(/^\/approve\s+(\S+)$/);
  if (approveMatch) {
    const result = approveLearning(approveMatch[1]);
    await message.reply(result.message);
    return true;
  }

  // /reject <id> — reject a vault learning for promotion
  const rejectMatch = content.match(/^\/reject\s+(\S+)$/);
  if (rejectMatch) {
    const result = rejectLearning(rejectMatch[1]);
    await message.reply(result.message);
    return true;
  }

  // /vault-status — show vault learning stats
  if (content === "/vault-status") {
    const stats = getVaultStats();
    const statusLines = Object.entries(stats.byStatus)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");
    const typeLines = Object.entries(stats.byType)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");
    const recentLines = stats.recentLearnings
      .map((l) => `  • ${l.id}: ${l.title} (×${l.recurrence})`)
      .join("\n");
    await message.reply(
      `**Vault Status** (${stats.total} learnings)\n` +
        `**By status:**\n${statusLines || "  (none)"}\n` +
        `**By type:**\n${typeLines || "  (none)"}\n` +
        `**Promotion candidates:** ${stats.promotionCandidates}\n` +
        `**Top learnings:**\n${recentLines || "  (none)"}`
    );
    return true;
  }

  // /dead-letter — list dead-lettered tasks
  if (content === "/dead-letter") {
    const deadLetters = listDeadLetters();
    if (deadLetters.length === 0) {
      await message.reply("No dead-lettered tasks.");
    } else {
      const lines = deadLetters.slice(0, 10).map(
        (dl) =>
          `• \`${dl.id}\` — <#${dl.channel_id}> — ${dl.error.slice(0, 80)} (${dl.attempts} attempts, ${dl.created_at.slice(0, 16)})`
      );
      await message.reply(
        `**Dead-lettered tasks (${deadLetters.length}):**\n${lines.join("\n")}${deadLetters.length > 10 ? `\n... and ${deadLetters.length - 10} more` : ""}`
      );
    }
    return true;
  }

  // /retry <id> — re-enqueue a dead-lettered task
  const retryMatch = content.match(/^\/retry\s+(\S+)$/);
  if (retryMatch) {
    const newTaskId = retryDeadLetter(retryMatch[1]);
    if (newTaskId) {
      await message.reply(`Task re-enqueued as \`${newTaskId}\`. It will run automatically.`);
      // Spawn it
      await spawnTask(newTaskId);
    } else {
      await message.reply(`Dead-letter entry \`${retryMatch[1]}\` not found.`);
    }
    return true;
  }

  // /db-status — show database stats
  if (content === "/db-status") {
    const db = getDb();
    const tables = ["sessions", "channel_configs", "subagents", "projects", "task_queue", "dead_letter"];
    const counts: string[] = [];
    for (const table of tables) {
      const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
      counts.push(`• ${table}: ${row.c} rows`);
    }

    // DB file size
    const dbPath = join(HARNESS_ROOT, "bridges", "discord", "harness.db");
    let sizeStr = "unknown";
    try {
      const stats = readFileSync(dbPath);
      const sizeKb = Math.round(stats.length / 1024);
      sizeStr = sizeKb < 1024 ? `${sizeKb} KB` : `${(sizeKb / 1024).toFixed(1)} MB`;
    } catch {}

    await message.reply(
      `**Database Status:**\nFile size: ${sizeStr}\n${counts.join("\n")}`
    );
    return true;
  }

  // /restart — graceful bot restart via launchd
  if (content === "/restart") {
    await message.reply("Restarting bot... (launchd will bring it back in ~30s)");
    // Exit with non-zero code so launchd's KeepAlive (SuccessfulExit=false) restarts us
    setTimeout(() => process.exit(75), 1000);
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
• \`/approve <id>\` — Approve a vault learning for promotion to CLAUDE.md
• \`/reject <id>\` — Reject a vault learning promotion
• \`/vault-status\` — Show vault learning stats and promotion candidates
• \`/dead-letter\` — List failed tasks (dead-letter queue)
• \`/retry <id>\` — Re-enqueue a dead-lettered task
• \`/db-status\` — Show database table counts and file size
• \`/restart\` — Restart the bot (launchd brings it back)
*Channels under the Projects category are auto-adopted on first message.*
*Agents can create channels with \`[CREATE_CHANNEL:name]\` in their output.*
• \`/help\` — Show this help message`
    );
    return true;
  }

  return false;
}

// --- LinkedIn Approval Flow ---

async function handleLinkedInApproval(message: Message, token: string, approve: boolean): Promise<void> {
  try {
    const db = getDb();
    const post = db
      .prepare("SELECT id, status, topic, content FROM linkedin_posts WHERE approval_token = ?")
      .get(token) as { id: string; status: string; topic: string; content: string } | undefined;

    if (!post) {
      await message.reply("Invalid approval token — no matching draft found.");
      return;
    }

    if (post.status === "published") {
      await message.reply(`Post \`${post.id}\` was already published.`);
      return;
    }

    if (approve) {
      // Update status to approved
      db.prepare("UPDATE linkedin_posts SET status = 'approved' WHERE id = ?").run(post.id);

      const embed = new EmbedBuilder()
        .setTitle("LinkedIn Post Approved")
        .setDescription(`**${post.topic}**\n\n${post.content.slice(0, 300)}${post.content.length > 300 ? "..." : ""}`)
        .setColor(0x0A66C2) // LinkedIn blue
        .setFooter({ text: `Post ${post.id} — publishing...` })
        .setTimestamp();

      await message.reply({ embeds: [embed] });

      // Write a notification to trigger the MCP tool call for publishing
      // The bot doesn't call MCP directly — instead write instruction to notifications
      const publishNotif = JSON.stringify({
        task: "linkedin-publish",
        channel: "linkedin",
        summary: `Post ${post.id} approved — call linkedin_post with approvalToken "${token}" to publish.`,
        timestamp: new Date().toISOString(),
      });
      const notifyPath = join(HARNESS_ROOT, "heartbeat-tasks", "pending-notifications.jsonl");
      appendFileSync(notifyPath, publishNotif + "\n");
    } else {
      db.prepare("UPDATE linkedin_posts SET status = 'rejected', approval_token = NULL WHERE id = ?").run(post.id);

      const embed = new EmbedBuilder()
        .setTitle("LinkedIn Post Rejected")
        .setDescription(`**${post.topic}**\n\nDraft rejected and token invalidated.`)
        .setColor(0xED4245) // Red
        .setFooter({ text: `Post ${post.id}` })
        .setTimestamp();

      await message.reply({ embeds: [embed] });
    }
  } catch (err: any) {
    await message.reply(`Error processing approval: ${err.message}`);
  }
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

    // Atomic claim: rename the file so new writes go to a fresh file
    // This prevents TOCTOU races with heartbeat scripts appending concurrently
    const claimedFile = NOTIFY_FILE + ".draining";
    try {
      const { renameSync } = await import("fs");
      renameSync(NOTIFY_FILE, claimedFile);
    } catch (err: any) {
      if (err.code === "ENOENT") return; // File disappeared between check and rename
      throw err;
    }

    const raw = readFileSync(claimedFile, "utf-8").trim();
    if (!raw) {
      unlinkSync(claimedFile);
      return;
    }

    const lines = raw.split("\n").filter(Boolean);
    const failed: string[] = [];

    for (const line of lines) {
      try {
        const notif = JSON.parse(line);
        const channelName: string = notif.channel || "general";
        const task: string = notif.task || "unknown";
        const summary: string = notif.summary || "No summary";

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

        // Pick embed color by task type
        const color = task.includes("fail") || task.includes("error") ? 0xED4245
          : task.includes("reminder") || task.includes("assignment") ? 0xFEE75C
          : task.includes("goodnotes") || task.includes("notes") ? 0x57F287
          : task.includes("deploy") ? 0x5865F2
          : task.includes("linkedin") ? 0x0A66C2
          : task.includes("email") || task.includes("outlook") || task.includes("calendar") ? 0x0078D4
          : 0x2B2D31;

        const embed = new EmbedBuilder()
          .setTitle(task.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()))
          .setDescription(summary.slice(0, 4000))
          .setColor(color)
          .setTimestamp(new Date(notif.timestamp || Date.now()))
          .setFooter({ text: "AI Harness Heartbeat" });

        await targetChannel.send({ embeds: [embed] }).catch((err: any) =>
          console.error(`[NOTIFY] Discord send failed: ${err.message}`)
        );
        console.log(`[NOTIFY] Sent '${task}' to #${channelName}`);
      } catch (err: any) {
        console.error(`[NOTIFY] Failed to process: ${err.message}`);
        failed.push(line);
      }
    }

    if (failed.length > 0) {
      // Write back failed items to the main file (append, not overwrite, in case new items arrived)
      appendFileSync(NOTIFY_FILE, failed.join("\n") + "\n");
    }
    unlinkSync(claimedFile);
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.error(`[NOTIFY] Error: ${err.message}`);
    }
  }
}

// --- Bot Events ---

client.on("clientReady", async () => {
  console.log(`AI Harness bot online as ${client.user?.tag}`);
  console.log(`Allowed users: ${ALLOWED_USER_IDS.join(", ")}`);
  console.log(`Working directory: ${HARNESS_ROOT}`);
  console.log(`Max concurrent processes: ${MAX_CONCURRENT}`);

  // Initialize SQLite database (lazy init happens on first getDb() call)
  console.log("[DB] Initializing SQLite database...");
  getDb(); // Force init on startup
  console.log("[DB] Database ready");

  // Initialize activity stream
  initActivityStream(client);

  // Start subagent watching (now event-driven via FileWatcher)
  startSubagentPolling();

  // Clean up stale subagents from previous runs
  const cleaned = cleanupStale();
  if (cleaned > 0) console.log(`[SUBAGENT] Cleaned up ${cleaned} stale entries`);

  // Recover crashed tasks from previous run
  const recovered = recoverCrashedTasks();
  if (recovered > 0) console.log(`[TASK] Recovered ${recovered} crashed tasks`);

  // Prune old dead-letter entries
  const pruned = pruneDeadLetters(7);
  if (pruned > 0) console.log(`[TASK] Pruned ${pruned} old dead-letter entries`);

  // Sync vault embeddings (non-blocking — runs in background)
  syncEmbeddings().then((stats) => {
    console.log(`[EMBEDDINGS] Vault sync: +${stats.added} ~${stats.updated} -${stats.removed}`);
  }).catch((err) => {
    console.error(`[EMBEDDINGS] Sync failed (non-fatal): ${err.message}`);
  });

  // Watch vault for new/changed files → auto-embed
  watchVaultForEmbeddings();

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

  // Ensure "School" category + "calendar" channel exist
  for (const guild of client.guilds.cache.values()) {
    try {
      let schoolCat = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === "school"
      );
      if (!schoolCat) {
        schoolCat = await guild.channels.create({
          name: "School",
          type: ChannelType.GuildCategory,
          reason: "AI Harness school integration",
        });
        console.log(`[SCHOOL] Created "School" category in ${guild.name}`);
      }
      const calendarCh = guild.channels.cache.find(
        (c) => c.name === "calendar" && c.parentId === schoolCat!.id
      );
      if (!calendarCh) {
        await guild.channels.create({
          name: "calendar",
          type: ChannelType.GuildText,
          parent: schoolCat.id,
          topic: "Canvas iCal feed — assignments, events, and due dates",
          reason: "AI Harness Canvas calendar integration",
        });
        console.log(`[SCHOOL] Created #calendar channel in ${guild.name}`);
      }
      const goodnotesCh = guild.channels.cache.find(
        (c) => c.name === "goodnotes" && c.parentId === schoolCat!.id
      );
      if (!goodnotesCh) {
        await guild.channels.create({
          name: "goodnotes",
          type: ChannelType.GuildText,
          parent: schoolCat.id,
          topic: "GoodNotes PDF export notifications",
          reason: "AI Harness GoodNotes integration",
        });
        console.log(`[SCHOOL] Created #goodnotes channel in ${guild.name}`);
      }
      // Outlook email alerts channel under School
      const outlookCh = guild.channels.cache.find(
        (c) => c.name === "outlook" && c.parentId === schoolCat!.id
      );
      if (!outlookCh) {
        await guild.channels.create({
          name: "outlook",
          type: ChannelType.GuildText,
          parent: schoolCat.id,
          topic: "Outlook email alerts, calendar notifications, watched sender alerts",
          reason: "AI Harness Outlook integration",
        });
        console.log(`[SCHOOL] Created #outlook channel in ${guild.name}`);
      }
      // Per-course channels under School
      const courseChannels = [
        { name: "numerical-methods", topic: "Numerical Methods — notes, assignments, study material" },
        { name: "philosophy", topic: "Intro to Philosophy — notes, assignments, study material" },
        { name: "systems-programming", topic: "Systems Programming (CS 2600) — notes, assignments, study material" },
        { name: "comp-society", topic: "Computers and Society — notes, assignments, study material" },
      ];
      for (const cc of courseChannels) {
        const existing = guild.channels.cache.find(
          (c) => c.name === cc.name && c.parentId === schoolCat!.id
        );
        if (!existing) {
          const newCh = await guild.channels.create({
            name: cc.name,
            type: ChannelType.GuildText,
            parent: schoolCat.id,
            topic: cc.topic,
            reason: "AI Harness per-course academic channel",
          });
          setChannelConfig(newCh.id, { agent: "education" });
          console.log(`[SCHOOL] Created #${cc.name} channel with education agent in ${guild.name}`);
        } else {
          // Ensure education agent is assigned to existing course channels
          const cfg = getChannelConfig(existing.id);
          if (!cfg?.agent) {
            setChannelConfig(existing.id, { agent: "education" });
            console.log(`[SCHOOL] Assigned education agent to existing #${cc.name}`);
          }
        }
      }
    } catch (err: any) {
      console.error(`[SCHOOL] Failed to create school channels: ${err.message}`);
    }
  }

  // Ensure "LinkedIn" channel exists (top-level or under a general category)
  for (const guild of client.guilds.cache.values()) {
    try {
      const linkedinCh = guild.channels.cache.find(
        (c) => c.name === "linkedin" && c.type === ChannelType.GuildText
      );
      if (!linkedinCh) {
        await guild.channels.create({
          name: "linkedin",
          type: ChannelType.GuildText,
          topic: "LinkedIn post drafts, approvals, and published confirmations",
          reason: "AI Harness LinkedIn integration",
        });
        console.log(`[LINKEDIN] Created #linkedin channel in ${guild.name}`);
      }
    } catch (err: any) {
      console.error(`[LINKEDIN] Failed to create linkedin channel: ${err.message}`);
    }
  }

  // Start notification drain polling (keep as-is)
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

  // Download image attachments so Claude can read them
  const imageAttachments = message.attachments.filter(
    (a) => a.contentType?.startsWith("image/") || /\.(png|jpg|jpeg|gif|webp)$/i.test(a.name || "")
  );
  let attachmentPaths: string[] = [];
  if (imageAttachments.size > 0) {
    const imgDir = join(HARNESS_ROOT, "bridges", "discord", ".tmp", "images");
    mkdirSync(imgDir, { recursive: true });
    for (const [, attachment] of imageAttachments) {
      try {
        const ext = (attachment.name || "image.png").split(".").pop() || "png";
        const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
        const filepath = join(imgDir, filename);
        const response = await fetch(attachment.url);
        const buffer = Buffer.from(await response.arrayBuffer());
        writeFileSync(filepath, buffer);
        attachmentPaths.push(filepath);
        console.log(`[IMG] Downloaded ${attachment.name} → ${filepath} (${buffer.length} bytes)`);
      } catch (err: any) {
        console.error(`[IMG] Failed to download ${attachment.name}: ${err.message}`);
      }
    }
  }

  // Build prompt with image references
  let promptText = content;
  if (attachmentPaths.length > 0) {
    const imgRefs = attachmentPaths.map((p) => `[Attached image: ${p}]`).join("\n");
    promptText = `${imgRefs}\n\n${content || "What do you see in this image?"}`;
  }

  if (!promptText.trim()) return;

  // Handle commands first
  if (content.startsWith("/")) {
    const handled = await handleCommand(message, content);
    if (handled) return;
    // If not a recognized command, fall through to Claude
  }

  // !approve / !reject — LinkedIn post approval flow
  const approveTokenMatch = content.match(/^!approve\s+(\S+)$/);
  if (approveTokenMatch) {
    await handleLinkedInApproval(message, approveTokenMatch[1], true);
    return;
  }
  const rejectTokenMatch = content.match(/^!reject\s+(\S+)$/);
  if (rejectTokenMatch) {
    await handleLinkedInApproval(message, rejectTokenMatch[1], false);
    return;
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
      handleClaude(message, promptText).catch(async (err) => {
        await message.reply(`Error: ${err.message}`);
        releaseChannel(channelId);
      });
    },
  };

  const wasQueued = enqueueTask(channelId, task);
  if (wasQueued) {
    await message.react("\u23f3");
  }
});

client.login(DISCORD_TOKEN);
