/**
 * Gateway Core — Transport-agnostic orchestration engine.
 *
 * Receives messages from any TransportAdapter, manages the task queue,
 * spawns Claude processes, handles output routing, and coordinates
 * agent handoffs.
 *
 * This file contains NO transport-specific code (no Discord imports).
 * All interaction with the outside world goes through the TransportAdapter.
 */

import type {
  TransportAdapter,
  GatewayConfig,
  GatewayMessage,
  PendingTaskEntry,
  CommandResult,
} from "./core-types.js";
import { executeCommand, type CommandContext } from "./core-commands.js";

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
  type DeadLetterRecord,
} from "./task-runner.js";

import { getChannelConfig } from "./channel-config-store.js";
import { getProject } from "./project-manager.js";
import { getProjectSessionKey } from "./handoff-router.js";
import {
  registerInstance,
  finalizeInstance,
  processMonitorEvent,
  getCompletedSummary,
} from "./instance-monitor.js";
import { StreamPoller } from "./stream-poller.js";
import { getDb } from "./db.js";
import { join } from "path";
import { mkdirSync, readdirSync, unlinkSync, existsSync, readFileSync, appendFileSync } from "fs";
import { persistTaskTelemetry } from "./task-telemetry.js";

// ─── Queue System ────────────────────────────────────────────────────

interface QueuedTask {
  execute: () => void;
  message: GatewayMessage;
}

// ─── Gateway Class ───────────────────────────────────────────────────

/**
 * Hook called after a successful task response, before the default send.
 * If it returns true, the response was handled (e.g., handoff chain started)
 * and the gateway skips its default send logic.
 */
export type PostOutputHook = (
  channelId: string,
  response: string,
  agentName: string | undefined,
  originMessageId: string
) => Promise<boolean>;

export class Gateway {
  private adapter: TransportAdapter;
  private config: GatewayConfig;
  private channelQueues = new Map<string, QueuedTask[]>();
  private activeChannels = new Set<string>();
  private pendingTasks = new Map<string, PendingTaskEntry>();
  private activeStreamMessageIds = new Map<string, string>(); // taskId → messageId
  private activeStreamPollers = new Map<string, StreamPoller>();
  private postOutputHook: PostOutputHook | null = null;
  private tempDir: string;
  private streamDir: string;
  private started = false;

  constructor(adapter: TransportAdapter, config: GatewayConfig) {
    this.adapter = adapter;
    this.config = config;
    this.tempDir = join(config.harnessRoot, "bridges", "discord", ".tmp");
    this.streamDir = join(this.tempDir, "streams");
  }

  /**
   * Register a hook that intercepts successful task output before default send.
   * Used by transports to handle handoffs, create-channel directives, etc.
   */
  setPostOutputHook(hook: PostOutputHook): void {
    this.postOutputHook = hook;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;

    try { mkdirSync(this.tempDir, { recursive: true }); } catch {}
    try { mkdirSync(this.streamDir, { recursive: true }); } catch {}

    // Register task output handler
    onTaskOutput(async (taskId, response, error, sessionId, raw) => {
      await this.handleTaskOutput(taskId, response, error, sessionId, raw);
    });

    onTaskDeadLetter(async (record) => {
      await this.handleDeadLetter(record);
    });

    // Recover tasks from before restart
    const recovered = recoverCrashedTasks();
    if (recovered > 0) {
      console.log(`[GATEWAY] Recovered ${recovered} crashed tasks`);
    }

    this.started = true;
    console.log("[GATEWAY] Core started");
  }

  async stop(): Promise<void> {
    for (const poller of this.activeStreamPollers.values()) {
      poller.stop();
    }
    this.activeStreamPollers.clear();
    this.started = false;
    console.log("[GATEWAY] Core stopped");
  }

  // ─── Inbound Message Handling ────────────────────────────────────

