import { getChannelConfig } from "./channel-config-store.js";
import { assembleContext } from "./context-assembler.js";
import { readAgentPrompt } from "./agent-loader.js";
import { getProject, resolveProjectWorkdir } from "./project-manager.js";
import { getSession } from "./session-store.js";
import { HARNESS_ROOT } from "./claude-config.js";

export interface CodexRunConfig {
  prompt: string;
  runnerArgs: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface BuildCodexConfigOptions {
  channelId: string;
  prompt: string;
  agentName?: string | null;
  sessionKey?: string | null;
  taskId?: string;
  extraSystemPrompts?: string[];
  worktreePath?: string | null;
  outputFile?: string;
  streamDir?: string;
  skipSessionResume?: boolean;
}

export function extractCodexResponse(result: unknown): string | null {
  const payload = result as Record<string, unknown> | null;
  if (!payload) return null;

  if (typeof payload.lastMessage === "string" && payload.lastMessage.trim()) {
    return payload.lastMessage.trim();
  }

  const stdout = typeof payload.stdout === "string" ? payload.stdout : "";
  let fallback: string | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.type === "message" && typeof parsed.content === "string" && parsed.content.trim()) {
        fallback = parsed.content.trim();
      }
      if (parsed.type === "result" && typeof parsed.result === "string" && parsed.result.trim()) {
        return parsed.result.trim();
      }
    } catch {}
  }

  return fallback;
}

export function extractCodexSessionId(result: unknown): string | null {
  const payload = result as Record<string, unknown> | null;
  if (!payload) return null;

  if (typeof payload.threadId === "string" && payload.threadId.trim()) {
    return payload.threadId;
  }

  const stdout = typeof payload.stdout === "string" ? payload.stdout : "";
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.type === "thread" && typeof parsed.thread_id === "string" && parsed.thread_id.trim()) {
        return parsed.thread_id;
      }
    } catch {}
  }

  return null;
}

export async function buildCodexConfig(opts: BuildCodexConfigOptions): Promise<CodexRunConfig> {
  const channelConfig = getChannelConfig(opts.channelId);
  const agentName = opts.agentName || channelConfig?.agent;
  const promptSections: string[] = [];

  if (agentName) {
    const agentPrompt = readAgentPrompt(agentName);
    if (agentPrompt) {
      promptSections.push(agentPrompt.trim());
    }
  }

  const context = await assembleContext({
    channelId: opts.channelId,
    prompt: opts.prompt,
    agentName: agentName || "default",
    sessionKey: opts.sessionKey || opts.channelId,
    taskId: opts.taskId || `codex-${Date.now()}`,
  });
  if (context) {
    promptSections.push(context.trim());
  }

  if (opts.extraSystemPrompts?.length) {
    promptSections.push(...opts.extraSystemPrompts.map((section) => section.trim()).filter(Boolean));
  }

  promptSections.push(opts.prompt);

  const runnerArgs: string[] = [];
  if (!opts.skipSessionResume) {
    const sessionKey = opts.sessionKey || opts.channelId;
    const existingSession = getSession(sessionKey, "codex");
    if (existingSession) {
      runnerArgs.push("--resume", existingSession);
    }
  }

  if (channelConfig?.model) {
    runnerArgs.push("--model", channelConfig.model);
  }

  const project = getProject(opts.channelId);
  const projectCwd = opts.worktreePath || (project ? resolveProjectWorkdir(project.name) : null);
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    HARNESS_ROOT,
    ...(projectCwd ? { PROJECT_CWD: projectCwd } : {}),
  };

  return {
    prompt: promptSections.filter(Boolean).join("\n\n"),
    runnerArgs,
    env,
    cwd: HARNESS_ROOT,
  };
}
