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
import {
  classifyRuntimeFailureForFailover,
  runtimeFailoverMessage,
} from "./runtime-failover.js";

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

  const baseEntry: registry.SubagentEntry = {
    id,
    parentChannelId: options.channelId,
    description: options.description,
    agent: agentName,
    runtime,
    outputFile: "",
    pid: 0,
    status: "running",
    startedAt: new Date().toISOString(),
  };

  const entry = await startSubagentRuntime(baseEntry, runtime, { register: true });

  // Post to activity stream (async, don't block)
  postStart(entry).then((msgId) => {
    if (msgId) {
      registry.update(id, { streamMessageId: msgId });
    }
  });

  console.log(`[SUBAGENT] Spawned ${id}: "${options.description}" (PID ${entry.pid})`);
  return entry;
}

async function startSubagentRuntime(
  entry: registry.SubagentEntry,
  runtime: AgentRuntime,
  opts: { register: boolean },
): Promise<registry.SubagentEntry> {
  const outputFile = join(TEMP_DIR, `subagent-${entry.id}-${runtime}-${Date.now()}.json`);
  let promptFile: string | null = null;
  const adapter = getAdapter(runtime);
  const promptFilePath =
    runtime === "codex" ? join(TEMP_DIR, `subagent-${entry.id}-${Date.now()}.prompt.txt`) : undefined;
  const spawnArgs = await adapter.buildSpawnArgs({
    channelId: entry.parentChannelId,
    prompt: entry.description,
    agentName: entry.agent ?? null,
    sessionKey: entry.parentChannelId,
    taskId: `subagent-${entry.id}-${Date.now()}`,
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

  const runningEntry: registry.SubagentEntry = {
    ...entry,
    runtime,
    outputFile,
    pid: childProc.pid!,
    status: "running",
  };

  if (opts.register) {
    registry.register(runningEntry);
  } else {
    registry.update(entry.id, {
      runtime,
      outputFile,
      pid: runningEntry.pid,
      status: "running",
    });
  }

  // Set up FileWatcher instead of polling
  const watcher = new FileWatcher({
    filePath: outputFile,
    onFile: (content: string) => {
      untrackWatcher(watcher);
      if (promptFile && existsSync(promptFile)) {
        unlinkSync(promptFile);
      }
      handleSubagentOutput(runningEntry, content).catch((err) =>
        console.error(`[SUBAGENT] Output handler error for ${entry.id}: ${err.message}`)
      );
    },
    onTimeout: () => {
      untrackWatcher(watcher);
      if (promptFile && existsSync(promptFile)) {
        unlinkSync(promptFile);
      }
      console.log(`[SUBAGENT] ${entry.id} timed out after ${SUBAGENT_TIMEOUT}s`);
      registry.update(entry.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
      });
      postError(runningEntry, `Timed out after ${SUBAGENT_TIMEOUT}s`).catch(() => {});
      if (notifyCallback) {
        notifyCallback({ ...runningEntry, status: "failed" }, `Timed out after ${SUBAGENT_TIMEOUT}s`);
      }
    },
    timeoutMs: SUBAGENT_TIMEOUT * 1000,
    fallbackPollMs: 3000,
    retryReadMs: 100,
  });
  trackWatcher(watcher);
  watcher.start();

  return runningEntry;
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
      const failover = classifyRuntimeFailureForFailover({
        channelId: entry.parentChannelId,
        agentName: entry.agent,
        explicitRuntime: entry.runtime,
        failedRuntime: entry.runtime || "claude",
        stdout,
        stderr,
        returncode,
      });
      if (failover?.shouldFailover && failover.nextRuntime) {
        const message = runtimeFailoverMessage(entry.runtime || "claude", failover.nextRuntime);
        console.log(`[SUBAGENT] ${entry.id} ${message}`);
        await postUpdate(entry, `${message}: ${failover.reason.slice(0, 500)}`).catch(() => {});
        await startSubagentRuntime(entry, failover.nextRuntime, { register: false });
        return;
      }

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
