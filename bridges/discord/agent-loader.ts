/**
 * Shared Agent Module
 *
 * Single source of truth for:
 * - Loading agent prompts from .claude/agents/
 * - Listing available agent names
 * - Agent tool restriction definitions (enforced at CLI level, not prompt level)
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";

// --- Agent Loading ---

export function readAgentPrompt(name: string): string | null {
  const agentFile = join(HARNESS_ROOT, ".claude", "agents", `${name}.md`);
  if (!existsSync(agentFile)) return null;
  return readFileSync(agentFile, "utf-8");
}

export function listAgentNames(): string[] {
  const agentsDir = join(HARNESS_ROOT, ".claude", "agents");
  if (!existsSync(agentsDir)) return [];
  return readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(".md", ""));
}

export type AgentRuntime = "claude" | "codex";

export function getAgentRuntime(agentName?: string | null): AgentRuntime {
  if (!agentName) return "claude";
  return agentName.startsWith("codex-") ? "codex" : "claude";
}

// --- Tool Restriction Definitions ---

/**
 * Per-agent tool restrictions. These are enforced deterministically at spawn time
 * via --allowedTools / --disallowedTools CLI flags. The LLM cannot override them.
 *
 * `allowed` = whitelist (only these tools available)
 * `disallowed` = blacklist (these tools blocked, on top of global guardrails)
 *
 * If neither is specified, the agent gets all tools (subject to global guardrails).
 */
export interface AgentToolRestrictions {
  allowed?: string[];
  disallowed?: string[];
}

export const AGENT_TOOL_RESTRICTIONS: Record<string, AgentToolRestrictions> = {
  orchestrator: {
    disallowed: [
      "Edit",
      "Write",
      "NotebookEdit",
      "Bash(npm:*)",
      "Bash(npx:*)",
    ],
  },
  researcher: {
    allowed: [
      "Read",
      "Grep",
      "Glob",
      "WebSearch",
      "WebFetch",
      "Bash(cat:*)",
      "Bash(ls:*)",
      "Bash(find:*)",
      "Bash(wc:*)",
      "Bash(head:*)",
      "Bash(tail:*)",
      "mcp__vault__vault_search",
      "mcp__vault__vault_read",
      "mcp__vault__vault_list",
      "mcp__vault__vault_stats",
      "mcp__projects__project_context",
      "mcp__projects__project_list",
      "mcp__calendar__calendar_list",
      "mcp__calendar__calendar_events",
      "mcp__calendar__calendar_search",
    ],
  },
  reviewer: {
    allowed: [
      "Read",
      "Grep",
      "Glob",
      "Bash(cat:*)",
      "Bash(ls:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git show:*)",
    ],
  },
  education: {
    allowed: [
      "Read",
      "Grep",
      "Glob",
      "Bash(cat:*)",
      "Bash(ls:*)",
      "Bash(curl:*)",
      "Bash(python3:*)",
      "mcp__vault__vault_search",
      "mcp__vault__vault_read",
      "mcp__vault__vault_list",
      "mcp__calendar__calendar_list",
      "mcp__calendar__calendar_events",
      "mcp__calendar__calendar_search",
    ],
  },
  scheduler: {
    allowed: [
      "Read",
      "Write",
      "Edit",
      "Grep",
      "Glob",
      "Bash(launchctl:*)",
      "Bash(python3:*)",
      "Bash(cat:*)",
      "Bash(ls:*)",
      "Bash(tail:*)",
      "Bash(head:*)",
      "Bash(wc:*)",
      "Bash(find:*)",
      "Bash(date:*)",
      "mcp__harness__harness_heartbeat_list",
      "mcp__harness__harness_heartbeat_toggle",
      "mcp__harness__harness_heartbeat_run",
      "mcp__harness__harness_heartbeat_status",
      "mcp__harness__harness_heartbeat_create",
      "mcp__harness__harness_heartbeat_delete",
      "mcp__harness__harness_heartbeat_logs",
      "mcp__harness__harness_health",
    ],
  },
  // builder, ops, project: no restrictions beyond global guardrails
};

/**
 * Per-agent default models. Used when no channel-level model override is set.
 * Agents not listed here use the Claude CLI default (currently Sonnet).
 *
 * Opus: deeper reasoning → better plans, subtler code review, architectural decisions
 * Sonnet: fast, capable → code gen, tutoring, research, ops tasks
 */
export const AGENT_DEFAULT_MODELS: Record<string, string> = {
  orchestrator: "opus",
  reviewer: "opus",
  project: "opus",
  // builder, researcher, education, ops, commands: use CLI default (sonnet)
};

/**
 * Get the model to use for a given agent, respecting channel override > agent default > CLI default.
 */
export function getAgentModel(agentName: string | undefined, channelModel: string | undefined): string | undefined {
  // Channel-level override takes priority
  if (channelModel) return channelModel;
  // Agent-level default
  if (agentName && AGENT_DEFAULT_MODELS[agentName]) return AGENT_DEFAULT_MODELS[agentName];
  // No override — let CLI use its default
  return undefined;
}

/**
 * Build CLI args for tool restrictions for a given agent.
 * Returns args to append to the claude CLI invocation.
 */
export function getToolRestrictionArgs(agentName: string): string[] {
  const restrictions = AGENT_TOOL_RESTRICTIONS[agentName];
  if (!restrictions) return [];

  const args: string[] = [];

  if (restrictions.allowed?.length) {
    args.push("--allowedTools", restrictions.allowed.join(","));
  }

  if (restrictions.disallowed?.length) {
    args.push("--disallowedTools", restrictions.disallowed.join(","));
  }

  return args;
}
