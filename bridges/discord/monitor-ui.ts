/**
 * Monitor UI — Discord embeds and buttons for real-time Claude instance monitoring.
 *
 * Creates per-instance embed messages in #monitor with:
 * - Agent name, channel, prompt, duration
 * - Current tool call with actual command/args
 * - Recent tool call history with timing
 * - Token/cost estimates
 * - [Kill] [Redirect] [Inject] [Pause/Resume] buttons
 *
 * Updates are throttled to 1 edit per 3 seconds per instance to respect Discord rate limits.
 */

import {
  Client,
  TextChannel,
  ThreadChannel,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Message,
} from "discord.js";
import type { MonitoredInstance, ToolCallEvent } from "./instance-monitor.js";

const MONITOR_CHANNEL_NAME = "monitor";
const UPDATE_THROTTLE_MS = 3000;

let client: Client | null = null;
let monitorChannel: TextChannel | null = null;

// Track last update time per instance to throttle edits
const lastUpdateTimes = new Map<string, number>();
// Track pending updates that were throttled
const pendingUpdates = new Map<string, MonitoredInstance>();
// Track monitor messages and threads per instance
const monitorMessages = new Map<string, Message>();
const monitorThreads = new Map<string, ThreadChannel>();
// Track tool calls already posted to thread (avoid duplicates)
const threadToolCounts = new Map<string, number>();
// Throttle flush interval
let flushInterval: ReturnType<typeof setInterval> | null = null;

// ─── Initialization ──────────────────────────────────────────────────

export function initMonitorUI(discordClient: Client): void {
  client = discordClient;
}

export async function ensureMonitorChannel(): Promise<TextChannel | null> {
  if (monitorChannel) return monitorChannel;
  if (!client) return null;

  for (const guild of client.guilds.cache.values()) {
    // Refresh cache to avoid creating duplicates on rapid restarts
    await guild.channels.fetch();

    const existing = guild.channels.cache.find(
      (c) => c.name === MONITOR_CHANNEL_NAME && c.type === 0 // GuildText
    ) as TextChannel | undefined;

    if (existing) {
      monitorChannel = existing;
      return monitorChannel;
    }

    // Create the channel
    try {
      monitorChannel = await guild.channels.create({
        name: MONITOR_CHANNEL_NAME,
        type: 0, // GuildText
        topic: "Real-time monitoring of Claude agent instances — auto-managed by AI Harness",
        reason: "AI Harness instance monitor",
      });
      console.log(`[MONITOR-UI] Created #${MONITOR_CHANNEL_NAME} channel`);
      return monitorChannel;
    } catch (err: any) {
      console.error(`[MONITOR-UI] Failed to create monitor channel: ${err.message}`);
    }
  }

  return null;
}

export function startMonitorUI(): void {
  // Flush pending updates every 3s
  if (!flushInterval) {
    flushInterval = setInterval(flushPendingUpdates, UPDATE_THROTTLE_MS);
  }
}

export function stopMonitorUI(): void {
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }
}

// ─── Instance Lifecycle ──────────────────────────────────────────────

export async function onInstanceRegistered(instance: MonitoredInstance): Promise<void> {
  const channel = await ensureMonitorChannel();
  if (!channel) return;

  const { embed, row } = buildInstanceEmbed(instance);

  try {
    const msg = await channel.send({ embeds: [embed], components: [row] });
    monitorMessages.set(instance.taskId, msg);
    instance.monitorMessageId = msg.id;

    // Create a thread for detailed tool call log
    try {
      const thread = await msg.startThread({
        name: `${instance.agent || "default"} — ${instance.prompt.slice(0, 40)}`,
        autoArchiveDuration: 60,
      });
      instance.monitorThreadId = thread.id;
      monitorThreads.set(instance.taskId, thread);
    } catch {}

    console.log(`[MONITOR-UI] Created monitor embed for ${instance.taskId}`);
  } catch (err: any) {
    console.error(`[MONITOR-UI] Failed to send monitor embed: ${err.message}`);
  }
}

export async function onInstanceUpdate(instance: MonitoredInstance): Promise<void> {
  const now = Date.now();
  const lastUpdate = lastUpdateTimes.get(instance.taskId) || 0;

  if (now - lastUpdate < UPDATE_THROTTLE_MS) {
    // Throttled — queue the update
    pendingUpdates.set(instance.taskId, instance);
    return;
  }

  await doUpdate(instance);
}

