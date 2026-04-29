import { getChannelConfig } from "./channel-config-store.js";
import { getAgentRuntime, type AgentRuntime } from "./agent-loader.js";

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
  if (
    agentName === "builder" ||
    agentName === "codex-builder" ||
    agentName === "researcher" ||
    agentName === "education"
  ) {
    return "codex";
  }
  return getAgentRuntime(agentName);
}

export function getFallbackOrderForAgent(agentName?: string | null): AgentRuntime[] {
  const preferred = getPreferredRuntimeForAgent(agentName);
  return preferred === "codex"
    ? ["codex", "claude"]
    : ["claude", "codex"];
}

export function resolveRuntimePolicy(opts: {
  channelId: string;
  agentName?: string | null;
  explicitRuntime?: AgentRuntime | null;
}): RuntimePolicy {
  if (opts.explicitRuntime === "claude" || opts.explicitRuntime === "codex") {
    return {
      selectedRuntime: opts.explicitRuntime,
      preferredRuntime: opts.explicitRuntime,
      fallbackOrder: uniqueRuntimes([opts.explicitRuntime, ...getFallbackOrderForAgent(opts.agentName)]),
      source: "task",
    };
  }

  const channelRuntime = getChannelConfig(opts.channelId)?.runtime;
  if (channelRuntime === "claude" || channelRuntime === "codex") {
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