  async onMessage(msg: GatewayMessage): Promise<void> {
    // Check allowed users
    if (!this.config.allowedUserIds.includes(msg.userId)) {
      console.log(`[GATEWAY] Blocked message from ${msg.userId} — not in allowed list`);
      return;
    }

    const text = msg.text.trim();
    if (!text && msg.attachmentPaths.length === 0) return;

    // Check for commands (starts with /)
    if (text.startsWith("/")) {
      const parts = text.split(/\s+/);
      const command = parts[0].slice(1); // remove leading /
      const args = parts.slice(1);
      const result = await this.onCommand(msg.channelId, command, args, msg);
      if (result) {
        await this.adapter.sendMessage(msg.channelId, result.text, msg.id);
        return;
      }
    }

    // Normal message — process through Claude
    await this.processMessage(msg);
  }

  // ─── Command Handling ────────────────────────────────────────────

  async onCommand(channelId: string, command: string, args: string[], msg: GatewayMessage): Promise<CommandResult | null> {
    const ctx: CommandContext = {
      channelId,
      userId: msg.userId,
      guildId: msg.guildId,
      rawText: msg.text.trim(),
      releaseChannel: () => this.releaseChannel(channelId),
    };

    return executeCommand(ctx);
  }

  // ─── Core Message Processing ─────────────────────────────────────

  private async processMessage(msg: GatewayMessage): Promise<void> {
    const channelId = msg.channelId;
    const userText = msg.text.trim();

    // Build prompt (with image paths if any)
    let prompt = userText;
    if (msg.attachmentPaths.length > 0) {
      const imgRefs = msg.attachmentPaths.map(p => `[Image: ${p}]`).join("\n");
      prompt = `${imgRefs}\n\n${userText}`;
    }

    // Determine agent and session
    const channelConfig = getChannelConfig(channelId);
    const project = getProject(channelId);
    const agentName = channelConfig?.agent;
    const sessionKey = project
      ? getProjectSessionKey(channelId, agentName || "default")
      : channelId;

    // Enqueue the task
    const isQueued = this.enqueueTask(channelId, {
      message: msg,
      execute: async () => {
        // Submit to task runner
        const taskId = submitTask({
          channelId,
          prompt,
          agent: agentName || undefined,
          sessionKey,
          maxSteps: 10,
          maxAttempts: 3,
        });

        // Spawn the task
        const spawnResult = await spawnTask(taskId);
        if (!spawnResult) {
          await this.adapter.sendMessage(channelId, "Failed to spawn runtime process.", msg.id);
          this.releaseChannel(channelId);
          return;
        }

        // Register with instance monitor
        registerInstance({
          taskId,
          channelId,
          agent: agentName || "default",
          runtime: spawnResult.runtime,
          prompt: userText,
          pid: spawnResult.pid,
        });

        // Store pending task context
        this.pendingTasks.set(taskId, {
          originMessageId: msg.id,
          channelId,
          userId: msg.userId,
          userText,
          agentName: agentName || undefined,
          streamDir: spawnResult.streamDir,
          isRetry: false,
          transportMeta: msg.transportMeta,
        });

        // Set up stream poller for progressive updates
        let lastStreamText = "";
        const streamPoller = new StreamPoller(spawnResult.streamDir, async (text, toolInfo) => {
          try {
            const displayText = toolInfo
              ? `${text}\n\n*${toolInfo}*`
              : text || "Thinking...";
            const truncated = displayText.length > this.adapter.maxMessageLength
              ? displayText.slice(-this.adapter.maxMessageLength)
              : displayText;

            if (truncated === lastStreamText) return;
            lastStreamText = truncated;

            const existingStreamId = this.activeStreamMessageIds.get(taskId);
            if (!existingStreamId) {
              const streamMsgId = await this.adapter.sendMessage(channelId, truncated, msg.id);
              this.activeStreamMessageIds.set(taskId, streamMsgId);
            } else {
              await this.adapter.editMessage(channelId, existingStreamId, truncated);
            }
          } catch {
            // Rate limited or message deleted — ignore
          }
        }, {
          monitorCallback: (event) => processMonitorEvent(taskId, event),
        });

        this.activeStreamPollers.set(taskId, streamPoller);
        streamPoller.start();

        // Typing indicator
        const typingInterval = setInterval(() => {
          const task = getTask(taskId);
          if (!task || ["completed", "dead", "failed"].includes(task.status)) {
            clearInterval(typingInterval);
            return;
          }
          this.adapter.sendTyping(channelId).catch(() => {});
        }, 8000);
      },
    });

    if (isQueued) {
      await this.adapter.sendMessage(channelId, "Queued — working on a previous request.", msg.id);
    }
  }

