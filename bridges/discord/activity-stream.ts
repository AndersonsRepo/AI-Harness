import { Client, TextChannel, EmbedBuilder, AttachmentBuilder } from "discord.js";
import type { SubagentEntry } from "./process-registry.js";
import { monitor } from "./truncation-monitor.js";

let streamChannel: TextChannel | null = null;
let discordClient: Client | null = null;

export function initActivityStream(client: Client): void {
  discordClient = client;
  const channelId = process.env.STREAM_CHANNEL_ID;
  if (!channelId) {
    console.log("[STREAM] No STREAM_CHANNEL_ID set, activity stream disabled");
    return;
  }
  const ch = client.channels.cache.get(channelId);
  if (ch && ch.isTextBased()) {
    streamChannel = ch as TextChannel;
    console.log(`[STREAM] Activity stream connected to #${streamChannel.name}`);
  } else {
    console.log(`[STREAM] Channel ${channelId} not found or not text-based`);
  }
}

export async function postStart(entry: SubagentEntry): Promise<string | null> {
  if (!streamChannel) return null;
  try {
    const embed = new EmbedBuilder()
      .setTitle(`🚀 Subagent Started`)
      .setDescription(entry.description)
      .addFields(
        { name: "ID", value: entry.id, inline: true },
        { name: "Agent", value: entry.agent || "default", inline: true },
        { name: "Channel", value: `<#${entry.parentChannelId}>`, inline: true }
      )
      .setColor(0x3498db)
      .setTimestamp(new Date(entry.startedAt));

    const msg = await streamChannel.send({ embeds: [embed] });
    return msg.id;
  } catch (err: any) {
    console.error(`[STREAM] Failed to post subagent start: ${err.message}`);
    return null;
  }
}

export async function postUpdate(
  entry: SubagentEntry,
  summary: string
): Promise<void> {
  if (!streamChannel || !entry.streamMessageId) return;
  try {
    const msg = await streamChannel.messages.fetch(entry.streamMessageId);
    const embed = EmbedBuilder.from(msg.embeds[0])
      .addFields({ name: "Status", value: monitor.truncate(summary, 1024, "stream:status-field") });
    await msg.edit({ embeds: [embed] });
  } catch (err: any) {
    console.error(`[STREAM] Failed to update message: ${err.message}`);
  }
}

export async function postComplete(
  entry: SubagentEntry,
  result: string
): Promise<void> {
  if (!streamChannel || !entry.streamMessageId) return;
  try {
    const msg = await streamChannel.messages.fetch(entry.streamMessageId);
    const { text: truncated, overflow } = monitor.truncateForEmbed(result, 1800, "stream:subagent-complete");
    const embed = new EmbedBuilder()
      .setTitle(`✅ Subagent Completed`)
      .setDescription(truncated)
      .addFields(
        { name: "ID", value: entry.id, inline: true },
        { name: "Agent", value: entry.agent || "default", inline: true },
        { name: "Duration", value: getDuration(entry), inline: true }
      )
      .setColor(0x2ecc71)
      .setTimestamp();

    const files: AttachmentBuilder[] = [];
    if (overflow) {
      files.push(
        new AttachmentBuilder(Buffer.from(result, "utf-8"), {
          name: `result-${entry.id}.md`,
        })
      );
    }

    await msg.edit({ embeds: [embed], files });
  } catch (err: any) {
    console.error(`[STREAM] Failed to post completion: ${err.message}`);
  }
}

export async function postError(
  entry: SubagentEntry,
  error: string
): Promise<void> {
  if (!streamChannel || !entry.streamMessageId) return;
  try {
    const msg = await streamChannel.messages.fetch(entry.streamMessageId);
    const embed = new EmbedBuilder()
      .setTitle(`❌ Subagent Failed`)
      .setDescription(monitor.truncate(error, 1800, "stream:subagent-error"))
      .addFields(
        { name: "ID", value: entry.id, inline: true },
        { name: "Agent", value: entry.agent || "default", inline: true },
        { name: "Duration", value: getDuration(entry), inline: true }
      )
      .setColor(0xe74c3c)
      .setTimestamp();
    await msg.edit({ embeds: [embed] });
  } catch (err: any) {
    console.error(`[STREAM] Failed to post error: ${err.message}`);
  }
}

