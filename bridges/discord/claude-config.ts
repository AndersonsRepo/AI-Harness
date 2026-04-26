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
import { claudeDisallowedToolArgs } from "./safety.js";

export const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";

// Global safety guardrails — applied to every Claude invocation. Sourced
// from safety.ts so the Codex runtime enforces the same patterns at the
// event-stream level (see codex-runner.py).
export const GLOBAL_DISALLOWED_TOOLS = claudeDisallowedToolArgs().join(",");

// ─── Error Classification ───────────────────────────────────────────

export interface ClassifiedError {
  /** User-facing message. Begins with an emoji marker so core-gateway can
   *  render it without a generic "Something went wrong" code-block wrapper. */
  message: string;
  /** False for permanent quota / auth errors so task-runner can short-circuit
   *  retries that have no chance of succeeding. True for transient API issues
   *  worth backing off on. */
  retryable: boolean;
  /** Original error text used for the classification, for telemetry/logs. */
  raw: string;
}

// Detected via String.startsWith on the message. Exported so other modules
// (e.g. core-gateway) can decide whether an error is already user-facing.
export const CLASSIFIED_ERROR_PREFIXES = ["🚫", "⏳", "🌐", "🔑", "💳", "⚠️"];

export function isClassifiedErrorMessage(msg: string): boolean {
  return CLASSIFIED_ERROR_PREFIXES.some((p) => msg.startsWith(p));
}

/**
 * Inspect Claude CLI stdout (JSONL stream) and stderr for known API failure
 * shapes and produce a structured, user-friendly error message.
 *
 * Returns null when no recognizable pattern matches — caller should fall
 * back to the original generic error text.
 */
export function classifyClaudeError(
  stdout: string,
  stderr: string,
  _returncode: number,
): ClassifiedError | null {
  // Pull the most recent `type: result` chunk with is_error: true. That is
  // where Claude CLI surfaces structured API errors (quota, overload, etc.).
  let resultChunk: any = null;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t);
      if (parsed?.type === "result" && parsed?.is_error) {
        resultChunk = parsed;
      }
    } catch {}
  }

  const apiStatus: number | null = resultChunk?.api_error_status ?? null;
  const resultText: string = (resultChunk?.result ?? "").toString();
  const haystack = `${resultText}\n${stderr || ""}`.toLowerCase();
  const raw = (resultText || stderr || "").trim();

  // Quota class — permanent until billing cycle resets. Skip retries.
  if (haystack.includes("monthly usage limit") || haystack.includes("monthly limit")) {
    return {
      message: "🚫 **Anthropic monthly quota exhausted.** Resets at the start of your next billing cycle. Check console.anthropic.com → Settings → Plans & Billing, or upgrade your plan.",
      retryable: false,
      raw,
    };
  }
  if (haystack.includes("weekly usage limit") || haystack.includes("weekly limit")) {
    return {
      message: "🚫 **Anthropic weekly quota exhausted.** Resets at the start of next week. Check console.anthropic.com or upgrade your plan.",
      retryable: false,
      raw,
    };
  }
  if (haystack.includes("daily usage limit") || haystack.includes("daily limit")) {
    return {
      message: "⏳ **Anthropic daily quota exhausted.** Resets at midnight UTC. Try again later or upgrade your plan.",
      retryable: false,
      raw,
    };
  }
  if (haystack.includes("credit balance") && haystack.includes("low")) {
    return {
      message: "💳 **Anthropic credit balance is too low.** Add credits at console.anthropic.com → Settings → Plans & Billing.",
      retryable: false,
      raw,
    };
  }

  // Auth — caller has to fix.
  if (apiStatus === 401 || haystack.includes("authentication_error") || haystack.includes("invalid authentication")) {
    return {
      message: "🔑 **Anthropic authentication failed.** Re-run `claude /login` or check `ANTHROPIC_API_KEY`.",
      retryable: false,
      raw,
    };
  }

  // Overload class — transient. Retry will likely succeed.
  if (apiStatus === 529 || haystack.includes("overloaded")) {
    return {
      message: "⏳ Anthropic API is currently overloaded. Backing off and retrying...",
      retryable: true,
      raw,
    };
  }
  if (apiStatus === 503 || haystack.includes("service unavailable")) {
    return {
      message: "⏳ Anthropic service unavailable. Backing off and retrying...",
      retryable: true,
      raw,
    };
  }
  if (apiStatus === 502 || haystack.includes("bad gateway")) {
    return {
      message: "⏳ Anthropic gateway error (502). Backing off and retrying...",
      retryable: true,
      raw,
    };
  }
  if (haystack.includes("stream idle timeout") || haystack.includes("stream") && haystack.includes("timeout")) {
    return {
      message: "🌐 Anthropic streaming connection went idle. Retrying...",
      retryable: true,
      raw,
    };
  }
  // 429 *not* matched as a quota above — generic rate limiting.
  if (apiStatus === 429 || haystack.includes("rate limit")) {
    return {
      message: "⏳ Rate limited by Anthropic. Backing off and retrying...",
      retryable: true,
      raw,
    };
  }

  return null;
}

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
    const existingSession = getSession(sessionKey, "claude");
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
