/**
 * DiscordTransport — TransportAdapter implementation for Discord.
 *
 * Wraps discord.js Client and implements the TransportAdapter interface
 * from core-types.ts. Handles all Discord-specific concerns:
 * - Client lifecycle (login, ready, disconnect)
 * - Message conversion (discord.js Message → GatewayMessage)
 * - Image attachment download
 * - Channel/guild management (create, resolve, auto-setup)
 * - Embed rendering via EmbedBuilder
 * - LinkedIn approval flow (!approve / !reject)
 * - Notification drain (atomic rename + embed rendering)
 * - Project auto-adopt in Projects category
 * - Subagent completion notifications
 * - Activity stream + instance monitor wiring
 *
 * Phase 5 of the Gateway abstraction.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  Message,
  TextChannel,
  ChannelType,
  EmbedBuilder,
} from "discord.js";
import type {
  TransportAdapter,
  GatewayMessage,
  EmbedPayload,
  ChannelCreateOpts,
} from "./core-types.js";
import type { Gateway } from "./core-gateway.js";
import { isSupportedAttachment } from "./core-gateway.js";
import { executeCommand, type CommandContext } from "./core-commands.js";
import { setChannelConfig, getChannelConfig } from "./channel-config-store.js";
import {
  getProject,
  createProject,
  closeProject,
  autoAdoptIfInCategory,
  adoptChannel,
  updateProject,
  resetHandoffDepth,
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
import {
  formatManualHandoffNotice,
  isProjectAutoChainEnabled,
} from "./project-chain-policy.js";
import {
  initActivityStream,
  postAgentStart,
  postAgentComplete,
  postAgentError,
  type AgentActivity,
} from "./activity-stream.js";
import {
  onSubagentComplete,
  startPolling as startSubagentPolling,
} from "./subagent-manager.js";
import { cleanupStale as cleanupStaleSubagents } from "./process-registry.js";
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
import {
  CONTROL_CHANNEL_NAME,
  ensureControlPanel,
  handleControlInteraction,
} from "./control-panel.js";
import { isFullyFrozen } from "./autorun-mode.js";
import { reapOrphanedRunners, formatReapReport } from "./process-reaper.js";
import {
  setMonitorUpdateCallback,
  setMonitorCompletionCallback,
} from "./instance-monitor.js";
import { syncEmbeddings, watchVaultForEmbeddings, stopEmbeddingWatchers } from "./embeddings.js";
import { getDb } from "./db.js";
import { monitor } from "./truncation-monitor.js";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  appendFileSync,
  renameSync,
  statSync,
} from "fs";
import { basename, join } from "path";
import {
  submitTask,
  spawnTask,
  pruneDeadLetters,
} from "./task-runner.js";
import { spawn } from "child_process";

// ─── Types ──────────────────────────────────────────────────────────

export interface DiscordTransportConfig {
  token: string;
  allowedUserIds: string[];
  harnessRoot: string;
  maxConcurrent: number;
}

// ─── DiscordTransport ───────────────────────────────────────────────

export class DiscordTransport implements TransportAdapter {
  readonly name = "discord";
  readonly maxMessageLength = 1900;

  private client: Client;
  private config: DiscordTransportConfig;
  private gateway: Gateway | null = null;
  private notifyInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: DiscordTransportConfig) {
    this.config = config;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  /** Set the gateway reference so we can delegate message handling. */
  setGateway(gateway: Gateway): void {
    this.gateway = gateway;
  }

  // ─── TransportAdapter: Send Operations ────────────────────────────

  async sendMessage(channelId: string, text: string, replyToId?: string): Promise<string> {
    const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    if (replyToId) {
      try {
        const original = await channel.messages.fetch(replyToId);
        const sent = await original.reply(text);
        return sent.id;
      } catch {
        // Fall through to plain send if reply target not found
      }
    }

    const sent = await channel.send(text);
    return sent.id;
  }

  async editMessage(channelId: string, messageId: string, text: string): Promise<void> {
    const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
    if (!channel) return;
    try {
      const msg = await channel.messages.fetch(messageId);
      await msg.edit(text);
    } catch (err: any) {
      console.error(`[DISCORD] Failed to edit message ${messageId}: ${err.message}`);
    }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
    if (!channel) return;
    try {
      const msg = await channel.messages.fetch(messageId);
      await msg.delete();
    } catch (err: any) {
      console.error(`[DISCORD] Failed to delete message ${messageId}: ${err.message}`);
    }
  }

  async sendTyping(channelId: string): Promise<void> {
    const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
    if (!channel) return;
    await channel.sendTyping();
  }

  // ─── TransportAdapter: Rich Content ───────────────────────────────

  async sendEmbed(channelId: string, embed: EmbedPayload): Promise<string> {
    const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    const builder = new EmbedBuilder();
    if (embed.title) builder.setTitle(embed.title);
    if (embed.description) builder.setDescription(embed.description);
    if (embed.color !== undefined) builder.setColor(embed.color);
    if (embed.footer) builder.setFooter({ text: embed.footer });
    if (embed.timestamp) builder.setTimestamp(embed.timestamp);
    if (embed.fields) {
      for (const f of embed.fields) {
        builder.addFields({ name: f.name, value: f.value, inline: f.inline });
      }
    }

    try {
      const sent = await channel.send({ embeds: [builder] });
      return sent.id;
    } catch (err: any) {
      console.error(`[TRANSPORT] sendEmbed failed for ${channelId}: ${err.message}`);
      throw err;
    }
  }

  async sendFile(channelId: string, buffer: Buffer, filename: string): Promise<string> {
    const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    try {
      const sent = await channel.send({ files: [{ attachment: buffer, name: filename }] });
      return sent.id;
    } catch (err: any) {
      console.error(`[TRANSPORT] sendFile failed for ${channelId}: ${err.message}`);
      throw err;
    }
  }

  // ─── TransportAdapter: Channel Management ─────────────────────────

  async createChannel(name: string, opts?: ChannelCreateOpts): Promise<string> {
    const guild = this.client.guilds.cache.first();
    if (!guild) throw new Error("No guilds available");

    let parentId: string | undefined;
    if (opts?.parentCategory) {
      const cat = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === opts.parentCategory!.toLowerCase()
      );
      parentId = cat?.id;
    }

    const channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: parentId,
      topic: opts?.topic,
      reason: "Created by AI Harness Gateway",
    });

    if (opts?.agent) {
      setChannelConfig(channel.id, { agent: opts.agent });
    }

    return channel.id;
  }

  async fetchRecentMessages(channelId: string, limit: number): Promise<GatewayMessage[]> {
    const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
    if (!channel) return [];

    const messages = await channel.messages.fetch({ limit });
    return [...messages.values()].reverse().map((msg) => this.convertMessage(msg));
  }

  resolveChannelByName(name: string): string | null {
    for (const guild of this.client.guilds.cache.values()) {
      const ch = guild.channels.cache.find(
        (c) => c.name === name && c.isTextBased() && c.type === 0
      );
      if (ch) return ch.id;
    }
    return null;
  }

  // ─── TransportAdapter: Lifecycle ──────────────────────────────────

  async start(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.client.on("clientReady", async () => {
        console.log(`[DISCORD] Online as ${this.client.user?.tag}`);

        // Initialize SQLite
        getDb();
        console.log("[DISCORD] Database ready");

        // Instance monitor
        initMonitorUI(this.client);
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

        // Activity stream
        initActivityStream(this.client);

        // Subagents
        startSubagentPolling();
        const cleaned = cleanupStaleSubagents();
        if (cleaned > 0) console.log(`[DISCORD] Cleaned ${cleaned} stale subagents`);

        // Prune old dead letters
        const pruned = pruneDeadLetters(7);
        if (pruned > 0) console.log(`[DISCORD] Pruned ${pruned} old dead-letter entries`);

        // Embeddings (non-blocking)
        syncEmbeddings().then((stats) => {
          console.log(`[DISCORD] Embeddings: +${stats.added} ~${stats.updated} -${stats.removed}`);
        }).catch((err) => {
          console.error(`[DISCORD] Embedding sync failed (non-fatal): ${err.message}`);
        });
        watchVaultForEmbeddings();

        // Subagent completion notifications
        onSubagentComplete(async (entry, result) => {
          try {
            const ch = this.client.channels.cache.get(entry.parentChannelId) as TextChannel | undefined;
            if (ch) {
              const status = entry.status === "completed" ? "completed" : "failed";
              const preview = result.slice(0, 300);
              await ch.send(
                `**Subagent \`${entry.id}\` ${status}** (${entry.agent || "default"})\n${preview}${result.length > 300 ? "..." : ""}`
              );
            }
          } catch (err: any) {
            console.error(`[DISCORD] Subagent notify failed: ${err.message}`);
          }
        });

        // Channel auto-setup (school/courses/linkedin/performance). bot.ts is
        // legacy/dead and never runs this — see ERR-20260429-003.
        await this.ensureChannels();

        // One-shot deterministic reap of wedged runners left by a previous
        // instance (orphans survive restarts). No AI, no tokens.
        try {
          const report = reapOrphanedRunners();
          if (report.reaped.length) console.log(`[DISCORD] ${formatReapReport(report)}`);
        } catch (err: any) {
          console.error(`[DISCORD] Startup reaper failed: ${err.message}`);
        }

        // Notification drain polling
        const notifyFile = join(this.config.harnessRoot, "heartbeat-tasks", "pending-notifications.jsonl");
        this.notifyInterval = setInterval(() => this.drainNotifications(notifyFile), 60_000);

        resolve();
      });

      // Message routing
      this.client.on("messageCreate", (msg) => this.handleMessage(msg));

      // Component interactions (buttons, selects, modals). Control-panel
      // interactions are checked FIRST and are deterministic — they spawn no AI
      // and are never gated by autorun mode, so the panel can always switch the
      // kill-switch back off even under full freeze.
      this.client.on("interactionCreate", async (interaction) => {
        try {
          if (await handleControlInteraction(interaction)) return;
          await handleMonitorInteraction(interaction);
        } catch (err: any) {
          console.error(`[DISCORD] Interaction error: ${err.message}`);
        }
      });

      this.client.login(this.config.token);
    });
  }

  async stop(): Promise<void> {
    if (this.notifyInterval) {
      clearInterval(this.notifyInterval);
      this.notifyInterval = null;
    }
    stopMonitorUI();
    stopEmbeddingWatchers();
    this.client.destroy();
    console.log("[DISCORD] Transport stopped");
  }

  // ─── Discord Client Accessor ──────────────────────────────────────

  getClient(): Client {
    return this.client;
  }

  // ─── Message Handling ─────────────────────────────────────────────

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return;

    const userId = message.author.id;
    if (!this.config.allowedUserIds.includes(userId)) {
      console.log(`[DISCORD] Blocked ${userId} — not in allowed list`);
      return;
    }

    const content = message.content.trim();

    // LinkedIn approval flow: !approve / !reject
    const approveMatch = content.match(/^!approve\s+(\S+)$/);
    if (approveMatch) {
      await this.handleLinkedInApproval(message, approveMatch[1], true);
      return;
    }
    const rejectMatch = content.match(/^!reject\s+(\S+)$/);
    if (rejectMatch) {
      await this.handleLinkedInApproval(message, rejectMatch[1], false);
      return;
    }

    // Lifecycle commands. These run BEFORE the gateway/task-runner sees the
    // message — important because a task-routed shutdown is immortal: the
    // crashed-task recovery path would re-spawn the prompt on next start.
    // See vault: LRN-do-not-task-the-bot-with-self-affecting-actions.
    if (content === "!stop-heartbeats" || content === "!stop-bot" || content === "!stop-harness") {
      await this.handleLifecycleCommand(message, content);
      return;
    }

    // Download image attachments
    const attachmentPaths = await this.downloadAttachments(message);

    // Build the GatewayMessage
    const gatewayMsg = this.convertMessage(message, attachmentPaths);

    // Discord-specific pre-processing before handing to gateway

    // Auto-adopt channels under Projects category
    const channelId = message.channel.id;
    if (
      !getProject(channelId) &&
      "parent" in message.channel &&
      message.channel.parent &&
      message.channel.parent.name.toLowerCase() === getProjectsCategoryName().toLowerCase()
    ) {
      const ch = message.channel as TextChannel;
      const adopted = autoAdoptIfInCategory(
        channelId, ch.name, ch.parentId, message.guild?.id || ""
      );
      if (adopted) {
        console.log(`[DISCORD] Auto-adopted #${ch.name} as project "${adopted.name}"`);
        await message.reply(
          `Auto-registered as project \`${adopted.name}\` (in Projects category). Agents: ${adopted.agents.join(", ")}`
        );
      }
    }

    // Project channel: reset handoff depth on human message, route addressed agent
    const project = getProject(channelId);
    if (project) {
      resetHandoffDepth(channelId);
      const agentAddressMatch = content.match(/^(\w+)\s*:\s*(.+)$/s);
      if (agentAddressMatch) {
        const addressedAgent = agentAddressMatch[1].toLowerCase();
        if (project.agents.includes(addressedAgent)) {
          setChannelConfig(channelId, { agent: addressedAgent });
          updateProject(channelId, { activeAgent: addressedAgent });
        }
      }
    }

    // Try Discord-specific commands first (channel/project create, adopt, close, help, restart)
    if (content.startsWith("/")) {
      const handled = await this.handleDiscordCommand(message, content);
      if (handled) return;
    }

    // Autorun kill-switch (control panel): under FULL freeze, the bot stops
    // responding to messages with AI. Deterministic commands above (/commands,
    // lifecycle, approvals) already ran; only the AI gateway is gated. Switch
    // back via the #control-panel buttons (interactions are never frozen).
    if (isFullyFrozen()) {
      await message.react("🧊").catch(() => {});
      return;
    }

    // Delegate to Gateway
    if (this.gateway) {
      await this.gateway.onMessage(gatewayMsg);
    }
  }

  // ─── Discord-Specific Commands ────────────────────────────────────

  /**
   * Handle commands that require Discord guild access and can't be in core-commands.ts.
   * Returns true if handled.
   */
  private async handleDiscordCommand(message: Message, content: string): Promise<boolean> {
    const channelId = message.channel.id;

    // /channel create <name> [--agent <agentName>]
    const channelCreateMatch = content.match(
      /^\/channel\s+create\s+(\S+)(?:\s+--agent\s+(\w+))?$/
    );
    if (channelCreateMatch) {
      const [, name, agentName] = channelCreateMatch;
      if (!message.guild) {
        await message.reply("This command only works in a server.");
        return true;
      }
      try {
        const newChannel = await message.guild.channels.create({
          name,
          type: ChannelType.GuildText,
          reason: "Created by AI Harness bot",
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

    // /project create <name> "description"
    const projectCreateMatch = content.match(
      /^\/project\s+create\s+(\w[\w-]*)\s+"([^"]+)"$/
    );
    if (projectCreateMatch) {
      const [, name, description] = projectCreateMatch;
      if (!message.guild) {
        await message.reply("This command only works in a server.");
        return true;
      }
      try {
        const project = await createProject(message.guild, name, description);
        await message.reply(
          `Project created: <#${project.channelId}>\nAgents: ${project.agents.join(", ")}\nDescription: ${description}`
        );
      } catch (err: any) {
        await message.reply(`Failed to create project: ${err.message}`);
      }
      return true;
    }

    // /project adopt ["description"]
    const adoptMatch = content.match(/^\/project\s+adopt(?:\s+"([^"]+)")?$/);
    if (adoptMatch) {
      const project = getProject(channelId);
      if (project) {
        await message.reply("This channel is already a project.");
        return true;
      }
      if (!("name" in message.channel)) {
        await message.reply("This command only works in a server text channel.");
        return true;
      }
      const ch = message.channel as TextChannel;
      const adopted = adoptChannel(
        channelId, ch.name, ch.parentId, message.guild?.id || "", adoptMatch[1] || undefined
      );
      await message.reply(
        `Channel adopted as project \`${adopted.name}\`.\nAgents: ${adopted.agents.join(", ")}\nDescription: ${adopted.description}`
      );
      return true;
    }

    // /project close
    if (content === "/project close") {
      if (!message.guild) {
        await message.reply("This command only works in a server.");
        return true;
      }
      const closed = await closeProject(message.guild, channelId);
      await message.reply(closed ? "Project closed and channel archived." : "This channel is not a project channel.");
      return true;
    }

    // /restart
    if (content === "/restart") {
      await message.reply("Restarting bot... (scheduler will bring it back in ~30s)");
      setTimeout(() => process.exit(75), 1000);
      return true;
    }

    // /help
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
            name: "Lifecycle",
            value: [
              "`!stop-heartbeats` — Stop all heartbeats (bot stays up)",
              "`!stop-bot` — Stop the bot (terminal needed to restart)",
              "`!stop-harness` — Stop bot + heartbeats",
            ].join("\n"),
            inline: true,
          },
        )
        .setFooter({ text: "Type /help to see this message" });
      await message.reply({ embeds: [embed] });
      return true;
    }

    return false;
  }

  // ─── Handoff + Output Post-Processing ─────────────────────────────

  /**
   * Called by Gateway after task output to handle Discord-specific post-processing:
   * - CREATE_CHANNEL directives
   * - Handoff chain execution
   * - Orchestrator debrief
   *
   * Returns true if the response was handled (handoff/create-channel), false for normal flow.
   */
  async handlePostOutput(
    channelId: string,
    response: string,
    agentName: string | undefined,
    originMessageId: string
  ): Promise<boolean> {
    const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
    if (!channel) return false;

    // Check for [CREATE_CHANNEL:name] directive
    const createDir = parseCreateChannel(response);
    if (createDir) {
      const guild = channel.guild;
      if (guild) {
        try {
          const newProject = await createProject(
            guild,
            createDir.channelName,
            createDir.description || `Created by ${agentName || "agent"}`,
            createDir.agent
              ? [createDir.agent, ...["researcher", "reviewer", "builder", "ops"].filter(a => a !== createDir.agent)]
              : undefined
          );
          const cleanResponse = response.replace(
            /\[CREATE_CHANNEL\s*:\s*[\w-]+(?:\s+--agent\s+\w+)?(?:\s+"[^"]*")?\]/i,
            `*(Created project channel <#${newProject.channelId}>)*`
          );
          const chunks = monitor.splitForDiscord(cleanResponse, this.maxMessageLength, "create-channel");
          for (const chunk of chunks.slice(0, 5)) {
            await channel.send(chunk);
          }
          return true;
        } catch (err: any) {
          console.error(`[DISCORD] CREATE_CHANNEL failed: ${err.message}`);
        }
      }
    }

    // Check for handoff in project channels.
    // Prefer the harness_handoff tool's queue over text-based [HANDOFF:]
    // parsing — the tool is a structured signal, regex on prose is fragile.
    // Fall back to parseHandoff so existing text directives still work.
    const project = getProject(channelId);
    const handoffSessionKey = project && agentName ? getProjectSessionKey(channelId, agentName) : null;
    const queuedHandoff = handoffSessionKey ? dequeueHandoff(handoffSessionKey) : null;
    const handoff = queuedHandoff ?? parseHandoff(response);
    if (project && agentName && handoff) {
      // Post pre-handoff text
      if (handoff.preHandoffText) {
        try {
          const preChunks = monitor.splitForDiscord(
            `**${capitalize(agentName)}:** ${handoff.preHandoffText}`,
            this.maxMessageLength,
            "handoff:pre-text"
          );
          for (const chunk of preChunks) {
            await channel.send(chunk);
          }
        } catch (err: any) {
          console.error(`[TRANSPORT] Failed to send pre-handoff text: ${err.message}`);
        }
      }

      if (!isProjectAutoChainEnabled()) {
        const noticeChunks = monitor.splitForDiscord(
          formatManualHandoffNotice(agentName, handoff),
          this.maxMessageLength,
          "handoff:auto-chain-disabled",
        );
        for (const chunk of noticeChunks) {
          await channel.send(chunk);
        }
        return true;
      }

      const chainResult = await runHandoffChain(
        channel, agentName, response,
        { originAgent: agentName, initialHandoff: queuedHandoff ?? undefined }
      );

      // Orchestrator debrief
      if (agentName === "orchestrator" && chainResult.entries.length > 1) {
        await this.invokeOrchestratorDebrief(channel, chainResult);
      }

      return true;
    }

    return false;
  }

  // ─── Orchestrator Debrief ─────────────────────────────────────────

  private async invokeOrchestratorDebrief(
    channel: TextChannel,
    chainResult: ChainResult
  ): Promise<void> {
    const summaryLines: string[] = ["[CHAIN_COMPLETE]", "", "## Chain Summary", ""];
    for (const entry of chainResult.entries) {
      summaryLines.push(`### ${entry.agent}`);
      summaryLines.push(entry.response);
      summaryLines.push("");
    }

    const taskId = submitTask({
      channelId: channel.id,
      prompt: summaryLines.join("\n"),
      agent: "orchestrator",
      sessionKey: getProjectSessionKey(channel.id, "orchestrator"),
      maxSteps: 3,
      maxAttempts: 1,
    });

    const spawnResult = await spawnTask(taskId);
    if (!spawnResult) {
      console.error("[DISCORD] Failed to spawn orchestrator debrief");
      return;
    }

    console.log(`[DISCORD] Orchestrator debrief spawned as ${taskId}`);
  }

  // ─── Lifecycle Commands ──────────────────────────────────────────
  //
  // !stop-heartbeats / !stop-bot / !stop-harness route here, NOT through
  // the task-runner. If a shutdown were processed via a Claude task, the
  // task_queue row would be left in `running` state when the bot dies, and
  // crash-recovery on next start would re-issue the prompt — an infinite
  // loop. Bypassing the gateway means no row is created.
  // See: LRN-do-not-task-the-bot-with-self-affecting-actions.

  private async handleLifecycleCommand(message: Message, content: string): Promise<void> {
    // Map each command to its script. Narrow scripts (bot-only, heartbeats-only)
    // live in scripts/; the comprehensive harness-stop is the existing one in
    // bridges/discord/scripts/ which uses `launchctl disable` for durability
    // across login/reboot and also kills orphaned runner subprocesses.
    const scriptRel = {
      "!stop-heartbeats": "scripts/stop-heartbeats.sh",
      "!stop-bot": "scripts/stop-bot.sh",
      "!stop-harness": "bridges/discord/scripts/harness-stop.sh",
    }[content];
    if (!scriptRel) return;

    const scriptPath = join(this.config.harnessRoot, scriptRel);
    if (!existsSync(scriptPath)) {
      await message.reply(`Script not found: \`${scriptPath}\``);
      return;
    }

    // Acknowledge BEFORE spawning the script. For !stop-bot / !stop-harness
    // the bot is about to be killed, so this reply is the last user-visible
    // signal that the command was accepted.
    const willKillSelf = content === "!stop-bot" || content === "!stop-harness";
    const ack = willKillSelf
      ? `Running \`${scriptRel}\`. The bot will go offline shortly. Restart with \`./scripts/start-harness.sh\` from a terminal.`
      : `Running \`${scriptRel}\`. Bot remains online; heartbeats will stop.`;
    await message.reply(ack);

    console.log(`[LIFECYCLE] User ${message.author.id} triggered ${content} → ${scriptPath}`);

    // Detached + ignored stdio so the script survives the bot's death.
    // unref() prevents the parent's event loop from waiting on it.
    const child = spawn("/bin/bash", [scriptPath], {
      detached: true,
      stdio: "ignore",
      cwd: this.config.harnessRoot,
    });
    child.unref();
  }

  // ─── LinkedIn Approval ────────────────────────────────────────────

  private async handleLinkedInApproval(
    message: Message,
    token: string,
    approve: boolean
  ): Promise<void> {
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
        db.prepare("UPDATE linkedin_posts SET status = 'approved' WHERE id = ?").run(post.id);

        const embed = new EmbedBuilder()
          .setTitle("LinkedIn Post Approved")
          .setDescription(`**${post.topic}**\n\n${post.content.slice(0, 300)}${post.content.length > 300 ? "..." : ""}`)
          .setColor(0x0A66C2)
          .setFooter({ text: `Post ${post.id} — publishing...` })
          .setTimestamp();

        await message.reply({ embeds: [embed] });

        const publishNotif = JSON.stringify({
          task: "linkedin-publish",
          channel: "linkedin",
          summary: `Post ${post.id} approved — call linkedin_post with approvalToken "${token}" to publish.`,
          timestamp: new Date().toISOString(),
        });
        const notifyPath = join(this.config.harnessRoot, "heartbeat-tasks", "pending-notifications.jsonl");
        appendFileSync(notifyPath, publishNotif + "\n");
      } else {
        db.prepare("UPDATE linkedin_posts SET status = 'rejected', approval_token = NULL WHERE id = ?").run(post.id);

        const embed = new EmbedBuilder()
          .setTitle("LinkedIn Post Rejected")
          .setDescription(`**${post.topic}**\n\nDraft rejected and token invalidated.`)
          .setColor(0xED4245)
          .setFooter({ text: `Post ${post.id}` })
          .setTimestamp();

        await message.reply({ embeds: [embed] });
      }
    } catch (err: any) {
      await message.reply(`Error processing approval: ${err.message}`);
    }
  }

  // ─── Notification Drain ───────────────────────────────────────────

  private async drainNotifications(notifyFilePath: string): Promise<void> {
    try {
      if (!existsSync(notifyFilePath)) return;

      // Atomic claim via rename to prevent TOCTOU races
      const claimedFile = notifyFilePath + ".draining";
      try {
        renameSync(notifyFilePath, claimedFile);
      } catch (err: any) {
        if (err.code === "ENOENT") return;
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

          const channelId = this.resolveChannelByName(channelName);
          if (!channelId) {
            console.log(`[DISCORD] Notify: channel '${channelName}' not found, skipping`);
            failed.push(line);
            continue;
          }

          // Pick embed color by task type
          const color = task.includes("fail") || task.includes("error") ? 0xED4245
            : task.includes("reminder") || task.includes("assignment") ? 0xFEE75C
            : task.includes("goodnotes") || task.includes("notes") ? 0x57F287
            : task.includes("deploy") ? 0x5865F2
            : task.includes("linkedin") ? 0x0A66C2
            : task.includes("email") || task.includes("emails") || task.includes("calendar") ? 0x0078D4
            : 0x2B2D31;

          // Optional file attachments — notif.files may be an array of
          // string paths or {path, name} objects. Files are validated for
          // existence and Discord's 25 MB non-boosted upload ceiling.
          const attachments: Array<{ attachment: string; name: string }> = [];
          const rawFiles = Array.isArray(notif.files) ? notif.files : [];
          for (const f of rawFiles) {
            const p = typeof f === "string" ? f : (f && f.path);
            if (!p || typeof p !== "string") continue;
            if (!existsSync(p)) {
              console.log(`[DISCORD] Notify: file missing, skipping: ${p}`);
              continue;
            }
            let size = 0;
            try { size = statSync(p).size; } catch { continue; }
            if (size > 25 * 1024 * 1024) {
              console.log(`[DISCORD] Notify: file too large (${size} B), skipping: ${p}`);
              continue;
            }
            const n = (typeof f !== "string" && f && f.name) ? f.name : basename(p);
            attachments.push({ attachment: p, name: n });
          }

          if (attachments.length === 0) {
            await this.sendEmbed(channelId, {
              title: task.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
              description: summary.slice(0, 4000),
              color,
              footer: "AI Harness Heartbeat",
              timestamp: new Date(notif.timestamp || Date.now()),
            });
          } else {
            // Send embed + files together in one Discord message
            const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined;
            if (!channel) {
              failed.push(line);
              continue;
            }
            const builder = new EmbedBuilder()
              .setTitle(task.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()))
              .setDescription(summary.slice(0, 4000))
              .setColor(color)
              .setFooter({ text: "AI Harness Heartbeat" })
              .setTimestamp(new Date(notif.timestamp || Date.now()));
            await channel.send({ embeds: [builder], files: attachments });
          }

          console.log(
            `[DISCORD] Sent '${task}' to #${channelName}` +
            (attachments.length > 0 ? ` (+${attachments.length} file${attachments.length === 1 ? "" : "s"})` : "")
          );
        } catch (err: any) {
          console.error(`[DISCORD] Notify parse failed: ${err.message}`);
          failed.push(line);
        }
      }

      if (failed.length > 0) {
        appendFileSync(notifyFilePath, failed.join("\n") + "\n");
      }
      unlinkSync(claimedFile);
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        console.error(`[DISCORD] Notify error: ${err.message}`);
      }
    }
  }

  // ─── Channel Auto-Setup ───────────────────────────────────────────

  private async ensureChannels(): Promise<void> {
    for (const guild of this.client.guilds.cache.values()) {
      try {
        // School category + channels
        let schoolCat = guild.channels.cache.find(
          (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === "school"
        );
        if (!schoolCat) {
          schoolCat = await guild.channels.create({
            name: "School",
            type: ChannelType.GuildCategory,
            reason: "AI Harness school integration",
          });
          console.log(`[DISCORD] Created "School" category in ${guild.name}`);
        }

        const schoolChannels = [
          { name: "calendar", topic: "Canvas iCal feed — assignments, events, and due dates" },
          { name: "goodnotes", topic: "GoodNotes PDF export notifications" },
          { name: "emails", topic: "Email alerts, calendar notifications, watched sender alerts" },
        ];
        for (const sc of schoolChannels) {
          const existing = guild.channels.cache.find(
            (c) => c.name === sc.name && c.parentId === schoolCat!.id
          );
          if (!existing) {
            await guild.channels.create({
              name: sc.name,
              type: ChannelType.GuildText,
              parent: schoolCat.id,
              topic: sc.topic,
              reason: "AI Harness integration",
            });
            console.log(`[DISCORD] Created #${sc.name}`);
          }
        }

        // Course channels with education agent
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
            console.log(`[DISCORD] Created #${cc.name} with education agent`);
          } else {
            const cfg = getChannelConfig(existing.id);
            if (!cfg?.agent) {
              setChannelConfig(existing.id, { agent: "education" });
            }
          }
        }

        // LinkedIn channel (top-level)
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
          console.log(`[DISCORD] Created #linkedin`);
        }

        // Performance channel (top-level) — destination for weekly role-
        // telemetry heartbeat and other long-form metrics reports.
        const perfCh = guild.channels.cache.find(
          (c) => c.name === "performance" && c.type === ChannelType.GuildText
        );
        if (!perfCh) {
          await guild.channels.create({
            name: "performance",
            type: ChannelType.GuildText,
            topic: "Per-role telemetry, cost tracking, runtime quality drift signals",
            reason: "AI Harness performance telemetry",
          });
          console.log(`[DISCORD] Created #performance`);
        }

        // Control panel (top-level) — human-operated deterministic ops surface.
        let controlCh = guild.channels.cache.find(
          (c) => c.name === CONTROL_CHANNEL_NAME && c.type === ChannelType.GuildText
        );
        if (!controlCh) {
          controlCh = await guild.channels.create({
            name: CONTROL_CHANNEL_NAME,
            type: ChannelType.GuildText,
            topic: "Human-operated controls: AI autorun kill-switch, heartbeat toggles, process reaper — no AI tokens",
            reason: "AI Harness control panel",
          });
          console.log(`[DISCORD] Created #${CONTROL_CHANNEL_NAME}`);
        }
        if (controlCh?.type === ChannelType.GuildText) {
          await ensureControlPanel(controlCh as TextChannel);
        }
      } catch (err: any) {
        console.error(`[DISCORD] Channel setup failed: ${err.message}`);
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private convertMessage(message: Message, attachmentPaths?: string[]): GatewayMessage {
    return {
      id: message.id,
      channelId: message.channel.id,
      // TextChannels have a `name`; DMs don't — leave undefined there.
      channelName: (message.channel as { name?: string }).name || undefined,
      userId: message.author.id,
      text: message.content,
      attachmentPaths: attachmentPaths || [],
      replyToId: message.reference?.messageId || undefined,
      guildId: message.guild?.id,
      transportMeta: message,
    };
  }

  private async downloadAttachments(message: Message): Promise<string[]> {
    // Filter to image + PDF attachments — see isSupportedAttachment for
    // rationale (Read-tool renderable, no arbitrary binaries).
    const supported = message.attachments.filter((a) =>
      isSupportedAttachment({ contentType: a.contentType, name: a.name }),
    );
    if (supported.size === 0) return [];

    // 50MB cap mirrors Discord's nitro upload limit and keeps a runaway
    // attachment from filling .tmp. Files over the cap get logged and
    // skipped.
    const MAX_BYTES = 50 * 1024 * 1024;

    const dir = join(this.config.harnessRoot, "bridges", "discord", ".tmp", "attachments");
    mkdirSync(dir, { recursive: true });

    const paths: string[] = [];
    for (const [, attachment] of supported) {
      if (attachment.size > MAX_BYTES) {
        console.warn(
          `[DISCORD] Skipping ${attachment.name} (${attachment.size} bytes) — exceeds ${MAX_BYTES}-byte cap`,
        );
        continue;
      }
      try {
        const fallbackName = (attachment.contentType || "").includes("pdf") ? "file.pdf" : "image.png";
        const ext = (attachment.name || fallbackName).split(".").pop() || "bin";
        const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
        const filepath = join(dir, filename);
        const response = await fetch(attachment.url);
        const buffer = Buffer.from(await response.arrayBuffer());
        writeFileSync(filepath, buffer);
        paths.push(filepath);
      } catch (err: any) {
        console.error(`[DISCORD] Failed to download attachment ${attachment.name}: ${err.message}`);
      }
    }
    return paths;
  }
}

// ─── Utility ────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