// --- Channel agent activity (regular requests) ---

export interface AgentActivity {
  channelId: string;
  agent: string;
  runtime?: "claude" | "codex";
  prompt: string;
  startedAt: number;
  streamMessageId?: string;
}

export async function postAgentStart(activity: AgentActivity): Promise<string | null> {
  if (!streamChannel) return null;
  try {
    const embed = new EmbedBuilder()
      .setTitle(`Agent Active`)
      .setDescription(monitor.truncate(activity.prompt, 200, "stream:agent-prompt"))
      .addFields(
        { name: "Agent", value: activity.agent, inline: true },
        { name: "Runtime", value: activity.runtime || "claude", inline: true },
        { name: "Channel", value: `<#${activity.channelId}>`, inline: true }
      )
      .setColor(0x9b59b6)
      .setTimestamp();

    const msg = await streamChannel.send({ embeds: [embed] });
    return msg.id;
  } catch (err: any) {
    console.error(`[STREAM] Failed to post agent start: ${err.message}`);
    return null;
  }
}

export async function postAgentComplete(
  activity: AgentActivity,
  result: string
): Promise<void> {
  if (!streamChannel || !activity.streamMessageId) return;
  try {
    const msg = await streamChannel.messages.fetch(activity.streamMessageId);
    const duration = Math.round((Date.now() - activity.startedAt) / 1000);
    const durationStr = duration < 60 ? `${duration}s` : `${Math.floor(duration / 60)}m ${duration % 60}s`;
    const { text: truncated, overflow } = monitor.truncateForEmbed(result, 1800, "stream:agent-complete");

    const embed = new EmbedBuilder()
      .setTitle(`Agent Done`)
      .setDescription(truncated)
      .addFields(
        { name: "Agent", value: activity.agent, inline: true },
        { name: "Runtime", value: activity.runtime || "claude", inline: true },
        { name: "Channel", value: `<#${activity.channelId}>`, inline: true },
        { name: "Duration", value: durationStr, inline: true }
      )
      .setColor(0x2ecc71)
      .setTimestamp();

    const files: AttachmentBuilder[] = [];
    if (overflow) {
      files.push(
        new AttachmentBuilder(Buffer.from(result, "utf-8"), {
          name: `result-${activity.agent}-${Date.now()}.md`,
        })
      );
    }

    await msg.edit({ embeds: [embed], files });
  } catch (err: any) {
    console.error(`[STREAM] Failed to post agent completion: ${err.message}`);
  }
}

export async function postAgentError(
  activity: AgentActivity,
  error: string
): Promise<void> {
  if (!streamChannel || !activity.streamMessageId) return;
  try {
    const msg = await streamChannel.messages.fetch(activity.streamMessageId);
    const duration = Math.round((Date.now() - activity.startedAt) / 1000);
    const durationStr = duration < 60 ? `${duration}s` : `${Math.floor(duration / 60)}m ${duration % 60}s`;

    const embed = new EmbedBuilder()
      .setTitle(`Agent Error`)
      .setDescription(monitor.truncate(error, 1800, "stream:agent-error"))
      .addFields(
        { name: "Agent", value: activity.agent, inline: true },
        { name: "Runtime", value: activity.runtime || "claude", inline: true },
        { name: "Channel", value: `<#${activity.channelId}>`, inline: true },
        { name: "Duration", value: durationStr, inline: true }
      )
      .setColor(0xe74c3c)
      .setTimestamp();
    await msg.edit({ embeds: [embed] });
  } catch (err: any) {
    console.error(`[STREAM] Failed to post agent error: ${err.message}`);
  }
}

function getDuration(entry: SubagentEntry): string {
  const start = new Date(entry.startedAt).getTime();
  const end = entry.completedAt
    ? new Date(entry.completedAt).getTime()
    : Date.now();
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
