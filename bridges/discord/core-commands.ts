/**
 * Core Commands — Transport-agnostic command implementations.
 *
 * Each command is a pure function that returns a CommandResult.
 * The transport adapter decides how to present it (Discord reply, iMessage text, etc.).
 *
 * Commands that require transport-specific features (channel creation, guild access)
 * are handled by the transport adapter directly, not here.
 */

import type { CommandResult } from "./core-types.js";
import { getSession, clearChannelSessions } from "./session-store.js";
import { getChannelConfig, setChannelConfig } from "./channel-config-store.js";
import { getProject, listProjects, updateProject } from "./project-manager.js";
import { getTaskPidForChannel, cancelChannelTasks, listDeadLetters, retryDeadLetter, spawnTask } from "./task-runner.js";
import { listAgentNames, readAgentPrompt } from "./agent-loader.js";
import { getRunning } from "./process-registry.js";
import { spawnSubagent, cancelSubagent } from "./subagent-manager.js";
import { approveLearning, rejectLearning, getVaultStats } from "./promotion-handler.js";
import { getDb } from "./db.js";
import { existsSync, writeFileSync, mkdirSync, statSync } from "fs";
import { join } from "path";

const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";

// ─── Command Registry ────────────────────────────────────────────────

export interface CommandContext {
  channelId: string;
  userId: string;
  guildId?: string;
  /** Full raw command text (e.g., "/agent builder") */
  rawText: string;
  /** Callback for releasing the channel queue after /stop */
  releaseChannel?: () => void;
}

/**
 * Execute a command. Returns CommandResult if handled, null if not a recognized command.
 */
export async function executeCommand(ctx: CommandContext): Promise<CommandResult | null> {
  const text = ctx.rawText.trim();

  // /stop
  if (text === "/stop") {
    return commandStop(ctx);
  }

  // /new
  if (text === "/new") {
    return commandNew(ctx);
  }

  // /status
  if (text === "/status") {
    return commandStatus(ctx);
  }

  // /agents
  if (text === "/agents") {
    return commandAgents();
  }

  // /agent clear
  if (text === "/agent clear") {
    return commandAgentClear(ctx);
  }

  // /agent create <name> "description"
  const createMatch = text.match(/^\/agent\s+create\s+(\w+)\s+"([^"]+)"$/);
  if (createMatch) {
    return commandAgentCreate(createMatch[1], createMatch[2]);
  }

  // /agent <name>
  const agentMatch = text.match(/^\/agent\s+(\w+)$/);
  if (agentMatch) {
    return commandAgentSet(ctx, agentMatch[1]);
  }

  // /model <name>
  const modelMatch = text.match(/^\/model\s+(.+)$/);
  if (modelMatch) {
    return commandModelSet(ctx, modelMatch[1].trim());
  }

  // /config
  if (text === "/config") {
    return commandConfig(ctx);
  }

  // /tasks
  if (text === "/tasks") {
    return commandTasks();
  }

  // /cancel <id>
  const cancelMatch = text.match(/^\/cancel\s+(\S+)$/);
  if (cancelMatch) {
    return commandCancel(cancelMatch[1]);
  }

  // /approve <id>
  const approveMatch = text.match(/^\/approve\s+(\S+)$/);
  if (approveMatch) {
    return { text: approveLearning(approveMatch[1]).message };
  }

  // /reject <id>
  const rejectMatch = text.match(/^\/reject\s+(\S+)$/);
  if (rejectMatch) {
    return { text: rejectLearning(rejectMatch[1]).message };
  }

  // /vault-status
  if (text === "/vault-status") {
    return commandVaultStatus();
  }

  // /dead-letter
  if (text === "/dead-letter") {
    return commandDeadLetter();
  }

  // /retry <id>
  const retryMatch = text.match(/^\/retry\s+(\S+)$/);
  if (retryMatch) {
    return commandRetry(retryMatch[1]);
  }

  // /db-status
  if (text === "/db-status") {
    return commandDbStatus();
  }

  // /project list
  if (text === "/project list") {
    return commandProjectList();
  }

  // /project agents <agents>
  const projectAgentsMatch = text.match(/^\/project\s+agents\s+([\w,]+)$/);
  if (projectAgentsMatch) {
    return commandProjectAgents(ctx, projectAgentsMatch[1]);
  }

  // /project close
  if (text === "/project close") {
    // Needs guild access — return null to let transport handle it
    return null;
  }

  // /spawn — needs subagent system
  const spawnMatch = text.match(/^\/spawn\s+(?:--agent\s+(\w+)\s+)?(.+)$/s);
  if (spawnMatch) {
    return commandSpawn(ctx, spawnMatch[2], spawnMatch[1]);
  }

  // Commands that need Discord-specific features (return null → transport handles them):
  // /channel create, /project create, /project adopt, /project close
  if (text.startsWith("/channel create") || text.startsWith("/project create") || text.startsWith("/project adopt")) {
    return null;
  }

  // Not a recognized command
  return null;
}