  // ─── Task Output Handling ────────────────────────────────────────

  private async handleTaskOutput(
    taskId: string,
    response: string | null,
    error: string | null,
    sessionId: string | null,
    raw: string
  ): Promise<void> {
    const entry = this.pendingTasks.get(taskId);
    const task = getTask(taskId);

    if (!entry) {
      // Orphaned task (survived a restart) — try to post to channel anyway
      if (task && response) {
        console.log(`[GATEWAY] Orphaned task ${taskId} completed — posting to ${task.channel_id}`);
        try {
          const chunks = this.splitMessage(response);
          for (const chunk of chunks.slice(0, 5)) {
            await this.adapter.sendMessage(task.channel_id, chunk);
          }
        } catch (err: any) {
          console.error(`[GATEWAY] Failed to post orphaned response: ${err.message}`);
        }
      }
      // Clean up monitor
      finalizeInstance(taskId, "completed");
      return;
    }

    const isComplete = task?.status === "completed" || task?.status === "dead";
    const isContinuation = task && task.step_count > 1 && !isComplete;

    // Stop stream poller if done
    if (isComplete) {
      const poller = this.activeStreamPollers.get(taskId);
      if (poller) {
        poller.stop();
        this.activeStreamPollers.delete(taskId);
      }
    }

    // Continuation step — update stream message and let it keep going
    if (isContinuation && response) {
      const streamMsgId = this.activeStreamMessageIds.get(taskId);
      if (streamMsgId) {
        const chunks = this.splitMessage(response);
        const note = `\n\n*Continuing... (step ${task!.step_count})*`;
        try {
          await this.adapter.editMessage(entry.channelId, streamMsgId, chunks[0] + (chunks.length === 1 ? note : ""));
          for (let i = 1; i < chunks.length; i++) {
            const suffix = i === chunks.length - 1 ? note : "";
            await this.adapter.sendMessage(entry.channelId, chunks[i] + suffix);
          }
          this.activeStreamMessageIds.delete(taskId);
        } catch {}
      }
      return;
    }

    // Task finished — clean up
    this.pendingTasks.delete(taskId);
    const streamMsgId = this.activeStreamMessageIds.get(taskId);
    this.activeStreamMessageIds.delete(taskId);

    // Persist telemetry
    const telemetry = getCompletedSummary(taskId);
    finalizeInstance(taskId, task?.status === "dead" ? "failed" : "completed");
    if (telemetry && task) {
      try {
        persistTaskTelemetry({
          taskId,
          channelId: task.channel_id,
          agent: task.agent || "default",
          prompt: task.prompt || "",
          status: task.status,
          telemetry,
          error,
        });
      } catch (err: any) {
        console.error(`[GATEWAY] Telemetry persist failed: ${err.message}`);
      }
    }

    // Error response
    if (error && !response) {
      const errorReply = `Something went wrong:\n\`\`\`\n${error.slice(0, 500)}\n\`\`\``;
      if (streamMsgId) {
        await this.adapter.editMessage(entry.channelId, streamMsgId, errorReply);
      } else {
        await this.adapter.sendMessage(entry.channelId, errorReply, entry.originMessageId);
      }
      this.releaseChannel(entry.channelId);
      return;
    }

    // Success response
    if (response) {
      // Let the transport intercept for handoffs, create-channel, etc.
      if (this.postOutputHook) {
        const handled = await this.postOutputHook(
          entry.channelId, response, entry.agentName, entry.originMessageId
        );
        if (handled) {
          // Delete stream message if transport handled the response
          if (streamMsgId) {
            try { await this.adapter.deleteMessage(entry.channelId, streamMsgId); } catch {}
          }
          this.releaseChannel(entry.channelId);
          return;
        }
      }

      const chunks = this.splitMessage(response).slice(0, 5);
      if (streamMsgId) {
        await this.adapter.editMessage(entry.channelId, streamMsgId, chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await this.adapter.sendMessage(entry.channelId, chunks[i]);
        }
      } else {
        for (const chunk of chunks) {
          await this.adapter.sendMessage(entry.channelId, chunk, entry.originMessageId);
        }
      }
    } else {
      const errMsg = "Got a response but couldn't parse it. Check logs.";
      if (streamMsgId) {
        await this.adapter.editMessage(entry.channelId, streamMsgId, errMsg);
      } else {
        await this.adapter.sendMessage(entry.channelId, errMsg, entry.originMessageId);
      }
    }

    this.releaseChannel(entry.channelId);
  }

