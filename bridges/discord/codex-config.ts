import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getChannelConfig } from "./channel-config-store.js";
import { assembleContext } from "./context-assembler.js";
import { readAgentPrompt, readAgentMetadata, CodexSandbox, agentAllowsWrite } from "./agent-loader.js";
import { getProject, resolveProjectWorkdir } from "./project-manager.js";
import { HARNESS_ROOT } from "./claude-config.js";
import { safetyPatternsJson } from "./safety.js";
import { getSession } from "./session-store.js";
import { resolveAllowedMcps } from "./mcp-config-builder.js";

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

const DEFAULT_SANDBOX: CodexSandbox = "workspace-write";

// Codex MCP servers default to `default_tools_approval_mode="prompt"`, which
// hangs `codex exec` (no human to approve) — every call returns "user
// cancelled MCP tool call". For headless spawns we override the registered
// servers to "approve" so MCP tools execute without prompting. Scoped to the
// spawn via `-c` rather than persisted to ~/.codex/config.toml so an
// interactive `codex` from a terminal still uses the safer prompt default.
//
// Read directly from ~/.codex/config.toml because Codex maintains its own MCP
// registry separate from Claude's ~/.claude.json (a parallel registry, not a
// shared one). The regex matches the canonical [mcp_servers.<name>] heading
// shape codex itself emits — exotic quoted names would slip past, but those
// aren't producible via `codex mcp add`.
function readCodexMcpRegistry(configPath?: string): Set<string> {
  const path = configPath ?? join(homedir(), ".codex", "config.toml");
  if (!existsSync(path)) return new Set();
  try {
    const text = readFileSync(path, "utf-8");
    const names = new Set<string>();
    const re = /^\[mcp_servers\.([A-Za-z0-9_-]+)\]/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      names.add(m[1]!);
    }
    return names;
  } catch {
    return new Set();
  }
}

export function buildCodexMcpApprovalArgs(
  channelId: string,
  registryPath?: string,
): string[] {
  const allowed = resolveAllowedMcps(channelId);
  const registered = readCodexMcpRegistry(registryPath);
  const args: string[] = [];
  for (const name of allowed) {
    if (registered.has(name)) {
      args.push("-c", `mcp_servers.${name}.default_tools_approval_mode="approve"`);
    }
  }
  return args;
}

function composePrompt(parts: {
  agentPrompt?: string | null;
  context?: string | null;
  extras?: string[];
  userPrompt: string;
}): string {
  const sections: string[] = [];
  if (parts.agentPrompt && parts.agentPrompt.trim()) {
    sections.push(`# Agent Personality\n\n${parts.agentPrompt.trim()}`);
  }
  if (parts.context && parts.context.trim()) {
    sections.push(`# Harness Context\n\n${parts.context.trim()}`);
  }
  if (parts.extras && parts.extras.length > 0) {
    sections.push(`# Operator Guidance\n\n${parts.extras.join("\n\n").trim()}`);
  }
  sections.push(`# User Request\n\n${parts.userPrompt}`);
  return sections.join("\n\n---\n\n");
}

