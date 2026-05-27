/**
 * Control Panel — a deterministic, token-free operations surface in #control-panel.
 *
 * Renders persistent buttons + a heartbeat select menu. Every handler here runs
 * pure code (DB reads, file writes, process signals) and NEVER spawns an AI, so
 * it is safe to operate by hand and works even when AI is fully frozen (these
 * are Discord component interactions, not messages). See [[autorun-mode]].
 *
 * Controls:
 *   • Autorun mode:  🟢 Resume All · ⏸ Pause Autonomous · 🧊 Full Freeze
 *   • Process ops:   🧹 Reap Orphans · 📋 List Runners · 🔄 Refresh
 *   • Heartbeats:    select menu to toggle each AI-spawning heartbeat on/off
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type Client,
  type Interaction,
  type Message,
  type StringSelectMenuInteraction,
  type TextChannel,
} from "discord.js";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  describeAutorunMode,
  getAutorunMode,
  setAutorunMode,
  type AutorunMode,
} from "./autorun-mode.js";
import {
  formatReapReport,
  listHarnessRunners,
  reapOrphanedRunners,
} from "./process-reaper.js";
import { cancelChannelTasks, getRunningTasks } from "./task-runner.js";
import { cancelSubagent } from "./subagent-manager.js";
import { getRunning as getRunningSubagents } from "./process-registry.js";
import { getActiveCount, getInstances } from "./instance-monitor.js";
import { getDb } from "./db.js";
import { getChannelConfig, setChannelConfig } from "./channel-config-store.js";
import { listAgentNames } from "./agent-loader.js";
import type { AgentRuntime } from "./agent-loader.js";
import { formatClaudeUsage, refreshClaudeUsage } from "./usage-limits.js";

const RUNTIMES: AgentRuntime[] = ["claude", "codex"];

/** Resolve a channelId to a human name (#name) using the Discord client cache. */
export type ChannelNameResolver = (channelId: string) => string;

function clientResolver(client: Client): ChannelNameResolver {
  return (channelId: string) => {
    const ch: any = client.channels.cache.get(channelId);
    return ch?.name ? `#${ch.name}` : channelId;
  };
}

// Kill operations are real side effects on shared state. Injectable so tests
// never terminate live task/subagent PIDs (the kill ops read the live DB).
let killTasksInChannel = cancelChannelTasks;
let killSubagentById = cancelSubagent;

export function setControlKillForTests(
  fns: {
    cancelChannelTasks?: typeof cancelChannelTasks;
    cancelSubagent?: typeof cancelSubagent;
  } | null,
): void {
  killTasksInChannel = fns?.cancelChannelTasks ?? cancelChannelTasks;
  killSubagentById = fns?.cancelSubagent ?? cancelSubagent;
}

const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";
const HEARTBEAT_DIR = join(HARNESS_ROOT, "heartbeat-tasks");
const PANEL_TITLE = "🎛️ **AI Harness Control Panel**";
const CONFIG_TITLE = "🎚️ **Channel Configuration**";
export const CONTROL_CHANNEL_NAME = "control-panel";

// ─── Heartbeat enumeration / toggle (deterministic, no launchd needed) ──────
// Setting `enabled:false` in the config is sufficient — heartbeat-runner.py
// skips disabled tasks at its `enabled` gate, so the plist may still fire but
// does nothing (no AI, negligible cost).

export interface HeartbeatInfo {
  name: string;
  enabled: boolean;
  isAI: boolean;
}

