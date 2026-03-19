import { spawn } from "child_process";
import { existsSync, readFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import * as registry from "./process-registry.js";
import {
  postStart,
  postUpdate,
  postComplete,
  postError,
} from "./activity-stream.js";
import { getChannelConfig } from "./channel-config-store.js";
import { getProject, resolveProjectWorkdir } from "./project-manager.js";
import { FileWatcher, trackWatcher, untrackWatcher } from "./file-watcher.js";
import { assembleContext } from "./context-assembler.js";
import { AGENT_TOOL_RESTRICTIONS, getAgentModel } from "./agent-loader.js";

const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";
const TEMP_DIR = join(HARNESS_ROOT, "bridges", "discord", ".tmp");
const SUBAGENT_TIMEOUT = parseInt(process.env.SUBAGENT_TIMEOUT || "300", 10);
const MAX_CONCURRENT = parseInt(
  process.env.MAX_CONCURRENT_PROCESSES || "5",
  10
);

// Safety guardrails applied to all subagents
const GLOBAL_DISALLOWED = [
  "Bash(rm -rf:*)",
  "Bash(git push --force:*)",
  "Bash(git reset --hard:*)",
  "Bash(DROP:*)",
  "Bash(DELETE FROM:*)",
  "Bash(kill -9:*)",
].join(",");

// Extract response from Claude JSON output
function extractResponse(output: string): string | null {
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
  const match = output.match(/"result"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (match) {
    return match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').trim();
  }
  return null;
}

export interface SpawnOptions {
  channelId: string;
  description: string;
  agent?: string;
}

let notifyCallback: ((entry: registry.SubagentEntry, result: string) => void) | null = null;

export function onSubagentComplete(
  cb: (entry: registry.SubagentEntry, result: string) => void
): void {
  notifyCallback = cb;
}

export async function spawnSubagent(options: SpawnOptions): Promise<registry.SubagentEntry | null> {
  const running = registry.getRunning();
  if (running.length >= MAX_CONCURRENT) {
    return null; // At capacity
  }

  const id = `sa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const outputFile = join(TEMP_DIR, `subagent-${id}.json`);

  try {
    mkdirSync(TEMP_DIR, { recursive: true });
  } catch {}

  // Build claude args
  const args = ["-p", "--output-format", "json", "--dangerously-skip-permissions"];

  // Agent personality
  const agentName = options.agent || getChannelConfig(options.channelId)?.agent;
  if (agentName) {
    const agentFile = join(HARNESS_ROOT, ".claude", "agents", `${agentName}.md`);
    if (existsSync(agentFile)) {
      args.push("--append-system-prompt", readFileSync(agentFile, "utf-8"));
    }
  }

  // Context injection (deterministic daemon)
  const context = await assembleContext({
    channelId: options.channelId,
    prompt: options.description,
    agentName: agentName || "default",
    sessionKey: options.channelId,
    taskId: `subagent-${Date.now()}`,
  });
  if (context) {
    args.push("--append-system-prompt", context);
  }

  // Permission mode from channel config
  const channelConfig = getChannelConfig(options.channelId);
  if (channelConfig?.permissionMode) {
    args.push("--permission-mode", channelConfig.permissionMode);
  }

  // Merge all tool restrictions into single flags
  const allDisallowed: string[] = [GLOBAL_DISALLOWED];
  const allAllowed: string[] = [];

  // Agent-specific tool restrictions (deterministic, enforced at CLI level)
  if (agentName) {
    const restrictions = AGENT_TOOL_RESTRICTIONS[agentName];
    if (restrictions?.disallowed?.length) {
      allDisallowed.push(restrictions.disallowed.join(","));
    }
    if (restrictions?.allowed?.length) {
      allAllowed.push(...restrictions.allowed);
    }
  }

  // Channel-specific overrides
  if (channelConfig?.disallowedTools?.length) {
    allDisallowed.push(channelConfig.disallowedTools.join(","));
  }

  args.push("--disallowedTools", allDisallowed.join(","));
  if (allAllowed.length) {
    args.push("--allowedTools", allAllowed.join(","));
  }

  // Model: channel override > agent default > CLI default
  const model = getAgentModel(options.agent, channelConfig?.model);
  if (model) {
    args.push("--model", model);
  }

  // The prompt (-- separator prevents flags from consuming it)
  args.push("--", options.description);

  const pythonArgs = [
    `${HARNESS_ROOT}/bridges/discord/claude-runner.py`,
    outputFile,
    "--timeout",
    String(SUBAGENT_TIMEOUT),
    ...args,
  ];

  // Resolve project working directory (passed via env to claude-runner.py)
  const project = getProject(options.channelId);
  const projectCwd = project ? resolveProjectWorkdir(project.name) : null;

  const proc = spawn("python3", pythonArgs, {
    cwd: HARNESS_ROOT,
    env: {
      ...process.env,
      HARNESS_ROOT,
      ...(projectCwd ? { PROJECT_CWD: projectCwd } : {}),
    },
    detached: true,
    stdio: "ignore",
  });
  proc.unref();

  const entry: registry.SubagentEntry = {
    id,
    parentChannelId: options.channelId,
    description: options.description,
    agent: agentName,
    outputFile,
    pid: proc.pid!,
    status: "running",
    startedAt: new Date().toISOString(),
  };

  registry.register(entry);

  // Post to activity stream (async, don't block)
  postStart(entry).then((msgId) => {
    if (msgId) {
      registry.update(id, { streamMessageId: msgId });
    }
  });

  // Set up FileWatcher instead of polling
  const watcher = new FileWatcher({
    filePath: outputFile,
    onFile: (content: string) => {
      untrackWatcher(watcher);
      handleSubagentOutput(entry, content).catch((err) =>
        console.error(`[SUBAGENT] Output handler error for ${id}: ${err.message}`)
      );
    },
    onTimeout: () => {
      untrackWatcher(watcher);
      console.log(`[SUBAGENT] ${id} timed out after ${SUBAGENT_TIMEOUT}s`);
      registry.update(id, {
        status: "failed",
        completedAt: new Date().toISOString(),
      });
      postError(entry, `Timed out after ${SUBAGENT_TIMEOUT}s`).catch(() => {});
      if (notifyCallback) {
        notifyCallback({ ...entry, status: "failed" }, `Timed out after ${SUBAGENT_TIMEOUT}s`);
      }
    },
    timeoutMs: SUBAGENT_TIMEOUT * 1000,
    fallbackPollMs: 3000,
    retryReadMs: 100,
  });
  trackWatcher(watcher);
  watcher.start();

  console.log(`[SUBAGENT] Spawned ${id}: "${options.description}" (PID ${proc.pid})`);
  return entry;
}

async function handleSubagentOutput(entry: registry.SubagentEntry, content: string): Promise<void> {
  try {
    // Clean up the output file
    if (existsSync(entry.outputFile)) {
      unlinkSync(entry.outputFile);
    }

    const result = JSON.parse(content);
    const { stdout, stderr, returncode } = result;

    if (returncode !== 0) {
      const errorMsg = stderr?.trim() || `Exited with code ${returncode}`;
      registry.update(entry.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
      });
      await postError(entry, errorMsg);
      if (notifyCallback) {
        notifyCallback(
          { ...entry, status: "failed" },
          `Failed: ${errorMsg}`
        );
      }
    } else {
      const responseText = extractResponse(stdout) || "No response parsed";
      registry.update(entry.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
      await postComplete(entry, responseText);
      if (notifyCallback) {
        notifyCallback({ ...entry, status: "completed" }, responseText);
      }
    }
  } catch (err: any) {
    console.error(`[SUBAGENT] Error processing ${entry.id}: ${err.message}`);
  }
}

// startPolling and stopPolling are now no-ops — kept for backward compatibility
// FileWatcher handles per-subagent output detection
export function startPolling(): void {
  console.log("[SUBAGENT] Using event-driven file watching (FileWatcher per subagent)");
}

export function stopPolling(): void {
  // No-op — watchers are cleaned up individually or via stopAllWatchers()
}

export function cancelSubagent(id: string): boolean {
  const entry = registry.get(id);
  if (!entry || entry.status !== "running") return false;

  try {
    process.kill(entry.pid, "SIGTERM");
  } catch {}

  registry.update(id, {
    status: "cancelled",
    completedAt: new Date().toISOString(),
  });

  postError(entry, "Cancelled by user").catch(() => {});
  console.log(`[SUBAGENT] Cancelled ${id}`);
  return true;
}