  private async handleDeadLetter(record: DeadLetterRecord): Promise<void> {
    try {
      await this.adapter.sendMessage(
        record.channel_id,
        `**Task failed permanently** after ${record.attempts} attempts.\nError: \`${record.error.slice(0, 300)}\`\nTask ID: \`${record.task_id}\``
      );
    } catch (err: any) {
      console.error(`[GATEWAY] Dead letter notification failed: ${err.message}`);
    }
  }

  // ─── Queue Management ────────────────────────────────────────────

  private enqueueTask(channelId: string, task: QueuedTask): boolean {
    if (!this.channelQueues.has(channelId)) {
      this.channelQueues.set(channelId, []);
    }
    const isQueued = this.activeChannels.has(channelId) || getGlobalRunningCount() >= this.config.maxConcurrent;
    this.channelQueues.get(channelId)!.push(task);
    this.processChannelQueue(channelId);
    return isQueued;
  }

  private processChannelQueue(channelId: string): void {
    if (this.activeChannels.has(channelId)) return;
    if (getGlobalRunningCount() >= this.config.maxConcurrent) return;
    const queue = this.channelQueues.get(channelId);
    if (!queue || queue.length === 0) return;
    const task = queue.shift()!;
    this.activeChannels.add(channelId);
    task.execute();
  }

  releaseChannel(channelId: string): void {
    this.activeChannels.delete(channelId);
    this.processChannelQueue(channelId);
    for (const [queuedChannelId, queue] of this.channelQueues) {
      if (queue.length > 0 && !this.activeChannels.has(queuedChannelId)) {
        this.processChannelQueue(queuedChannelId);
      }
    }
  }

  // ─── Message Splitting ───────────────────────────────────────────

  splitMessage(text: string): string[] {
    const maxLen = this.adapter.maxMessageLength;
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;
    let inCodeBlock = false;
    let codeBlockLang = "";

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }

      let splitAt = remaining.lastIndexOf("\n", maxLen);
      if (splitAt === -1 || splitAt < maxLen * 0.5) {
        splitAt = maxLen;
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

  // ─── Notification Drain ──────────────────────────────────────────

  async drainNotifications(notifyFilePath: string): Promise<number> {
    if (!existsSync(notifyFilePath)) return 0;

    let content: string;
    try {
      content = readFileSync(notifyFilePath, "utf-8").trim();
      if (!content) return 0;
    } catch {
      return 0;
    }

    const lines = content.split("\n").filter(l => l.trim());
    let drained = 0;

    for (const line of lines) {
      try {
        const notification = JSON.parse(line);
        const channelName = notification.channel || notification.discord_channel;
        const summary = notification.summary || notification.message || notification.body || "No summary";
        const task = notification.task || "Unknown";

        if (!channelName) continue;

        const channelId = this.adapter.resolveChannelByName?.(channelName);
        if (!channelId) continue;

        if (this.adapter.sendEmbed) {
          await this.adapter.sendEmbed(channelId, {
            title: task.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
            description: summary.slice(0, 4000),
            color: 0x2B2D31,
            footer: `AI Harness Heartbeat`,
            timestamp: new Date(),
          });
        } else {
          await this.adapter.sendMessage(channelId, `**${task}**\n${summary.slice(0, 1900)}`);
        }

        drained++;
      } catch {}
    }

    // Clear the file
    if (drained > 0) {
      try {
        const { writeFileSync } = await import("fs");
        writeFileSync(notifyFilePath, "");
      } catch {}
    }

    return drained;
  }

  // ─── Getters ─────────────────────────────────────────────────────

  getAdapter(): TransportAdapter {
    return this.adapter;
  }

  getConfig(): GatewayConfig {
    return this.config;
  }

  getPendingTask(taskId: string): PendingTaskEntry | undefined {
    return this.pendingTasks.get(taskId);
  }

  isChannelActive(channelId: string): boolean {
    return this.activeChannels.has(channelId);
  }
}