export async function onInstanceCompleted(instance: MonitoredInstance): Promise<void> {
  // Final update with completed status
  pendingUpdates.delete(instance.taskId);
  await doUpdate(instance);

  // Post completion summary to monitor channel
  const channel = await ensureMonitorChannel();
  if (channel) {
    const durationSec = Math.round((Date.now() - instance.startedAt) / 1000);
    const durationStr = durationSec >= 60
      ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`
      : `${durationSec}s`;
    const inputCost = (instance.estimatedInputTokens / 1_000_000) * 3;
    const outputCost = (instance.estimatedOutputTokens / 1_000_000) * 15;
    const cost = (inputCost + outputCost).toFixed(4);
    const statusIcon = instance.status === "completed" ? "✅" : instance.status === "killed" ? "🛑" : "❌";
    const agent = instance.agent ? instance.agent.charAt(0).toUpperCase() + instance.agent.slice(1) : "Default";

    try {
      await channel.send(
        `${statusIcon} **${agent}** completed in ${durationStr} (${instance.toolCalls.length} tools, ~$${cost}) — <#${instance.channelId}>`
      );
    } catch {}
  }

  // Delete the embed + thread after 2 minutes
  const msg = monitorMessages.get(instance.taskId);
  const thread = monitorThreads.get(instance.taskId);
  setTimeout(async () => {
    if (thread) {
      try { await thread.delete(); } catch {}
    }
    if (msg) {
      try { await msg.delete(); } catch {}
    }
    monitorMessages.delete(instance.taskId);
    monitorThreads.delete(instance.taskId);
    threadToolCounts.delete(instance.taskId);
    lastUpdateTimes.delete(instance.taskId);
  }, 120_000);
}

// ─── Embed Builder ───────────────────────────────────────────────────

// Cost thresholds for color alerting
const COST_WARN_CENTS = 50;   // $0.50 → yellow
const COST_ALERT_CENTS = 100; // $1.00 → red
const STALE_THRESHOLD_MS = 60_000; // 60s no activity → stale warning

function buildInstanceEmbed(instance: MonitoredInstance): {
  embed: EmbedBuilder;
  row: ActionRowBuilder<ButtonBuilder>;
} {
  const durationSec = Math.round((Date.now() - instance.startedAt) / 1000);
  const durationStr = durationSec >= 60
    ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`
    : `${durationSec}s`;

  const statusEmoji = {
    running: "🟢",
    paused_continue: "⏸️",
    completed: "✅",
    killed: "🛑",
    failed: "❌",
  }[instance.status] || "⚪";

  // Cost estimate
  const inputCost = (instance.estimatedInputTokens / 1_000_000) * 3;
  const outputCost = (instance.estimatedOutputTokens / 1_000_000) * 15;
  const totalCostNum = inputCost + outputCost;
  const totalCost = totalCostNum.toFixed(4);
  const costCents = Math.round(totalCostNum * 100);

  // Stale detection
  const timeSinceActivity = Date.now() - instance.lastActivityAt;
  const isStale = instance.status === "running" && timeSinceActivity > STALE_THRESHOLD_MS;

  // Color: status-based, but cost overrides if high
  let embedColor = 0x3498db; // blue (running)
  if (instance.status === "paused_continue") embedColor = 0xf39c12;
  else if (instance.status === "completed") embedColor = 0x2ecc71;
  else if (instance.status === "killed") embedColor = 0xe74c3c;
  else if (instance.status === "failed") embedColor = 0xe74c3c;

  // Cost alerting overrides running color
  if (instance.status === "running") {
    if (costCents >= COST_ALERT_CENTS) embedColor = 0xe74c3c; // red
    else if (costCents >= COST_WARN_CENTS) embedColor = 0xf39c12; // yellow
    else if (isStale) embedColor = 0xe67e22; // orange for stale
  }

  // Current activity display
  let currentStr = "Thinking...";
  if (instance.currentTool) {
    currentStr = instance.currentTool.displaySummary;
  } else if (instance.status === "completed") {
    currentStr = "Done";
  } else if (instance.status === "failed") {
    currentStr = "Failed";
  } else if (instance.thinkingText) {
    // Show a snippet of what Claude is thinking about
    const snippet = instance.thinkingText.trim().split("\n").pop() || "";
    currentStr = snippet.slice(0, 120) || "Thinking...";
  }

  // Recent tool calls (last 5)
  const recentTools = instance.toolCalls.slice(-5).map((tc) => {
    const duration = tc.durationMs ? `(${(tc.durationMs / 1000).toFixed(1)}s)` : "";
    return `✓ ${tc.displaySummary.slice(0, 55)} ${duration}`;
  });

  const agentDisplay = instance.agent
    ? instance.agent.charAt(0).toUpperCase() + instance.agent.slice(1)
    : "Default";

  // Build title with stale indicator
  const title = isStale
    ? `${statusEmoji} ${agentDisplay} Agent ⚠️ STALE (${Math.round(timeSinceActivity / 1000)}s idle)`
    : `${statusEmoji} ${agentDisplay} Agent`;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(`<#${instance.channelId}>`)
    .setColor(embedColor)
    .addFields(
      {
        name: "Prompt",
        value: instance.prompt.slice(0, 200) + (instance.prompt.length > 200 ? "..." : ""),
        inline: false,
      },
      {
        name: "Duration",
        value: durationStr,
        inline: true,
      },
      {
        name: "Tools Used",
        value: `${instance.toolCalls.length}${instance.currentTool ? " (+1 running)" : ""}`,
        inline: true,
      },
      {
        name: "Cost (est.)",
        value: costCents >= COST_ALERT_CENTS
          ? `⚠️ $${totalCost}`
          : costCents >= COST_WARN_CENTS
            ? `⚡ $${totalCost}`
            : `$${totalCost}`,
        inline: true,
      },
      {
        name: "Current",
        value: currentStr.slice(0, 200),
        inline: false,
      },
    )
    .setFooter({ text: `Task: ${instance.taskId} | PID: ${instance.pid}` })
    .setTimestamp();

  if (recentTools.length > 0) {
    embed.addFields({
      name: "Recent Tools",
      value: recentTools.join("\n").slice(0, 1024),
      inline: false,
    });
  }

  // Intervention notice
  if (instance.holdContinuation) {
    embed.addFields({
      name: "⏸️ Paused",
      value: "Continuation held — click Resume to continue",
      inline: false,
    });
  }
  if (instance.interventionNote) {
    embed.addFields({
      name: "📝 Intervention Note",
      value: instance.interventionNote.slice(0, 200),
      inline: false,
    });
  }

  // Buttons
  const isPaused = instance.holdContinuation;
  const isFinished = ["completed", "killed", "failed"].includes(instance.status);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`monitor:kill:${instance.taskId}`)
      .setLabel("Kill")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(isFinished),
    new ButtonBuilder()
      .setCustomId(`monitor:redirect:${instance.taskId}`)
      .setLabel("Redirect")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(isFinished),
    new ButtonBuilder()
      .setCustomId(`monitor:inject:${instance.taskId}`)
      .setLabel("Inject")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isFinished),
    new ButtonBuilder()
      .setCustomId(isPaused ? `monitor:resume:${instance.taskId}` : `monitor:pause:${instance.taskId}`)
      .setLabel(isPaused ? "Resume" : "Pause")
      .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(isFinished),
  );

  return { embed, row };
}

