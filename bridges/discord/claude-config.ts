/**
 * Shared Claude CLI Configuration
 *
 * Single source of truth for constants and helpers used across all spawn points:
 * task-runner.ts, handoff-router.ts, subagent-manager.ts, tmux-orchestrator.ts
 *
 * Phase 0 of the Claude Agent SDK migration — consolidate before replacing.
 */

import { getChannelConfig } from "./channel-config-store.js";
import { assembleContext } from "./context-assembler.js";
import { readAgentPrompt, AGENT_TOOL_RESTRICTIONS, getAgentModel } from "./agent-loader.js";
import { getProject, resolveProjectWorkdir } from "./project-manager.js";
import { getSession } from "./session-store.js";

export const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";

// Global safety guardrails — applied to every Claude invocation
export const GLOBAL_DISALLOWED_TOOLS = [
  "Bash(rm -rf:*)",
  "Bash(git push --force:*)",
  "Bash(git reset --hard:*)",
  "Bash(DROP:*)",
  "Bash(DELETE FROM:*)",
  "Bash(kill -9:*)",
].join(",");

// ─── Response Parsing ───────────────────────────────────────────────

/**
 * Extract the final text response from Claude CLI output (stream-json or plain JSON).
 * Returns null if no response could be parsed.
 */
export function extractResponse(output: string): string | null {
  let lastAssistantText: string | null = null;

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.type === "result") {
        if (parsed.is_error) return `Error: ${parsed.result || "Unknown error"}`;
        const text = parsed.result || parsed.text || parsed.content;
        if (text && text.trim()) return text.trim();
        break;
      }
      if (parsed.type === "assistant" && parsed.message?.content) {
        for (const block of parsed.message.content) {
          if (block.type === "text" && block.text?.trim()) {
            lastAssistantText = block.text.trim();
          }
        }
      }
    } catch {}
  }

  if (lastAssistantText) return lastAssistantText;

  // Fallback: single JSON object
  try {
    const jsonStart = output.indexOf('{"type"');
    if (jsonStart !== -1) {
      const jsonEnd = output.lastIndexOf("}") + 1;
      const parsed = JSON.parse(output.slice(jsonStart, jsonEnd));
      if (parsed.is_error) return `Error: ${parsed.result || "Unknown error"}`;
      const text = parsed.result || parsed.text || parsed.content;
      return text ? text.trim() : null;
    }
  } catch {}

  // Last resort: regex
  const match = output.match(/"result"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (match) {
    return match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').trim();
  }
  return null;
}

/**
 * Extract session_id from Claude CLI output (stream-json lines or regex fallback).
 */
export function extractSessionId(output: string): string | null {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.session_id) return parsed.session_id;
    } catch {}
  }
  const match = output.match(/"session_id"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

// ─── Tool Restriction Merging ───────────────────────────────────────

export interface MergedToolFlags {
  disallowedTools: string;
  allowedTools: string | null;
}

/**
 * Merge global, agent-specific, and channel-specific tool restrictions
 * into single --disallowedTools and --allowedTools flag values.
 */
export function mergeToolRestrictions(
  agentName?: string | null,
  channelId?: string | null,
): MergedToolFlags {
  const allDisallowed: string[] = [GLOBAL_DISALLOWED_TOOLS];
  const allAllowed: string[] = [];

  if (agentName) {
    const restrictions = AGENT_TOOL_RESTRICTIONS[agentName];
    if (restrictions?.disallowed?.length) {
      allDisallowed.push(restrictions.disallowed.join(","));
    }
    if (restrictions?.allowed?.length) {
      allAllowed.push(...restrictions.allowed);
    }
  }

  if (channelId) {
    const channelConfig = getChannelConfig(channelId);
    if (channelConfig?.disallowedTools?.length) {
      allDisallowed.push(channelConfig.disallowedTools.join(","));
    }
    if (channelConfig?.allowedTools?.length) {
      allAllowed.push(...channelConfig.allowedTools);
    }
  }

  return {
    disallowedTools: allDisallowed.join(","),
    allowedTools: allAllowed.length > 0 ? allAllowed.join(",") : null,
  };
}

// ─── Claude CLI Config Builder ──────────────────────────────────────

export interface ClaudeRunConfig {
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface BuildConfigOptions {
  channelId: string;
  prompt: string;
  agentName?: string | null;
  sessionKey?: string | null;
  taskId?: string;
  isContinuation?: boolean;
  extraSystemPrompts?: string[];
  timeoutSeconds?: number;
  includeStreamDir?: boolean;
  worktreePath?: string | null;
  skipSessionResume?: boolean;
}

/**
 * Build the full Claude CLI argument list and environment for a spawn.
 * This is the shared config builder that all spawn points use.
 *
 * Returns { args, env, cwd } ready for claude-runner.py.
 */
export async function buildClaudeConfig(opts: BuildConfigOptions): Promise<ClaudeRunConfig> {
  const args = ["-p", "--output-format", "json", "--dangerously-skip-permissions"];

  const channelConfig = getChannelConfig(opts.channelId);

  // Resolve effective agent name
  const agentName = opts.agentName || channelConfig?.agent;

  // Agent personality
  if (agentName) {
    const agentPrompt = readAgentPrompt(agentName);
    if (agentPrompt) {
      args.push("--append-system-prompt", agentPrompt);
    }
  }

  // Context injection
  const context = await assembleContext({
    channelId: opts.channelId,
    prompt: opts.prompt,
    agentName: agentName || "default",
    sessionKey: opts.sessionKey || opts.channelId,
    taskId: opts.taskId || `spawn-${Date.now()}`,
  });
  if (context) {
    args.push("--append-system-prompt", context);
  }

  // Extra system prompts (intervention notes, etc.)
  if (opts.extraSystemPrompts) {
    for (const sp of opts.extraSystemPrompts) {
      args.push("--append-system-prompt", sp);
    }
  }

  // Permission mode
  if (channelConfig?.permissionMode) {
    args.push("--permission-mode", channelConfig.permissionMode);
  }

  // Model: channel override > agent default > CLI default
  const model = getAgentModel(agentName, channelConfig?.model);
  if (model) {
    args.push("--model", model);
  }

  // Tool restrictions
  const tools = mergeToolRestrictions(agentName, opts.channelId);
  args.push("--disallowedTools", tools.disallowedTools);
  if (tools.allowedTools) {
    args.push("--allowedTools", tools.allowedTools);
  }

  // Session resume
  if (!opts.skipSessionResume) {
    const sessionKey = opts.sessionKey || opts.channelId;
    const existingSession = getSession(sessionKey);
    if (existingSession) {
      args.push("--resume", existingSession);
    }
  }

  // Prompt (-- separator prevents flags from consuming it)
  if (opts.isContinuation) {
    args.push("--", "Continue where you left off. If you are done, do not include [CONTINUE].");
  } else {
    args.push("--", opts.prompt);
  }

  // Resolve working directory
  const project = getProject(opts.channelId);
  const projectCwd = opts.worktreePath || (project ? resolveProjectWorkdir(project.name) : null);

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    HARNESS_ROOT,
    ...(projectCwd ? { PROJECT_CWD: projectCwd } : {}),
  };

  return { args, env, cwd: HARNESS_ROOT };
}