// ─── Command Implementations ─────────────────────────────────────────

function commandStop(ctx: CommandContext): CommandResult {
  const pid = getTaskPidForChannel(ctx.channelId);
  if (!pid) return { text: "Nothing running in this channel." };
  try { process.kill(pid, "SIGTERM"); } catch {}
  cancelChannelTasks(ctx.channelId);
  ctx.releaseChannel?.();
  return { text: "Stopped the active request." };
}

function commandNew(ctx: CommandContext): CommandResult {
  const cleared = clearChannelSessions(ctx.channelId);
  return {
    text: cleared > 0
      ? `Cleared ${cleared} session(s). Next message starts a fresh conversation.`
      : "No active session in this channel.",
  };
}

function commandStatus(ctx: CommandContext): CommandResult {
  const session = getSession(ctx.channelId);
  return {
    text: session
      ? `Active session: \`${session}\``
      : "No active session in this channel.",
  };
}

function commandAgents(): CommandResult {
  const agents = listAgentNames();
  if (agents.length === 0) return { text: "No agent personalities found." };
  return { text: `**Available agents:**\n${agents.map(a => `• \`${a}\``).join("\n")}` };
}

function commandAgentClear(ctx: CommandContext): CommandResult {
  const cfg = getChannelConfig(ctx.channelId);
  if (cfg?.agent) {
    setChannelConfig(ctx.channelId, { agent: undefined } as any);
    return { text: "Agent cleared. Channel will use default behavior." };
  }
  return { text: "No agent set on this channel." };
}

function commandAgentCreate(name: string, description: string): CommandResult {
  const agentsDir = join(HARNESS_ROOT, ".claude", "agents");
  try { mkdirSync(agentsDir, { recursive: true }); } catch {}
  const agentFile = join(agentsDir, `${name}.md`);
  if (existsSync(agentFile)) {
    return { text: `Agent \`${name}\` already exists.` };
  }
  const template = `# ${name.charAt(0).toUpperCase() + name.slice(1)} Agent\n\n${description}\n\n## Behavior\n- Follow the description above\n- Be thorough and precise\n- If your work is not complete and you need to continue, end your response with [CONTINUE]. If you are done, do not include this marker.\n\n## Default Tools\nAll tools available. Destructive Bash commands are blocked by guardrails.\n`;
  writeFileSync(agentFile, template);
  return { text: `Agent \`${name}\` created.` };
}

function commandAgentSet(ctx: CommandContext, name: string): CommandResult {
  const available = listAgentNames();
  if (!available.includes(name)) {
    return { text: `Agent \`${name}\` not found. Available: ${available.map(a => `\`${a}\``).join(", ") || "none"}` };
  }
  setChannelConfig(ctx.channelId, { agent: name });
  return { text: `Channel agent set to \`${name}\`.` };
}

function commandModelSet(ctx: CommandContext, model: string): CommandResult {
  setChannelConfig(ctx.channelId, { model });
  return { text: `Channel model set to \`${model}\`.` };
}

function commandConfig(ctx: CommandContext): CommandResult {
  const cfg = getChannelConfig(ctx.channelId);
  const session = getSession(ctx.channelId);
  if (!cfg && !session) return { text: "No configuration set for this channel." };

  const lines: string[] = ["**Channel Config:**"];
  if (cfg?.agent) lines.push(`• Agent: \`${cfg.agent}\``);
  if (cfg?.model) lines.push(`• Model: \`${cfg.model}\``);
  if (cfg?.permissionMode) lines.push(`• Permission mode: \`${cfg.permissionMode}\``);
  if (session) lines.push(`• Session: \`${session}\``);
  if (cfg?.allowedTools?.length) lines.push(`• Allowed tools: ${cfg.allowedTools.join(", ")}`);
  if (cfg?.disallowedTools?.length) lines.push(`• Disallowed tools: ${cfg.disallowedTools.join(", ")}`);
  return { text: lines.join("\n") };
}

