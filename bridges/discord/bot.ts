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
import { getSession, setSession, clearSession, clearChannelSessions, clearStaleAgentSessions, validateSession } from "./session-store.js";
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
  dequeueHandoff,
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
  statSync,
  renameSync,
} from "fs";
import { join } from "path";
import {
  approveLearning,
  rejectLearning,
  getVaultStats,
} from "./promotion-handler.js";
import { getDb, closeDb } from "./db.js";
import { FileWatcher, trackWatcher, untrackWatcher, stopAllWatchers } from "./file-watcher.js";
import { generateResponsePdf, cleanupPdf } from "./pdf-generator.js";
import {
  submitTask,
  spawnTask,
  getTask,
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
import {
  onGroupComplete,
  getGroupStatus,
  getActiveGroups,
  buildAggregationPrompt,
  cancelGroup,
  getActiveWindowNames,
  pruneOldGroups,
  spawnParallelGroup,
} from "./tmux-orchestrator.js";
import * as tmuxSession from "./tmux-session.js";
import { cleanupOrphanedWorktrees, getActiveWorktrees } from "./worktree-manager.js";
import {
  startDispatcher,
  stopDispatcher,
  onWorkDispatched,
  setPreDispatchInterceptor,
  recoverStuckWork,
  pruneOldWork,
  getWorkStats,
  enqueue,
  cancelWorkItem,
  getRecentWork,
  getPendingWork,
  getRunningWork,
  getWorkItem,
  updateWorkItem,
  setMaxConcurrent,
  setActiveHours,
  getConfig as getWorkQueueConfig,
  approveProposal,
  rejectProposal,
  getProposedWork,
  parseMetadata,
  type WorkItem,
} from "./work-queue.js";
import {
  checkNotificationForWork,
  enqueueManual,
  enqueueCodeReview,
  enqueueIdeation,
  processIdeationOutput,
  enqueueMentoIteration,
  enqueueLeadGenIteration,
  enqueueLatticeIteration,
  enqueueAytmIteration,
  enqueueIaWestIteration,
  buildLatticeDirective,
} from "./work-sources.js";
import {
  registerInstance,
  finalizeInstance,
  processMonitorEvent,
  setMonitorUpdateCallback,
  setMonitorCompletionCallback,
  getCompletedSummary,
  isHoldingContinuation,
  getInterventionNote,
  clearInterventionNote,
} from "./instance-monitor.js";
import {
  initMonitorUI,
  ensureMonitorChannel,
  startMonitorUI,
  stopMonitorUI,
  onInstanceRegistered,
  onInstanceUpdate,
  onInstanceCompleted,
} from "./monitor-ui.js";
import { handleMonitorInteraction } from "./monitor-interventions.js";
import { proc, onShutdown } from "./platform.js";
import { persistTaskTelemetry } from "./task-telemetry.js";

config();

// --- Log Rotation (runs once at startup) ---
// Launchd directs stdout+stderr to bot.log. Rotate if over 5MB to prevent
// hitting the 50MB SoftResourceLimits FileSize cap which causes EFBIG crashes.
const LOG_FILE = join(import.meta.dirname || ".", "bot.log");
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5MB

function rotateLogIfNeeded(): void {
  try {
    if (!existsSync(LOG_FILE)) return;
    const size = statSync(LOG_FILE).size;
    if (size < LOG_MAX_BYTES) return;
    renameSync(LOG_FILE, LOG_FILE + ".1");
    writeFileSync(LOG_FILE, `[LOG ROTATED] Previous log (${(size / 1024 / 1024).toFixed(1)}MB) moved to bot.log.1\n`);
  } catch {}
}
rotateLogIfNeeded();

// PID file to prevent multiple instances
const PID_FILE = join(import.meta.dirname || ".", ".bot.pid");
try {
  if (existsSync(PID_FILE)) {
    const oldPid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    if (proc.isAlive(oldPid)) {
      console.error(`Bot already running (PID ${oldPid}). Exiting.`);
      process.exit(1);
    }
  }
  writeFileSync(PID_FILE, String(process.pid));
  process.on("exit", () => {
    try {
      unlinkSync(PID_FILE);
    } catch {}
    stopDispatcher();
    stopAllWatchers();
    stopEmbeddingWatchers();
    stopMonitorUI();
    closeDb();
  });
  onShutdown(() => process.exit(0));
} catch {}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";
const MAX_DISCORD_LENGTH = 1900;
const PDF_THRESHOLD = 3800; // Generate PDF when response exceeds ~2 Discord messages
// No concurrency cap — let API rate limits be the natural throttle
// const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_PROCESSES || "5", 10);

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
import { releaseChannel, enqueueTask, type QueuedTask } from "./channel-queue.js";

// Track stream pollers and stream messages for active tasks
const activeStreamPollers: Map<string, StreamPoller> = new Map(); // taskId → StreamPoller
const activeStreamMessages: Map<string, Message> = new Map(); // taskId → Discord stream message

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
  if (!ctx) {
    // Re-attached or orphaned task — try to post response to the original channel
    const task = getTask(taskId);

    // Check if this is an ideation-generation task completing
    if (task && response) {
      // Search work queue for this task_id — check if it's ideation output
      try {
        const db = getDb();
        const wqItem = db.prepare(
          "SELECT * FROM work_queue WHERE task_id = ? AND source = 'ideation-gen' LIMIT 1"
        ).get(taskId) as WorkItem | undefined;
        if (wqItem) {
          console.log(`[IDEATION] Processing output for ${taskId} (${response.length} chars)`);
          const proposalIds = processIdeationOutput(response, wqItem.channel_id);
          console.log(`[IDEATION] processIdeationOutput returned ${proposalIds.length} proposals`);
          if (proposalIds.length > 0) {
            const ch = client.channels.cache.get(wqItem.channel_id) as TextChannel | undefined;
            if (ch) {
              const proposals = getProposedWork().filter(p => proposalIds.includes(p.id));
              const lines = proposals.map(p => {
                const meta = parseMetadata(p);
                return `**${meta.title}** (${meta.category}) — ${meta.estimatedEffort || "?"}\n> ${meta.rationale}\n\`/work approve ${p.id}\` or \`/work reject ${p.id}\``;
              });
              await ch.send(`**New project ideas** (${proposals.length}):\n\n${lines.join("\n\n")}`);
            }
          }
          // Clean up monitor and return — don't post raw ideation JSON
          finalizeInstance(taskId, "completed");
          return;
        }
      } catch (err: any) {
        console.error(`[IDEATION] Output processing error: ${err.message}`);
      }
    }

    if (task && response) {
      console.log(`[OUTPUT] Orphaned task ${taskId} completed with response — posting to channel ${task.channel_id}`);
      try {
        const channel = client.channels.cache.get(task.channel_id) as TextChannel | undefined;
        if (channel) {
          const chunks = splitMessage(response);
          for (const chunk of chunks.slice(0, 5)) {
            await channel.send(chunk);
          }
        }
      } catch (err: any) {
        console.error(`[OUTPUT] Failed to post orphaned task response: ${err.message}`);
      }
    } else {
      console.log(`[OUTPUT] No context for task ${taskId} — skipping (re-attached or orphaned)`);
    }
    // Clean up monitor
    finalizeInstance(taskId, "completed");
    return;
  }

  console.log(`[OUTPUT] Processing task ${taskId}: response=${response ? response.length + ' chars' : 'null'}, error=${error ? error.slice(0, 100) : 'null'}`);

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
    } catch (err: any) {
      console.warn(`[BOT] Failed to update continuation stream message: ${err.message}`);
    }
    return;
  }

  // Task is finished (completed or dead)
  pendingTaskContexts.delete(taskId);
  const streamMessage = activeStreamMessages.get(taskId);
  activeStreamMessages.delete(taskId);

  // Update instance monitor + persist telemetry
  const telemetry = getCompletedSummary(taskId);
  finalizeInstance(taskId, task?.status === "dead" ? "failed" : "completed");
  if (telemetry && task) {
    try {
      persistTaskTelemetry({
        taskId,
        channelId: task.channel_id,
        agent: task.agent || "default",
        runtime: task.runtime,
        prompt: task.prompt || "",
        status: task.status,
        telemetry,
        error,
      });
    } catch (err: any) {
      console.error(`[TELEMETRY] Failed to persist: ${err.message}`);
    }
  }

  // Clean up stream directory
  try {
    const files = readdirSync(ctx.streamDir);
    for (const f of files) unlinkSync(join(ctx.streamDir, f));
    unlinkSync(ctx.streamDir);
  } catch (err: any) {
    console.warn(`[BOT] Stream dir cleanup failed: ${err.message}`);
  }

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

    // Check for handoff in project channels.
    // Prefer the harness_handoff tool's queue over text-based [HANDOFF:]
    // parsing — the tool is a more reliable signal than regex on free text.
    // Fall back to parseHandoff so existing text directives still work.
    const handoffSessionKey = project && agentName ? getProjectSessionKey(channelId, agentName) : null;
    const queuedHandoff = handoffSessionKey ? dequeueHandoff(handoffSessionKey) : null;
    const handoff = queuedHandoff ?? parseHandoff(response);
    if (project && agentName && handoff) {
      try {
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
      } catch (err: any) {
        console.error(`[BOT] Failed to send handoff pre-text: ${err.message}`);
        try {
          await (channel as TextChannel).send(`*Failed to deliver agent response (${err.message})*`).catch(() => {});
        } catch {}
      }

      const chainResult = await runHandoffChain(
        channel as TextChannel,
        agentName,
        response,
        { originAgent: agentName }
      );

      // If parallel group was spawned, chain is suspended — don't release channel yet
      if (chainResult.parallelGroupId) {
        console.log(`[BOT] Chain suspended for parallel group ${chainResult.parallelGroupId}`);
        await (channel as TextChannel).send(
          `**Orchestrator** spawned parallel tasks. Group: \`${chainResult.parallelGroupId}\`\nUse \`/tmux\` to monitor.`
        ).catch(() => {});
        postAgentComplete(ctx.activity, response).catch(() => {});
        releaseChannel(channelId);
        return;
      }

      // If orchestrator started the chain and there were multiple agents, trigger debrief
      if (agentName === "orchestrator" && chainResult.entries.length > 1) {
        await invokeOrchestratorDebrief(channel as TextChannel, chainResult);
      }

      postAgentComplete(ctx.activity, response).catch(() => {});
      releaseChannel(channelId);
      return;
    }

    // Normal response — if too long, generate PDF instead of splitting into many messages
    const chunks = splitMessage(response);

    if (response.length > PDF_THRESHOLD) {
      // Generate PDF of full response
      const channelName = (message.channel as TextChannel).name ?? "unknown";
      let pdfPath: string | null = null;
      try {
        pdfPath = await generateResponsePdf(response, {
          agent: ctx.agentName,
          channel: channelName,
          query: ctx.userText,
        });
        // Post a summary (first chunk) + PDF attachment
        const summary = chunks[0] + `\n\n*Full response attached as PDF (${chunks.length} sections, ${response.length.toLocaleString()} chars)*`;
        if (streamMessage) {
          await streamMessage.edit({ content: summary, files: [{ attachment: pdfPath, name: "response.pdf" }] });
        } else {
          await message.reply({ content: summary, files: [{ attachment: pdfPath, name: "response.pdf" }] });
        }
      } catch (pdfErr) {
        // PDF generation failed — fall back to chunked messages
        console.warn("[PDF] Generation failed, falling back to chunked messages:", pdfErr);
        const MAX_RESPONSE_MESSAGES = 5;
        const cappedChunks = chunks.slice(0, MAX_RESPONSE_MESSAGES);
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
        if (chunks.length > MAX_RESPONSE_MESSAGES) {
          await message.reply(`*(Response truncated — ${chunks.length - MAX_RESPONSE_MESSAGES} additional messages omitted.)*`);
        }
      } finally {
        if (pdfPath) cleanupPdf(pdfPath);
      }
    } else {
      // Short enough — post as regular messages
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
    }

    postAgentComplete(ctx.activity, response).catch(() => {});
  } else {
    console.error("[PARSE ERROR] No response text from task output (result field was empty — possible permission denial or empty turn)");
    const errMsg = "Task completed but returned no text. This usually happens when a tool permission was denied at the end of a turn.";
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
  }).catch((err) => console.error(`[BOT] Failed to post agent start: ${err.message}`));

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
    await message.reply("Failed to spawn runtime process.");
    releaseChannel(channelId);
    return;
  }

  activity.runtime = spawnResult.runtime;

  // Register with instance monitor
  registerInstance({
    taskId,
    channelId,
    agent: agentName || "default",
    runtime: spawnResult.runtime,
    prompt: userText,
    pid: spawnResult.pid,
  });

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
  }, {
    monitorCallback: (event) => processMonitorEvent(taskId, event),
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
    proc.terminate(pid);
    // Defense-in-depth: cancelChannelTasks touches SQLite. An uncaught
    // throw here previously crashed the bot, which launchd then
    // restarted, which triggered crash-recovery to RETRY the task —
    // the opposite of what /stop should do. See vault learning
    // ERR-cancel-channel-tasks-sql-bind-bot-crash.
    try {
      cancelChannelTasks(channelId);
    } catch (err) {
      console.error(`[STOP] cancelChannelTasks failed for ${channelId}:`, err);
    }
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

  // /reload-agents — clear sessions older than their agent.md mtime so edits
  // to .claude/agents/*.md take effect on the next message instead of being
  // masked by a resumed session that pre-dates the edit.
  if (content === "/reload-agents") {
    const agentNames = listAgents();
    const agentsDir = join(HARNESS_ROOT, ".claude", "agents");
    const mtimes = new Map<string, number>();
    for (const name of agentNames) {
      try {
        mtimes.set(name, statSync(join(agentsDir, `${name}.md`)).mtimeMs);
      } catch {
        // Skip agents whose file is missing
      }
    }

    const results = clearStaleAgentSessions(mtimes);
    const total = results.reduce((sum, r) => sum + r.cleared, 0);

    if (total === 0) {
      await message.reply(
        "No stale agent sessions. All sessions are newer than their agent.md files."
      );
    } else {
      const lines = results
        .map((r) => `• \`${r.agent}\` — ${r.cleared} session(s)`)
        .join("\n");
      await message.reply(
        `Cleared ${total} stale session(s):\n${lines}\n\n*Non-project channels: use \`/new\` to refresh.*`
      );
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
        `Failed to spawn subagent. Check logs for details.`
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

  // /wal-fix — force WAL checkpoint (TRUNCATE) to reclaim disk space
  if (content === "/wal-fix") {
    const db = getDb();
    try {
      const result = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number; log: number; checkpointed: number }[];
      const { busy, log, checkpointed } = result[0];
      await message.reply(
        `**WAL Checkpoint (TRUNCATE) complete:**\n• Pages in WAL: ${log}\n• Pages checkpointed: ${checkpointed}\n• Busy (not checkpointed): ${busy}`
      );
    } catch (err: any) {
      await message.reply(`WAL checkpoint failed: ${err.message}`);
    }
    return true;
  }

  // /restart — graceful bot restart via platform scheduler
  if (content === "/restart") {
    await message.reply("Restarting bot... (scheduler will bring it back in ~30s)");
    // Exit with non-zero code so the scheduler's keep-alive restarts us
    setTimeout(() => process.exit(75), 1000);
    return true;
  }

  // /tmux — parallel orchestration management
  if (content === "/tmux" || content.startsWith("/tmux ")) {
    const subCmd = content.slice(5).trim();

    if (!subCmd || subCmd === "list") {
      // List tmux windows and active parallel groups
      const windows = tmuxSession.listWindows();
      const groups = getActiveGroups();

      let text = `**tmux session:** ${tmuxSession.isSessionAlive() ? "alive" : "dead"}\n`;
      text += `**Windows:** ${windows.length}\n`;
      for (const w of windows) {
        text += `  - \`${w.name}\`${w.active ? " (active)" : ""}\n`;
      }

      if (groups.length > 0) {
        text += `\n**Active parallel groups:** ${groups.length}\n`;
        for (const g of groups) {
          text += `  \`${g.groupId}\`: ${g.tasks.map((t) => `${t.agent}(${t.status})`).join(", ")}\n`;
        }
      } else {
        text += "\nNo active parallel groups.";
      }

      await message.reply(text);
      return true;
    }

    if (subCmd === "attach") {
      await message.reply(`Attach to the tmux session:\n\`\`\`\n${tmuxSession.getAttachCommand()}\n\`\`\``);
      return true;
    }

    if (subCmd.startsWith("capture ")) {
      const winName = subCmd.slice(8).trim();
      const output = tmuxSession.capturePane(winName, 30);
      if (output) {
        await message.reply(`**tmux capture** \`${winName}\`:\n\`\`\`\n${output.slice(0, 1800)}\n\`\`\``);
      } else {
        await message.reply(`Window \`${winName}\` not found or empty.`);
      }
      return true;
    }

    if (subCmd.startsWith("kill ")) {
      const target = subCmd.slice(5).trim();
      // Check if it's a group ID
      const status = getGroupStatus(target);
      if (status) {
        const cancelled = cancelGroup(target);
        await message.reply(`Cancelled ${cancelled} task(s) in group \`${target}\`.`);
      } else {
        const killed = tmuxSession.killWindow(target);
        await message.reply(killed ? `Killed window \`${target}\`.` : `Window \`${target}\` not found.`);
      }
      return true;
    }

    await message.reply("Usage: `/tmux [list|attach|capture <window>|kill <window|groupId>]`");
    return true;
  }

  // /help — list all commands
  if (content === "/help") {
    const embed = new EmbedBuilder()
      .setTitle("📋 Available Commands")
      .setColor(0x5865F2)
      .addFields(
        {
          name: "Session",
          value: [
            "`/stop` — Kill the active request",
            "`/new` — Clear session, start fresh",
            "`/status` — Show current session info",
          ].join("\n"),
          inline: true,
        },
        {
          name: "Agents",
          value: [
            "`/agents` — List available agents",
            "`/agent <name>` — Set channel agent",
            "`/agent clear` — Remove agent override",
            "`/agent create <name> \"desc\"` — Create agent",
            "`/reload-agents` — Clear sessions older than agent.md edits",
            "`/model <name>` — Set channel model",
            "`/config` — Show channel config",
          ].join("\n"),
          inline: true,
        },
        {
          name: "Background Tasks",
          value: [
            "`/spawn [--agent <name>] <task>` — Spawn subagent",
            "`/tasks` — List running subagents",
            "`/cancel <id>` — Cancel a subagent",
          ].join("\n"),
          inline: true,
        },
        {
          name: "Channels & Projects",
          value: [
            "`/channel create <name>` — Create a channel",
            "`/project create <name> \"desc\"` — Create project",
            "`/project adopt` — Register channel as project",
            "`/project list` — List active projects",
            "`/project agents <a1,a2>` — Set project agents",
            "`/project close` — Archive project",
          ].join("\n"),
          inline: true,
        },
        {
          name: "Vault & Learning",
          value: [
            "`/vault-status` — Vault stats & promotions",
            "`/approve <id>` — Approve learning promotion",
            "`/reject <id>` — Reject learning promotion",
          ].join("\n"),
          inline: true,
        },
        {
          name: "Infrastructure",
          value: [
            "`/dead-letter` — List failed tasks",
            "`/retry <id>` — Re-enqueue failed task",
            "`/db-status` — Database stats",
            "`/wal-fix` — Force WAL checkpoint (TRUNCATE)",
            "`/restart` — Restart the bot",
          ].join("\n"),
          inline: true,
        },
        {
          name: "Parallel Orchestration",
          value: [
            "`/tmux` — List tmux windows & groups",
            "`/tmux attach` — Get attach command",
            "`/tmux capture <win>` — Show window output",
            "`/tmux kill <win|group>` — Kill window/group",
          ].join("\n"),
          inline: true,
        },
        {
          name: "LinkedIn",
          value: [
            "`!approve <token>` — Approve post draft",
            "`!reject <token>` — Reject post draft",
          ].join("\n"),
          inline: true,
        },
        {
          name: "Work Queue",
          value: [
            "`/work` — Queue status overview",
            "`/work add <prompt>` — Enqueue manual work",
            "`/work list` — List pending/running items",
            "`/work ideas` — View project proposals",
            "`/work ideate` — Generate new ideas",
            "`/work approve <id>` — Approve an idea",
            "`/work reject <id>` — Reject an idea",
          ].join("\n"),
          inline: true,
        },
      )
      .setFooter({ text: "Type /help to see this message" });
    await message.reply({ embeds: [embed] });
    return true;
  }

  // /work — Autonomous Work Queue commands
  if (content === "/work" || content.startsWith("/work ")) {
    const args = content.slice(5).trim();

    // /work (no args) — status overview
    if (!args) {
      const stats = getWorkStats();
      const running = getRunningWork();
      const config = getWorkQueueConfig();
      const lines = [
        `**Work Queue Status**`,
        `Ideas: **${stats.proposed}** | Pending: **${stats.pending}** | Gated: **${stats.gated}** | Running: **${stats.running}**`,
        `Completed: ${stats.completed} | Failed: ${stats.failed} | Cancelled: ${stats.cancelled}`,
        `Capacity: ${running.length}/${config.maxConcurrent} | Hours: ${config.activeHoursStart}:00-${config.activeHoursEnd}:00`,
      ];
      if (running.length > 0) {
        lines.push("", "**Running:**");
        for (const item of running) {
          lines.push(`• \`${item.id}\` (${item.source}) — ${item.prompt.slice(0, 80)}...`);
        }
      }
      await message.reply(lines.join("\n"));
      return true;
    }

    // /work add <prompt> [--agent <name>] [--priority <n>]
    if (args.startsWith("add ")) {
      let prompt = args.slice(4).trim();
      let agent: string | undefined;
      let priority: number | undefined;

      const agentMatch = prompt.match(/--agent\s+(\w+)/);
      if (agentMatch) {
        agent = agentMatch[1];
        prompt = prompt.replace(agentMatch[0], "").trim();
      }
      const priorityMatch = prompt.match(/--priority\s+(\d+)/);
      if (priorityMatch) {
        priority = parseInt(priorityMatch[1], 10);
        prompt = prompt.replace(priorityMatch[0], "").trim();
      }

      if (!prompt) {
        await message.reply("Usage: `/work add <prompt> [--agent <name>] [--priority <n>]`");
        return true;
      }

      const id = enqueueManual({ channelId, prompt, agent, priority });
      await message.reply(`Enqueued: \`${id}\`\nPrompt: ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}`);
      return true;
    }

    // /work list [pending|running|all]
    if (args === "list" || args.startsWith("list ")) {
      const filter = args.slice(4).trim() || "pending";
      let items: WorkItem[];
      if (filter === "running") {
        items = getRunningWork();
      } else if (filter === "all") {
        items = getRecentWork(20);
      } else {
        items = getPendingWork();
      }

      if (items.length === 0) {
        await message.reply(`No ${filter} work items.`);
        return true;
      }

      const lines = items.slice(0, 15).map((item) => {
        const age = Math.round((Date.now() - new Date(item.created_at).getTime()) / 60000);
        return `\`${item.id}\` [${item.status}] P${item.priority} (${item.source}) ${age}m ago — ${item.prompt.slice(0, 60)}...`;
      });
      await message.reply(`**Work Queue — ${filter}** (${items.length} items)\n${lines.join("\n")}`);
      return true;
    }

    // /work cancel <id>
    if (args.startsWith("cancel ")) {
      const id = args.slice(7).trim();
      if (cancelWorkItem(id)) {
        await message.reply(`Cancelled: \`${id}\``);
      } else {
        await message.reply(`Could not cancel \`${id}\` (not found or already done).`);
      }
      return true;
    }

    // /work config
    if (args === "config") {
      const config = getWorkQueueConfig();
      await message.reply([
        "**Work Queue Config**",
        `Max concurrent: ${config.maxConcurrent}`,
        `Active hours: ${config.activeHoursStart}:00-${config.activeHoursEnd}:00`,
        `Dispatch interval: ${config.dispatchIntervalMs / 1000}s`,
      ].join("\n"));
      return true;
    }

    // /work set <key> <value>
    if (args.startsWith("set ")) {
      const parts = args.slice(4).trim().split(/\s+/);
      const key = parts[0];
      const value = parts[1];

      if (key === "concurrent" && value) {
        setMaxConcurrent(parseInt(value, 10));
        await message.reply(`Max concurrent set to ${value}`);
        return true;
      }
      if (key === "hours" && value) {
        const [start, end] = value.split("-").map(Number);
        if (!isNaN(start) && !isNaN(end)) {
          setActiveHours(start, end);
          await message.reply(`Active hours set to ${start}:00-${end}:00`);
          return true;
        }
      }
      await message.reply("Usage: `/work set concurrent <n>` or `/work set hours <start>-<end>`");
      return true;
    }

    // /work ideas — show proposed ideas awaiting approval
    if (args === "ideas") {
      const proposals = getProposedWork();
      if (proposals.length === 0) {
        await message.reply("No project ideas pending approval. Use `/work ideate` to generate some.");
        return true;
      }

      const lines = proposals.map((p) => {
        const meta = parseMetadata(p);
        const age = Math.round((Date.now() - new Date(p.created_at).getTime()) / 3600000);
        return `**${meta.title || "Untitled"}** [${meta.category || "?"}] (${meta.estimatedEffort || "?"}) — ${age}h ago\n> ${(meta.rationale || "").slice(0, 150)}\n\`/work approve ${p.id}\` · \`/work reject ${p.id}\``;
      });
      await message.reply(`**Project Ideas** (${proposals.length} awaiting approval)\n\n${lines.join("\n\n")}`);
      return true;
    }

    // /work ideate — trigger idea generation now
    if (args === "ideate") {
      const id = enqueueIdeation({ channelId });
      if (id) {
        await message.reply(`Ideation task enqueued: \`${id}\`. Ideas will appear when the researcher finishes.`);
      } else {
        await message.reply("Skipped — already have enough proposals pending. Review them with `/work ideas`.");
      }
      return true;
    }

    // /work approve <id>
    if (args.startsWith("approve ")) {
      const id = args.slice(8).trim();
      if (approveProposal(id)) {
        const item = getWorkItem(id);
        const meta = item ? parseMetadata(item) : {};
        await message.reply(`Approved: **${meta.title || id}** — now in queue for execution.`);
      } else {
        await message.reply(`Could not approve \`${id}\` — not found or not in proposed state.`);
      }
      return true;
    }

    // /work reject <id>
    if (args.startsWith("reject ")) {
      const id = args.slice(7).trim();
      if (rejectProposal(id)) {
        await message.reply(`Rejected: \`${id}\``);
      } else {
        await message.reply(`Could not reject \`${id}\` — not found or not in proposed state.`);
      }
      return true;
    }

    await message.reply("Unknown /work subcommand. Try `/work`, `/work add`, `/work list`, `/work cancel`, `/work config`, `/work set`, `/work ideas`, `/work ideate`, `/work approve`, `/work reject`.");
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
// Two notification paths exist: heartbeat scripts use heartbeat-tasks/, while
// work-sources.ts, lead-gen, and Agent Teams hooks use the project root.
// Drain both to prevent pile-up.
const NOTIFY_FILES = [
  join(HARNESS_ROOT, "heartbeat-tasks", "pending-notifications.jsonl"),
  join(HARNESS_ROOT, "pending-notifications.jsonl"),
];
const NOTIFY_POLL_MS = 60_000;

async function drainNotifications(): Promise<void> {
  for (const notifyFile of NOTIFY_FILES) {
    try {
      if (!existsSync(notifyFile)) continue;

      // Atomic claim: rename the file so new writes go to a fresh file
      // This prevents TOCTOU races with heartbeat scripts appending concurrently
      const claimedFile = notifyFile + ".draining";
      try {
        renameSync(notifyFile, claimedFile);
      } catch (err: any) {
        if (err.code === "ENOENT") continue; // File disappeared between check and rename
        throw err;
      }

      const raw = readFileSync(claimedFile, "utf-8").trim();
      if (!raw) {
        unlinkSync(claimedFile);
        continue;
      }

      const lines = raw.split("\n").filter(Boolean);
      const failed: string[] = [];

      for (const line of lines) {
        try {
          const notif = JSON.parse(line);
          const channelName: string = notif.channel || "general";
          const task: string = notif.task || notif.source || "unknown";
          const summary: string = notif.summary || notif.message || "No summary";

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

          // Check if this notification carries work-queue directives
          const workId = checkNotificationForWork(notif, targetChannel.id);
          if (workId) {
            console.log(`[NOTIFY] Enqueued work ${workId} from '${task}' notification`);
          }

          // Pick embed color by task type
          const color = task.includes("fail") || task.includes("error") ? 0xED4245
            : task.includes("reminder") || task.includes("assignment") ? 0xFEE75C
            : task.includes("goodnotes") || task.includes("notes") ? 0x57F287
            : task.includes("deploy") ? 0x5865F2
            : task.includes("linkedin") ? 0x0A66C2
            : task.includes("email") || task.includes("emails") || task.includes("calendar") ? 0x0078D4
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
        // Write back failed items to the same file (append, not overwrite, in case new items arrived)
        appendFileSync(notifyFile, failed.join("\n") + "\n");
      }
      unlinkSync(claimedFile);
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        console.error(`[NOTIFY] Error draining ${notifyFile}: ${err.message}`);
      }
    }
  }
}

// --- Bot Events ---

client.on("clientReady", async () => {
  console.log(`AI Harness bot online as ${client.user?.tag}`);
  console.log(`Allowed users: ${ALLOWED_USER_IDS.join(", ")}`);
  console.log(`Working directory: ${HARNESS_ROOT}`);
  console.log(`Concurrency: unlimited (API rate-limited)`);

  // Initialize SQLite database (lazy init happens on first getDb() call)
  console.log("[DB] Initializing SQLite database...");
  getDb(); // Force init on startup
  console.log("[DB] Database ready");

  // Initialize instance monitor
  initMonitorUI(client);
  setMonitorUpdateCallback((instance) => {
    if (!instance.monitorMessageId) {
      onInstanceRegistered(instance).catch(() => {});
    } else {
      onInstanceUpdate(instance).catch(() => {});
    }
  });
  setMonitorCompletionCallback((instance) => {
    onInstanceCompleted(instance).catch(() => {});
  });
  startMonitorUI();
  await ensureMonitorChannel();
  console.log("[MONITOR] Instance monitor initialized");

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

  // Initialize tmux session for parallel orchestration
  tmuxSession.ensureSession();
  tmuxSession.cleanupDeadWindows(getActiveWindowNames());
  pruneOldGroups(7);

  // Clean up orphaned worktrees from previous runs
  const wtCleaned = cleanupOrphanedWorktrees();
  if (wtCleaned > 0) console.log(`[WORKTREE] Cleaned ${wtCleaned} orphaned worktree(s) on startup`);
  const activeWt = getActiveWorktrees();
  if (activeWt.length > 0) console.log(`[WORKTREE] ${activeWt.length} active worktree(s)`);

  // Periodic worktree cleanup (every 30 min)
  setInterval(() => {
    try { cleanupOrphanedWorktrees(); } catch (err: any) {
      console.error(`[WORKTREE] Periodic cleanup error: ${err.message}`);
    }
  }, 30 * 60 * 1000);

  // ─── Autonomous Work Queue ───────────────────────────────────────────
  recoverStuckWork();
  const wqPruned = pruneOldWork(7);
  if (wqPruned > 0) console.log(`[WORK-QUEUE] Pruned ${wqPruned} old items`);

  onWorkDispatched(async (item, taskId) => {
    try {
      const ch = client.channels.cache.get(item.channel_id) as TextChannel | undefined;
      if (ch) {
        const meta = parseMetadata(item);
        const label = meta.project ? `[${meta.project}]` : `[${item.source}]`;
        // Extract first sentence as summary, strip markdown noise
        const cleaned = item.prompt.replace(/\*\*[A-Z ]+:\*\*/g, "").replace(/[*#_`]/g, "");
        const firstSentence = cleaned.match(/^[^\n.!?]*[.!?]?/)?.[0]?.trim() || "";
        const summary = firstSentence.slice(0, 80) + (firstSentence.length > 80 ? "..." : "");
        await ch.send(`**[Auto]** ${label} ${summary || "Task started"}`);
      }
    } catch (err: any) {
      console.error(`[WORK-QUEUE] Dispatch notification error: ${err.message}`);
    }
  });

  // Pre-dispatch interceptor for parallel spawns (lattice)
  setPreDispatchInterceptor(async (item) => {
    if (item.prompt !== "[LATTICE_PARALLEL_SPAWN]") return false;

    try {
      const directive = buildLatticeDirective();
      const groupId = await spawnParallelGroup({
        channelId: item.channel_id,
        directive: { agents: directive.agents, tasks: directive.tasks },
      });

      updateWorkItem(item.id, {
        status: "running",
        started_at: new Date().toISOString(),
        metadata: JSON.stringify({
          ...parseMetadata(item),
          parallelGroupId: groupId,
        }),
      });

      const ch = client.channels.cache.get(item.channel_id) as TextChannel | undefined;
      if (ch) {
        const features = [...directive.tasks.values()].map(t => {
          const match = t.match(/YOUR SPECIFIC TASK:\n(.+)/);
          return match ? match[1].slice(0, 60) : "creative feature";
        });
        await ch.send(
          `**[Auto] [lattice]** Spawned 4 parallel builders (group \`${groupId}\`)\n` +
          features.map((f, i) => `• builder-${i + 1}: ${f}...`).join("\n")
        );
      }

      console.log(`[WORK-QUEUE] Lattice parallel spawn: group ${groupId}, 4 builders`);
      return true;
    } catch (err: any) {
      console.error(`[WORK-QUEUE] Lattice parallel spawn failed: ${err.message}`);
      updateWorkItem(item.id, { status: "failed", last_error: err.message });
      return true; // Handled (even if failed) — don't try normal dispatch
    }
  });

  startDispatcher();
  const wqStats = getWorkStats();
  console.log(`[WORK-QUEUE] Ready: ${wqStats.pending} pending, ${wqStats.gated} gated, ${wqStats.running} running`);

  // Periodic work queue maintenance (every 30 min)
  setInterval(() => {
    try {
      const recovered = recoverStuckWork();
      const pruned = pruneOldWork(7);
      if (recovered > 0 || pruned > 0) {
        console.log(`[WORK-QUEUE] Maintenance: recovered=${recovered}, pruned=${pruned}`);
      }
    } catch (err: any) {
      console.error(`[WORK-QUEUE] Maintenance error: ${err.message}`);
    }
  }, 30 * 60 * 1000);

  // Periodic ideation — DISABLED (2026-03-24) to conserve weekly API limits
  // Re-enable by uncommenting when budget allows
  // const IDEATION_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours
  // setInterval(() => {
  //   try {
  //     for (const guild of client.guilds.cache.values()) {
  //       const ch = guild.channels.cache.find(
  //         (c) => c.name === "general" && c.isTextBased() && c.type === ChannelType.GuildText
  //       ) as TextChannel | undefined;
  //       if (ch) {
  //         enqueueIdeation({ channelId: ch.id });
  //         break;
  //       }
  //     }
  //   } catch (err: any) {
  //     console.error(`[IDEATION] Periodic trigger error: ${err.message}`);
  //   }
  // }, IDEATION_INTERVAL_MS);
  console.log(`[IDEATION] Periodic ideation DISABLED (conserving API limits)`);

  // ─── Continuous Project Iteration ──────────────────────────────────────
  // Mento: every 3.5 hours, works on harness/auto-dev branch, never pushes to main
  const MENTO_INTERVAL_MS = 3.5 * 60 * 60 * 1000;
  // Lead-gen: every 1 hour, no paid tools (Brightdata blocked)
  const LEAD_GEN_INTERVAL_MS = 1 * 60 * 60 * 1000;

  // Helper to resolve a project's Discord channel
  function resolveProjectChannel(channelName: string): TextChannel | null {
    for (const guild of client.guilds.cache.values()) {
      // Check both exact name and proj- prefixed name (createProject adds prefix)
      const ch = guild.channels.cache.find(
        (c) => (c.name === channelName || c.name === `proj-${channelName}`) &&
          c.isTextBased() && c.type === ChannelType.GuildText
      ) as TextChannel | undefined;
      if (ch) return ch;
    }
    return null;
  }

  // Mento auto-iteration: DISABLED (2026-04-15) — weekly credit limit
  // setInterval(() => {
  //   try {
  //     const ch = resolveProjectChannel("mento");
  //     if (ch) enqueueMentoIteration(ch.id);
  //   } catch (err: any) {
  //     console.error(`[PROJECT-ITER] Mento trigger error: ${err.message}`);
  //   }
  // }, MENTO_INTERVAL_MS);

  // Lead-gen auto-iteration: DISABLED by user request (2026-03-25)
  // setInterval(() => {
  //   try {
  //     const ch = resolveProjectChannel("lead-gen-pipeline");
  //     if (ch) enqueueLeadGenIteration(ch.id);
  //   } catch (err: any) {
  //     console.error(`[PROJECT-ITER] Lead-gen trigger error: ${err.message}`);
  //   }
  // }, LEAD_GEN_INTERVAL_MS);

  // Lattice: disabled — using heartbeat task (6h, active hours only) to conserve credits
  // const LATTICE_INTERVAL_MS = 4 * 60 * 60 * 1000;
  // setInterval(() => {
  //   try {
  //     const ch = resolveProjectChannel("lattice");
  //     if (ch) enqueueLatticeIteration(ch.id);
  //   } catch (err: any) {
  //     console.error(`[PROJECT-ITER] Lattice trigger error: ${err.message}`);
  //   }
  // }, LATTICE_INTERVAL_MS);

  // Hackathon: DISABLED 2026-04-06 — user request to stop iterations
  // const HACKATHON_INTERVAL_MS = 2 * 60 * 60 * 1000;
  // setInterval(() => {
  //   try {
  //     const aytmCh = resolveProjectChannel("aytm-research");
  //     if (aytmCh) enqueueAytmIteration(aytmCh.id);
  //   } catch (err: any) {
  //     console.error(`[PROJECT-ITER] Aytm trigger error: ${err.message}`);
  //   }
  //   try {
  //     const iaWestCh = resolveProjectChannel("ia-west-match");
  //     if (iaWestCh) enqueueIaWestIteration(iaWestCh.id);
  //   } catch (err: any) {
  //     console.error(`[PROJECT-ITER] IA West trigger error: ${err.message}`);
  //   }
  // }, HACKATHON_INTERVAL_MS);

  console.log(`[PROJECT-ITER] Mento iteration DISABLED (2026-04-15 — weekly credit limit)`);
  console.log(`[PROJECT-ITER] Lead-gen iteration DISABLED (user request 2026-03-25)`);
  console.log(`[PROJECT-ITER] Lattice parallel iteration disabled (using heartbeat task instead)`);
  console.log(`[PROJECT-ITER] Hackathon iteration DISABLED (user request 2026-04-06)`);

  // Handle parallel group completions — feed results back to orchestrator
  onGroupComplete(async (groupId, status) => {
    try {
      const ch = client.channels.cache.get(status.channelId);
      if (!ch || !ch.isTextBased()) return;
      const channel = ch as TextChannel;

      const summary = status.tasks.map((t) => {
        const icon = t.status === "completed" ? "✅" : "❌";
        return `${icon} **${t.agent}**: ${t.status}`;
      }).join("\n");

      await channel.send(`**Parallel group complete** (\`${groupId}\`)\n${summary}`);

      // Feed aggregated results back to the orchestrator
      const aggregation = buildAggregationPrompt(status);
      const taskId = submitTask({
        channelId: status.channelId,
        prompt: aggregation,
        agent: "orchestrator",
        sessionKey: `${status.channelId}:orchestrator`,
      });
      const spawnResult = await spawnTask(taskId);
      if (!spawnResult) {
        await channel.send("*Failed to spawn orchestrator for result synthesis.*");
      }
    } catch (err: any) {
      console.error(`[PARALLEL] Group complete handler error: ${err.message}`);
    }
  });

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
      // Refresh channel cache to avoid creating duplicates on rapid restarts
      await guild.channels.fetch();

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
      // Email alerts channel under School (renamed from #outlook → #emails)
      const oldOutlookCh = guild.channels.cache.find(
        (c) => c.name === "outlook" && c.parentId === schoolCat!.id
      );
      if (oldOutlookCh && "setName" in oldOutlookCh) {
        await (oldOutlookCh as any).setName("emails", "Renamed: #outlook → #emails (now pulling from Gmail)");
        await (oldOutlookCh as any).setTopic("Email alerts, calendar notifications, watched sender alerts");
        console.log(`[SCHOOL] Renamed #outlook → #emails in ${guild.name}`);
      }
      const emailsCh = guild.channels.cache.find(
        (c) => c.name === "emails" && c.parentId === schoolCat!.id
      );
      if (!emailsCh && !oldOutlookCh) {
        await guild.channels.create({
          name: "emails",
          type: ChannelType.GuildText,
          parent: schoolCat.id,
          topic: "Email alerts, calendar notifications, watched sender alerts",
          reason: "AI Harness email integration",
        });
        console.log(`[SCHOOL] Created #emails channel in ${guild.name}`);
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

  // Scheduler category + heartbeat management channels
  for (const guild of client.guilds.cache.values()) {
    try {
      let schedulerCat = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === "scheduler"
      );
      if (!schedulerCat) {
        schedulerCat = await guild.channels.create({
          name: "Scheduler",
          type: ChannelType.GuildCategory,
          reason: "AI Harness heartbeat/scheduling management",
        });
        console.log(`[SCHEDULER] Created "Scheduler" category in ${guild.name}`);
      }
      const schedulerChannels = [
        { name: "heartbeat-status", topic: "Live heartbeat task dashboard and notifications" },
        { name: "task-logs", topic: "Heartbeat task failure details and diagnostic output" },
        { name: "schedule-mgmt", topic: "Create, edit, pause, resume, delete scheduled tasks" },
      ];
      for (const sc of schedulerChannels) {
        const existing = guild.channels.cache.find(
          (c) => c.name === sc.name && c.parentId === schedulerCat!.id
        );
        if (!existing) {
          const newCh = await guild.channels.create({
            name: sc.name,
            type: ChannelType.GuildText,
            parent: schedulerCat.id,
            topic: sc.topic,
            reason: "AI Harness scheduler channel",
          });
          setChannelConfig(newCh.id, { agent: "scheduler" });
          console.log(`[SCHEDULER] Created #${sc.name} channel with scheduler agent in ${guild.name}`);
        } else {
          const cfg = getChannelConfig(existing.id);
          if (!cfg?.agent) {
            setChannelConfig(existing.id, { agent: "scheduler" });
            console.log(`[SCHEDULER] Assigned scheduler agent to existing #${sc.name}`);
          }
        }
      }
    } catch (err: any) {
      console.error(`[SCHEDULER] Failed to create scheduler channels: ${err.message}`);
    }
  }

  // General-purpose channels for parallel task capacity
  for (const guild of client.guilds.cache.values()) {
    try {
      const generalChannels = ["general-2", "general-3", "general-4"];
      for (const name of generalChannels) {
        const existing = guild.channels.cache.find(
          (c) => c.name === name && c.type === ChannelType.GuildText && !c.parentId
        );
        if (!existing) {
          await guild.channels.create({
            name,
            type: ChannelType.GuildText,
            topic: "General purpose AI tasks",
            reason: "AI Harness parallel task capacity",
          });
          console.log(`[GENERAL] Created #${name} channel in ${guild.name}`);
        }
      }
    } catch (err: any) {
      console.error(`[GENERAL] Failed to create general channels: ${err.message}`);
    }
  }

  // LinkedIn channel — uses already-fetched guild cache from above
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

  // Ensure separate hackathon project channels exist (1 per project)
  // NOTE: createProject() prefixes channel names with "proj-", so check for that
  // Ensure separate hackathon project channels exist (1 per project)
  // Guard: check both Discord cache AND SQLite DB before creating
  const hackathonProjects = [
    { name: "aytm-research", desc: "Aytm x Neo Smart Living — simulated market research pipeline. CPP AI Hackathon 2026 ($2K prize). April 16, 2026." },
    { name: "ia-west-match", desc: "IA West Smart Match — AI-powered speaker-event CRM. CPP AI Hackathon 2026 ($2K prize). April 16, 2026." },
  ];
  for (const guild of client.guilds.cache.values()) {
    for (const hp of hackathonProjects) {
      try {
        // Check Discord cache for existing channel
        const existingCh = guild.channels.cache.find(
          (c) => c.name === `proj-${hp.name}` && c.type === ChannelType.GuildText
        );
        // Check SQLite DB for existing project record
        const existingDb = getDb().prepare(
          "SELECT name FROM projects WHERE name = ?"
        ).get(hp.name);
        if (!existingCh && !existingDb) {
          const proj = await createProject(
            guild, hp.name, hp.desc,
            ["orchestrator", "researcher", "builder", "reviewer", "ops"]
          );
          console.log(`[HACKATHON] Created #proj-${hp.name} channel (${proj.channelId}) in ${guild.name}`);
        }
      } catch (err: any) {
        console.error(`[HACKATHON] Failed to create ${hp.name} channel: ${err.message}`);
      }
    }

    // One-time cleanup: delete old duplicate hackathon channels
    const staleNames = ["ai-hackathon", "proj-ai-hackathon", "aytm-research", "ia-west-match"];
    for (const ch of guild.channels.cache.values()) {
      if (ch.type === ChannelType.GuildText && staleNames.includes(ch.name)) {
        try {
          await ch.delete("Replaced by #proj-aytm-research and #proj-ia-west-match");
          console.log(`[HACKATHON] Deleted stale channel #${ch.name} (${ch.id})`);
        } catch (err: any) {
          console.error(`[HACKATHON] Failed to delete #${ch.name}: ${err.message}`);
        }
      }
    }
  }

  // Start notification drain polling (keep as-is)
  setInterval(drainNotifications, NOTIFY_POLL_MS);
  console.log(`[NOTIFY] Polling every ${NOTIFY_POLL_MS / 1000}s`);
});

// --- Monitor Interaction Handler (buttons, select menus, modals) ---
client.on("interactionCreate", async (interaction) => {
  try {
    await handleMonitorInteraction(interaction);
  } catch (err: any) {
    console.error(`[MONITOR] Interaction error: ${err.message}`);
  }
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

  // Fast-path: /restart bypasses everything — no attachment download, no queue check
  if (content === "/restart") {
    await message.reply("Restarting bot... (launchd will bring it back in ~30s)");
    setTimeout(() => process.exit(75), 500);
    return;
  }

  // Download ALL attachments (images, PDFs, files) so Claude can read them
  let attachmentPaths: string[] = [];
  if (message.attachments.size > 0) {
    const attachDir = join(HARNESS_ROOT, "bridges", "discord", ".tmp", "images");
    mkdirSync(attachDir, { recursive: true });
    for (const [, attachment] of message.attachments) {
      try {
        const ext = (attachment.name || "file").split(".").pop() || "bin";
        const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
        const filepath = join(attachDir, filename);
        const response = await fetch(attachment.url);
        const buffer = Buffer.from(await response.arrayBuffer());
        writeFileSync(filepath, buffer);
        attachmentPaths.push(filepath);
        console.log(`[ATTACH] Downloaded ${attachment.name} (${attachment.contentType || 'unknown'}) → ${filepath} (${buffer.length} bytes)`);
      } catch (err: any) {
        console.error(`[ATTACH] Failed to download ${attachment.name}: ${err.message}`);
      }
    }
  }

  // Build prompt with attachment references
  let promptText = content;
  if (attachmentPaths.length > 0) {
    const refs = attachmentPaths.map((p) => {
      const isImage = /\.(png|jpg|jpeg|gif|webp)$/i.test(p);
      const isPdf = /\.pdf$/i.test(p);
      if (isImage) return `Use the Read tool to view this image: ${p}`;
      if (isPdf) return `Use the Read tool to read this PDF: ${p}`;
      return `Use the Read tool to read this file: ${p}`;
    }).join("\n");
    promptText = `${refs}\n\n${content || "What do you see in the attached file(s)?"}`;
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
