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
// Track monitor messages per instance
const monitorMessages = new Map<string, Message>();
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

  // Clean up after 30 seconds
  setTimeout(() => {
    monitorMessages.delete(instance.taskId);
    lastUpdateTimes.delete(instance.taskId);
  }, 30000);
}

// ─── Embed Builder ───────────────────────────────────────────────────

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
  const totalCost = (inputCost + outputCost).toFixed(4);

  // Current tool
  let currentToolStr = "Thinking...";
  if (instance.currentTool) {
    currentToolStr = instance.currentTool.displaySummary;
  } else if (instance.status === "completed") {
    currentToolStr = "Done";
  }

  // Recent tool calls (last 5)
  const recentTools = instance.toolCalls.slice(-5).map((tc) => {
    const duration = tc.durationMs ? `(${(tc.durationMs / 1000).toFixed(1)}s)` : "";
    return `✓ ${tc.displaySummary.slice(0, 60)} ${duration}`;
  });

  const agentDisplay = instance.agent
    ? instance.agent.charAt(0).toUpperCase() + instance.agent.slice(1)
    : "Default";

  const embed = new EmbedBuilder()
    .setTitle(`${statusEmoji} ${agentDisplay} Agent`)
    .setColor(
      instance.status === "running" ? 0x3498db :
      instance.status === "paused_continue" ? 0xf39c12 :
      instance.status === "completed" ? 0x2ecc71 :
      instance.status === "killed" ? 0xe74c3c :
      0x95a5a6
    )
    .addFields(
      {
        name: "Prompt",
        value: `\`\`\`${instance.prompt.slice(0, 200)}${instance.prompt.length > 200 ? "..." : ""}\`\`\``,
        inline: false,
      },
      {
        name: "Duration",
        value: durationStr,
        inline: true,
      },
      {
        name: "Tools Used",
        value: `${instance.toolCalls.length}`,
        inline: true,
      },
      {
        name: "Tokens (est.)",
        value: `~${(instance.estimatedInputTokens / 1000).toFixed(1)}k in / ~${(instance.estimatedOutputTokens / 1000).toFixed(1)}k out ($${totalCost})`,
        inline: true,
      },
      {
        name: "Current",
        value: `\`${currentToolStr.slice(0, 100)}\``,
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