// ─── Update Helpers ──────────────────────────────────────────────────

async function doUpdate(instance: MonitoredInstance): Promise<void> {
  const msg = monitorMessages.get(instance.taskId);
  if (!msg) return;

  const { embed, row } = buildInstanceEmbed(instance);

  try {
    await msg.edit({ embeds: [embed], components: [row] });
    lastUpdateTimes.set(instance.taskId, Date.now());
  } catch (err: any) {
    // Message might have been deleted
    if (err.code === 10008) {
      monitorMessages.delete(instance.taskId);
    }
  }

  // Post new thinking + tool calls to the thread
  const thread = monitorThreads.get(instance.taskId);
  if (thread) {
    const lines: string[] = [];

    // Post new thinking content (if substantial new text since last post)
    const thinkingLen = instance.thinkingText.length;
    if (thinkingLen > instance.lastPostedThinkingLen + 50) {
      // Get the new portion of thinking text
      const newThinking = instance.thinkingText.slice(-200).trim();
      if (newThinking) {
        // Take the last meaningful line/sentence
        const lastLine = newThinking.split("\n").filter(l => l.trim()).pop() || newThinking;
        const elapsed = ((Date.now() - instance.startedAt) / 1000).toFixed(0);
        lines.push(`\`[${elapsed}s]\` 💭 ${lastLine.slice(0, 150)}`);
      }
      instance.lastPostedThinkingLen = thinkingLen;
    }

    // Post new tool calls
    const lastPosted = threadToolCounts.get(instance.taskId) || 0;
    const newTools = instance.toolCalls.slice(lastPosted);
    for (const tc of newTools.slice(0, 5)) {
      const elapsed = ((tc.timestamp - instance.startedAt) / 1000).toFixed(0);
      const duration = tc.durationMs ? ` (${(tc.durationMs / 1000).toFixed(1)}s)` : "";
      lines.push(`\`[${elapsed}s]\` 🔧 ${tc.displaySummary.slice(0, 80)}${duration}`);
    }
    if (newTools.length > 0) {
      threadToolCounts.set(instance.taskId, instance.toolCalls.length);
    }

    // Send batched update to thread
    if (lines.length > 0) {
      try {
        await thread.send(lines.join("\n"));
      } catch {}
    }
  }
}

function flushPendingUpdates(): void {
  for (const [taskId, instance] of pendingUpdates) {
    doUpdate(instance).catch(() => {});
    pendingUpdates.delete(taskId);
  }
}

// ─── Exports for intervention handlers ───────────────────────────────

export function getMonitorMessage(taskId: string): Message | null {
  return monitorMessages.get(taskId) || null;
}
