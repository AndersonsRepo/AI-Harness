import type { AgentRuntime } from "./agent-loader.js";
import { classifyClaudeError, type ClassifiedError } from "./claude-config.js";
import { resolveRuntimePolicy } from "./role-policy.js";
import { recordLimitEvent } from "./usage-tracker.js";

export interface RuntimeFailoverInput {
  channelId: string;
  agentName?: string | null;
  explicitRuntime?: AgentRuntime | null;
  failedRuntime: AgentRuntime;
  stdout?: string | null;
  stderr?: string | null;
  returncode?: number | null;
}

export interface RuntimeFailoverDecision {
  classification: ClassifiedError;
  nextRuntime: AgentRuntime | null;
  shouldFailover: boolean;
  reason: string;
  message: string;
  retryable: boolean;
}

export function getNextFallbackRuntime(opts: {
  channelId: string;
  agentName?: string | null;
  explicitRuntime?: AgentRuntime | null;
  failedRuntime: AgentRuntime;
}): AgentRuntime | null {
  const policy = resolveRuntimePolicy({
    channelId: opts.channelId,
    agentName: opts.agentName,
    explicitRuntime: opts.explicitRuntime,
  });
  const failedIdx = policy.fallbackOrder.indexOf(opts.failedRuntime);
  const candidates = failedIdx >= 0
    ? policy.fallbackOrder.slice(failedIdx + 1)
    : policy.fallbackOrder;
  return candidates.find((candidate) => candidate !== opts.failedRuntime) ?? null;
}

export function classifyRuntimeFailureForFailover(
  input: RuntimeFailoverInput,
): RuntimeFailoverDecision | null {
  if (input.failedRuntime !== "claude") return null;

  const classification = classifyClaudeError(
    input.stdout || "",
    input.stderr || "",
    input.returncode ?? 1,
  );
  if (!classification) return null;

  // Record usage/rate/credit limit hits for the control-panel dashboard. This
  // is the single chokepoint both task-runner and subagent-manager reach, so
  // every Claude limit event is captured here. Best-effort, no tokens.
  recordLimitEvent(classification.kind, input.failedRuntime);

  const nextRuntime = classification.kind === "usage_limit"
    ? getNextFallbackRuntime(input)
    : null;

  return {
    classification,
    nextRuntime,
    shouldFailover: nextRuntime !== null,
    reason: classification.raw || classification.message,
    message: classification.message,
    retryable: classification.retryable,
  };
}

export function runtimeFailoverMessage(
  failedRuntime: AgentRuntime,
  nextRuntime: AgentRuntime,
): string {
  return `${failedRuntime} failed with a provider usage limit; failing over to ${nextRuntime}`;
}