export function listHeartbeats(): HeartbeatInfo[] {
  let files: string[] = [];
  try {
    files = readdirSync(HEARTBEAT_DIR).filter(
      (f) => f.endsWith(".json") && !f.endsWith(".state.json"),
    );
  } catch {
    return [];
  }
  const out: HeartbeatInfo[] = [];
  for (const file of files) {
    try {
      const cfg = JSON.parse(readFileSync(join(HEARTBEAT_DIR, file), "utf-8"));
      // Heartbeat configs carry a schedule or cron; skip registries like projects.json.
      if (!cfg || (!cfg.schedule && !cfg.cron)) continue;
      const name = cfg.name || file.replace(/\.json$/, "");
      const isAI =
        cfg.type !== "script" || Boolean(cfg.provider) || Array.isArray(cfg.allowed_tools);
      out.push({ name, enabled: cfg.enabled !== false, isAI });
    } catch {
      /* skip malformed */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function toggleHeartbeat(name: string, enabled: boolean): boolean {
  const configPath = join(HEARTBEAT_DIR, `${name}.json`);
  if (!existsSync(configPath)) return false;
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    cfg.enabled = enabled;
    writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
    // Re-enabling clears the auto-pause failure counter so the runner resumes.
    if (enabled) {
      const statePath = join(HEARTBEAT_DIR, `${name}.state.json`);
      if (existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, "utf-8"));
        state.consecutive_failures = 0;
        writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
      }
    }
    return true;
  } catch {
    return false;
  }
}

// ─── Runtime status + kill ops (deterministic reads/signals) ────────────────

