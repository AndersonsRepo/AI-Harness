/**
 * Local (Ollama) runtime configuration — Phase H of the runtime-abstraction plan.
 *
 * The third runtime: a session-less, tool-less local model reached over HTTP
 * (Ollama, http://localhost:11434), which is what actually proves the
 * abstraction is model-NEUTRAL rather than just Claude/Codex failover. Because
 * there is no `--resume` and no MCP/tools, everything the model needs is folded
 * into one chat payload: a SYSTEM message (agent personality + the SAME harness
 * ambient context Claude/Codex receive via assembleContext + operator guidance +
 * any injected prior conversation) and a USER message (the prompt).
 *
 * Opt-in only: reached when a task/channel explicitly selects runtime "ollama".
 * role-policy keeps it out of the default fallback order, so it is never
 * auto-selected. The model itself is pulled separately (`ollama pull <model>`);
 * until then local-runner.py fails gracefully with a clear error.
 */

import { getChannelConfig } from "./channel-config-store.js";
import { assembleContext } from "./context-assembler.js";
import { readAgentPrompt } from "./agent-loader.js";
import { getProject, resolveProjectWorkdir } from "./project-manager.js";
import type { AgentContext } from "./agent-context.js";
import type { ParsedEnvelope } from "./runtime-adapter.js";

const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";

/** Default local model + endpoint, override via env. The model is downloaded
 *  out of band (`ollama pull`); the runner reports a clear error if it's absent. */
export const DEFAULT_OLLAMA_MODEL = process.env.HARNESS_OLLAMA_MODEL || "qwen3:8b";
export const DEFAULT_OLLAMA_ENDPOINT = process.env.HARNESS_OLLAMA_ENDPOINT || "http://localhost:11434";

export interface OllamaRunConfig {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  endpoint: string;
  cwd: string;
  env: Record<string, string>;
}

export interface BuildOllamaOptions {
  channelId: string;
  channelName?: string | null;
  prompt: string;
  agentName: string | null;
  sessionKey?: string | null;
  taskId?: string;
  extraSystemPrompts?: string[];
  worktreePath?: string | null;
  isContinuation?: boolean;
  /** Session-less compensation: the CLI runtimes resume conversation via
   *  `--resume`; the local model has no session, so prior turns (if the caller
   *  has them) must be injected into the system message. */
  recentConversation?: string[];
  operatorGuidance?: string[];
}

export async function buildOllamaConfig(opts: BuildOllamaOptions): Promise<OllamaRunConfig> {
  const channelConfig = getChannelConfig(opts.channelId);
  const agentName = opts.agentName || channelConfig?.agent || "default";

  const systemParts: string[] = [];

  // Agent personality — same source Claude/Codex use.
  const agentPrompt = readAgentPrompt(agentName);
  if (agentPrompt) systemParts.push(agentPrompt);

  // Harness ambient context — the SAME provider-neutral string Claude/Codex
  // attach. Keeping it identical is what makes a Claude-vs-local quality
  // comparison fair (the Phase H validation slice).
  const context = await assembleContext({
    channelId: opts.channelId,
    prompt: opts.prompt,
    agentName,
    sessionKey: opts.sessionKey || opts.channelId,
    taskId: opts.taskId || `ollama-${Date.now()}`,
  });
  if (context) systemParts.push(context);

  for (const sp of opts.operatorGuidance ?? []) systemParts.push(`[OPERATOR GUIDANCE]: ${sp}`);
  for (const sp of opts.extraSystemPrompts ?? []) systemParts.push(sp);

  if (opts.recentConversation && opts.recentConversation.length > 0) {
    systemParts.push("## Recent conversation\n" + opts.recentConversation.join("\n"));
  }

  const userPrompt = opts.isContinuation
    ? "Continue where you left off. If you are done, do not include [CONTINUE]."
    : opts.prompt;

  const project = getProject(opts.channelId);
  const projectCwd = opts.worktreePath || (project ? resolveProjectWorkdir(project.name) : null);
  const sessionKey = opts.sessionKey || opts.channelId;

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HARNESS_ROOT,
    HARNESS_CHANNEL_ID: opts.channelId,
    ...(opts.channelName ? { HARNESS_CHANNEL_NAME: opts.channelName } : {}),
    HARNESS_SESSION_KEY: sessionKey,
    HARNESS_FROM_AGENT: agentName,
    ...(projectCwd ? { PROJECT_CWD: projectCwd } : {}),
  };

  return {
    systemPrompt: systemParts.join("\n\n"),
    userPrompt,
    model: DEFAULT_OLLAMA_MODEL,
    endpoint: DEFAULT_OLLAMA_ENDPOINT,
    cwd: HARNESS_ROOT,
    env,
  };
}

/** AgentContext → OllamaRunConfig (the renderContext seam). Mirrors the Claude/
 *  Codex `*FromContext` helpers: map the durable context to loose opts and reuse
 *  buildOllamaConfig, which re-derives the ambient context from channelId. */
export async function buildOllamaConfigFromContext(context: AgentContext): Promise<OllamaRunConfig> {
  return buildOllamaConfig({
    channelId: context.channelId,
    channelName: context.channelName ?? null,
    prompt: context.userPrompt,
    agentName: context.profile?.name ?? null,
    sessionKey: context.sessionKey,
    taskId: context.workflow?.taskId,
    worktreePath: context.workflow?.worktreePath ?? null,
    isContinuation: context.workflow?.isContinuation,
    recentConversation: context.recentConversation,
    operatorGuidance: context.operatorGuidance,
  });
}

/** Parse the local-runner envelope. The runner writes the model's reply to
 *  `lastMessage` (and mirrors it into `stdout`); on failure returncode != 0. */
export function extractOllamaResponse(envelope: ParsedEnvelope): string | null {
  if (typeof envelope.lastMessage === "string" && envelope.lastMessage.trim()) {
    return envelope.lastMessage;
  }
  if (typeof envelope.stdout === "string" && envelope.stdout.trim()) {
    return envelope.stdout;
  }
  return null;
}