function commandTasks(): CommandResult {
  const running = getRunning();
  if (running.length === 0) return { text: "No running subagents." };
  const lines = running.map(
    e => `• \`${e.id}\` (${e.agent || "default"}) — ${e.description.slice(0, 80)}`
  );
  return { text: `**Running subagents (${running.length}):**\n${lines.join("\n")}` };
}

function commandCancel(id: string): CommandResult {
  const cancelled = cancelSubagent(id);
  return {
    text: cancelled
      ? `Subagent \`${id}\` cancelled.`
      : `Subagent \`${id}\` not found or not running.`,
  };
}

function commandVaultStatus(): CommandResult {
  const stats = getVaultStats();
  const statusLines = Object.entries(stats.byStatus).map(([k, v]) => `  ${k}: ${v}`).join("\n");
  const typeLines = Object.entries(stats.byType).map(([k, v]) => `  ${k}: ${v}`).join("\n");
  const recentLines = stats.recentLearnings.map(l => `  • ${l.id}: ${l.title} (×${l.recurrence})`).join("\n");
  return {
    text: `**Vault Status** (${stats.total} learnings)\n` +
      `**By status:**\n${statusLines || "  (none)"}\n` +
      `**By type:**\n${typeLines || "  (none)"}\n` +
      `**Promotion candidates:** ${stats.promotionCandidates}\n` +
      `**Top learnings:**\n${recentLines || "  (none)"}`,
  };
}

function commandDeadLetter(): CommandResult {
  const deadLetters = listDeadLetters();
  if (deadLetters.length === 0) return { text: "No dead-lettered tasks." };
  const lines = deadLetters.slice(0, 10).map(
    dl => `• \`${dl.id}\` — <#${dl.channel_id}> — ${dl.error.slice(0, 80)} (${dl.attempts} attempts, ${dl.created_at.slice(0, 16)})`
  );
  return {
    text: `**Dead-lettered tasks (${deadLetters.length}):**\n${lines.join("\n")}${deadLetters.length > 10 ? `\n... and ${deadLetters.length - 10} more` : ""}`,
  };
}

async function commandRetry(id: string): Promise<CommandResult> {
  const newTaskId = retryDeadLetter(id);
  if (newTaskId) {
    await spawnTask(newTaskId);
    return { text: `Task re-enqueued as \`${newTaskId}\`. It will run automatically.` };
  }
  return { text: `Dead-letter entry \`${id}\` not found.` };
}

function commandDbStatus(): CommandResult {
  const db = getDb();
  const tables = ["sessions", "channel_configs", "subagents", "projects", "task_queue", "dead_letter"];
  const counts: string[] = [];
  for (const table of tables) {
    try {
      const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
      counts.push(`• ${table}: ${row.c} rows`);
    } catch {
      counts.push(`• ${table}: (error)`);
    }
  }

  const dbPath = join(HARNESS_ROOT, "bridges", "discord", "harness.db");
  let sizeStr = "unknown";
  try {
    const stats = statSync(dbPath);
    sizeStr = `${(stats.size / 1024).toFixed(0)} KB`;
  } catch {}

  return { text: `**Database Status** (${sizeStr})\n${counts.join("\n")}` };
}

function commandProjectList(): CommandResult {
  const projects = listProjects();
  if (projects.length === 0) return { text: "No active projects." };
  const lines = projects.map(
    p => `• <#${p.channelId}> — ${p.description.slice(0, 80)} (agents: ${p.agents.join(", ")})`
  );
  return { text: `**Active projects (${projects.length}):**\n${lines.join("\n")}` };
}

function commandProjectAgents(ctx: CommandContext, agentStr: string): CommandResult {
  const agents = agentStr.split(",").map(a => a.trim());
  const project = getProject(ctx.channelId);
  if (!project) return { text: "This channel is not a project channel." };
  const available = listAgentNames();
  const invalid = agents.filter(a => !available.includes(a));
  if (invalid.length > 0) {
    return { text: `Unknown agents: ${invalid.join(", ")}. Available: ${available.join(", ")}` };
  }
  updateProject(ctx.channelId, { agents });
  return { text: `Project agents updated: ${agents.join(", ")}` };
}

async function commandSpawn(ctx: CommandContext, description: string, agent?: string): Promise<CommandResult> {
  const entry = await spawnSubagent({
    channelId: ctx.channelId,
    description,
    agent: agent || undefined,
  });
  if (!entry) {
    return { text: "At capacity. Try again later." };
  }
  return {
    text: `Subagent spawned: \`${entry.id}\`\nAgent: ${entry.agent || "default"}\nTask: ${description.slice(0, 200)}`,
  };
}
