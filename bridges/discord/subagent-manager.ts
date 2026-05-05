import { spawn } from "child_process";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import * as registry from "./process-registry.js";
import {
  postStart,
  postUpdate,
  postComplete,
  postError,
} from "./activity-stream.js";
import { getChannelConfig } from "./channel-config-store.js";
import type { AgentRuntime } from "./agent-loader.js";
import { FileWatcher, trackWatcher, untrackWatcher } from "./file-watcher.js";
import { proc } from "./platform.js";
import { HARNESS_ROOT } from "./claude-config.js";
import { resolveRuntimePolicy } from "./role-policy.js";
import { getAdapter } from "./runtime-adapter.js";

const TEMP_DIR = join(HARNESS_ROOT, "bridges", "discord", ".tmp");
const SUBAGENT_TIMEOUT = parseInt(process.env.SUBAGENT_TIMEOUT || "300", 10);
let spawnProcess = spawn;

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

export function setSubagentSpawnProcessForTests(
  impl: typeof spawn | null,
): void {
  spawnProcess = impl || spawn;
}

export async function spawnSubagent(options: SpawnOptions): Promise<registry.SubagentEntry | null> {
  const id = `sa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const outputFile = join(TEMP_DIR, `subagent-${id}.json`);
  let promptFile: string | null = null;

  try {
    mkdirSync(TEMP_DIR, { recursive: true });
  } catch {}

  // Build shared config
  const channelConfig = getChannelConfig(options.channelId);
  const agentName = options.agent || channelConfig?.agent;
  const runtime: AgentRuntime = resolveRuntimePolicy({
    channelId: options.channelId,
    agentName,
  }).selectedRuntime;

  const adapter = getAdapter(runtime);
  const promptFilePath =
    runtime === "codex" ? join(TEMP_DIR, `subagent-${id}.prompt.txt`) : undefined;
  const spawnArgs = await adapter.buildSpawnArgs({
    channelId: options.channelId,
    prompt: options.description,
    agentName: agentName ?? null,
    sessionKey: options.channelId,
    taskId: `subagent-${Date.now()}`,
    outputFile,
    timeoutSecs: SUBAGENT_TIMEOUT,
    skipSessionResume: true,
    promptFilePath,
  });
  promptFile = spawnArgs.promptFilePath;

  const childProc = spawnProcess("python3", spawnArgs.pythonArgs, {
    cwd: spawnArgs.cwd,
    env: spawnArgs.env,
    detached: true,
    stdio: "ignore",
  });
  childProc.unref();

  const entry: registry.SubagentEntry = {
    id,
    parentChannelId: options.channelId,
    description: options.description,
    agent: agentName,
    runtime,
    outputFile,
    pid: childProc.pid!,
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
      if (promptFile && existsSync(promptFile)) {
        unlinkSync(promptFile);
      }
      handleSubagentOutput(entry, content).catch((err) =>
        console.error(`[SUBAGENT] Output handler error for ${id}: ${err.message}`)
      );
    },
    onTimeout: () => {
      untrackWatcher(watcher);
      if (promptFile && existsSync(promptFile)) {
        unlinkSync(promptFile);
      }
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

  console.log(`[SUBAGENT] Spawned ${id}: "${options.description}" (PID ${childProc.pid})`);
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
      const adapter = getAdapter(entry.runtime || "claude");
      const responseText = adapter.extractResponse(result) || "No response parsed";
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

  proc.terminate(entry.pid);

  registry.update(id, {
    status: "cancelled",
    completedAt: new Date().toISOString(),
  });

  postError(entry, "Cancelled by user").catch(() => {});
  console.log(`[SUBAGENT] Cancelled ${id}`);
  return true;
}
