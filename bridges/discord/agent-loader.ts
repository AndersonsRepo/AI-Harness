/**
 * Shared Agent Module
 *
 * Single source of truth for:
 * - Loading agent prompts from .claude/agents/
 * - Listing available agent names
 * - Agent tool restriction definitions (enforced at CLI level, not prompt level)
 * - Per-agent runtime (claude | codex) and codex sandbox, read from optional
 *   YAML frontmatter at the top of each agent .md file.
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";

// --- Agent Loading ---

export type AgentRuntime = "claude" | "codex";
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

export interface AgentMetadata {
  runtime: AgentRuntime;
  sandbox?: CodexSandbox;
  raw: Record<string, string>;
}

function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { fields: {}, body: text };
  }
  const afterOpen = text.indexOf("\n") + 1;
  const closeIdx = text.indexOf("\n---", afterOpen);
  if (closeIdx === -1) return { fields: {}, body: text };
  const fmRaw = text.slice(afterOpen, closeIdx);
  const endLineIdx = text.indexOf("\n", closeIdx + 1);
  const body = endLineIdx === -1 ? "" : text.slice(endLineIdx + 1);
  const fields: Record<string, string> = {};
  for (const line of fmRaw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (m) fields[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { fields, body };
}

function agentFilePath(name: string): string {
  return join(HARNESS_ROOT, ".claude", "agents", `${name}.md`);
}

export function readAgentPrompt(name: string): string | null {
  const agentFile = agentFilePath(name);
  if (!existsSync(agentFile)) return null;
  const raw = readFileSync(agentFile, "utf-8");
  const { body, fields } = parseFrontmatter(raw);
  return Object.keys(fields).length > 0 ? body : raw;
}

export function readAgentMetadata(name: string): AgentMetadata | null {
  const agentFile = agentFilePath(name);
  if (!existsSync(agentFile)) return null;
  const raw = readFileSync(agentFile, "utf-8");
  const { fields } = parseFrontmatter(raw);
  const runtime: AgentRuntime = fields.runtime === "codex" ? "codex" : "claude";
  const sandbox = fields.sandbox as CodexSandbox | undefined;
  return { runtime, sandbox, raw: fields };
}

export function listAgentNames(): string[] {
  const agentsDir = join(HARNESS_ROOT, ".claude", "agents");
  if (!existsSync(agentsDir)) return [];
  return readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(".md", ""));
}

export function getAgentRuntime(agentName?: string | null): AgentRuntime {
  if (!agentName) return "claude";
  const meta = readAgentMetadata(agentName);
  if (meta) return meta.runtime;
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
      "mcp__codex__codex",
      "mcp__codex__codex-reply",
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
  tester: {
    allowed: [
      "Read",
      "Grep",
      "Glob",
      "Bash(npm:*)",
      "Bash(npx:*)",
      "Bash(tsx:*)",
      "Bash(python3:*)",
      "Bash(pytest:*)",
      "Bash(curl:*)",
      "Bash(cat:*)",
      "Bash(ls:*)",
      "Bash(head:*)",
      "Bash(tail:*)",
      "Bash(wc:*)",
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "mcp__vault__vault_search",
      "mcp__vault__vault_read",
      "mcp__vault__vault_list",
      "mcp__vault__vault_write",
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
  tester: "opus",
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
 * Does this agent's restriction profile permit filesystem writes?
 *
 * Returns false when the agent is whitelisted to tools that don't include
 * Edit/Write/NotebookEdit, or when those tools are explicitly in the disallowed
 * list. Returns true for agents with no restrictions (builder, ops, project)
 * and for agents whose whitelist includes write tools (scheduler).
 *
 * Used to pick the Codex sandbox: read-only for non-writers, workspace-write
 * otherwise. This is the role-level safety guard — see also the command-level
 * filter in codex-runner.py.
 */
export function agentAllowsWrite(agentName: string | null | undefined): boolean {
  if (!agentName) return true;
  const restrictions = AGENT_TOOL_RESTRICTIONS[agentName];
  if (!restrictions) return true;

  const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit"];

  if (restrictions.disallowed?.some((t) => WRITE_TOOLS.includes(t))) {
    return false;
  }

  if (restrictions.allowed?.length) {
    return restrictions.allowed.some((t) => WRITE_TOOLS.includes(t));
  }

  return true;
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