function deadLetterCount(): number {
  try {
    const row = getDb().prepare("SELECT COUNT(*) AS n FROM dead_letter").get() as { n: number };
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

interface RunningByChannel {
  channelId: string;
  tasks: number;
  subagents: number;
}

function runningByChannel(): RunningByChannel[] {
  const map = new Map<string, RunningByChannel>();
  const bump = (channelId: string | undefined, key: "tasks" | "subagents") => {
    if (!channelId) return;
    const e = map.get(channelId) ?? { channelId, tasks: 0, subagents: 0 };
    e[key]++;
    map.set(channelId, e);
  };
  try {
    for (const t of getRunningTasks()) bump((t as any).channel_id, "tasks");
  } catch {}
  try {
    for (const s of getRunningSubagents()) bump(s.parentChannelId, "subagents");
  } catch {}
  return [...map.values()];
}

function formatUptime(secs: number): string {
  const s = Math.floor(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function killChannelRunners(channelId: string): { tasks: number; subagents: number } {
  let tasks = 0;
  let subagents = 0;
  try {
    tasks = killTasksInChannel(channelId);
  } catch {}
  try {
    for (const s of getRunningSubagents()) {
      if (s.parentChannelId === channelId && killSubagentById(s.id)) subagents++;
    }
  } catch {}
  return { tasks, subagents };
}

function killAllRunners(): { tasks: number; subagents: number } {
  let tasks = 0;
  let subagents = 0;
  try {
    const channels = new Set(
      getRunningTasks()
        .map((t: any) => t.channel_id)
        .filter(Boolean),
    );
    for (const c of channels) tasks += killTasksInChannel(c as string);
  } catch {}
  try {
    for (const s of getRunningSubagents()) if (killSubagentById(s.id)) subagents++;
  } catch {}
  return { tasks, subagents };
}

function formatAgentActivity(): string {
  const live = getInstances().filter((i) => i.status === "running");
  if (live.length === 0) return "🧠 No agents are currently running.";
  const lines: string[] = ["🧠 **Live agent activity** (latest thought / message)", ""];
  for (const i of live.slice(0, 8)) {
    const thought = (i.thinkingText || i.assistantText || "").trim().replace(/\s+/g, " ");
    const tool = i.currentTool ? ` · 🔧 ${i.currentTool.toolName}` : "";
    const snippet = thought ? thought.slice(-380) : "(no output yet)";
    lines.push(`**${i.agent}** (${i.runtime}) · \`${i.taskId.slice(0, 18)}\`${tool}`);
    lines.push(`> ${snippet}`);
    lines.push("");
  }
  const text = lines.join("\n");
  return text.length > 1900 ? text.slice(0, 1900) + "\n…(truncated)" : text;
}

// ─── Panel rendering ────────────────────────────────────────────────────────

function autorunButtons(mode: AutorunMode): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("control:autorun:normal")
      .setLabel("Resume All")
      .setEmoji("🟢")
      .setStyle(ButtonStyle.Success)
      .setDisabled(mode === "normal"),
    new ButtonBuilder()
      .setCustomId("control:autorun:autonomous")
      .setLabel("Pause Autonomous")
      .setEmoji("⏸️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(mode === "autonomous"),
    new ButtonBuilder()
      .setCustomId("control:autorun:full")
      .setLabel("Full Freeze")
      .setEmoji("🧊")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(mode === "full"),
  );
}

function opButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("control:reap").setLabel("Reap Orphans").setEmoji("🧹").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("control:list").setLabel("List Runners").setEmoji("📋").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("control:activity").setLabel("Agent Activity").setEmoji("🧠").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("control:refresh").setLabel("Refresh").setEmoji("🔄").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("control:kill-all").setLabel("Kill ALL").setEmoji("⛔").setStyle(ButtonStyle.Danger),
  );
}

/** Select menu to kill every runner in a chosen channel (by name). Omitted when nothing is running. */
function killChannelSelect(resolve?: ChannelNameResolver): ActionRowBuilder<StringSelectMenuBuilder> | null {
  const channels = runningByChannel().slice(0, 25);
  if (channels.length === 0) return null;
  const menu = new StringSelectMenuBuilder()
    .setCustomId("control:kill-channel")
    .setPlaceholder("Kill all runners in a channel…")
    .addOptions(
      channels.map((c) => ({
        label: (resolve ? resolve(c.channelId) : c.channelId).slice(0, 100),
        value: c.channelId,
        description: `${c.tasks} task(s), ${c.subagents} subagent(s)`.slice(0, 100),
      })),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function heartbeatSelect(): ActionRowBuilder<StringSelectMenuBuilder> | null {
  // The select toggles AI-spawning heartbeats (the token-relevant ones). Discord
  // caps a select at 25 options.
  const ai = listHeartbeats().filter((h) => h.isAI).slice(0, 25);
  if (ai.length === 0) return null;
  const menu = new StringSelectMenuBuilder()
    .setCustomId("control:hb-toggle")
    .setPlaceholder("Toggle an AI heartbeat on/off…")
    .addOptions(
      ai.map((h) => ({
        label: `${h.enabled ? "✅" : "⛔"} ${h.name}`.slice(0, 100),
        value: h.name,
        description: h.enabled ? "Enabled — click to disable" : "Disabled — click to enable",
      })),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export interface PanelPayload {
  content: string;
  components: any[];
}

export interface BuildPanelOptions {
  resolveChannelName?: ChannelNameResolver;
}

export function buildControlPanel(opts: BuildPanelOptions = {}): PanelPayload {
  const mode = getAutorunMode();
  const hbs = listHeartbeats();
  const aiOn = hbs.filter((h) => h.isAI && h.enabled).length;
  const aiTotal = hbs.filter((h) => h.isAI).length;

  const runningTasks = (() => { try { return getRunningTasks().length; } catch { return 0; } })();
  const subs = (() => { try { return getRunningSubagents().length; } catch { return 0; } })();
  const liveAgents = (() => { try { return getActiveCount(); } catch { return 0; } })();
  const renderMode = process.env.HARNESS_RENDER_CONTEXT || "off";

  const content = [
    PANEL_TITLE,
    "",
    `**AI Autorun:** ${describeAutorunMode(mode)}`,
    "",
    "**Status**",
    `> running tasks: ${runningTasks} · subagents: ${subs} · live agents: ${liveAgents}`,
    `> dead-letter: ${deadLetterCount()} · render: \`${renderMode}\` · uptime: ${formatUptime(process.uptime())}`,
    `> AI heartbeats enabled: ${aiOn}/${aiTotal}`,
    "",
    "**Claude usage limits**",
    `> ${formatClaudeUsage()}`,
    "",
    "_Human-operated — buttons run deterministic ops, no AI tokens._",
  ].join("\n");

  const rows: any[] = [autorunButtons(mode), opButtons()];
  const hb = heartbeatSelect();
  if (hb) rows.push(hb);
  const kill = killChannelSelect(opts.resolveChannelName);
  if (kill) rows.push(kill);
  return { content, components: rows };
}

function panelFor(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): PanelPayload {
  return buildControlPanel({ resolveChannelName: clientResolver(interaction.client) });
}

// ─── Interaction handling ─────────────────────────────────────────────────
// NOTE: this path must NEVER spawn AI and must NEVER be gated by autorun mode —
// it is the ONLY way to switch the kill-switch back off.

export async function handleControlInteraction(interaction: Interaction): Promise<boolean> {
  if (interaction.isButton() && interaction.customId.startsWith("control:")) {
    await handleControlButton(interaction);
    return true;
  }
  if (interaction.isStringSelectMenu()) {
    const id = interaction.customId;
    if (id === "control:hb-toggle") { await handleHeartbeatToggle(interaction); return true; }
    if (id === "control:kill-channel") { await handleKillChannel(interaction); return true; }
    if (id === "control:cfg-channel") { await handleCfgChannel(interaction); return true; }
    if (id.startsWith("control:cfg-runtime:")) { await handleCfgRuntime(interaction); return true; }
    if (id.startsWith("control:cfg-agent:")) { await handleCfgAgent(interaction); return true; }
  }
  return false;
}

async function handleControlButton(interaction: ButtonInteraction): Promise<void> {
  const id = interaction.customId; // control:<action>[:<arg>]

  if (id.startsWith("control:autorun:")) {
    const mode = id.split(":")[2] as AutorunMode;
    setAutorunMode(mode === "autonomous" || mode === "full" ? mode : "normal");
    await interaction.update(panelFor(interaction));
    return;
  }

  if (id === "control:refresh") {
    // Usage probe is a network call (keychain read + GET) that can exceed
    // Discord's 3s ack window — defer first, fetch, then edit the message.
    await interaction.deferUpdate();
    await refreshClaudeUsage().catch(() => {});
    await interaction.message.edit(panelFor(interaction)).catch(() => {});
    return;
  }

  if (id === "control:reap") {
    const report = reapOrphanedRunners();
    await interaction.reply({ content: formatReapReport(report), ephemeral: true });
    await interaction.message.edit(panelFor(interaction)).catch(() => {});
    return;
  }

  if (id === "control:list") {
    await interaction.reply({ content: formatRunners(), ephemeral: true });
    return;
  }

  if (id === "control:activity") {
    await interaction.reply({ content: formatAgentActivity(), ephemeral: true });
    return;
  }

  if (id === "control:kill-all") {
    const killed = killAllRunners();
    await interaction.reply({
      content: `⛔ Cancelled ${killed.tasks} task(s) and ${killed.subagents} subagent(s) across all channels.`,
      ephemeral: true,
    });
    await interaction.message.edit(panelFor(interaction)).catch(() => {});
    return;
  }
}

async function handleHeartbeatToggle(interaction: StringSelectMenuInteraction): Promise<void> {
  const name = interaction.values[0];
  const current = listHeartbeats().find((h) => h.name === name);
  if (!current) {
    await interaction.reply({ content: `Heartbeat \`${name}\` not found.`, ephemeral: true });
    return;
  }
  const ok = toggleHeartbeat(name, !current.enabled);
  await interaction.update(panelFor(interaction));
  await interaction.followUp({
    content: ok
      ? `${!current.enabled ? "✅ Enabled" : "⛔ Disabled"} heartbeat \`${name}\`.`
      : `⚠ Failed to toggle \`${name}\`.`,
    ephemeral: true,
  });
}

async function handleKillChannel(interaction: StringSelectMenuInteraction): Promise<void> {
  const channelId = interaction.values[0];
  const killed = killChannelRunners(channelId);
  const name = clientResolver(interaction.client)(channelId);
  await interaction.update(panelFor(interaction));
  await interaction.followUp({
    content: `⛔ Killed ${killed.tasks} task(s) + ${killed.subagents} subagent(s) in ${name}.`,
    ephemeral: true,
  });
}

// ─── Channel configuration (runtime + agent per channel) ────────────────────

interface ConfiguredChannel {
  channelId: string;
  agent: string | null;
  runtime: string | null;
}

function listConfiguredChannels(): ConfiguredChannel[] {
  try {
    const rows = getDb()
      .prepare("SELECT channel_id, agent, runtime FROM channel_configs ORDER BY channel_id")
      .all() as { channel_id: string; agent: string | null; runtime: string | null }[];
    return rows.map((r) => ({ channelId: r.channel_id, agent: r.agent, runtime: r.runtime }));
  } catch {
    return [];
  }
}

/**
 * Second panel message: pick a channel, then set its runtime / agent. STATELESS —
 * the chosen channelId is embedded in the runtime/agent select customIds, so it
 * survives restarts and needs no per-user state. Deterministic, spends no tokens.
 */
export function buildChannelConfigPanel(
  opts: { resolveChannelName?: ChannelNameResolver; selectedChannelId?: string } = {},
): PanelPayload {
  const resolve = opts.resolveChannelName;
  const channels = listConfiguredChannels().slice(0, 25);
  const selected = opts.selectedChannelId
    ? channels.find((c) => c.channelId === opts.selectedChannelId)
    : undefined;
  const selName = selected ? (resolve ? resolve(selected.channelId) : selected.channelId) : null;
  const cid = opts.selectedChannelId || "";

  const content = [
    CONFIG_TITLE,
    "",
    selected
      ? `**Selected:** ${selName} — runtime: \`${selected.runtime || "default"}\` · agent: \`${selected.agent || "default"}\``
      : "_Pick a channel, then set its runtime / agent below._",
  ].join("\n");

  const channelMenu = new StringSelectMenuBuilder()
    .setCustomId("control:cfg-channel")
    .setPlaceholder("Pick a channel to configure…")
    .addOptions(
      channels.length
        ? channels.map((c) => ({
            label: (resolve ? resolve(c.channelId) : c.channelId).slice(0, 100),
            value: c.channelId,
            description: `runtime: ${c.runtime || "default"} · agent: ${c.agent || "default"}`.slice(0, 100),
            default: c.channelId === opts.selectedChannelId,
          }))
        : [{ label: "(no configured channels)", value: "none" }],
    )
    .setDisabled(channels.length === 0);

  const runtimeMenu = new StringSelectMenuBuilder()
    .setCustomId(`control:cfg-runtime:${cid}`)
    .setPlaceholder(selected ? `Set runtime for ${selName}…` : "Pick a channel first…")
    .addOptions(RUNTIMES.map((rt) => ({ label: rt, value: rt, default: selected?.runtime === rt })))
    .setDisabled(!selected);

  const agents = listAgentNames().slice(0, 25);
  const agentMenu = new StringSelectMenuBuilder()
    .setCustomId(`control:cfg-agent:${cid}`)
    .setPlaceholder(selected ? `Set agent (personality) for ${selName}…` : "Pick a channel first…")
    .addOptions(
      (agents.length ? agents : ["default"]).map((a) => ({ label: a, value: a, default: selected?.agent === a })),
    )
    .setDisabled(!selected);

  return {
    content,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(channelMenu),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(runtimeMenu),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(agentMenu),
    ],
  };
}

function configPanelFor(interaction: StringSelectMenuInteraction, selectedChannelId?: string): PanelPayload {
  return buildChannelConfigPanel({
    resolveChannelName: clientResolver(interaction.client),
    selectedChannelId,
  });
}

async function handleCfgChannel(interaction: StringSelectMenuInteraction): Promise<void> {
  const channelId = interaction.values[0];
  if (channelId === "none") {
    await interaction.deferUpdate();
    return;
  }
  await interaction.update(configPanelFor(interaction, channelId));
}

async function handleCfgRuntime(interaction: StringSelectMenuInteraction): Promise<void> {
  const channelId = interaction.customId.split(":")[2] || "";
  const runtime = interaction.values[0] as AgentRuntime;
  if (!channelId) {
    await interaction.reply({ content: "Pick a channel first.", ephemeral: true });
    return;
  }
  setChannelConfig(channelId, { runtime });
  await interaction.update(configPanelFor(interaction, channelId));
  await interaction.followUp({
    content: `✅ Runtime of ${clientResolver(interaction.client)(channelId)} → \`${runtime}\`.`,
    ephemeral: true,
  });
}

async function handleCfgAgent(interaction: StringSelectMenuInteraction): Promise<void> {
  const channelId = interaction.customId.split(":")[2] || "";
  const agent = interaction.values[0];
  if (!channelId) {
    await interaction.reply({ content: "Pick a channel first.", ephemeral: true });
    return;
  }
  setChannelConfig(channelId, { agent });
  await interaction.update(configPanelFor(interaction, channelId));
  await interaction.followUp({
    content: `✅ Agent of ${clientResolver(interaction.client)(channelId)} → \`${agent}\`.`,
    ephemeral: true,
  });
}

function formatRunners(): string {
  const tasks = (() => {
    try {
      return getRunningTasks();
    } catch {
      return [];
    }
  })();
  const subs = (() => {
    try {
      return getRunningSubagents();
    } catch {
      return [];
    }
  })();
  const procs = listHarnessRunners();

  const lines: string[] = ["📋 **Active runners**", ""];
  lines.push(`**Tracked tasks (DB):** ${tasks.length}`);
  for (const t of tasks.slice(0, 10)) {
    lines.push(`  • \`${t.id}\` ${(t as any).agent || "default"}/${(t as any).runtime || "?"} pid=${(t as any).pid ?? "?"} (${(t as any).status})`);
  }
  lines.push(`**Subagents:** ${subs.length}`);
  for (const s of subs.slice(0, 10)) {
    lines.push(`  • \`${s.id}\` ${s.agent || "default"}/${s.runtime} pid=${s.pid}`);
  }
  lines.push(`**OS runner processes:** ${procs.length}`);
  for (const p of procs.slice(0, 15)) {
    lines.push(`  • pid ${p.pid} (${p.kind}, ${Math.floor(p.ageSecs / 60)}m)`);
  }
  const text = lines.join("\n");
  return text.length > 1900 ? text.slice(0, 1900) + "\n…(truncated)" : text;
}

// ─── Panel installation (called on startup) ─────────────────────────────────

/**
 * Post or refresh the single control-panel message. Finds an existing panel
 * authored by the bot (by title marker) and edits it in place, so restarts do
 * not stack duplicate panels.
 */
export async function ensureControlPanel(channel: TextChannel): Promise<void> {
  const resolve = clientResolver(channel.client);
  // Populate the usage cache once on startup so the panel shows live numbers.
  await refreshClaudeUsage().catch(() => {});
  try {
    const recent = await channel.messages.fetch({ limit: 30 });
    const selfId = channel.client.user?.id;
    const upsert = async (title: string, payload: PanelPayload) => {
      const existing = recent.find(
        (m: Message) => m.author.id === selfId && m.content.startsWith(title),
      );
      if (existing) await existing.edit(payload);
      else await channel.send(payload);
    };
    // Main panel first, then the channel-config panel (two persistent messages).
    await upsert(PANEL_TITLE, buildControlPanel({ resolveChannelName: resolve }));
    await upsert(CONFIG_TITLE, buildChannelConfigPanel({ resolveChannelName: resolve }));
  } catch (err: any) {
    console.error(`[CONTROL-PANEL] Failed to install panel: ${err?.message || String(err)}`);
  }
}