export async function buildCodexConfig(opts: BuildCodexConfigOptions): Promise<CodexRunConfig> {
  const channelConfig = getChannelConfig(opts.channelId);
  const agentName = opts.agentName || channelConfig?.agent || null;

  const agentPrompt = agentName ? readAgentPrompt(agentName) : null;
  const meta = agentName ? readAgentMetadata(agentName) : null;
  // Role-level safety: agents whose tool restrictions forbid Edit/Write (orchestrator,
  // researcher, reviewer, tester, education) are downgraded to read-only regardless of
  // what their agent metadata requests. Stops Codex-backed review/research agents from
  // mutating the workspace. See ERR-new-runtime-safety-guardrails-not-inherited.
  const requestedSandbox: CodexSandbox = meta?.sandbox || DEFAULT_SANDBOX;
  const sandbox: CodexSandbox = agentAllowsWrite(agentName) ? requestedSandbox : "read-only";

  const context = await assembleContext({
    channelId: opts.channelId,
    prompt: opts.prompt,
    agentName: agentName || "default",
    sessionKey: opts.sessionKey || opts.channelId,
    taskId: opts.taskId || `codex-spawn-${Date.now()}`,
  });

  const promptBody = composePrompt({
    agentPrompt,
    context,
    extras: opts.extraSystemPrompts,
    userPrompt: opts.prompt,
  });

  const project = getProject(opts.channelId);
  const projectCwd = opts.worktreePath || (project ? resolveProjectWorkdir(project.name) : null);
  const workingDir = projectCwd || HARNESS_ROOT;
  const runnerArgs: string[] = [];

  // Session resume: if a Codex thread id is already stored for this
  // sessionKey, pass --session-id so codex-runner.py runs `codex exec resume
  // <id>` instead of starting a fresh thread. Parity with claude-config's
  // --resume flag. codex-runner.py consumes --session-id before the codex
  // CLI args begin, so it must appear before --json below.
  // Chain-context identity. Used both for session resume (below) and for
  // env-var propagation to MCP tools (e.g. mcp-harness/harness_handoff)
  // that need to know which session to attribute writes to. Mirrors
  // claude-config.ts wiring so both runtimes carry the same chain identity.
  const sessionKey = opts.sessionKey || opts.channelId;
  const fromAgent = agentName || "default";

  if (!opts.skipSessionResume) {
    const existingSession = getSession(sessionKey, "codex");
    if (existingSession) {
      runnerArgs.push("--session-id", existingSession);
    }
  }

  runnerArgs.push(
    "--json",
    "-s", sandbox,
    "-C", workingDir,
    "--skip-git-repo-check",
    "-c", "approval_policy=\"never\"",
  );

  // Auto-approve MCP tool calls for registered servers in this channel's
  // allowlist. Without this, `codex exec` hangs the call and surfaces
  // "user cancelled MCP tool call" — see header comment on
  // buildCodexMcpApprovalArgs for the full rationale.
  runnerArgs.push(...buildCodexMcpApprovalArgs(opts.channelId));

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HARNESS_ROOT,
    HARNESS_CHANNEL_ID: opts.channelId,
    HARNESS_SESSION_KEY: sessionKey,
    HARNESS_FROM_AGENT: fromAgent,
    // codex-runner.py enforces these at the event-stream level, since
    // `codex exec` has no equivalent of Claude's --disallowedTools flag.
    CODEX_SAFETY_PATTERNS: safetyPatternsJson(),
    ...(projectCwd ? { PROJECT_CWD: projectCwd } : {}),
  };

  return {
    runnerArgs,
    prompt: promptBody,
    env,
    cwd: workingDir,
  };
}

export function extractCodexResponse(resultJson: any): string | null {
  if (!resultJson || typeof resultJson !== "object") return null;
  if (typeof resultJson.lastMessage === "string" && resultJson.lastMessage.trim()) {
    return resultJson.lastMessage.trim();
  }

  const collectText = (value: any): string | null => {
    if (typeof value === "string") return value.trim() || null;
    if (Array.isArray(value)) {
      const parts = value
        .map((item) => collectText(item))
        .filter((item): item is string => Boolean(item));
      return parts.length ? parts.join("\n").trim() : null;
    }
    if (!value || typeof value !== "object") return null;

    for (const key of ["text", "result", "message", "content", "last_agent_message", "output", "response", "item"]) {
      const text = collectText(value[key]);
      if (text) return text;
    }
    return null;
  };

  const stdout = typeof resultJson.stdout === "string" ? resultJson.stdout : "";
  let last: string | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const ev = JSON.parse(trimmed);
      const msg = typeof ev?.msg === "object" && ev.msg ? ev.msg : ev;
      const text = collectText(msg) || collectText(ev);
      if (typeof text === "string" && text.trim()) last = text.trim();
    } catch {}
  }
  return last;
}

export function extractCodexSessionId(resultJson: any): string | null {
  if (!resultJson || typeof resultJson !== "object") return null;
  if (typeof resultJson.threadId === "string" && resultJson.threadId) return resultJson.threadId;
  return null;
}
