import { resolveRuntimePolicyCompatibility } from "./agent-profile.js";
import { getChannelConfig } from "./channel-config-store.js";
import type { AgentRuntime } from "./agent-loader.js";

export interface RuntimePolicy {
  selectedRuntime: AgentRuntime;
  preferredRuntime: AgentRuntime;
  fallbackOrder: AgentRuntime[];
  source: "task" | "channel" | "role";
}

function uniqueRuntimes(items: AgentRuntime[]): AgentRuntime[] {
  return [...new Set(items)];
}

export function getPreferredRuntimeForAgent(agentName?: string | null): AgentRuntime {
  return resolveRuntimePolicyCompatibility(agentName).preferredRuntime;
}

export function getFallbackOrderForAgent(agentName?: string | null): AgentRuntime[] {
  return resolveRuntimePolicyCompatibility(agentName).fallbackOrder;
}

export function resolveRuntimePolicy(opts: {
  channelId: string;
  agentName?: string | null;
  explicitRuntime?: AgentRuntime | null;
}): RuntimePolicy {
  // "ollama" (local, Phase H) is OPT-IN only: selectable when explicitly set
  // on the task or channel, but deliberately absent from getFallbackOrderForAgent
  // so it is NEVER auto-selected as a failover target.
  if (opts.explicitRuntime === "claude" || opts.explicitRuntime === "codex" || opts.explicitRuntime === "ollama") {
    return {
      selectedRuntime: opts.explicitRuntime,
      preferredRuntime: opts.explicitRuntime,
      fallbackOrder: uniqueRuntimes([opts.explicitRuntime, ...getFallbackOrderForAgent(opts.agentName)]),
      source: "task",
    };
  }

  const channelRuntime = getChannelConfig(opts.channelId)?.runtime;
  if (channelRuntime === "claude" || channelRuntime === "codex" || channelRuntime === "ollama") {
    return {
      selectedRuntime: channelRuntime,
      preferredRuntime: channelRuntime,
      fallbackOrder: uniqueRuntimes([channelRuntime, ...getFallbackOrderForAgent(opts.agentName)]),
      source: "channel",
    };
  }

  const preferredRuntime = getPreferredRuntimeForAgent(opts.agentName);
  return {
    selectedRuntime: preferredRuntime,
    preferredRuntime,
    fallbackOrder: getFallbackOrderForAgent(opts.agentName),
    source: "role",
  };
}
